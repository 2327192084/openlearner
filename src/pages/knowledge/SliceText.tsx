import type { ReactNode } from 'react';

/**
 * 原文高亮切分渲染（P2 校对界面用）。
 *
 * 两条从 P1 继承下来的硬规矩，这里原样遵守：
 *
 * 1. **不用 `dangerouslySetInnerHTML`**。资料正文来自学生随手下载的文件，
 *    把文字当 HTML 插进 DOM 意味着里面任何 `<script>` 都会执行。
 *    用 React 分段渲染，文本永远只是文本。
 * 2. **按原文坐标切分**。切段只为排版，绝不改变坐标系：
 *    偏移始终相对 `SourceSegment.text`，与 anchors 的 charStart/charEnd 同一套坐标，
 *    所以高亮不会因为分段而错位。
 *
 * 为什么不像阅读器那样直接复用 `HighlightedText`：
 * 那个组件把 `reader__p` / `reader__mark` 样式写死在资料页的 CSS 里，
 * 跨页引用会让「改资料页样式」意外改到知识点页。这里用独立的 `kp-text__*` 类。
 */

export interface SliceRange {
  charStart: number;
  charEnd: number;
}

interface Block {
  start: number;
  end: number;
  text: string;
}

/** 按「一个及以上空行」切段，同时保留每块在原文中的偏移 */
export function splitParagraphs(text: string): Block[] {
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
 * 把任意范围的偏移裁到合法区间。
 *
 * 为什么需要：`charStart/charEnd` 来自落库时的实测结果，
 * 但资料可能被重新导入过（段文本变了），旧锚点就会越界。
 * 越界时 React 切出来是空字符串 —— 界面上表现为「高亮没了」，
 * 比抛错更难查。这里统一裁掉，并且把 start >= end 的空范围直接丢弃。
 */
export function clampRanges(text: string, ranges: SliceRange[]): SliceRange[] {
  const out: SliceRange[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, Math.floor(range.charStart)));
    const end = Math.max(0, Math.min(text.length, Math.floor(range.charEnd)));
    if (end > start) out.push({ charStart: start, charEnd: end });
  }
  // 排序便于逐块顺序渲染；同起点时长的在前，保证外层先闭合
  return out.sort((a, b) => a.charStart - b.charStart || b.charEnd - a.charEnd);
}

/** 两段范围是否重叠；「当前选中」的判定用它，而不是全等 */
export function overlaps(a: SliceRange, b: SliceRange): boolean {
  return a.charStart < b.charEnd && a.charEnd > b.charStart;
}

export function SliceText({
  text,
  ranges,
  activeRange,
  activeRef,
}: {
  text: string;
  /** 本段正文上要标出来的所有锚点范围 */
  ranges: SliceRange[];
  /** 当前选中的知识点对应范围，用更实的底色标出 */
  activeRange: SliceRange | null;
  /** 把当前选中高亮的 DOM 节点交回调用方，用于 scrollIntoView */
  activeRef?: (el: HTMLElement | null) => void;
}) {
  const blocks = splitParagraphs(text);
  const safeRanges = clampRanges(text, ranges);

  return (
    <>
      {blocks.map((block, index) => (
        <p className="kp-text__p" key={`${block.start}-${index}`}>
          {renderBlock(block, text, safeRanges, activeRange, activeRef)}
        </p>
      ))}
    </>
  );
}

function renderBlock(
  block: Block,
  fullText: string,
  ranges: SliceRange[],
  activeRange: SliceRange | null,
  activeRef: ((el: HTMLElement | null) => void) | undefined,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = block.start;

  for (const range of ranges) {
    // 只处理与本块相交的部分；块外的部分由相邻块负责
    if (range.charEnd <= block.start || range.charStart >= block.end) continue;

    const start = Math.max(range.charStart, block.start);
    const end = Math.min(range.charEnd, block.end);
    if (end <= start) continue;

    if (start > cursor) nodes.push(fullText.slice(cursor, start));

    const isActive = activeRange !== null && overlaps(activeRange, { charStart: start, charEnd: end });

    nodes.push(
      <mark
        key={`${start}-${end}`}
        className={`kp-text__mark${isActive ? ' kp-text__mark--active' : ''}`}
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
