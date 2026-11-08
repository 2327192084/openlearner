/**
 * 覆盖度：一份资料的正文段落里，哪些有题、哪些从没出过题。
 *
 * ## 这个功能回答什么问题
 *
 * 现在界面只能说「这个题组有 8 道题」，但**不知道这 8 道覆盖了资料的多少** ——
 * 可能全集中在第 1 章，后面 30 页一道题都没有。用户以为复习完了，
 * 其实只是把出一半题的那几道做熟了。
 *
 * 结果一句话：「这份资料 36 页，有题的是 12 页（33%）；第 13–24 页从没出过题。」
 *
 * ## 参考来源
 *
 * StudyHub `lib/coverage.js`（MIT）。核心设计照搬，实现按我们的数据结构重写：
 *
 * 1. **单位是叶子段落**（leaf section）。它用 `lib/sections.js` 把资料切成
 *    PDF 页 / Markdown 标题 / 转录分段 / 固定窗口。我们的 `sourceSegments`
 *    已经是「按页或按章切好的正文」，天然就是叶子段落 —— 不需要再切一遍。
 *
 * 2. **三种状态，不是两种**：
 *    - `covered`   至少有一道题的出处落在这段里
 *    - `never-planned` 从来没计划过（我们的现状：没有出题计划记录，所以只有这一种「没题」）
 *
 *    StudyHub 还有 `planned-failed`（计划了但生成失败）。**我们没有这个状态** ——
 *    我们没有「出题计划」这个数据结构，不能假装有。少一种状态是如实，
 *    硬凑一个 `plannedFailed` 会永远显示 0，那是假的。
 *
 * 3. **纯函数，不碰 I/O**。StudyHub 的注释反复强调「backend and browser read
 *    ONE function, so the numbers on every screen are the same numbers」——
 *    这正是我们踩过的坑（概览说已学 10 张但列表只有 3 张）。所以这里也是纯函数。
 *
 * 4. **两个百分比**：按段数（percentLeaves）和按字符数（percentChars）。
 *    为什么两个都要：一份资料里有的页文字很多、有的页只有一句标题。
 *    只看段数会高估「薄页」的分量。
 *
 * ## 我们比 StudyHub 简单的地方
 *
 * 它的题目定位要三级回退（selection 偏移 → quote 搜索 → 章节范围）。
 * 我们的 `Question.anchors[]` 直接带 `sourceId` + `page`，所以一个 Map 就够。
 */

import type { SourceLocation, SourceSegment } from '@/core/model.ts';

/** 参与覆盖度计算的最小段形状 */
export interface CoverSegment {
  id: string;
  sourceId: string;
  /** 页码（按章节切分的资料里等于顺序号） */
  page: number;
  chapter: string | null;
  charCount: number;
}

/** 参与覆盖度计算的最小题目形状 */
export interface CoverCard {
  id: string;
  anchors: SourceLocation[];
}

/** 一段的覆盖状态 */
export type CoverState = 'covered' | 'never-planned';

export interface CoverSection {
  segmentId: string;
  page: number;
  chapter: string | null;
  chars: number;
  state: CoverState;
  /** 落在这段里的题数 */
  cards: number;
}

export interface Coverage {
  sourceId: string;
  sections: CoverSection[];
  /** 有题的段数 */
  covered: number;
  /** 从没出过题的段数 */
  neverPlanned: number;
  /** 总段数 */
  leaves: number;
  /** 有题的段占比 0–100 */
  percentLeaves: number;
  /** 有题的段字符数占比 0–100 */
  percentChars: number;
  /** 每万字几道题（题目密度） */
  perTenK: number;
  /** 落在这份资料里的题数 */
  cards: number;
  /** 总字符数 */
  chars: number;
}

/** 百分比取整，避免界面出现 33.33333% */
function pct(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, part / total)) * 100);
}

/**
 * 算一份资料的覆盖度。
 *
 * @param segments 这份资料的段（调用方按 sourceId 过滤好）
 * @param cards    全库题目（内部按 anchors 过滤到这份资料）
 */
