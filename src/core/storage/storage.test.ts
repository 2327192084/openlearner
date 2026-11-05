import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { IndexedDbStorage } from './indexeddb-storage.ts';
import { MemoryStorage } from './memory-storage.ts';
import { BACKUP_STORES, STORES } from './types.ts';
import type { StorageAdapter, StoreSnapshot } from './types.ts';

/**
 * 两套存储适配器跑**同一组**用例。
 *
 * 这是契约测试的意义：上层用例代码只依赖 StorageAdapter 接口，
 * 所以只要两套实现都过同一组断言，换存储就不会改变行为。
 * 如果只测一套，另一套的偏差会等到切环境时才炸。
 */

type AdapterFactory = { name: string; make: () => StorageAdapter };

const factories: AdapterFactory[] = [
  { name: 'MemoryStorage', make: () => new MemoryStorage() },
  { name: 'IndexedDbStorage', make: () => new IndexedDbStorage() },
];

const ts = new Date().toISOString();

function course(id: string, name: string) {
  return { id, name, color: null, createdAt: ts };
}

function emptySnapshot(): StoreSnapshot {
  const snap = {} as StoreSnapshot;
  for (const store of BACKUP_STORES) snap[store] = [] as never;
  return snap;
}

for (const factory of factories) {
  describe(`StorageAdapter 契约 · ${factory.name}`, () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      adapter = factory.make();
      await adapter.init();
      // IndexedDB 在用例之间共享同一个库，必须清干净；
      // 内存实现本来就是新的，清一次也无害。
      for (const store of STORES) await adapter.clear(store);
    });

    afterEach(() => {
      if (adapter instanceof IndexedDbStorage) adapter.close();
    });

    it('init 可重复调用（幂等）', async () => {
      await expect(adapter.init()).resolves.toBeUndefined();
      await expect(adapter.init()).resolves.toBeUndefined();
    });

    it('put 之后 get 拿得到', async () => {
      await adapter.put('courses', course('c1', '线性代数'));
      expect(await adapter.get('courses', 'c1')).toEqual(course('c1', '线性代数'));
    });

    it('get 不存在的 id 返回 null，而不是抛错或 undefined', async () => {
      expect(await adapter.get('courses', 'nope')).toBeNull();
    });

    it('同 id 的 put 是覆盖，不是插入两条', async () => {
      await adapter.put('courses', course('c1', '旧名'));
      await adapter.put('courses', course('c1', '新名'));
      const all = await adapter.getAll('courses');
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('新名');
    });

    it('putMany 一次写入多条', async () => {
      await adapter.putMany('courses', [course('c1', 'A'), course('c2', 'B'), course('c3', 'C')]);
      expect(await adapter.getAll('courses')).toHaveLength(3);
    });

    it('putMany 空数组是合法的空操作', async () => {
      await expect(adapter.putMany('courses', [])).resolves.toBeUndefined();
      expect(await adapter.getAll('courses')).toHaveLength(0);
    });

    it('remove 只删指定记录', async () => {
      await adapter.putMany('courses', [course('c1', 'A'), course('c2', 'B')]);
      await adapter.remove('courses', 'c1');
      const all = await adapter.getAll('courses');
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('c2');
    });

    it('remove 不存在的 id 不报错', async () => {
      await expect(adapter.remove('courses', 'ghost')).resolves.toBeUndefined();
    });

    it('clear 只清空指定分区，不碰其他分区', async () => {
      await adapter.put('courses', course('c1', 'A'));
      await adapter.put('sources', {
        id: 's1',
        title: '课件',
        fileName: 'a.pdf',
        kind: 'pdf',
        courseId: null,
        pageCount: 10,
        byteSize: 1024,
        // P1 引入的字段：存储契约测试也要跟着补齐，
        // 否则测的是一个已经不存在的 Source 形状
        textStatus: 'ready' as const,
        segmentCount: 0,
        fileStored: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await adapter.clear('courses');
      expect(await adapter.getAll('courses')).toHaveLength(0);
      // 关键断言：清 A 分区不该把 B 分区也清了
      expect(await adapter.getAll('sources')).toHaveLength(1);
    });

    it('分区之间互不干扰：同 id 可以在不同分区共存', async () => {
      await adapter.put('courses', course('same-id', '课程'));
      await adapter.put('decks', {
        id: 'same-id',
        title: '习题集',
        courseId: null,
        status: 'draft',
        // P3 引入的字段：存储契约测试也要跟着补齐，
        // 否则测的是一个已经不存在的 Deck 形状
        sourceId: null,
        backendId: null,
        questionCount: 0,
        blockingIssues: 0,
        publishedAt: null,
        createdAt: ts,
        updatedAt: ts,
      });
      expect((await adapter.get('courses', 'same-id'))?.id).toBe('same-id');
      expect((await adapter.get('decks', 'same-id'))?.id).toBe('same-id');
    });

    it('replaceAll 整库替换', async () => {
      await adapter.put('courses', course('old', '旧课程'));

      const snap = emptySnapshot();
      snap.courses = [course('new1', '新课程一'), course('new2', '新课程二')] as never;
      await adapter.replaceAll(snap);

      const all = await adapter.getAll('courses');
      expect(all).toHaveLength(2);
      expect(all.some((c) => c.id === 'old')).toBe(false);
    });

    it('replaceAll 会清掉快照里没提到的分区', async () => {
      await adapter.put('sources', {
        id: 's1',
        title: '残留资料',
        fileName: null,
        kind: 'text',
        courseId: null,
        pageCount: null,
        byteSize: 0,
        textStatus: 'ready' as const,
        segmentCount: 0,
        fileStored: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await adapter.replaceAll(emptySnapshot());
      // 导入空备份必须真的清空，否则「恢复到一个空库」做不到
      expect(await adapter.getAll('sources')).toHaveLength(0);
    });

    it('replaceAll 不带入 secrets（凭据永不跟随备份）', async () => {
      const snap = emptySnapshot();
      await adapter.replaceAll(snap);
      expect(await adapter.getAll('secrets')).toHaveLength(0);
    });

    it('readAll 与 replaceAll 互为逆操作', async () => {
      await adapter.putMany('courses', [course('c1', 'A'), course('c2', 'B')]);
      const snap = await adapter.readAll();
      expect(snap.courses).toHaveLength(2);

      await adapter.replaceAll(snap);
      expect(await adapter.getAll('courses')).toHaveLength(2);
    });

    it('readAll 不含 secrets 键', async () => {
      const snap = await adapter.readAll();
      expect(Object.keys(snap).sort()).toEqual([...BACKUP_STORES].sort());
      expect('secrets' in snap).toBe(false);
    });

    it('写入的内容是拷贝，外部改对象不影响已存数据', async () => {
      const record = course('c1', '原名');
      await adapter.put('courses', record);
      record.name = '被外部改掉';

      const stored = await adapter.get('courses', 'c1');
      // IndexedDB 走结构化克隆、内存实现显式 clone，两者都应隔离
      expect(stored?.name).toBe('原名');
    });
  });
}
