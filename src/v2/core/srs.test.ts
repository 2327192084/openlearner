import { describe, expect, it } from 'vitest';
import {
  initialState,
  schedule,
  addDays,
  todayUtc,
  isDue,
  daysOverdue,
  mastery,
  masteryLabel,
  isMastered,
  buildTodayQueue,
  type ReviewGrade,
  type ReviewState,
} from '../core/srs.ts';

/**
 * 间隔复习引擎的测试。
 *
 * ## 为什么这套测试要写得这么细
 *
 * 这是整个学习工具的地基：用户每天打开看到「该复习这些」，
 * 全靠它算。算错了用户会感觉「这软件在瞎安排」，
 * 而这种感觉说不清、也难复现 —— 只能靠测试先钉死行为。
 */

const T = '2026-11-06';

describe('addDays：日期加减（只关心「哪一天」）', () => {
  it('加一天', () => {
    expect(addDays('2026-11-06', 1)).toBe('2026-11-07');
  });

  it('跨月', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('跨年', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('闰年 2 月', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('加 0 天不变', () => {
    expect(addDays('2026-11-06', 0)).toBe('2026-11-06');
  });

  it('加 365 天正好一年', () => {
    expect(addDays('2026-11-06', 365)).toBe('2027-11-06');
  });
});

describe('todayUtc', () => {
  it('返回 YYYY-MM-DD 格式', () => {
    expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('同一时刻的不同时区不影响结果（用 UTC 日期）', () => {
    const d = new Date('2026-11-06T23:30:00Z');
    expect(todayUtc(d)).toBe('2026-11-06');
  });
});

describe('initialState：新卡', () => {
  it('当天就该学', () => {
    const s = initialState(T);
    expect(s.dueAt).toBe(T);
    expect(s.intervalDays).toBe(0);
    expect(s.ease).toBe(2.5);
    expect(s.reviewCount).toBe(0);
  });
});

describe('schedule：答对时间隔递增', () => {
  it('首次复习：五个档位给出各不相同的间隔', () => {
    /*
     * 这条测试是针对用户反馈写的：「只有 5 分才和别的分数拉开差距」。
     *
     * 旧实现 `FIRST_INTERVAL = { hard: 1, good: 1, easy: 3 }`
     * 让 3 分和 4 分都给 1 天 —— 评分等于没区分。
     * 现在按艾宾浩斯台阶走：hard→1 天、good→2 天、easy→4 天，
     * 三档互不相同；again 固定 1 天（答错了就该明天再看）。
     */
    const again = schedule(initialState(T), 'again', T).intervalDays;
    const hard = schedule(initialState(T), 'hard', T).intervalDays;
    const good = schedule(initialState(T), 'good', T).intervalDays;
    const easy = schedule(initialState(T), 'easy', T).intervalDays;

    // again = 0 天：当天内再考一次（艾宾浩斯：忘了就要马上补）
    expect(again).toBe(0);
    // 三个答对档位必须严格递增，这就是「区分度」
    expect(good).toBeGreaterThan(hard);
    expect(easy).toBeGreaterThan(good);
  });

  it('连续 good：间隔按 ease 增长', () => {
    let s = initialState(T);
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      s = schedule(s, 'good', T);
      intervals.push(s.intervalDays);
    }
    // 应该严格递增
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]!).toBeGreaterThan(intervals[i - 1]!);
    }
  });

  it('easy 比 good 长得快', () => {
    let a = initialState(T);
    let b = initialState(T);
    for (let i = 0; i < 3; i++) {
      a = schedule(a, 'easy', T);
      b = schedule(b, 'good', T);
    }
    expect(a.intervalDays).toBeGreaterThan(b.intervalDays);
  });

  it('间隔不超过 365 天（备考场景不该推到十年后）', () => {
    let s = initialState(T);
    for (let i = 0; i < 40; i++) s = schedule(s, 'easy', T);
    expect(s.intervalDays).toBeLessThanOrEqual(365);
  });

  it('interval 至少前进 1 天（答对了就该有进展）', () => {
    let s = initialState(T);
    s = schedule(s, 'hard', T);
    expect(s.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('dueAt 与 intervalDays 一致', () => {
    const s = schedule(initialState(T), 'good', T);
    expect(s.dueAt).toBe(addDays(T, s.intervalDays));
  });
});

describe('schedule：答错的处理', () => {
  it('答错回到「当天内」', () => {
    let s = initialState(T);
    s = schedule(s, 'good', T);
    s = schedule(s, 'good', T);
    const before = s.intervalDays;
    s = schedule(s, 'again', T);
    expect(s.intervalDays).toBe(0);
    expect(s.dueAt).toBe(T);
    expect(before).toBeGreaterThan(1);
  });

  it('答错时 streak 清零', () => {
    let s = initialState(T);
    s = schedule(s, 'good', T);
    s = schedule(s, 'good', T);
    expect(s.streak).toBe(2);
    s = schedule(s, 'again', T);
    expect(s.streak).toBe(0);
  });

  it('答错时 lapseCount 增加', () => {
    let s = initialState(T);
    s = schedule(s, 'again', T);
    expect(s.lapseCount).toBe(1);
  });

  it('**答错不清空全部历史**：ease 只小幅下降', () => {
    let s = initialState(T);
    s = schedule(s, 'good', T);
    const before = s.ease;
    s = schedule(s, 'again', T);
    // 只降 0.2，不是打回 2.5 或更低
    expect(s.ease).toBeCloseTo(before - 0.2, 2);
  });

  it('连续答错时 ease 持续下降但不会低于 1.3', () => {
    let s = initialState(T);
    for (let i = 0; i < 20; i++) s = schedule(s, 'again', T);
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
  });

  it('刚答错过又答对：给一个较小的跳跃，不当成全新卡片', () => {
    let s = initialState(T);
    s = schedule(s, 'good', T);
    s = schedule(s, 'good', T);
    s = schedule(s, 'again', T); // 1 天
    s = schedule(s, 'good', T);
    // 不是 1 天（那样感觉「明明会了还让天天看」），也不是巨大跳跃
    expect(s.intervalDays).toBeGreaterThan(1);
    expect(s.intervalDays).toBeLessThanOrEqual(5);
  });
});

describe('schedule：ease 边界', () => {
  it('ease 不低于 1.3', () => {
    let s = initialState(T);
    for (let i = 0; i < 30; i++) s = schedule(s, 'hard', T);
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
  });

  it('ease 不高于 3.0', () => {
    let s = initialState(T);
    for (let i = 0; i < 30; i++) s = schedule(s, 'easy', T);
    expect(s.ease).toBeLessThanOrEqual(3.0);
  });
});

describe('isDue / daysOverdue', () => {
  it('到期日等于今天算到期', () => {
    expect(isDue(initialState(T), T)).toBe(true);
  });

  it('未来不算到期', () => {
    const s = schedule(initialState(T), 'easy', T);
    expect(isDue(s, T)).toBe(false);
  });

  it('过期算到期，并给出逾期天数', () => {
    const s = { ...initialState('2026-11-01') };
    expect(isDue(s, T)).toBe(true);
    expect(daysOverdue(s, T)).toBe(5);
  });

  it('未到期时逾期天数为 0', () => {
    const s = schedule(initialState(T), 'easy', T);
    expect(daysOverdue(s, T)).toBe(0);
  });
});

describe('mastery：熟练度', () => {
  it('没学过是 0', () => {
    expect(mastery(initialState(T))).toBe(0);
  });

  it('学过就大于 0', () => {
    const s = schedule(initialState(T), 'good', T);
    expect(mastery(s)).toBeGreaterThan(0);
  });

  it('间隔越长熟练度越高', () => {
    let s = initialState(T);
    const values: number[] = [];
    for (let i = 0; i < 6; i++) {
      s = schedule(s, 'good', T);
      values.push(mastery(s));
    }
    // 整体趋势向上
    expect(values[values.length - 1]!).toBeGreaterThan(values[0]!);
  });

  it('答错过的熟练度低于一直答对的', () => {
    let perfect = initialState(T);
    let slipped = initialState(T);
    for (let i = 0; i < 4; i++) {
      perfect = schedule(perfect, 'good', T);
      slipped = schedule(slipped, i === 2 ? 'again' : 'good', T);
    }
    expect(mastery(slipped)).toBeLessThan(mastery(perfect));
  });

  it('结果始终在 0~1 之间', () => {
    let s = initialState(T);
    for (const g of ['easy', 'good', 'hard', 'again', 'good', 'easy'] as ReviewGrade[]) {
      s = schedule(s, g, T);
      const m = mastery(s);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe('masteryLabel：给用户看的文字', () => {
  it('各区间都有可读标签', () => {
    expect(masteryLabel(0)).toBe('未学过');
    expect(masteryLabel(0.2)).toBe('刚起步');
    expect(masteryLabel(0.5)).toBe('有点印象');
    expect(masteryLabel(0.7)).toBe('熟练');
    expect(masteryLabel(0.9)).toBe('很熟');
  });

  /*
   * 「很熟」需要连续答对（2026-11-08）。
   *
   * 纯按分值会出现「蒙对一次就显示很熟」：一道题如果当前间隔很长
   * （说明历史不错）但最近刚答错、连续答对为 0，分值仍可能很高。
   *
   * 门槛参考 StudyHub lib/mastery.js：间隔 >= 21 天 且 连续答对 >= 2。
   * 它的注释原话：「没有任何调度器设置能靠一次作答就让人已掌握」。
   */
  describe('「很熟」需要连续答对', () => {
    const st = (intervalDays: number, streak: number): ReviewState => ({
      ...initialState('2026-01-01'),
      reviewCount: 5,
      intervalDays,
      streak,
      lapseCount: 0,
    });

    it('间隔够长 + 连续答对 >= 2 → 很熟', () => {
      expect(masteryLabel(0.9, st(30, 2))).toBe('很熟');
    });

    it('间隔够长但只有 1 次答对 → 降到熟练（可能是蒙的）', () => {
      expect(masteryLabel(0.9, st(30, 1))).toBe('熟练');
    });

    it('连续答对够但间隔太短 → 降到熟练（还没进长期记忆）', () => {
      expect(masteryLabel(0.9, st(7, 5))).toBe('熟练');
    });

    it('两条都不满足 → 熟练', () => {
      expect(masteryLabel(0.9, st(3, 1))).toBe('熟练');
    });

    it('21 天是边界，刚好够', () => {
      expect(masteryLabel(0.9, st(21, 2))).toBe('很熟');
      expect(masteryLabel(0.9, st(20, 2))).toBe('熟练');
    });

    it('2 次是边界，刚好够', () => {
      expect(masteryLabel(0.9, st(30, 2))).toBe('很熟');
      expect(masteryLabel(0.9, st(30, 1))).toBe('熟练');
    });

    it('分值不够 0.85 时，那两条无所谓 —— 仍是纯数值分档', () => {
      expect(masteryLabel(0.7, st(30, 9))).toBe('熟练');
      expect(masteryLabel(0.5, st(30, 9))).toBe('有点印象');
    });

    it('不传 state 时退回旧行为（聚合平均值用）', () => {
      // 首页/统计页显示的是全库平均掌握度，没有单卡 state
      expect(masteryLabel(0.9)).toBe('很熟');
    });
  });
});

describe('isMastered：「已掌握」的判定', () => {
  const st = (over: Partial<ReviewState> = {}): ReviewState => ({
    ...initialState('2026-01-01'),
    reviewCount: 5,
    intervalDays: 30,
    streak: 3,
    lapseCount: 0,
    ...over,
  });

  it('三条都满足 → 已掌握', () => {
    expect(isMastered(st())).toBe(true);
  });

  it('没学过 → 不算', () => {
    expect(isMastered(st({ reviewCount: 0 }))).toBe(false);
  });

  it('null / undefined → 不算', () => {
    expect(isMastered(null)).toBe(false);
    expect(isMastered(undefined)).toBe(false);
  });

  it('间隔不足 21 天 → 不算', () => {
    expect(isMastered(st({ intervalDays: 20 }))).toBe(false);
  });

  it('连续答对不足 2 → 不算', () => {
    expect(isMastered(st({ streak: 1 }))).toBe(false);
  });

  it('与 masteryLabel 说「很熟」的条件一致（同一个口径）', () => {
    const cases = [st(), st({ intervalDays: 20 }), st({ streak: 1 }), st({ lapseCount: 4 })];
    for (const c of cases) {
      const label = masteryLabel(mastery(c), c);
      expect(isMastered(c)).toBe(label === '很熟');
    }
  });
});

describe('buildTodayQueue：今天该学什么', () => {
  it('新卡进 fresh，到期卡进 due', () => {
    const q = buildTodayQueue(
      [
        { id: 'a', state: null },
        { id: 'b', state: { ...initialState('2026-11-01') } },
      ],
      T,
    );
    expect(q.fresh).toHaveLength(1);
    expect(q.due).toHaveLength(1);
  });

  it('未到期的卡不出现', () => {
    const future = schedule(initialState(T), 'easy', T);
    const q = buildTodayQueue([{ id: 'a', state: future }], T);
    expect(q.due).toHaveLength(0);
    expect(q.fresh).toHaveLength(0);
  });

  it('**逾期越久越靠前**', () => {
    const q = buildTodayQueue(
      [
        { id: 'recent', state: { ...initialState('2026-11-05') } },
        { id: 'old', state: { ...initialState('2026-10-01') } },
        { id: 'mid', state: { ...initialState('2026-11-01') } },
      ],
      T,
    );
    expect(q.due.map((x) => (x as { id: string }).id)).toEqual(['old', 'mid', 'recent']);
  });

  it('新卡有上限（默认 20），避免一天塞太多', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, state: null }));
    const q = buildTodayQueue(items, T);
    expect(q.fresh).toHaveLength(20);
    expect(q.freshTotal).toBe(50);
  });

  it('上限可配置', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, state: null }));
    const q = buildTodayQueue(items, T, { newLimit: 5 });
    expect(q.fresh).toHaveLength(5);
  });

  it('总数如实报告，不受上限影响', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, state: { ...initialState('2026-11-01') } })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, state: null })),
    ];
    const q = buildTodayQueue(items, T, { newLimit: 10 });
    expect(q.dueTotal).toBe(3);
    expect(q.freshTotal).toBe(30);
    expect(q.fresh).toHaveLength(10);
  });

  it('空列表不报错', () => {
    const q = buildTodayQueue([], T);
    expect(q.due).toEqual([]);
    expect(q.fresh).toEqual([]);
    expect(q.dueTotal).toBe(0);
  });
});

describe('完整学习流程：连学一周', () => {
  it('每天答 good，间隔递增且不失控', () => {
    let s = initialState('2026-11-06');
    let day = '2026-11-06';
    const log: { day: string; interval: number }[] = [];

    for (let i = 0; i < 8; i++) {
      s = schedule(s, 'good', day);
      log.push({ day, interval: s.intervalDays });
      // 跳到下次到期日继续
      day = s.dueAt;
    }

    // 间隔应该递增（说明卡片在往后推）
    const intervals = log.map((l) => l.interval);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]!).toBeGreaterThanOrEqual(intervals[i - 1]!);
    }
    // 且不超过上限
    expect(intervals[intervals.length - 1]!).toBeLessThanOrEqual(365);
  });

  it('一张卡从陌生到「很熟」需要多次答对', () => {
    let s = initialState(T);
    let day = T;
    let rounds = 0;
    while (mastery(s) < 0.85 && rounds < 50) {
      s = schedule(s, 'easy', day);
      day = s.dueAt;
      rounds++;
    }
    // 应该在合理次数内达到（不是永远达不到，也不是一次就到）
    expect(rounds).toBeGreaterThan(1);
    expect(rounds).toBeLessThan(30);
  });
});
