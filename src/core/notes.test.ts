import { beforeEach, describe, expect, it } from 'vitest';
import { NoteService } from './notes.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 学习笔记的测试。
 *
 * ## 重点在「拒绝」上
 *
 * 笔记是用户自己敲的字，写坏了最恼人。所以这里测的多是
 * **不该发生的操作会不会被拦住**：空正文、没有归属、改不存在的笔记。
 *
 * 这些如果不拦，界面上会出现「点开是空的」「保存了但列表没有」
 * 这类让人以为软件坏了的现象。
 */
describe('NoteService', () => {
  let storage: MemoryStorage;
  let svc: NoteService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new NoteService(storage);
  });

  describe('新建', () => {
    it('挂在卡片上能保存', async () => {
      const n = await svc.create({ cardId: 'q1', body: '这题的关键是先通分' });
      expect(n.cardId).toBe('q1');
      expect(n.body).toBe('这题的关键是先通分');
      expect(n.createdAt).toBeTruthy();
    });

    it('挂在资料上能保存', async () => {
      const n = await svc.create({ sourceId: 's1', body: '第 3 页这段要记住' });
      expect(n.sourceId).toBe('s1');
    });

    it('正文首尾空白会被去掉', async () => {
      const n = await svc.create({ cardId: 'q1', body: '  有空白  \n' });
      expect(n.body).toBe('有空白');
    });

    it('空正文被拒绝（不留空壳笔记）', async () => {
      await expect(svc.create({ cardId: 'q1', body: '   ' })).rejects.toThrow(/空/);
      expect(await svc.list()).toHaveLength(0);
    });

    it('既没有 cardId 也没有 sourceId 被拒绝', async () => {
      await expect(svc.create({ body: '没挂在哪' })).rejects.toThrow(/挂在/);
    });
  });

  describe('查询', () => {
    it('按卡片查', async () => {
      await svc.create({ cardId: 'q1', body: 'a' });
      await svc.create({ cardId: 'q2', body: 'b' });
      const mine = await svc.listByCard('q1');
      expect(mine).toHaveLength(1);
      expect(mine[0]!.body).toBe('a');
    });

    it('按资料查', async () => {
      await svc.create({ sourceId: 's1', body: 'x' });
      expect(await svc.listBySource('s1')).toHaveLength(1);
      expect(await svc.listBySource('s2')).toHaveLength(0);
    });

    it('全部列表按更新时间倒序（最近写的在前面）', async () => {
      const a = await svc.create({ cardId: 'q1', body: '先写的' });
      const b = await svc.create({ cardId: 'q2', body: '后写的' });
      /* 手动改一个更晚的更新时间，模拟用户后来编辑过 a */
      await svc.update(a.id, '改过的');
      const list = await svc.list();
      expect(list[0]!.id).toBe(a.id);
      expect(list[1]!.id).toBe(b.id);
    });

    it('同一张卡上的多条按创建顺序', async () => {
      await svc.create({ cardId: 'q1', body: '1' });
      await svc.create({ cardId: 'q1', body: '2' });
      const mine = await svc.listByCard('q1');
      expect(mine.map((n) => n.body)).toEqual(['1', '2']);
    });
  });

  describe('修改', () => {
    it('能改正文并刷新更新时间', async () => {
      const n = await svc.create({ cardId: 'q1', body: '旧' });
      const updated = await svc.update(n.id, '新内容');
      expect(updated.body).toBe('新内容');
      expect(updated.id).toBe(n.id);
      expect(updated.createdAt).toBe(n.createdAt);
    });

    it('改成空正文被拒绝（要删请用删除）', async () => {
      const n = await svc.create({ cardId: 'q1', body: '有内容' });
      await expect(svc.update(n.id, '  ')).rejects.toThrow(/空/);
      /* 原内容不能被清掉 */
      const mine = await svc.listByCard('q1');
      expect(mine[0]!.body).toBe('有内容');
    });

    it('改不存在的笔记会报错（不静默新建一条）', async () => {
      await expect(svc.update('note_不存在', '内容')).rejects.toThrow(/不存在/);
      expect(await svc.list()).toHaveLength(0);
    });
  });

  describe('删除', () => {
    it('按 id 删除', async () => {
      const n = await svc.create({ cardId: 'q1', body: 'x' });
      await svc.remove(n.id);
      expect(await svc.list()).toHaveLength(0);
    });

    it('按卡片级联删除', async () => {
      await svc.create({ cardId: 'q1', body: 'a' });
      await svc.create({ cardId: 'q1', body: 'b' });
      await svc.create({ cardId: 'q2', body: 'c' });
      const removed = await svc.removeByCard('q1');
      expect(removed).toBe(2);
      expect(await svc.list()).toHaveLength(1);
    });

    it('按资料级联删除', async () => {
      await svc.create({ sourceId: 's1', body: 'a' });
      await svc.create({ sourceId: 's1', body: 'b' });
      expect(await svc.removeBySource('s1')).toBe(2);
      expect(await svc.list()).toHaveLength(0);
    });
  });
});
