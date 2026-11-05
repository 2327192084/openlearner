import { parseDocx } from './docx.ts';
import { parsePdf } from './pdf.ts';
import { parsePptx } from './pptx.ts';
import { parseMarkdown, parseText } from './text.ts';
import { detectImageKind, parseImage } from './image.ts';
import { MAX_FILE_BYTES, importError } from './types.ts';
import type { ParsedDocument } from './types.ts';

/**
 * 解析调度：按真实格式分流。
 *
 * 一条重要原则：**按文件内容（魔数）判断格式，不只看扩展名**。
 * 学生手上的课件经常是从微信/QQ 转存来的，扩展名和真实内容对不上
 * （.pdf 其实是 docx、.txt 其实是 xlsx 导出）。
 * 只看扩展名会把这类文件丢进错误的解析器，得到一个看不懂的报错。
 */

export type SupportedKind = 'pdf' | 'docx' | 'pptx' | 'markdown' | 'text' | 'image';

/** 依次尝试的嗅探结果 */
export function detectFormat(fileName: string, head: Uint8Array): SupportedKind | null {
  // 扩展名（小写，去参数）
  const ext = fileName.toLowerCase().split('?')[0].split('.').pop() ?? '';

  // ---- 先看魔数 ----
  // PDF: %PDF-
  if (head.length >= 5) {
    const magic = String.fromCharCode(head[0], head[1], head[2], head[3], head[4]);
    if (magic === '%PDF-') return 'pdf';
  }

  // 图片按魔数认，扩展名改了也认得出。放在 ZIP 判断之前 ——
  // 图片魔数与 PK 不冲突，但 BMP 的 "BM" 太短，必须先排除图片
  if (detectImageKind(head)) return 'image';

  // ZIP 容器（docx/pptx 都是）：PK\x03\x04
  // 光看魔数分不出 docx 与 pptx，交给扩展名；扩展名也不对时按 zip 内部结构判断
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    if (ext === 'docx' || ext === 'doc') return 'docx';
    if (ext === 'pptx' || ext === 'ppt') return 'pptx';
    // 扩展名不明：必须靠解压看目录，这一步放到 parseAny 里做
    return null;
  }

  // ---- 没有魔数可依，看扩展名 ----
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt' || ext === 'text') return 'text';

  return null;
}

/**
 * 解析任意文件。
 *
 * @param fileName 用于判断格式与生成标题
 * @param data 原始字节
 */
export async function parseAny(
  fileName: string,
  data: Uint8Array,
  options: {
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ParsedDocument> {
  if (data.byteLength === 0) {
    throw importError('empty', '文件是空的（0 字节）');
  }
  if (data.byteLength > MAX_FILE_BYTES) {
    throw importError(
      'too-large',
      `文件 ${(data.byteLength / 1024 / 1024).toFixed(1)} MB，超过 200 MB 上限`,
    );
  }

  /**
   * 取 16 字节而不是 8 —— WEBP 的魔数在第 8~11 字节（"RIFF....WEBP"），
   * 只取 8 字节会把 webp 判成「未知格式」。
   */
  const head = data.subarray(0, 16);
  let kind = detectFormat(fileName, head);

  // ZIP 但扩展名不明：用内部结构判断到底是 docx 还是 pptx。
  // 这一步很重要——把 pptx 当 docx 解析会得到「结构不完整」这种误导性报错。
  if (kind === null && head[0] === 0x50 && head[1] === 0x4b) {
    kind = await sniffZipKind(data);
  }

  if (kind === null) {
    throw importError(
      'unsupported-format',
      `不支持的文件格式：${fileName}`,
    );
  }

  const title = titleFromFileName(fileName);

  switch (kind) {
    case 'pdf':
      return parsePdf(data, { title, onProgress: options.onProgress });
    case 'docx':
      return parseDocx(data, { title });
    case 'pptx':
      return parsePptx(data, { title });
    case 'markdown':
      return parseMarkdown(data, { title });
    case 'text':
      return parseText(data, { title });
    case 'image':
      return parseImage(data, { title });
  }
}

/** 解开 zip 看顶层目录，区分 docx / pptx / 其他 Office 格式 */
async function sniffZipKind(data: Uint8Array): Promise<SupportedKind | null> {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(data);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('ppt/presentation.xml')) return 'pptx';
    // xlsx 之类：明确不支持，给准确的提示，不要说"文件损坏"
    if (zip.file('xl/workbook.xml')) {
      throw importError(
        'unsupported-format',
        '这是一份 Excel 表格文件，暂不支持直接导入',
      );
    }
    return null;
  } catch (err) {
    // 上面主动抛的 ImportError 要原样传出，不能被吞成 null
    if (err instanceof Error && err.name === 'ImportError') throw err;
    return null;
  }
}

/** 从文件名取标题：去扩展名，去路径 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const withoutExt = base.replace(/\.[^.]+$/, '');
  return withoutExt.trim() || base || '未命名资料';
}

/** 由扩展名推断 Source.kind，用于入库 */
export function kindFromFileName(fileName: string): SupportedKind {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'doc':
      return 'docx';
    case 'pptx':
    case 'ppt':
      return 'pptx';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'bmp':
      return 'image';
    default:
      return 'text';
  }
}

export { parsePdf, parseDocx, parsePptx, parseMarkdown, parseText, parseImage, detectImageKind };
