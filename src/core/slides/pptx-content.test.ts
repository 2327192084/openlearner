import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { KnowledgePoint, SourceLocation } from '../model.ts';
import { SlideService } from './service.ts';

/**
 * 导出的 .pptx 内容验证。
 *
 * ## 为什么非要解压再验
 *
 * 只验「字节数 > 5000」和「前两字节是 PK」是**假测试**：
 * 一个只含 `[Content_Types].xml` 的空 pptx 也满足这两条。
 * 而真正的失败模式恰恰是那种"文件能打开但是空的"——
 * 用户会觉得软件坏了，而我们所有的测试都是绿的。
 *
 * 所以这里解压 zip，读 `ppt/slides/slideN.xml`，断言：
 *   - 页数 = 预期
 *   - 文字真的在里面（<a:t> 节点）
 *   - 角标真的在（[n] 文本）
 *   - 是文本 run 而非图片
 */

function makePoint(over: Partial<KnowledgePoint> & { id: string }): KnowledgePoint {
  const anchor: SourceLocation = {
    sourceId: 'src-a',
    page: 3,
    chapter: '第一章',
    charStart: 0,
    charEnd: 20,
  };
  return {
    sourceId: 'src-a',
    statement: over.statement ?? `知识点 ${over.id} 的内容。`,
    quotes: over.quotes ?? [`知识点 ${over.id} 的原文`],
    anchors: over.anchors ?? [anchor],
    anchorStatus: over.anchorStatus ?? 'located',
    chapter: over.chapter ?? '第一章',
    level: 1,
    tags: [],
    backendId: 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as KnowledgePoint;
}

/** 解开 pptx，返回每页 XML 文本 */
async function readSlides(buffer: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      // slide2 要排在 slide10 前面：按数字排，不按字符串排
      const na = Number(/slide(\d+)\.xml$/.exec(a)![1]);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)![1]);
      return na - nb;
    });

  const out: string[] = [];
  for (const name of names) {
    out.push(await zip.file(name)!.async('string'));
  }
  return out;
}

