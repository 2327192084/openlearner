/**
 * 跨资料全文搜索（2026-11-20）。
 *
 * ## 用户诉求
 *
 * 交接文档把它列为建议的下一项，理由写得很准：
 *
 * > 现状：`sourceService.search(sourceId, query)` **只接受单个 sourceId**，
 * > 只能在某一本书里搜。真实场景是「我记得在哪本书看过这个概念」。
 * > 纯本地实现，不需要 AI，能离线完整验证。高频操作，效果立竿见影。
 *
 * ## 为什么不能循环调 sourceService.search()
 *
 * `sourceService.search()` 内部是 `getSegments(sourceId)`，而
 * `getSegments` 每次都 `storage.getAll('sourceSegments')` —— **全表读**再过滤。
 * 用户库里 4 份资料 1006 段，循环 4 次就是把这 1006 段读出 4 遍并过滤 4 遍。
 * 资料越多越慢，而且是 O(资料数 × 全表)。
 *
 * 所以这里**只读一次全表**，在内存里按 sourceId 分组后统一匹配。
 * 一份 50 页的教材正文几十万字，1000 段也就几 MB —— 一次读进来完全可行，
 * 而反复全表读才是真正的浪费。
 *
 * ## 为什么复用 findAllFolded 而不是重写匹配
 *
 * 那是项目里已经调好的匹配器：忽略一切空白（中文没有词间空格，
 * 搜「句后」要能命中原文的「句\n后」）、大小写不敏感、**同时记录每个
 * 折叠字符来自原文的哪个下标** —— 命中后偏移能直接映射回原文坐标。
 *
 * 「先删空白再 indexOf」那种做法偏移是折叠后坐标，拿去切原文本会越切越偏、
 * 高亮错位。这个坑 sources.ts 的注释里记着，不要重犯。
 *
 * ## 本模块是纯函数
 *
 * 不碰 I/O，不依赖 React。入参是资料列表与段落列表，出参是分组好的结果。
 */

import type { Source, SourceSegment } from '@/core/model.ts';
import { findAllFolded } from '@/core/sources.ts';

/** 一条跨资料命中的结果 */
export interface GlobalSearchHit {
  sourceId: string;
  /** 资料标题（结果里必须显示「哪本书」，否则用户还是要挨个点开看） */
  sourceTitle: string;
  segmentId: string;
  page: number;
  chapter: string | null;
  charStart: number;
  charEnd: number;
  /** 上下文片段（前后各约 30 字） */
  snippet: string;
}

/** 按资料分组的结果（一份资料一组，组内按页码） */
export interface SourceHitGroup {
  sourceId: string;
  sourceTitle: string;
  hits: GlobalSearchHit[];
  /** 这份资料里有多少处命中 */
  count: number;
}

/** 搜索总结果 */
export interface GlobalSearchResult {
  groups: SourceHitGroup[];
  /** 总命中数 */
  total: number;
  /** 涉及的资料份数 */
  sourceCount: number;
  /**
   * 被跳过的资料数（没有正文 / 正文为空）。
   *
   * 必须如实计数：用户搜不到东西时要能分辨「真的没有」和
   * 「这几份资料还没解析出正文」。静默跳过会让人以为搜遍了全库。
   */
  skippedSources: number;
}

/** 片段上下文长度（前后各这么多字符） */
const SNIPPET_PAD = 30;

/**
 * 从一段正文里切出命中位置附近的上下文。
 *
 * 与其他搜索实现（sources.ts 的 makeSnippet）保持同一口径：
 * 前 30 字、后 30 字，两端用省略号表示被截断。
 */
function makeSnippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_PAD);
  const to = Math.min(text.length, end + SNIPPET_PAD);
  const head = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return head + text.slice(from, to).replace(/\s+/g, ' ').trim() + tail;
}

/**
 * 跨全部资料搜索。
 *
 * @param sources 全部资料（用于取标题、判断哪些没有正文）
 * @param segments 全部段落（一次读全表的结果）
 * @param query 搜索词
 * @param limit 最多返回多少条（默认 500，防一次搜「的」这类高频词卡死界面）
 */
