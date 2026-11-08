import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { TrashService } from './trash.ts';
import { DeckService } from './questions/service.ts';
import { KnowledgeService } from './knowledge/service.ts';
import { SourceService } from './sources.ts';
import type { GenerationRun, KnowledgePoint } from './model.ts';

/**
 * 任务记录的删除与「出题要留 run」的测试（2026-11-08）。
 *
 * ## 这一组为什么存在
 *
 * 用户报「任务栏最近一次的任务没统计 token」。查下来是：
 * 出题流程**根本不写 generationRuns**，任务页只能从 decks 反推，
 * 拿不到 token（真实数据里那组题确实花了 51861 token，
 * 只是记在按天聚合的 usageRecords 里，关联不上）。
 *
 * 所以这里守两件事：
 *  1. 出题确实写了一条带 actualTokens 的 run
 *  2. 删任务记录进回收站，且**不动**知识点与题目
 */

const mockBackend = {
  id: 'b1',
  provider: 'deepseek',
  isMock: true,
  label: '假后端',
  estimateTokens: () => 100,
  /*
   * 注意：真实的出题后端是**通过 onDraft 回调**把题一道一道交给服务层的，
   * 不是在返回值里塞 drafts 数组。返回值里的 drafts 只是"最终汇总"，
   * 服务层不读它（读的是自己收集到的 questions）。
   *
   * 第一版 mock 写成 `drafts: [一题]` 但没调 onDraft，于是 producedCount
   * 是 0 —— 测试红了，但那暴露的是**测试写错了**，不是代码错了。
   * 这个区别很重要：不能为了让断言变绿去改断言的期望值。
   */
  generate: async (
    _points: unknown,
    opts: { onDraft?: (d: unknown) => Promise<void> },
  ) => {
    await opts.onDraft?.({
      knowledgePointId: 'kp1',
      kind: 'single' as const,
      prompt: '题干',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
      ],
      answer: 'A',
      explanation: '',
      cognitiveLevel: 'remember' as const,
      topic: null,
    });
    return { actualTokens: 1234, stopped: false };
  },
};

function makePoint(): KnowledgePoint {
  return {
    id: 'kp1', sourceId: 's1', statement: '信号', quotes: ['信号'],
    anchors: [{ sourceId: 's1', page: 1, charStart: 0, charEnd: 2 }],
    anchorStatus: 'located', cognitiveLevel: 'remember', tags: [], chapter: null,
    backendId: 'b1', origin: 'material', createdAt: '', updatedAt: '',
  } as KnowledgePoint;
}

/** 出题输入的最小合法形状（signal 是必填，给个不会触发的） */
function inputFor(points: KnowledgePoint[], backend: unknown, title: string) {
  return {
    points,
    title,
    backend,
    signal: new AbortController().signal,
    options: { count: 1, kinds: ['single'] },
  } as never;
}

describe('出题写 generationRuns（修 token 显示）', () => {
  it('成功后有一条 kind=questions 的 run，带真实 token 与 deckId', async () => {
    const storage = new MemoryStorage();
    const decks = new DeckService(storage);

    const out = await decks.generate(inputFor([makePoint()], mockBackend, '测试题组'));

    const runs = await storage.getAll('generationRuns');
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.kind).toBe('questions');
    expect(run.status).toBe('completed');
    expect(run.actualTokens).toBe(1234);
    expect(run.deckId).toBe(out.deck.id);
    expect(run.producedCount).toBe(1);
    expect(run.finishedAt).not.toBeNull();
  });

  it('失败时也留一条 failed 的 run（否则任务页永远显示进行中）', async () => {
    const storage = new MemoryStorage();
    const decks = new DeckService(storage);
    const failing = {
      ...mockBackend,
      generate: async () => {
        throw new Error('模型返回了空结果');
      },
    };

    await expect(
      decks.generate(inputFor([makePoint()], failing, '会失败的题组')),
    ).rejects.toThrow();

    const runs = await storage.getAll('generationRuns');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error).toContain('空结果');
  });
});

describe('任务记录删除', () => {
  function makeRun(id: string, over: Partial<GenerationRun> = {}): GenerationRun {
    return {
      id, kind: 'organize', sourceId: 's1', pageRange: null, status: 'completed',
      estimatedTokens: 100, actualTokens: 500, producedCount: 10, unlocatedCount: 0,
      error: null, backendId: 'b1', startedAt: '2026-11-07T00:00:00.000Z',
      finishedAt: '2026-11-07T00:01:00.000Z', ...over,
    };
  }

  it('删一条记录 → 进回收站，能还原', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    await storage.put('generationRuns', makeRun('run_1'));
    await knowledge.removeRun('run_1');

    expect(await storage.getAll('generationRuns')).toHaveLength(0);
    const rec = (await trash.list())[0]!;
    expect(rec.kind).toBe('generationRuns');
    expect(rec.title).toBe('整理记录');

    await trash.restore(rec.id);
    expect(await storage.getAll('generationRuns')).toHaveLength(1);
  });

  it('删记录不动知识点（这是关键：别把劳动成果一起删了）', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    await storage.put('generationRuns', makeRun('run_1'));
    await storage.put('knowledgePoints', makePoint());

    await knowledge.removeRun('run_1');

    // run 没了，知识点还在
    expect(await storage.getAll('generationRuns')).toHaveLength(0);
    expect(await storage.getAll('knowledgePoints')).toHaveLength(1);
  });

  it('清空全部记录 → 合成一条回收站记录', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    for (let i = 0; i < 3; i++) {
      await storage.put('generationRuns', makeRun(`run_${i}`));
    }
    const n = await knowledge.clearRuns();
    expect(n).toBe(3);
    expect(await storage.getAll('generationRuns')).toHaveLength(0);

    const list = await trash.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe('3 条');
    expect(list[0]!.attachments).toHaveLength(2);
  });

  it('回收站里的记录标题能区分出题与整理', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    await storage.put('generationRuns', makeRun('q1', { kind: 'questions' }));
    await storage.put('generationRuns', makeRun('o1', { kind: 'organize' }));

    await knowledge.removeRun('q1');
    await knowledge.removeRun('o1');

    const titles = (await trash.list()).map((r) => r.title);
    expect(titles).toContain('出题记录');
    expect(titles).toContain('整理记录');
  });

  it('没有记录时清空返回 0，不产生空回收站条目', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const sources = new SourceService(storage, trash);
    const knowledge = new KnowledgeService(storage, sources, undefined, trash);

    expect(await knowledge.clearRuns()).toBe(0);
    expect(await trash.list()).toEqual([]);
  });
});