/** 从 slide xml 里抽出所有可见文字 */
function extractText(xml: string): string {
  const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
  return matches
    .map((m) => m.replace(/<\/?a:t>/g, ''))
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

describe('导出的 pptx 内容真实可读', () => {
  it('解压后页数与导出的 slideCount 一致', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = Array.from({ length: 6 }, (_, i) =>
      makePoint({ id: `k${i}`, statement: `第 ${i} 条要点内容。` }),
    );
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);

    const xmls = await readSlides(out.buffer);
    expect(xmls).toHaveLength(out.slideCount);
  });

  it('要点文字真的写进了 slide xml（不是空文件）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = [
      makePoint({ id: 'k1', statement: '采样定理要求采样频率大于两倍最高频率。' }),
      makePoint({ id: 'k2', statement: '线性系统满足叠加性与齐次性。' }),
    ];
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);

    const all = (await readSlides(out.buffer)).map(extractText).join('\n');

    expect(all).toContain('采样定理要求采样频率大于两倍最高频率');
    expect(all).toContain('线性系统满足叠加性与齐次性');
  });

  it('角标 [n] 真的渲染进了 slide xml', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: Array.from({ length: 3 }, (_, i) => makePoint({ id: `k${i}` })),
    });
    const out = await slides.export(deck.id);

    const all = (await readSlides(out.buffer)).map(extractText).join('\n');

    expect(all).toContain('[1]');
    expect(all).toContain('[2]');
    expect(all).toContain('[3]');
  });

  it('角标用上标（baseline 属性）而不是普通文字', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint({ id: 'k1' })],
    });
    const out = await slides.export(deck.id);

    const all = (await readSlides(out.buffer)).join('\n');
    // OOXML 的上标是 rPr 的 baseline 属性
    expect(all).toMatch(/baseline="30000"|baseline="30%/);
  });

  it('资料来源页列出文档名与页码', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = [
      makePoint({
        id: 'k1',
        anchors: [{ sourceId: 'src-a', page: 88, chapter: '第五章', charStart: 0, charEnd: 9 }],
      }),
    ];
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);

    const all = (await readSlides(out.buffer)).map(extractText).join('\n');

    expect(all).toContain('资料来源');
    expect(all).toContain('88');
    expect(all).toContain('第五章');
  });

  it('不含图片（证明是可编辑文本，不是截图拼贴）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: Array.from({ length: 5 }, (_, i) => makePoint({ id: `k${i}` })),
    });
    const out = await slides.export(deck.id);

    const zip = await JSZip.loadAsync(out.buffer);
    // 只要真实的图片文件，不要目录项：
    // pptxgenjs 无论如何都会建一个空的 ppt/media/ 目录条目，
    // 按前缀匹配会把它也算进去，得出的结论就永远失败（或永远通过）。
    const media = Object.keys(zip.files).filter(
      (n) => n.startsWith('ppt/media/') && !zip.files[n].dir,
    );

    // 计划书 P4 第 5 条：导出真实 .pptx（可编辑，非图片拼贴）
    expect(media).toHaveLength(0);
  });

  it('中文不乱码（UTF-8 正确写入）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint({ id: 'k1', statement: '傅里叶变换与拉普拉斯变换的关系。' })],
    });
    const out = await slides.export(deck.id);

    const all = (await readSlides(out.buffer)).map(extractText).join('\n');
    // 不能出现问号替换或乱码
    expect(all).toContain('傅里叶变换与拉普拉斯变换的关系');
    expect(all).not.toMatch(/[\ufffd]/); // Unicode 替换字符
  });

  it('50 页教材规模导出：页数正确且每页都有内容', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = Array.from({ length: 200 }, (_, i) =>
      makePoint({
        id: `k${i}`,
        statement: `第 ${i} 条知识点，说明一个具体概念。`,
        chapter: `第${Math.floor(i / 20) + 1}章`,
      }),
    );
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);

    const xmls = await readSlides(out.buffer);
    expect(xmls).toHaveLength(out.slideCount);

    // 每一页都得有文字（不能有空白页）
    for (const xml of xmls) {
      expect(extractText(xml).trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * 画布尺寸与形状越界。
 *
 * ## 这组测试是补出来的
 *
 * 上面所有断言原本全绿，但导出的文件其实是坏的：画布是
 * 10 × 5.625 英寸（pptxgenjs 的 'LAYOUT_16x9' 预设），
 * 而所有坐标都按 13.333 × 7.5 算，于是 49 个形状跑到画布外，
 * 在 Office / WPS 里直接被裁掉。
 *
 * 为什么之前没发现：`<a:t>` 里文字一个不少，页数也对，
 * **文字存在和文字可见是两件事**。比例也还是 16:9，
 * 所以肉眼看预览完全正常。
 *
 * 是拿 python-pptx（另一套独立 OOXML 实现）解析产物才暴露的，
 * 见 scripts/inspect-pptx.py。这两条测试把那个排查固化成断言。
 *
 * EMU：1 英寸 = 914400 EMU（OOXML 的固定换算）。
 */
const EMU_PER_INCH = 914400;

describe('画布尺寸与形状边界', () => {
  /** 读 ppt/presentation.xml 里的 <p:sldSz cx cy> */
  async function readSlideSize(
    buffer: Uint8Array,
  ): Promise<{ cx: number; cy: number }> {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('ppt/presentation.xml')!.async('string');
    const match = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(xml);
    expect(match, 'presentation.xml 里应该有 sldSz 尺寸声明').not.toBeNull();
    return { cx: Number(match![1]), cy: Number(match![2]) };
  }

  /** 从一页 slide xml 里抽出所有形状的位置与尺寸（EMU） */
  function readShapeBoxes(
    xml: string,
  ): Array<{ x: number; y: number; cx: number; cy: number }> {
    const boxes: Array<{ x: number; y: number; cx: number; cy: number }> = [];
    // <a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>
    const re = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      boxes.push({
        x: Number(m[1]),
        y: Number(m[2]),
        cx: Number(m[3]),
        cy: Number(m[4]),
      });
    }
    return boxes;
  }

  it('画布是标准宽屏 13.333 × 7.5 英寸，不是 pptxgenjs 的 10 × 5.625 预设', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint({ id: 'k1' })],
    });
    const out = await slides.export(deck.id);

    const { cx, cy } = await readSlideSize(out.buffer);

    // 容差 2000 EMU ≈ 0.002 英寸，只为吸收浮点换算，不放宽到能容忍 33% 偏差
    expect(cx).toBeCloseTo(13.333 * EMU_PER_INCH, -3);
    expect(cy).toBeCloseTo(7.5 * EMU_PER_INCH, -3);

    // 显式钉住两个错误尺寸：pptxgenjs 预设 9144000×5143500 与 4:3 的 9144000×6858000
    expect(cx).not.toBe(9144000);
  });

  it('任何形状都不超出画布（越界的内容在 Office 里会被裁掉）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = Array.from({ length: 12 }, (_, i) =>
      makePoint({
        id: `k${i}`,
        statement: `第 ${i} 条要点，用来撑出足够多的形状以覆盖各种版式。`,
        chapter: i < 6 ? '第一章' : '第二章',
      }),
    );
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);

    const { cx: pageW, cy: pageH } = await readSlideSize(out.buffer);
    const xmls = await readSlides(out.buffer);

    let checked = 0;
    xmls.forEach((xml, pageIndex) => {
      for (const box of readShapeBoxes(xml)) {
        checked += 1;
        expect(box.x, `第 ${pageIndex + 1} 页有形状左边界越界`).toBeGreaterThanOrEqual(0);
        expect(box.y, `第 ${pageIndex + 1} 页有形状上边界越界`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.cx, `第 ${pageIndex + 1} 页有形状右边越界`).toBeLessThanOrEqual(pageW);
        expect(box.y + box.cy, `第 ${pageIndex + 1} 页有形状底部越界`).toBeLessThanOrEqual(pageH);
      }
    });

    // 防止正则没匹配到形状而导致上面循环空转、测试假通过
    expect(checked).toBeGreaterThan(10);
  });
});

