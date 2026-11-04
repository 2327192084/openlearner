import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { normalizePlainText } from './normalize.ts';
import { importError } from './types.ts';
import type { ParsedDocument, ParsedSegment } from './types.ts';

/**
 * DOCX（Word）解析：按章节切分。
 *
 * 两种切分方式的选择依据是计划书 P1 第 2 条「按页或按章节切开」：
 * DOCX 本身没有固定页（页数取决于排版引擎与纸张），
 * 硬按页切会切在句子中间。所以 Word 文档按**标题层级**切章节，
 * 这既符合教材的真实结构，也稳定可复现。
 *
 * 没有标题的文档（纯段落）退回「每 N 段一块」，避免出现一个巨长的段。
 */

/**
 * Open XML 的命名空间前缀不固定。
 * Word 自己写的是 `w:`，但一些导出工具（WPS、在线转换）可能用默认命名空间。
 * 所以按「本地名」匹配，不按前缀匹配 —— 否则换一个导出器就解析不出任何东西。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // 保留文本原样，空格由我们自己处理（xml:space="preserve" 会用到）
  preserveOrder: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

/** 从 zip 里取一个 XML 文件并按需解析 */
async function readXml(zip: JSZip, path: string): Promise<unknown | null> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async('text');
  try {
    return parser.parse(text);
  } catch {
    return null;
  }
}

/**
 * 一个 docx 段落：样式名 + 文本。
 * 样式名用于识别 Heading，从而按章节切分。
 */
interface DocxParagraph {
  style: string;
  text: string;
}

/**
 * 递归找出所有段落，**按文档顺序**。
 *
 * 关键：一个节点里可能同时有 `w:p` 和 `w:tbl`（正文段落 + 表格）。
 * 第一版实现一看到 `w:p` 就 `return`，于是 `w:tbl` 整个被跳过，
 * 表格里的文字全丢 —— 而教材里表格常常承载核心定义。
 *
 * 现在按 key 顺序遍历：遇到 `w:p` 就解析它，其他 key 一律继续下钻。
 * JS 对象保持插入顺序，所以拿到的就是文档顺序。
 */
function collectParagraphs(node: unknown, out: DocxParagraph[]): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectParagraphs(item, out);
    return;
  }

  const obj = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:p') {
      for (const p of Array.isArray(value) ? value : [value]) {
        const parsed = parseParagraph(p);
        if (parsed) out.push(parsed);
      }
      // 段落内部不再下钻：parseParagraph 已经把它的 w:t 取完了
      continue;
    }
    // 表格 w:tbl、内容控件 w:sdt、嵌入对象 …… 都要继续找
    collectParagraphs(value, out);
  }
}

/** 解析单个 w:p */
function parseParagraph(p: unknown): DocxParagraph | null {
  if (p === null || typeof p !== 'object') return null;
  const node = p as Record<string, unknown>;

  // 样式名
  let style = '';
  const pPr = node['w:pPr'];
  const pPrObj = Array.isArray(pPr) ? pPr[0] : pPr;
  if (pPrObj && typeof pPrObj === 'object') {
    const pStyle = (pPrObj as Record<string, unknown>)['w:pStyle'];
    const styleObj = Array.isArray(pStyle) ? pStyle[0] : pStyle;
    if (styleObj && typeof styleObj === 'object') {
      const val = (styleObj as Record<string, unknown>)['@_w:val'];
      if (typeof val === 'string') style = val;
    } else if (typeof styleObj === 'string') {
      style = styleObj;
    }
  }

  // 文本：拼所有 w:r/w:t，包括嵌在超链接（w:hyperlink）里的
  const pieces: string[] = [];
  collectRuns(node, pieces);
  const text = pieces.join('').trim();

  if (!text) return null;
  return { style, text };
}

