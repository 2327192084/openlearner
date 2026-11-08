import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { TrashService } from './trash.ts';
import { SourceService } from './sources.ts';
import { DeckService } from './questions/service.ts';
import { KnowledgeService } from './knowledge/service.ts';
import { NoteService } from './notes.ts';
import { TodoService } from './todos.ts';
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