/**
 * 叠字缺陷的回归测试。
 *
 * ## 这条测试诞生的经过
 *
 * 所有验收（verify-p4 20/20）和 544 条单测都是绿的，页数、文字、角标、
 * 边界全部正确。但把导出的 pptx 用 LibreOffice 渲染成图片一看，
 * 第 3 页有**两行字叠在同一个位置**。
 *
 * 根因：pptxgenjs 把文本里的换行符编成**独立段落**（多个 `<a:p>`），
 * 不是 `<a:br/>`。要点文本框高度 0.8 英寸、行距 0.86 英寸，
 * 一条要点变成两段后，第二段压到了下一条要点身上。
 *
 * 这正是「自动验收全绿 ≠ 东西是对的」的典型 ——
 * 文字都在、角标都在、页数也对，只有眼睛能看出问题。
 * 所以这条断言必须能在缺陷复现时变红，否则它只是安慰剂。
 */
describe('一条要点只占一个段落（叠字回归）', () => {
  /** 每个文本框里的段落文字数组 */
  function readTextShapes(xml: string): string[][] {
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
    return shapes.map((sp) => {
      const paras = sp.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];
      return paras.map((para) =>
        (para.match(/<a:t>([^<]*)<\/a:t>/g) ?? [])
          .map((m) => m.replace(/<\/?a:t>/g, ''))
          .join(''),
      );
    });
  }

  it('原文里带换行的知识点，导出后仍是单个段落且一个字都没丢', async () => {
    const slides = new SlideService(new MemoryStorage());
    const points = [
      makePoint({
        id: 'k1',
        // 复刻真实场景：PDF 抽出的段落带着章节标题行的换行
        statement:
          '第一章 数据结构绪论\n数据结构研究的是数据元素之间的关系以及在这些关系上的操作。',
      }),
      makePoint({ id: 'k2', statement: '线性表是最常用的数据结构之一。' }),
    ];
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });
    const out = await slides.export(deck.id);
    const xmls = await readSlides(out.buffer);

    let textShapes = 0;
    for (const xml of xmls) {
      for (const paragraphs of readTextShapes(xml)) {
        const filled = paragraphs.filter((t) => t.trim().length > 0);
        if (filled.length === 0) continue;
        textShapes += 1;
        expect(
          filled.length,
          `有文本框被拆成了 ${filled.length} 个段落，第二段会压到下一条要点上：${filled.join(' / ')}`,
        ).toBe(1);
      }
    }

    // 防止上面的循环一次都没跑（形状没匹配到 → 假通过）
    expect(textShapes).toBeGreaterThan(5);

    // 折叠空白不等于删内容：原来那些字必须都还在
    const all = xmls.map(extractText).join('\n');
    expect(all).toContain('第一章 数据结构绪论 数据结构研究的是数据元素之间的关系以及在这些关系上的操作');
  });

  it('要点文本进库前就归一了空白（不靠渲染时补救）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint({ id: 'k1', statement: '短句。' })],
    });

    const page = deck.pages.find((p) => p.layout === 'bullets');
    expect(page).toBeDefined();
    const bullet = page!.bullets[0];

    const updated = await slides.updateBulletText(
      deck.id,
      page!.id,
      bullet.id,
      '第一行\n\n第二行\t第三行',
    );
    const after = updated.pages.find((p) => p.id === page!.id)!.bullets[0];

    expect(after.text).toBe('第一行 第二行 第三行');
    expect(after.text).not.toContain('\n');
  });
});
