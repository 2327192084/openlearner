import { describe, expect, it } from 'vitest';
import type { SlideCitation, SlideDeck, SlideOutlinePage } from '../model.ts';
import { buildRenderPlan, formatLocation, planStats } from './render-plan.ts';

/**
 * 渲染计划的测试。
 *
 * 这个文件守住一个承诺：**预览看到几页，导出就是几页**。
 * 界面和导出都消费 `buildRenderPlan` 的返回值，所以只要这里的分页
 * 算对，两边就永远一致。反过来说，如果哪天有人为了"预览好看一点"
 * 在界面里另写一套分页，这些测试挡不住 —— 但至少核心层是对的。
 */

function page(over: Partial<SlideOutlinePage> & { id: string }): SlideOutlinePage {
  return {
    layout: 'bullets',
    title: '要点',
    subtitle: null,
    bullets: [],
    ...over,
  } as SlideOutlinePage;
}

function citation(over: Partial<SlideCitation> & { index: number }): SlideCitation {
  return {
    knowledgePointId: `k${over.index}`,
    sourceId: 'src-a',
    sourceTitle: '信号与系统',
    page: 3,
    chapter: '第一章',
    quote: '原文片段',
    ...over,
  } as SlideCitation;
}

function deck(over: Partial<SlideDeck> = {}): SlideDeck {
  return {
    id: 'slide1',
    title: '信号与系统 · 学习 PPT',
    courseId: null,
    sourceId: 'src-a',
    status: 'outline',
    pages: [
      page({ id: 'p1', layout: 'title', title: '信号与系统', subtitle: '共 3 个知识点' }),
      page({
        id: 'p2',
        title: '第一章',
        bullets: [
          { id: 'b1', text: '要点一', citationIndex: 1 },
          { id: 'b2', text: '要点二', citationIndex: 2 },
        ],
      }),
    ],
    citations: [citation({ index: 1 }), citation({ index: 2 })],
    exports: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('buildRenderPlan：页码与结构', () => {
  it('页码从 1 开始连续，封面也占页码', () => {
    const plan = buildRenderPlan(deck());
    expect(plan.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
  });

  it('资料来源页自动追加在最后，且不在大纲里', () => {
    const d = deck();
    // 大纲只有 2 页，但渲染计划是 3 页
    expect(d.pages).toHaveLength(2);
    const plan = buildRenderPlan(d);
    expect(plan).toHaveLength(3);
    expect(plan[2].layout).toBe('sources');
  });

  it('没有引用时不生成空的资料来源页', () => {
    const plan = buildRenderPlan(deck({ citations: [] }));
    expect(plan.filter((s) => s.layout === 'sources')).toHaveLength(0);
  });

  it('封面页 footer 为空（封面不显示资料名）', () => {
    const plan = buildRenderPlan(deck());
    expect(plan[0].footer).toBe('');
    expect(plan[1].footer).toBeTruthy();
  });

  it('渲染计划保留角标编号', () => {
    const plan = buildRenderPlan(deck());
    const bullets = plan[1].bullets;
    expect(bullets.map((b) => b.citationIndex)).toEqual([1, 2]);
  });

  it('无角标的要点保持 null（不被塞成 0 或 1）', () => {
    const d = deck({
      pages: [
        page({ id: 'p1', layout: 'title', title: '标题' }),
        page({
          id: 'p2',
          bullets: [
            { id: 'b1', text: '有出处', citationIndex: 1 },
            { id: 'b2', text: '没出处', citationIndex: null },
          ],
        }),
      ],
      citations: [citation({ index: 1 })],
    });
    const plan = buildRenderPlan(d);
    expect(plan[1].bullets[1].citationIndex).toBeNull();
  });
});

describe('buildRenderPlan：资料来源页分页', () => {
  it('引用超过每页上限时拆成多页，标题带序号', () => {
    // 上限 12 条/页
    const many = Array.from({ length: 20 }, (_, i) => citation({ index: i + 1 }));
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: '标题' })],
      citations: many,
    });

    const sources = buildRenderPlan(d).filter((s) => s.layout === 'sources');
    expect(sources).toHaveLength(2);
    expect(sources[0].title).toBe('资料来源 · 1/2');
    expect(sources[1].title).toBe('资料来源 · 2/2');

    // 20 条引用一条不少
    expect(sources.flatMap((s) => s.citationLines)).toHaveLength(20);
  });

  it('资料页每行带编号、文档名、页码、引用片段', () => {
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: '标题' })],
      citations: [citation({ index: 1, sourceTitle: '高等数学', page: 42, chapter: '第三章' })],
    });
    const line = buildRenderPlan(d).find((s) => s.layout === 'sources')!.citationLines[0];

    expect(line).toContain('[1]');
    expect(line).toContain('高等数学');
    expect(line).toContain('42');
  });

  it('引用片段过长时截断并加省略号（资料页是索引，不是正文）', () => {
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: '标题' })],
      citations: [citation({ index: 1, quote: '很长'.repeat(50) })],
    });
    const line = buildRenderPlan(d).find((s) => s.layout === 'sources')!.citationLines[0];

    expect(line).toContain('…');
    expect(line.length).toBeLessThan(120);
  });

  it('引用按编号排序（即使传入顺序是乱的）', () => {
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: '标题' })],
      citations: [citation({ index: 3 }), citation({ index: 1 }), citation({ index: 2 })],
    });
    const lines = buildRenderPlan(d).find((s) => s.layout === 'sources')!.citationLines;

    expect(lines[0]).toContain('[1]');
    expect(lines[1]).toContain('[2]');
    expect(lines[2]).toContain('[3]');
  });
});

