import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '@/core/storage/memory-storage.ts';
import { buildSnapshot } from './study-snapshot.ts';
import { ReviewService } from '@/v2/core/review-service.ts';
import { DeckService } from '@/core/questions/service.ts';
import { KnowledgeService } from '@/core/knowledge/service.ts';
import { SourceService } from '@/core/sources.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { Deck, Question } from '@/core/model.ts';

/**
 * 首页「N 道错题待巩固」的口径测试（2026-11-08）。
 *
 * ## 这个 bug 是用户报出来的
 *
 * 「学习库处的待处理错题，我点进去跳转到错题界面，但是没有任何错题。」
 *
 * 真实数据里的情况：
 *   reviewLogs 18 条 / 16 张卡，其中 15 张曾经答错
 *   → 首页角标显示 15
 *   但那 15 张**全都不在当前的 questions 表里**（旧题组删了，
 *     重新生成了一批新 id）
 *   → 错题页有 `if (!card) continue`，过滤后 0 条
 *
 * 所以根因是**角标没过滤已删除的题**，而错题页过滤了。
 * 两边口径不一致，用户点进去就看到空的。
 *
 * ## 这里守什么
 *
 * 角标数必须等于「点进去真能看到几条」。
 * 只测「没删时数得对」不够 —— 那本来就不会错；
 * 必须构造「日志还在、题没了」这个场景。
 */

function makeQuestion(id: string, deckId: string): Question {
  return {
    id, deckId, kind: 'single', prompt: `题目 ${id}`,
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ],
    answer: 'A', explanation: '', anchors: [], knowledgePointId: null,
    cognitiveLevel: 'remember', topic: null, order: 0, createdAt: '', updatedAt: '',
  };
}

function makeDeck(id: string): Deck {
  return {
    id, title: `题组 ${id}`, courseId: null, status: 'published', sourceId: null,
    backendId: null, knowledgePointId: null, kinds: undefined, questionCount: 0,
    blockingIssues: [], publishedAt: '', createdAt: '', updatedAt: '',
  } as unknown as Deck;
}

/** 造一个「题目 + 卡片」的最小环境 */
async function setup(questionIds: string[]) {
  const storage = new MemoryStorage();
  const review = new ReviewService(storage);
  const sources = new SourceService(storage);
  const knowledge = new KnowledgeService(storage, sources);
  const decks = new DeckService(storage);

  await storage.put('decks', makeDeck('d1'));
  for (const id of questionIds) {
    await storage.put('questions', makeQuestion(id, 'd1'));
  }

  const cards: Card[] = questionIds.map((id) => ({
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
    createdAt: '',
    sourceId: null,
    knowledgePointId: null,
    anchors: [],
  })) as unknown as Card[];

  return { storage, review, knowledge, decks, cards };
}

/** 给某张卡写一条「答错」日志 */
async function logWrong(storage: MemoryStorage, cardId: string, day = '2026-11-08') {
  await storage.put('reviewLogs', {
    id: `log_${cardId}_${day}_${Math.random().toString(36).slice(2, 8)}`,
    cardId,
    kind: 'question',
    grade: 'again',
    day,
    at: `${day}T10:00:00.000Z`,
    elapsedSec: 10,
  } as never);
}

async function snapshotOf(
  env: Awaited<ReturnType<typeof setup>>,
  cards: Card[],
) {
  return buildSnapshot({
    loadCards: async () => cards,
    decks: env.decks,
    knowledge: env.knowledge,
    reviewService: env.review,
    sourceTitleOf: () => null,
    today: '2026-11-08',
  });
}

describe('首页错题数：只算当前还存在的题', () => {
  it('题目都在时，错题数等于答错过的张数', async () => {
    const env = await setup(['q1', 'q2', 'q3']);
    await logWrong(env.storage, 'q1');
    await logWrong(env.storage, 'q2');

    const snap = await snapshotOf(env, env.cards);
    expect(snap.wrongIds.size).toBe(2);
  });

  it('题被删掉后，它的历史错题不再计入角标（用户报的那个 bug）', async () => {
    /*
     * 这是核心场景：
     *   日志还留着（删题不销毁历史），但题目已经不在库里了。
     * 原来角标会把它们算进去，于是显示「N 道错题」点进去是空的。
     */
    const env = await setup(['q1', 'q2']);
    await logWrong(env.storage, 'q1');
    await logWrong(env.storage, 'q2');

    // 模拟「题组被删、只剩 q1」
    const remaining = env.cards.filter((c) => c.id === 'q1');
    const snap = await snapshotOf(env, remaining);

    expect(snap.wrongIds.size).toBe(1);
    expect(snap.wrongIds.has('q1')).toBe(true);
    expect(snap.wrongIds.has('q2')).toBe(false);
  });

  it('全部题都被删时角标为 0（而不是显示一堆点不开的错题）', async () => {
    /*
     * 真实数据就接近这个形态：15 张错卡，一张都不在 questions 表里。
     * 修之前显示 15；修之后必须是 0 —— 因为点进去确实是空的。
     */
    const env = await setup(['q1', 'q2', 'q3']);
    await logWrong(env.storage, 'q1');
    await logWrong(env.storage, 'q2');
    await logWrong(env.storage, 'q3');

    const snap = await snapshotOf(env, []);
    expect(snap.wrongIds.size).toBe(0);
  });

  it('答对过的卡不算错题（只看最后一次评分）', async () => {
    const env = await setup(['q1']);
    await env.storage.put('reviewLogs', {
      id: 'log_good',
      cardId: 'q1',
      kind: 'question',
      grade: 'good',
      day: '2026-11-07',
      at: '2026-11-07T10:00:00.000Z',
      elapsedSec: 10,
    } as never);

    const snap = await snapshotOf(env, env.cards);
    expect(snap.wrongIds.size).toBe(0);
  });

  it('错题数与错题页看到的一致（同口径）', async () => {
    /*
     * 这条是从用户视角写的：两边数字必须能对上。
     * 实现层面就是「都用当前存在的卡片过滤一遍」。
     */
    const env = await setup(['q1', 'q2', 'q3', 'q4']);
    await logWrong(env.storage, 'q1');
    await logWrong(env.storage, 'q2');
    await logWrong(env.storage, 'q3');

    // 只剩 q1 q2
    const remaining = env.cards.filter((c) => c.id === 'q1' || c.id === 'q2');
    const snap = await snapshotOf(env, remaining);

    const detailed = await env.review.wrongCardsDetailed();
    const visible = detailed.filter((d) => snap.cardById.has(d.cardId));

    expect(snap.wrongIds.size).toBe(visible.length);
    expect(snap.wrongIds.size).toBe(2);
  });
});
