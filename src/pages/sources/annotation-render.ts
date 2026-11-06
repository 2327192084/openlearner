import type { InkStroke, ShapeElement, ShapeKind, PenKind } from '@/core/model.ts';
import type { Pt } from '@/core/annotation-geometry.ts';

/**
 * 标注的绘制引擎（canvas 2D）。
 *
 * ## 为什么单独抽出来
 *
 * 五种笔形、四种图形的画法差别很大，混在组件里会既难读又难测。
 * 这里全部是「(ctx, 元素, 尺寸) → 画」的纯绘制函数，
 * 组件只负责调度。
 *
 * ## 坐标约定
 *
 * 所有元素坐标是页面比例（0~1）。这里统一乘上 w/h 变成像素，
 * 所以同一份数据在任何显示尺寸下都画在相同的相对位置。
 */

/** 各笔形的绘制参数：透明度、端点、混合方式 */
export interface PenStyle {
  alpha: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  /** 是否用「随速变宽」的压感模拟（钢笔/铅笔） */
  pressure: boolean;
  /** 轻微抖动（铅笔的草稿感） */
  jitter: number;
  /** 用叠加混合（马克笔叠色加深而不变黑） */
  multiply: boolean;
}

export const PEN_STYLES: Record<PenKind, PenStyle> = {
  pen: { alpha: 1, lineCap: 'round', lineJoin: 'round', pressure: true, jitter: 0, multiply: false },
  marker: { alpha: 0.75, lineCap: 'square', lineJoin: 'miter', pressure: false, jitter: 0, multiply: true },
  highlighter: { alpha: 0.3, lineCap: 'butt', lineJoin: 'round', pressure: false, jitter: 0, multiply: true },
  pencil: { alpha: 0.85, lineCap: 'round', lineJoin: 'round', pressure: true, jitter: 0.35, multiply: false },
  /**
   * 激光笔：不落墨，只是高亮光点。
   *
   * 半透明 + 圆形端点让它看起来像光斑。
   * 普通激光笔松手就消失，这里保留但用低透明度 ——
   * 用户明确画了就该留下痕迹，否则「画完看不见」会被当成失败。
   */
  laser: { alpha: 0.55, lineCap: 'round', lineJoin: 'round', pressure: false, jitter: 0, multiply: false },
};

/** 从笔迹推断笔形（兼容老的 highlighter 布尔字段） */
export function strokePenKind(stroke: InkStroke): PenKind {
  if (stroke.kind) return stroke.kind;
  return stroke.highlighter ? 'highlighter' : 'pen';
}