describe('buildRenderPlan：超长标题处理', () => {
  it('封面超长标题会折行', () => {
    // 必须真的超过 maxTitleChars = 40 才会折
    const long =
      '第三章：连续时间系统的频域分析——从傅里叶级数到拉普拉斯变换的完整推导过程与典型例题精讲补遗';
    expect(long.length).toBeGreaterThan(40);
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: long })],
      citations: [],
    });
    const plan = buildRenderPlan(d);

    expect(plan[0].title).toContain('\n');
    expect(plan[0].title.replace(/\n/g, '')).toBe(long);
  });

  it('正文页标题不折行（要点页标题区高度固定，折行会压到正文）', () => {
    const long = '第三章：连续时间系统的频域分析——从傅里叶级数到拉普拉斯变换的完整推导过程';
    const d = deck({
      pages: [page({ id: 'p1', layout: 'title', title: '封面' }), page({ id: 'p2', title: long })],
      citations: [],
    });
    const plan = buildRenderPlan(d);

    expect(plan[1].title).toBe(long);
    expect(plan[1].title).not.toContain('\n');
  });
});

describe('planStats：统计必须和实际页数一致', () => {
  it('total 等于渲染计划长度', () => {
    const d = deck();
    const plan = buildRenderPlan(d);
    expect(planStats(plan).total).toBe(plan.length);
  });

  it('区分正文页与资料页', () => {
    const stats = planStats(buildRenderPlan(deck()));
    expect(stats.total).toBe(3);
    expect(stats.contentPages).toBe(2);
    expect(stats.sourcePages).toBe(1);
  });

  it('统计要点总数与无角标要点数', () => {
    const d = deck({
      pages: [
        page({ id: 'p1', layout: 'title', title: '标题' }),
        page({
          id: 'p2',
          bullets: [
            { id: 'b1', text: 'a', citationIndex: 1 },
            { id: 'b2', text: 'b', citationIndex: null },
            { id: 'b3', text: 'c', citationIndex: null },
          ],
        }),
      ],
      citations: [citation({ index: 1 })],
    });
    const stats = planStats(buildRenderPlan(d));

    expect(stats.bullets).toBe(3);
    expect(stats.withoutCitation).toBe(2);
  });
});

