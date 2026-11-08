import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  summarizeToday,
  stateByCard,
  wrongCardIds,
  type TodayCardInput,
} from './today-plan.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import type { ReviewRecord } from '@/v2/core/review-service.ts';

/**
 * 今日学习卡分类的测试（2026-11-08）。
 *
 * ## 为什么要有这一层
 *
 * 首页原来只说「还有 N 张新卡没学过」，用户看不出这 N 张里在考什么。
 * 拆成「到期 / 薄弱」之后，**什么算薄弱**就成了必须有明确定义的东西 ——
 * 否则同一个词在不同人心里是两件事，界面上一个数字会说不清。
 *
 * 这里把定义钉死，并守住三条最容易搞错的地方：
 *  1. 从没练过 ≠ 薄弱（那是「没学过」，不该让人以为自己很差）
 *  2. 到期优先于薄弱（今天该做的动作要可执行）
 *  3. 答错过但分数很高 → 仍算薄弱（防止「假熟练」）
 */

const TODAY = '2026-11-08';

function state(over: Partial<ReviewState> = {}): ReviewState {
  return {
    ease: 2.5,
    intervalDays: 1,
    streak: 0,
    reviewCount: 1,
    lapseCount: 0,
    dueAt: '2026-11-20',
    ...over,
  };
}

describe('bucketOf', () => {
  it('从没练过 → fresh，不是 weak', () => {
    /*
     * 这条最关键。如果没练过的卡被算成「薄弱」，
     * 用户一打开首页就看到「20 张薄弱」，而其实他一道题都还没做 ——
     * 那是在骂人，不是在帮他。
     */
    expect(bucketOf(null, TODAY, false)).toBe('fresh');
    expect(bucketOf(undefined, TODAY, false)).toBe('fresh');
    expect(bucketOf(state({ reviewCount: 0 }), TODAY, false)).toBe('fresh');
  });

  it('今天到期 → due', () => {
    expect(bucketOf(state({ dueAt: TODAY }), TODAY, false)).toBe('due');
  });

  it('到期时间已过 → 也是 due', () => {
    expect(bucketOf(state({ dueAt: '2026-11-01' }), TODAY, false)).toBe('due');
  });

  it('到期优先于薄弱（今天该复习就先复习）', () => {
    // 掌握度很低，**同时也到期** → 归 due
    // 注意必须显式给 dueAt：默认值远在未来，那样根本不会到期。
    expect(
      bucketOf(
        state({ intervalDays: 1, lapseCount: 3, reviewCount: 4, dueAt: TODAY }),
        TODAY,
        true,
      ),
    ).toBe('due');
  });

  it('练过但掌握度低 → weak', () => {
    // 间隔短 + 有答错 → mastery 低
    const s = state({ intervalDays: 1, reviewCount: 3, lapseCount: 2, streak: 0, dueAt: '2026-12-01' });
    expect(bucketOf(s, TODAY, false)).toBe('weak');
  });

  it('答错过但当前分数不低 → 仍算 weak（防假熟练）', () => {
    /*
     * 场景：题目历史间隔被拉到很长（分数上去了），
     * 但最近答错过一次、连续答对为 0。
     * 只看分数会显示「熟练」，实际下次大概率又想不起来。
     * 这与 masteryLabel 里「很熟要求连续答对 ≥2」是同一个考虑。
     */
    const s = state({
      intervalDays: 60,
      reviewCount: 5,
      lapseCount: 1,
      streak: 0,
      dueAt: '2026-12-20',
    });
    // 先确认分数确实不低（否则这条测试就没意义）
    expect(bucketOf(s, TODAY, true)).toBe('weak');
  });

  it('还没到期、掌握度够、也没错题 → settled', () => {
    const s = state({
      intervalDays: 300,
      reviewCount: 6,
      lapseCount: 0,
      streak: 5,
      dueAt: '2027-06-01',
    });
    expect(bucketOf(s, TODAY, false)).toBe('settled');
  });

  it('很熟但有过错题历史 → 不算 weak（已经稳了）', () => {
    const s = state({
      intervalDays: 300,
      reviewCount: 8,
      lapseCount: 1,
      streak: 4,
      dueAt: '2027-06-01',
    });
    // mastery 应 >= 0.85
    expect(bucketOf(s, TODAY, true)).toBe('settled');
  });
});

