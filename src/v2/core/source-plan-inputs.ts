/**
 * 「依据资料本体」规划路线的数据装配（2026-11-21 深夜）。
 *
 * ## 为什么单独一层
 *
 * 与 `plan-inputs.ts` 同一个理由：纯函数不该碰存储，页面也不该自己查表。
 * 这一层负责读（资料 + 段落），纯函数（`source-outline.ts` /
 * `subject-guess.ts` / `source-route.ts`）负责算。
 *
 * ## 与 `plan-inputs.ts` 的区别（两个都留着）
 *
 * | | `plan-inputs.ts` | 这里 |
 * |---|---|---|
 * | 读什么 | 知识点 + 复习记录 | **资料 + 段落正文** |
 * | 算什么 | 每条知识点的弱项信号 | **资料的目录结构与覆盖范围** |
 * | 给谁用 | 知识点级排序（`plan-order.ts`） | 资料级路线（`source-route.ts`） |
 *
 * 用户这轮明确要的是后者（「依据资料本体」）。前者没删 ——
 * 「我有 105 个知识点，先攻哪个」仍然是另一个问题。
 *
 * ## 一次读全表，不要循环查
 *
 * `getSegments(sourceId)` 内部每次都会 `getAll` 再过滤（`sourceService`
 * 的实现），循环调用是 O(资料数 × 全表)。用户在库里有 1000+ 段，
 * 这里一次读完再分组 —— 与交接文档里 `getAllSegments()` 的教训一致。
 */

import type { Source, SourceSegment } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { buildOutline, coveredChapters, type SourceOutline } from './source-outline.ts';
import { checkCompleteness, guessSubject, type ParseCompleteness, type SubjectGuess } from './subject-guess.ts';
import type { ScopeInfo } from '@/core/ai/source-route.ts';

/** 一份资料的规划准备情况 */
export interface SourcePlanPrep {
  source: Source;
  /** 目录结构（三种形态之一） */
  outline: SourceOutline;
  /** 覆盖的章范围；null = 无章号概念 */
  coverage: { from: number; to: number; complete: boolean; declaredTo: number | null } | null;
  /** 能否规划（用户确认要「挡住先补解析」） */
  completeness: ParseCompleteness;
  /** 推定的科目（用户要先确认） */
  subject: SubjectGuess;
  /** 段数 */
  segmentCount: number;
  /** 正文字数 */
  charCount: number;
}

/** 装配结果 */
export interface PlanPrepResult {
  /** 每份资料的准备情况 */
  sources: SourcePlanPrep[];
  /**
   * 可直接规划的（解析完整、且有内容）。
   *
   * 单独列出来是因为界面要「默认选中第一份能用的」——
   * 让用户在一堆「这份不能排」里自己找能用的，是没必要的负担。
   */
  ready: SourcePlanPrep[];
}

export interface PrepareOptions {
  sourceService: SourceService;
}

/**
 * 读出所有资料，逐份算出「能不能规划 + 是什么科目 + 覆盖哪几章」。
 *
 * 不做筛选：不能规划的那份也要返回（带原因），
 * 因为用户需要知道**为什么**不能排，而不是它从列表里消失。
 */
export async function prepareSourcePlans(options: PrepareOptions): Promise<PlanPrepResult> {
  const { sourceService } = options;

  const sources = await sourceService.list();

  /*
   * 一次读完所有段落再按 sourceId 分组。
   *
   * ⚠️ 不要写成 `for (const s of sources) await getSegments(s.id)` ——
   * 那个方法的实现是「getAll 全表再 filter」，循环就是 O(N × 全表)。
   * 用户库里 1000+ 段时这个差别很明显（交接文档记过同一条）。
   */
  const allSegments = await sourceService.getAllSegments();
  const bySource = new Map<string, SourceSegment[]>();
  for (const seg of allSegments) {
    const arr = bySource.get(seg.sourceId);
    if (arr) arr.push(seg);
    else bySource.set(seg.sourceId, [seg]);
  }

  const prepared: SourcePlanPrep[] = sources.map((source) => {
    const segs = (bySource.get(source.id) ?? []).slice().sort((a, b) => a.index - b.index);
    const outline = buildOutline(segs);
    const coverage = coveredChapters(outline);
    const completeness = checkCompleteness(
      source,
      segs,
      outline,
      coverage ? { declaredTo: coverage.declaredTo, to: coverage.to } : null,
    );
    const subject = guessSubject(source, outline, segs);
    const charCount = segs.reduce((n, s) => n + (s.charCount || s.text.length), 0);

    return {
      source,
      outline,
      coverage,
      completeness,
      subject,
      segmentCount: segs.length,
      charCount,
    };
  });

  /*
   * 「能用」的判据：解析完整 **且** 有正文。
   *
   * 不要求「有目录」—— 用户明确说了没有目录的资料也要能规划
   * （问科目 + 按内容分块），只是边界靠「无章号」处理。
   */
  const ready = prepared.filter(
    (p) => p.completeness.ok && p.segmentCount > 0,
  );

  return { sources: prepared, ready };
}

