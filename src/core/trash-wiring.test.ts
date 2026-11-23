import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { TrashService } from './trash.ts';
import { SourceService } from './sources.ts';
import { DeckService } from './questions/service.ts';
import { KnowledgeService } from './knowledge/service.ts';
import { NoteService } from './notes.ts';
import { TodoService } from './todos.ts';
import { FlashcardService } from './flashcards.ts';
import type { Course } from './model.ts';

/**
 * 回收站的**端到端**接线测试。
 *
 * 单测（trash.test.ts）只保证 TrashService 自己算得对；
 * 这个文件保证每个服务的删除路径**真的接上了回收站**。
 *
 * 为什么这条非验不可：
 * 每个服务的构造参数都是可选的（`trash?:`），漏传一个编译器不会报错，
 * 界面也看不出来 —— 只有用户误删后想还原，才发现「那类东西找不回来」。
 * 所以这里对每一类实体都走一遍：删除 → 在回收站里看得到 → 还原 → 回来了。
 */

function newStack() {
  const storage = new MemoryStorage();
  const trash = new TrashService(storage);
  return { storage, trash };
}

describe('资料删除进回收站', () => {
  it('删资料 → 回收站里有一条（含段与注释） → 还原能拿回资料与段', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);
    const courses = storage;

    // 造一份资料 + 3 段
    const course: Course = {
      id: 'c1', name: '信号与系统', color: '#000', createdAt: '',
    };
    await courses.put('courses', course);

    await storage.put('sources', {
      id: 'src_1', title: '信号与系统第1章', fileName: 'a.pdf', kind: 'pdf',
      courseId: 'c1', pageCount: 3, byteSize: 1000, textStatus: 'ready',
      segmentCount: 3, fileStored: false, createdAt: '', updatedAt: '',
    } as never);
    for (let i = 1; i <= 3; i++) {
      await storage.put('sourceSegments', {
        id: `seg_${i}`, sourceId: 'src_1', index: i, page: i,
        chapter: null, text: `第${i}页正文`, charCount: 5,
      } as never);
    }

    await sources.remove('src_1');

    // 原分区里真没了
    expect(await storage.get('sources', 'src_1')).toBeNull();
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);

    // 回收站里有一条，附带 3 段
    const list = await trash.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('sources');
    expect(list[0]!.title).toBe('信号与系统第1章');
    expect(list[0]!.attachments).toHaveLength(3);

    // 还原
    await trash.restore(list[0]!.id);
    expect(await storage.get('sources', 'src_1')).not.toBeNull();
    expect(await storage.getAll('sourceSegments')).toHaveLength(3);
    expect(await trash.list()).toHaveLength(0);
  });

  it('有原始文件时，skipped 里如实说明「还原后要重新导入」', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);

    await storage.put('sources', {
      id: 'src_2', title: '带原文件的资料', fileName: 'b.pdf', kind: 'pdf',
      courseId: null, pageCount: 1, byteSize: 20 * 1024 * 1024, textStatus: 'ready',
      segmentCount: 0, fileStored: true, createdAt: '', updatedAt: '',
    } as never);
    await storage.put('sourceFiles', {
      id: 'src_2', data: new ArrayBuffer(8), byteSize: 8, savedAt: '',
    } as never);

    await sources.remove('src_2');
    const rec = (await trash.list())[0]!;
    expect(rec.skipped.length).toBeGreaterThan(0);
    expect(rec.skipped[0]!.what).toContain('原始文件');
    expect(rec.skipped[0]!.reason).toContain('重新导入');
    // 原始字节真的被删了（不进回收站）
    expect(await storage.get('sourceFiles', 'src_2')).toBeNull();
  });

  /**
   * 还原后 `fileStored` 必须按实际重写（2026-11-17 修）。
   *
   * ## 这个谎话是怎么被发现的
   *
   * 用户库实测：高等数学 442 页 `fileStored=true`，但 `sourceFiles` 里
   * 没有它的记录 —— 它 11-16 被删进回收站（字节被清掉）、
   * 又从回收站恢复（字节回不来，字段却还是 true）。
   *
   * 后果：ConvertPanel 据此认为「库里有原件」→ 去取 → 取不到 →
   * 回落到弹系统文件框，让用户重新找一遍。用户报的
   * 「解析时还要再选一次文件」，这一条就是其中一个来源。
   */
  it('★ 还原资料后，fileStored 按实际有没有原件校正（不能继续撒谎）', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);

    await storage.put('sources', {
      id: 'src_fs', title: '带原件的资料', fileName: 'd.pdf', kind: 'pdf',
      courseId: null, pageCount: 1, byteSize: 100, textStatus: 'ready',
      segmentCount: 0, fileStored: true, createdAt: '', updatedAt: '',
    } as never);
    await storage.put('sourceFiles', {
      id: 'src_fs', data: new ArrayBuffer(16), byteSize: 16, savedAt: '',
    } as never);

    /* 删 → 原件字节被清掉（回收站不装字节） */
    await sources.remove('src_fs');
    expect(await storage.get('sourceFiles', 'src_fs')).toBeNull();

    /* 还原 */
    const rec = (await trash.list())[0]!;
    await trash.restore(rec.id);

    const back = (await storage.get('sources', 'src_fs')) as { fileStored?: boolean } | null;
    expect(back).not.toBeNull();

    /*
     * 关键断言：字节已经不在了，fileStored 必须是 false。
     * 挂掉说明界面又会去「取一个不存在的原件」，
     * 然后回落到让用户重新选文件 —— 正是用户抱怨的那一步。
     */
    expect(back!.fileStored).toBe(false);
  });

  it('有插图时 skipped 里说明插图没保留', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);

    await storage.put('sources', {
      id: 'src_3', title: '带图的资料', fileName: 'c.pdf', kind: 'pdf',
      courseId: null, pageCount: 1, byteSize: 100, textStatus: 'ready',
      segmentCount: 0, fileStored: false, createdAt: '', updatedAt: '',
    } as never);
    await storage.put('sourceImages', {
      id: 'figure_src_3_1_7', sourceId: 'src_3', page: 1, block: 7, charOffset: 0,
      kind: 'image', dataUri: 'data:image/jpeg;base64,AA', width: 1, height: 1,
      byteSize: 1, caption: null, tier: 'basic', docShortId: 'x', createdAt: '',
    } as never);

    await sources.remove('src_3');
    const rec = (await trash.list())[0]!;
    expect(rec.skipped.some((s) => s.what.includes('插图'))).toBe(true);
    expect(await storage.getAll('sourceImages')).toHaveLength(0);
  });
});

