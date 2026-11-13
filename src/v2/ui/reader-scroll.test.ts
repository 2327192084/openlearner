import { describe, expect, it } from 'vitest';
import {
  EMPTY_SCROLL_MEMORY,
  MAX_REMEMBERED,
  MIN_MEANINGFUL_TOP,
  rememberScroll,
  scrollFor,
  worthRemembering,
} from './reader-scroll.ts';

/**
 * 阅读器滚动位置记忆的单测。
 *
 * ## 为什么这块要测
 *
 * 三个错法在界面上都**看不出是 bug**：
 *  1. 夹取写错 → 用户翻回去发现停在底部，以为「记忆坏了」但说不出所以然
 *  2. 淘汰顺序写错 → 反复读的那段被优先忘掉，表现为「有时记得有时不记得」
 *  3. 记了 0 → 每段都从顶部开始，和没做这个功能一样
 *
 * 这三条都只有单测能钉住。
 */

describe('rememberScroll', () => {
  it('记下某段的位置', () => {
    const m = rememberScroll(EMPTY_SCROLL_MEMORY, 3, 480);
    expect(m.get(3)).toBe(480);
  });

  it('负数夹到 0（时钟/布局异常不该产生负偏移）', () => {
    expect(rememberScroll(EMPTY_SCROLL_MEMORY, 1, -50).get(1)).toBe(0);
  });

  it('小数取整（scrollTop 本身可能是小数，存下来没意义）', () => {
    expect(rememberScroll(EMPTY_SCROLL_MEMORY, 1, 120.7).get(1)).toBe(121);
  });

  it('同一段重复记会覆盖，不产生两条', () => {
    let m = rememberScroll(EMPTY_SCROLL_MEMORY, 2, 100);
    m = rememberScroll(m, 2, 300);
    expect(m.size).toBe(1);
    expect(m.get(2)).toBe(300);
  });

  it('不改动传入的 Map（纯函数）', () => {
    const base = rememberScroll(EMPTY_SCROLL_MEMORY, 1, 100);
    rememberScroll(base, 2, 200);
    expect(base.size).toBe(1);
  });

  it('超过上限时淘汰最旧的，且保留最新的', () => {
    let m = EMPTY_SCROLL_MEMORY;
    for (let i = 0; i < MAX_REMEMBERED + 5; i++) m = rememberScroll(m, i, 100 + i);
    expect(m.size).toBe(MAX_REMEMBERED);
    /* 最早的 5 个（0..4）应该被淘汰 */
    expect(m.has(0)).toBe(false);
    expect(m.has(4)).toBe(false);
    /* 最后插入的还在 */
    expect(m.has(MAX_REMEMBERED + 4)).toBe(true);
  });

  it('重新访问老段会让它变成「最新」，不被优先淘汰', () => {
    let m = EMPTY_SCROLL_MEMORY;
    for (let i = 0; i < MAX_REMEMBERED; i++) m = rememberScroll(m, i, 100);
    /* 再访问第 0 段 */
    m = rememberScroll(m, 0, 500);
    /* 再塞一个新的，触发淘汰 */
    m = rememberScroll(m, 999, 300);
    /* 第 0 段因为刚被访问过，应该还在（被淘汰的应该是原来的第 1 段） */
    expect(m.has(0)).toBe(true);
    expect(m.has(1)).toBe(false);
  });
});

describe('scrollFor', () => {
  const m = rememberScroll(
    rememberScroll(EMPTY_SCROLL_MEMORY, 3, 800),
    4,
    300,
  );

  it('没记过的段返回 0', () => {
    expect(scrollFor(m, 99, 1000)).toBe(0);
  });

  it('记过的段返回原值', () => {
    expect(scrollFor(m, 4, 1000)).toBe(300);
  });

  it('记忆值超过当前可滚上限时夹到上限（内容变短了）', () => {
    /* 第 3 段记的是 800，但现在只能滚 200 */
    expect(scrollFor(m, 3, 200)).toBe(200);
  });

  it('maxTop 为 0（还没渲染出内容）时一律回 0，不乱跳', () => {
    expect(scrollFor(m, 3, 0)).toBe(0);
  });

  it('maxTop 为负或 NaN 时回 0', () => {
    expect(scrollFor(m, 3, -10)).toBe(0);
    expect(scrollFor(m, 3, Number.NaN)).toBe(0);
  });
});

describe('worthRemembering', () => {
  it('接近顶部的位置不值得记', () => {
    expect(worthRemembering(0)).toBe(false);
    expect(worthRemembering(MIN_MEANINGFUL_TOP - 1)).toBe(false);
  });

  it('滚下去之后值得记', () => {
    expect(worthRemembering(MIN_MEANINGFUL_TOP)).toBe(true);
    expect(worthRemembering(999)).toBe(true);
  });

  it('NaN 不记', () => {
    expect(worthRemembering(Number.NaN)).toBe(false);
  });
});
