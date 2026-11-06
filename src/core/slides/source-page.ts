import { isBrowser, loadPdfjs, resolveAssetBase } from '../parsers/pdf.ts';

/**
 * 把 PDF 的某一页渲染成图片，供图文页使用。
 *
 * ## 为什么不从 PDF 里抽「插图」
 *
 * 直觉做法是找出教材里的插图对象贴进 PPT。但 scripts/probe-figures.ts
 * 实测过：文字型教材（我们的主要输入）每页的内嵌位图是 **0 张** ——
 * 章节示意图基本都是矢量绘制，而唯一有位图的扫描件是整页一张图。
 * 也就是说「抽插图」在真实教材上抽不到东西，做出来的图文页会是空的。
 *
 * 渲染整页则总能成功，而且它正好答上了本项目最要紧的那个问题：
 * 学生看到的图和原文是同一页，旁边写着「第 N 页」，翻书就能对上。
 *
 * ## 为什么用 PNG 而不是 JPEG
 *
 * 教材页面里全是文字和小字号公式。JPEG 在文字边缘会产生振铃，
 * 放大到投影尺寸后糊成一团；PNG 无损，代价只是文件大一些。
 * 页面截图本身颜色少（黑白为主），PNG 压得其实不差。
 */

/** 渲染出来的页面图 */
export interface RenderedPage {
  /** `data:image/png;base64,...`，pptxgenjs 与 <img> 都直接收这个格式 */
  imageData: string;
  /** 像素宽 */
  width: number;
  /** 像素高 */
  height: number;
}

/**
 * 渲染目标宽度（像素）。
 *
 * 选 1400 的依据：图文页里图片最宽占 7 英寸左右，1400 / 7 = 200 DPI，
 * 投影或放大到全屏都不虚；再高只会让备份文件白白变大
 * （A4 页面按 1400 宽约 0.3~0.6MB，2000 宽会翻倍，肉眼在投影上看不出差别）。
 */
export const FIGURE_TARGET_WIDTH = 1400;

/** 渲染宽度上限，防止有人把 targetWidth 传成 20000 把内存打爆 */
const MAX_TARGET_WIDTH = 3000;

/** 画布的最小抽象：只要能画出图并导出 PNG 就够，便于在 Node 里注入假实现 */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

/** 创建一个画布。浏览器用 document.createElement，测试可注入。 */
export type CanvasFactory = (width: number, height: number) => CanvasLike;

export interface RenderPageOptions {
  /** 目标宽度像素，默认 FIGURE_TARGET_WIDTH */
  targetWidth?: number;
  /** 取消信号：用户在渲染时切走了，不该继续占 CPU */
  signal?: AbortSignal;
  /** 测试注入的画布工厂 */
  canvasFactory?: CanvasFactory;
}

/** 渲染失败时抛它，带可操作提示 */
export class RenderPageError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'RenderPageError';
  }
}

/**
 * 渲染 PDF 的第 `page` 页（从 1 开始）。
 *
 * @param fileData PDF 原始字节
 * @param page 页码，从 1 开始
 */
