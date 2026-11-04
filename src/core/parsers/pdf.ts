import { groupLinesIntoBlocks, blocksToText, looksLikeNoText } from './normalize.ts';
import type { TextLine } from './normalize.ts';
import { importError } from './types.ts';
import type { ParsedDocument, ParsedSegment } from './types.ts';

/**
 * PDF 解析：按页切分，逐页取文本。
 *
 * 分工：本文件只负责「把一页的取词结果变成一个段」，
 * 规范化（接回被硬断的句子、分块）交给 normalize.ts。
 * 这样位置映射的单元测试可以完全不碰 pdfjs。
 */

/** pdfjs 的 TextItem 里我们真正用到的字段（避免依赖其完整类型） */
interface PdfTextItem {
  str: string;
  transform: number[];
  height: number;
  width: number;
}

/** 判断一个 item 是不是有文字的真 item（TextMarkedContent 没有 str） */
function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof (item as { str: unknown }).str === 'string'
  );
}

/**
 * 把 pdfjs 一页的 items 转成带位置的行。
 *
 * 为什么按 y 聚类而不是直接用 item 顺序：
 * PDF 里 item 的绘制顺序和阅读顺序不一定一致（尤其分栏、表格、页眉），
 * 直接拼接会出现「页眉的文字插在正文中间」。按 y 聚类再从上到下排，
 * 至少对单栏讲义是稳的 —— 而单栏讲义正是学生课件的主流形态。
 */
export function itemsToLines(items: PdfTextItem[]): TextLine[] {
  const rows = new Map<string, TextLine>();

  for (const item of items) {
    if (!item.str) continue;
    // y 取整到 1 位小数作为行 key：同一行的 item 基线可能差 0.1
    const y = Math.round(item.transform[5] * 10) / 10;
    const x = item.transform[4];
    const key = String(y);

    const existing = rows.get(key);
    if (existing) {
      // 同一行内按 x 从左到右追加
      existing.text += item.str;
      existing.x = Math.min(existing.x, x);
    } else {
      rows.set(key, {
        text: item.str,
        x,
        y,
        height: item.height || 12,
      });
    }
  }

  // 从上到下
  return [...rows.values()].sort((a, b) => b.y - a.y);
}

/**
 * 解析一份 PDF。
 *
 * @param data 原始字节
 * @param onProgress 逐页回调，用于导入进度（P2 会复用同一条链路）
 */
export async function parsePdf(
  data: Uint8Array,
  options: {
    title?: string;
    onProgress?: (done: number, total: number) => void;
    /** 注入 pdfjs，便于测试不依赖真实库 */
    pdfjs?: typeof import('pdfjs-dist');
  } = {},
): Promise<ParsedDocument> {
  // 魔数校验：先确认这确实是 PDF，再交给 pdfjs。
  // 否则 pdfjs 对随机字节会抛「Invalid PDF structure」这类对用户无意义的错。
  const header = new TextDecoder('latin1').decode(data.subarray(0, 5));
  if (!header.startsWith('%PDF-')) {
    throw importError('corrupted', '这个文件不是有效的 PDF（缺少 PDF 文件头）');
  }

  const pdfjs = options.pdfjs ?? (await loadPdfjs());

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      useSystemFonts: true,
      // 不从网络取字体/CMap，避免离线环境卡住
      disableFontFace: false,
      useWorkerFetch: false,
    }).promise;
  } catch (err) {
    throw classifyPdfError(err);
  }

  const total = doc.numPages;
  const segments: ParsedSegment[] = [];
  let meaningfulChars = 0;

  try {
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // TextMarkedContent 没有 str，过滤掉。
      // 这里用显式 filter + map 而不是类型守卫，是因为 pdfjs 的
      // TextItem 要求 dir/fontName/hasEOL 等我们用不到的字段，
      // 自定义接口无法成为它的子类型，守卫会被 TS 拒绝。
      const items: PdfTextItem[] = content.items
        .filter((it) => isTextItem(it))
        .map((it) => {
          const t = it as PdfTextItem;
          return { str: t.str, transform: t.transform, height: t.height, width: t.width };
        });

      const lines = itemsToLines(items);
      const blocks = groupLinesIntoBlocks(lines);
      const text = blocksToText(blocks);

      meaningfulChars += text.replace(/\s/g, '').length;
      segments.push({
        index: i,
        page: i,
        chapter: detectChapter(blocks.map((b) => b.text), text),
        text,
      });

      options.onProgress?.(i, total);
      // 让出主线程，避免大文件把界面卡死（浏览器里 pdfjs 是纯 JS 解析）
      await yieldToEventLoop();
    }
  } finally {
    // pdfjs v6 的类型定义里没有 destroy()，但运行时存在。
    // 用可选调用：即使某个版本没有，也不该让清理逻辑抛错盖掉真正的错误。
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }

  // 扫描件判定：整份都没有文本层才算，不是逐页判。
  // 一份混合文档（部分页有文字）仍然可用，只是那些页搜不到。
  const textStatus = looksLikeNoText(segments.map((s) => s.text).join('')) 
    ? 'no-text-layer'
    : 'ready';

  return {
    title: options.title ?? '未命名资料',
    pageCount: total,
    segments,
    textStatus,
  };
}

