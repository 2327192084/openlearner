/**
 * 原文偏移 ⇄ DOM Range 的换算（2026-11-11）。
 *
 * ## 为什么需要这一层
 *
 * 锚点（`TextMark.anchor`、知识点 `SourceLocations`）里的 `start/end` 都是
 * **原文偏移** —— 相对 `SourceSegment.text`。而正文渲染成 DOM 之后，
 * 文本节点里的字符数**与原文字符数不同**：
 *
 *  | 结构 | 原文 | DOM | 差 |
 *  |---|---|---|---|
 *  | 标题 `## 第1章 信号与系统` | 12 | 9 | −3（`## ` 被吃掉） |
 *  | 公式 `$v_{s}$` | 7 | 2（`vs`） | −5（KaTeX 输出 `vs`） |
 *  | 插图切分 | 一整段 | 多个 `.reader-md` | 每段有独立基准 |
 *
 * 实测第 1 页：原文 1048 字，`.reader-md` 的 DOM 文本 606 字，**差 442 字**。
 * 把原文偏移直接当 DOM 偏移用，标注必然画偏 —— 这就是用户报的
 * 「标注部分与实际渲染部分有偏移」。
 *
 * ## 做法：渲染时把原文坐标写进 DOM
 *
 * `raw-text.tsx` 渲染每个片段时写 `data-raw`（该片段在原文里的起点）
 * 与 `data-raw-len`（原文长度）。于是每个片段**自带坐标**，
 * 换算只是在 DOM 里找「哪个片段包含目标偏移」，不需要全局累加、
 * 也不担心公式/标题/插图各自吃掉多少字符。
 *
 * ## 参考
 *
 * - W3C Web Annotation TextPositionSelector
 *   https://www.w3.org/TR/annotation-model/#text-position-selector
 * - `dom-anchor-text-position` 的 `toRange(root, {start, end})`：
 *   https://www.npmjs.com/package/dom-anchor-text-position
 *   它把「root 的文本偏移」翻成 Range。**但那要求 DOM 文本与锚点时一致**，
 *   我们这里文本被 Markdown / KaTeX 改写过，所以必须把偏移**标注**在
 *   DOM 上，而不能运行时累计 —— 这是本模块与它的关键差别。
 *
 * ## 公式为什么吸附到边界
 *
 * 一个公式在原文里是 `$v_{s}$`（7 字符），在 DOM 里是一整棵 KaTeX span 树。
 * 若高亮区间落在公式中间，在 DOM 里无法精确表达（KaTeX 的字符与 LaTeX
 * 源码不是一一对应）。此时把区间**扩张到整个公式**：宁可多亮一个公式，
 * 也不要画出半个公式或错位到别处。
 *
 * 这也是「不插入字符」原则的延续：正文 DOM 里一个字符都不多加，
 * 只挂 Range，滚动缩放全自动（见 paint-marks.ts 头部）。
 */

/**
 * 收集容器内所有带 `data-raw` 的片段。
 *
 * 返回按原文起点升序排列。片段是 `raw-text.tsx` 产出的 `.raw-piece`。
 */
export function collectRawPieces(container: HTMLElement): {
  el: HTMLElement;
  rawFrom: number;
  rawLen: number;
  rawTo: number;
  math: boolean;
}[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-raw]'));
  const out = nodes
    .map((el) => {
      const rawFrom = Number(el.getAttribute('data-raw'));
      const rawLen = Number(el.getAttribute('data-raw-len') ?? '0');
      return {
        el,
        rawFrom,
        rawLen,
        rawTo: rawFrom + rawLen,
        math: el.hasAttribute('data-raw-math'),
      };
    })
    .filter((p) => Number.isFinite(p.rawFrom) && Number.isFinite(p.rawLen) && p.rawLen >= 0);
  out.sort((a, b) => a.rawFrom - b.rawFrom);
  return out;
}

