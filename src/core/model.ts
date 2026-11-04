/**
 * 学习库数据模型（P0 只落地骨架需要的部分）
 *
 * 设计约束来自计划书第 2 节：中间层「知识点」是唯一整理结果，
 * PPT 与习题都是它的两种输出。因此 P0 先把这些实体的**外壳**定好，
 * 后续阶段只往里填字段，不改动已有结构的语义。
 *
 * 所有实体都带 id + schemaVersion，导出/导入备份靠它做迁移。
 */

/** 当前学习库结构版本。改动实体结构时递增，并在 migrations.ts 补一段迁移。 */
export const LIBRARY_SCHEMA_VERSION = 3;

/**
 * 位置信息 —— 全项目「点回原文」的唯一依据。
 *
 * 语义在这里必须**精确定义**，因为 P2/P3/P4 全靠它：
 * 指错页比不能跳转更糟，它冒充可信。
 *
 * - `page`：页码，从 1 开始。按页切分的资料（PDF/PPTX）用它；
 *   按章节切分的资料（DOCX/MD）此值为该章节**起始**所占的序号。
 * - `chapter`：章节标题，便于目录跳转与出题时标注范围。
 * - `charStart`/`charEnd`：相对于**该页/该章节文本**（即 SourceSegment.text）的字符偏移，
 *   左闭右开。刻意不用「全文偏移」：全文偏移在重新导入或编辑后会整体错位，
 *   而页内偏移只依赖那一页的文本，稳定得多。
 */
export interface SourceLocation {
  /** 资料 id */
  sourceId: string;
  /** 页码（从 1 开始）。按章节切分的资料此值为该章节起始页/序号。 */
  page?: number;
  /** 章节标题（按章节切分时使用） */
  chapter?: string;
  /** 该片段在**本页/本章文本**中的起始字符偏移（左闭） */
  charStart?: number;
  /** 结束字符偏移（右开） */
  charEnd?: number;
}

/** 资料里的一段可定位文本（一页，或一章）。 */
export interface SourceSegment {
  id: string;
  sourceId: string;
  /** 顺序号，从 1 开始；用于翻页与稳定排序 */
  index: number;
  /** 页码。按章节切分的资料里等于 index */
  page: number;
  /** 所属章节标题，没有则 null */
  chapter: string | null;
  /**
   * 规范化后的正文。
   *
   * 「规范化」指：PDF 里被行尾硬断开的句子已经接回整句（见 parser/normalize.ts），
   * 段落之间用 `\n\n` 分隔。这样全文搜索整句能命中，
   * 而 charStart/charEnd 也直接对应这里，高亮不会错位。
   */
  text: string;
  /** 该段字符数，避免每次搜索都算长度 */
  charCount: number;
}

/** 资料的文本可用状态。扫描件在这里被显式标出来，而不是伪装成「导入成功」。 */
export type SourceTextStatus =
  /** 正常，有可检索的文本层 */
  | 'ready'
  /** 扫描件：没有文本层，文字在图片里。P6 会走看图模型 */
  | 'no-text-layer'
  /**
   * 解码失败：文件里有字（有字体、有绘制指令），但我们取不出来。
   *
   * 和扫描件必须分开：扫描件该让用户换电子版或等 OCR，
   * 解码失败是我们这边的配置/依赖问题，让用户去换文件是推卸责任。
   */
  | 'decode-failed';

/**
 * 资料（教材/课件/讲义/粘贴文本）。
 */
