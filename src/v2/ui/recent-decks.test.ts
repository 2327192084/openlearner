import { describe, expect, it } from 'vitest';
import { recentDecksOf } from './recent-decks.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { Deck } from '@/core/model.ts';
import type { ReviewLog } from '@/v2/core/review-service.ts';

const card = (id: string, deckId: string): Card => ({
  id,
  sourceId: 's1',
  kind: 'single',
  prompt: `题 ${id}`,
  options: [],
  answer: 'A',
  explanation: '',
  anchors: [],
  deckId,
  createdAt: '2026-11-01T00:00:00Z',
});

const log = (cardId: string, day: string): ReviewLog => ({
  id: `log_${cardId}_${day}`,
  cardId,
  kind: 'question',
  grade: 'good',
  day,
  prevIntervalDays: 0,
  newIntervalDays: 1,
  at: `${day}T10:00:00Z`,
});

const deck = (id: string, title: string): Deck =>
  ({
    id,
    title,
    courseId: null,
    status: 'published',
    sourceId: 's1',
    backendId: 'b1',
    questionCount: 0,
    blockingIssues: 0,
    publishedAt: '2026-11-01T00:00:00Z',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }) as Deck;

describe('recentDecksOf：「未完成」的判定', () => {
  it('练过一部分 → 算未完成，给出 练过 N/M', () => {
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
      ['q3', card('q3', 'd1')],
    ]);
    const out = recentDecksOf([log('q1', '2026-11-07')], cards, [deck('d1', '第一章')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ deckId: 'd1', done: 1, total: 3, ratio: 1 / 3 });
  });

  it('全都没练过 → 不出现（不属于「最近在练的」）', () => {
    const cards = new Map([['q1', card('q1', 'd1')]]);
    expect(recentDecksOf([], cards, [deck('d1', '第一章')])).toEqual([]);
  });

  it('全都练过了 → 不出现（已完成，不占位置）', () => {
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
    ]);
    const out = recentDecksOf(
      [log('q1', '2026-11-07'), log('q2', '2026-11-07')],
      cards,
      [deck('d1', '第一章')],
    );
    expect(out).toEqual([]);
  });

  it('同一道题的多次日志只算练过一次', () => {
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
    ]);
    const out = recentDecksOf(
      [log('q1', '2026-11-06'), log('q1', '2026-11-07'), log('q1', '2026-11-07')],
      cards,
      [deck('d1', '第一章')],
    );
    expect(out[0]!.done).toBe(1);
    expect(out[0]!.ratio).toBe(0.5);
  });

  it('最近练过的排前面', () => {
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
      ['q3', card('q3', 'd2')],
      ['q4', card('q4', 'd2')],
    ]);
    const out = recentDecksOf(
      [log('q1', '2026-11-01'), log('q3', '2026-11-07')],
      cards,
      [deck('d1', '旧的'), deck('d2', '新的')],
    );
    expect(out.map((d) => d.title)).toEqual(['新的', '旧的']);
  });

  it('题组里一道题都没有 → 不显示', () => {
    // d1 有两道、练过一道 → 未完成，应该出现；d2 一道题都没有 → 不该出现
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
    ]);
    const out = recentDecksOf([log('q1', '2026-11-07')], cards, [
      deck('d1', '有题'),
      deck('d2', '空组'),
    ]);
    expect(out.map((d) => d.deckId)).toEqual(['d1']);
  });

  it('日志里的题已被删（卡片池里没有）→ 忽略，不报错', () => {
    const cards = new Map([['q1', card('q1', 'd1')], ['q2', card('q2', 'd1')]]);
    const out = recentDecksOf([log('q_deleted', '2026-11-07')], cards, [deck('d1', '第一章')]);
    // 只碰到已删除的题 → 这一组等于没练过
    expect(out).toEqual([]);
  });

  it('最多返回 4 个', () => {
    const cards = new Map<string, Card>();
    const decks: Deck[] = [];
    const logs: ReviewLog[] = [];
    for (let i = 0; i < 6; i++) {
      cards.set(`q${i}`, card(`q${i}`, `d${i}`));
      cards.set(`q${i}b`, card(`q${i}b`, `d${i}`));
      decks.push(deck(`d${i}`, `组 ${i}`));
      logs.push(log(`q${i}`, '2026-11-07'));
    }
    expect(recentDecksOf(logs, cards, decks)).toHaveLength(4);
  });

  it('知识点类型的日志不计入（只算题目）', () => {
    const cards = new Map([['q1', card('q1', 'd1')], ['q2', card('q2', 'd1')]]);
    const pointLog: ReviewLog = { ...log('p1', '2026-11-07'), kind: 'point' };
    const out = recentDecksOf([pointLog], cards, [deck('d1', '第一章')]);
    expect(out).toEqual([]);
  });

  it('错题数由外部传入，没传就是 0', () => {
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
    ]);
    const withWrong = recentDecksOf([log('q1', '2026-11-07')], cards, [deck('d1', 'A')], new Map([['d1', 2]]));
    expect(withWrong[0]!.wrong).toBe(2);

    const noWrong = recentDecksOf([log('q1', '2026-11-07')], cards, [deck('d1', 'A')]);
    expect(noWrong[0]!.wrong).toBe(0);
  });

  it('用 cardById 统计总数，不用 deck.questionCount 缓存', () => {
    /*
     * 题组缓存说 99 道，但库里真实只剩 2 道 ——
     * 用缓存会算出「练过 1/99」这种荒唐数字。
     */
    const cards = new Map([
      ['q1', card('q1', 'd1')],
      ['q2', card('q2', 'd1')],
    ]);
    const d = { ...deck('d1', 'A'), questionCount: 99 } as Deck;
    const out = recentDecksOf([log('q1', '2026-11-07')], cards, [d]);
    expect(out[0]!.total).toBe(2);
  });
});
