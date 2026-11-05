/**
 * 拖拽编辑用的坐标换算。
 *
 * ## 为什么单独抽出来并写测试
 *
 * 拖拽最容易出的错不是「拖不动」，而是**拖了但位置差一点**：
 * 鼠标在图上按住的地方和图的左上角不是一回事，于是拖一下图就跳一下。
 * 这类偏差在 4K 屏上明显、在小窗口里几乎看不见，靠手试很难复现，
 * 所以把换算做成纯函数，用测试钉死。
 *
 * 所有函数都在「比例空间」（0~1）里工作，与数据层存的格式一致。
 */

/** 一块矩形，用比例表示（0~1），x/y 是左上角 */
export interface RatioBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次指针移动的位移，用比例表示 */
export interface RatioDelta {
  dx: number;
  dy: number;
}

/**
 * 把像素位移换算成比例位移。
 *
 * @param px 像素位移
 * @param sizePx 容器在该方向上的像素尺寸
 *
 * 容器尺寸为 0 时返回 0 而不是 Infinity/NaN：
 * 元素还没布局完就收到 pointermove 是会发生的（首帧、切换页），
 * 让 NaN 流进 state 会让整块图消失，且看不出原因。
 */
export function pxToRatio(px: number, sizePx: number): number {
  if (!Number.isFinite(sizePx) || sizePx <= 0) return 0;
  return px / sizePx;
}

/**
 * 移动：返回新框，**保持尺寸不变**。
 *
 * 不夹紧到 0~1 之内是刻意的 —— 允许把图拖出页面边缘一部分，
 * 用户可以自己决定要不要露出半张图。真正要防止的是拖到
 * 完全看不见的地方（那样再也选不中），所以只做「至少留一点在画面内」。
 */
export function moveBox(box: RatioBox, delta: RatioDelta): RatioBox {
  const next = { ...box, x: box.x + delta.dx, y: box.y + delta.dy };

  // 至少留 10% 在画面内，否则用户再也点不到它
  const margin = 0.1;
  next.x = clamp(next.x, -box.w + margin, 1 - margin);
  next.y = clamp(next.y, -box.h + margin, 1 - margin);

  return next;
}

/** 拉伸的八个方向 */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 最小尺寸（比例）。太小就点不中，也没法再拉回来 */
export const MIN_SIZE = 0.04;

/**
 * 拉伸：按方向把手调整对应边，**对角固定**。
 *
 * 例：拖右下角（'se'）时左上角不动、宽高变大；
 * 拖左上角（'nw'）时右下角不动，所以 x/y 跟着变、w/h 反向变。
 *
 * 只允许「反向拉」而不许「穿过对角」：宽或高被压到 MIN_SIZE 就停住，
 * 而不是翻成负数 —— 负尺寸在 pptx 里是无效值，导出会得到坏文件。
 */
export function resizeBox(box: RatioBox, handle: ResizeHandle, delta: RatioDelta): RatioBox {
  let { x, y, w, h } = box;

  const growsLeft = handle.includes('w');
  const growsRight = handle.includes('e');
  const growsTop = handle.includes('n');
  const growsBottom = handle.includes('s');

  if (growsLeft) {
    // 左边往左拉：x 变小、w 变大，右边固定
    const nextW = clamp(w - delta.dx, MIN_SIZE, 1);
    x = x + (w - nextW);
    w = nextW;
  } else if (growsRight) {
    w = clamp(w + delta.dx, MIN_SIZE, 1);
  }

  if (growsTop) {
    const nextH = clamp(h - delta.dy, MIN_SIZE, 1);
    y = y + (h - nextH);
    h = nextH;
  } else if (growsBottom) {
    h = clamp(h + delta.dy, MIN_SIZE, 1);
  }

  return { x, y, w, h };
}

/**
 * 按住某块时的「抓取偏移」。
 *
 * 用户按在图的中间再拖，图应该跟着鼠标走，而不是让左上角跳到鼠标位置。
 * 所以记下「按下点相对块左上角」的偏移，移动时一直保持它。
 */
export function grabOffset(box: RatioBox, pointer: RatioDelta): RatioDelta {
  return { dx: pointer.dx - box.x, dy: pointer.dy - box.y };
}

/**
 * 新插入内容的默认位置：居中，占 60% 宽。
 *
 * 不放在左上角：那里通常已有标题，盖上就等于用户一插入就看不见内容。
 */
export function defaultBox(aspect = 0.75): RatioBox {
  const w = 0.6;
  const h = Math.min(0.6 * aspect, 0.8);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
