import { describe, expect, it } from 'vitest';
import type { KnowledgePoint, SourceLocation } from '../model.ts';
import { buildOutline } from './outline.ts';

/**
 * 大纲生成的单元测试。
 *
 * 这里要守住的核心是 P4 验收第 3 条的精神：
 * **每条要点带引用角标，且角标指向的位置是真的**。
 *
 * 最容易犯的错是"给每条要点都安一个角标，凑齐了看起来完整"。
 * 所以下面有一半的用例在断言**什么情况下不给角标**。
 */

/** 造一个知识点，只填测试关心的字段 */
function point(over: Partial<KnowledgePoint> & { id: string }): KnowledgePoint {
  const anchor: SourceLocation = {
    sourceId: 'src-a',
    page: 3,
    chapter: '第一章',
    charStart: 0,
    charEnd: 20,
  };
  return {
    sourceId: 'src-a',
    statement: over.statement ?? '这是一条知识点的表述。',
    quotes: over.quotes ?? ['这是一条知识点的原文引用'],
    anchors: over.anchors ?? [anchor],
    anchorStatus: over.anchorStatus ?? 'located',
    chapter: over.chapter ?? '第一章',
    cognitiveLevel: over.cognitiveLevel ?? 'understand',
    tags: over.tags ?? [],
    backendId: over.backendId ?? 'mock',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00.000Z',
    ...over,
  } as KnowledgePoint;
}

describe('buildOutline：基本结构', () => {
  it('总是先出封面页', () => {
    const r = buildOutline({ points: [point({ id: 'k1' })], sourceTitle: '信号与系统' });
    expect(r.pages[0].layout).toBe('title');
    expect(r.pages[0].title).toContain('信号与系统');
  });

  it('封面副标题带知识点数量', () => {
    const r = buildOutline({
      points: [point({ id: 'k1' }), point({ id: 'k2' })],
      sourceTitle: '高等数学',
    });
    expect(r.pages[0].subtitle).toContain('2 个知识点');
  });

  it('指定标题时用指定标题，不用资料名', () => {
    const r = buildOutline({
      points: [point({ id: 'k1' })],
      sourceTitle: '信号与系统',
      title: '期末冲刺版',
    });
    expect(r.pages[0].title).toBe('期末冲刺版');
  });

  it('单章节不插章节过渡页（只有一章时过渡页像卡住）', () => {
    const points = [
      point({ id: 'k1', chapter: '第一章' }),
      point({ id: 'k2', chapter: '第一章' }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });
    expect(r.pages.filter((p) => p.layout === 'section')).toHaveLength(0);
  });

  it('多章节插章节过渡页', () => {
    const points = [
      point({ id: 'k1', chapter: '第一章' }),
      point({ id: 'k2', chapter: '第二章' }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });
    const sections = r.pages.filter((p) => p.layout === 'section');
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.title)).toEqual(['第一章', '第二章']);
  });

  it('章节顺序按知识点出现顺序，不按字母序', () => {
    // 「第三章」在「第一章」前面出现时，第三章先出
    const points = [
      point({ id: 'k1', chapter: '第三章' }),
      point({ id: 'k2', chapter: '第一章' }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });
    const sections = r.pages.filter((p) => p.layout === 'section');
    expect(sections.map((s) => s.title)).toEqual(['第三章', '第一章']);
  });

  it('没有章节名的知识点归为「未分章」', () => {
    const r = buildOutline({
      points: [point({ id: 'k1', chapter: null as unknown as string })],
      sourceTitle: '资料',
    });
    const bulletsPage = r.pages.find((p) => p.layout === 'bullets');
    expect(bulletsPage?.title).toBe('未分章');
  });
});