/**
 * 画一笔。
 *
 * 分段绘制而不是一条 path 画完：压感模拟需要每段不同的线宽，
 * canvas 的 lineWidth 是全局状态，只能一段一段改。
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  w: number,
  h: number,
  /** 叠加一层光晕（激光笔拖动时用） */
  glow = false,
): void {
  const pts = stroke.points;
  if (pts.length === 0) return;

  const kind = strokePenKind(stroke);
  const style = PEN_STYLES[kind];
  const baseWidth = Math.max(0.5, stroke.width * w);

  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = style.alpha;
  ctx.lineCap = style.lineCap;
  ctx.lineJoin = style.lineJoin;
  if (style.multiply) ctx.globalCompositeOperation = 'multiply';

  if (glow) {
    ctx.shadowColor = stroke.color;
    ctx.shadowBlur = Math.max(4, baseWidth * 2);
  }

  // 单点：画一个圆点（点一下也要留痕）
  if (pts.length === 1) {
    const p = pts[0]!;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, baseWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (style.pressure) {
    drawWithPressure(ctx, pts, w, h, baseWidth, style.jitter);
  } else {
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x * w, pts[0]!.y * h);
    // 二次贝塞尔平滑：直接 lineTo 在低采样率下会有明显折角
    for (let i = 1; i < pts.length - 1; i++) {
      const c = pts[i]!;
      const n = pts[i + 1]!;
      const mx = ((c.x + n.x) / 2) * w;
      const my = ((c.y + n.y) / 2) * h;
      ctx.quadraticCurveTo(c.x * w, c.y * h, mx, my);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last.x * w, last.y * h);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * 压感绘制：按移动速度改变线宽。
 *
 * 快 = 细，慢 = 粗。这是真实笔的手感 —— 快速划过时笔尖接触时间短，
 * 落墨少。用一个确定性的伪随机做铅笔抖动，避免每次重绘纹理都变。
 */
function drawWithPressure(
  ctx: CanvasRenderingContext2D,
  pts: readonly Pt[],
  w: number,
  h: number,
  baseWidth: number,
  jitter: number,
): void {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = (b.x - a.x) * w;
    const dy = (b.y - a.y) * h;
    const dist = Math.hypot(dx, dy);

    /**
     * 压感效果：按「这一段的像素长度」相对基准缩放线宽。
     *
     * ⚠️ 这里踩过坑，写清楚免得再犯：
     * 最初写成 `speed = dist / 12`，然后又改成 `dist / (baseWidth*6)`。
     * 两次都错，因为**笔迹会被 simplifyStroke 简化** ——
     * 一条 30 个采样点的线简化后可能只剩首尾 2 个点，
     * 那一段的距离是几百像素，任何固定分母都会让它「极速」，
     * 线宽触底到不可见，表现为「钢笔画不上」（inkAfter = 0）。
     *
     * 现在按「相对页面宽度」归一：一段跨整个页面宽算最快。
     * 这样无论简化成几个点，线宽都在合理区间内。
     */
    const pageW = Math.max(1, w);
    const speed = Math.min(dist / (pageW * 0.25), 1);
    const width = baseWidth * (1 - 0.35 * speed);

    let ax = a.x * w;
    let ay = a.y * h;
    let bx = b.x * w;
    let by = b.y * h;

    if (jitter > 0) {
      // 基于坐标的确定性抖动：同一笔每次重绘纹理一致
      const n1 = pseudoNoise(i * 12.9898) * jitter;
      const n2 = pseudoNoise(i * 78.233) * jitter;
      ax += n1;
      ay += n2;
      bx += n1;
      by += n2;
    }

    /**
     * 逐段设置线宽后累积 path、最后统一 stroke 不行 ——
     * lineWidth 是全局状态，不同宽度的段必须分别 stroke。
     * 所以这里一段一次，但要保证最细不小于 0.8px：低于这个
     * 值在屏幕上几乎不可见，用户会以为没画上。
     */
    ctx.lineWidth = Math.max(0.8, width);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
}

/** 确定性伪随机（同一输入永远同一输出），范围 -1~1 */
function pseudoNoise(seed: number): number {
  const x = Math.sin(seed) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * 画一个图形。
 *
 * 矩形与椭圆支持填充；线/箭头不支持（fill 为 null）。
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: ShapeElement,
  w: number,
  h: number,
): void {
  const x1 = shape.x1 * w;
  const y1 = shape.y1 * h;
  const x2 = shape.x2 * w;
  const y2 = shape.y2 * h;

  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.fill ?? 'transparent';
  ctx.lineWidth = Math.max(1, shape.width * w);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const kind: ShapeKind = shape.kind;

  if (kind === 'rect') {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1);
    const rh = Math.abs(y2 - y1);
    if (shape.fill) {
      ctx.fillRect(x, y, rw, rh);
    }
    ctx.strokeRect(x, y, rw, rh);
  } else if (kind === 'ellipse') {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    ctx.stroke();
  } else {
    // 直线与箭头的杆
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    if (kind === 'arrow') {
      drawArrowHead(ctx, x1, y1, x2, y2, Math.max(1, shape.width * w));
    }
  }

  ctx.restore();
}

/**
 * 箭头头部。
 *
 * 用两条斜线而不是实心三角：实心在细线宽下看起来像个疙瘩，
 * 两条线在任何线宽下都读得出「这是箭头」。
 * 头部长度随线宽变化，但不小于 6px（太小的箭头看不清方向）。
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = Math.max(6, lineWidth * 4);
  const spread = Math.PI / 7;

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread));
  ctx.stroke();
}

/** 画套索轨迹（虚线，表示"正在框选"） */
export function drawLasso(
  ctx: CanvasRenderingContext2D,
  points: readonly Pt[],
  w: number,
  h: number,
): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(points[0]!.x * w, points[0]!.y * h);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i]!.x * w, points[i]!.y * h);
  }
  // 闭合回起点，让用户看到"框住的范围"
  ctx.lineTo(points[0]!.x * w, points[0]!.y * h);
  ctx.stroke();
  ctx.restore();
}

/** 画选中高亮（套索选中后给元素描一层蓝边） */
export function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  box: { x1: number; y1: number; x2: number; y2: number },
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    box.x1 * w - 3,
    box.y1 * h - 3,
    (box.x2 - box.x1) * w + 6,
    (box.y2 - box.y1) * h + 6,
  );
  ctx.restore();
}

/** 给测试用的别名（导出表本身，避免测试依赖内部命名） */
export const PEN_STYLES_FOR_TEST = PEN_STYLES;
