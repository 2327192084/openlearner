import type { TextAnchor } from './model.ts';

/**
 * 文本锚点：把标记钉在「某段文字的某个位置」。
 *
 * ## 为什么这件事比看上去难
 *
 * 用户高亮一句话之后，下面这些事都可能发生，而标记必须还在原处：
 *  - 窗口变宽变窄（换行位置全变）
 *  - 字号调整
 *  - 资料重新解析（OCR 补全正文后，整页文本都变了）
 *  - 同一句话在这一页出现多次
 *
 * 所以不能只存「第 3 个字符到第 20 个字符」——偏移量一变就全错。
 * 也不能只存「这句话」——同一页里重复的句子会选错。
 *
 * ## 两个选择器配合（W3C Web Annotation 的做法）
 *
 * 1. **position**：存 start/end 偏移。命中率高、O(1)，
 *    但文本一变就失效。
 * 2. **quote**：存 exact + 前后文。文本变了仍能找回，
 *    但需要搜索。
 *
 * 还原顺序：先试 position，校验 exact 是否对得上；
 * 对不上就全文搜 exact，再用前后文挑最可能的那一处。
 * 两者都失败才算锚点失效（界面要如实标出来，不能假装还在）。
 *
 * 这套思路 Zotero 与 Hypothesis 都在用，是经过大规模检验的做法。
 */

/** 前后文取多少字。32 字足够区分同一页里的重复句子，又不会太长 */
const CONTEXT_LEN = 32;

/**
 * 从一段文本 + 选中区间生成锚点。
 *
 * @param fullText 这一页的完整纯文本
 * @param start 选中起点（相对 fullText 的字符偏移）
 * @param end 选中终点（开区间）
 * @param page 页码
 */
export function describeTextAnchor(
  fullText: string,
  start: number,
  end: number,
  page: number,
): TextAnchor | null {
  const s = Math.max(0, Math.min(start, fullText.length));
  const e = Math.max(s, Math.min(end, fullText.length));
  const exact = fullText.slice(s, e);
  if (exact.trim().length === 0) return null;

  return {
    page,
    exact,
    prefix: fullText.slice(Math.max(0, s - CONTEXT_LEN), s),
    suffix: fullText.slice(e, Math.min(fullText.length, e + CONTEXT_LEN)),
    start: s,
    end: e,
  };
}

/** 一次锚点还原的结果 */
export interface AnchorResolution {
  /** 是否找到了位置 */
  ok: boolean;
  start: number;
  end: number;
  /**
   * 置信程度：
   *  - 'exact'    位置偏移直接对上，且引文一致（最可靠）
   *  - 'quote'    偏移对不上，靠引文全文搜索找回
   *  - 'fuzzy'    引文也找不到完全一致的，找到了近似位置（要提示用户）
   *  - 'lost'     彻底找不到
   */
  confidence: 'exact' | 'quote' | 'fuzzy' | 'lost';
}

/**
 * 在文本里还原锚点的位置。
 *
 * @param fullText 当前这一页的纯文本（可能与建锚点时不同）
 */
export function resolveTextAnchor(fullText: string, anchor: TextAnchor): AnchorResolution {
  const { exact, prefix, suffix, start, end } = anchor;
  const lost: AnchorResolution = { ok: false, start: 0, end: 0, confidence: 'lost' };

  if (!exact) return lost;

  // 1) 先看原偏移是否还对得上 —— 最常见的路径
  if (
    start >= 0 &&
    end <= fullText.length &&
    end > start &&
    fullText.slice(start, end) === exact
  ) {
    return { ok: true, start, end, confidence: 'exact' };
  }

  // 2) 全文找 exact 的所有出现位置，用前后文挑最靠谱的那一处
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = fullText.indexOf(exact, from);
    if (idx === -1) break;
    hits.push(idx);
    from = idx + 1;
    // 保护：同一段文字重复几千次时不要卡死
    if (hits.length > 200) break;
  }

  if (hits.length === 0) {
    /**
     * 3) 逐字对不上（OCR 修过错字），退一步找最相似的位置。
     *
     * ⚠️ 必须用 `!== null` 判断，不能用 `fuzzy ?`：
     * 匹配位置是 **0** 时（标记在页首）会被当成 falsy，
     * 明明找到了却报「锚点丢失」。这个 bug 只在「标记从页面第一个字
     * 开始」时出现，非常隐蔽。
     */
    const fuzzy = findFuzzy(fullText, exact);
    return fuzzy !== null
      ? { ok: true, start: fuzzy, end: fuzzy + exact.length, confidence: 'fuzzy' }
      : lost;
  }

  if (hits.length === 1) {
    const idx = hits[0]!;
    return { ok: true, start: idx, end: idx + exact.length, confidence: 'quote' };
  }

  // 多处出现：按前后文匹配度打分，取最高分
  let best = hits[0]!;
  let bestScore = -1;
  for (const idx of hits) {
    const before = fullText.slice(Math.max(0, idx - CONTEXT_LEN), idx);
    const after = fullText.slice(idx + exact.length, idx + exact.length + CONTEXT_LEN);
    const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return { ok: true, start: best, end: best + exact.length, confidence: 'quote' };
}

