import type { Source } from '../model.ts';
import type { SourceService, WriteSegmentInput } from '../sources.ts';
import { OcrError } from './types.ts';
import type {
  OcrPageFailure,
  OcrProgress,
  OcrResult,
  VisionBackend,
} from './types.ts';

/**
 * OCR 服务：把一份扫描件资料逐页渲染成图片、交给视觉后端识别、
 * 再把结果写回分段与 textStatus。
 *
 * ## 它解决的是哪个具体问题
 *
 * 设置页有三个能力勾选框（文字整理 / 看图识公式 / 联网检索），
 * 但 core 里一次都没有读过它们 —— 用户勾上「看图识公式」，
 * 扫描件依然无法处理，而且没有任何提示。假开关比没有开关更糟。
 *
 * 这个类是「看图识公式」那条链路的核心：勾选框 → 选到带
 * visionFormula 的后端 → 这里逐页识别 → 分段里有字了 →
 * 资料页的搜索、整理知识点、出题才真正可用。
 *
 * ## 为什么依赖注入 renderPage 和 vision
 *
 * 渲染要用 pdfjs + canvas，测试里没有 DOM；真实模型要花钱、要联网。
 * 两个都做成注入，主流程（逐页循环、失败处理、进度、写回）
 * 就能用假实现完整跑通 —— 和 P2 用假后端跑通整理流程同一个思路。
 * 否则这条链路上最要紧的逻辑（一页失败要不要继续、中途停止保不保留）
 * 会变成只有真花钱调用时才验证得到。
 *
 * ## 失败策略：单页失败不放弃整本
 *
 * 一本 600 页的教材跑到第 400 页因为一次网络抖动整本重来，
 * 是在烧用户的钱。所以逐页 try/catch：失败的页记进 failures、
 * 继续下一页，最后如实报「成功 N 页、失败 M 页、哪几页」。
 * 已经识别出来的页一定会写回 —— 半本可用的资料比零更有价值。
 */

/** 渲染一页的函数签名（默认用 renderSourcePage，测试可注入假实现） */
export type RenderPageFn = (
  fileData: Uint8Array,
  page: number,
  opts?: { targetWidth?: number; signal?: AbortSignal },
) => Promise<{ imageData: string; width: number; height: number }>;

export interface OcrServiceOptions {
  sources: SourceService;
  /** 视觉后端。可以是 ModelVisionBackend，也可以是测试用的假实现 */
  vision: VisionBackend;
  /** 渲染函数。默认 renderSourcePage；注入是为了测试不依赖 pdfjs/canvas */
  renderPage?: RenderPageFn;
  /** 逐页进度回调。界面据此画进度条 */
  onProgress?: (progress: OcrProgress) => void;
}

/** 识别时的可选项 */
export interface OcrRunOptions {
  /** 只识别这些页（默认全部）。页码从 1 开始 */
  pages?: number[];
  /** 取消信号：已识别的页会保留 */
  signal?: AbortSignal;
  /** 渲染宽度。默认沿用图文页的 1400 */
  targetWidth?: number;
}

/** 识别一份资料所需的前置检查结果 */
export interface OcrPrecheck {
  ok: boolean;
  /** 不可识别的具体原因 */
  reason?: string;
  /** 下一步能做什么 */
  hint?: string;
}

/**
 * 判断一份资料现在能不能走 OCR。
 *
 * ## 为什么要在花钱之前先检查
 *
 * 计划书从 P1 起就要求「不做点了才发现不能用」，而 OCR 是**按页计费**的：
 * 让用户在没有原始文件、或后端根本不支持看图的情况下跑一遍，
 * 花掉的钱换不回任何东西。所以入口点之前先把条件讲清楚。
 */
export function checkOcrReadiness(
  source: Source,
  vision: { provider: string; model?: string } | null,
): OcrPrecheck {
  if (source.kind !== 'pdf') {
    return {
      ok: false,
      reason: `「${source.title}」不是 PDF，没有可以逐页渲染的原始页面`,
      hint: '看图识别只支持 PDF 扫描件。docx/pptx 的文字本身就能直接读，不需要这一条路。',
    };
  }

  if (!source.fileStored) {
    return {
      ok: false,
      reason: `「${source.title}」的原始文件不在本机，无法渲染出页面图片`,
      hint:
        '原始文件只在导入 PDF 时才会留下，且不进备份文件。' +
        '换过机器或恢复过备份的资料需要重新导入一次这份 PDF。',
    };
  }

  if (!vision) {
    return {
      ok: false,
      reason: '还没有可用的看图后端',
      hint:
        '请到设置页添加一个支持看图的模型（如智谱 glm-4v、通义 qwen-vl-max、OpenAI gpt-4o），' +
        '并勾上「看图识公式」。',
    };
  }

  return { ok: true };
}

export class OcrService {
  private readonly sources: SourceService;
  private readonly vision: VisionBackend;
  private readonly renderPage: RenderPageFn;
  private readonly onProgress: ((progress: OcrProgress) => void) | undefined;

  constructor(options: OcrServiceOptions) {
    this.sources = options.sources;
    this.vision = options.vision;
    this.renderPage = options.renderPage ?? defaultRenderPage;
    this.onProgress = options.onProgress;
  }

