/**
 * `bucketOf` 与解析运行记录的单测（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「任务栏没有记录文档解析的任务，把这个加上去。
 *   同时任务栏也做分类，未完成；进行中；已完成三种。」
 *
 * ## 这里钉什么
 *
 * 1. **分类映射**：stopped / failed 归「未完成」而不是「已完成」——
 *    这条是产品判断，写错的话任务页会骗人（把没做成的活显示成做完了）
 * 2. **解析记录能落库、能收尾**：开一条 → 结束 → 状态与页数对得上
 * 3. **不会永远卡在「进行中」**：finish 之后 status 必须变
 */

import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { bucketOf, TaskRunService } from './task-run-service.ts';

describe('bucketOf：三种分类的映射', () => {
  it('running → 进行中', () => {
    expect(bucketOf('running')).toBe('running');
  });

  it('completed → 已完成', () => {
    expect(bucketOf('completed')).toBe('done');
  });

  it('★ stopped → **未完成**（用户中途停下，活没干完）', () => {
    expect(bucketOf('stopped')).toBe('todo');
  });

  it('★ failed → **未完成**（失败了就是没做成）', () => {
    expect(bucketOf('failed')).toBe('todo');
  });

  it('★ 只有 completed 算「已完成」（否定断言，防止误把别的状态归进去）', () => {
    const all = ['running', 'completed', 'stopped', 'failed'] as const;
    const done = all.filter((s) => bucketOf(s) === 'done');
    expect(done).toEqual(['completed']);
  });
});

describe('TaskRunService：解析运行记录', () => {
  const input = {
    sourceId: 'src_1',
    sourceTitle: '高等数学 第7版 上',
    pageRange: { from: 1, to: 442 },
    engine: 'deepseek' as const,
  };

  it('★ 开一条记录 → 状态是 running，kind 是 parse', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);

    const id = await svc.startParseRun(input);
    const rows = await svc.listRuns();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.kind).toBe('parse');
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.finishedAt).toBeNull();
  });

  it('★ 结束记录 → 状态、页数、时间都对', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);

    const id = await svc.startParseRun(input);
    await svc.finishParseRun(id, { status: 'completed', pages: 442 });

    const rows = await svc.listRuns();
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.producedCount).toBe(442);
    expect(rows[0]!.finishedAt).not.toBeNull();
  });

  it('★ 不会永远停在「进行中」—— finish 之后一定能落成终态', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);
    const id = await svc.startParseRun(input);
    await svc.finishParseRun(id, { status: 'failed', pages: 0, error: '网关拒收' });

    const rows = await svc.listRuns();
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toBe('网关拒收');
    expect(bucketOf(rows[0]!.status)).toBe('todo');
  });

  it('token 是 null 而不是 0（解析不花 token，0 是假数据）', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);
    await svc.startParseRun(input);
    const rows = await svc.listRuns();
    expect(rows[0]!.estimatedTokens).toBeNull();
    expect(rows[0]!.actualTokens).toBeNull();
  });

  it('引擎记进 backendId，便于区分本地 / 云端', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);
    await svc.startParseRun({ ...input, engine: 'local' });
    const rows = await svc.listRuns();
    expect(rows[0]!.backendId).toBe('mineru-local');
  });

  it('★ 列表按时间倒序（刚发生的在最上面）', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);

    /* 直接造两条不同时间的记录，避免依赖真实时钟精度 */
    await storage.put('generationRuns', {
      id: 'r_old', kind: 'parse', sourceId: 's', pageRange: null, status: 'completed',
      estimatedTokens: null, actualTokens: null, producedCount: 1, unlocatedCount: 0,
      error: null, backendId: null, startedAt: '2026-11-01T00:00:00.000Z', finishedAt: null,
    } as never);
    await storage.put('generationRuns', {
      id: 'r_new', kind: 'parse', sourceId: 's', pageRange: null, status: 'completed',
      estimatedTokens: null, actualTokens: null, producedCount: 1, unlocatedCount: 0,
      error: null, backendId: null, startedAt: '2026-11-17T00:00:00.000Z', finishedAt: null,
    } as never);

    const rows = await svc.listRuns();
    expect(rows.map((r) => r.id)).toEqual(['r_new', 'r_old']);
  });

  it('finish 一个不存在的 id 不抛错（幂等，别炸主流程）', async () => {
    const storage = new MemoryStorage();
    const svc = new TaskRunService(storage);
    await expect(svc.finishParseRun('nope', { status: 'completed', pages: 1 })).resolves.toBeUndefined();
  });
});