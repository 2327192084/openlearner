import type {
  BackendConfig,
  Course,
  Deck,
  KnowledgePoint,
  LibraryMeta,
  Question,
  SettingsRecord,
  SlideDeck,
  SlideImageRecord,
  Source,
  SourceAnnotation,
  SourceSegment,
  GenerationRun,
  AnswerRecord,
  UsageRecord,
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
  /**
   * 原始文件字节，仅 PDF。
   *
   * 存在的唯一理由：图文页要把原文某一页渲染成图片贴进 PPT，
   * 而 pdfjs 需要拿到原始字节才能渲染。P1 导入时本可以直接丢弃字节
   * （正文已抽成文本），为了这个功能才留下。
   *
   * **刻意不进 BACKUP_STORES**：一份 50 页教材 PDF 二三十 MB，
   * 备份文件会被撑大十几倍，而备份主要是给用户换机器用的。
   * 恢复备份后这些资料的 fileStored 就是 false，界面如实关闭图文页。
   */
  'sourceFiles',
  /**
   * 用户在资料页面上做的注释（画笔笔迹与文本框）。
   *
   * 单独一张表而不是塞进 Source 或 SourceSegment：
   *  - 按「资料 + 页」存，只加载当前页的注释（628 页教材全量加载会拖慢打开）
   *  - 删资料时要级联清理，独立分区才好一次删干净
   *
   * **进备份**：这些是用户自己画的，丢了找不回来 ——
   * 与 sourceFiles 性质不同（那个可以从原文件重新渲染）。
   */
  'sourceAnnotations',
  'knowledgePoints',
  'generationRuns',
  'decks',
  'questions',
  'answerRecords',
  'slideDecks',
  /**
   * 用户插入到 PPT 里的图片。
   *
   * 单独一个分区而不是内嵌进 slideDecks：同一张图可能被用在多页，
   * 内嵌会让 deck 记录成倍变大，而 IndexedDB 单条记录有大小风险。
   * 页面里只存 id（见 SlideOverlay.imageId）。
   *
   * **进备份**：这些是用户自己找来的图，换机器后丢了就找不回来，
   * 与 sourceFiles（可从原文件重新渲染）性质不同。
   */
  'slideImages',
  'backends',
  /**
   * 用量统计（按天 + 后端 + 用途聚合）。
   *
   * 单独一张表的原因：它不该跟着资料一起被删。用户删掉一份资料，
   * 已经花掉的钱不会回来，账单也就不该消失——否则用量页的数字会
   * 莫名其妙变小，看起来像在掩盖花费。
   */
  'usageRecords',
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
  /** 用户手写注释。进备份：这是用户自己画的内容，丢了找不回来 */
  'sourceAnnotations',
  'knowledgePoints',
  'generationRuns',
  'decks',
  'questions',
  'answerRecords',
  'slideDecks',
  /** 用户插入的图片。进备份：这些图用户找不回来，与可从原文件重渲染的 sourceFiles 不同 */
  'slideImages',
  'backends',
  /** 用量统计。进备份：换机器后账单不该归零。只有数字，不含 Key 与请求内容 */
  'usageRecords',
] as const;

export type BackupStoreName = (typeof BACKUP_STORES)[number];

/** 各分区对应的记录类型 */
export interface StoreRecordMap {
  meta: LibraryMeta;
  sourceFiles: SourceFileRecord;
  settings: SettingsRecord;
  courses: Course;
  sources: Source;
  sourceSegments: SourceSegment;
  sourceAnnotations: SourceAnnotation;
  knowledgePoints: KnowledgePoint;
  generationRuns: GenerationRun;
  decks: Deck;
  questions: Question;
  answerRecords: AnswerRecord;
  slideDecks: SlideDeck;
  slideImages: SlideImageRecord;
  backends: BackendConfig;
  usageRecords: UsageRecord;
  secrets: SecretRecord;
}

/**
 * 一份资料的原始字节。
 *
 * 按 sourceId 作主键（id 就是 sourceId），一份资料一条。
 */
export interface SourceFileRecord {
  /** 与 Source.id 相同 */
  id: string;
  /** 文件字节。IndexedDB 能直接存 ArrayBuffer，不转 base64（转码会大 33%） */
  data: ArrayBuffer;
  byteSize: number;
  savedAt: string;
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
