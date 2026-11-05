import { describe, expect, it } from 'vitest';
import {
  MIN_SIZE,
  defaultBox,
  grabOffset,
  moveBox,
  pxToRatio,
  resizeBox,
  type RatioBox,
} from './overlay-geometry.ts';

/**
 * 拖拽几何的测试。
 *
 * 这组守的是「拖了但位置差一点」那类缺陷：鼠标按在图的中间，
 * 拖一下图却跳一下；或者拉左上角时右下角跟着动。
 * 这类偏差在小窗口里几乎看不见，在 4K 屏上很明显，靠手试很难复现。
 *
 * 所有输入输出的坐标都是 0~1 的比例（与数据层一致）。
 */

const box: RatioBox = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };

describe('pxToRatio：像素 → 比例', () => {
  it('正常换算', () => {
    expect(pxToRatio(100, 1000)).toBeCloseTo(0.1);
    expect(pxToRatio(-50, 500)).toBeCloseTo(-0.1);
  });

  it('容器尺寸为 0 时返回 0（不是 NaN/Infinity）', () => {
    // 元素还没布局完就收到 pointermove 是会发生的
    expect(pxToRatio(100, 0)).toBe(0);
    expect(pxToRatio(100, -1)).toBe(0);
    expect(pxToRatio(100, NaN)).toBe(0);
  });

  it('结果不会是 NaN（NaN 流进 state 会让图整个消失）', () => {
    expect(Number.isNaN(pxToRatio(50, 0))).toBe(false);
  });
});

describe('moveBox：移动不改尺寸', () => {
  it('按位移整体平移', () => {
    const next = moveBox(box, { dx: 0.1, dy: 0.05 });
    expect(next.x).toBeCloseTo(0.3);
    expect(next.y).toBeCloseTo(0.35);
    // 尺寸一动不动
    expect(next.w).toBe(box.w);
    expect(next.h).toBe(box.h);
  });

  it('负位移同理', () => {
    const next = moveBox(box, { dx: -0.1, dy: -0.1 });
    expect(next.x).toBeCloseTo(0.1);
    expect(next.y).toBeCloseTo(0.2);
  });

  it('不会把块拖到完全看不见（至少留一点在画面内）', () => {
    // 往左上狂拖
    const farLeft = moveBox(box, { dx: -5, dy: -5 });
    expect(farLeft.x).toBeGreaterThan(-box.w);
    expect(farLeft.y).toBeGreaterThan(-box.h);

    // 往右下狂拖
    const farRight = moveBox(box, { dx: 5, dy: 5 });
    expect(farRight.x).toBeLessThan(1);
    expect(farRight.y).toBeLessThan(1);
  });

  it('允许露出一部分到页外（用户可能就想这样）', () => {
    const next = moveBox(box, { dx: 0.6, dy: 0 });
    // 0.2 + 0.6 = 0.8，还在界内
    expect(next.x).toBeLessThanOrEqual(1);
  });

  it('返回新对象，不改原对象', () => {
    const original = { ...box };
    moveBox(box, { dx: 1, dy: 1 });
    expect(box).toEqual(original);
  });
});

describe('resizeBox：拉角时对角固定', () => {
  it('拉右下角：左上角不动，宽高变大', () => {
    const next = resizeBox(box, 'se', { dx: 0.1, dy: 0.05 });
    expect(next.x).toBeCloseTo(box.x);
    expect(next.y).toBeCloseTo(box.y);
    expect(next.w).toBeCloseTo(box.w + 0.1);
    expect(next.h).toBeCloseTo(box.h + 0.05);
  });

  it('拉左上角：右下角固定（x/y 变，w/h 反向变）', () => {
    const next = resizeBox(box, 'nw', { dx: -0.1, dy: -0.05 });
    // 左上角跟手走
    expect(next.x).toBeCloseTo(box.x - 0.1);
    expect(next.y).toBeCloseTo(box.y - 0.05);
    expect(next.w).toBeCloseTo(box.w + 0.1);
    expect(next.h).toBeCloseTo(box.h + 0.05);

    // 右边位置必须还在原处
    expect(next.x + next.w).toBeCloseTo(box.x + box.w);
    expect(next.y + next.h).toBeCloseTo(box.y + box.h);
  });

  it('拉右上角：左下角固定', () => {
    const next = resizeBox(box, 'ne', { dx: 0.1, dy: -0.05 });
    expect(next.y + next.h).toBeCloseTo(box.y + box.h); // 下边不动
    expect(next.x).toBeCloseTo(box.x); // 左边不动
    expect(next.w).toBeCloseTo(box.w + 0.1);
    expect(next.h).toBeCloseTo(box.h + 0.05);
  });

  it('拉左边（e/w 单边）：高度不变', () => {
    const next = resizeBox(box, 'w', { dx: -0.1, dy: 0.3 });
    expect(next.h).toBe(box.h);
    expect(next.w).toBeCloseTo(box.w + 0.1);
  });

  it('尺寸不会小于最小值（压扁到 0 就再也点不中）', () => {
    const tiny = resizeBox(box, 'se', { dx: -9, dy: -9 });
    expect(tiny.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(tiny.h).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  it('尺寸不会变成负数（负数在 pptx 里是无效值）', () => {
    const negative = resizeBox(box, 'nw', { dx: 9, dy: 9 });
    expect(negative.w).toBeGreaterThan(0);
    expect(negative.h).toBeGreaterThan(0);
  });
});

describe('grabOffset：按住时保持抓取点', () => {
  it('按在中间再拖，块不会跳到鼠标位置', () => {
    // 块在 (0.2, 0.3)，用户按在块正中间 = (0.4, 0.4)
    const offset = grabOffset(box, { dx: 0.4, dy: 0.4 });
    expect(offset.dx).toBeCloseTo(0.2);
    expect(offset.dy).toBeCloseTo(0.1);

    /**
     * 用这个偏移反推：把块移到指针位置时，减去偏移就得到正确的左上角。
     * 不做这一步的话，一按下块就会瞬移到鼠标下面。
     */
    const pointer = { dx: 0.5, dy: 0.5 };
    const newX = pointer.dx - offset.dx;
    const newY = pointer.dy - offset.dy;
    expect(newX).toBeCloseTo(0.3);
    expect(newY).toBeCloseTo(0.4);
  });

  it('按在左上角时偏移为 0', () => {
    const offset = grabOffset(box, { dx: box.x, dy: box.y });
    expect(offset.dx).toBeCloseTo(0);
    expect(offset.dy).toBeCloseTo(0);
  });
});

describe('defaultBox：新插入内容的初始位置', () => {
  it('居中而不是左上角（左上角通常已有标题）', () => {
    const b = defaultBox(0.75);
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 1);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 1);
  });

  it('按图片比例算高度（不把图拉扁）', () => {
    const wide = defaultBox(0.5); // 宽图片：高更小
    const tall = defaultBox(1.5); // 高图片：高更大
    expect(tall.h).toBeGreaterThan(wide.h);
  });

  it('高度不会超出页面', () => {
    const veryTall = defaultBox(10);
    expect(veryTall.h).toBeLessThanOrEqual(1);
  });

  it('宽高都是正数', () => {
    const b = defaultBox(0.75);
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
  });
});
