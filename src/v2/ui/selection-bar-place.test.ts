import { describe, expect, it } from 'vitest';
import {
  BAR_GAP,
  VIEWPORT_MARGIN,
  isUsableAnchor,
  placeBar,
} from './selection-bar-place.ts';
import type { RectLike } from './selection-bar-place.ts';

/** 视口 1280x800，浮层 160x36 —— 都是本项目真实量级的量级 */
const VIEWPORT = { width: 1280, height: 800 };
const BAR = { width: 160, height: 36 };

function rect(left: number, top: number, width = 200, height = 20): RectLike {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function place(anchor: RectLike, bar = BAR, viewport = VIEWPORT) {
  return placeBar({ anchor, bar, viewport });
}

describe('placeBar 垂直', () => {
  it('空间够时放在选区上方（不挡住刚选中的字）', () => {
    const out = place(rect(400, 300));
    expect(out.placement).toBe('above');
    expect(out.top).toBe(300 - BAR.height - BAR_GAP);
  });

  it('贴着页面顶端时翻到下方', () => {
    const out = place(rect(400, 2));
    expect(out.placement).toBe('below');
    expect(out.top).toBe(2 + 20 + BAR_GAP);
  });

  it('上方刚好够（等于 VIEWPORT_MARGIN）时仍放上方', () => {
    const top = BAR.height + BAR_GAP + VIEWPORT_MARGIN;
    const out = place(rect(400, top));
    expect(out.placement).toBe('above');
    expect(out.top).toBe(VIEWPORT_MARGIN);
  });

  it('上方差 1px 就翻到下方', () => {
    const top = BAR.height + BAR_GAP + VIEWPORT_MARGIN - 1;
    const out = place(rect(400, top));
    expect(out.placement).toBe('below');
  });

  it('选区在页面底部且下方也放不下时，夹紧到视口内而不是溢出', () => {
    const out = place(rect(400, 790, 200, 20));
    expect(out.top + BAR.height + VIEWPORT_MARGIN).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('上下都放不下（选区几乎满屏）时浮层仍完整可见', () => {
    const out = place(rect(0, 100, 1280, 700));
    expect(out.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(out.top + BAR.height).toBeLessThanOrEqual(VIEWPORT.height);
  });
});

describe('placeBar 水平', () => {
  it('居中于选区', () => {
    const anchor = rect(500, 300, 200); // 中心 600
    const out = place(anchor);
    expect(out.left).toBe(600 - BAR.width / 2);
  });

  it('选区贴左边时夹到 VIEWPORT_MARGIN，不出现负坐标', () => {
    const out = place(rect(0, 300, 40));
    expect(out.left).toBe(VIEWPORT_MARGIN);
  });

  it('选区贴右边时夹紧，右侧不出视口', () => {
    const out = place(rect(1200, 300, 80));
    expect(out.left + BAR.width + VIEWPORT_MARGIN).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('浮层比视口还宽时靠左留边，不返回负数', () => {
    const out = place(rect(500, 300), { width: 2000, height: 36 });
    expect(out.left).toBe(VIEWPORT_MARGIN);
  });
});

describe('placeBar 退化输入', () => {
  it('NaN 宽度不会传成 NaN 出去（否则 style 里变成 "NaNpx"）', () => {
    const out = placeBar({
      anchor: { left: 100, top: 300, right: 300, bottom: 320, width: 200, height: 20 },
      bar: { width: Number.NaN, height: 36 },
      viewport: VIEWPORT,
    });
    expect(Number.isFinite(out.left)).toBe(true);
    expect(Number.isFinite(out.top)).toBe(true);
  });

  it('视口为 0 时仍返回有限数', () => {
    const out = placeBar({
      anchor: rect(0, 0),
      bar: BAR,
      viewport: { width: 0, height: 0 },
    });
    expect(Number.isFinite(out.left)).toBe(true);
    expect(Number.isFinite(out.top)).toBe(true);
  });
});

describe('isUsableAnchor', () => {
  it('正常矩形可用', () => {
    expect(isUsableAnchor(rect(10, 10))).toBe(true);
  });

  it('全零矩形不可用（会跑到左上角，看着像坏了）', () => {
    expect(isUsableAnchor({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })).toBe(false);
  });

  it('null / undefined 不可用', () => {
    expect(isUsableAnchor(null)).toBe(false);
    expect(isUsableAnchor(undefined)).toBe(false);
  });

  it('NaN 尺寸不可用', () => {
    expect(
      isUsableAnchor({ left: 0, top: 0, right: 0, bottom: 0, width: Number.NaN, height: 10 }),
    ).toBe(false);
  });
});