  /**
   * 识别一份资料，并把结果写回分段。
   *
   * @returns 写回后的资料、分段、成功/失败页数。资料不存在时返回 null。
   */
  async run(sourceId: string, options: OcrRunOptions = {}): Promise<OcrResult | null> {
    const source = await this.sources.get(sourceId);
    if (!source) return null;

    const precheck = checkOcrReadiness(source, { provider: this.vision.provider });
    if (!precheck.ok) {
      throw new OcrError(
        precheck.reason ?? '这份资料现在不能做看图识别',
        precheck.hint ?? '请先确认资料与后端配置。',
        'not-ready',
      );
    }

    const fileData = await this.sources.getOriginalFile(sourceId);
    if (!fileData || fileData.byteLength === 0) {
      /**
       * fileStored 说 true 但读不出字节：备份恢复或旧版本留下的不一致。
       * 不能静默当成「0 页完成」，那会让用户以为识别过了。
       */
      throw new OcrError(
        `「${source.title}」的原始文件读不出来（记录说已保存，实际是空的）`,
        '这份资料的原始字节不完整，请重新导入一次这份 PDF。',
        'missing-file',
      );
    }

    const totalPages = source.pageCount ?? 0;
    const targets = normalizePages(options.pages, totalPages);

    const failures: OcrPageFailure[] = [];
    const written: WriteSegmentInput[] = [];
    let succeeded = 0;
    let tokens = 0;
    let stopped = false;

    const report = (currentPage: number): void => {
      this.onProgress?.({
        done: succeeded + failures.length,
        total: targets.length,
        currentPage,
        succeeded,
        failed: failures.length,
        tokens,
      });
    };

    report(targets[0] ?? 1);

    for (const pageNo of targets) {
      if (options.signal?.aborted) {
        stopped = true;
        break;
      }

      try {
        const rendered = await this.renderPage(fileData, pageNo, {
          ...(options.targetWidth !== undefined ? { targetWidth: options.targetWidth } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });

        const result = await this.vision.extractPage({
          imageDataUrl: rendered.imageData,
          pageNo,
          sourceTitle: source.title,
          ...(options.signal ? { signal: options.signal } : {}),
        });

        if (result.actualTokens !== null) tokens += result.actualTokens;

        /**
         * 空页**不算失败**，也不写空段。
         *
         * 整页插图、章节扉页确实没有字，这是正常的一页。
         * 但如果整本都是空的，那就是识别没成功 —— 那个判断放在最后
         * 统一做，因为单页看起来「正常空白」和「后端返回不了字」
         * 在这里分不开。
         */
        if (result.text.trim()) {
          written.push({ page: pageNo, chapter: null, text: result.text });
          succeeded += 1;
        }
      } catch (err) {
        // 用户主动停止不是失败，不该记进 failures 吓人
        if (options.signal?.aborted || (err instanceof OcrError && err.code === 'aborted')) {
          stopped = true;
          break;
        }
        failures.push(toPageFailure(err, pageNo));
      }

      report(pageNo);
    }

    /**
     * 一页都没识别出来时，不能把 textStatus 写成 ready。
     *
     * 那会让资料页显示「正常」，而正文是空的 —— 用户点开搜索、
     * 整理知识点都拿不到东西，却看不出为什么。如实保留原状态并报错，
     * 是这里唯一诚实的选择。
     */
    if (written.length === 0) {
      const detail =
        failures.length > 0
          ? failures
              .slice(0, 3)
              .map((f) => `第 ${f.pageNo} 页：${f.message}`)
              .join('；')
          : '后端对每一页都返回了空文本';
      throw new OcrError(
        `没有识别出任何文字（${detail}）`,
        failures[0]?.hint ?? '请确认这份 PDF 确实是扫描件，且后端填的是多模态模型。',
        'no-text-recognized',
      );
    }

    /**
     * 写回分两种，按「是否整篇」区分 —— 这是关键。
     *
     * - **整篇识别**（没传 pages，或 pages 覆盖了所有页）：整份替换，
     *   把旧的空段清掉，不留「前几页是空的」脏数据。
     * - **局部识别**（用户点「只识别第 1 页」看效果）：按页合并，
     *   未识别的页原样保留。否则 628 页的资料识别 1 页后只剩 1 段，
     *   其余 627 页的页码与目录全没了，用户再也翻不回去 —— 那是数据损失。
     *
     * 两种语义都是真实需求：整篇跑完该清爽，局部试跑不该破坏可翻性。
     */
    const isWholeDocument = targets.length >= totalPages || !options.pages;
    const segments = [...written].sort((a, b) => a.page - b.page);

    const saved = isWholeDocument
      ? await this.sources.writeSegments(sourceId, segments, 'ready')
      : await this.sources.mergeSegments(sourceId, segments, 'ready');

    if (!saved) {
      throw new OcrError(
        '识别完成但没能写回资料（资料可能已被删除）',
        '请刷新页面确认这份资料还在，然后重试。',
        'write-failed',
      );
    }

    return {
      source: saved.source,
      segments: saved.segments,
      succeeded,
      failures,
      tokens,
      stopped,
    };
  }
}

/**
 * 默认渲染实现：懒加载真实的 renderSourcePage。
 *
 * 用动态 import 而不是顶层 import：pdfjs 与 canvas 只有浏览器里才有，
 * 测试环境导入本模块时不该把它们一起拖进来。
 */
const defaultRenderPage: RenderPageFn = async (fileData, page, opts) => {
  const { renderSourcePage } = await import('../slides/source-page.ts');
  return renderSourcePage(fileData, page, opts ?? {});
};

/** 把调用方给的页码收拢成「有效、去重、升序」的列表 */
function normalizePages(pages: number[] | undefined, total: number): number[] {
  if (!pages || pages.length === 0) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const valid = pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= total);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/** 把任意错误转成一页的失败记录，保证一定带 hint */
function toPageFailure(err: unknown, pageNo: number): OcrPageFailure {
  if (err instanceof OcrError) {
    return {
      pageNo,
      code: err.code,
      message: err.message,
      hint: err.hint,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    pageNo,
    code: 'ocr-failed',
    message,
    hint: '这一页识别失败，其他页不受影响。可以稍后单独重试这一页。',
  };
}