export async function renderSourcePage(
  fileData: Uint8Array,
  page: number,
  opts: RenderPageOptions = {},
): Promise<RenderedPage> {
  if (!Number.isInteger(page) || page < 1) {
    throw new RenderPageError(
      `页码无效（${page}）`,
      '请重新选择要插入的那一页',
    );
  }

  const factory = opts.canvasFactory ?? defaultCanvasFactory();

  const pdfjs = await loadPdfjs();
  const assetBase = resolveAssetBase();

  // 注意：legacy 构建的 PDFDocumentProxy 没有 destroy()，
  // 必须留着 loadingTask 才能释放 worker（用错会报 pdf.destroy is not a function）
  const loadingTask = pdfjs.getDocument({
    // 复制一份：pdfjs 会接管这块内存（Transferable），和正在用的 Uint8Array 共享
    // buffer 时，渲染完那段数据就废了，用户再翻原文会得到乱码
    data: new Uint8Array(fileData),
    useSystemFonts: true,
    disableFontFace: false,
    useWorkerFetch: false,
    ...(assetBase
      ? {
          cMapUrl: `${assetBase}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assetBase}standard_fonts/`,
          /**
           * JBIG2 / JPX / ICC 的解码器是 wasm，pdfjs 6 **必须**显式给 wasmUrl。
           *
           * 不给的后果极其隐蔽：控制台只有一行
           *   "Ensure that the `wasmUrl` API parameter is provided."
           * 然后 `getOperatorList - ignoring XObject: JBig2 failed to initialize`
           * —— 图像被**静默跳过**，页面渲染成一张纯白图，
           * 不抛错、不显示任何提示。
           *
           * 这个坑的表现就是「PDF 只能看前两页」：用户那份教材前两页是
           * DCTDecode（JPEG，纯 JS 可解），第 3 页起 597 页都是 JBIG2，
           * 于是全部渲染成白板。DOM 检查、尺寸检查、PNG 有效性检查全都「通过」，
           * 只有真的采样像素（nonWhiteRatio=0）才能发现。
           */
          wasmUrl: `${assetBase}wasm/`,
        }
      : {}),
  });

  try {
    const doc = await loadingTask.promise;

    if (page > doc.numPages) {
      throw new RenderPageError(
        `这份 PDF 只有 ${doc.numPages} 页，没有第 ${page} 页`,
        '请确认页码后重试。页码从 1 开始',
      );
    }

    throwIfAborted(opts.signal);

    const pdfPage = await doc.getPage(page);
    const baseViewport = pdfPage.getViewport({ scale: 1 });

    const targetWidth = clampWidth(opts.targetWidth ?? FIGURE_TARGET_WIDTH);
    const scale = targetWidth / baseViewport.width;
    const viewport = pdfPage.getViewport({ scale });

    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    const canvas = factory(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new RenderPageError(
        '无法创建画布上下文，页面渲染失败',
        '请换用桌面版或较新的浏览器；如果坚持要这一页，可以截图后手动插入',
      );
    }

    // 白底：PDF 页面本身是透明的，直接导出会得到黑底图
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    /**
     * ⚠️ 关键：只传 `canvasContext`，并把 `canvas` 显式设为 null。
     *
     * pdfjs 6 的文档写明：
     *   "If the context must absolutely be used to render the page,
     *    the canvas must be null."
     *
     * 一旦同时传了 `canvas`，pdfjs 会**忽略** `canvasContext`，
     * 自己从 canvas 上取一个新的 2D context 去画。而我们在外面
     * 用的是 `ctx` 引用 —— 于是 `canvas.toDataURL()` 拿到的是
     * 我们自己填的白底，页面内容根本没画上来。
     *
     * 表现：图有、尺寸对、PNG 有效（47KB），但整张全白。
     * 这个坑特别隐蔽 —— 所有 DOM 检查都会「通过」，
     * 只有真的去采样像素才能发现（nonWhiteRatio = 0）。
     */
    await pdfPage.render({
      canvas: null,
      canvasContext: ctx,
      viewport,
    }).promise;

    throwIfAborted(opts.signal);

    const imageData = canvas.toDataURL('image/png');
    if (!imageData || !imageData.startsWith('data:image/png')) {
      throw new RenderPageError(
        '页面渲染完成但导出图片失败',
        '可能是内存不足。请关掉其他标签页后重试，或换一页',
      );
    }

    return { imageData, width, height };
  } finally {
    // 无论成功失败都要释放，否则每渲染一页就泄漏一个 worker
    await loadingTask.destroy().catch(() => {});
  }
}

/** 宽度夹到合理区间：太小的图贴进 PPT 是马赛克，太大只占内存 */
function clampWidth(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return FIGURE_TARGET_WIDTH;
  return Math.min(Math.round(w), MAX_TARGET_WIDTH);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // AbortSignal 的 abort 事件对「已经发生过的取消」不会再触发，
    // 所以必须主动查一次状态，否则用户点了取消，渲染照跑、内存照占
    throw new DOMException('渲染已取消', 'AbortError');
  }
}

/**
 * 默认画布工厂。
 *
 * Node（单测/脚本）里没有 document，直接报可操作的错误 ——
 * 而不是让调用方拿到一个奇怪的 TypeError。
 */
function defaultCanvasFactory(): CanvasFactory {
  if (!isBrowser()) {
    throw new RenderPageError(
      '当前环境不能渲染页面图片（没有浏览器画布）',
      '页面渲染只在应用界面里可用。命令行脚本请改用 scripts/ 下的验证脚本',
    );
  }
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}
