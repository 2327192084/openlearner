/**
 * AI 整理后端的抽象层。
 *
 * ## 为什么要在 P2 就抽这一层
 *
 * 计划书 P2 验收明确要求：「用假后端（固定返回）也能跑通整个流程，便于测试」。
 * 而 P5 要把后端做成可插拔（模型直连 / agent 应用），同一份资料用不同后端
 * 整理、结果并存对比。
 *
 * 所以从第一天就定死接口：调用方只认 `OrganizeBackend`，
 * 不关心背后是 DeepSeek、WorkBuddy 还是写死的假数据。
 * 这样 P5 加后端不需要动任何业务代码。
 */

/** 送进去的一段原文 */
export interface OrganizeInputSegment {
  /** 段 id，用于把模型输出对应回原文 */
  segmentId: string;
  /** 页码/章节序号，仅供模型理解上下文，**不作为输出依据** */
  page: number;
  chapter: string | null;
  text: string;
}

/** 模型返回的一条知识点草稿 */
export interface KnowledgeDraft {
  /** 概念表述 */
  statement: string;
  /**
   * 支撑这条知识点的原文引用（逐字摘自输入文本）。
   *
   * 注意：**这里没有 page 字段**。页码由我们的定位器在真实文本里找出来。
   * 让模型直接说「第 12 页」是不可信的 —— 它看不到分页，只会编。
   */
  quotes: string[];
  /** 认知层级，模型给建议值，用户可以改 */
  cognitiveLevel: 'remember' | 'understand' | 'apply' | 'analyze';
  /** 标签，可空 */
  tags: string[];
}

/** 一次整理请求 */
export interface OrganizeRequest {
  sourceTitle: string;
  segments: OrganizeInputSegment[];
  /** 中途停止的信号：置为 aborted 后后端应尽快返回已产出的部分 */
  signal: AbortSignal;
  /**
   * 逐条产出时回调。
   *
   * 允许返回 Promise，后端应当 await 它：
   * 这样「定位 + 落库 + 推进度」都能在产出当下完成，
   * 用户在进度条上点停止才是真正的中途停止，而不是等全部跑完才生效。
   */
  onDraft?: (draft: KnowledgeDraft) => void | Promise<void>;
}

/** 一次整理结果 */
export interface OrganizeResult {
  drafts: KnowledgeDraft[];
  /** 实际用量（token）。假后端返回估算值 */
  actualTokens: number | null;
  /** 是否因为用户停止而提前结束 */
  stopped: boolean;
}

/**
 * 后端接口。
 *
 * 只需要两个方法：估用量、执行整理。
 * 估用量是为了 P2 要求「生成前显示预计用量」。
 *
 * ## 实现者必须遵守的约定（很重要）
 *
 * `organize()` **必须逐条 await onDraft()**，不能把所有 drafts 攒好再一次性返回。
 * 原因：定位与落库都发生在 onDraft 里，只有逐条等它完成，
 * 「中途停止」才能真的在两条之间生效、已产出的部分才能保留。
 *
 * 反过来，`OrganizeResult.drafts` 只是给调用方一份完整副本用于统计，
 * **不能**作为落库依据 —— 那个路径在停止场景下会漏掉条目。
 */
export interface OrganizeBackend {
  /** 后端标识，存进知识点以便 P5 做多后端对比 */
  readonly id: string;
  /** 界面上显示的名字 */
  readonly label: string;
  /** 这个后端能不能真的联网调用（假后端为 false） */
  readonly isMock: boolean;

  /** 估算用量。生成前显示，避免用户不小心烧掉大量额度。 */
  estimateTokens(segments: OrganizeInputSegment[]): number;

  /** 执行整理 */
  organize(request: OrganizeRequest): Promise<OrganizeResult>;
}