describe('题组与题目删除进回收站', () => {
  it('删题组 → 一条记录含全部题目 → 还原都回来', async () => {
    const { storage, trash } = newStack();
    const decks = new DeckService(storage, undefined, trash);

    await storage.put('decks', {
      id: 'd1', title: '第1章题组', courseId: null, status: 'published',
      sourceId: null, backendId: null, kinds: null, questionCount: 2,
      blockingIssues: [], publishedAt: null, createdAt: '', updatedAt: '',
    } as never);
    for (let i = 0; i < 2; i++) {
      await storage.put('questions', {
        id: `q${i}`, deckId: 'd1', kind: 'single', prompt: `题目${i}`,
        options: [], answer: 'A', explanation: '', anchors: [],
        knowledgePointId: null, cognitiveLevel: 'remember', topic: null,
        order: i, createdAt: '', updatedAt: '',
      } as never);
    }

    await decks.removeDeck('d1');

    expect(await storage.getAll('questions')).toHaveLength(0);
    const rec = (await trash.list())[0]!;
    expect(rec.kind).toBe('decks');
    expect(rec.title).toBe('第1章题组');
    expect(rec.summary).toContain('2 道题');
    expect(rec.attachments).toHaveLength(2);

    await trash.restore(rec.id);
    expect(await storage.get('decks', 'd1')).not.toBeNull();
    expect(await storage.getAll('questions')).toHaveLength(2);
  });

  it('删单题 → 回收站里一条，title 是题干前 60 字', async () => {
    const { storage, trash } = newStack();
    const decks = new DeckService(storage, undefined, trash);
    const longPrompt = '很长很长的题干'.repeat(20);

    await storage.put('decks', {
      id: 'd2', title: 'T', courseId: null, status: 'draft', sourceId: null,
      backendId: null, kinds: null, questionCount: 1, blockingIssues: [],
      publishedAt: null, createdAt: '', updatedAt: '',
    } as never);
    await storage.put('questions', {
      id: 'q1', deckId: 'd2', kind: 'single', prompt: longPrompt,
      options: [], answer: 'A', explanation: '', anchors: [],
      knowledgePointId: null, cognitiveLevel: 'remember', topic: null,
      order: 0, createdAt: '', updatedAt: '',
    } as never);

    await decks.removeQuestion('q1');
    const rec = (await trash.list())[0]!;
    expect(rec.kind).toBe('questions');
    expect(rec.title).toHaveLength(60);
    expect(rec.summary).toContain('第 1 题');
  });
});

