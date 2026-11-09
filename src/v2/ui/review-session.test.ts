import { describe, expect, it } from 'vitest';
import {
  REVIEW_BATCH,
  buildReviewQueue,
  currentItem,
  grade,
  isFinished,
  progressOf,
  recapOf,
  reveal,
  startSession,
} from './review-session.ts';

/**
 * 今日复习会话（2026-11-09）。
 *
 * 这组测试守的是**复习与做题的分界**：
 *  - 只收今日到期 + 新卡（不自由挑）
 *  - 必须先翻面才能自评（不许盲评）
 *  - 评完即进下一题，全部评完即结束（有终点）
 */

function card(id: string) {
  return { id, question: { prompt: `题干 ${id}` } };
}

const promptOf = (q: { prompt: string }) => q.prompt;

describe('buildReviewQueue', () => {
  it('只收 dueAt <= 今天的卡，未到期的不收', () => {
    const q = buildReviewQueue({
      cards: [card('a'), card('b'), card('c')],
      dueAtByCard: new Map([
        ['a', '2026-11-01'], // 逾期
        ['b', '2026-11-09'], // 今天到期
        ['c', '2026-12-01'], // 还没到
      ]),
      today: '2026-11-09',
      promptOf,
    });
    expect(q.due.map((x) => x.cardId)).toEqual(['a', 'b']);
  });

  it('没有记录的卡算新卡', () => {
    const q = buildReviewQueue({
      cards: [card('a'), card('x')],
      dueAtByCard: new Map([['a', '2026-11-09']]),
      today: '2026-11-09',
      promptOf,
    });
    expect(q.fresh.map((x) => x.cardId)).toEqual(['x']);
    expect(q.fresh[0]!.isNew).toBe(true);
    expect(q.due[0]!.isNew).toBe(false);
  });

  it('到期按逾期最久排前（先救快忘光的）', () => {
    const q = buildReviewQueue({
      cards: [card('late'), card('early'), card('mid')],
      dueAtByCard: new Map([
        ['late', '2026-11-08'],
        ['early', '2026-10-01'],
        ['mid', '2026-11-01'],
      ]),
      today: '2026-11-09',
      promptOf,
    });
    expect(q.due.map((x) => x.cardId)).toEqual(['early', 'mid', 'late']);
  });

  it('到期超过批次上限时截断，但如实报告总数', () => {
    /*
     * 「截断必须说出来」是项目的老规矩：界面写「今天 5 张」而实际
     * 有 50 张，做完显示「完成」就是在骗人。
     */
    const cards = Array.from({ length: 50 }, (_, i) => card('c' + i));
    const due = new Map(cards.map((c) => [c.id, '2026-11-09']));
    const q = buildReviewQueue({ cards, dueAtByCard: due, today: '2026-11-09', promptOf, limit: 10 });
    expect(q.due).toHaveLength(10);
    expect(q.availableBeforeLimit).toBe(50);
  });

  it('到期没占满批次才补新卡（先还债再学新的）', () => {
    const q = buildReviewQueue({
      cards: [card('d1'), card('d2'), card('n1'), card('n2')],
      dueAtByCard: new Map([
        ['d1', '2026-11-09'],
        ['d2', '2026-11-09'],
      ]),
      today: '2026-11-09',
      promptOf,
      limit: 3,
    });
    expect(q.due).toHaveLength(2);
    expect(q.fresh).toHaveLength(1); // 只剩一个位置
    expect(q.total).toBe(3);
  });

  it('到期占满批次时不补新卡', () => {
    const q = buildReviewQueue({
      cards: [card('d1'), card('d2'), card('n1')],
      dueAtByCard: new Map([
        ['d1', '2026-11-09'],
        ['d2', '2026-11-09'],
      ]),
      today: '2026-11-09',
      promptOf,
      limit: 2,
    });
    expect(q.fresh).toHaveLength(0);
    expect(q.total).toBe(2);
  });

  it('空池不炸', () => {
    const q = buildReviewQueue({ cards: [], dueAtByCard: new Map(), today: '2026-11-09', promptOf });
    expect(q.total).toBe(0);
    expect(q.availableBeforeLimit).toBe(0);
  });

  it('默认批次是 REVIEW_BATCH', () => {
    const cards = Array.from({ length: REVIEW_BATCH + 5 }, (_, i) => card('c' + i));
    const due = new Map(cards.map((c) => [c.id, '2026-11-09']));
    const q = buildReviewQueue({ cards, dueAtByCard: due, today: '2026-11-09', promptOf });
    expect(q.due).toHaveLength(REVIEW_BATCH);
  });
});