describe('buildOutline：角标与引用', () => {
  it('已定位的知识点生成角标，编号从 1 开始连续', () => {
    const points = [point({ id: 'k1' }), point({ id: 'k2' }), point({ id: 'k3' })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.citations).toHaveLength(3);
    expect(r.citations.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('角标的页码从知识点 anchors 原样继承，不重新猜', () => {
    const points = [
      point({
        id: 'k1',
        anchors: [{ sourceId: 'src-a', page: 17, chapter: '第二章', charStart: 0, charEnd: 5 }],
      }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.citations[0].page).toBe(17);
    expect(r.citations[0].chapter).toBe('第二章');
  });

  it('角标带原文引用片段，便于资料页核对', () => {
    const points = [point({ id: 'k1', quotes: ['采样定理指出采样频率须大于两倍最高频率'] })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.citations[0].quote).toBe('采样定理指出采样频率须大于两倍最高频率');
  });

  it('未定位的知识点：要点照常生成，但没有角标', () => {
    const points = [point({ id: 'k1', anchorStatus: 'unlocated', anchors: [] })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].citationIndex).toBeNull();
    // 关键：不建引用记录，不给假角标
    expect(r.citations).toHaveLength(0);
    expect(r.bulletsWithoutCitation).toBe(1);
  });

  it('豁免的知识点同样不给角标', () => {
    const points = [point({ id: 'k1', anchorStatus: 'waived', anchors: [] })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.citations).toHaveLength(0);
    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets[0].citationIndex).toBeNull();
  });

  it('标为 located 但 anchors 为空：仍然不给角标（状态和事实不符时信事实）', () => {
    // 这是脏数据的典型形态：状态说定位了，实际没有位置。
    // 相信状态会造出一个点不通的角标。
    const points = [point({ id: 'k1', anchorStatus: 'located', anchors: [] })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.citations).toHaveLength(0);
    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets[0].citationIndex).toBeNull();
  });

  it('同一条知识点拆出的多条要点共用一个角标编号', () => {
    // 一条很长但有标点的表述：必须真的超过单条上限（88 字）才会被拆
    const long =
      '第一句话说明这件事的基本定义以及它在整个学科中的位置和意义。' +
      '第二句话说明它成立所需要的前提条件，特别是那些容易被忽略的边界情况。' +
      '第三句话说明它的适用范围，以及在什么情况下会失效。' +
      '第四句话说明初学者最常见的三种错误理解方式。' +
      '第五句话给一个具体的反例来说明上面这些要点。';
    expect(long.length).toBeGreaterThan(88);
    const points = [point({ id: 'k1', statement: long })];
    const r = buildOutline({ points, sourceTitle: '资料' });

    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets.length).toBeGreaterThan(1);

    // 所有拆出来的要点角标编号必须一致
    const nums = new Set(bullets.map((b) => b.citationIndex));
    expect(nums.size).toBe(1);
    // 引用表也只有一条
    expect(r.citations).toHaveLength(1);
  });

  it('引用编号在混合情况下仍然连续（未定位的要点不占号）', () => {
    const points = [
      point({ id: 'k1' }),
      point({ id: 'k2', anchorStatus: 'unlocated', anchors: [] }),
      point({ id: 'k3' }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });

    // 只有两条建了引用，编号 1、2，中间不留空号
    expect(r.citations.map((c) => c.index)).toEqual([1, 2]);
    expect(r.bulletsWithoutCitation).toBe(1);
  });

  it('跨资料引用：sourceTitle 按 sourceId 查表取，取不到才回退', () => {
    const points = [
      point({
        id: 'k1',
        sourceId: 'src-b',
        anchors: [{ sourceId: 'src-b', page: 9,  charStart: 0, charEnd: 5 }],
      }),
    ];
    const r = buildOutline({
      points,
      sourceTitle: '主资料',
      sourceTitles: new Map([['src-b', '另一本书']]),
    });

    expect(r.citations[0].sourceTitle).toBe('另一本书');
  });

  it('查不到资料标题时回退到主资料名（不留空字符串）', () => {
    const points = [
      point({
        id: 'k1',
        sourceId: 'src-unknown',
        anchors: [{ sourceId: 'src-unknown', page: 1,  charStart: 0, charEnd: 5 }],
      }),
    ];
    const r = buildOutline({ points, sourceTitle: '主资料' });
    expect(r.citations[0].sourceTitle).toBe('主资料');
  });
});

describe('buildOutline：分页上限', () => {
  it('要点超过每页上限时拆成续页，不截断', () => {
    const points = Array.from({ length: 5 }, (_, i) =>
      point({ id: `k${i}`, statement: `第 ${i} 条独立的知识点表述。` }),
    );
    const r = buildOutline({ points, sourceTitle: '资料' });

    const bulletPages = r.pages.filter((p) => p.layout === 'bullets');
    // 5 条正好一页（上限 5）
    expect(bulletPages).toHaveLength(1);

    // 再加一条就变两页
    const r2 = buildOutline({
      points: [...points, point({ id: 'k9', statement: '第六条。' })],
      sourceTitle: '资料',
    });
    const pages2 = r2.pages.filter((p) => p.layout === 'bullets');
    expect(pages2).toHaveLength(2);
    expect(pages2[1].title).toContain('续');

    // 全部要点都在，一条不少
    const all = pages2.flatMap((p) => p.bullets);
    expect(all).toHaveLength(6);
  });

  it('空正文的知识点被跳过并计数', () => {
    const points = [
      point({ id: 'k1', statement: '有内容。' }),
      point({ id: 'k2', statement: '   ' }),
      point({ id: 'k3', statement: '' }),
    ];
    const r = buildOutline({ points, sourceTitle: '资料' });

    expect(r.skippedPoints).toBe(2);
    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets).toHaveLength(1);
  });

  it('50 页教材规模：200 条知识点不崩且要点数守恒', () => {
    // 计划书要求「50 页教材一次生成不崩」
    const points = Array.from({ length: 200 }, (_, i) =>
      point({
        id: `k${i}`,
        statement: `第 ${i} 条知识点，说明一个具体的概念，长度适中。`,
        chapter: `第${Math.floor(i / 20) + 1}章`,
      }),
    );
    const r = buildOutline({ points, sourceTitle: '大教材' });

    const bullets = r.pages.filter((p) => p.layout === 'bullets').flatMap((p) => p.bullets);
    expect(bullets).toHaveLength(200);
    expect(r.citations).toHaveLength(200);

    // 每页不超过上限
    for (const page of r.pages.filter((p) => p.layout === 'bullets')) {
      expect(page.bullets.length).toBeLessThanOrEqual(5);
    }

    // 10 个章节 → 10 个过渡页
    expect(r.pages.filter((p) => p.layout === 'section')).toHaveLength(10);
  });
});

describe('buildOutline：边界', () => {
  it('没有任何知识点时只出封面页', () => {
    const r = buildOutline({ points: [], sourceTitle: '空资料' });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].layout).toBe('title');
    expect(r.citations).toHaveLength(0);
  });

  it('资料标题为空时用「学习资料」兜底', () => {
    const r = buildOutline({ points: [point({ id: 'k1' })], sourceTitle: '' });
    expect(r.pages[0].subtitle).toContain('学习资料');
  });

  it('每条要点都有唯一 id（界面要按 id 做增删）', () => {
    const points = Array.from({ length: 12 }, (_, i) =>
      point({ id: `k${i}`, statement: `第 ${i} 条。` }),
    );
    const r = buildOutline({ points, sourceTitle: '资料' });

    const ids = r.pages.flatMap((p) => p.bullets.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);

    const pageIds = r.pages.map((p) => p.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });
});
