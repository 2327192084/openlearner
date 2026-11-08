import { describe, expect, it } from 'vitest';
import { isSingleChoice, pickOption } from './option-pick.ts';

/**
 * 选项点击规则。
 *
 * 这一组锁的是 2026-11-08 靠截图才发现的 bug：
 * 判断题可以同时选中「对」和「错」，然后提交按钮变灰、用户卡死。
 *
 * 前两轮一直没抓到，因为真实模型没出过判断题，
 * 「判断题渲染」这条验证欠了两轮。
 */
describe('isSingleChoice', () => {
  it('单选与判断是单选题型', () => {
    expect(isSingleChoice('single')).toBe(true);
    expect(isSingleChoice('truefalse')).toBe(true);
  });

  it('多选、填空、简答、知识点不是', () => {
    expect(isSingleChoice('multiple')).toBe(false);
    expect(isSingleChoice('blank')).toBe(false);
    expect(isSingleChoice('short')).toBe(false);
    expect(isSingleChoice('point')).toBe(false);
  });
});

describe('pickOption：判断题', () => {
  it('点「对」→ 选中它', () => {
    expect(pickOption('truefalse', [], 'T')).toEqual(['T']);
  });

  /*
   * 这是那个 bug 的核心断言。
   * 旧实现走多选分支，会得到 ['T','F']，然后提交按钮禁用。
   */
  it('已选「对」再点「错」→ 替换，不会两个都选中', () => {
    const next = pickOption('truefalse', ['T'], 'F');
    expect(next).toEqual(['F']);
    expect(next).toHaveLength(1); // canSubmit 要求恰好 1 个
  });

  it('无论点什么，结果永远恰好 1 个', () => {
    let picked: string[] = [];
    for (const k of ['T', 'F', 'T', 'F']) {
      picked = pickOption('truefalse', picked, k);
      expect(picked).toHaveLength(1);
    }
  });

  it('再点已选中的那一个 → 仍然选中它（不会取消）', () => {
    // 允许取消会让提交按钮突然变灰，用户不知道发生了什么
    expect(pickOption('truefalse', ['T'], 'T')).toEqual(['T']);
  });
});

describe('pickOption：单选', () => {
  it('替换', () => {
    expect(pickOption('single', ['A'], 'C')).toEqual(['C']);
  });

  it('再点已选中的 → 仍选中（不取消）', () => {
    expect(pickOption('single', ['A'], 'A')).toEqual(['A']);
  });
});

describe('pickOption：多选', () => {
  it('逐个加入', () => {
    expect(pickOption('multiple', ['A'], 'C')).toEqual(['A', 'C']);
  });

  it('再点一次取消', () => {
    expect(pickOption('multiple', ['A', 'C'], 'A')).toEqual(['C']);
  });

  it('可以清空（多选允许 0 个然后重新选）', () => {
    expect(pickOption('multiple', ['A'], 'A')).toEqual([]);
  });
});

describe('pickOption：其它题型原样返回', () => {
  it('填空题不经过选项点击', () => {
    expect(pickOption('blank', [], 'A')).toEqual([]);
  });

  it('简答题不经过选项点击', () => {
    expect(pickOption('short', ['x'], 'A')).toEqual(['x']);
  });
});
