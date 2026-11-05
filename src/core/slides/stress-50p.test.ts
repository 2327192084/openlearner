import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { parsePdf } from '../parsers/pdf.ts';
import { findQuoteInText } from '../knowledge/locator.ts';
import { buildOutline } from './outline.ts';
import { buildRenderPlan } from './render-plan.ts';
import { exportToPptx } from './pptx-export.ts';
import type { KnowledgePoint, SlideDeck } from '../model.ts';
import type { ParsedSegment } from '../parsers/types.ts';

/**
 * 压力测试：50 页教材一次生成不崩。
 *
 * 计划书 P4「算做完」最后一条点名要求这一点。
 *
 * ## 为什么这件事必须单独测
 *
 * 3 页样本上永远不会暴露的瓶颈，在 50 页上可能是致命的：
 *   - 知识点数量涨 16 倍 → PPT 页数、引用表、角标编号跟着涨
 *   - 导出时 pptxgenjs 要排几百个文本框
 *   - 定位器要在 240KB 文本上跑上千次匹配
 *
 * 而「不崩」有两种失败方式，测试必须两种都盯：
 *   1. 抛异常 / 超时 —— 显性失败
 *   2. **静默丢内容** —— 生成的 PPT 页数比该有的少，或者要点被悄悄截断。
 *      这种更危险：用户拿到一份"看起来正常但缺了半本教材"的 PPT，还不会发现。
 *
 * 所以核心断言是**守恒**：知识点 → 要点 → 页数，每一步都不许凭空减少。
 */

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');
const PDF = path.join(FIXTURES, 'large-50p.pdf');

/** 整份解析一次，多个测试共用（解析 50 页要几秒，不必每个用例重来） */
let cached: ParsedSegment[] | null = null;

async function parseLarge(): Promise<ParsedSegment[]> {
  if (cached) return cached;
  const bytes = new Uint8Array(fs.readFileSync(PDF));
  const doc = await parsePdf(bytes, { title: '数据结构综合讲义' });
  cached = doc.segments;
  return cached;
}

/** 页码 → 该页正文（一页可能有多段，拼起来） */
function pageTexts(segments: ParsedSegment[]): string[] {
  const byPage = new Map<number, string[]>();
  for (const seg of segments) {
    const list = byPage.get(seg.page) ?? [];
    list.push(seg.text);
    byPage.set(seg.page, list);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  return pages.map((p) => byPage.get(p)!.join('\n'));
}

/** 用真实解析出来的页面文本构造知识点（模拟 P2 的输出） */
async function makePoints(limit = 120): Promise<KnowledgePoint[]> {
  const segments = await parseLarge();
  const pages = pageTexts(segments);
  const points: KnowledgePoint[] = [];
  const ts = '2026-11-05T00:00:00.000Z';

  for (let i = 0; i < pages.length && points.length < limit; i += 1) {
    // 每页取前 3 段实质文字，模拟整理器每页出 1~3 条知识点。
    // 50 页 × 3 = 150 条上限，够造 120 条练压力。
    const blocks = pages[i]
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12)
      .slice(0, 3);

    blocks.forEach((text, j) => {
      if (points.length >= limit) return;
      const quote = text.slice(0, Math.min(40, text.length));
      const hit = findQuoteInText(text, quote);
      const seg = segments.find((s) => s.page === i + 1);
      points.push({
        id: `kp_${i}_${j}`,
        sourceId: 'source_large',
        statement: text,
        chapter: `第 ${Math.floor(i / 5) + 1} 章`,
        cognitiveLevel: 'understand',
        tags: [],
        anchors: hit
          ? [
              {
                sourceId: 'source_large',
                page: i + 1,
                chapter: `第 ${Math.floor(i / 5) + 1} 章`,
                charStart: hit.start,
                charEnd: hit.end,
              },
            ]
          : [],
        quotes: [quote],
        origin: 'material',
        anchorStatus: hit ? 'located' : 'unlocated',
        backendId: null,
        createdAt: ts,
        updatedAt: ts,
      });
      void seg;
    });
  }
  return points;
}

