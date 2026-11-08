import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import {
  TrashService,
  computeExpiresAt,
  hoursUntilExpiry,
  isExpired,
  shouldRemind,
  TRASH_RETENTION_DAYS,
} from './trash.ts';
import type { TrashRecord } from './model.ts';

/**
 * 回收站的测试。
 *
 * 重点守四件事：
 *  1. 30 天保留期算对（这条用户明确要求）
 *  2. 24 小时提醒窗口算对，且**过期的不提醒**
 *  3. 还原要连附属记录一起回来（否则拿回一份空壳资料）
 *  4. 启动清扫只删过期的，不误删快过期的
 */

const HOUR = 60 * 60 * 1000;

function makeRecord(over: Partial<TrashRecord> = {}): TrashRecord {
  const deletedAt = '2026-11-08T00:00:00.000Z';
  return {
    id: 'trash_1',
    kind: 'knowledgePoints',
    originalId: 'kp_1',
    title: '知识点标题',
    summary: '1 条知识点',
    payload: { id: 'kp_1', statement: '内容' },
    attachments: [],
    skipped: [],
    deletedAt,
    expiresAt: computeExpiresAt(deletedAt),
    ...over,
  };
}

describe('computeExpiresAt', () => {
  it('正好是 30 天后', () => {
    const at = computeExpiresAt('2026-11-08T00:00:00.000Z');
    const d = new Date(at);
    const start = new Date('2026-11-08T00:00:00.000Z');
    const days = Math.round((d.getTime() - start.getTime()) / (24 * HOUR));
    expect(days).toBe(TRASH_RETENTION_DAYS);
  });

  it('跨月也对（11月8日 → 12月8日）', () => {
    const at = new Date(computeExpiresAt('2026-11-08T12:00:00.000Z'));
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(11); // 12 月（0 基）
    expect(at.getDate()).toBe(8);
  });

  it('坏输入原样返回，不抛（宁可显示奇怪日期，也不要崩掉删除流程）', () => {
    expect(computeExpiresAt('不是日期')).toBe('不是日期');
    expect(computeExpiresAt('')).toBe('');
  });
});

describe('hoursUntilExpiry / isExpired / shouldRemind', () => {
  it('刚删的还剩约 30 天', () => {
    const rec = makeRecord();
    const now = new Date(rec.deletedAt).getTime();
    expect(Math.round(hoursUntilExpiry(rec, now) / 24)).toBe(TRASH_RETENTION_DAYS);
  });

  it('剩 23 小时 → 该提醒', () => {
    const rec = makeRecord();
    const at = new Date(rec.expiresAt).getTime();
    const now = at - 23 * HOUR;
    expect(shouldRemind(rec, now)).toBe(true);
    expect(isExpired(rec, now)).toBe(false);
  });

  it('剩 25 小时 → 还不提醒（不到 24h 窗口）', () => {
    const rec = makeRecord();
    const at = new Date(rec.expiresAt).getTime();
    expect(shouldRemind(rec, at - 25 * HOUR)).toBe(false);
  });

  it('剩 1 小时 → 提醒', () => {
    const rec = makeRecord();
    const at = new Date(rec.expiresAt).getTime();
    expect(shouldRemind(rec, at - 1 * HOUR)).toBe(true);
  });

  it('已经过期 → 不提醒（马上要删了，提醒只会让人措手不及）', () => {
    const rec = makeRecord();
    const at = new Date(rec.expiresAt).getTime();
    expect(shouldRemind(rec, at + 1)).toBe(false);
    expect(isExpired(rec, at + 1)).toBe(true);
  });

  it('正好到点算过期', () => {
    const rec = makeRecord();
    const at = new Date(rec.expiresAt).getTime();
    expect(isExpired(rec, at)).toBe(true);
  });
});

describe('moveToTrash', () => {
  it('把一批合成一条记录，第一条是主记录', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const rec = await trash.moveToTrash([
      { kind: 'sources', title: '信号与系统', summary: '36 页', payload: { id: 'src_1' } },
      { kind: 'sourceSegments', title: '', summary: '', payload: { id: 'seg_1' } },
      { kind: 'sourceSegments', title: '', summary: '', payload: { id: 'seg_2' } },
    ]);
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe('sources');
    expect(rec!.originalId).toBe('src_1');
    expect(rec!.attachments).toHaveLength(2);
    expect(await trash.list()).toHaveLength(1);
  });

  it('空数组直接返回 null，不产生空记录', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    expect(await trash.moveToTrash([])).toBeNull();
    expect(await trash.list()).toEqual([]);
  });

  it('skipped 如实保留（大二进制不收，但要说明原因）', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const rec = await trash.moveToTrash(
      [{ kind: 'sources', title: 'x', summary: 'y', payload: { id: 's1' } }],
      [{ what: '原始 PDF', reason: '22 MB，能从原文件重新导入' }],
    );
    expect(rec!.skipped).toHaveLength(1);
    expect(rec!.skipped[0]!.what).toBe('原始 PDF');
  });

  it('expiresAt 自动算好', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const rec = await trash.moveToTrash([
      { kind: 'notes', title: 'n', summary: 's', payload: { id: 'n1' } },
    ]);
    expect(rec!.expiresAt).not.toBe(rec!.deletedAt);
    expect(new Date(rec!.expiresAt).getTime()).toBeGreaterThan(new Date(rec!.deletedAt).getTime());
  });
});

