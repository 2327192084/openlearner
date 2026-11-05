import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { KnowledgePoint, SourceLocation } from '../model.ts';
import { SlideService } from './service.ts';
import { buildFileName } from './pptx-export.ts';

/**
 * SlideService 的测试。
 *
 * 除了常规增删改，这里重点守两件事：
 *   1. 导出真的产出可解析的 pptx（不是空文件、不是图片）
 *   2. 删要点/删页之后角标编号要重排 —— 否则资料页里会出现 [1] [3] [4]
 *      这种缺号，读者会以为 PPT 丢了两条引用
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
    statement: over.statement ?? `知识点 ${over.id} 的表述内容。`,
    quotes: over.quotes ?? [`知识点 ${over.id} 的原文引用`],
    anchors: over.anchors ?? [anchor],
    anchorStatus: over.anchorStatus ?? 'located',
    chapter: over.chapter ?? '第一章',
    cognitiveLevel: over.cognitiveLevel ?? 'understand',
    tags: over.tags ?? [],
    backendId: over.backendId ?? 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as KnowledgePoint;
}

function makePoints(n: number, chapter = '第一章'): KnowledgePoint[] {
  return Array.from({ length: n }, (_, i) =>
    makePoint({ id: `k${i}`, statement: `第 ${i} 条知识点，内容各不相同，便于区分。`, chapter }),
  );
}

describe('SlideService：创建', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  it('从知识点创建，落库并返回大纲', async () => {
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: makePoints(3),
      title: '期末复习',
    });

    expect(deck.title).toBe('期末复习');
    expect(deck.status).toBe('outline');
    expect(deck.pages.length).toBeGreaterThan(1);
    expect(deck.citations).toHaveLength(3);

    const stored = await slides.get(deck.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(deck.id);
  });

  it('没有知识点时明确报错，不建空壳', async () => {
    await expect(
      slides.createFromPoints({ sourceId: 'src-a', points: [] }),
    ).rejects.toThrow(/没有选中的知识点/);

    // 关键：库里不能留下一个空 PPT
    expect(await slides.list()).toHaveLength(0);
  });

  it('知识点正文全空时报错并说明原因', async () => {
    await expect(
      slides.createFromPoints({
        sourceId: 'src-a',
        points: [makePoint({ id: 'k1', statement: '   ' })],
      }),
    ).rejects.toThrow(/正文都是空的/);

    expect(await slides.list()).toHaveLength(0);
  });

  it('资料不存在时用兜底标题，不抛错', async () => {
    const { deck } = await slides.createFromPoints({
      sourceId: 'not-exist',
      points: makePoints(1),
    });
    // 不因为查不到资料就拒绝生成：用户可能已经删了资料但知识点还在
    expect(deck.pages.length).toBeGreaterThan(1);
  });

  it('返回无角标要点数，界面据此如实提示', async () => {
    const points = [
      makePoint({ id: 'k1' }),
      makePoint({ id: 'k2', anchorStatus: 'unlocated', anchors: [] }),
    ];
    const r = await slides.createFromPoints({ sourceId: 'src-a', points });

    expect(r.bulletsWithoutCitation).toBe(1);
    expect(r.deck.citations).toHaveLength(1);
  });

  it('countBulletsWithoutCitation 与创建时的统计一致', async () => {
    const points = [
      makePoint({ id: 'k1' }),
      makePoint({ id: 'k2', anchorStatus: 'unlocated', anchors: [] }),
      makePoint({ id: 'k3', anchorStatus: 'unlocated', anchors: [] }),
    ];
    const { deck, bulletsWithoutCitation } = await slides.createFromPoints({
      sourceId: 'src-a',
      points,
    });

    expect(await slides.countBulletsWithoutCitation(deck.id)).toBe(bulletsWithoutCitation);
  });
});

describe('SlideService：大纲编辑', () => {
  let storage: MemoryStorage;
  let slides: SlideService;
  let deckId: string;

  beforeEach(async () => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
    const r = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(4) });
    deckId = r.deck.id;
  });

  it('改标题', async () => {
    const d = await slides.updateTitle(deckId, '新标题');
    expect(d.title).toBe('新标题');
    expect((await slides.get(deckId))!.title).toBe('新标题');
  });

  it('标题改成空白时保留原标题（不接受空标题）', async () => {
    const d = await slides.updateTitle(deckId, '   ');
    expect(d.title).not.toBe('');
  });

  it('改页标题与副标题', async () => {
    const deck = (await slides.get(deckId))!;
    const pageId = deck.pages[0].id;

    await slides.updatePageTitle(deckId, pageId, '我的封面');
    const d = await slides.updatePageSubtitle(deckId, pageId, '副标题文字');

    const p = d.pages.find((x) => x.id === pageId)!;
    expect(p.title).toBe('我的封面');
    expect(p.subtitle).toBe('副标题文字');
  });

  it('副标题清空后是 null 而不是空字符串', async () => {
    const deck = (await slides.get(deckId))!;
    const pageId = deck.pages[0].id;
    await slides.updatePageSubtitle(deckId, pageId, '有内容');
    const d = await slides.updatePageSubtitle(deckId, pageId, '  ');
    expect(d.pages.find((x) => x.id === pageId)!.subtitle).toBeNull();
  });

  it('改要点文字不动角标', async () => {
    const deck = (await slides.get(deckId))!;
    const page = deck.pages.find((p) => p.bullets.length > 0 && p.layout === 'bullets')!;
    const bullet = page.bullets[0];
    const before = bullet.citationIndex;

    const d = await slides.updateBulletText(deckId, page.id, bullet.id, '改过的文字');
    const after = d.pages.find((p) => p.id === page.id)!.bullets[0];

    expect(after.text).toBe('改过的文字');
    // 角标指的是「这条要点依据哪段原文」，与措辞无关
    expect(after.citationIndex).toBe(before);
  });

  it('封面页不能删除', async () => {
    const deck = (await slides.get(deckId))!;
    const titlePage = deck.pages.find((p) => p.layout === 'title')!;

    await expect(slides.removePage(deckId, titlePage.id)).rejects.toThrow(/封面页不能删除/);
    expect((await slides.get(deckId))!.pages).toHaveLength(deck.pages.length);
  });

  it('封面页不能移动', async () => {
    const deck = (await slides.get(deckId))!;
    const titlePage = deck.pages[0];

    await expect(slides.movePage(deckId, titlePage.id, 1)).rejects.toThrow(/封面页固定/);
  });

  it('普通页可以上移下移', async () => {
    const d0 = await slides.createFromPoints({
      sourceId: 'src-a',
      points: makePoints(12), // 需要多页才有得移
    });
    const initial = d0.deck.pages.map((p) => p.id);
    // 取第一个非封面的页
    const movable = d0.deck.pages[1];

    const d = await slides.movePage(d0.deck.id, movable.id, 1);
    const moved = d.pages.map((p) => p.id);

    expect(moved[0]).toBe(initial[0]); // 封面还在第一位
    expect(moved[2]).toBe(movable.id);
  });

  it('移到边界外时安静地不做（不抛错、不损坏顺序）', async () => {
    const deck = (await slides.get(deckId))!;
    const last = deck.pages[deck.pages.length - 1];

    const d = await slides.movePage(deckId, last.id, 1);
    expect(d.pages).toHaveLength(deck.pages.length);
  });

  it('加页、加要点、删要点', async () => {
    const d1 = await slides.addPage(deckId);
    const newPage = d1.pages[d1.pages.length - 1];
    expect(newPage.layout).toBe('bullets');

    const d2 = await slides.addBullet(deckId, newPage.id, '我自己写的一条');
    const bullet = d2.pages.find((p) => p.id === newPage.id)!.bullets[0];
    // 手写要点没有出处，不该被安一个角标
    expect(bullet.citationIndex).toBeNull();

    const d3 = await slides.removeBullet(deckId, newPage.id, bullet.id);
    expect(d3.pages.find((p) => p.id === newPage.id)!.bullets).toHaveLength(0);
  });

  it('加空要点被拒绝', async () => {
    const deck = (await slides.get(deckId))!;
    const bulletsPage = deck.pages.find((p) => p.layout === 'bullets')!;
    await expect(slides.addBullet(deckId, bulletsPage.id, '   ')).rejects.toThrow(/不能为空/);
  });

  it('往封面页加要点被拒绝', async () => {
    const deck = (await slides.get(deckId))!;
    const titlePage = deck.pages.find((p) => p.layout === 'title')!;
    await expect(slides.addBullet(deckId, titlePage.id, '文字')).rejects.toThrow(/只有「要点页」/);
  });
});

describe('SlideService：角标重排', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  it('删掉一个要点后，角标编号连续不留空号', async () => {
    const { deck } = await slides.createFromPoints({
      sourceId: 'src-a',
      points: makePoints(3),
    });
    const page = deck.pages.find((p) => p.bullets.length === 3)!;
    expect(deck.citations.map((c) => c.index)).toEqual([1, 2, 3]);

    // 删掉第一条要点（角标 1）
    const d = await slides.removeBullet(deck.id, page.id, page.bullets[0].id);

    // 剩两条，编号必须是 1、2，而不是 2、3
    expect(d.citations.map((c) => c.index)).toEqual([1, 2]);
    const remaining = d.pages.find((p) => p.id === page.id)!.bullets;
    expect(remaining.map((b) => b.citationIndex)).toEqual([1, 2]);
  });

  it('删页后该页独占的角标被移除，编号重排', async () => {
    // 造两页、每页一条独占要点
    const points = makePoints(10);
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points });

    const bulletPages = deck.pages.filter((p) => p.layout === 'bullets');
    expect(bulletPages.length).toBeGreaterThan(1);

    const firstPage = bulletPages[0];
    // 这一页有几条要点，就预计少几条引用
    const removedCount = firstPage.bullets.filter((b) => b.citationIndex !== null).length;
    expect(removedCount).toBeGreaterThan(0);
    const before = deck.citations.length;

    const d = await slides.removePage(deck.id, firstPage.id);

    // 引用条数减少了被删页独占的那几条
    expect(d.citations.length).toBe(before - removedCount);

    // 剩下的编号必须连续 1..n（重排过，不是留着空缺）
    expect(d.citations.map((c) => c.index)).toEqual(
      Array.from({ length: d.citations.length }, (_, i) => i + 1),
    );

    // 每个要点指向的编号都仍然有效
    const valid = new Set(d.citations.map((c) => c.index));
    for (const p of d.pages) {
      for (const b of p.bullets) {
        if (b.citationIndex !== null) expect(valid.has(b.citationIndex)).toBe(true);
      }
    }
  });

  it('重排后所有要点仍指向存在的引用', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(8) });
    const page = deck.pages.find((p) => p.layout === 'bullets')!;

    const d = await slides.removeBullet(deck.id, page.id, page.bullets[0].id);

    const validIds = new Set(d.citations.map((c) => c.index));
    for (const p of d.pages) {
      for (const b of p.bullets) {
        if (b.citationIndex !== null) {
          // 不能出现指向不存在引用的角标
          expect(validIds.has(b.citationIndex)).toBe(true);
        }
      }
    }
  });
});

describe('SlideService：导出', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  it('导出产出可解析的 pptx 字节', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(3) });
    const out = await slides.export(deck.id);

    expect(out.buffer.byteLength).toBeGreaterThan(5000);
    // pptx 是 zip，头两字节必须是 PK
    expect(out.buffer[0]).toBe(0x50); // P
    expect(out.buffer[1]).toBe(0x4b); // K
    expect(out.slideCount).toBeGreaterThan(1);
    expect(out.fileName).toMatch(/\.pptx$/);
  });

  it('导出的页数与 getPlan 的长度一致（预览=导出）', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(20) });
    const plan = await slides.getPlan(deck.id);
    const out = await slides.export(deck.id);

    expect(out.slideCount).toBe(plan.length);
  });

  it('stats 报的页数与实际导出页数一致', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(15) });
    const stats = await slides.stats(deck.id);
    const out = await slides.export(deck.id);

    expect(stats.total).toBe(out.slideCount);
  });

  it('每次导出都追加记录，文件名带版本号不覆盖', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(3) });

    const e1 = await slides.export(deck.id);
    const e2 = await slides.export(deck.id);
    const e3 = await slides.export(deck.id);

    expect(e1.fileName).toContain('第1版');
    expect(e2.fileName).toContain('第2版');
    expect(e3.fileName).toContain('第3版');

    const stored = (await slides.get(deck.id))!;
    expect(stored.exports).toHaveLength(3);
    expect(stored.exports[0].fileName).toBe(e1.fileName);
    expect(stored.exports[2].fileName).toBe(e3.fileName);
  });

  it('导出记录存了页数与字节数，便于界面如实显示', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(3) });
    await slides.export(deck.id);

    const rec = (await slides.get(deck.id))!.exports[0];
    expect(rec.slideCount).toBeGreaterThan(1);
    expect(rec.byteSize).toBeGreaterThan(5000);
    expect(new Date(rec.exportedAt).getTime()).toBeGreaterThan(0);
  });

  it('只有封面时拒绝导出并说明原因', async () => {
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(1) });
    // 手工把正文页全删掉，只留封面
    const d = (await slides.get(deck.id))!;
    for (const p of d.pages.filter((x) => x.layout !== 'title')) {
      await slides.removePage(deck.id, p.id);
    }

    await expect(slides.export(deck.id)).rejects.toThrow(/只有封面页/);
    // 失败不能留下导出记录
    expect((await slides.get(deck.id))!.exports).toHaveLength(0);
  });

  it('导出不存在的 PPT 时给出可理解的错误', async () => {
    await expect(slides.export('not-exist')).rejects.toThrow(/已经不存在/);
  });
});

describe('SlideService：确认与删除', () => {
  it('confirm 把 outline 改成 ready', async () => {
    const storage = new MemoryStorage();
    const slides = new SlideService(storage);
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(2) });

    expect(deck.status).toBe('outline');
    const d = await slides.confirm(deck.id);
    expect(d.status).toBe('ready');
  });

  it('删除后 list 里不再出现', async () => {
    const storage = new MemoryStorage();
    const slides = new SlideService(storage);
    const { deck } = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(2) });

    await slides.remove(deck.id);
    expect(await slides.get(deck.id)).toBeNull();
    expect(await slides.list()).toHaveLength(0);
  });

  it('list 按更新时间倒序（最近改的在前）', async () => {
    const storage = new MemoryStorage();
    const slides = new SlideService(storage);
    const a = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(1), title: 'A' });
    const b = await slides.createFromPoints({ sourceId: 'src-a', points: makePoints(1), title: 'B' });

    // 改 A 让它变新
    await new Promise((r) => setTimeout(r, 5));
    await slides.updateTitle(a.deck.id, 'A 改过');

    const list = await slides.list();
    expect(list[0].id).toBe(a.deck.id);
    expect(list[1].id).toBe(b.deck.id);
  });
});

describe('buildFileName', () => {
  it('含标题、时间、版本号', () => {
    const at = new Date(2026, 10, 5, 10, 32); // 2026-11-05 10:32
    const name = buildFileName('信号与系统', 2, at);

    expect(name).toBe('信号与系统-20261105-1032-第2版.pptx');
  });

  it('清掉 Windows 非法字符', () => {
    const at = new Date(2026, 0, 1, 0, 0);
    const name = buildFileName('第1章/概述:要点?', 1, at);

    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain('第1章');
  });

  it('标题为空时用兜底名（不生成「-20260101-0000-第1版.pptx」）', () => {
    const at = new Date(2026, 0, 1, 0, 0);
    const name = buildFileName('   ', 1, at);

    expect(name.startsWith('-')).toBe(false);
    expect(name).toBe('学习PPT-20260101-0000-第1版.pptx');
  });

  it('超长标题截断到 60 字，避免路径过长', () => {
    const at = new Date(2026, 0, 1, 0, 0);
    const name = buildFileName('长'.repeat(200), 1, at);

    expect(name.length).toBeLessThan(100);
  });
});
