import { describe, expect, it } from 'vitest';
import { badgeCounts, resolvePool } from './data-sync.ts';

/**
 * 数据同步决策。
 *
 * 锁的是用户 2026-11-08 报的 bug：
 * 「我把题库里的题都删掉了，但待复习便签还显示 15 道，重启后才正常。」
 *
 * 根因是卡片池不刷新。修复的两个关键决策在这里被钉死。
 */

describe('resolvePool：读失败时保持旧池子', () => {
  it('读失败（null）→ 继续用当前池子', () => {
    const cur = ['q1', 'q2'];
    const r = resolvePool(null, cur);
    expect(r.effective).toEqual(cur);
    expect(r.shouldUpdate).toBe(false);
  });

  /*
   * 这一条是重点：读失败时**不能**清成空数组。
   * 清掉的话界面会突然显示「0 道题」，用户以为题全丢了 ——
   * 比显示旧数字糟得多。
   */
  it('读失败时不会变成空数组', () => {
    const r = resolvePool(null, ['q1']);
    expect(r.effective).not.toEqual([]);
    expect(r.effective).toHaveLength(1);
  });

  it('当前池子是空、读也失败 → 仍是空（但不报错）', () => {
    const r = resolvePool(null, []);
    expect(r.effective).toEqual([]);
    expect(r.shouldUpdate).toBe(false);
  });
});

describe('resolvePool：读到新值时更新', () => {
  it('题被删光 → 新池子是空，且要更新 state', () => {
    const r = resolvePool([], ['q1', 'q2']);
    expect(r.effective).toEqual([]);
    expect(r.shouldUpdate).toBe(true);
  });

  it('题变多 → 用新的', () => {
    const r = resolvePool(['q1', 'q2', 'q3'], ['q1']);
    expect(r.effective).toHaveLength(3);
    expect(r.shouldUpdate).toBe(true);
  });

  it('内容没变时也更新（宁可多渲染，不要漏刷新）', () => {
    const r = resolvePool(['q1'], ['q1']);
    expect(r.effective).toEqual(['q1']);
    /*
     * 为什么 shouldUpdate 仍是 true：池子没变不代表数据没变 ——
     * 里面每道题的复习状态可能变了（刚做完一轮）。
     * 界面很小，多渲染一次的代价远小于漏刷新。
     */
    expect(r.shouldUpdate).toBe(true);
  });

  /*
   * 这条是那个 bug 的核心：
   * 算数字必须用「刚读到的」池子，不能用 state 里的旧值。
   * 否则删完题还是按旧池子数，等于没修。
   */
  it('effective 一定是刚读到的那个，不是旧的', () => {
    const fresh = ['q_remaining'];
    const stale = ['q1', 'q2', 'q3'];
    const r = resolvePool(fresh, stale);
    expect(r.effective).toEqual(fresh);
    expect(r.effective).not.toBe(stale);
  });
});

describe('badgeCounts：侧栏徽标', () => {
  it('有到期时才显示 review', () => {
    expect(badgeCounts(9, 2)).toEqual({ sources: 2, review: 9 });
  });

  /*
   * 0 时不放这个键。
   * 显示一个「0」的徽标等于在喊「有 0 件事要做」，纯噪音。
   */
  it('到期为 0 → 不出现 review 键', () => {
    const b = badgeCounts(0, 2);
    expect(b).toEqual({ sources: 2 });
    expect('review' in b).toBe(false);
  });

  it('资料数为 0 也要显示（库是空的这件事本身有意义）', () => {
    expect(badgeCounts(0, 0)).toEqual({ sources: 0 });
  });

  it('两者都大于 0', () => {
    expect(badgeCounts(3, 5)).toEqual({ sources: 5, review: 3 });
  });
});