export function searchAllSources(
  sources: readonly Source[],
  segments: readonly SourceSegment[],
  query: string,
  limit = 500,
): GlobalSearchResult {
  const needle = query.trim();
  const empty: GlobalSearchResult = {
    groups: [],
    total: 0,
    sourceCount: 0,
    skippedSources: 0,
  };
  if (!needle) return empty;

  /* ---- 1) 按资料分组段落（一次遍历，不反复 filter 全表） ---- */
  const segsBySource = new Map<string, SourceSegment[]>();
  for (const seg of segments) {
    const arr = segsBySource.get(seg.sourceId);
    if (arr) arr.push(seg);
    else segsBySource.set(seg.sourceId, [seg]);
  }

  /*
   * ---- 2) 每一份资料分别匹配 ----
   *
   * 按资料标题排序，不按命中数：用户找的是「那本书」，
   * 稳定的顺序比「命中多的浮上来」更好预期（命中数已在组上显示）。
   */
  const ordered = [...sources].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));

  const groups: SourceHitGroup[] = [];
  let skipped = 0;
  let total = 0;

  for (const src of ordered) {
    if (total >= limit) break;
    const segs = segsBySource.get(src.id);
    if (!segs || segs.length === 0) {
      /* 没有正文的资料如实计入跳过数 —— 用户要知道「这几份搜不了」 */
      skipped += 1;
      continue;
    }

    /* 段内按页序，保证结果从上到下 */
    const sorted = [...segs].sort((a, b) => a.index - b.index);
    const hits: GlobalSearchHit[] = [];

    for (const seg of sorted) {
      if (total + hits.length >= limit) break;
      const occurrences = findAllFolded(seg.text, needle);
      for (const { start, end } of occurrences) {
        hits.push({
          sourceId: src.id,
          sourceTitle: src.title,
          segmentId: seg.id,
          page: seg.page,
          chapter: seg.chapter,
          charStart: start,
          charEnd: end,
          snippet: makeSnippet(seg.text, start, end),
        });
      }
    }

    if (hits.length > 0) {
      groups.push({
        sourceId: src.id,
        sourceTitle: src.title,
        hits,
        count: hits.length,
      });
      total += hits.length;
    }
  }

  return {
    groups,
    total,
    sourceCount: groups.length,
    skippedSources: skipped,
  };
}

/**
 * 把 `GlobalSearchHit` 转成阅读器能直接用的定位目标（2026-11-20）。
 *
 * 点搜索结果应该跳到**那一句**并标橙光 —— 与昨晚做的
 * 「定位精确到句子」是同一条链路（`ReaderTarget` 带 charStart/charEnd）。
 *
 * 不做这一步的话，跨资料搜索只能「跳到那一页」，
 * 而搜索恰恰是「我知道有这句话，就要看它」的场景，必须落到那句话。
 */
export function hitToReaderTarget(hit: GlobalSearchHit): {
  sourceId: string;
  page: number;
  charStart: number;
  charEnd: number;
  segmentId: string;
} {
  return {
    sourceId: hit.sourceId,
    page: hit.page,
    charStart: hit.charStart,
    charEnd: hit.charEnd,
    segmentId: hit.segmentId,
  };
}

/**
 * 结果摘要文案（给界面顶部用）。
 *
 * 单独抽出来是为了可测 —— 文案里这几个数字的语义容易被写错：
 * 「几处 / 几份资料 / 几份搜不了」是三件事。
 */
export function summarizeResult(r: GlobalSearchResult, query: string): string {
  if (!query.trim()) return '';
  if (r.total === 0) {
    return r.skippedSources > 0
      ? `没有找到「${query.trim()}」。另外有 ${r.skippedSources} 份资料还没有正文，不在搜索范围内。`
      : `没有找到「${query.trim()}」。`;
  }
  const base = `「${query.trim()}」共 ${r.total} 处，分布在 ${r.sourceCount} 份资料`;
  return r.skippedSources > 0
    ? `${base}（另有 ${r.skippedSources} 份资料没有正文，未参与搜索）`
    : base;
}
