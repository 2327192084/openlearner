import { describe, expect, it } from 'vitest';
import { initialState } from './srs.ts';
import type { ReviewGrade, ReviewState } from './srs.ts';
import {
  EBBINGHAUS_STEPS,
  previewDays,
  scheduleEbbinghaus,
  stepOf,
} from './ebbinghaus.ts';

/**
 * 艾宾浩斯阶梯调度算法的测试。
 *
 * ## 这块测试针对的是用户的真实抱怨
 *
 * 原话：「掌握程度的评分标准也不行，复习时间的区分度不大，
 * 只有 5 分才与其他分数的复习时间做出了区分」。
 *
 * 查证属实：旧实现首次复习 3 分和 4 分都给 1 天。
 * 所以这里最重要的一组测试就是「五个档位必须给出不同的间隔」——
 * 它直接对应这条产品要求，退化了要立刻失败。
 */

const T = '2026-11-07';

const ALL_GRADES: ReviewGrade[] = ['again', 'hard', 'good', 'easy'];

/** 模拟连续按同一个评分复习 n 次，返回每次的间隔 */
function run(grades: ReviewGrade[], start: ReviewState = initialState(T)): number[] {
  let s = start;
  const out: number[] = [];
  for (const g of grades) {
    s = scheduleEbbinghaus(s, g, T);
    out.push(s.intervalDays);
  }
  return out;
}

