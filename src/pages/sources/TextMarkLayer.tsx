import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextMark, TextMarkKind } from '@/core/model.ts';
import { MARK_COLORS, resolveTextAnchor } from '@/core/text-anchor.ts';

/**
 * 文本标记（高亮 / 下划线 / 删除线）的渲染层。
 *
 * ## 为什么覆盖一层 div，而不是直接改文字样式
 *
 * 直接给文字套 `<mark>` 或改 `background-color` 有致命问题：
 * React 重新渲染、或者用户翻页再回来，那些行内标签就没了；
 * 而且会污染原文 DOM —— 搜索命中高亮、词法渲染都会打架。
 *
 * 所以做法是：**不动原文一个节点**，在它上面绝对定位一层
 * 只画背景色的小块。原文怎么变都不影响标记数据，
 * 标记位置由锚点重新算出来。
 *
 * ## 定位方式
 *
 * 用 `Range.getClientRects()` 拿到每行文字的矩形，
 * 相对容器左上角换算成绝对定位。一个高亮跨三行就是三个 div ——
 * 这是浏览器给的标准答案，比我们自己算换行可靠得多。
 */

export interface TextMarkLayerProps {
  /** 这一页的纯文本（与锚点建立时同一份来源） */
  fullText: string;
  /** 这一页的标记 */
  marks: readonly TextMark[];
  /** 承载文字的容器，用于测量与定位 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 点击某个标记（打开备注编辑） */
  onSelect?: (mark: TextMark) => void;
  /** 锚点还原失败时回调，界面要如实告知 */
  onStale?: (mark: TextMark) => void;
}

interface RenderedRect {
  mark: TextMark;
  /** 相对容器的像素位置 */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function TextMarkLayer({
  fullText,
  marks,
  containerRef,
  onSelect,
  onStale,
}: TextMarkLayerProps) {
  const [rects, setRects] = useState<RenderedRect[]>([]);
  const layerRef = useRef<HTMLDivElement | null>(null);

  /**
   * 把标记换算成屏幕矩形。
   *
   * 需要遍历容器里的文本节点，把「页内纯文本偏移」映射到真实 DOM 位置。
   * 用 TreeWalker 而不是 innerText：innerText 会插入看不见的换行，
   * 与实际字符偏移对不上。
   */
  const compute = useCallback(() => {
    const container = containerRef.current;
    const layer = layerRef.current;
    if (!container || !layer) return;

    /**
     * 只扫正文元素，不扫整个容器。
     *
     * 容器里除了正文还有批注层工具栏（图标也是文本节点），
     * 一起遍历会让偏移偏掉，高亮画到错误的位置。
     */
    const textRoot =
      container.querySelector('.reader__p') ??
      container.querySelector('p') ??
      container;

    // 定位基准是正文元素，不是整块容器（后者含工具栏，会让标记偏移）
    const containerRect = textRoot.getBoundingClientRect();

    // 收集正文里的文本节点及其在纯文本里的起始偏移
    const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; start: number }[] = [];
    let offset = 0;
    let n: Node | null = walker.nextNode();
    while (n) {
      const t = n as Text;
      nodes.push({ node: t, start: offset });
      offset += t.data.length;
      n = walker.nextNode();
    }
    if (nodes.length === 0) {
      setRects([]);
      return;
    }

    const out: RenderedRect[] = [];

    for (const mark of marks) {
      const resolved = resolveTextAnchor(fullText, mark.anchor);
      if (!resolved.ok) {
        onStale?.(mark);
        continue;
      }

      // 把字符偏移映射到范围
      const range = document.createRange();
      let startSet = false;
      let endSet = false;

      for (const { node, start: nodeStart } of nodes) {
        const nodeEnd = nodeStart + node.data.length;
        if (!startSet && resolved.start >= nodeStart && resolved.start < nodeEnd) {
          range.setStart(node, resolved.start - nodeStart);
          startSet = true;
        }
        if (!endSet && resolved.end > nodeStart && resolved.end <= nodeEnd) {
          range.setEnd(node, resolved.end - nodeStart);
          endSet = true;
        }
        if (startSet && endSet) break;
      }

      // 边界情况：选区正好结束在某个节点末尾
      if (startSet && !endSet) {
        const last = nodes[nodes.length - 1]!;
        if (resolved.end <= last.start + last.node.data.length) {
          range.setEnd(last.node, resolved.end - last.start);
          endSet = true;
        }
      }

      if (!startSet || !endSet) {
        onStale?.(mark);
        continue;
      }

      /**
       * 一行一个矩形。
       *
       * getClientRects 给的是每行的框，跨行高亮自然拆成多个方块。
       * 用返回值而不是自己算换行：中英文混排、字体回退、
       * 各种 CSS 都可能改变折行位置，自己算必然出错。
       */
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({
          mark,
          left: r.left - containerRect.left,
          top: r.top - containerRect.top,
          width: r.width,
          height: r.height,
        });
      }
    }

    setRects(out);
  }, [containerRef, fullText, marks, onStale]);

  // 初次与依赖变化时重算
  useEffect(() => {
    compute();
  }, [compute]);

  /**
   * 尺寸变化时重算。
   *
   * 窗口变宽变窄会改变折行，高亮的矩形必须跟着重算，
   * 否则会看到标记错位或宽度不对。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', compute);
      return () => window.removeEventListener('resize', compute);
    }
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [compute, containerRef]);

  return (
    <div ref={layerRef} className="mark-layer" aria-hidden="true">
      {rects.map((r, i) => (
        <div
          key={`${r.mark.id}-${i}`}
          className={`mark-box mark-box--${r.mark.kind}`}
          style={{
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            ...(r.mark.kind === 'highlight'
              ? { background: r.mark.color ?? MARK_COLORS.highlight }
              : {}),
            ...(r.mark.kind === 'underline'
              ? { borderBottomColor: r.mark.color ?? MARK_COLORS.underline }
              : {}),
            ...(r.mark.kind === 'strikethrough'
              ? { borderTopColor: r.mark.color ?? MARK_COLORS.strikethrough }
              : {}),
          }}
          // 标记本身可点击（打开备注），但不能挡住文字选择
          onClick={() => onSelect?.(r.mark)}
        />
      ))}
    </div>
  );
}

/** 默认颜色查询，供界面在没指定颜色时使用 */
export function defaultMarkColor(kind: TextMarkKind): string {
  return MARK_COLORS[kind];
}
