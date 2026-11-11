/**
 * `pagesArgToCoveredPages` 的测试（2026-11-11 晚）。
 *
 * 这个函数决定「分片解析时该清掉哪几页的旧图」。
 * 它的返回值直接决定用户会不会再遇到「解析 1-2 页后别的页的图没了」。
 *
 * 关键不变量：
 *  1. `all` → undefined（表示覆盖整份，清理全部旧图）
 *  2. `1-2` → [1, 2]（**只有这两页**，不能是 1..pageCount）
 *  3. 反向区间 `5-3` 也要能正确展开（MinerU 接受，别让用户的输入变成空集）
 *  4. 非法/空输入 → undefined（宁可全清，也不要「一页都不清」导致图堆积）
 */
import { describe, expect, it } from 'vitest';
import { pagesArgToCoveredPages, toPagesArg } from './PageRangePicker.tsx';

describe('pagesArgToCoveredPages', () => {
  it('all → undefined（完整解析，覆盖整份）', () => {
    expect(pagesArgToCoveredPages('all')).toBeUndefined();
  });

  it('空串 → undefined', () => {
    expect(pagesArgToCoveredPages('')).toBeUndefined();
    expect(pagesArgToCoveredPages('   ')).toBeUndefined();
  });

  it('★ 1-2 → [1, 2]（只有这两页，不是整本）', () => {
    expect(pagesArgToCoveredPages('1-2')).toEqual([1, 2]);
  });

  it('3-15 → 13 页连续', () => {
    const got = pagesArgToCoveredPages('3-15');
    expect(got).toHaveLength(13);
    expect(got![0]).toBe(3);
    expect(got![12]).toBe(15);
  });

  it('单页 → 单元素数组', () => {
    expect(pagesArgToCoveredPages('5')).toEqual([5]);
  });

  it('反向区间 5-3 → [3, 4, 5]（不产生空集）', () => {
    expect(pagesArgToCoveredPages('5-3')).toEqual([3, 4, 5]);
  });

  it('逗号分隔多段 1-2,7 → [1, 2, 7]', () => {
    expect(pagesArgToCoveredPages('1-2,7')).toEqual([1, 2, 7]);
  });

  it('全是垃圾输入 → undefined（退回全清，不留孤儿图）', () => {
    expect(pagesArgToCoveredPages('abc')).toBeUndefined();
    expect(pagesArgToCoveredPages('-')).toBeUndefined();
  });

  it('与 toPagesArg 往返一致：range 模式', () => {
    const arg = toPagesArg('range', '4', '9');
    expect(arg).toBe('4-9');
    expect(pagesArgToCoveredPages(arg)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('与 toPagesArg 往返一致：full 模式恒为 undefined', () => {
    expect(pagesArgToCoveredPages(toPagesArg('full', '1', '36'))).toBeUndefined();
  });

  it('起止相同时 toPagesArg 给单页，覆盖集合只有一个', () => {
    const arg = toPagesArg('range', '7', '7');
    expect(arg).toBe('7');
    expect(pagesArgToCoveredPages(arg)).toEqual([7]);
  });
});
