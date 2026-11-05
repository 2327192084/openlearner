import type { ParsedDocument } from './types.ts';
import { importError } from './types.ts';

/**
 * 图片资料（扫描版讲义、板书照片、截图）。
 *
 * ## 为什么图片也要走解析层
 *
 * 图片里**通常有字**，但字在像素里。如果只把它当「一个附件」存下来，
 * 它在项目里就是个摆设：搜不了、整理不出知识点、出不了题。
 *
 * 所以图片导入后落成一段「待识别」的资料：
 *  - `textStatus: 'no-text-layer'` —— 与扫描件同一条路，复用已有的一切
 *    （阅读器提示、OCR 入口、识别后写回分段）。
 *  - 段数为 1，正文为空，页码为 1。识别成功后正文被写回，
 *    这条资料就变得和其它资料完全一样。
 *
 * ## 为什么不在解析阶段直接跑 OCR
 *
 * 解析是同步的、无网络的、可离线重放的纯函数；OCR 要起 wasm 或发网络请求，
 * 可能失败、可能花钱。把它塞进导入流程会让「导入成功」的含义变模糊
 * ——用户以为文件进来了，其实还卡在识别上。
 * 让用户明确点一次「识别」，比导入时偷偷跑掉更诚实。
 *
 * ## 支持哪些格式
 *
 * 只认浏览器能直接显示的四种：png / jpeg / webp / gif。
 * 判断依据是**文件魔数**而不只是扩展名 —— 扩展名可以随便改，
 * 把 webp 改名成 .png 交给 `<img>` 在部分环境会显示不出来。
 */

/** 浏览器能直接渲染的图片格式 */
export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp';

/**
 * 按魔数判断图片类型。不是图片返回 null。
 *
 * 只认这几种，是因为它们的 `<img>` 支持最稳。TIFF、HEIC 等
 * 在浏览器里多数渲染不出来，收进来只会得到一张破图。
 */
export function detectImageKind(data: Uint8Array): ImageKind | null {
  if (data.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';

  // GIF: "GIF87a" / "GIF89a"
  if (
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
  ) {
    return 'gif';
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return 'webp';
  }

  // BMP: "BM"
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp';

  return null;
}

/** 图片格式 → MIME，用于拼 data URL */
export const IMAGE_MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/**
 * 把图片解析成一份「一段、正文待识别」的资料。
 *
 * 这里的 `pageCount: 1` 是**如实**的：一张图就是一页。
 * 不做「估算它相当于几页文字」这种编造。
 */
export function parseImage(data: Uint8Array, opts: { title: string }): ParsedDocument {
  const kind = detectImageKind(data);
  if (!kind) {
    throw importError(
      'unsupported-format',
      '这个文件看起来不是能直接显示的图片（支持 PNG、JPEG、WebP、GIF、BMP）',
      '请另存为 PNG 或 JPEG 再导入。TIFF、HEIC 这类格式浏览器打不开。',
    );
  }

  return {
    title: opts.title,
    pageCount: 1,
    segments: [
      {
        index: 1,
        page: 1,
        chapter: null,
        /**
         * 正文留空是真的空 —— 我们确实还没读它。
         * 不放占位文字（如「（图片）」）: 那会让全文搜索搜出假命中，
         * 也会让「整理知识点」拿一句占位符去喂模型。
         */
        text: '',
      },
    ],
    textStatus: 'no-text-layer',
  };
}

/**
 * 把图片字节拼成 data URL，供 `<img src>` 直接显示。
 *
 * 用分块拼 base64，避免 `String.fromCharCode(...data)` 在大图上爆栈
 * （一张 5MB 的图直接展开会被参数个数上限卡死）。
 */
export function toImageDataUrl(data: Uint8Array): string {
  const kind = detectImageKind(data);
  const mime = kind ? IMAGE_MIME[kind] : 'application/octet-stream';
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
