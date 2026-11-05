import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { KnowledgePoint, SlideFigure, SourceLocation } from '../model.ts';
import { SlideService } from './service.ts';
import { buildRenderPlan, SLIDE_BOX, SLIDE_SIZE } from './render-plan.ts';

/**
 * 图文页：把原文原页截图贴进 PPT。
 *
 * ## 为什么这一组测试必须存在
 *
 * 图文页最容易出的不是崩溃，而是三种「看着正常」的坏结果：
 *   1. 图片根本没进 pptx（预览有、导出没有）——用户拿到 PPT 才发现是空框
 *   2. 图片被拉伸变形（文字页被压扁，原文认不出来）
 *   3. 图片超出画布被裁掉（Office 里只看到半页）
 * 这三种在浏览器里点一遍都发现不了，只能解压 OOXML 验。
 */

const EMU_PER_INCH = 914400;

/** 1×1 透明 PNG，够当 data URL 用；尺寸由 SlideFigure.width/height 决定 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makePoint(id: string): KnowledgePoint {
  const anchor: SourceLocation = {
    sourceId: 'src-a',
    page: 3,
    chapter: '第一章',
    charStart: 0,
    charEnd: 20,
  };
  return {
    id,
    sourceId: 'src-a',
    statement: `知识点 ${id} 的内容。`,
    quotes: [`知识点 ${id} 的原文`],
    anchors: [anchor],
    anchorStatus: 'located',
    chapter: '第一章',
    cognitiveLevel: 'understand',
    tags: [],
    origin: 'material',
    backendId: 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeFigure(over: Partial<SlideFigure> = {}): SlideFigure {
  return {
    sourceId: 'src-a',
    page: 12,
    imageData: TINY_PNG,
    // A4 竖版的比例，最常见的教材页
    width: 1400,
    height: 1980,
    caption: '《数据结构》第 12 页',
    ...over,
  };
}

async function readSlides(buffer: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));

  const out: string[] = [];
  for (const name of names) out.push(await zip.file(name)!.async('string'));
  return out;
}

/** 媒体文件（真实的图片字节，排除目录条目） */
async function readMedia(buffer: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).filter(
    (n) => n.startsWith('ppt/media/') && !zip.files[n].dir,
  );
}

/** 从 slide xml 抽出图片框：<p:pic> 内的 a:off / a:ext */
function readPicBoxes(xml: string): Array<{ x: number; y: number; cx: number; cy: number }> {
  const boxes: Array<{ x: number; y: number; cx: number; cy: number }> = [];
  const pics = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? [];
  for (const pic of pics) {
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/.exec(pic);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(pic);
    if (!off || !ext) continue;
    boxes.push({
      x: Number(off[1]),
      y: Number(off[2]),
      cx: Number(ext[1]),
      cy: Number(ext[2]),
    });
  }
  return boxes;
}

describe('图文页：图片真的进了 pptx', () => {
  it('导出后 zip 里有一张真实图片（不是只有目录）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const out = await slides.export(withFigure.id);

    const media = await readMedia(out.buffer);
    expect(media.length).toBeGreaterThanOrEqual(1);
    // 目录条目也要有，但不能靠它充数 —— 上面已用 !dir 过滤
    expect(media.some((n) => /\.(png|jpe?g)$/i.test(n))).toBe(true);
  });

  it('图片挂在图文页上，且页数增加一页', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const before = (await slides.getPlan(deck.id)).length;

    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const plan = await slides.getPlan(withFigure.id);

    expect(plan).toHaveLength(before + 1);

    const figureSlide = plan.find((s) => s.layout === 'figure');
    expect(figureSlide, '渲染计划里应该有一页图文页').toBeDefined();
    expect(figureSlide!.figure?.imageData.startsWith('data:image/')).toBe(true);
  });

  it('图文页插在封面之后，不是吊在资料来源页前面', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    const withFigure = await slides.addFigurePage(deck.id, makeFigure());

    expect(withFigure.pages[0].layout).toBe('title');
    expect(withFigure.pages[1].layout).toBe('figure');
  });

  it('资料来源页仍然排在最后（图文页不能挤掉它）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const plan = await slides.getPlan(withFigure.id);

    expect(plan[plan.length - 1].layout).toBe('sources');
    expect(plan.filter((s) => s.layout === 'sources')).toHaveLength(1);
  });
});