/** b 的末尾与 a 的末尾有多少字符相同 */
function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** a 的开头与 b 的开头有多少字符相同 */
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * 近似查找：逐字比对，允许少量差异（OCR 修正错字后会出现这种情况）。
 *
 * 用简单的滑动窗口 + 相同字符比例判断，不做完整的编辑距离 ——
 * 一页文本几千字，O(n*m) 的动态规划会明显卡顿，
 * 而这个功能只是「尽量找回」，精度要求不高。
 *
 * @returns 最相似的起始位置；找不到返回 null
 */
function findFuzzy(fullText: string, exact: string): number | null {
  const n = exact.length;
  if (n === 0 || fullText.length < n) return null;

  // 太短的引文不做模糊匹配：2 个字几乎哪儿都能匹配上，纯属噪音
  if (n < 6) return null;

  const target = exact.replace(/\s/g, '');
  if (target.length === 0) return null;

  let bestIdx: number | null = null;
  let bestRatio = 0;
  /**
   * 步长必须细。
   *
   * 最初用 `n/4`（24 字时步长 6），结果跳过了正确起点 ——
   * 那个位置的匹配度是 0.958，但采样点落在偏移 3 处，只有 0.83，
   * 而阈值是 0.7，居然也能过… 问题是起点偏了 3 个字，
   * 高亮会从句子中间开始，看起来像标记漂移。
   *
   * 改成每 2 个字扫一次。一页几千字、引文几十字，
   * 计算量是 O(篇幅 × 引文长 / 2)，在现代机器上可忽略；
   * 而准确性直接决定用户会不会觉得「标记跑到别处了」。
   */
  const step = 2;

  for (let i = 0; i + n <= fullText.length; i += step) {
    const window = fullText.slice(i, i + n).replace(/\s/g, '');
    if (window.length === 0) continue;
    let same = 0;
    const len = Math.min(window.length, target.length);
    for (let k = 0; k < len; k++) {
      if (window[k] === target[k]) same++;
    }
    const ratio = same / Math.max(window.length, target.length);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIdx = i;
    }
  }

  // 阈值 0.7：低于这个比例的匹配基本是巧合，报出来反而误导用户
  return bestRatio >= 0.7 ? bestIdx : null;
}

/**
 * 把一段 DOM 文本（可能被拆在多个节点里）按「页内纯文本偏移」切开。
 *
 * 渲染时要知道「从第 start 个字符到第 end 个字符」对应哪些
 * 文本节点片段 —— 一个高亮可能跨好几个 <span>。
 *
 * @param nodes 该页内的文本节点（按文档顺序）
 * @returns 每个与区间相交的节点 → 该节点内的局部区间
 */
export function sliceByOffset(
  nodes: readonly { node: Text; start: number }[],
  start: number,
  end: number,
): { node: Text; start: number; end: number }[] {
  const out: { node: Text; start: number; end: number }[] = [];
  for (const { node, start: nodeStart } of nodes) {
    const len = node.data.length;
    const nodeEnd = nodeStart + len;
    if (nodeEnd <= start || nodeStart >= end) continue;
    out.push({
      node,
      start: Math.max(0, start - nodeStart),
      end: Math.min(len, end - nodeStart),
    });
  }
  return out;
}

/** 标记的默认颜色 */
export const MARK_COLORS = {
  highlight: '#fde68a',
  underline: '#2563eb',
  strikethrough: '#ef4444',
  /*
   * 备注没有"颜色"这个概念 —— 它不改文字样式。
   * 但这个值要给小圆点用（见 reader-page.css 的 .reader-note-dot），
   * 取 info 蓝而非朱砂：朱砂留给主操作。
   */
  note: '#86a9c6',
} as const;

/** 标记的显示名 */
export const MARK_LABELS = {
  highlight: '高亮',
  underline: '下划线',
  strikethrough: '删除线',
  note: '备注',
} as const;

/**
 * 这条 mark 是不是「整页备注」（2026-11-11）。
 *
 * 整页备注与划选备注共用 `note` 类型，区别在锚点形状：
 *  - 划选备注：exact 是被选中的那句话，start/end 只覆盖那句
 *  - 整页备注：exact 为整段首句（可能被截断），start=0 且 end 覆盖整段
 *
 * 判定用 start === 0 且覆盖长度接近整段 —— 不能只看 start===0，
 * 因为用户可能正好从第一个字开始划选。
 *
 * @param mark 待判定的标记
 * @param segmentLength 该段正文的总长度（不含 trim）
 */
export function isWholePageNote(
  mark: { kind: string; anchor: { start: number; end: number } },
  segmentLength: number,
): boolean {
  if (mark.kind !== 'note') return false;
  if (mark.anchor.start !== 0) return false;
  /* 容差：整页备注的 end 允许与段长差一点（trim / 末尾换行） */
  return mark.anchor.end >= segmentLength - 2;
}
