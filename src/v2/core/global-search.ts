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
  /**
   * 实际展示的命中（可能少于 `count` —— 触到 limit 时被截断）。
   *
   * 界面必须能分辨这两个数：`hits.length` 是「列出来的」，
   * `count` 是「这本书里真有的」。只显示前者会让用户以为
   * 一本有 800 处命中的书只有 12 处。
   */
  hits: GlobalSearchHit[];
  /**
   * 这份资料里**真实**有多少处命中（不受 limit 影响）。
   *
   * 与 `hits.length` 可能不同 —— 见上面。
   */
  count: number;
}

/** 搜索总结果 */
export interface GlobalSearchResult {
  groups: SourceHitGroup[];
  /** **实际返回**的命中数（受 limit 限制） */
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
  /**
   * 库里**一共有多少处**命中（不受 limit 限制）—— 2026-11-20 加。
   *
   * ## 为什么必须有这个字段
   *
   * 实测用户库里搜「的」有 **2365 处**，而 limit 是 500。
   * 原来只返回 500 条、`total` 也写 500，界面显示「共 500 处」——
   * **那是假话**：用户以为搜遍了全库，其实漏掉 1865 处。
   *
   * 项目一贯的规矩是「说出来就要是真的」。
   * 所以现在：**计数算全（便宜）**，展示截断（贵的是 DOM），
   * 界面可以说「共 2365 处，显示前 500 处」。
   */
  matchCount: number;
  /** 是否被 limit 截断（方便界面直接判断） */
  truncated: boolean;
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
    matchCount: 0,
    truncated: false,
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
  let shown = 0;
  /*
   * `matchCount` 与 `shown` 必须分开（2026-11-20 修）。
   *
   * `findAllFolded` 的结果本来就在手上 —— 数它「有几个」是零成本的，
   * 贵的只是为命中构建 DOM 与 snippet。所以：
   *   - **计数算全**（哪怕 2365 处）
   *   - **构建截断**（到 limit 就停止构建）
   *
   * 第一版把两者混成一个 `total`，于是搜「的」时界面显示
   * 「共 500 处」—— 那是假话，实有 2365 处。
   */
  let matchCount = 0;

  /*
   * 每份资料的展示配额（2026-11-20）。
   *
   * ## 为什么不是「先到先得、吃完为止」
   *
   * 第一版就是那样：按资料标题排序，第一份（高数，515 处）
   * 把 500 条额度吃光，后面两份命中几百处的资料**一条都不列**。
   * 实测截图：搜「的」只看到一份资料，另两份显示「列前 0 处」——
   * 读起来像坏掉了，而且违背「跨资料搜索」的意义
   * （用户就想知道「哪几本书里有」）。
   *
   * ## 现在：先给每份资料一个保底配额
   *
   * 有 N 份有命中的资料时，每份先分 `floor(limit / N)` 条，
   * 剩下的额度再按顺序补给前面的资料。这样每份资料至少能看到几处，
   * 「哪本书里有」这个信息不会被截断吃掉。
   *
   * 先数一遍「有几份资料有命中」—— 这需要多扫一遍，
   * 但只是字符串匹配，比让用户看不到资料强。
   */
  const hasHit: { src: Source; segs: SourceSegment[]; groupCount: number }[] = [];
  for (const src of ordered) {
    const segs = segsBySource.get(src.id);
    if (!segs || segs.length === 0) {
      /* 没有正文的资料如实计入跳过数 —— 用户要知道「这几份搜不了」 */
      skipped += 1;
      continue;
    }
    const sorted = [...segs].sort((a, b) => a.index - b.index);
    let c = 0;
    for (const seg of sorted) c += findAllFolded(seg.text, needle).length;
    matchCount += c;
    if (c > 0) hasHit.push({ src, segs: sorted, groupCount: c });
  }

  /** 每份资料的保底配额（至少 1 条，让用户看到「这本书里有」） */
  const perSourceQuota =
    hasHit.length > 0 ? Math.max(1, Math.floor(limit / hasHit.length)) : limit;