/**
 * 从一页的块里猜章节标题。
 *
 * 只做低风险的启发：第一行短、且不含句号结尾，就当作章节名。
 * 猜错代价很低（仅用于目录显示），猜不到就 null —— 绝不因此丢内容。
 */
function detectChapter(blockTexts: string[], fullText: string): string | null {
  const first = blockTexts[0]?.trim();
  if (!first) return null;
  if (first.length > 40) return null;
  if (/[。；，、]$/.test(first)) return null;
  // 只在这行确实是全文开头时才当章节，避免把正文首句误判成标题
  if (!fullText.trimStart().startsWith(first)) return null;
  return first;
}

/**
 * 把 pdfjs 的报错翻译成用户看得懂的原因。
 *
 * pdfjs 的原始报错（"Invalid PDF structure."）对用户没有信息量，
 * 而「有密码」和「文件坏了」对用户来说是完全不同的下一步。
 *
 * 实测补充：pdfjs 对损坏文件抛的是 `InvalidPDFException`，
 * 且 message 末尾**带句点**（"Invalid PDF structure."）。
 * 所以既匹配类名也匹配不带句点的片段，避免正则被标点带偏。
 */
function classifyPdfError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  // 密码保护：优先判类名，message 兜底
  if (name === 'PasswordException' || /password/i.test(message)) {
    return importError('encrypted', '这份 PDF 设了打开密码，无法读取内容');
  }

  // 结构损坏：类名 + 两类常见 message
  if (
    name === 'InvalidPDFException' ||
    /Invalid PDF structure|Bad FPDF|Invalid XRef|No PDF header|Indexing all PDF/i.test(message)
  ) {
    return importError('corrupted', 'PDF 结构损坏，读不出内容');
  }

  return importError('unknown', `PDF 解析失败：${message}`);
}

/**
 * 动态加载 pdfjs 并配置 worker。
 *
 * 这里踩过三个坑，都写下来免得后人重踩：
 *
 * 1. **浏览器里必须设置 workerSrc**。pdfjs-dist v6 没有 worker 就直接抛
 *    `No "GlobalWorkerOptions.workerSrc" specified.`，一份 PDF 都解析不了。
 *
 * 2. **必须让打包器把 worker 当成资源单独产出**。用 `?url` 导入，Vite 会把
 *    pdf.worker.mjs 复制到 assets 并在运行时给出它的 URL。写死路径的话
 *    开发模式能跑、生产包必崩 —— 和 P0 的 file:// 路由是同一类问题。
 *
 * 3. **Node（单元测试）里不能用 `?url`**。没有打包器时它会被解析成
 *    文件系统路径 `E:\node_modules\...`，pdfjs 拿它做模块说明符必然失败：
 *    `Cannot find module 'E:\node_modules\pdfjs-dist\...'`。
 *    所以 Node 环境走「不指定 workerSrc」这条路，pdfjs 会自动用 fake worker
 *    在主线程解析 —— 单测要的正是这个，不需要真 worker。
 */
let pdfjsReady: Promise<typeof import('pdfjs-dist')> | null = null;

/** 判断是否在浏览器（有打包器处理的资源 URL 语义）里运行 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  // 只加载并配置一次。重复设置 workerSrc 会触发 pdfjs 的重复初始化告警。
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof import('pdfjs-dist');

      if (isBrowser()) {
        // 浏览器：worker 作为 URL 资源导入，交给打包器处理路径
        const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url');
        const workerUrl = (workerModule as { default: string }).default;
        if (workerUrl) mod.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      // Node：不设置 workerSrc，pdfjs 退回 fake worker（主线程）。
      // 单测与脚本都走这条；它慢一点，但结果完全一致。

      return mod;
    })().catch((err) => {
      // 加载失败要清掉缓存，否则后续每次导入都拿到同一个已 rejected 的 promise
      pdfjsReady = null;
      throw err;
    });
  }
  return pdfjsReady;
}

/**
 * 把控制权让给事件循环。
 *
 * 浏览器里解析 50 页 PDF 是纯 JS 计算，一个 for 循环跑完会冻结界面几秒。
 * 每页让出一次，界面才能更新进度条、响应取消。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}
