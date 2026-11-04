import type { ReactNode } from 'react';

/**
 * 高亮切分渲染。
 *
 * 为什么不用 `dangerouslySetInnerHTML`：把资料正文当 HTML 插进 DOM，
 * 意味着教材里任何一段 `<script>`、`<img onerror=...>` 都会执行 ——
 * 资料来自学生随手下载的文件，这条路径必须当成不可信输入。
 * 用 React 分段渲染，文本永远只是文本。
 *
 * 为什么按「段落块」而不是整段文本渲染：
 * PDF 取出的正文段落用 `\n\n` 分隔。直接 `white-space: pre-wrap` 也能保住换行，
 * 但段落没有独立的间距，长文读起来很闷。这里先把文本按空行切块，
 * 每块一个 `<p>`，块内再做高亮切片 —— 偏移始终是**原文坐标**（segment.text），
 * 切块只是为了排版，不改变坐标系，所以高亮不会错位。
 */

export interface HighlightRange {
  charStart: number;
  charEnd: number;
}

interface Block {
  start: number;
  end: number;
  text: string;
}

/** 按「一个及以上空行」切段，同时保留每块在原文中的偏移 */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const breaker = /\n{2,}/g;

  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = breaker.exec(text)) !== null) {
    blocks.push({ start: from, end: match.index, text: text.slice(from, match.index) });
    from = match.index + match[0].length;
  }
  blocks.push({ start: from, end: text.length, text: text.slice(from) });

  // 首尾空串与连续空行会产出空块，滤掉；有内容的块保留原偏移
  return blocks.filter((b) => b.text.length > 0);
}

/**
 * 合并重叠命中。
 *
 * core 的 search() 允许重叠（「aa」在「aaa」里返回 2 处），
 * 但渲染时嵌套 `<mark>` 会让文字重复显示。合并成并集即可；
 * 命中列表本身仍逐条展示，与 core 的行为保持一致。
 */
export function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd);

  const merged: HighlightRange[] = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.charStart < last.charEnd) {
      const end = Math.max(last.charEnd, range.charEnd);
      merged[merged.length - 1] = { charStart: last.charStart, charEnd: end };
    } else {
      merged.push({ charStart: range.charStart, charEnd: range.charEnd });
    }
  }
  return merged;
}

export function HighlightedText({
  text,
  ranges,
  active,
  activeRef,
}: {
  text: string;
  ranges: HighlightRange[];
  /** 当前点击的那一处命中，用更实的底色标出，便于在满屏高亮里找回定位 */
  active: HighlightRange | null;
  /** 把当前命中的 DOM 节点交回调用方，用于 scrollIntoView */
  activeRef?: (el: HTMLElement | null) => void;
}) {
  const blocks = splitBlocks(text);
  const merged = mergeRanges(ranges);

  return (
    <>
      {blocks.map((block, blockIndex) => (
        <p className="reader__p" key={blockIndex}>
          {renderBlock(block, text, merged, active, activeRef)}
        </p>
      ))}
    </>
  );
}

function renderBlock(
  block: Block,
  fullText: string,
  ranges: HighlightRange[],
  active: HighlightRange | null,
  activeRef: ((el: HTMLElement | null) => void) | undefined,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = block.start;

  for (const range of ranges) {
    // 只处理与本块相交的部分；块外的部分由相邻块负责
    if (range.charEnd <= block.start || range.charStart >= block.end) continue;

    const start = Math.max(range.charStart, block.start);
    const end = Math.min(range.charEnd, block.end);

    if (start > cursor) nodes.push(fullText.slice(cursor, start));

    // 「当前命中」判定用重叠而非全等：并集合并后，点击的窄命中可能落在更宽的并集里
    const isActive =
      active !== null && active.charStart < end && active.charEnd > start;

    nodes.push(
      <mark
        key={`${start}-${end}`}
        className={`reader__mark${isActive ? ' reader__mark--active' : ''}`}
        ref={isActive && activeRef ? activeRef : undefined}
      >
        {fullText.slice(start, end)}
      </mark>,
    );

    cursor = end;
  }

  if (cursor < block.end) nodes.push(fullText.slice(cursor, block.end));
  return nodes;
}