  for (const { src, segs, groupCount } of hasHit) {
    /*
     * 这份能展示多少：保底配额，或剩余额度（谁先来谁用剩下的）。
     * 用 `Math.max` 保证即使配额为 0 也至少给 1 条 ——
     * 「有命中但一条都不列」是最糟糕的呈现。
     */
    const remain = limit - shown;
    const allowance = Math.max(0, Math.min(Math.max(perSourceQuota, 1), remain));

    const hits: GlobalSearchHit[] = [];
    if (allowance > 0) {
      for (const seg of segs) {
        if (hits.length >= allowance) break;
        const occurrences = findAllFolded(seg.text, needle);
        for (const { start, end } of occurrences) {
          if (hits.length >= allowance) break;
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
    }

    groups.push({
      sourceId: src.id,
      sourceTitle: src.title,
      hits,
      count: groupCount,
    });
    shown += hits.length;
  }

  /*
   * 还剩额度就按顺序补给前面的资料（配额可能没被用满，
   * 比如某份资料只有 3 处命中但配额是 166）。
   *
   * 简化实现：每轮给还没列满且额度仍有剩余的组补一条，直到额度用尽。
   * 不追求「填得最满」，只保证列表不至于因为配额偏低而显得空。
   */
  if (shown < limit) {
    const byId = new Map(hasHit.map((h) => [h.src.id, h.segs]));
    let progressed = true;
    while (shown < limit && progressed) {
      progressed = false;
      for (const g of groups) {
        if (shown >= limit) break;
        if (g.hits.length >= g.count) continue;
        const segs = byId.get(g.sourceId);
        if (!segs) continue;
        const seen = new Set(g.hits.map((h) => `${h.segmentId}:${h.charStart}`));
        let added = false;
        for (const seg of segs) {
          if (added) break;
          for (const { start, end } of findAllFolded(seg.text, needle)) {
            if (seen.has(`${seg.id}:${start}`)) continue;
            g.hits.push({
              sourceId: g.sourceId,
              sourceTitle: g.sourceTitle,
              segmentId: seg.id,
              page: seg.page,
              chapter: seg.chapter,
              charStart: start,
              charEnd: end,
              snippet: makeSnippet(seg.text, start, end),
            });
            shown += 1;
            added = true;
            break;
          }
        }
        if (added) progressed = true;
      }
    }
  }

  return {
    groups,
    total: shown,
    sourceCount: groups.length,
    skippedSources: skipped,
    matchCount,
    truncated: matchCount > shown,
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
 * 「几处 / 显示几处 / 几份资料 / 几份搜不了」是四件事。
 *
 * ## 为什么要专门说「显示前 N 处」（2026-11-20）
 *
 * 实测用户库里搜「的」有 2365 处，而 limit 是 500。
 * 第一版摘要写的是「共 500 处」—— 那是假话，用户以为搜遍了全库。
 *
 * 项目一贯的规矩：**说出来就要是真的**。宁可承认「没全列出来」，
 * 也不能让用户以为搜全了。
 */
export function summarizeResult(r: GlobalSearchResult, query: string): string {
  const q = query.trim();
  if (!q) return '';

  if (r.matchCount === 0) {
    return r.skippedSources > 0
      ? `没有找到「${q}」。另外有 ${r.skippedSources} 份资料还没有正文，不在搜索范围内。`
      : `没有找到「${q}」。`;
  }

  /*
   * 截断时的说法：「共 2365 处（列表只列前 500 处）」——
   * 总数在前、列表数在后，因为用户最想知道的是「到底有多少」。
   */
  const base = r.truncated
    ? `「${q}」共 ${r.matchCount} 处，分布在 ${r.sourceCount} 份资料（列表只列前 ${r.total} 处，换个更具体的词能缩小范围）`
    : `「${q}」共 ${r.matchCount} 处，分布在 ${r.sourceCount} 份资料`;

  return r.skippedSources > 0
    ? `${base}（另有 ${r.skippedSources} 份资料没有正文，未参与搜索）`
    : base;
}

/**
 * 把一份资料的命中按「页」归并（2026-11-21）。
 *
 * ## 为什么需要
 *
 * 实测搜「极限」时，前 6 条结果**全部来自「第 11 页 目录」**——
 * 因为那是一份 PDF 的目录页，页里密集出现「极限」这个词。
 * 真正有价值的内容（第 18、27 页的定义）被压在下面，用户要滚很久。
 *
 * 这不是 bug（目录页确实有这个词），但按「一条结果一行」平铺
 * 会把同一页的重复内容堆在一起，读起来像刷屏。
 *
 * ## 做法：同页归并，一页一行
 *
 * 一页内的多处命中合成一条，显示：
 *  - 页码 + 章节
 *  - 这一页有几处
 *  - 第一处的片段（作为「这一页讲什么」的线索）
 *
 * 点进去仍然定位到**第一处**并标橙光 —— 至少落点对了，
 * 而用户想看的更多是「这一页在哪」，翻过去自己就能扫。
 *
 * ## 为什么不做「目录页降权」
 *
 * 那需要判断「这一页是不是目录/索引」，靠标题关键词猜会误判
 * （用户的书可能管它叫「内容提要」「本章要点」）。
 * 同页归并是**不确定内容语义也能安全做**的那一档：
 * 它只减少重复，不改变哪条更重要的判断。
 */
export interface PageHit {
  page: number;
  chapter: string | null;
  /** 这一页里有多少处命中 */
  count: number;
  /** 代表这一页的那一处（第一处） */
  first: GlobalSearchHit;
}

/**
 * 把命中按页归并，保持原有顺序（按页码升序）。
 *
 * @param hits 一份资料的全部命中
 */
export function groupHitsByPage(hits: readonly GlobalSearchHit[]): PageHit[] {
  const byPage = new Map<number, PageHit>();
  for (const h of hits) {
    const cur = byPage.get(h.page);
    if (cur) cur.count += 1;
    else byPage.set(h.page, { page: h.page, chapter: h.chapter, count: 1, first: h });
  }
  /* 页码升序：与用户翻书的顺序一致（hits 本身已按页排，这里显式排序更稳） */
  return [...byPage.values()].sort((a, b) => a.page - b.page);
}