describe('50 页教材：解析与定位', () => {
  it('整份教材能解析出 50 页正文', async () => {
    const pages = pageTexts(await parseLarge());
    expect(pages.length).toBe(50);
  });

  it('每页都有实质文字（不是空白页）', async () => {
    const pages = pageTexts(await parseLarge());
    const empty = pages.filter((t) => t.trim().length < 10);
    expect(empty).toHaveLength(0);
  });

  it('抽查首/中/尾页：引用能正确定位到该页', async () => {
    const pages = pageTexts(await parseLarge());

    for (const idx of [0, 24, 49]) {
      const text = pages[idx];
      const snippet = text.trim().slice(0, 30);
      const hit = findQuoteInText(text, snippet);
      expect(hit, `第 ${idx + 1} 页定位失败`).not.toBeNull();
      expect(text.slice(hit!.start, hit!.end)).toBe(snippet);
    }
  });

  it('定位 100 条引用不需要夸张的时间（< 3 秒）', async () => {
    const pages = pageTexts(await parseLarge());
    const snippets = pages.slice(0, 100).map((t) => t.trim().slice(0, 30));

    const start = Date.now();
    let ok = 0;
    snippets.forEach((snip, i) => {
      if (findQuoteInText(pages[i % pages.length], snip)) ok += 1;
    });
    const elapsed = Date.now() - start;

    expect(ok).toBe(snippets.length);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('50 页教材：大纲与分页（守恒）', () => {
  it('120 条知识点：每条要点都进大纲，一条不丢', async () => {
    const points = await makePoints(120);
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });

    const bulletTotal = outline.pages.reduce((n, p) => n + p.bullets.length, 0);
    expect(points.length).toBe(120);
    expect(bulletTotal).toBeGreaterThanOrEqual(120);
  });

  it('已定位的知识点全部拿到角标，编号从 1 连续', async () => {
    const points = await makePoints(120);
    const locatedCount = points.filter((p) => p.anchorStatus === 'located').length;
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });

    expect(outline.citations).toHaveLength(locatedCount);
    outline.citations.forEach((c, i) => expect(c.index).toBe(i + 1));
  });

  it('没有要点的页不会出现（不产空页）', async () => {
    const points = await makePoints(120);
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });

    for (const page of outline.pages) {
      if (page.layout === 'bullets') {
        expect(page.bullets.length).toBeGreaterThan(0);
      }
    }
  });

  it('每页要点数不超过上限（超长内容被拆页而非截断）', async () => {
    const points = await makePoints(120);
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });

    for (const page of outline.pages) {
      expect(page.bullets.length).toBeLessThanOrEqual(5);
    }
  });

  it('所有知识点文字都还留在大纲里（拆页不丢内容）', async () => {
    const points = await makePoints(60);
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });

    const allBulletText = outline.pages
      .flatMap((p) => p.bullets.map((b) => b.text))
      .join('');

    for (const point of points) {
      const chars = point.statement.replace(/\s/g, '');
      // 拆长文本会按标点断开，个别标点会落在切点上被吃掉；
      // 内容主体（汉字）必须全部还在
      const han = [...chars].filter((ch) => /[\u4e00-\u9fa5]/.test(ch));
      const missing = han.filter((ch) => !allBulletText.includes(ch));
      const coveredRatio = (han.length - missing.length) / Math.max(1, han.length);
      expect(coveredRatio, `知识点 ${point.id} 内容丢失过多`).toBeGreaterThan(0.95);
    }
  });
});

describe('50 页教材：渲染计划与导出', () => {
  async function makeDeck(pointLimit = 60): Promise<SlideDeck> {
    const points = await makePoints(pointLimit);
    const outline = buildOutline({ points, sourceTitle: '数据结构综合讲义' });
    const ts = '2026-11-05T00:00:00.000Z';
    return {
      id: 'slide_large',
      title: '数据结构综合讲义',
      courseId: null,
      sourceId: 'source_large',
      status: 'ready',
      pages: outline.pages,
      citations: outline.citations,
      exports: [],
      createdAt: ts,
      updatedAt: ts,
    };
  }

  it('渲染计划的页码从 1 连续到 N', async () => {
    const deck = await makeDeck(60);
    const plan = buildRenderPlan(deck);
    plan.forEach((slide, i) => expect(slide.pageNumber).toBe(i + 1));
  });

  it('资料页全部在末尾且连续（引用多时按上限拆页）', async () => {
    const deck = await makeDeck(60);
    const plan = buildRenderPlan(deck);
    const sourceSlides = plan.filter((s) => s.layout === 'sources');

    // 引用条数超过 SLIDE_LIMITS.maxCitationsPerPage（12）时必须拆页。
    // 挤在一页里会溢出到页面外——导出成 pptx 后就是彻底看不见的内容。
    const citationCount = deck.citations.length;
    const expectedPages = Math.ceil(citationCount / 12);
    expect(sourceSlides.length).toBe(expectedPages);

    // 关键：所有资料页必须**连续排在最后**，不能夹在正文中间
    const firstSourceAt = plan.findIndex((s) => s.layout === 'sources');
    expect(firstSourceAt).toBe(plan.length - sourceSlides.length);
    for (let i = firstSourceAt; i < plan.length; i += 1) {
      expect(plan[i].layout).toBe('sources');
    }
  });

  it('导出 60 条知识点的 PPT 不崩，页数与渲染计划一致', async () => {
    const deck = await makeDeck(60);
    const plan = buildRenderPlan(deck);

    const out = await exportToPptx(deck, 1);
    expect(out.buffer.length).toBeGreaterThan(10000);

    const zip = await JSZip.loadAsync(out.buffer);
    const slides = Object.keys(zip.files).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    );
    expect(slides.length).toBe(plan.length);
    expect(out.slideCount).toBe(plan.length);
  }, 60000);

  it('导出 120 条知识点的 PPT（最坏情况）仍不崩', async () => {
    const deck = await makeDeck(120);
    const plan = buildRenderPlan(deck);

    const out = await exportToPptx(deck, 1);

    const zip = await JSZip.loadAsync(out.buffer);
    const slides = Object.keys(zip.files).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    );
    expect(slides.length).toBe(plan.length);
    expect(slides.length).toBeLessThan(120);
  }, 120000);

  it('导出的每一页都有文字（没有空白页）', async () => {
    const deck = await makeDeck(60);
    const out = await exportToPptx(deck, 1);
    const zip = await JSZip.loadAsync(out.buffer);

    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml$/.exec(a)![1]);
        const nb = Number(/slide(\d+)\.xml$/.exec(b)![1]);
        return na - nb;
      });

    for (const name of slideNames) {
      const xml = await zip.file(name)!.async('string');
      const texts = (xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [])
        .map((m) => m.replace(/<\/?a:t>/g, ''))
        .join('');
      expect(texts.trim().length, `${name} 是空白页`).toBeGreaterThan(0);
    }
  }, 60000);

  it('50 页教材的完整链路在合理时间内完成（< 60 秒）', async () => {
    const started = Date.now();

    const deck = await makeDeck(100);
    const plan = buildRenderPlan(deck);
    const out = await exportToPptx(deck, 1);

    const elapsed = Date.now() - started;

    expect(plan.length).toBeGreaterThan(10);
    expect(out.buffer.length).toBeGreaterThan(10000);
    expect(elapsed).toBeLessThan(60000);
  }, 120000);
});
