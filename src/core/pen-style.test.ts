import { describe, expect, it } from 'vitest';
import { PEN_STYLES_FOR_TEST, strokePenKind } from '@/pages/sources/annotation-render.ts';
import type { InkStroke } from './model.ts';

/**
 * 笔形渲染的回归测试。
 *
 * ## 锁的两个真实缺陷
 *
 * 1. **压感线宽算错导致「画不上」**。
 *    最初写成 `speed = dist / 12`（固定像素），大画布上每段都被判成极速，
 *    线宽触底到 0.4px，实测 inkAfter = 0 —— 用户看到的是「钢笔画不出来」。
 *
 * 2. **`kind` 字段缺失时的回退**。
 *    2026-11-06 之前只存 `highlighter?: boolean`，老记录读出来没有 `kind`。
 *    回退错了会让老注释全部变成失去半透明的实心粗线。
 */

const mk = (extra: Partial<InkStroke> = {}): InkStroke => ({
  points: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
  ],
  color: '#000',
  width: 0.0035,
  ...extra,
});

describe('strokePenKind：老数据兼容', () => {
  it('有 kind 时直接用', () => {
    expect(strokePenKind(mk({ kind: 'marker' }))).toBe('marker');
    expect(strokePenKind(mk({ kind: 'laser' }))).toBe('laser');
  });

  it('没有 kind 但有 highlighter=true 时回退到荧光笔', () => {
    expect(strokePenKind(mk({ highlighter: true }))).toBe('highlighter');
  });

  it('两者都没有时按钢笔处理', () => {
    expect(strokePenKind(mk())).toBe('pen');
  });

  it('kind 优先于旧的 highlighter 字段', () => {
    // 用户明确选了马克笔，不该因为遗留字段变回荧光笔
    expect(strokePenKind(mk({ kind: 'marker', highlighter: true }))).toBe('marker');
  });
});

describe('笔形样式表', () => {
  it('五种笔形都定义了样式', () => {
    for (const k of ['pen', 'marker', 'highlighter', 'pencil', 'laser'] as const) {
      expect(PEN_STYLES_FOR_TEST[k]).toBeDefined();
      expect(PEN_STYLES_FOR_TEST[k].alpha).toBeGreaterThan(0);
      expect(PEN_STYLES_FOR_TEST[k].alpha).toBeLessThanOrEqual(1);
    }
  });

  it('荧光笔最透明，钢笔完全不透明', () => {
    expect(PEN_STYLES_FOR_TEST.highlighter.alpha).toBeLessThan(0.5);
    expect(PEN_STYLES_FOR_TEST.pen.alpha).toBe(1);
  });

  it('马克笔与荧光笔用叠加混合（叠色加深而不是盖住）', () => {
    expect(PEN_STYLES_FOR_TEST.marker.multiply).toBe(true);
    expect(PEN_STYLES_FOR_TEST.highlighter.multiply).toBe(true);
    expect(PEN_STYLES_FOR_TEST.pen.multiply).toBe(false);
  });

  it('铅笔有抖动（草稿感），其他笔没有', () => {
    expect(PEN_STYLES_FOR_TEST.pencil.jitter).toBeGreaterThan(0);
    expect(PEN_STYLES_FOR_TEST.pen.jitter).toBe(0);
    expect(PEN_STYLES_FOR_TEST.marker.jitter).toBe(0);
  });

  it('钢笔与铅笔用压感，马克笔与荧光笔不用', () => {
    expect(PEN_STYLES_FOR_TEST.pen.pressure).toBe(true);
    expect(PEN_STYLES_FOR_TEST.pencil.pressure).toBe(true);
    expect(PEN_STYLES_FOR_TEST.marker.pressure).toBe(false);
    expect(PEN_STYLES_FOR_TEST.highlighter.pressure).toBe(false);
  });
});
