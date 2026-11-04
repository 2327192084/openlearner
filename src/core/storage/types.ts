import type {
  BackendConfig,
  Course,
  Deck,
  KnowledgePoint,
  LibraryMeta,
  Question,
  SettingsRecord,
  SlideDeck,
  Source,
  SourceSegment,
  GenerationRun,
} from '../model.ts';

/** 学习库的存储分区。每个分区是一张「表」。 */
export const STORES = [
  'meta',
  'settings',
  'courses',
  'sources',
  /**
   * 资料的切分正文，单独一张表。
   *
   * 为什么不塞进 Source 记录：一份 50 页课件的片段会到数百条、正文几十万字，
   * 塞进去会让「读资料列表」也拖着全部正文。分开之后列表只读元信息，
   * 阅读器按 sourceId 取需要的段。
   */
  'sourceSegments',
  'knowledgePoints',
  'generationRuns',
  'decks',
  'questions',
  'slideDecks',
  'backends',
  /**
   * 凭据分区：**独立存放，永不进入备份文件**。
   * P5 验收要求「后端配置与登录凭据不出现在导出文件、日志、界面截图中」，
   * 这里从存储层面就把它和可导出数据隔开，而不是靠导出时记得剔除。
   */
  'secrets',
] as const;

export type StoreName = (typeof STORES)[number];

/** 可整库导出/导入的业务分区（不含 secrets）。 */
export const BACKUP_STORES = [
  'courses',
  'sources',
  'sourceSegments',
  'knowledgePoints',
  'generationRuns',
  'decks',
  'questions',
  'slideDecks',
  'backends',
] as const;

export type BackupStoreName = (typeof BACKUP_STORES)[number];

/** 各分区对应的记录类型 */
export interface StoreRecordMap {
  meta: LibraryMeta;
  settings: SettingsRecord;
  courses: Course;
  sources: Source;
  sourceSegments: SourceSegment;
  knowledgePoints: KnowledgePoint;
  generationRuns: GenerationRun;
  decks: Deck;
  questions: Question;
  slideDecks: SlideDeck;
  backends: BackendConfig;
  secrets: SecretRecord;
}

/** 一条凭据。key 与 backendId 关联，但不放在 backends 里。 */
export interface SecretRecord {
  id: string;
  backendId: string;
  /** 凭据本体。只在本机存储层存在。 */
  value: string;
  createdAt: string;
  updatedAt: string;
}

/** 整库快照（导出/导入的中间形态，不含 secrets） */
export type StoreSnapshot = {
  [K in BackupStoreName]: StoreRecordMap[K][];
};

/**
 * 存储适配器契约。
 *
 * 两套实现共用它：
 *  - IndexedDB（浏览器 / Electron 渲染进程，真实持久化）
 *  - 内存（单元测试与流程测试，P2 要求「用假后端也能跑通」的同类思路）
 *
 * 上层用例代码只依赖这个接口，所以换存储不动业务。
 */
export interface StorageAdapter {
  /** 打开/建表。幂等，可重复调用。 */
  init(): Promise<void>;

  getAll<K extends StoreName>(store: K): Promise<StoreRecordMap[K][]>;

  get<K extends StoreName>(store: K, id: string): Promise<StoreRecordMap[K] | null>;

  put<K extends StoreName>(store: K, value: StoreRecordMap[K]): Promise<void>;

  putMany<K extends StoreName>(store: K, values: StoreRecordMap[K][]): Promise<void>;

  remove(store: StoreName, id: string): Promise<void>;

  /** 清空单个分区 */
  clear(store: StoreName): Promise<void>;

  /**
   * 原子地整库替换。
   *
   * 导入备份用它：要么整库换成备份内容，要么什么都不变。
   * 半途失败留下半个库，比导入失败更糟——用户会以为数据还在。
   */
  replaceAll(snapshot: StoreSnapshot): Promise<void>;

  /** 读整库快照（不含 secrets），导备份用 */
  readAll(): Promise<StoreSnapshot>;
}