export interface Source {
  id: string;
  title: string;
  /** 原始文件名，粘贴文本为 null */
  fileName: string | null;
  /** 来源类型 */
  kind: 'pdf' | 'docx' | 'pptx' | 'markdown' | 'text';
  /** 归属课程，未归类为 null */
  courseId: string | null;
  /** 总页数（未知为 null） */
  pageCount: number | null;
  /** 导入时的字节数（粘贴文本为字符数） */
  byteSize: number;
  /** 文本可用状态 */
  textStatus: SourceTextStatus;
  /** 切分出的段数，列表页直接显示，不必再查 segments */
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 课程，用于把资料分组（P1 资料库列表依赖）。 */
export interface Course {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

/**
 * 一条知识点的定位状态。
 *
 * 为什么要有这个字段：计划书 P2 第 7 条要求
 * 「指认不到原文位置的条目单独标出来，等人处理，**不要自动填一个位置上去**」。
 * 用一个显式状态把这件事变成数据，而不是靠「anchors 为空」去猜 ——
 * 「用户删掉了锚点」和「AI 给的位置找不到」是两种不同的情况，界面提示也不同。
 */
export type AnchorStatus =
  /** 定位成功，anchors 可用 */
  | 'located'
  /** AI 给了引用文本，但在原文里找不到 → 需要人工处理 */
  | 'unlocated'
  /** 人工确认为「没有出处」（比如模型总结性的话），不再提示 */
  | 'waived';

/**
 * 知识点：中间层实体，PPT 与习题都由它派生。
 *
 * 设计上最重要的一条：**模型不产出页码，只产出原文引用**。
 * 页码由我们在真实段落里定位后写入（见 core/knowledge/locator.ts）。
 * 让模型直接说「第 12 页」是不可信的 —— 它不知道分页在哪，
 * 而指错页比不能跳转更糟，因为它冒充可信。
 */
export interface KnowledgePoint {
  id: string;
  /** 概念表述 —— 会被 PPT 与题目引用 */
  statement: string;
  /** 归属章节 */
  chapter: string | null;
  /** 认知层级，决定出题难度（P3 依赖） */
  cognitiveLevel: 'remember' | 'understand' | 'apply' | 'analyze';
  tags: string[];
  /**
   * 锚定的原文位置。定位失败时**为空数组**，绝不用估算位置填充。
   * 每个 anchor 的 page/charStart/charEnd 都是实测出来的。
   */
  anchors: SourceLocation[];
  /** 原文片段（引用文本），与 anchors 一一对应 */
  quotes: string[];
  /** 定位状态，决定界面上是否要标红提醒人工处理 */
  anchorStatus: AnchorStatus;
  /** 该知识点是教材原文还是网上补充资料 */
  origin: 'material' | 'web';
  /** 来源资料（P2 生成时记录，便于回溯与重新定位） */
  sourceId: string | null;
  /** 生成这批知识点用的后端 id，便于 P5「多后端结果并存对比」 */
  backendId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一次生成任务的元信息。
 *
 * 单独存一张表而不是塞进 source：一次生成可能跨多份资料（后期），
 * 而且「中途停止」要求已产出的部分保留，需要一个地方记录这次跑到哪。
 */
export interface GenerationRun {
  id: string;
  /** 归属资料（P2 阶段一次只处理一份） */
  sourceId: string;
  /** 页码范围，null 表示整份 */
  pageRange: { from: number; to: number } | null;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  /** 预计用量（token），生成前显示 */
  estimatedTokens: number | null;
  /** 实际用量，生成后显示 */
  actualTokens: number | null;
  /** 产出的知识点条数 */
  producedCount: number;
  /** 定位失败的条数，便于界面直接提示 */
  unlocatedCount: number;
  /** 失败原因（status === 'failed' 时） */
  error: string | null;
  /** 用的后端 */
  backendId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 习题集。P3 实现，P0 只占位。 */
export interface Deck {
  id: string;
  title: string;
  courseId: string | null;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
}

/** 单道题目。P3 实现，P0 只占位。 */
export interface Question {
  id: string;
  deckId: string;
  kind: 'single' | 'multiple' | 'blank' | 'essay';
  prompt: string;
  /** 答案、解析、出处（出处必填，P3 验收要求题题可点通） */
  answer: string;
  explanation: string;
  anchors: SourceLocation[];
  createdAt: string;
}

/** 学习 PPT。P4 实现，P0 只占位。 */
export interface SlideDeck {
  id: string;
  title: string;
  courseId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * AI 后端配置。
 *
 * 安全要求（计划书 P5 验收）：凭据不得出现在导出文件、日志、界面截图中。
 * 因此 apiKey 单独存于 `secrets` 存储区，**永不进入备份文件**。
 */
export interface BackendConfig {
  id: string;
  /** 用户可读名称 */
  label: string;
  /** 后端类型：模型 API 直连 / agent 应用接入 */
  kind: 'direct-api' | 'agent-app';
  /** direct-api 的服务商标识，如 deepseek / openai-compatible */
  provider: string;
  /** API 基址（direct-api 使用） */
  baseUrl: string;
  /** 默认模型名 */
  model: string;
  /** 该后端自报支持的能力（P5 要求调用前就告知） */
  capabilities: {
    textOrganize: boolean;
    visionFormula: boolean;
    webSearch: boolean;
  };
  /** 当前可用状态（P5 要求调用前告知，不做「点了才发现不能用」） */
  status: 'ready' | 'unconfigured' | 'needs-login' | 'expired';
  /** 是否为当前默认后端 */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 应用设置（与学习库一起导出，但不含任何凭据）。 */
export interface AppSettings {
  /** 界面语言，P0 固定 zh-CN */
  locale: 'zh-CN';
  /** 默认出题语言 */
  questionLanguage: 'zh' | 'en';
  /** 是否已看过首次引导 */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  questionLanguage: 'zh',
  onboarded: false,
};

/**
 * 存储层里的设置记录。
 *
 * 设置本身是一个单例，但所有分区都以 `id` 为主键（导入备份时靠它覆盖），
 * 所以这里显式带上 id，而不是在存储代码里到处 as 断言。
 */
export interface SettingsRecord extends AppSettings {
  id: string;
}

/**
 * 学习库元信息。
 * 一个学习库 = 一个可整体导出/导入的单元（P0 交付要求）。
 */
export interface LibraryMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

/**
 * 备份文件结构。
 *
 * 刻意**不包含** secrets：凭据不进导出文件是 P5 的硬性验收项。
 */
export interface LibraryBackup {
  /** 固定标记，导入时校验，防止误传其他 JSON */
  format: 'openleaner-library';
  schemaVersion: number;
  exportedAt: string;
  meta: LibraryMeta;
  settings: AppSettings;
  courses: Course[];
  sources: Source[];
  /** 切分后的正文。跟资料一起备份，否则恢复后「点回原文」全失效 */
  sourceSegments: SourceSegment[];
  knowledgePoints: KnowledgePoint[];
  /** 生成任务记录。跟知识点一起备份，否则恢复后看不到「这批是哪次跑的、花了多少」 */
  generationRuns: GenerationRun[];
  decks: Deck[];
  questions: Question[];
  slideDecks: SlideDeck[];
  backends: BackendConfig[];
}
