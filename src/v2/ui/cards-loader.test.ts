import { describe, expect, it } from 'vitest';
import { createCardLoader } from './cards-loader.ts';
import type { StorageAdapter } from '@/core/storage/types.ts';

/**
 * 这组测试钉住一条**行为契约**：
 *
 *   草稿题组里的题，不进复习队列。
 *
 * 为什么重要：计划书 P3 第 2 条要求「生成习题集 → 先落草稿，
 * 人工检查后才发布；发布时逐题再校验一遍」。
 *
 * 2026-11-07 查出的真实问题是：cards-loader 不看 deck.status，
 * 于是用户刚生成、还没检查过的题就被当成正式题塞进复习队列 ——
 * 那道人工关被完全绕过了。而界面上完全看不出来（题确实在复习里出现了，
 * 用户以为一切正常）。
 */

/** 造一个只实现 getAll 的最小 storage */
function makeStorage(tables: Record<string, unknown[]>): StorageAdapter {
  return {
    async getAll(store: string) {
      return (tables[store] ?? []) as never[];
    },
    async get() {
      return null;
    },
    async put() {},
    async putMany() {},
    async remove() {},
    async clear() {},
  } as unknown as StorageAdapter;
}

function makeDeck(id: string, status: 'draft' | 'published', sourceId = 'src1') {
  return { id, title: id, status, sourceId, questionCount: 1 };
}

function makeQuestion(id: string, deckId: string) {
  return {
    id,
    deckId,
    kind: 'single',
    prompt: `题目 ${id}`,
    options: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙' },
    ],
    answer: 'A',
    explanation: '',
    anchors: [{ sourceId: 'src1', page: 1, charStart: 0, charEnd: 4 }],
    sequence: 0,
    createdAt: '2026-11-07T00:00:00.000Z',
  };
}

describe('cards-loader：草稿不进复习', () => {
  it('只加载已发布题组的题目', async () => {
    const storage = makeStorage({
      decks: [makeDeck('d_pub', 'published'), makeDeck('d_draft', 'draft')],
      questions: [makeQuestion('q_pub', 'd_pub'), makeQuestion('q_draft', 'd_draft')],
      knowledgePoints: [],
    });
    const load = createCardLoader(storage);
    const cards = await load();
    const ids = cards.map((c) => c.id);
    expect(ids).toContain('q_pub');
    expect(ids).not.toContain('q_draft');
  });

  it('全是草稿时，题目一张都不出现', async () => {
    const storage = makeStorage({
      decks: [makeDeck('d1', 'draft'), makeDeck('d2', 'draft')],
      questions: [makeQuestion('q1', 'd1'), makeQuestion('q2', 'd2')],
      knowledgePoints: [],
    });
    const cards = await createCardLoader(storage)();
    expect(cards.filter((c) => c.kind !== 'point')).toHaveLength(0);
  });

  it('发布后题目立刻可用（不用重启）', async () => {
    const decks = [makeDeck('d1', 'draft')];
    const questions = [makeQuestion('q1', 'd1')];
    const storage = makeStorage({ decks, questions, knowledgePoints: [] });
    const load = createCardLoader(storage);

    expect((await load()).filter((c) => c.kind !== 'point')).toHaveLength(0);

    // 模拟用户点「发布」
    decks[0] = makeDeck('d1', 'published');
    expect((await load()).filter((c) => c.kind !== 'point')).toHaveLength(1);
  });

  it('孤儿题（所属题组已不存在）不会被加载', async () => {
    const storage = makeStorage({
      decks: [],
      questions: [makeQuestion('q_orphan', 'd_gone')],
      knowledgePoints: [],
    });
    const cards = await createCardLoader(storage)();
    expect(cards.map((c) => c.id)).not.toContain('q_orphan');
  });

  it('已发布题组能带上出处信息（供点回原文）', async () => {
    const storage = makeStorage({
      decks: [makeDeck('d1', 'published', 'src_abc')],
      questions: [makeQuestion('q1', 'd1')],
      knowledgePoints: [],
    });
    const cards = await createCardLoader(storage)();
    const q = cards.find((c) => c.id === 'q1');
    expect(q?.sourceId).toBe('src_abc');
    expect(q?.anchors[0]?.page).toBe(1);
  });
});
