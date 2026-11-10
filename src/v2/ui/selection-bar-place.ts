/**
 * 选区浮层的定位几何（2026-11-10）。
 *
 * ## 为什么单独一个文件
 *
 * 「把浮层放在选区旁边」看着是两行 CSS 的事，实际有一串边界：
 * 选区在页面最上面（浮层放上面会跑出屏幕）、最下面、
 * 贴左边（居中会被裁掉一半）、贴右边、以及浮层比屏幕还宽。
 * 这些全是纯算术，**不该埋在组件里靠试** —— 2026-11-10 那天
 * 有 5 个 bug 是「测试全绿、界面错」，其中「错题页右侧空一大块」
 * 就是没量几何。所以把算术拿出来单测，组件只负责把结果套上 style。
 *
 * 本文件不碰 DOM：入参全是数字，返回也是数字。
 */

/** 浮层与选区之间留多少像素（视口坐标） */
export const BAR_GAP = 8;

/** 浮层与视口边缘的最小距离，防止贴边看着像被切掉 */
export const VIEWPORT_MARGIN = 8;

/** 放不下时最终落到哪边。'above' = 选区上方，'below' = 下方 */
export type BarPlacement = 'above' | 'below';

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PlaceBarInput {
  /** 选区的视口矩形（Range.getBoundingClientRect()） */
  anchor: RectLike;
  /** 浮层自身尺寸（要等渲染后才能量到） */
  bar: { width: number; height: number };
  /** 视口尺寸 */
  viewport: { width: number; height: number };
}

export interface PlaceBarResult {
  /** 浮层的 left（视口坐标，已夹紧） */
  left: number;
  /** 浮层的 top（视口坐标，已夹紧） */
  top: number;
  /** 实际落在上边还是下边 —— 用于给浮层加一个小箭头朝向 */
  placement: BarPlacement;
}

/**
 * 算出浮层该放在哪。
 *
 * 规则按优先级：
 *  1. 优先放**上方**（不挡住用户刚选中的那行字）
 *  2. 上方放不下 → 放下方
 *  3. 上下都放不下（选区几乎占满视口）→ 仍放下方并夹紧，
 *     至少保证浮层完整可见（宁可盖住一点字，也不能跑到屏幕外）
 *  4. 水平居中于选区，再夹进视口
 *
 * ## 为什么水平方向夹紧要用「浮层宽度」而不是半个
 *
 * 居中公式 `anchor.left + anchor.width/2 - bar.width/2` 在浮层比选区宽时
 * 会让 left 跑到负数（选区贴左边）。夹紧到 `VIEWPORT_MARGIN` 即可。
 * 但如果浮层自己比视口还宽，两个约束冲突 —— 此时让步给「靠左留边」，
 * 右边溢出交给 CSS 的 max-width 处理。这里如实返回数字，不假装能装下。
 */
export function placeBar({ anchor, bar, viewport }: PlaceBarInput): PlaceBarResult {
  /* 水平：居中后夹紧 */
  const centeredLeft = anchor.left + anchor.width / 2 - bar.width / 2;
  const maxLeft = viewport.width - bar.width - VIEWPORT_MARGIN;
  const left = clamp(centeredLeft, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft));

  /* 垂直：先试上方 */
  const aboveTop = anchor.top - bar.height - BAR_GAP;
  if (aboveTop >= VIEWPORT_MARGIN) {
    return { left, top: aboveTop, placement: 'above' };
  }

  /* 上方放不下 → 下方（同样夹紧，防止底部溢出） */
  const belowTop = anchor.bottom + BAR_GAP;
  const maxTop = viewport.height - bar.height - VIEWPORT_MARGIN;
  return {
    left,
    top: clamp(belowTop, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop)),
    placement: 'below',
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 选区矩形是否「值得显示浮层」。
 *
 * 全零矩形是浏览器在「选区跨了 display:none 的节点」或
 * 「选区已失效」时的产物 —— 那时浮层会跑到左上角（0,0），
 * 看着像界面坏了。宁可不显示。
 */
export function isUsableAnchor(anchor: RectLike | null | undefined): anchor is RectLike {
  if (!anchor) return false;
  if (!Number.isFinite(anchor.width) || !Number.isFinite(anchor.height)) return false;
  return anchor.width > 0 || anchor.height > 0;
}