/** 递归收集 w:t 文本节点 */
function collectRuns(node: unknown, out: string[]): void {
  if (node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectRuns(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  const t = obj['w:t'];
  if (t !== undefined) {
    // w:t 可能是字符串，也可能是 { '#text': '...' } 或数组
    for (const item of Array.isArray(t) ? t : [t]) {
      const value = extractTextNode(item);
      if (value) out.push(value);
    }
  }

  // w:tab / w:br 转成空格，否则相邻 run 会粘在一起
  if ('w:tab' in obj || 'w:br' in obj) out.push(' ');

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:t' || key === 'w:pPr') continue;
    collectRuns(value, out);
  }
}

function extractTextNode(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'number') return String(item);
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    if (typeof obj['#text'] === 'number') return String(obj['#text']);
  }
  return '';
}

/** Heading 1/2/3 及中文版样式名都算标题 */
function headingLevel(style: string): number {
  if (!style) return 0;
  // 英文模板：Heading1 / heading 1
  const m = /^heading\s*([1-6])$/i.exec(style);
  if (m) return Number(m[1]);
  // 中文模板：标题 1 / 标题1
  const cn = /^标题\s*([1-6])$/.exec(style);
  if (cn) return Number(cn[1]);
  // 有些模板叫 Title（文档大标题），当 1 级
  if (/^title$/i.test(style)) return 1;
  return 0;
}

export async function parseDocx(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ParsedDocument> {
  // zip 魔数：PK\x03\x04
  if (!(data[0] === 0x50 && data[1] === 0x4b)) {
    throw importError('corrupted', '这不是有效的 Word 文件（缺少 zip 文件头）');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw importError('corrupted', 'Word 文件已损坏，无法解压');
  }

  const doc = await readXml(zip, 'word/document.xml');
  if (!doc) {
    // 有 zip 结构但没有正文：常见于加密文档（OLE 复合文档套了密码）
    throw importError('encrypted', '读不到 Word 正文，文件可能设了密码保护');
  }

  const paragraphs: DocxParagraph[] = [];
  collectParagraphs(doc, paragraphs);

  if (paragraphs.length === 0) {
    throw importError('empty', 'Word 文件里没有可读取的文字');
  }

  // 按标题切章节
  const segments: ParsedSegment[] = [];
  let currentChapter: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const text = normalizePlainText(buffer.join('\n'));
    if (!text) return;
    segments.push({
      index: segments.length + 1,
      page: segments.length + 1,
      chapter: currentChapter,
      text,
    });
    buffer = [];
  };

  for (const para of paragraphs) {
    const level = headingLevel(para.style);
    if (level > 0 && level <= 2) {
      // 1/2 级标题开新章。3 级及以下当正文，避免章节碎成一堆
      flush();
      currentChapter = para.text;
      buffer.push(para.text);
    } else {
      buffer.push(para.text);
    }
  }
  flush();

  // 一个标题都没有：整份就是一章，但按段落数切成若干块，
  // 否则阅读器会变成一个几千行的滚动条，也没法用页码定位
  if (segments.length === 1 && segments[0].text.length > 4000) {
    return {
      title: options.title ?? 'Word 文档',
      pageCount: Math.ceil(segments[0].text.length / 3000),
      segments: splitByParagraphs(segments[0].text),
      textStatus: 'ready',
    };
  }

  return {
    title: options.title ?? 'Word 文档',
    pageCount: segments.length,
    segments,
    textStatus: segments.every((s) => s.text.replace(/\s/g, '').length < 20)
      ? 'no-text-layer'
      : 'ready',
  };
}

/**
 * 没有标题的长文档按段落聚合成块。
 *
 * 目标长度 3000 字：一屏能读完一段，又不至于把页数撑到几百页。
 * 只在段落边界切，绝不切开一个段落 —— 切开的段落会让位置映射指向半句话。
 */
function splitByParagraphs(text: string, targetChars = 3000): ParsedSegment[] {
  const paras = text.split('\n\n').filter((p) => p.trim());
  const segments: ParsedSegment[] = [];
  let buffer: string[] = [];
  let length = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({
      index: segments.length + 1,
      page: segments.length + 1,
      chapter: null,
      text: buffer.join('\n\n'),
    });
    buffer = [];
    length = 0;
  };

  for (const para of paras) {
    buffer.push(para);
    length += para.length;
    if (length >= targetChars) flush();
  }
  flush();

  return segments;
}