describe('知识点删除进回收站', () => {
  it('删单条 → 回收站里一条，能还原', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    await storage.put('knowledgePoints', {
      id: 'kp1', sourceId: 's1', statement: '信号可以表示为函数', quotes: [],
      anchors: [{ page: 3 }], anchorStatus: 'located', cognitiveLevel: 'remember',
      tags: [], chapter: null, backendId: null, createdAt: '', updatedAt: '',
    } as never);

    await knowledge.remove('kp1');
    expect(await storage.get('knowledgePoints', 'kp1')).toBeNull();

    const rec = (await trash.list())[0]!;
    expect(rec.kind).toBe('knowledgePoints');
    expect(rec.title).toBe('信号可以表示为函数');
    expect(rec.summary).toContain('第 3 页');

    await trash.restore(rec.id);
    expect(await storage.get('knowledgePoints', 'kp1')).not.toBeNull();
  });

  it('按资料清空 → 一条记录含全部知识点', async () => {
    const { storage, trash } = newStack();
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    await storage.put('sources', {
      id: 's1', title: '信号与系统', fileName: 'a.pdf', kind: 'pdf',
      courseId: null, pageCount: 1, byteSize: 1, textStatus: 'ready',
      segmentCount: 0, fileStored: false, createdAt: '', updatedAt: '',
    } as never);

    for (let i = 0; i < 5; i++) {
      await storage.put('knowledgePoints', {
        id: `kp${i}`, sourceId: 's1', statement: `知识点${i}`, quotes: [],
        anchors: [], anchorStatus: 'located', cognitiveLevel: 'remember',
        tags: [], chapter: null, backendId: null, createdAt: '', updatedAt: '',
      } as never);
    }

    await knowledge.clearBySource('s1');
    expect(await storage.getAll('knowledgePoints')).toHaveLength(0);

    const rec = (await trash.list())[0]!;
    expect(rec.summary).toBe('5 条');
    expect(rec.title).toContain('信号与系统');
    expect(rec.attachments).toHaveLength(4);
  });
});

describe('笔记与待办删除进回收站', () => {
  it('删笔记 → 能还原', async () => {
    const { storage, trash } = newStack();
    const notes = new NoteService(storage, trash);

    await storage.put('notes', {
      id: 'n1', cardId: 'q1', sourceId: null, body: '这道题我总是算错',
      createdAt: '', updatedAt: '', sequence: 1,
    } as never);

    await notes.remove('n1');
    expect(await storage.get('notes', 'n1')).toBeNull();
    const rec = (await trash.list())[0]!;
    expect(rec.title).toBe('这道题我总是算错');
    await trash.restore(rec.id);
    expect(await storage.get('notes', 'n1')).not.toBeNull();
  });

  it('删待办 → 能还原', async () => {
    const { storage, trash } = newStack();
    const todos = new TodoService(storage, trash);

    await storage.put('todos', {
      id: 't1', title: '复习第 3 章', note: '', dueAt: null, done: false,
      doneAt: null, createdAt: '', updatedAt: '', order: 0,
    } as never);

    await todos.remove('t1');
    expect(await storage.get('todos', 't1')).toBeNull();
    const rec = (await trash.list())[0]!;
    expect(rec.title).toBe('复习第 3 章');
    expect(rec.summary).toBe('未完成');
    await trash.restore(rec.id);
    expect(await storage.get('todos', 't1')).not.toBeNull();
  });

  it('「清掉已完成」一次删多条也进回收站，合成一条', async () => {
    const { storage, trash } = newStack();
    const todos = new TodoService(storage, trash);

    for (let i = 0; i < 3; i++) {
      await storage.put('todos', {
        id: `t${i}`, title: `已完成${i}`, note: '', dueAt: null, done: true,
        doneAt: '', createdAt: '', updatedAt: '', order: i,
      } as never);
    }
    await storage.put('todos', {
      id: 'tkeep', title: '还没做', note: '', dueAt: null, done: false,
      doneAt: null, createdAt: '', updatedAt: '', order: 9,
    } as never);

    const n = await todos.clearDone();
    expect(n).toBe(3);
    // 未完成的没被删
    expect(await storage.get('todos', 'tkeep')).not.toBeNull();

    const rec = (await trash.list())[0]!;
    expect(rec.summary).toBe('3 条');
    await trash.restore(rec.id);
    expect(await storage.getAll('todos')).toHaveLength(4);
  });
});

