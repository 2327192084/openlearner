import { importError } from './types.ts';
import type { ParsedDocument, ParsedSegment } from './types.ts';

/**
 * Markdown / 纯文本解析。
 *
 * 两者共用一条路径，差别只在「认不认 # 标题」：
 *  - Markdown 按 `#`~`###` 切章节（教材笔记通常就是这么组织的）
 *  - 纯文本没有结构信号，按空行分段再聚合
 *
 * 刻意不做 Markdown 渲染成 HTML：我们要的是**原文**。
 * 渲染后的 HTML 会让「点回原文」拿到的是一堆标签，
 * 而且数学公式、表格这些渲染后与原文差异大，出题引用会失真。
 * 阅读器自己决定怎么显示（P1 只需要保留段落，等宽显示即可）。
 */

export async function parseMarkdown(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ParsedDocument> {
  const text = decodeText(data);
  return parseStructuredText(text, { ...options, kind: 'markdown' });
}

export async function parseText(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ParsedDocument> {
  const text = decodeText(data);
  return parseStructuredText(text, { ...options, kind: 'text' });
}

/**
 * 解码文本文件，处理 BOM 与常见编码。
 *
 * 只处理 UTF-8（含 BOM）与 UTF-16 BOM：
 * 中文 txt 偶尔是 GBK，但浏览器里没有内置 GBK 解码器，
 * 硬猜会得到一堆乱码而用户不知道原因。这种情况按「编码不支持」明确报错，
 * 比给出乱码好 —— 乱码进库之后「点回原文」就全废了。
 */
function decodeText(data: Uint8Array): string {
  // UTF-8 BOM
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3));
  }
  // UTF-16 LE BOM
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(data.subarray(2));
  }
  // UTF-16 BE BOM
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(data.subarray(2));
  }

  // 无 BOM：先按 UTF-8 严格解码，失败说明不是 UTF-8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw importError(
      'unsupported-format',
      '这个文本文件不是 UTF-8 编码，无法正确读取',
      '请用记事本或 VS Code 另存为 UTF-8 编码（不要选 GBK/ANSI）后再导入，否则中文会变成乱码。',
    );
  }
}

interface ParseOptions {
  title?: string;
  kind: 'markdown' | 'text';
}

function parseStructuredText(raw: string, options: ParseOptions): ParsedDocument {
  const cleaned = raw.replace(/\r\n?/g, '\n');

  if (cleaned.trim().length === 0) {
    throw importError('empty', '文件内容为空');
  }

  const useHeadings = options.kind === 'markdown';
  const segments: ParsedSegment[] = [];

  if (useHeadings) {
    const lines = cleaned.split('\n');
    let chapter: string | null = null;
    let buffer: string[] = [];
    let inCodeFence = false;

    const flush = () => {
      // 去掉 markdown 语法符号，但保留文字本身
      const body = buffer.join('\n');
      const text = normalizeMarkdownBody(body);
      if (text.trim()) {
        segments.push({
          index: segments.length + 1,
          page: segments.length + 1,
          chapter,
          text,
        });
      }
      buffer = [];
    };

    for (const line of lines) {
      // 代码块里的 # 不是标题，必须跳过判断，否则代码注释会被当成章节
      if (/^\s*```/.test(line)) {
        inCodeFence = !inCodeFence;
        buffer.push(line);
        continue;
      }

      const headingMatch = !inCodeFence && /^(#{1,3})\s+(.*)$/.exec(line);
      if (headingMatch) {
        flush();
        chapter = headingMatch[2].trim();
        buffer.push(chapter);
      } else {
        buffer.push(line);
      }
    }
    flush();
  }

  // 没有标题（纯文本，或 markdown 里一个 # 都没有）→ 按段落聚合
  if (segments.length === 0) {
    const text = options.kind === 'markdown' ? normalizeMarkdownBody(cleaned) : cleaned;
    return {
      title: options.title ?? '未命名资料',
      pageCount: 1,
      segments: splitByParagraphs(text),
      textStatus: 'ready',
    };
  }

  return {
    title: options.title ?? '未命名资料',
    pageCount: segments.length,
    segments,
    textStatus: 'ready',
  };
}

/**
 * 去掉 Markdown 的行内语法，保留文字。
 *
 * 为什么这里可以「改写原文」而 PDF 不行：Markdown 的语法符号
 * （`**`、`- `、`[text](url)`）本来就不是内容，是排版指令。
 * 学生看到的是渲染后的样子，出题引用也该是那个样子。
 * 但**不改动任何文字**，只剥符号。
 */
function normalizeMarkdownBody(text: string): string {
  return (
    text
      // 行首列表符号 / 引用符号
      .replace(/^\s{0,3}[-*+]\s+/gm, '')
      .replace(/^\s{0,3}\d+\.\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      // 粗体/斜体/删除线
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      // 行内代码
      .replace(/`([^`]+)`/g, '$1')
      // 链接 [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // 图片 ![alt](url) → [图: alt]
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[图: ${alt}]` : '[图]'))
      // 水平分割线
      .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
      // 多余空行
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * 按段落聚合成长度适中的块。
 *
 * 只在段落边界切，绝不切开段落 —— 切开会让位置映射指向半句话。
 */
function splitByParagraphs(text: string, targetChars = 3000): ParsedSegment[] {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
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
    // 单个超长段落（没有空行分隔的整篇）：按句子切，否则会成一整块
    if (para.length > targetChars * 2) {
      flush();
      for (const chunk of splitLongParagraph(para, targetChars)) {
        segments.push({
          index: segments.length + 1,
          page: segments.length + 1,
          chapter: null,
          text: chunk,
        });
      }
      continue;
    }

    buffer.push(para);
    length += para.length;
    if (length >= targetChars) flush();
  }
  flush();

  return segments;
}

/** 超长段落按句末标点切，尽量不切断句子 */
function splitLongParagraph(text: string, targetChars: number): string[] {
  const sentences = text.split(/(?<=[。！？.!?\n])/);
  const chunks: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer.length + sentence.length > targetChars && buffer) {
      chunks.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.filter(Boolean);
}
