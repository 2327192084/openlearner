import { beforeEach, describe, expect, it } from 'vitest';
import { TodoService } from './todos.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 待办服务的测试。
 *
 * ## 重点：排序
 *
 * 排序规则直接决定用户打开时先看到什么。这里把规则逐条钉死：
 * 无期限的在前、有期限按日期近的在前、已完成沉底。
 *
 * 另外几条是对**数据卫生**的要求：空标题拒绝、截止日格式统一、
 * 完成时间不给未完成项留残值。
 */
describe('TodoService', () => {
  let storage: MemoryStorage;
  let svc: TodoService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new TodoService(storage);
  });

  describe('新建', () => {
    it('新建一条未完成的待办', async () => {
      const t = await svc.create({ title: '周三前复习完第三章' });
      expect(t.title).toBe('周三前复习完第三章');
      expect(t.done).toBe(false);
      expect(t.doneAt).toBeNull();
      expect(t.dueAt).toBeNull();
    });

    it('空标题被拒绝', async () => {
      await expect(svc.create({ title: '   ' })).rejects.toThrow(/空/);
      expect(await svc.list()).toHaveLength(0);
    });

    it('截止日只接受 YYYY-MM-DD', async () => {
      const ok = await svc.create({ title: 'a', dueAt: '2026-11-12' });
      expect(ok.dueAt).toBe('2026-11-12');

      /* 带时间的 ISO 会让字符串比较失效，统一当「不限期」 */
      const bad = await svc.create({ title: 'b', dueAt: '2026-11-12T10:00:00Z' });
      expect(bad.dueAt).toBeNull();
    });

    it('新条目排在无期限组的最前面', async () => {
      await svc.create({ title: '先写' });
      await svc.create({ title: '后写' });
      const list = await svc.list();
      expect(list[0]!.title).toBe('后写');
    });
  });

  describe('排序', () => {
    it('无期限的排在有期限的前面（否则大部分待办会被挤到最后看不见）', async () => {
      await svc.create({ title: '有期限', dueAt: '2026-11-20' });
      await svc.create({ title: '无期限' });
      const list = await svc.list();
      expect(list[0]!.title).toBe('无期限');
    });

    it('有期限的按日期近的在前', async () => {
      await svc.create({ title: '远期', dueAt: '2026-12-01' });
      await svc.create({ title: '近期', dueAt: '2026-11-10' });
      const list = await svc.list();
      expect(list[0]!.title).toBe('近期');
      expect(list[1]!.title).toBe('远期');
    });

    it('已完成的沉底', async () => {
      const a = await svc.create({ title: '要做的' });
      await svc.create({ title: '已做完' });
      await svc.toggle((await svc.list()).find((t) => t.title === '已做完')!.id, '2026-11-07');
      const list = await svc.list();
      expect(list[0]!.id).toBe(a.id);
      expect(list[list.length - 1]!.title).toBe('已做完');
    });

    it('已完成的按完成时间倒序（刚做完的在上面）', async () => {
      const a = await svc.create({ title: 'A' });
      const b = await svc.create({ title: 'B' });
      await svc.toggle(a.id, '2026-11-05');
      await svc.toggle(b.id, '2026-11-07');
      const done = (await svc.list()).filter((t) => t.done);
      expect(done[0]!.title).toBe('B');
    });
  });

  describe('勾选', () => {
    it('勾选后记完成时间', async () => {
      const t = await svc.create({ title: 'x' });
      const done = await svc.toggle(t.id, '2026-11-07');
      expect(done.done).toBe(true);
      expect(done.doneAt).toBe('2026-11-07');
    });

    it('取消勾选要清掉完成时间（不留残值）', async () => {
      const t = await svc.create({ title: 'x' });
      await svc.toggle(t.id, '2026-11-07');
      const undone = await svc.toggle(t.id, '2026-11-08');
      expect(undone.done).toBe(false);
      expect(undone.doneAt).toBeNull();
    });

    it('勾选不存在的待办会报错', async () => {
      await expect(svc.toggle('todo_不存在', '2026-11-07')).rejects.toThrow(/不存在/);
    });
  });

  describe('修改', () => {
    it('能改标题与备注', async () => {
      const t = await svc.create({ title: '旧' });
      const next = await svc.update(t.id, { title: '新', note: '备注' });
      expect(next.title).toBe('新');
      expect(next.note).toBe('备注');
    });

    it('改成空标题被拒绝，原内容保留', async () => {
      const t = await svc.create({ title: '有内容' });
      await expect(svc.update(t.id, { title: '  ' })).rejects.toThrow(/空/);
      const list = await svc.list();
      expect(list[0]!.title).toBe('有内容');
    });

    it('能把截止日改成不限期', async () => {
      const t = await svc.create({ title: 'x', dueAt: '2026-11-20' });
      const next = await svc.update(t.id, { dueAt: null });
      expect(next.dueAt).toBeNull();
    });
  });

  describe('计数与清理', () => {
    it('未完成条数', async () => {
      const a = await svc.create({ title: 'a' });
      await svc.create({ title: 'b' });
      await svc.toggle(a.id, '2026-11-07');
      expect(await svc.pendingCount()).toBe(1);
    });

    it('逾期条数只算未完成且日期已过', async () => {
      await svc.create({ title: '逾期', dueAt: '2026-11-01' });
      await svc.create({ title: '今天到期', dueAt: '2026-11-07' });
      await svc.create({ title: '未来', dueAt: '2026-12-01' });
      await svc.create({ title: '无期限' });
      /* 今天 = 2026-11-07：只有 11-01 那条算逾期（当天到期不算逾期） */
      expect(await svc.overdueCount('2026-11-07')).toBe(1);
    });

    it('清掉已完成', async () => {
      const a = await svc.create({ title: 'a' });
      await svc.create({ title: 'b' });
      await svc.toggle(a.id, '2026-11-07');
      expect(await svc.clearDone()).toBe(1);
      expect(await svc.list()).toHaveLength(1);
    });

    it('删除单条', async () => {
      const t = await svc.create({ title: 'x' });
      await svc.remove(t.id);
      expect(await svc.list()).toHaveLength(0);
    });
  });
});