export function coverageOf(
  sourceId: string,
  segments: readonly CoverSegment[],
  cards: readonly CoverCard[],
): Coverage {
  const mine = [...segments].sort((a, b) => a.page - b.page);

  /*
   * 段 → 题数。
   *
   * 一道题可能有多个 anchors（同一概念在几页出现）。它应该只算「覆盖」一次，
   * 但落在哪一段要按 page 决定。这里有意的选择：
   * **每道题只计入它第一个指向本资料的 anchor**。
   * 一道题算作覆盖了两页，会让覆盖率虚高。
   */
  const rows: CoverSection[] = mine.map((s) => ({
    segmentId: s.id,
    page: s.page,
    chapter: s.chapter,
    chars: s.charCount,
    state: 'never-planned',
    cards: 0,
  }));

  // page → 段（一段一页时最常见；按章节切分时可能几段同页，取第一个）
  const segByPage = new Map<number, CoverSection>();
  for (const r of rows) if (!segByPage.has(r.page)) segByPage.set(r.page, r);

  let placed = 0;
  for (const card of cards) {
    const anchor = card.anchors.find((a) => a.sourceId === sourceId);
    if (!anchor) continue;
    placed += 1;
    if (typeof anchor.page !== 'number' || anchor.page <= 0) continue;
    const row = segByPage.get(anchor.page);
    if (!row) continue;
    row.cards += 1;
  }

  for (const r of rows) {
    if (r.cards > 0) r.state = 'covered';
  }

  const covered = rows.filter((r) => r.state === 'covered').length;
  const chars = rows.reduce((n, r) => n + r.chars, 0);
  const coveredChars = rows.filter((r) => r.state === 'covered').reduce((n, r) => n + r.chars, 0);

  return {
    sourceId,
    sections: rows,
    covered,
    neverPlanned: rows.length - covered,
    leaves: rows.length,
    percentLeaves: pct(covered, rows.length),
    percentChars: pct(coveredChars, chars),
    // 每万字几人题：StudyHub 用的是「每万字几道」（*100000/10 取一位小数）
    perTenK: chars > 0 ? Math.round((placed / chars) * 100000) / 10 : 0,
    cards: placed,
    chars,
  };
}

/**
 * 把连续的「没题」段落合并成区间，用于一句话结论。
 *
 * 「第 13–24 页从没出过题」比列出 12 个页码有用得多。
 * 只合并不超过 maxGap 的间隔，否则「第 1 页、第 36 页」会被合成
 * 「第 1–36 页」，那是误导。
 */
export function gapsOf(
  coverage: Coverage,
  maxGap = 2,
): { from: number; to: number; pages: number }[] {
  const missing = coverage.sections.filter((s) => s.state === 'never-planned');
  if (missing.length === 0) return [];

  const out: { from: number; to: number; pages: number }[] = [];
  let from = missing[0]!.page;
  let to = from;
  let count = 1;

  for (let i = 1; i < missing.length; i++) {
    const p = missing[i]!.page;
    if (p - to <= maxGap) {
      to = p;
      count += 1;
    } else {
      out.push({ from, to, pages: count });
      from = p;
      to = p;
      count = 1;
    }
  }
  out.push({ from, to, pages: count });
  return out;
}

/** 把区间说成一句中文 */
export function describeGap(gap: { from: number; to: number; pages: number }): string {
  if (gap.from === gap.to) return `第 ${gap.from} 页`;
  return `第 ${gap.from}–${gap.to} 页`;
}

/** 段列表 → 精简段（调用方从完整 SourceSegment 转换） */
export function toCoverSegments(segments: readonly SourceSegment[]): CoverSegment[] {
  return segments.map((s) => ({
    id: s.id,
    sourceId: s.sourceId,
    page: s.page,
    chapter: s.chapter,
    charCount: s.charCount,
  }));
}
