import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { normalizePlainText } from './normalize.ts';
import { importError } from './types.ts';
import type { ParsedDocument, ParsedSegment } from './types.ts';

/**
 * PPTX（PowerPoint）解析：一张幻灯片 = 一段。
 *
 * PPTX 天然按幻灯片组织，所以「页」的语义是确定的，
 * 比 DOCX 按章节猜要可靠得多。这也正是它在 P4 出 PPT 时最好用的地方：
 * 学生课件本来就是按页讲的。
 *
 * 关键难点：**必须按 presentation.xml 里的 sldIdLst 顺序读**，
 * 不能按文件名 slide1.xml / slide2.xml 排序。
 * PowerPoint 在调整页序时只改 presentation.xml 的引用顺序，**不改文件名**。
 * 按文件名排会导致「第 2 页显示的是原文第 5 页」——
 * 这正是计划书最怕的「指错页」，而且它冒充可信。
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

/** 从 slide XML 里按顺序取出所有 a:t 文本 */
function collectTextRuns(node: unknown, out: string[]): void {
  if (node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTextRuns(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  const t = obj['a:t'];
  if (t !== undefined) {
    for (const item of Array.isArray(t) ? t : [t]) {
      const value = extractText(item);
      if (value) out.push(value);
    }
  }

  // 换行符 a:br → 空格
  if ('a:br' in obj) out.push(' ');

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'a:t') continue;
    collectTextRuns(value, out);
  }
}

function extractText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'number') return String(item);
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    if (typeof obj['#text'] === 'number') return String(obj['#text']);
  }
  return '';
}

/**
 * 按 presentation.xml 的 sldIdLst 顺序解析出幻灯片文件顺序。
 *
 * 返回的是 rels 里的 Target（如 "slides/slide3.xml"），已按显示顺序排列。
 */
async function resolveSlideOrder(
  zip: JSZip,
): Promise<{ target: string; chapter: string | null }[]> {
  const presFile = zip.file('ppt/presentation.xml');
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');

  if (!presFile || !relsFile) {
    throw importError('corrupted', 'PPT 文件缺少 presentation.xml（结构不完整）');
  }

  const pres = parser.parse(await presFile.async('text')) as Record<string, unknown>;
  const rels = parser.parse(await relsFile.async('text')) as Record<string, unknown>;

  // rId → Target 映射
  const relMap = new Map<string, string>();
  const relRoot = rels['Relationships'] as Record<string, unknown> | undefined;
  const relItems = relRoot?.['Relationship'];
  for (const rel of Array.isArray(relItems) ? relItems : relItems ? [relItems] : []) {
    if (!rel || typeof rel !== 'object') continue;
    const r = rel as Record<string, unknown>;
    const id = r['@_Id'];
    const target = r['@_Target'];
    if (typeof id === 'string' && typeof target === 'string') {
      // Target 可能是相对路径 "slides/slide1.xml" 或 "/ppt/slides/slide1.xml"
      relMap.set(id, target.replace(/^\/?ppt\//, '').replace(/^\//, ''));
    }
  }

  // sldIdLst 顺序
  const order: string[] = [];
  const presRoot = pres['p:presentation'] as Record<string, unknown> | undefined;
  const sldIdLst = presRoot?.['p:sldIdLst'] as Record<string, unknown> | undefined;
  const sldIds = sldIdLst?.['p:sldId'];

  for (const item of Array.isArray(sldIds) ? sldIds : sldIds ? [sldIds] : []) {
    if (!item || typeof item !== 'object') continue;
    const rid = (item as Record<string, unknown>)['@_r:id'];
    if (typeof rid === 'string') {
      const target = relMap.get(rid);
      if (target) order.push(target);
    }
  }

  if (order.length === 0) {
    throw importError('empty', 'PPT 文件里没有幻灯片');
  }

  return order.map((target) => ({ target, chapter: null }));
}

export async function parsePptx(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ParsedDocument> {
  if (!(data[0] === 0x50 && data[1] === 0x4b)) {
    throw importError('corrupted', '这不是有效的 PowerPoint 文件（缺少 zip 文件头）');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw importError('corrupted', 'PowerPoint 文件已损坏，无法解压');
  }

  const order = await resolveSlideOrder(zip);

  const segments: ParsedSegment[] = [];

  for (const { target } of order) {
    const file = zip.file(`ppt/${target}`);
    if (!file) {
      // 单页缺失不致命：跳过它并继续，总比整份导入失败好。
      // 但要占住页码位，否则后续页会整体前移，导致指错页。
      segments.push({
        index: segments.length + 1,
        page: segments.length + 1,
        chapter: null,
        text: '',
      });
      continue;
    }

    const xml = parser.parse(await file.async('text')) as Record<string, unknown>;
    const runs: string[] = [];
    collectTextRuns(xml, runs);

    const text = normalizePlainText(runs.join(' '));
    const page = segments.length + 1;

    segments.push({
      index: page,
      page,
      // 标题页/首个非空文本块当章节名，便于目录
      chapter: guessSlideTitle(text),
      text,
    });
  }

  const nonEmpty = segments.filter((s) => s.text.replace(/\s/g, '').length >= 20);

  return {
    title: options.title ?? '演示文稿',
    pageCount: segments.length,
    segments,
    // 一张幻灯片都没文字 → 可能是纯图片版 PPT（等于扫描件）
    textStatus: nonEmpty.length === 0 ? 'no-text-layer' : 'ready',
  };
}

/** 幻灯片标题：第一行，且不太长、不以句号结尾 */
function guessSlideTitle(text: string): string | null {
  const first = text.split('\n')[0]?.trim();
  if (!first) return null;
  if (first.length > 40) return null;
  if (/[。；]$/.test(first)) return null;
  return first;
}