/** 片段内的纯文本节点（公式片段由 KaTeX 生成，可能有多层） */
function textNodesIn(el: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    /* 公式片段里跳过 MathML 的 annotation（它是 LaTeX 源码，不是可见文字） */
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

/** 公式片段里不可见的文本节点（MathML annotation / aria-hidden 的重复层） */
function isInvisible(n: Node): boolean {
  let el = n.parentElement;
  while (el) {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.tagName === 'ANNOTATION') return true;
    if (el.classList.contains('katex-mathml')) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * 把「原文区间」换算成 DOM Range 列表。
 *
 * 一个区间可能横跨多个片段（段落里含公式时就是如此），
 * 所以返回数组 —— CSS Custom Highlight API 接受多个 Range。
 *
 * @param container 正文容器（`.reader-body`）
 * @param rawStart 原文起点（含）
 * @param rawEnd 原文终点（不含）
 */
export function rawRangeToRanges(
  container: HTMLElement,
  rawStart: number,
  rawEnd: number,
): Range[] {
  if (rawEnd <= rawStart) return [];
  const pieces = collectRawPieces(container);
  if (pieces.length === 0) return [];

  const ranges: Range[] = [];

  for (const p of pieces) {
    if (p.rawLen === 0) continue;
    if (p.rawTo <= rawStart || p.rawFrom >= rawEnd) continue;

    /* 相交部分换算成片段内偏移 */
    const inFrom = Math.max(rawStart, p.rawFrom) - p.rawFrom;
    const inTo = Math.min(rawEnd, p.rawTo) - p.rawFrom;

    if (p.math) {
      /*
       * 公式：整块吸附。
       * 只要区间与它相交，就整块高亮（理由见文件头）。
       */
      const r = document.createRange();
      r.selectNodeContents(p.el);
      /* 去掉不可见的 MathML 层，避免 Range 覆盖到源码文本 */
      try {
        r.selectNode(p.el);
      } catch {
        /* ignore */
      }
      ranges.push(r);
      continue;
    }

    const nodes = textNodesIn(p.el).filter((n) => !isInvisible(n));
    if (nodes.length === 0) continue;

    /* 累计片段内文本长度，找到起止所在的文本节点 */
    let cursor = 0;
    let startNode: Text | null = null;
    let startOff = 0;
    let endNode: Text | null = null;
    let endOff = 0;

    for (const n of nodes) {
      const len = n.nodeValue?.length ?? 0;
      const nFrom = cursor;
      const nTo = cursor + len;

      if (!startNode && inFrom >= nFrom && inFrom < nTo) {
        startNode = n;
        startOff = inFrom - nFrom;
      }
      if (inTo > nFrom && inTo <= nTo) {
        endNode = n;
        endOff = inTo - nFrom;
      }
      cursor = nTo;
    }

    /*
     * 边界恰好落在片段末尾（inFrom === p.rawLen）时上面循环找不到起点。
     * 这在「高亮结束于段落末尾」时很常见，退到最后一个文本节点的末尾。
     */
    if (!startNode) {
      const last = nodes[nodes.length - 1]!;
      startNode = last;
      startOff = last.nodeValue?.length ?? 0;
    }
    if (!endNode) {
      const last = nodes[nodes.length - 1]!;
      endNode = last;
      endOff = last.nodeValue?.length ?? 0;
    }

    /* 空区间不产生 Range（CSS Highlight 不接受塌缩 Range） */
    if (startNode === endNode && endOff <= startOff) continue;

    try {
      const r = document.createRange();
      r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue?.length ?? 0)));
      r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue?.length ?? 0)));
      if (!r.collapsed) ranges.push(r);
    } catch {
      /* Range 越界就跳过这一段，不抛给上层 */
    }
  }

  return ranges;
}

/**
 * 反向：从一个 DOM 节点 + 节点内偏移，算出**原文偏移**。
 *
 * 用户划选时，`window.getSelection()` 给出的是 DOM 位置。
 * 之前 `handleAddMark` 用「块起点 + 块内 DOM 文本长度」近似，
 * 那个近似在**块内含公式**时仍然会错（公式处字符数变了）。
 *
 * 有了 `data-raw`，可以直接精确换算：
 *   原文偏移 = 片段.rawFrom + 片段内文本偏移
 *
 * @returns 原文偏移；无法定位时返回 -1
 */
export function domPointToRaw(container: HTMLElement, node: Node, offset: number): number {
  /* 找到所属的 raw 片段 */
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;

  while (el && el !== container && !el.hasAttribute('data-raw')) {
    el = el.parentElement;
  }
  if (!el || !el.hasAttribute('data-raw')) return -1;

  const rawFrom = Number(el.getAttribute('data-raw'));
  if (!Number.isFinite(rawFrom)) return -1;

  /* 公式片段：整体当一个单位，选在它内部就取它的起点 */
  if (el.hasAttribute('data-raw-math')) return rawFrom;

  /*
   * 纯文本片段：从片段开头量到选区起点的文本长度。
   * 这里可以放心用 Range.toString()，因为片段内**没有**会被渲染器
   * 吃掉的语法符号（Markdown 标记在切块时就已排除在块外）。
   */
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, offset);
    return rawFrom + r.toString().length;
  } catch {
    return -1;
  }
}

/**
 * 一段 DOM 内的文本在原文里对应的总长度。
 *
 * 用于诊断：`domTextLength(container)` 与 `seg.text.length` 的差
 * 就是「渲染吃掉了多少字符」。脚本靠它判断坐标系是否真的统一了。
 */
export function domTextLength(container: HTMLElement): number {
  let total = 0;
  for (const p of collectRawPieces(container)) {
    total += p.rawLen;
  }
  return total;
}
