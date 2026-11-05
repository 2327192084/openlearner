import { describe, expect, it } from 'vitest';
import type { KnowledgePoint, SlideCitation } from '../model.ts';
import { assembleTemplate, planTemplate } from './template.ts';
import type { TemplateContentItem } from './template.ts';
import { buildRenderPlan } from './render-plan.ts';
import type { SlideDeck } from '../model.ts';

/**
 * 固定版式模板的测试。
 *
 * 守的是一件事：**用户什么都不填时，每次跑出来的结构必须一样。**
 * 这是「可预期」的全部含义。如果页数、顺序随模型发挥而变，
 * 用户就没法照着它准备讲课，也没法比较两次生成的差别。
 */

function point(id: string, chapter: string | null, page = 1): KnowledgePoint {
  return {
    id,
    statement: `知识点 ${id}`,
    quotes: [`引用 ${id}`],
    cognitiveLevel: 'understand',
    tags: [],
    chapter,
    sourceId: 'src_1',
    origin: 'material',
    anchors: [{ sourceId: 'src_1', page, charStart: 0, charEnd: 5, chapter }],
    anchorStatus: 'located',
    backendId: null,
    approved: true,
    createdAt: '',
    updatedAt: '',
  } as KnowledgePoint;
}

/** 给每条知识点造一份 AI 内容 */
function contentFor(points: KnowledgePoint[]): Map<string, TemplateContentItem> {
  return new Map(
    points.map((p) => [p.id, { fromPointId: p.id, title: `${p.chapter} 要点`, bullet: `讲解 ${p.id}` }]),
  );
}

/** 角标函数：用知识点顺序当编号 */
function citationOf(points: KnowledgePoint[]) {
  const map = new Map(points.map((p, i) => [p.id, i + 1]));
  return (p: KnowledgePoint) => map.get(p.id) ?? null;
}

describe('planTemplate：章节分组', () => {
  it('按章节分组，顺序按第一次出现', () => {
    const points = [point('a', '第一章'), point('b', '第二章'), point('c', '第一章')];
    const plan = planTemplate(points);

    expect(plan.chapters.map((c) => c.name)).toEqual(['第一章', '第二章']);
    // 同一章的知识点归到一起，不按输入顺序拆散
    expect(plan.chapters[0]!.points.map((p) => p.id)).toEqual(['a', 'c']);
    expect(plan.chapters[1]!.points.map((p) => p.id)).toEqual(['b']);
  });

  it('没有章节名的归到「主要内容」', () => {
    const plan = planTemplate([point('a', null)]);
    expect(plan.chapters[0]!.name).toBe('主要内容');
  });

  it('只有一章时不插章节过渡页', () => {
    const plan = planTemplate([point('a', '第一章'), point('b', '第一章')]);
    // 一章还要插过渡页，用户会觉得「翻了一页什么都没有」
    expect(plan.needsSectionPages).toBe(false);
  });

  it('多章时插章节过渡页', () => {
    const plan = planTemplate([point('a', '第一章'), point('b', '第二章')]);
    expect(plan.needsSectionPages).toBe(true);
  });

  it('空 statement 的知识点被跳过', () => {
    const empty = { ...point('x', '第一章'), statement: '   ' } as KnowledgePoint;
    const plan = planTemplate([point('a', '第一章'), empty]);
    expect(plan.chapters[0]!.points).toHaveLength(1);
  });
});

