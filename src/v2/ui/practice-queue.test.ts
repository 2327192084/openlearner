import { describe, expect, it } from 'vitest';
import { buildQueueRows, masteredIds } from './practice-queue.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import type { Card } from '@/v2/core/cards.ts';

/**
 * 待做题目清单的测试（2026-11-08）。
 *
 * 用户要求「知道待做哪些题，已掌握的能筛掉」。这里守三件事：
 *  1. 「已掌握」的判据必须与 srs.isMastered 完全一致
 *     （不一致 → 界面说已掌握但系统仍当它没掌握）
 *  2. 没练过的题不算已掌握（那是「没学过」，不该被一键跳过）
 *  3. 逾期天数算对（用来排序与提示）
 */

const TODAY = '2026-11-08';

function state(over: Partial<ReviewState> = {}): ReviewState {
  return {
    ease: 2.5,
    intervalDays: 1,
    streak: 0,
    reviewCount: 1,
    lapseCount: 0,
    dueAt: TODAY,
    ...over,
  };
}

function card(id: string): Card {
  return {
    id,
    deckId: 'd1',
    kind: 'single',
    prompt: `题目 ${id}`,
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ],
    answer: 'A',
    explanation: '',
    anchors: [],
    sourceId: '',
    knowledgePointId: null,
    createdAt: '',
  } as unknown as Card;
}

describe('buildQueueRows', () => {
  it('没练过的题：mastery=0、不算已掌握', () => {
    const rows = buildQueueRows([card('q1')], new Map(), TODAY);
    expect(rows[0]!.mastery).toBe(0);
    expect(rows[0]!.mastered).toBe(false);
    // 文案以 srs.masteryLabel 为准（实际是「未学过」）。
    // 这里不硬编码成我自己以为的「没学过」—— 同一档位两处不同说法
    // 正是项目里踩过的「同一个数字两个说法」那类问题。
    expect(rows[0]!.label).toBe('未学过');
  });

  it('已掌握的判据与 srs.isMastered 一致', () => {
    /*
     * 判据三条同时满足：间隔 >= 21、连续答对 >= 2、掌握度 >= 0.85。
     * 差一条就不是已掌握 —— 这里逐条验，防止以后改了一处忘了另一处。
     */
    const full = state({ intervalDays: 60, streak: 3, reviewCount: 6, lapseCount: 0, dueAt: TODAY });
    expect(buildQueueRows([card('a')], new Map([['a', full]]), TODAY)[0]!.mastered).toBe(true);

    // 间隔不够
    const shortInterval = state({ intervalDays: 10, streak: 3, reviewCount: 6, dueAt: TODAY });
    expect(buildQueueRows([card('b')], new Map([['b', shortInterval]]), TODAY)[0]!.mastered).toBe(
      false,
    );

    // 连续答对不够
    const lowStreak = state({ intervalDays: 60, streak: 1, reviewCount: 6, dueAt: TODAY });
    expect(buildQueueRows([card('c')], new Map([['c', lowStreak]]), TODAY)[0]!.mastered).toBe(false);

    // 有答错（拉低掌握度）
    const lapsed = state({ intervalDays: 60, streak: 2, reviewCount: 6, lapseCount: 3, dueAt: TODAY });
    expect(buildQueueRows([card('d')], new Map([['d', lapsed]]), TODAY)[0]!.mastered).toBe(false);
  });

  it('掌握度很低的题不算已掌握（即使间隔被拉长过）', () => {
    const s = state({ intervalDays: 60, streak: 2, reviewCount: 8, lapseCount: 5, dueAt: TODAY });
    expect(buildQueueRows([card('x')], new Map([['x', s]]), TODAY)[0]!.mastered).toBe(false);
  });

  it('逾期天数：到期日早于今天才有值', () => {
    const overdue = state({ dueAt: '2026-11-01' });
    const notYet = state({ dueAt: '2026-12-01' });

    const rows = buildQueueRows(
      [card('o'), card('n')],
      new Map([
        ['o', overdue],
        ['n', notYet],
      ]),
      TODAY,
    );
    expect(rows[0]!.overdueDays).toBe(7);
    expect(rows[1]!.overdueDays).toBe(0);
  });

  it('正好今天到期 → 逾期 0 天（不算逾期）', () => {
    const rows = buildQueueRows([card('t')], new Map([['t', state({ dueAt: TODAY })]]), TODAY);
    expect(rows[0]!.overdueDays).toBe(0);
  });

  it('保持输入顺序（不在这里排序，交给调用方）', () => {
    const rows = buildQueueRows([card('z'), card('a')], new Map(), TODAY);
    expect(rows.map((r) => r.card.id)).toEqual(['z', 'a']);
  });
});

describe('masteredIds', () => {
  const mastered = state({
    intervalDays: 60, streak: 3, reviewCount: 6, lapseCount: 0, dueAt: TODAY,
  });

  it('只挑已掌握且还没被跳过的', () => {
    const rows = buildQueueRows(
      [card('m1'), card('m2'), card('w1')],
      new Map([
        ['m1', mastered],
        ['m2', mastered],
        ['w1', state({ lapseCount: 2, streak: 0, dueAt: TODAY })],
      ]),
      TODAY,
    );
    // m2 已被手动跳过 → 不再重复挑
    expect(masteredIds(rows, new Set(['m2']))).toEqual(['m1']);
  });

  it('没有已掌握时返回空数组', () => {
    const rows = buildQueueRows([card('w')], new Map(), TODAY);
    expect(masteredIds(rows, new Set())).toEqual([]);
  });
});
