import type { SourceAnnotation, InkStroke, TextNote } from './model.ts';

/**
 * 资料页面注释的工具函数。
 *
 * 类型定义在 model.ts（与其它业务模型放在一起，存储层要从那里取）。
 * 这里只放纯函数：判空、汇总、颜色常量。
 * 全部是纯函数，便于单测钉死行为。
 */

/** 注释面板可选的笔色 */
export const INK_COLORS = [
  { id: 'red', value: '#e11d48', label: '红' },
  { id: 'blue', value: '#2563eb', label: '蓝' },
  { id: 'green', value: '#16a34a', label: '绿' },
  { id: 'yellow', value: '#eab308', label: '黄' },
  { id: 'black', value: '#111827', label: '黑' },
] as const;

/**
 * 默认笔迹粗细（页面宽度比例）。
 *
 * 0.0035 × 1200px ≈ 4px —— 写字不糊，也不至于盖住原文。
 * 存比例而不是像素：窗口缩放时笔迹不该跟着变粗变细。
 */
export const DEFAULT_INK_WIDTH = 0.0035;

/** 荧光笔粗细，明显更宽 */
export const HIGHLIGHTER_WIDTH = 0.02;

/**
 * 注释里是否有可显示的内容。
 *
 * ⚠️ 必须把 shapes 也算进来。
 * 早先只判 strokes 和 texts，于是「只画了一个矩形」的页面被判成空注释，
 * 保存时直接删除 —— 表现是「图形画出来了，刷新就没了」。
 * 这个 bug 只在「页面上只有图形、没有笔迹和文字」时出现，
 * 所以混着笔迹测试时完全看不出来。
 */
export function hasContent(annotation: SourceAnnotation): boolean {
  return (
    annotation.strokes.length > 0 ||
    annotation.texts.length > 0 ||
    (annotation.shapes?.length ?? 0) > 0
  );
}

/**
 * 是否为空注释。
 *
 * 空注释不该写进库：用户点一下画笔又取消，就会留下一条
 * 「这条资料有笔记」的记录，实际什么都没有 —— 那种假标记比没有更烦人。
 */
export function isAnnotationEmpty(annotation: SourceAnnotation): boolean {
  return !hasContent(annotation);
}

/** 某份资料里有注释的页码集合 —— 列表与目录据此显示标记 */
export function pagesWithAnnotations(all: readonly SourceAnnotation[]): Set<number> {
  return new Set(all.filter(hasContent).map((a) => a.page));
}

/** 一份资料的注释摘要，用于显示「N 页有笔记」 */
export function annotationSummary(all: readonly SourceAnnotation[]): {
  pages: number;
  strokes: number;
  texts: number;
} {
  const withContent = all.filter(hasContent);
  return {
    pages: withContent.length,
    strokes: withContent.reduce((n, a) => n + a.strokes.length, 0),
    texts: withContent.reduce((n, a) => n + a.texts.length, 0),
  };
}

/** 新建一条空注释（页面第一次被画时用） */
export function createAnnotation(
  id: string,
  sourceId: string,
  page: number,
  now: string,
): SourceAnnotation {
  return { id, sourceId, page, strokes: [], texts: [], createdAt: now, updatedAt: now };
}

export type { SourceAnnotation, InkStroke, TextNote };
