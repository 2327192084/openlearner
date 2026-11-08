import { BACKUP_STORES, STORES } from './types.ts';
import type {
  StorageAdapter,
  StoreName,
  StoreRecordMap,
  StoreSnapshot,
} from './types.ts';

const DB_NAME = 'openleaner';
/**
 * 库版本。
 *
 * 新增分区（比如 v2 的 sourceFiles）必须同时提这个数字 ——
 * onupgradeneeded 只在版本升高时触发，不提版本的新分区永远不会被建出来，
 * 而写入时抛的 NotFoundError 只在「往新分区写第一条记录」时才出现。
 */
/** v3：新增 sourceAnnotations（用户在资料上的手写注释） */
/** v4：新增 reviewRecords(reviewLogs) —— 间隔复习进度与历史 */
/** v5：新增 notes（学习笔记） */
/** v6：新增 examAttempts（模拟考试记录） */
/** v7：新增 todos（待办） */
/** v8：新增 focusSessions（专注记录 / 番茄钟） */
/** v9：新增 sourceImages（MinerU 转换出的教材插图） */
/** v10：新增 trash（回收站） */
const DB_VERSION = 10;

/**
 * IndexedDB 存储适配器（浏览器与 Electron 渲染进程用）。
 *
 * 为什么不用 localStorage：P1 之后要存切分后的资料正文与位置映射，
 * 一份 50 页课件就会超过 localStorage 的 5MB 上限，且 localStorage 是同步阻塞的。
 *
 * 每个分区以记录自带的 `id` 作为主键（不用自增 keyPath），
 * 这样导入备份时同一份 id 直接覆盖，不会产生重复记录。
 */
export class IndexedDbStorage implements StorageAdapter {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await this.open();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new Error(
            'IndexedDB 不可用：当前环境没有持久化存储。若在测试中运行，请改用 MemoryStorage。',
          ),
        );
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        // 另一个标签页/窗口升级了库结构，本连接必须让位，否则后续事务全部抛错。
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };

      req.onerror = () => reject(req.error ?? new Error('打开学习库失败'));
      req.onblocked = () =>
        reject(new Error('学习库被其他窗口占用，请关闭其他页面后重试'));
    });
  }

  private async conn(): Promise<IDBDatabase> {
    if (!this.db) await this.init();
    return this.db!;
  }

  /** 把一次 IDB 请求包成 Promise，错误统一转成中文提示 */
  private async run<T>(
    store: StoreName,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.conn();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(store, mode);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(`读取 ${store} 失败`));
      tx.onabort = () => reject(tx.error ?? new Error(`写入 ${store} 被中止`));
    });
  }

  async getAll<K extends StoreName>(store: K): Promise<StoreRecordMap[K][]> {
    return this.run(store, 'readonly', (s) => s.getAll() as IDBRequest<StoreRecordMap[K][]>);
  }

  async get<K extends StoreName>(store: K, id: string): Promise<StoreRecordMap[K] | null> {
    const row = await this.run(store, 'readonly', (s) => s.get(id) as IDBRequest<
      StoreRecordMap[K] | undefined
    >);
    return row ?? null;
  }

  async put<K extends StoreName>(store: K, value: StoreRecordMap[K]): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
  }

  async putMany<K extends StoreName>(store: K, values: StoreRecordMap[K][]): Promise<void> {
    if (values.length === 0) return;
    const db = await this.conn();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      for (const v of values) s.put(v);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(`批量写入 ${store} 失败`));
      tx.onabort = () => reject(tx.error ?? new Error(`批量写入 ${store} 被中止`));
    });
  }

  async remove(store: StoreName, id: string): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  }

  async clear(store: StoreName): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  }

  /**
   * 原子整库替换。
   *
   * 关键：所有分区放进**同一个事务**。IndexedDB 事务是原子的——
   * 任一步失败，整个库回滚到导入前状态，不会留下删了一半的库。
   */
  async replaceAll(snapshot: StoreSnapshot): Promise<void> {
    const db = await this.conn();
    await new Promise<void>((resolve, reject) => {
      // 事务范围必须一次列出全部要动的分区，事后不能再加。
      const tx = db.transaction([...STORES], 'readwrite');

      for (const store of STORES) {
        tx.objectStore(store).clear();
      }
      for (const store of BACKUP_STORES) {
        const target = tx.objectStore(store);
        for (const record of snapshot[store] as { id: string }[]) {
          target.put(record);
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('导入学习库失败，已回滚'));
      tx.onabort = () => reject(tx.error ?? new Error('导入学习库被中止，已回滚'));
    });
  }

  async readAll(): Promise<StoreSnapshot> {
    const out = {} as StoreSnapshot;
    for (const store of BACKUP_STORES) {
      out[store] = (await this.getAll(store)) as never;
    }
    return out;
  }

  /** 应用退出/切库时显式关闭，避免 Electron 重载时被 blocked */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}
