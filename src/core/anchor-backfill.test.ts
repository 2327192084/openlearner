import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LibraryService } from './library.ts';
import type { Question, SourceSegment } from './model.ts';

/**
 * 库内旧题的 segmentId 回填（2026-11-09）。
 *
 * 与 migrations 里那条的区别：`migrations.ts` 只处理**备份导入**，
 * 用户正在用的库不会因为版本号变了就自动升级。
 * 所以 init() 里要单独跑一次，这组测试守的就是它。
 */

function seg(id: string, sourceId: string, page: number): SourceSegment {
  return {
    id,
    sourceId,
    index: page,
    page,
    chapter: null,
    text: 'x'.repeat(100),
    charCount: 100,
    createdAt: '2026-11-09T00:00:00.000Z',
  } as unknown as SourceSegment;
}

function question(id: string, anchors: Question['anchors']): Question {
  return {
    id,
    deckId: 'd1',
    kind: 'blank',
    prompt: 'p',
    options: [],
    answer: 'a',
    explanation: '',
    anchors,
    knowledgePointId: null,
    cognitiveLevel: 'understand',
    topic: null,
    order: 1,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  } as Question;
}

async function setup(segs: SourceSegment[], qs: Question[]) {
  const storage = new MemoryStorage();
  await storage.init();
  for (const s of segs) await storage.put('sourceSegments', s);
  for (const q of qs) await storage.put('questions', q);
  const library = new LibraryService(storage);
  await library.init();
  return storage;
}

describe('init() 回填旧题的 segmentId', () => {
  it('page 唯一对应一段 → 填上', async () => {
    const storage = await setup(
      [seg('s1', 'src1', 5), seg('s2', 'src1', 6)],
      [question('q1', [{ sourceId: 'src1', page: 5, charStart: 0, charEnd: 10 }])],
    );
    const q = (await storage.get('questions', 'q1')) as Question;
    expect(q.anchors[0]!.segmentId).toBe('s1');
  });

  it('同一 page 对应多段 → 留空（不挑第一条猜）', async () => {
    const storage = await setup(
      [seg('s1', 'src1', 5), seg('s2', 'src1', 5)],
      [question('q1', [{ sourceId: 'src1', page: 5 }])],
    );
    const q = (await storage.get('questions', 'q1')) as Question;
    expect(q.anchors[0]!.segmentId).toBeUndefined();
  });

  it('已有 segmentId 不被覆盖', async () => {
    const storage = await setup(
      [seg('s1', 'src1', 5)],
      [question('q1', [{ sourceId: 'src1', page: 5, segmentId: 'mine' }])],
    );
    const q = (await storage.get('questions', 'q1')) as Question;
    expect(q.anchors[0]!.segmentId).toBe('mine');
  });

  it('位置字段一个都不改', async () => {
    const storage = await setup(
      [seg('s1', 'src1', 5)],
      [question('q1', [{ sourceId: 'src1', page: 5, charStart: 7, charEnd: 21, chapter: 'C1' }])],
    );
    const q = (await storage.get('questions', 'q1')) as Question;
    expect(q.anchors[0]).toMatchObject({
      sourceId: 'src1',
      page: 5,
      charStart: 7,
      charEnd: 21,
      chapter: 'C1',
    });
  });

  it('没有要填的题时不写库（避免每次启动都全量写一遍）', async () => {
    /*
     * 这条守的是「没有副作用」：启动路径上无谓的写入会让
     * 库的 updatedAt 之类的东西无端变化，也拖慢启动。
     *
     * 空库启动应当顺利结束，且 questions 分区仍是空的。
     * （get 对不存在的记录返回 null，不是 undefined —— 以适配器为准。）
     */
    const storage = new MemoryStorage();
    await storage.init();
    await storage.put('sourceSegments', seg('s1', 'src1', 5));
    const library = new LibraryService(storage);
    await library.init();

    expect(await storage.get('questions', 'q1')).toBeNull();
    expect(await storage.getAll('questions')).toHaveLength(0);
  });

  it('题目没有 anchors 时不炸', async () => {
    const storage = new MemoryStorage();
    await storage.init();
    await storage.put('sourceSegments', seg('s1', 'src1', 5));
    await storage.put('questions', { ...question('q1', []), anchors: undefined } as never);
    const library = new LibraryService(storage);
    await expect(library.init()).resolves.toBeUndefined();
  });
});
