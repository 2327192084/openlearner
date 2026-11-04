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
export const LIBRARY_SCHEMA_VERSION = 1;

/** 每份资料在库里的位置信息，是「点回原文」的前提（P1/P2 依赖）。 */
export interface SourceLocation {
  /** 资料 id */
  sourceId: string;
  /** 页码（从 1 开始）。按章节切分的资料此值为该章节起始页。 */
  page?: number;
  /** 章节标题（按章节切分时使用） */
  chapter?: string;
  /** 该片段在全文中的字符偏移，用于精确定位高亮 */
  charStart?: number;
  charEnd?: number;
}

/**
 * 资料（教材/课件/讲义/粘贴文本）。
 * P0 只建记录，P1 才做真实的解析与切分。
 */
export interface Source {
  id: string;
  title: string;
  /** 原始文件名，粘贴文本为 null */
  fileName: string | null;
  /** 来源类型；P0 只作为占位信息保存 */
  kind: 'pdf' | 'docx' | 'pptx' | 'markdown' | 'text';
  /** 归属课程，未归类为 null */
  courseId: string | null;
  /** 总页数（未知为 null） */
  pageCount: number | null;
  /** 导入时的字节数（粘贴文本为字符数） */
  byteSize: number;
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
 * 知识点：中间层实体，PPT 与习题都由它派生。
 * P2 才真正生产数据；P0 先把契约定死，避免后续返工。
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
  /** 锚定的原文位置。P2 要求指认不到时**留空等人处理**，不要自动填。 */
  anchors: SourceLocation[];
  /** 原文片段（引用文本），可与 anchors 一一对应 */
  quotes: string[];
  /** 该知识点是教材原文还是网上补充资料 */
  origin: 'material' | 'web';
  createdAt: string;
  updatedAt: string;
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
  knowledgePoints: KnowledgePoint[];
  decks: Deck[];
  questions: Question[];
  slideDecks: SlideDeck[];
  backends: BackendConfig[];
}
