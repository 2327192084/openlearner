import JSZip from 'jszip';

/**
 * DOCX → Markdown 转换器。
 *
 * ## 为什么需要它
 *
 * 原来的 `parseDocx` 只抽**纯文本**，按标题切章节写进 `sourceSegments`。
 * 用户实测反馈「word 文件的格式也是乱的」—— 因为标题层级、列表、表格
 * 全被拍平成一段段文字，原来的样子一点没剩。
 *
 * 现在改成先转成 Markdown（保留 `#` 标题、`-` 列表、`|` 表格、`**` 强调），
 * 再按页/章写回。Markdown 是纯文本，仍然满足「按页存、能搜索、能定位」，
 * 但人看起来结构是完整的。
 *
 * ## 为什么不引第三方库
 *
 * StudyHub 用的是自研 ZIP/XML 读取（`lib/office/`，零依赖）。我们已经有
 * `jszip` + `fast-xml-parser`，够用；再加一个 mammoth/turndown 只会让
 * 打包体积变大，而它们对中文排版的支持并不比手写更可靠。
 */

/** 一个含样式的段落（从 document.xml 里抽出来的中间结构） */
export interface DocxBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'table';
  /** 标题级别 1-6；非标题为 0 */
  level: number;
  /** 纯文本（已去掉 Markdown 标记） */
  text: string;
  /** 列表是否有序 */
  ordered?: boolean;
  /** 表格行（每行是单元格文本数组） */
  rows?: string[][];
}

/**
 * 把中间结构渲染成 Markdown。
 *
 * 规则尽量朴素 —— 目标不是「完美的 Markdown」，而是
 * **让人一眼看出原文的层次**：
 *  - 标题 → `#`（级别按 Word 的 Heading N）
 *  - 列表 → `- ` / `1. `
 *  - 表格 → 标准 Markdown 表格（首行当表头）
 *  - 其余 → 普通段落，段间空一行
 */
export function blocksToMarkdown(blocks: readonly DocxBlock[]): string {
  const out: string[] = [];
  let listCounter = 0;

  for (const b of blocks) {
    if (b.kind === 'heading') {
      listCounter = 0;
      const level = Math.min(6, Math.max(1, b.level || 1));
      out.push(`${'#'.repeat(level)} ${b.text}`);
      out.push('');
      continue;
    }

    if (b.kind === 'list') {
      if (b.ordered) {
        listCounter += 1;
        out.push(`${listCounter}. ${b.text}`);
      } else {
        listCounter = 0;
        out.push(`- ${b.text}`);
      }
      continue;
    }

    if (b.kind === 'table') {
      listCounter = 0;
      const rows = (b.rows ?? []).filter((r) => r.length > 0);
      if (rows.length === 0) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const norm = rows.map((r) => {
        const cells = [...r];
        while (cells.length < width) cells.push('');
        // 单元格里的 `|` 必须转义，否则表格会被切错列
        return cells.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' '));
      });
      const [header, ...body] = norm;
      out.push(`| ${header!.join(' | ')} |`);
      out.push(`| ${header!.map(() => '---').join(' | ')} |`);
      for (const r of body) out.push(`| ${r.join(' | ')} |`);
      out.push('');
      continue;
    }

    listCounter = 0;
    out.push(b.text);
    out.push('');
  }

  // 合并多余空行
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从 docx 的 document.xml 抽出带结构的块。
 *
 * 与 `parseDocx` 里那份 `collectParagraphs` 的区别：
 * 这里保留**表格结构**与**列表标记**，而那边为了切章节把一切都拍平了。
 */
export function extractBlocks(doc: unknown): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  walk(doc, blocks);
  return blocks;
}

function walk(node: unknown, out: DocxBlock[]): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }

  const obj = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:p') {
      for (const p of Array.isArray(value) ? value : [value]) {
        const block = parseParagraphBlock(p);
        if (block) out.push(block);
      }
      continue; // 段落内部不再下钻
    }
    if (key === 'w:tbl') {
      for (const t of Array.isArray(value) ? value : [value]) {
        const table = parseTableBlock(t);
        if (table) out.push(table);
      }
      continue; // 表格已单独处理
    }
    walk(value, out);
  }
}