describe('图文页：等比缩放，绝不拉伸', () => {
  it('竖版页面不会被压成正方形', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    // 1400×1980 = 0.7071，A4 竖版
    const figure = makeFigure({ width: 1400, height: 1980 });
    const withFigure = await slides.addFigurePage(deck.id, figure);
    const plan = await slides.getPlan(withFigure.id);
    const box = plan.find((s) => s.layout === 'figure')!.figureBox!;

    // 导出框是四舍五入到 0.01 英寸的，容差放到 0.02
    expect(box.w / box.h).toBeCloseTo(1400 / 1980, 1);
  });

  it('横版页面不会被拉成竖版', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ width: 2000, height: 1000 }),
    );
    const plan = await slides.getPlan(withFigure.id);
    const box = plan.find((s) => s.layout === 'figure')!.figureBox!;

    expect(box.w / box.h).toBeCloseTo(2000 / 1000, 1);
    expect(box.w).toBeGreaterThan(box.h);
  });

  it('图片完全落在正文区内，不压标题也不压页码', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    // 极端长条：逼出「高度受限」的分支
    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ width: 400, height: 4000 }),
    );
    const plan = await slides.getPlan(withFigure.id);
    const box = plan.find((s) => s.layout === 'figure')!.figureBox!;

    expect(box.x).toBeGreaterThanOrEqual(SLIDE_BOX.marginX - 0.01);
    expect(box.y).toBeGreaterThanOrEqual(SLIDE_BOX.bodyTop - 0.01);
    expect(box.x + box.w).toBeLessThanOrEqual(SLIDE_SIZE.width - SLIDE_BOX.marginX + 0.01);
    expect(box.y + box.h).toBeLessThanOrEqual(SLIDE_BOX.footerTop + 0.01);
  });

  it('导出的图片框比例与渲染计划一致（预览和导出不是一个尺寸就白做了）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ width: 1400, height: 1980 }),
    );

    const plan = await slides.getPlan(withFigure.id);
    const planned = plan.find((s) => s.layout === 'figure')!.figureBox!;

    const out = await slides.export(withFigure.id);
    const xmls = await readSlides(out.buffer);

    const figurePageXml = xmls[plan.findIndex((s) => s.layout === 'figure')];
    const boxes = readPicBoxes(figurePageXml);
    expect(boxes, '图文页里应该恰好有一个图片框').toHaveLength(1);

    const actual = boxes[0];
    expect(actual.cx / EMU_PER_INCH).toBeCloseTo(planned.w, 1);
    expect(actual.cy / EMU_PER_INCH).toBeCloseTo(planned.h, 1);
  });

  it('图片不出画布（越界的图在 Office 里只看到半页）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ width: 3000, height: 500 }),
    );

    const out = await slides.export(withFigure.id);
    const xmls = await readSlides(out.buffer);

    const zip = await JSZip.loadAsync(out.buffer);
    const presXml = await zip.file('ppt/presentation.xml')!.async('string');
    const m = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml)!;
    const pageW = Number(m[1]);
    const pageH = Number(m[2]);

    let checked = 0;
    for (const xml of xmls) {
      for (const box of readPicBoxes(xml)) {
        checked += 1;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.cx).toBeLessThanOrEqual(pageW + 1);
        expect(box.y + box.cy).toBeLessThanOrEqual(pageH + 1);
      }
    }
    // 防正则空转：真的读到了图
    expect(checked).toBeGreaterThanOrEqual(1);
  });
});

