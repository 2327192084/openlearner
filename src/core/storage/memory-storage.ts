import { BACKUP_STORES, STORES } from './types.ts';
import type {
  BackupStoreName,
  StorageAdapter,
  StoreName,
  StoreRecordMap,
  StoreSnapshot,
} from './types.ts';

/**
 * 内存存储适配器。
 *
 * 存在的理由不是「省事」，是计划书第 7 节的两条验收要求：
 *  - 单元测试要能跑资料切分与位置映射，不能依赖浏览器
 *  - P2 要求「用假后端也能跑通整个流程，便于测试」
 * 一个纯内存的学习库让这两件事在本机反复跑、不联网、不落盘。
 */
export class MemoryStorage implements StorageAdapter {
  private data = new Map<StoreName, Map<string, unknown>>();

  async init(): Promise<void> {
    if (this.data.size === 0) this.reset();
  }

  private reset(): void {
    this.data = new Map();
    for (const store of STORES) this.data.set(store, new Map());
  }

  private table<K extends StoreName>(store: K): Map<string, StoreRecordMap[K]> {
    let t = this.data.get(store);
    if (!t) {
      t = new Map();
      this.data.set(store, t);
    }
    return t as Map<string, StoreRecordMap[K]>;
  }

  async getAll<K extends StoreName>(store: K): Promise<StoreRecordMap[K][]> {
    return [...this.table(store).values()];
  }

  async get<K extends StoreName>(store: K, id: string): Promise<StoreRecordMap[K] | null> {
    return this.table(store).get(id) ?? null;
  }

  async put<K extends StoreName>(store: K, value: StoreRecordMap[K]): Promise<void> {
    this.table(store).set(value.id, structuredClone(value));
  }

  async putMany<K extends StoreName>(store: K, values: StoreRecordMap[K][]): Promise<void> {
    const t = this.table(store);
    for (const v of values) t.set(v.id, structuredClone(v));
  }

  async remove(store: StoreName, id: string): Promise<void> {
    this.table(store).delete(id);
  }

  async clear(store: StoreName): Promise<void> {
    this.table(store).clear();
  }

  /**
   * 内存实现天然「原子」：先把新数据算好再一次性换掉引用。
   * 中途抛错时旧数据仍然完整，符合 replaceAll 的语义。
   */
  async replaceAll(snapshot: StoreSnapshot): Promise<void> {
    const next = new Map<StoreName, Map<string, unknown>>();
    for (const store of STORES) next.set(store, new Map());

    for (const store of BACKUP_STORES) {
      const table = next.get(store)!;
      for (const record of snapshot[store] as { id: string }[]) {
        table.set(record.id, structuredClone(record));
      }
    }
    // secrets 不参与导入：换库时旧凭据也一并清掉，避免把 A 库的 Key 用到 B 库。
    this.data = next;
  }

  async readAll(): Promise<StoreSnapshot> {
    const out = {} as StoreSnapshot;
    for (const store of BACKUP_STORES) {
      out[store] = (await this.getAll(store)).map((r) => structuredClone(r)) as never;
    }
    return out;
  }

  /** 测试辅助：直接看某分区条数，免得测试里写一堆 getAll().length */
  count(store: StoreName): number {
    return this.table(store).size;
  }
}

export type { BackupStoreName };