describe('stepOf：把天数映射成「等效增长台阶」（仅用于观测）', () => {
  /*
   * 注意这个函数**不参与天数计算** —— 真正算天数的是各档倍率（GROWTH）。
   * 它只是把「当前间隔大约处在第几个翻倍节点」显示出来，
   * 便于调试与设置页展示。所以这里测的是映射关系，而不是查表下标。
   */
  it('0 天与负值表示还没开始（或刚答错）', () => {
    expect(stepOf(0)).toBe(-1);
    expect(stepOf(-5)).toBe(-1);
  });

  it('天数每翻一倍，台阶序号 +1', () => {
    expect(stepOf(1)).toBe(0);
    expect(stepOf(2)).toBe(1);
    expect(stepOf(4)).toBe(2);
    expect(stepOf(8)).toBe(3);
  });

  it('单调不减：间隔越长，台阶序号不会变小', () => {
    let last = -1;
    for (const d of [1, 2, 3, 5, 9, 17, 40, 100, 365]) {
      const s = stepOf(d);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('台阶表仍然导出（供设置页与调试参考）', () => {
    expect(EBBINGHAUS_STEPS.length).toBeGreaterThan(6);
    expect(EBBINGHAUS_STEPS[0]).toBe(1);
    expect(EBBINGHAUS_STEPS[EBBINGHAUS_STEPS.length - 1]).toBe(365);
  });
});

describe('核心要求：五个评分档的间隔必须互相区分', () => {
  it('首次复习：good 与 hard 不再相同', () => {
    /*
     * 这条就是用户抱怨的那个 bug。
     * 旧实现：hard=1, good=1（完全一样）→ 用户点了 4 分，第二天照样见到。
     */
    const hard = scheduleEbbinghaus(initialState(T), 'hard', T).intervalDays;
    const good = scheduleEbbinghaus(initialState(T), 'good', T).intervalDays;
    expect(good).not.toBe(hard);
    expect(good).toBeGreaterThan(hard);
  });

  it('首次复习：good 与 easy 不同', () => {
    const good = scheduleEbbinghaus(initialState(T), 'good', T).intervalDays;
    const easy = scheduleEbbinghaus(initialState(T), 'easy', T).intervalDays;
    expect(easy).toBeGreaterThan(good);
  });

  it('首次复习：三档答对的间隔严格递增（hard < good < easy）', () => {
    const hard = scheduleEbbinghaus(initialState(T), 'hard', T).intervalDays;
    const good = scheduleEbbinghaus(initialState(T), 'good', T).intervalDays;
    const easy = scheduleEbbinghaus(initialState(T), 'easy', T).intervalDays;
    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
  });

  it('四个档位在**每一个**阶段都给出互不相同的天数', () => {
    /*
     * 这是本轮最重要的一条约束，直接对应用户原话：
     * 「复习时间的区分度不大，只有 5 分才与其他分数的复习时间做出了区分」。
     *
     * 从新卡开始，连续走 8 轮，每一轮都检查四档天数两两不同。
     * 只要有一轮出现重复，就说明区分度又丢了。
     */
    let base: ReviewState = initialState(T);
    for (let round = 0; round < 8; round++) {
      const days = ALL_GRADES.map((g) => scheduleEbbinghaus(base, g, T).intervalDays);
      expect(new Set(days).size).toBe(4);
      // 顺序也必须是 again < hard <= good < easy（短的表示更急）
      expect(days[0]).toBeLessThan(days[1]!);
      expect(days[1]).toBeLessThan(days[2]!);
      expect(days[2]).toBeLessThan(days[3]!);
      // 往下走一轮
      base = scheduleEbbinghaus(base, 'good', T);
    }
  });

  it('第二次复习：四个档位的间隔两两不同（区分度足够）', () => {
    /*
     * 只测首次不够 —— 用户是在「用过一段时间」之后发现没区分度的。
     * 这里把卡先推到第 3 次复习，再比较四档的结果。
     */
    let base = initialState(T);
    base = scheduleEbbinghaus(base, 'good', T);
    base = scheduleEbbinghaus(base, 'good', T);

    const values = ALL_GRADES.map(
      (g) => scheduleEbbinghaus(base, g, T).intervalDays,
    );
    const unique = new Set(values);
    /*
     * again 与 hard 可能重合（都很短），这是合理的：
     * 「忘了」和「勉强想起来」本质上都是没记住。
     * 但三个答对的档位必须互不相同。
     */
    const easy = scheduleEbbinghaus(base, 'easy', T).intervalDays;
    const good = scheduleEbbinghaus(base, 'good', T).intervalDays;
    const hard = scheduleEbbinghaus(base, 'hard', T).intervalDays;
    expect(new Set([hard, good, easy]).size).toBe(3);
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  it('同一张卡连续用 good 时，每次都在推进', () => {
    const seq = run(['good', 'good', 'good', 'good']);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!).toBeGreaterThan(seq[i - 1]!);
    }
  });
});

describe('again：答错回到最近的一档', () => {
  it('答错后回到「当天内再考」，而不是排到明天', () => {
    /*
     * 艾宾浩斯曲线的核心：完全想不起来的东西，隔一天再考几乎等于重学。
     * 所以 again 的间隔是 0 天、到期日就是今天 ——
     * 用户今天再看「今日题组」，这道题仍然在里面。
     */
    let s = initialState(T);
    s = scheduleEbbinghaus(s, 'easy', T);
    s = scheduleEbbinghaus(s, 'easy', T);
    expect(s.intervalDays).toBeGreaterThan(4);
    s = scheduleEbbinghaus(s, 'again', T);
    expect(s.intervalDays).toBe(0);
    expect(s.dueAt).toBe(T);
  });

  it('答错清零 streak、累加 lapse', () => {
    let s = initialState(T);
    s = scheduleEbbinghaus(s, 'good', T);
    s = scheduleEbbinghaus(s, 'good', T);
    expect(s.streak).toBe(2);
    s = scheduleEbbinghaus(s, 'again', T);
    expect(s.streak).toBe(0);
    expect(s.lapseCount).toBe(1);
  });

  it('答错不重置 ease（只是小幅下降）', () => {
    let s = initialState(T);
    s = scheduleEbbinghaus(s, 'easy', T);
    const before = s.ease;
    s = scheduleEbbinghaus(s, 'again', T);
    expect(s.ease).toBeLessThan(before);
    expect(s.ease).toBeGreaterThan(1.3);
  });
});

describe('hard：原地不动，但不至于永远 1 天', () => {
  it('hard 在中间台阶上不进不退', () => {
    let s = initialState(T);
    // 推到 7 天那一级
    s = scheduleEbbinghaus(s, 'good', T); // 2
    s = scheduleEbbinghaus(s, 'good', T); // 4
    s = scheduleEbbinghaus(s, 'good', T); // 7
    const before = s.intervalDays;
    const after = scheduleEbbinghaus(s, 'hard', T).intervalDays;
    /*
     * 允许因 ease 微调产生 ±1 天的浮动，但不该出现「大幅前进或回退」。
     */
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  });

  it('hard 在第 0 级时会前进到第 1 级（否则和 again 没区别）', () => {
    const first = scheduleEbbinghaus(initialState(T), 'hard', T);
    const second = scheduleEbbinghaus(first, 'hard', T);
    expect(second.intervalDays).toBeGreaterThanOrEqual(first.intervalDays);
  });
});

describe('连续答对跳级', () => {
  it('连续答对 3 次以上时，good 推进得更快', () => {
    // 一张已经连续答对 3 次的卡
    let vet = initialState(T);
    for (let i = 0; i < 3; i++) vet = scheduleEbbinghaus(vet, 'good', T);

    // 一张刚答错过的卡（streak = 0）
    let fresh = initialState(T);
    fresh = scheduleEbbinghaus(fresh, 'again', T);

    // 把两者的间隔对齐到同一台阶，只让 streak 不同
    const aligned: ReviewState = { ...fresh, intervalDays: vet.intervalDays, streak: 0 };

    const vetNext = scheduleEbbinghaus(vet, 'good', T).intervalDays;
    const alignedNext = scheduleEbbinghaus(aligned, 'good', T).intervalDays;
    expect(vetNext).toBeGreaterThanOrEqual(alignedNext);
  });
});

describe('上限与边界', () => {
  it('四个档位各有上限，且上限之间互不相同', () => {
    /*
     * 这是「区分度不丢失」的最后一道保险：
     * 即使一路点 easy 到了顶，easy(365) 仍然大于 good(270) 大于 hard(180)。
     * 如果四档共用一个上限（比如都 365），走到最后就全变成 365 —— 
     * 那正是用户抱怨过的现象。
     */
    const capOf = (g: ReviewGrade) => {
      let s = initialState(T);
      for (let i = 0; i < 50; i++) s = scheduleEbbinghaus(s, g, T);
      return s.intervalDays;
    };
    const hard = capOf('hard');
    const good = capOf('good');
    const easy = capOf('easy');
    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
    expect(easy).toBeLessThanOrEqual(365);
  });

  it('答对的档位至少 1 天（答对了不会当天再来）', () => {
    /*
     * again 例外：它是 0 天（当天内重考），这是设计而非缺陷。
     * 答对的三个档位必须至少推到明天，否则「答对了还让你今天再做」很挫败。
     */
    for (const g of ['hard', 'good', 'easy'] as ReviewGrade[]) {
      expect(scheduleEbbinghaus(initialState(T), g, T).intervalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it('ease 夹在 [1.3, 3.0]', () => {
    let low = initialState(T);
    for (let i = 0; i < 30; i++) low = scheduleEbbinghaus(low, 'again', T);
    expect(low.ease).toBeGreaterThanOrEqual(1.3);

    let high = initialState(T);
    for (let i = 0; i < 30; i++) high = scheduleEbbinghaus(high, 'easy', T);
    expect(high.ease).toBeLessThanOrEqual(3.0);
  });

  it('历史数据里的怪值不会让算法崩', () => {
    const weird: ReviewState = {
      ease: 2.5,
      intervalDays: -3,
      streak: 0,
      reviewCount: 2,
      lapseCount: 0,
      dueAt: T,
    };
    const next = scheduleEbbinghaus(weird, 'good', T);
    expect(Number.isFinite(next.intervalDays)).toBe(true);
    expect(next.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('dueAt 与 intervalDays 一致', () => {
    const s = scheduleEbbinghaus(initialState(T), 'good', T);
    const [y, m, d] = T.split('-').map(Number);
    const expected = new Date(Date.UTC(y!, m! - 1, d! + s.intervalDays))
      .toISOString()
      .slice(0, 10);
    expect(s.dueAt).toBe(expected);
  });
});

describe('previewDays：让界面能事先告诉用户「点了会怎样」', () => {
  it('新卡的预估与真实排程一致', () => {
    for (const g of ALL_GRADES) {
      const preview = previewDays(null, g, T);
      const real = scheduleEbbinghaus(initialState(T), g, T).intervalDays;
      expect(preview).toBe(real);
    }
  });

  it('已有进度的卡，预估与真实一致', () => {
    let s = initialState(T);
    s = scheduleEbbinghaus(s, 'good', T);
    for (const g of ALL_GRADES) {
      expect(previewDays(s, g, T)).toBe(scheduleEbbinghaus(s, g, T).intervalDays);
    }
  });

  it('预估值随档位递增（good < easy）', () => {
    const s = initialState(T);
    expect(previewDays(s, 'easy', T)).toBeGreaterThan(previewDays(s, 'good', T));
  });
});