describe('restore', () => {
  it('主记录与附属记录一起回到各自分区', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);

    const rec = await trash.moveToTrash([
      { kind: 'sources', title: '资料', summary: 's', payload: { id: 'src_1', title: '资料' } },
      { kind: 'sourceSegments', title: '', summary: '', payload: { id: 'seg_1', text: '正文' } },
    ]);

    // 模拟「已从原分区真删除」
    await storage.put('sources', { id: 'src_1', title: '资料' } as never);
    await storage.remove('sources', 'src_1');

    const r = await trash.restore(rec!.id);
    expect(r!.restored).toBe(2);
    expect(await storage.get('sources', 'src_1')).not.toBeNull();
    expect(await storage.get('sourceSegments', 'seg_1')).not.toBeNull();
    // 还原后回收站里这条没了
    expect(await trash.list()).toHaveLength(0);
  });

  it('还原不存在的记录返回 null', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    expect(await trash.restore('trash_nope')).toBeNull();
  });
});

describe('purge / purgeAll', () => {
  it('彻底删除单条', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const rec = await trash.moveToTrash([
      { kind: 'todos', title: 't', summary: 's', payload: { id: 't1' } },
    ]);
    expect(await trash.purge(rec!.id)).toBe(true);
    expect(await trash.list()).toHaveLength(0);
  });

  it('清空全部', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    await trash.moveToTrash([{ kind: 'todos', title: 'a', summary: '', payload: { id: 'a' } }]);
    await trash.moveToTrash([{ kind: 'todos', title: 'b', summary: '', payload: { id: 'b' } }]);
    expect(await trash.purgeAll()).toBe(2);
    expect(await trash.list()).toHaveLength(0);
  });
});

describe('sweep（启动时扫一遍）', () => {
  it('只删过期的，快过期的不动', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);

    // 一条已过期
    const old = makeRecord({ id: 'trash_old', expiresAt: '2026-11-01T00:00:00.000Z' });
    // 一条还剩 10 小时
    const soon = makeRecord({
      id: 'trash_soon',
      expiresAt: new Date(Date.now() + 10 * HOUR).toISOString(),
    });
    await storage.put('trash', old);
    await storage.put('trash', soon);

    const r = await trash.sweep(Date.now());
    expect(r.purged).toBe(1);
    expect(r.reminded).toBe(1);

    const left = await trash.list();
    expect(left).toHaveLength(1);
    expect(left[0]!.id).toBe('trash_soon');
  });

  it('空回收站返回 0/0', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    expect(await trash.sweep()).toEqual({ purged: 0, reminded: 0 });
  });

  it('全部过期时全清掉', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    await storage.put('trash', makeRecord({ id: 'a', expiresAt: '2020-01-01T00:00:00.000Z' }));
    await storage.put('trash', makeRecord({ id: 'b', expiresAt: '2020-01-02T00:00:00.000Z' }));
    const r = await trash.sweep(Date.now());
    expect(r.purged).toBe(2);
    expect(await trash.list()).toHaveLength(0);
  });
});

describe('pendingReminders', () => {
  it('只返回 ≤24 小时且未过期的', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    const now = Date.now();

    await storage.put('trash', makeRecord({
      id: 'a', expiresAt: new Date(now + 5 * HOUR).toISOString(),
    }));
    await storage.put('trash', makeRecord({
      id: 'b', expiresAt: new Date(now + 20 * 24 * HOUR).toISOString(),
    }));
    await storage.put('trash', makeRecord({
      id: 'c', expiresAt: new Date(now - HOUR).toISOString(),
    }));

    const r = await trash.pendingReminders(now);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('a');
  });
});

describe('list / listByKind', () => {
  it('最近删的排在前面', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    await storage.put('trash', makeRecord({ id: 'old', deletedAt: '2026-11-01T00:00:00.000Z' }));
    await storage.put('trash', makeRecord({ id: 'new', deletedAt: '2026-11-07T00:00:00.000Z' }));
    const list = await trash.list();
    expect(list[0]!.id).toBe('new');
  });

  it('按 kind 过滤', async () => {
    const storage = new MemoryStorage();
    const trash = new TrashService(storage);
    await storage.put('trash', makeRecord({ id: 'a', kind: 'decks' }));
    await storage.put('trash', makeRecord({ id: 'b', kind: 'notes' }));
    expect(await trash.listByKind('decks')).toHaveLength(1);
  });
});