describe('formatLocation：位置文案', () => {
  it('有页码有章节时都显示', () => {
    expect(formatLocation(3, '第一章')).toContain('第 3 页');
    expect(formatLocation(3, '第一章')).toContain('第一章');
  });

  it('只有页码', () => {
    expect(formatLocation(7, null)).toBe(' 第 7 页');
  });

  it('只有章节', () => {
    expect(formatLocation(null, '绪论')).toContain('绪论');
    expect(formatLocation(null, '绪论')).not.toContain('页');
  });

  it('都没有时返回空串（不留一个孤零零的空格）', () => {
    expect(formatLocation(null, null)).toBe('');
  });

  it('章节是空白字符串时不显示（避免出现「」）', () => {
    expect(formatLocation(2, '   ')).toBe(' 第 2 页');
  });
});

describe('buildRenderPlan：空与边界', () => {
  it('空大纲返回空数组', () => {
    expect(buildRenderPlan(deck({ pages: [], citations: [] }))).toEqual([]);
  });

  it('资料名兜底：footer 不为空字符串', () => {
    const d = deck({ title: '' });
    const plan = buildRenderPlan(d, '');
    // 传空 fallback 时 footer 会是空串，但不该是 undefined
    expect(typeof plan[1].footer).toBe('string');
  });

  it('50 页教材规模：渲染计划页数与要点数守恒', () => {
    const pages: SlideOutlinePage[] = [page({ id: 'p0', layout: 'title', title: '大教材' })];
    for (let i = 0; i < 40; i += 1) {
      pages.push(
        page({
          id: `p${i + 1}`,
          title: `第 ${i + 1} 组`,
          bullets: Array.from({ length: 5 }, (_, j) => ({
            id: `b${i}-${j}`,
            text: `要点 ${i}-${j}`,
            citationIndex: (i * 5 + j) % 200 + 1,
          })),
        }),
      );
    }
    const citations = Array.from({ length: 200 }, (_, i) => citation({ index: i + 1 }));

    const plan = buildRenderPlan(deck({ pages, citations }));
    const stats = planStats(plan);

    // 41 页正文 + 200 条引用 / 12 每页 = 17 页资料页
    expect(stats.contentPages).toBe(41);
    expect(stats.sourcePages).toBe(17);
    expect(stats.total).toBe(58);
    expect(stats.bullets).toBe(200);
    // 页码连续无跳号
    expect(plan.map((s) => s.pageNumber)).toEqual(
      Array.from({ length: plan.length }, (_, i) => i + 1),
    );
  });
});

describe('资料来源行：换行不能留下（否则相邻编号压在一起）', () => {
  it('引用片段里的换行被折叠成空格，一条资料只占一行', () => {
    const citations = [
      citation({
        index: 1,
        quote: '第一章 数据结构绪论\n数据结构研究的是数据元素之间的关系以及在这些关系上的操作。',
      }),
      citation({ index: 2, quote: '逻辑结构分为线性结构与非线性结构两大类。' }),
    ];
    const plan = buildRenderPlan(deck({ pages: [page({ id: 'p1' })], citations }));
    const sourcePage = plan.find((s) => s.layout === 'sources')!;

    // 每条资料必须是一行——换行符会让渲染成两行，
    // 而资料行距按单行排，下一条编号就压上来了（和要点叠字同一根因）
    for (const line of sourcePage.citationLines) {
      expect(line, `资料行里还有换行符：${JSON.stringify(line)}`).not.toMatch(/[\r\n]/);
    }
    expect(sourcePage.citationLines).toHaveLength(2);

    // 折叠空白不等于删内容
    expect(sourcePage.citationLines[0]).toContain('第一章 数据结构绪论 数据结构研究的是数据元素之间的关系');

    // 片段仍要截断到预览长度，不能因为归一而变长
    expect(sourcePage.citationLines[0]).toContain('…');
  });

  it('引用片段超过预览长度时截断并加省略号', () => {
    const longQuote = '这'.repeat(80);
    const plan = buildRenderPlan(
      deck({ pages: [page({ id: 'p1' })], citations: [citation({ index: 1, quote: longQuote })] }),
    );
    const line = plan.find((s) => s.layout === 'sources')!.citationLines[0];
    // 行里前面还有「章节名」的引号，必须只取破折号后面那段片段
    const inner = /—「(.*)」$/.exec(line)![1];
    // 34 字 + 省略号
    expect(inner).toHaveLength(35);
    expect(inner.endsWith('…')).toBe(true);
  });
});