describe('闪卡批量删除进回收站（2026-11-23 晚）', () => {
  /**
   * ⚠️ 单卡删除**刻意不进回收站**（见 flashcards.ts 头注释），
   * 批量删（整组 / 整个文件夹）才进 —— 误伤面积大，必须能还原。
   * 这组断言守的是「批量那条路径真的接上了」，
   * 因为构造参数可选，漏传编译器不会报错。
   */
  it('批量删 → 回收站一条（含全部卡） → 还原整批回来', async () => {
    const { storage, trash } = newStack();
    const flashcards = new FlashcardService(storage, trash);

    const a = await flashcards.add({ frontText: '第一张', origin: 'user' });
    const b = await flashcards.add({ frontText: '第二张', origin: 'user' });
    const c = await flashcards.add({ frontText: '留着的', origin: 'user' });

    expect(await flashcards.removeMany([a!.id, b!.id])).toBe(2);

    /* 原分区里真没了，没点到的还在 */
    expect(await storage.get('flashcards', a!.id)).toBeNull();
    expect(await storage.get('flashcards', c!.id)).not.toBeNull();

    /* 回收站里一条，带 2 张 */
    const list = await trash.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('flashcards');
    expect(list[0]!.attachments).toHaveLength(1); /* 主记录 + 1 附件 = 2 张 */

    /* 还原：两张都回来，正文没坏 */
    await trash.restore(list[0]!.id);
    const back = await storage.getAll('flashcards');
    expect(back).toHaveLength(3);
    expect(back.map((x) => x.frontText).sort()).toEqual(['第一张', '第二张', '留着的'].sort());
    expect(await trash.list()).toHaveLength(0);
  });

  it('★ 单卡删除仍然不进回收站（两类删除刻意不对称）', async () => {
    const { storage, trash } = newStack();
    const flashcards = new FlashcardService(storage, trash);
    const a = await flashcards.add({ frontText: '单删的', origin: 'user' });

    expect(await flashcards.remove(a!.id)).toBe(true);
    expect(await storage.get('flashcards', a!.id)).toBeNull();
    /* 回收站里必须一条都没有 —— 否则这条「不对称」就没守住 */
    expect(await trash.list()).toHaveLength(0);
  });

  it('批量删空批次不产生回收站记录（别留空条目）', async () => {
    const { storage, trash } = newStack();
    const flashcards = new FlashcardService(storage, trash);
    expect(await flashcards.removeMany([])).toBe(0);
    expect(await trash.list()).toHaveLength(0);
  });

  it('删不存在的 id 不产生回收站记录', async () => {
    const { storage, trash } = newStack();
    const flashcards = new FlashcardService(storage, trash);
    expect(await flashcards.removeMany(['ghost'])).toBe(0);
    expect(await trash.list()).toHaveLength(0);
  });
});

describe('没传 trash 时退化为不可恢复删除（不该崩）', () => {
  it('SourceService 不传 trash 也能删', async () => {
    const { storage } = newStack();
    const sources = new SourceService(storage);
    await storage.put('sources', {
      id: 's', title: 't', fileName: 'f', kind: 'pdf', courseId: null,
      pageCount: 0, byteSize: 0, textStatus: 'ready', segmentCount: 0,
      fileStored: false, createdAt: '', updatedAt: '',
    } as never);
    await expect(sources.remove('s')).resolves.not.toThrow();
    expect(await storage.get('sources', 's')).toBeNull();
  });

  it('DeckService 不传 trash 也能删', async () => {
    const { storage } = newStack();
    const decks = new DeckService(storage);
    await storage.put('decks', {
      id: 'd', title: 't', courseId: null, status: 'draft', sourceId: null,
      backendId: null, kinds: null, questionCount: 0, blockingIssues: [],
      publishedAt: null, createdAt: '', updatedAt: '',
    } as never);
    await expect(decks.removeDeck('d')).resolves.not.toThrow();
    expect(await storage.get('decks', 'd')).toBeNull();
  });
});
