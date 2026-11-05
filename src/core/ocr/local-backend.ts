import type { VisionBackend, VisionPageInput, VisionPageResult } from './types.ts';
import { OcrError } from './types.ts';

/**
 * 本地 OCR：tesseract.js，纯离线，不花钱。
 *
 * ## 为什么要有这条路
 *
 * 云端看图模型效果好（能读版面、公式、表格），但**按页计费**。
 * 一本 600 页的教材全跑一遍成本不低，而很多资料只是普通印刷体，
 * 用本地引擎就够了。让用户自己选，而不是替他决定。
 *
 * ## 实测数据（2026-11-06，本机）
 *
 * 用 `src/test/fixtures/course.pdf` 第 1 页渲染成 PNG 后识别：
 *
 * ```
 * 原始: "第 一 章 数据 结构 绪论\n\n数据 结构 研究 的 是 数据 元 素 之 间 的 关系 …"
 * 置信度: 93    耗时: 1374 ms/页
 * ```
 *
 * 准确率够用，但有两个**真实缺陷**，用户必须知道（界面上会明说）：
 *
 * 1. **中文字之间会插空格**。tesseract 按词切分，中文没有词间空格，
 *    于是它在字与字之间补空格。
 * 2. **公式和表格明显变差**。这是 tesseract 的固有短板，不是配置问题。
 *
 * ## 为什么第 1 条不致命
 *
 * 「点回原文」靠 `locator.ts` 的空白归一匹配（三级策略的第二级），
 * 它**剔除**空白而不是压成空格（见该文件 151-166 行的注释）。
 * 全文搜索 `findAllFolded` 同样剔除一切空白。
 * 所以「第 一 章 数 据 结 构」归一后是「第一章数据结构」，
 * 引用与搜索都能命中 —— 这条链路不会被空格破坏。
 *
 * 但我们仍然在写回前**主动收紧**词边界两侧的空格（见 stripCjkSpaces），
 * 因为识别结果会直接显示给用户读，`第 一 章` 读起来是坏的。
 *
 * ## 为什么语言包必须本地打包
 *
 * tesseract.js 默认从 CDN 拉 worker / wasm / 语言包。这在本项目不可接受：
 *  - 项目定位是**纯本地、不联网**，偷偷下载 20MB 违反这个承诺；
 *  - 实测 jsdelivr 在本机不可达（HTTP 000），走 CDN 就是直接失败。
 *
 * 所以三样东西都放 `public/tesseract/`，随构建产物一起分发，
 * 路径用 `resolveAssetBase()` 算 —— 和 pdfjs 的 cmaps 同一套办法，
 * 这样 `file://`（Electron）与 `http://`（浏览器）都能正确解析。
 *
 * ### 两个只有真浏览器才会暴露的坑（都实测踩过）
 *
 * 1. **`core/` 目录必须同时有 `.wasm` 和 `.wasm.js`**。
 *    `.wasm.js` 是 Emscripten 的胶水代码，worker 用 `importScripts` 加载它，
 *    再由它去取真正的 `.wasm`。只复制 `.wasm` 时单元测试（注入假 worker）
 *    全绿，真浏览器里却报
 *    `Failed to execute 'importScripts' … tesseract-core-*.wasm.js failed to load`。
 *
 * 2. **6 个 core 变体一个都不能少**。`getCore.js` 按 CPU 特性四选一：
 *    relaxedsimd → simd → 普通（再按 lstmOnly 各分两路）。
 *    只留其中几个，换台机器就 404。本机（支持 relaxedsimd）实测：
 *    只留 simd 时装不起来。代价是 `core/` 约 43MB —— 这是浏览器离线 OCR 的固有体积。
 */

/** 静态资源根（与 pdfjs 的 cmaps 共用同一套解析逻辑） */
function assetBase(): string {
  if (typeof document === 'undefined') return '';
  try {
    return new URL('./tesseract/', document.baseURI).href;
  } catch {
    return './tesseract/';
  }
}

/**
 * 收紧中文字符之间由分词产生的多余空格。
 *
 * 只动「汉字 空格 汉字」这一种，且只删空格不删字：
 *  - 英文单词之间的空格必须保留（`data structure` 不能变 `datastructure`）；
 *  - 数字与单位之间也保留（`100 MB`）。
 *
 * 前后各保留一个空格的边界情况（`第 一 章` → `第一章`，与 `操作 。` → `操作。`）
 * 都覆盖到了，因为正则两侧都是汉字/中文标点。
 */
