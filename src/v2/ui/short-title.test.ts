import { describe, expect, it } from 'vitest';
import { shortTitle } from './short-title.ts';

/**
 * 横板节点标题截断（2026-11-21 深夜）。
 *
 * 横板一屏要放下好几步，节点太宽就只能看到两三个，
 * 反而看不出「这条路有多长」。所以标题要截短，但**不能把词切断**。
 *
 * 这条功能本身很小，但它有一个真实的坏实现：
 * `s.slice(0, max) + '…'` —— 会把「第一章 函数与极限」切成
 * 「第一章 函数与极…」，读起来断在半路。所以要测。
 */

describe('shortTitle', () => {
  it('短标题原样返回（不加省略号）', () => {
    expect(shortTitle('第1章')).toBe('第1章');
    expect(shortTitle('绪论')).toBe('绪论');
  });

  it('⚠️ 在标点处断开，不从词中间切', () => {
    /*
     * 坏实现 `s.slice(0,14) + '…'` 会得到「第一章 函数与极限的…」这种
     * 断在词中间的串。按标点断开才读得自然。
     */
    const t = '第1章 函数与极限，包括映射与函数、数列极限等内容';
    const out = shortTitle(t, 14);
    expect(out.length).toBeLessThanOrEqual(15); // 14 + 省略号
    /* 断点落在逗号处，所以结果里不该出现逗号后的内容 */
    expect(out).not.toContain('包括');
  });

  it('空格也算可断点（章名与节名之间常有空格）', () => {
    const out = shortTitle('第2章 导数与微分 中值定理', 10);
    expect(out).not.toContain('中值定理');
  });

  it('找不到合适断点时截断加省略号', () => {
    const t = '这是一个没有任何标点的很长的中文标题需要截断';
    const out = shortTitle(t, 8);
    expect(out.endsWith('…')).toBe(true);
  });

  it('首尾空白被去掉', () => {
    expect(shortTitle('  第1章  ')).toBe('第1章');
  });

  it('空标题不崩', () => {
    expect(shortTitle('')).toBe('');
    expect(shortTitle('   ')).toBe('');
  });
});