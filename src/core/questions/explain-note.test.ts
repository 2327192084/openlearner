import { describe, expect, it, beforeEach } from 'vitest';
import { DeckService } from './service.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { newId, nowIso } from '../id.ts';
import type { Question } from '../model.ts';

/**
 * 「针对错误生成的补充讲解」的存储（2026-11-19）。
 *
 * ## 为什么要单独一组测试
 *
 * 它的关键行为不是「能存」，而是**追加而不是覆盖**：
 * 同一个错误用「直接讲」不满意、再点「讲故事」，两条都该留着。
 * 覆盖会让人换个讲法就把上一次弄丢。
 *
 * ## 零迁移也要验
 *
 * 旧数据里 `Question` 没有 `explainNotes`。写入第一条时不能因为
 * 字段不存在而崩 —— 这是可选字段设计的全部意义。
 */

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: newId('q'),
    deckId: 'd1',
    kind: 'single',
    prompt: '线性表的定义是什么？',
    options: [
      { key: 'A', text: '有限序列', why: '符合定义' },
      { key: 'B', text: '无限序列', why: '把有限记成了无限' },
    ],
    answer: 'A',
    explanation: '线性表是有限序列。',
    anchors: [{ sourceId: 's', page: 2, charStart: 0, charEnd: 10 }],
    knowledgePointId: 'kp1',
    cognitiveLevel: 'remember',
    topic: null,
    order: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...over,
  };
}

let storage: MemoryStorage;
let decks: DeckService;

beforeEach(() => {
  storage = new MemoryStorage();
  decks = new DeckService(storage);
});

const NOTE = {
  given: 'B',
  styleId: 'story',
  crux: '把「有限」记成了「无限」',
  body: '第一段\n\n第二段',
  nextStep: '再看一眼定义',
};

describe('addExplainNote', () => {
  it('**旧题没有 explainNotes 字段时也能追加**（零迁移）', async () => {
    const q = makeQuestion();
    /* 确认起点真的没有这个字段 */
    expect(q.explainNotes).toBeUndefined();
    await storage.put('questions', q);

    const updated = await decks.addExplainNote(q.id, NOTE);
    expect(updated).not.toBeNull();
    expect(updated!.explainNotes).toHaveLength(1);
    expect(updated!.explainNotes![0].body).toBe(NOTE.body);

    /* 落库了，不只是返回值 */
    const reread = await decks.getQuestion(q.id);
    expect(reread!.explainNotes).toHaveLength(1);
  });

  it('**追加而不是覆盖**：换个讲法再生成一次，两条都在', async () => {
    const q = makeQuestion();
    await storage.put('questions', q);

    await decks.addExplainNote(q.id, { ...NOTE, styleId: 'direct' });
    await decks.addExplainNote(q.id, { ...NOTE, styleId: 'story', body: '用故事讲' });

    const reread = await decks.getQuestion(q.id);
    expect(reread!.explainNotes).toHaveLength(2);
    expect(reread!.explainNotes!.map((n) => n.styleId)).toEqual(['direct', 'story']);
    /* 顺序按追加时间，界面上先旧的新的在后面 */
    expect(reread!.explainNotes![1].body).toBe('用故事讲');
  });

  it('每一条都有自己的 id 与 createdAt', async () => {
    const q = makeQuestion();
    await storage.put('questions', q);
    await decks.addExplainNote(q.id, NOTE);
    await decks.addExplainNote(q.id, NOTE);

    const notes = (await decks.getQuestion(q.id))!.explainNotes!;
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
    expect(notes.every((n) => !!n.createdAt)).toBe(true);
    /* id 前缀是 exp_，与其它实体区分得开 */
    expect(notes.every((n) => n.id.startsWith('exp'))).toBe(true);
  });

  it('记录是哪次错误、哪种讲法（回看时要能分清）', async () => {
    const q = makeQuestion();
    await storage.put('questions', q);
    const updated = await decks.addExplainNote(q.id, NOTE);
    const note = updated!.explainNotes![0];
    expect(note.given).toBe('B');
    expect(note.styleId).toBe('story');
  });

  it('题目不存在 → 返回 null，不抛错也不产生脏数据', async () => {
    const out = await decks.addExplainNote('q_not_exist', NOTE);
    expect(out).toBeNull();
    expect(await storage.getAll('questions')).toHaveLength(0);
  });

  it('会把题目的 updatedAt 一起刷新（列表按最近改动排序时要体现）', async () => {
    const q = makeQuestion({ updatedAt: '2020-01-01T00:00:00.000Z' });
    await storage.put('questions', q);
    const updated = await decks.addExplainNote(q.id, NOTE);
    expect(updated!.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('不改动题目的其它内容（讲解是附属，不动题干/答案/选项）', async () => {
    const q = makeQuestion();
    await storage.put('questions', q);
    const updated = await decks.addExplainNote(q.id, NOTE);

    expect(updated!.prompt).toBe(q.prompt);
    expect(updated!.answer).toBe(q.answer);
    expect(updated!.options).toEqual(q.options);
    expect(updated!.explanation).toBe(q.explanation);
  });
});