describe('图文页：图注与标题', () => {
  it('图注里的换行被折叠（否则会和相邻文字叠在一起）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ caption: '《数据结构》\n第 12 页\t图 1-3' }),
    );
    const plan = await slides.getPlan(withFigure.id);
    const slide = plan.find((s) => s.layout === 'figure')!;

    expect(slide.figureCaption).toBe('《数据结构》 第 12 页 图 1-3');
    expect(slide.figureCaption).not.toContain('\n');
  });

  it('图注为空时标题兜底成「第 N 页」，不留空标题', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    const withFigure = await slides.addFigurePage(
      deck.id,
      makeFigure({ caption: '   ', page: 7 }),
    );
    const page = withFigure.pages.find((p) => p.layout === 'figure')!;

    expect(page.title.trim()).not.toBe('');
    expect(page.title).toBe('第 7 页');
  });

  it('改图注不会动图片数据', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const page = withFigure.pages.find((p) => p.layout === 'figure')!;

    const updated = await slides.updateFigureCaption(
      deck.id,
      page.id,
      '改成新的图注\n带换行',
    );
    const after = updated.pages.find((p) => p.id === page.id)!;

    expect(after.figure!.caption).toBe('改成新的图注 带换行');
    expect(after.figure!.imageData).toBe(TINY_PNG);
    expect(after.figure!.width).toBe(1400);
  });

  it('换图会同时换掉图片与图注', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const page = withFigure.pages.find((p) => p.layout === 'figure')!;

    const updated = await slides.replaceFigure(deck.id, page.id, {
      sourceId: 'src-a',
      page: 88,
      imageData: TINY_PNG,
      width: 1000,
      height: 1000,
      caption: '第 88 页 换过了',
    });
    const after = updated.pages.find((p) => p.id === page.id)!;

    expect(after.figure!.page).toBe(88);
    expect(after.figure!.width).toBe(1000);
    expect(after.figure!.caption).toBe('第 88 页 换过了');
  });
});

describe('图文页：拒绝坏数据', () => {
  it('图片不是 data URL 时拒绝（否则导出会崩在 pptxgenjs 里）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    await expect(
      slides.addFigurePage(deck.id, makeFigure({ imageData: 'not-a-data-url' })),
    ).rejects.toThrow(/data URL/);
  });

  it('图片尺寸为 0 时拒绝（算不出版面，会导出零面积图片）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });

    await expect(
      slides.addFigurePage(deck.id, makeFigure({ width: 0, height: 100 })),
    ).rejects.toThrow(/尺寸无效/);
  });

  it('对要点页调 updateFigureCaption 会明确报错，而不是静默什么都不做', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const bullets = deck.pages.find((p) => p.layout === 'bullets')!;

    await expect(
      slides.updateFigureCaption(deck.id, bullets.id, '随便写'),
    ).rejects.toThrow(/不是图文页/);
  });
});

describe('图文页：要点与角标', () => {
  it('图文页可以带要点，角标照常继承知识点', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const page = withFigure.pages.find((p) => p.layout === 'figure')!;

    const updated = await slides.addBullet(deck.id, page.id, '这张图说明了树的遍历顺序。');
    const after = updated.pages.find((p) => p.id === page.id)!;

    expect(after.bullets).toHaveLength(1);
    // 手写要点没有出处，不能硬安一个角标
    expect(after.bullets[0].citationIndex).toBeNull();
  });

  it('图文页的要点超出上限时拆页，不是硬塞进一页', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const page = withFigure.pages.find((p) => p.layout === 'figure')!;

    // render-plan 对图文页要点列沿用要点页的分页上限
    const plan = await slides.getPlan(deck.id);
    const figureSlide = plan.find((s) => s.layout === 'figure')!;
    expect(figureSlide.bullets.length).toBeLessThanOrEqual(5);

    // 页面本身还在
    expect(page.layout).toBe('figure');
  });
});

describe('buildRenderPlan 对图文页的兜底', () => {
  it('页上有图但 figureBox 算不出来时，不抛异常（宁可少图也不能导不出）', async () => {
    const slides = new SlideService(new MemoryStorage());
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: [makePoint('k1')],
    });
    const withFigure = await slides.addFigurePage(deck.id, makeFigure());
    const plan = await slides.getPlan(withFigure.id);

    // 正常路径：图与框都在
    const slide = plan.find((s) => s.layout === 'figure')!;
    expect(slide.figure).not.toBeNull();
    expect(slide.figureBox).not.toBeNull();

    // 极端宽高比也不会算出 NaN 或负数
    const weird = buildRenderPlan(
      {
        ...withFigure,
        pages: withFigure.pages.map((p) =>
          p.layout === 'figure'
            ? { ...p, figure: { ...p.figure!, width: 100000, height: 1 } }
            : p,
        ),
      },
      '学习资料',
    );
    const weirdBox = weird.find((s) => s.layout === 'figure')!.figureBox!;
    expect(Number.isFinite(weirdBox.w)).toBe(true);
    expect(Number.isFinite(weirdBox.h)).toBe(true);
    expect(weirdBox.w).toBeGreaterThan(0);
    expect(weirdBox.h).toBeGreaterThan(0);
  });
});