describe('会话：先回想，再看答案', () => {
  const q = buildReviewQueue({
    cards: [card('a'), card('b')],
    dueAtByCard: new Map([['a', '2026-11-09'], ['b', '2026-11-09']]),
    today: '2026-11-09',
    promptOf,
  });

  it('初始在 prompt 阶段（答案不可见）', () => {
    const s = startSession(q);
    expect(s.phase).toBe('prompt');
    expect(currentItem(s)!.cardId).toBe('a');
  });

  it('prompt 阶段不允许评分（没看答案就评会失真）', () => {
    const s = startSession(q);
    const after = grade(s, 'good');
    expect(after).toBe(s); // 原样返回，没有推进
    expect(after.done).toHaveLength(0);
  });

  it('翻面后才能评分，评完进下一题并回到 prompt', () => {
    let s = startSession(q);
    s = reveal(s);
    expect(s.phase).toBe('reveal');
    s = grade(s, 'good');
    expect(s.done).toHaveLength(1);
    expect(currentItem(s)!.cardId).toBe('b');
    expect(s.phase).toBe('prompt'); // 下一题重新遮住答案
  });

  it('全部评完即结束（有终点，不是无限刷）', () => {
    let s = startSession(q);
    s = grade(reveal(s), 'good');
    s = grade(reveal(s), 'again');
    expect(isFinished(s)).toBe(true);
    expect(currentItem(s)).toBeNull();
    expect(progressOf(s)).toEqual({ done: 2, total: 2 });
  });

  it('重复翻面是幂等的', () => {
    const s = reveal(startSession(q));
    expect(reveal(s)).toBe(s);
  });
});

describe('recapOf 今日回顾', () => {
  it('分开统计新卡与到期卡', () => {
    const q = buildReviewQueue({
      cards: [card('d1'), card('n1')],
      dueAtByCard: new Map([['d1', '2026-11-09']]),
      today: '2026-11-09',
      promptOf,
    });
    let s = startSession(q);
    s = grade(reveal(s), 'good'); // 到期卡
    s = grade(reveal(s), 'easy'); // 新卡

    const r = recapOf(s);
    expect(r.total).toBe(2);
    expect(r.dueCount).toBe(1);
    expect(r.newCount).toBe(1);
  });

  it('各档位计数正确', () => {
    const q = buildReviewQueue({
      cards: [card('a'), card('b'), card('c'), card('d')],
      dueAtByCard: new Map([
        ['a', '2026-11-09'],
        ['b', '2026-11-09'],
        ['c', '2026-11-09'],
        ['d', '2026-11-09'],
      ]),
      today: '2026-11-09',
      promptOf,
    });
    let s = startSession(q);
    s = grade(reveal(s), 'again');
    s = grade(reveal(s), 'hard');
    s = grade(reveal(s), 'good');
    s = grade(reveal(s), 'easy');

    const r = recapOf(s);
    expect(r.byGrade).toEqual({ again: 1, hard: 1, good: 1, easy: 1 });
  });

  it('「记住了」= good + easy 的占比', () => {
    const q = buildReviewQueue({
      cards: [card('a'), card('b'), card('c'), card('d')],
      dueAtByCard: new Map([
        ['a', '2026-11-09'],
        ['b', '2026-11-09'],
        ['c', '2026-11-09'],
        ['d', '2026-11-09'],
      ]),
      today: '2026-11-09',
      promptOf,
    });
    let s = startSession(q);
    s = grade(reveal(s), 'again');
    s = grade(reveal(s), 'hard');
    s = grade(reveal(s), 'good');
    s = grade(reveal(s), 'easy');

    /* 4 张里 good+easy 两张 = 50% */
    expect(recapOf(s).rememberedRatio).toBeCloseTo(0.5);
  });

  it('一张都没评时比例是 null，不是 0', () => {
    /* 显示 0% 会让用户以为「全忘了」，而实际是还没开始 */
    const r = recapOf(startSession(buildReviewQueue({
      cards: [], dueAtByCard: new Map(), today: '2026-11-09', promptOf,
    })));
    expect(r.total).toBe(0);
    expect(r.rememberedRatio).toBeNull();
  });
});