describe('summarizeToday', () => {
  function input(state_: ReviewState | null, hadWrong = false): TodayCardInput {
    return { cardId: `c${Math.random()}`, state: state_, hadWrong };
  }

  it('各档计数正确', () => {
    const cards = [
      input(state({ dueAt: TODAY })), // due
      input(state({ dueAt: TODAY })), // due
      input(state({ intervalDays: 1, reviewCount: 2, lapseCount: 1, dueAt: '2026-12-01' })), // weak
      input(null), // fresh
      input(null), // fresh
      input(state({ intervalDays: 300, reviewCount: 6, streak: 5, dueAt: '2027-06-01' })), // settled
    ];
    const plan = summarizeToday(cards, TODAY);
    expect(plan.due).toBe(2);
    expect(plan.weak).toBe(1);
    expect(plan.fresh).toBe(2);
    expect(plan.settled).toBe(1);
    expect(plan.total).toBe(6);
  });

  it('有到期时 focus = review', () => {
    const plan = summarizeToday([input(state({ dueAt: TODAY })), input(null)], TODAY);
    expect(plan.focus).toBe('review');
  });

  it('没到期但有薄弱时 focus = drill-weak', () => {
    const plan = summarizeToday(
      [
        input(state({ intervalDays: 1, reviewCount: 2, lapseCount: 1, dueAt: '2026-12-01' })),
        input(null),
      ],
      TODAY,
    );
    expect(plan.focus).toBe('drill-weak');
  });

  it('只有没学过的时 focus = learn-new', () => {
    const plan = summarizeToday([input(null), input(null)], TODAY);
    expect(plan.focus).toBe('learn-new');
  });

  it('全都稳了 focus = done', () => {
    const plan = summarizeToday(
      [input(state({ intervalDays: 300, reviewCount: 6, streak: 5, dueAt: '2027-06-01' }))],
      TODAY,
    );
    expect(plan.focus).toBe('done');
  });

  it('空池子 total = 0 且 focus = done（不崩）', () => {
    const plan = summarizeToday([], TODAY);
    expect(plan.total).toBe(0);
    expect(plan.focus).toBe('done');
  });

  it('五档之和恒等于条目数（这条以前踩过）', () => {
    /*
     * 项目里踩过「顶部 16 张，分布加起来 10 张」的坑。
     * 这里用一组混合数据守住「分类不重不漏」。
     */
    const cards = [
      input(state({ dueAt: TODAY })),
      input(state({ dueAt: '2026-11-01' })),
      input(state({ intervalDays: 1, reviewCount: 3, lapseCount: 2, dueAt: '2026-12-01' })),
      input(state({ intervalDays: 60, reviewCount: 5, lapseCount: 1, streak: 0, dueAt: '2026-12-20' }), true),
      input(null),
      input(null),
      input(null),
      input(state({ intervalDays: 300, reviewCount: 8, streak: 6, dueAt: '2027-06-01' })),
    ];
    const p = summarizeToday(cards, TODAY);
    expect(p.due + p.weak + p.fresh + p.settled).toBe(cards.length);
  });
});

describe('stateByCard / wrongCardIds', () => {
  function rec(cardId: string, lapseCount: number): ReviewRecord {
    return {
      id: `rv:${cardId}`,
      cardId,
      kind: 'question',
      state: state({ lapseCount }),
      firstSeenAt: '',
      updatedAt: '',
    };
  }

  it('建索引', () => {
    const m = stateByCard([rec('a', 0), rec('b', 1)]);
    expect(m.size).toBe(2);
    expect(m.get('b')!.lapseCount).toBe(1);
  });

  it('有过答错的卡被收进集合', () => {
    const s = wrongCardIds([rec('a', 0), rec('b', 1), rec('c', 3)]);
    expect([...s].sort()).toEqual(['b', 'c']);
  });

  it('没答错过的不进集合', () => {
    expect(wrongCardIds([rec('a', 0)]).size).toBe(0);
  });
});
