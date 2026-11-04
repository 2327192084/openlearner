import type { Source } from '../model.ts';

/**
 * 解析层的统一契约。
 *
 * 所有格式的解析结果都收敛成 `ParsedDocument`，上层（导入用例、阅读器）
 * 只认这一个形状 —— 加新格式（PDF/DOCX/PPTX/HTML/EPUB）不需要动界面。
 */

/** 解析出的一个段（对应 SourceSegment 的内容部分，不含 id/sourceId） */
export interface ParsedSegment {
  /** 顺序号，从 1 开始 */
  index: number;
  /** 页码；按章节切分的资料等于 index */
  page: number;
  /** 章节标题，没有则 null */
  chapter: string | null;
  /** 规范化后的正文 */
  text: string;
}

export interface ParsedDocument {
  /** 建议的标题（一般取文件名去扩展名） */
  title: string;
  /** 总页数/总段数 */
  pageCount: number;
  segments: ParsedSegment[];
  /**
   * 文本可用状态。
   * 扫描件在这里就是 'no-text-layer'，而不是抛错 ——
   * 它是**可导入**的（用户能翻着 OCR 前的图片看），只是不能搜索与出题。
   * 把它当失败会让用户以为文件坏了。
   */
  textStatus: Source['textStatus'];
}

/**
 * 导入失败的分类。
 *
 * 计划书 P1 明确要求：「导入失败给明确原因（格式不支持/文件损坏/有密码），
 * 不要只说失败」。所以这里把原因做成**枚举 + 可操作提示**，
 * 而不是抛一个 message 字符串让界面自己猜该怎么显示。
 */
export type ImportFailureCode =
  | 'unsupported-format'
  | 'corrupted'
  | 'encrypted'
  | 'empty'
  | 'too-large'
  | 'unknown';

export class ImportError extends Error {
  constructor(
    readonly code: ImportFailureCode,
    message: string,
    /** 下一步能做什么。界面必须显示它，不允许只显示 message。 */
    readonly hint: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** 各类失败的默认提示语。集中在一处，保证六种格式说法一致。 */
export const IMPORT_HINTS: Record<ImportFailureCode, string> = {
  'unsupported-format':
    '目前支持 PDF、Word（.docx）、PPT（.pptx）、Markdown、纯文本。其他格式请先另存为这些之一。',
  corrupted: '文件可能不完整或已损坏。请用原软件重新打开确认能正常显示，再另存一份后导入。',
  encrypted: '这份文件设了密码。请先用原软件去掉密码保护（另存为不加密的副本）再导入。',
  empty: '文件里没有可读取的内容。如果是空白文档，请确认导出时内容确实写进去了。',
  'too-large': '文件超过单份 200 MB 的上限。请拆分后再导入，或先压缩其中的图片。',
  unknown: '导入时遇到未预期的问题。可以换一份文件试试；若持续出现，请记下文件名反馈。',
};

/** 统一的失败构造，保证 hint 一定被填上 */
export function importError(
  code: ImportFailureCode,
  message: string,
  hint?: string,
): ImportError {
  return new ImportError(code, message, hint ?? IMPORT_HINTS[code]);
}

/** 单份资料上限 200MB：再大的 PDF 在浏览器里解析会卡死主线程 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