describe('assembleTemplate：结构必须可预期', () => {
  it('单章：封面 → 要点页', () => {
    const points = [point('a', '第一章'), point('b', '第一章')];
    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: contentFor(points),
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    expect(pages.map((p) => p.layout)).toEqual(['title', 'bullets']);
  });

  it('多章：封面 → 章节页 → 要点页 → 章节页 → 要点页', () => {
    const points = [point('a', '第一章'), point('b', '第二章')];
    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: contentFor(points),
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    expect(pages.map((p) => p.layout)).toEqual([
      'title',
      'section',
      'bullets',
      'section',
      'bullets',
    ]);
  });

  it('总结页固定放最后', () => {
    const points = [point('a', '第一章')];
    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: contentFor(points),
      summary: { title: '总结', bullets: ['要点一', '要点二'] },
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    expect(pages.at(-1)!.title).toBe('总结');
    // 总结不是引用内容，不该有角标
    expect(pages.at(-1)!.bullets.every((b) => b.citationIndex === null)).toBe(true);
  });

  it('同样的输入两次得到同样的结构（这是「可预期」的定义）', () => {
    const points = [point('a', '第一章'), point('b', '第二章'), point('c', '第二章')];
    const build = () =>
      assembleTemplate({
        plan: planTemplate(points),
        content: contentFor(points),
        summary: { title: '总结', bullets: ['x'] },
        deckTitle: 'T',
        sourceTitle: 'S',
        citationOf: citationOf(points),
      }).map((p) => `${p.layout}:${p.title}`);

    expect(build()).toEqual(build());
  });

  it('要点超过每页上限时拆成续页', () => {
    const points = Array.from({ length: 12 }, (_, i) => point(`k${i}`, '第一章'));
    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: contentFor(points),
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    const bulletPages = pages.filter((p) => p.layout === 'bullets');
    expect(bulletPages.length).toBe(3);
    expect(bulletPages[1]!.title).toContain('（续）');
  });

  it('AI 没写内容的知识点被跳过，不退回原文（避免同页两种语气）', () => {
    const points = [point('a', '第一章'), point('b', '第一章')];
    const partial = new Map<string, TemplateContentItem>([
      ['a', { fromPointId: 'a', title: 'T', bullet: '只有 a' }],
    ]);

    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: partial,
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    const bullets = pages.find((p) => p.layout === 'bullets')!.bullets;
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.text).toBe('只有 a');
  });

  it('一章全部没有内容时整章跳过，不产出空页', () => {
    const points = [point('a', '第一章'), point('b', '第二章')];
    const onlyA = new Map<string, TemplateContentItem>([
      ['a', { fromPointId: 'a', title: 'T', bullet: 'a 的内容' }],
    ]);

    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: onlyA,
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    // 第二章没有任何内容 → 章节页和要点页都不该出现
    expect(pages.filter((p) => p.layout === 'section')).toHaveLength(0);
    expect(pages.filter((p) => p.layout === 'bullets')).toHaveLength(1);
  });

  it('角标从 citationOf 取，与知识点一一对应', () => {
    const points = [point('a', '第一章'), point('b', '第一章')];
    const pages = assembleTemplate({
      plan: planTemplate(points),
      content: contentFor(points),
      summary: null,
      deckTitle: 'T',
      sourceTitle: 'S',
      citationOf: citationOf(points),
    });

    const bullets = pages.find((p) => p.layout === 'bullets')!.bullets;
    expect(bullets.map((b) => b.citationIndex)).toEqual([1, 2]);
  });
});

describe('render-plan：资料来源页开关', () => {
  function deckWithCitations(): SlideDeck {
    const citations: SlideCitation[] = [
      {
        index: 1,
        knowledgePointId: 'k1',
        sourceId: 'src_1',
        sourceTitle: '数据结构',
        page: 3,
        chapter: '第一章',
        quote: '引用片段',
      },
    ];
    return {
      id: 'd1',
      title: 'T',
      courseId: null,
      sourceId: 'src_1',
      status: 'outline',
      pages: [
        {
          id: 'p1',
          layout: 'title',
          title: 'T',
          subtitle: null,
          bullets: [],
          figure: null,
        },
        {
          id: 'p2',
          layout: 'bullets',
          title: '页',
          subtitle: null,
          bullets: [{ id: 'b1', text: '要点 [1]', citationIndex: 1 }],
          figure: null,
        },
      ],
      citations,
      exports: [],
      createdAt: '',
      updatedAt: '',
    } as SlideDeck;
  }

  it('默认包含资料来源页', () => {
    const plan = buildRenderPlan(deckWithCitations());
    expect(plan.some((s) => s.layout === 'sources')).toBe(true);
  });

  it('includeSources=false 时不再追加', () => {
    const plan = buildRenderPlan(deckWithCitations(), '学习资料', { includeSources: false });
    expect(plan.some((s) => s.layout === 'sources')).toBe(false);
    // 正文页不受影响
    expect(plan.filter((s) => s.layout !== 'sources')).toHaveLength(2);
  });

  it('关掉后页数正好少一页', () => {
    const withSources = buildRenderPlan(deckWithCitations());
    const withoutSources = buildRenderPlan(deckWithCitations(), '学习资料', {
      includeSources: false,
    });
    expect(withSources.length - withoutSources.length).toBe(1);
  });
});
