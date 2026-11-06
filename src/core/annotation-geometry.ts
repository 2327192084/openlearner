import type { InkStroke, ShapeElement, ShapeKind, PenKind } from './model.ts';

/**
 * 标注工具的几何计算。
 *
 * ## 为什么这些要单独抽成纯函数
 *
 * 命中检测、套索选择、包围盒这几件事最容易出错，而错了很难看出来：
 * 擦不掉的笔迹用户会以为卡住了，套索选错了会觉得"点不中"。
 * 全部做成纯函数（比例空间进出），就能用测试钉死边界行为，
 * 而不是靠手试。
 *
 * ## 坐标空间
 *
 * 全部输入输出都是**页面比例（0~1）**，与数据层存的格式一致。
 * 只有最终画到 canvas 时才乘上像素尺寸。
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 点到线段的距离（比例空间）。用于擦除与选择时的命中判定 */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  // 退化成一个点
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  // 投影参数夹到 [0,1]，得到线段上最近点
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** 点到整条笔迹的最短距离 */
export function distToStroke(p: Pt, stroke: InkStroke): number {
  const pts = stroke.points;
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);

  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(p, pts[i - 1]!, pts[i]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 某一笔是否被擦除工具「碰到」。
 *
 * 判定半径要把笔宽算进去：细笔画在屏幕上只有几像素，
 * 只按点的距离判定会让人觉得「点不准」。所以取
 * 「鼠标距离 < 笔宽一半 + 容差」。
 */
export function strokeHitByEraser(p: Pt, stroke: InkStroke, tolerance: number): boolean {
  const reach = stroke.width / 2 + tolerance;
  return distToStroke(p, stroke) <= reach;
}

/** 笔迹的包围盒 */
export function strokeBounds(stroke: InkStroke): Box | null {
  const pts = stroke.points;
  if (pts.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

/** 图形的包围盒（矩形/椭圆/线都按对角算） */
export function shapeBounds(shape: ShapeElement): Box {
  return {
    x1: Math.min(shape.x1, shape.x2),
    y1: Math.min(shape.y1, shape.y2),
    x2: Math.max(shape.x1, shape.x2),
    y2: Math.max(shape.y1, shape.y2),
  };
}

/** 一组点构成的包围盒（套索用） */
export function pointsBounds(points: readonly Pt[]): Box | null {
  if (points.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of points) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

/** 点是否在多边形内（射线法）。套索用 */
export function pointInPolygon(p: Pt, polygon: readonly Pt[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    // 判断射线是否穿过这条边
    const intersects = a.y > p.y !== b.y > p.y
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * 笔迹是否被套索选中。
 *
 * 判定标准：**任一采样点在多边形内**就算选中。
 * 不用「全部点都在内」的原因：一条横穿套索的长笔迹，
 * 两端在外面——按"全部在内"就选不中，用户会觉得套索没用。
 */
export function strokeCaughtByLasso(stroke: InkStroke, polygon: readonly Pt[]): boolean {
  if (polygon.length < 3) return false;
  return stroke.points.some((p) => pointInPolygon(p, polygon));
}

/** 图形是否被套索选中（用中心点判定，简单且符合直觉） */
export function shapeCaughtByLasso(shape: ShapeElement, polygon: readonly Pt[]): boolean {
  if (polygon.length < 3) return false;
  const b = shapeBounds(shape);
  const center = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
  if (pointInPolygon(center, polygon)) return true;
  // 图形较大、中心不在套索内但被部分覆盖时，也该算选中
  return [
    { x: b.x1, y: b.y1 },
    { x: b.x2, y: b.y1 },
    { x: b.x1, y: b.y2 },
    { x: b.x2, y: b.y2 },
  ].some((c) => pointInPolygon(c, polygon));
}

/** 平移一笔 */
export function translateStroke(stroke: InkStroke, dx: number, dy: number): InkStroke {
  return {
    ...stroke,
    points: stroke.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
  };
}

/** 平移一个图形 */
export function translateShape(shape: ShapeElement, dx: number, dy: number): ShapeElement {
  return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
}

/**
 * 笔迹简化（Douglas-Peucker）。
 *
 * 一条手写笔迹常有几百个点，其中大量点几乎共线。
 * 全部存下来会让 628 页教材的注释记录变得很大，渲染也慢。
 * 简化到容差以内不影响观感。
 *
 * @param tolerance 容差，比例空间。1e-4 大约相当于 1200px 宽下的 0.12px
 */
export function simplifyStroke(points: readonly Pt[], tolerance = 1e-4): Pt[] {
  if (points.length <= 2) return [...points];

  let maxDist = 0;
  let index = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyStroke(points.slice(0, index + 1), tolerance);
    const right = simplifyStroke(points.slice(index), tolerance);
    // 两边共享折点，去掉重复
    return [...left.slice(0, -1), ...right];
  }

  // 整段都足够直，只留首尾
  return [first, last];
}

/** 各笔形的默认线宽（页面宽度比例） */
export const PEN_WIDTHS: Record<PenKind, number> = {
  pen: 0.0035,
  marker: 0.012,
  highlighter: 0.02,
  pencil: 0.0025,
  laser: 0.006,
};

/** 笔形显示名 */
export const PEN_LABELS: Record<PenKind, string> = {
  pen: '钢笔',
  marker: '马克笔',
  highlighter: '荧光笔',
  pencil: '铅笔',
  laser: '激光笔',
};

/** 图形显示名 */
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  line: '直线',
  arrow: '箭头',
  rect: '矩形',
  ellipse: '椭圆',
};
