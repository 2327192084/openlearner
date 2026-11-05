import type { Source, SourceSegment } from '../model.ts';

/**
 * 视觉后端抽象层：把「一页扫描件图片」变成「这一页的文字」。
 *
 * ## 为什么单独抽这层
 *
 * 和 P2 的 `OrganizeBackend` 同一个理由：调用方（OcrService）只认这个接口，
 * 不关心背后是真实的视觉大模型、还是测试里写死的假实现。
 * 这样「逐页渲染 → 调后端 → 写回分段」这条主流程可以用假后端跑通，
 * 不需要测试真的花钱调一次模型。
 *
 * ## 为什么接口只有一页
 *
 * 视觉模型的计费单位是「页」，失败与重试也天然按页。
 * 一次请求塞多页进去，一页失败就整批重来，用户还看不出是哪页坏了。
 * 逐页也更适合「先跑一页看看效果再决定要不要跑整本」这种真实用法。
 */

/** 送给视觉后端的一页 */
export interface VisionPageInput {
  /** `data:image/png;base64,...` 整串，由 renderSourcePage 产出 */
  imageDataUrl: string;
  /** 页码，从 1 开始。只用于告诉模型「这是第几页」和报错定位 */
  pageNo: number;
  /** 这份资料的标题，给模型一点上下文（教材名往往能提示领域术语） */
  sourceTitle: string;
  /** 取消信号：用户中途停止，不该继续为剩下的页付钱 */
  signal?: AbortSignal;
}

/** 单页识别结果 */
export interface VisionPageResult {
  /** 识别出的正文。空字符串表示这一页确实没有可读文字（如整页插图） */
  text: string;
  /** 实际用量（token）。服务端没返回时为 null，**不猜** */
  actualTokens: number | null;
}

/** 一次识别请求的参数 */
export interface VisionBackendOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** 服务商标识，用于报错文案与 JSON 模式兼容性判断 */
  provider?: string;
  /** 用户给这个后端起的名字，用在进度与错误提示里 */
  label?: string;
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 视觉后端契约。
 *
 * 实现者必须遵守：
 *  - 只处理**一页**，不要自作主张跨页合并；
 *  - 不要凭空生成内容。看不清就说看不清 —— OCR 结果会写进
 *    `sourceSegments`，成为「点回原文」的引用底本，编出来的文字会让
 *    后续所有定位都是错的，而且错得很隐蔽。
 */
export interface VisionBackend {
  /** 稳定标识，用于日志与用量统计 */
  readonly id: string;
  /** 界面显示名 */
  readonly label: string;
  /** 是否为假实现（测试用）。真实现为 false */
  readonly isMock: boolean;
  /** 服务商标识，用于用量统计按服务商汇总 */
  readonly provider: string;
  /** 识别一页 */
  extractPage(input: VisionPageInput): Promise<VisionPageResult>;
}

/** 逐页识别的进度快照 */
export interface OcrProgress {
  /** 已完成的页数（含失败的） */
  done: number;
  /** 总页数 */
  total: number;
  /** 当前正在处理的页码 */
  currentPage: number;
  /** 成功识别的页数 */
  succeeded: number;
  /** 失败的页数 */
  failed: number;
  /** 累计 token */
  tokens: number;
}

/** 一页的失败记录 */
export interface OcrPageFailure {
  pageNo: number;
  /** 分类码，便于界面按类型给不同建议 */
  code: string;
  message: string;
  /** 下一步能做什么。失败时必须给，不能只说「失败」 */
  hint: string;
}

/** 一次整篇识别的结果 */
export interface OcrResult {
  /** 写回后的资料（含更新过的 textStatus / segmentCount） */
  source: Source;
  /** 写回后的分段 */
  segments: SourceSegment[];
  /** 成功识别的页数 */
  succeeded: number;
  /** 失败的页，逐页列出 */
  failures: OcrPageFailure[];
  /** 累计 token */
  tokens: number;
  /** 是否因用户停止而提前结束 */
  stopped: boolean;
}

/** 视觉识别失败时抛它，带可操作提示 */
export class OcrError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: string = 'ocr-failed',
  ) {
    super(message);
    this.name = 'OcrError';
  }
}