/**
 * 把一份资料准备情况转成路线规划要的 `ScopeInfo`。
 *
 * ## `chapters` 用哪个来源（这是边界正确性的关键）
 *
 * 用 `coverage`（它内部已经只认 `contentChapterNumbers`，即正文实际出现的章）
 * —— **不是** `outline.chapterNumbers`（那个含目录页声明的）。
 *
 * 实测依据：《信号与系统 第1章》的目录页列了整本书 8 章，
 * 但这份 PDF 只有第 1 章。用错来源就会把路线排到第 8 章去。
 */
export function toScopeInfo(prep: SourcePlanPrep, segments: readonly SourceSegment[]): ScopeInfo {
  const chapterBySegment = new Map<string, number | null>();

  if (prep.coverage === null) {
    /* 无章号概念：所有段的章号都是 null */
    for (const s of segments) chapterBySegment.set(s.id, null);
    return {
      chapters: null,
      sourceTitle: prep.source.title,
      chapterBySegment,
    };
  }

  /*
   * 有章号：逐段认出它属于哪一章。
   *
   * 怎么认：段落文本里出现「第N章」就归那一章。
   * 找不到时继承**上一段**的章号 —— 教材的章节标题只出现在章首，
   * 后面几十页正文里都不会再写章号。按「最近的章标题」归是唯一可行的做法。
   */
  let current: number | null = null;
  for (const seg of segments) {
    const found = chapterNumberOf(seg.text);
    if (found !== null) current = found;
    chapterBySegment.set(seg.id, current);
  }

  /*
   * chapters 用**正文实际出现的章号集合**（coverage.from..to 的完整范围）。
   * 注意：这里给的是区间内的每个整数，因为 `coveredChapters.complete = true`
   * 时正文确实覆盖了每一章。
   */
  const chapters: number[] = [];
  for (let n = prep.coverage.from; n <= prep.coverage.to; n += 1) chapters.push(n);

  return {
    chapters,
    sourceTitle: prep.source.title,
    chapterBySegment,
  };
}

/** 从一段正文里认出章号（只认行首的「第N章」） */
function chapterNumberOf(text: string): number | null {
  const m = /^[ \t]*第[ \t]*([0-9一二三四五六七八九十百]+)[ \t]*章/m.exec(text);
  if (!m) return null;
  const raw = m[1] ?? '';
  if (/^[0-9]+$/.test(raw)) return Number(raw);

  const CN: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (raw.length === 1) return CN[raw] ?? null;
  if (raw.startsWith('十')) {
    const rest = CN[raw.slice(1)];
    return rest === undefined ? 10 : 10 + rest;
  }
  const [tens, ones] = raw.split('十');
  const t = CN[tens ?? ''];
  if (t === undefined) return null;
  const o = ones ? CN[ones] : 0;
  return o === undefined ? null : t * 10 + o;
}

/**
 * 取一份资料的全部段落（按 index 排好）。
 *
 * 单独一个函数是为了让调用方不必重复写排序 —— 段落顺序错乱
 * 会直接导致「认章号」那段逻辑把章归错。
 */
export async function loadSourceSegments(
  sourceService: SourceService,
  sourceId: string,
): Promise<SourceSegment[]> {
  const segs = await sourceService.getSegments(sourceId);
  return segs.slice().sort((a, b) => a.index - b.index);
}