export function stripCjkSpaces(text: string): string {
  // 汉字或中文标点之间夹的空格，删掉
  return text.replace(/(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ \t]+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '');
}

/** tesseract 的 worker 接口（只声明我们用到的那几个方法） */
interface TessWorker {
  recognize(image: string | Uint8Array): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

export interface LocalOcrOptions {
  /** 语言，默认简体中文。多语言用 `chi_sim+eng` */
  lang?: string;
  /**
   * 注入 worker 工厂，仅测试用。
   *
   * 真实实现里 tesseract.js 会起 Web Worker + wasm，在 node 单测环境跑不了；
   * 注入假实现才能验「我们这一层的逻辑」（空文本判定、错误翻译、空格收紧）。
   */
  createWorkerImpl?: () => Promise<TessWorker>;
}

export class LocalTesseractBackend implements VisionBackend {
  readonly id = 'local:tesseract';
  readonly label = '本地识别（免费 · 离线）';
  readonly isMock = false;
  readonly provider = 'local';

  private readonly lang: string;
  private readonly createWorkerImpl: (() => Promise<TessWorker>) | undefined;

  /** worker 创建代价高（加载 wasm + 语言包约 1-2 秒），复用同一个 */
  private workerPromise: Promise<TessWorker> | null = null;

  constructor(options: LocalOcrOptions = {}) {
    this.lang = options.lang ?? 'chi_sim';
    this.createWorkerImpl = options.createWorkerImpl;
  }

  private async getWorker(): Promise<TessWorker> {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        if (this.createWorkerImpl) return this.createWorkerImpl();

        // 动态 import：node 单测里不加载，浏览器里才拉这份 1.4MB 的包
        const mod = (await import('tesseract.js')) as unknown as {
          createWorker: (
            lang: string,
            oem?: number,
            opts?: Record<string, unknown>,
          ) => Promise<TessWorker>;
        };

        const base = assetBase();
        return mod.createWorker(this.lang, 1, {
          // 明确指向本地资源：不传这些参数，tesseract.js 会去 CDN 下载
          workerPath: `${base}worker.min.js`,
          corePath: `${base}core`,
          langPath: `${base}lang`,
          gzip: true,
          cacheMethod: 'none',
        });
      })();

      // 创建失败要清掉，否则后续每页都拿到同一个被拒的 Promise
      this.workerPromise.catch(() => {
        this.workerPromise = null;
      });
    }
    return this.workerPromise;
  }

  async extractPage(input: VisionPageInput): Promise<VisionPageResult> {
    if (input.signal?.aborted) {
      throw new OcrError('已停止识别', '已经识别完的页会保留，可以稍后继续剩下的页。', 'aborted');
    }

    if (!input.imageDataUrl.startsWith('data:image/')) {
      throw new OcrError(
        '页面图片的格式不对（不是 data URL）',
        '这是渲染环节的问题，不是你操作错了。请重试一次；若持续出现请反馈。',
        'bad-image',
      );
    }

    let worker: TessWorker;
    try {
      worker = await this.getWorker();
    } catch (err) {
      throw new OcrError(
        '本地识别引擎没能在本机启动',
        '这通常是浏览器不支持 WebAssembly，或静态资源没随应用一起发布。' +
          '可以先改用「看图模型」那条路；若这是打包版本，请反馈这个现象。',
        'engine-unavailable',
      );
    }

    let text: string;
    try {
      const result = await worker.recognize(input.imageDataUrl);
      text = stripCjkSpaces(result.data.text ?? '');
    } catch (err) {
      if (input.signal?.aborted) {
        throw new OcrError('已停止识别', '已经识别完的页会保留，可以稍后继续剩下的页。', 'aborted');
      }
      throw new OcrError(
        `第 ${input.pageNo} 页本地识别失败`,
        '可以只重试这一页；如果整份都失败，建议改用看图模型。',
        'page-failed',
      );
    }

    return {
      text: text.trim(),
      /**
       * 本地识别没有 token 概念。返回 null 而不是编一个数字 ——
       * 用量统计那边「服务端没返回就不记，不猜」的规矩同样适用。
       */
      actualTokens: null,
    };
  }

  /** 释放 worker。整批识别完调用，否则 wasm 内存会一直占着 */
  async dispose(): Promise<void> {
    const p = this.workerPromise;
    this.workerPromise = null;
    if (!p) return;
    try {
      const worker = await p;
      await worker.terminate();
    } catch {
      // 已经失败或已释放，忽略
    }
  }
}