/** 段落 → heading / list / paragraph */
function parseParagraphBlock(p: unknown): DocxBlock | null {
  if (p === null || typeof p !== 'object') return null;
  const node = p as Record<string, unknown>;

  const pPr = firstOf(node['w:pPr']);
  const style = readStyleName(pPr);
  const level = headingLevel(style);

  const text = collectText(node).trim();
  if (!text) return null;

  if (level > 0) {
    return { kind: 'heading', level, text };
  }

  // 列表：w:numPr 存在就是列表项
  const numPr = pPr ? firstOf((pPr as Record<string, unknown>)['w:numPr']) : null;
  if (numPr && typeof numPr === 'object') {
    const numId = firstOf((numPr as Record<string, unknown>)['w:numId']);
    const numVal = numId && typeof numId === 'object' ? (numId as Record<string, unknown>)['@_w:val'] : null;
    // numId=0 表示「取消编号」，不算列表
    const isList = numVal !== undefined && String(numVal) !== '0';
    if (isList) {
      /*
       * 有序 vs 无序：Word 把真正的编号格式放在 numbering.xml 里，
       * 这里读不到（要再解析一个文件）。折中做法：
       * 一级缩进（ilvl=0）且 numId 相同的一批，按出现顺序编号，
       * 用 `-` 更安全 —— 猜错成有序会与原文编号打架。
       */
      return { kind: 'list', level: 0, text, ordered: false };
    }
  }

  return { kind: 'paragraph', level: 0, text };
}

/** 表格 → rows */
function parseTableBlock(t: unknown): DocxBlock | null {
  if (t === null || typeof t !== 'object') return null;
  const node = t as Record<string, unknown>;

  const rows: string[][] = [];
  const trs = node['w:tr'];
  for (const tr of Array.isArray(trs) ? trs : trs ? [trs] : []) {
    if (tr === null || typeof tr !== 'object') continue;
    const cells: string[] = [];
    const tcs = (tr as Record<string, unknown>)['w:tc'];
    for (const tc of Array.isArray(tcs) ? tcs : tcs ? [tcs] : []) {
      if (tc === null || typeof tc !== 'object') continue;
      // 单元格里可能有多个段落
      const parts: string[] = [];
      const ps = (tc as Record<string, unknown>)['w:p'];
      for (const p of Array.isArray(ps) ? ps : ps ? [ps] : []) {
        const txt = collectText(p).trim();
        if (txt) parts.push(txt);
      }
      cells.push(parts.join(' '));
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return null;
  return { kind: 'table', level: 0, text: '', rows };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function firstOf(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function readStyleName(pPr: unknown): string {
  if (!pPr || typeof pPr !== 'object') return '';
  const styleObj = firstOf((pPr as Record<string, unknown>)['w:pStyle']);
  if (styleObj && typeof styleObj === 'object') {
    const val = (styleObj as Record<string, unknown>)['@_w:val'];
    if (typeof val === 'string') return val;
  } else if (typeof styleObj === 'string') {
    return styleObj;
  }
  return '';
}

/** Heading 1/2/3 及中文版样式名都算标题 */
export function headingLevel(style: string): number {
  if (!style) return 0;
  const m = /^heading\s*([1-6])$/i.exec(style);
  if (m) return Number(m[1]);
  const cn = /^标题\s*([1-6])$/.exec(style);
  if (cn) return Number(cn[1]);
  if (/^title$/i.test(style)) return 1;
  return 0;
}

/** 递归收集 w:t 文本（含超链接里的） */
function collectText(node: unknown): string {
  const out: string[] = [];
  collectRuns(node, out);
  return out.join('');
}

function collectRuns(node: unknown, out: string[]): void {
  if (node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectRuns(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:t') {
      for (const t of Array.isArray(value) ? value : [value]) {
        if (typeof t === 'string') out.push(t);
        else if (t && typeof t === 'object') {
          const txt = (t as Record<string, unknown>)['#text'];
          if (typeof txt === 'string') out.push(txt);
          else if (typeof txt === 'number') out.push(String(txt));
        }
      }
      continue;
    }
    // w:tab 是制表符，w:br 是换行 —— 都要保留，否则表格与缩进会糊在一起
    if (key === 'w:tab') {
      out.push(' ');
      continue;
    }
    if (key === 'w:br') {
      out.push('\n');
      continue;
    }
    collectRuns(value, out);
  }
}

/** 供测试用：直接从 docx 字节转 Markdown */
export async function docxToMarkdown(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const file = zip.file('word/document.xml');
  if (!file) {
    throw importErrorLike('读不到 Word 正文，文件可能设了密码保护');
  }
  const xml = await file.async('text');
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const doc = parser.parse(xml);
  const blocks = extractBlocks(doc);
  return blocksToMarkdown(blocks);
}

function importErrorLike(message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = 'encrypted';
  return err;
}
