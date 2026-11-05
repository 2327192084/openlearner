import type { KnowledgePoint, SlideBullet, SlideOutlinePage } from '../model.ts';
import { newId } from '../id.ts';
import { SLIDE_LIMITS, splitLongText } from './limits.ts';
import { buildCoverPage } from './outline.ts';

/**
 * 固定版式模板。
 *
 * ## 为什么需要它
 *
 * 让 AI 自由决定「这份 PPT 有几页、每页讲什么」，结果是**不可预期**的：
 * 同样的知识点跑两次可能得到不同页数、不同结构。用户想要的是
 * 「每次都是这个样子」的稳定版式。
 *
 * 所以这里把「结构」从 AI 手里拿走：
 *
 *   封面 → （章节过渡页 → 要点页）× 章节数 → 总结页
 *
 * 结构由代码定死，AI 只负责**写内容**（页标题、要点文字、总结）。
 * 这样版式可预期，内容仍然是模型组织的。
 *
 * ## 什么时候用它
 *
 * 用户没有填写额外要求时（默认路径）。一旦用户写了提示词，
 * 就切到自由模式，由模型按用户的要求组织结构 —— 那时「可预期」
 * 让位给「按我说的做」。
 */

/** 一个章节分组 */
export interface TemplateChapter {
  /** 章节名（没有章节名时为「主要内容」） */
  name: string;
  points: KnowledgePoint[];
}

/** 模板结构 */
export interface TemplatePlan {
  chapters: TemplateChapter[];
  /** 是否需要章节过渡页（只有 1 章时不插，插了反而多一页翻页） */
  needsSectionPages: boolean;
}

/**
 * 按章节把知识点分组，按章节在原文中出现的顺序排。
 *
 * 顺序不按字母序：知识点已按页码排好，第一次出现的位置就是它在教材里的位置。
 */
export function planTemplate(points: KnowledgePoint[]): TemplatePlan {
  const groups: TemplateChapter[] = [];
  const index = new Map<string, number>();

  for (const point of points) {
    const statement = point.statement?.trim() ?? '';
    if (statement.length === 0) continue;

    const name = point.chapter?.trim() || '主要内容';
    let at = index.get(name);
    if (at === undefined) {
      at = groups.length;
      index.set(name, at);
      groups.push({ name, points: [] });
    }
    groups[at]!.points.push(point);
  }

  return {
    chapters: groups,
    /**
     * 只有 1 章时不插章节过渡页。
     *
     * 与 buildOutline 的同一条判断：一章的内容插一张只有章节名的页，
     * 用户体验是「翻了一页什么都没有」。
     */
    needsSectionPages: groups.length >= 2,
  };
}

/** AI 为某条知识点写好的内容 */
export interface TemplateContentItem {
  /** 依据的知识点 id */
  fromPointId: string;
  /** 这一页的标题（AI 起的小标题） */
  title: string | null;
  /** 要点文字（AI 提炼） */
  bullet: string;
}

/** AI 写的总结页内容 */
export interface TemplateSummary {
  title: string;
  bullets: string[];
}

export interface AssembleTemplateInput {
  plan: TemplatePlan;
  /** AI 写好的内容，按 fromPointId 索引 */
  content: Map<string, TemplateContentItem>;
  /** AI 写的总结（可空：模型没给就不出总结页） */
  summary: TemplateSummary | null;
  deckTitle: string;
  sourceTitle: string;
  /** 知识点 → 角标编号（由调用方按已建好的 citations 提供） */
  citationOf: (point: KnowledgePoint) => number | null;
}

/**
 * 按固定模板组装出页面。
 *
 * 结构与 planTemplate 一致：封面 →（章节页 → 要点页）× N → 总结页。
 * 任何一环缺内容就跳过那一环，不补空页 —— 空页是最糟的产出。
 */
export function assembleTemplate(input: AssembleTemplateInput): SlideOutlinePage[] {
  const { plan, content, summary, deckTitle, sourceTitle, citationOf } = input;

  const pages: SlideOutlinePage[] = [
    buildCoverPage({
      deckTitle,
      sourceTitle,
      pointCount: plan.chapters.reduce((n, c) => n + c.points.length, 0),
    }),
  ];

  const per = SLIDE_LIMITS.maxBulletsPerPage;

  /**
   * 先把每章的内容都组出来，再决定要不要章节过渡页。
   *
   * 不能直接用 plan.needsSectionPages：那是按**计划**的章节数算的。
   * 如果模型只给一章写了内容，剩下几章全是空的，按计划算就会给
   * 唯一有内容的那一章插一张只有章节名的页 —— 正是「翻一页什么都没有」。
   * 所以按**实际有内容**的章节数决定。
   */
  interface BuiltChapter {
    name: string;
    title: string;
    bullets: SlideBullet[];
  }

  const built: BuiltChapter[] = [];

  for (const chapter of plan.chapters) {
    const bullets: SlideBullet[] = [];
    let pageTitle = chapter.name;

    for (const point of chapter.points) {
      const item = content.get(point.id);
      /**
       * AI 没给这条知识点写内容 → 跳过。
       *
       * 不回退成知识点原文：默认模板的定位是「模型组织过的课件」，
       * 混进原文会让同一页里出现两种语气，读者一眼看出来。
       * 宁可少一条，也不制造这种不一致。
       */
      if (!item) continue;

      if (item.title && bullets.length === 0) pageTitle = item.title;

      const citationIndex = citationOf(point);
      for (const text of splitLongText(item.bullet)) {
        bullets.push({ id: newId('sb'), text, citationIndex });
      }
    }

    if (bullets.length === 0) continue;
    built.push({ name: chapter.name, title: pageTitle, bullets });
  }

  const needsSectionPages = built.length >= 2;

  for (const chapter of built) {
    if (needsSectionPages) {
      pages.push({
        id: newId('sp'),
        layout: 'section',
        title: chapter.name,
        subtitle: null,
        bullets: [],
        figure: null,
      });
    }

    for (let i = 0; i < chapter.bullets.length; i += per) {
      pages.push({
        id: newId('sp'),
        layout: 'bullets',
        title: i === 0 ? chapter.title : `${chapter.title}（续）`,
        subtitle: null,
        bullets: chapter.bullets.slice(i, i + per),
        figure: null,
      });
    }
  }

  // 总结页固定放最后（总结不是引用内容，所以没有角标）
  if (summary && summary.bullets.length > 0) {
    const bullets: SlideBullet[] = [];
    for (const text of summary.bullets) {
      for (const part of splitLongText(text)) {
        bullets.push({ id: newId('sb'), text: part, citationIndex: null });
      }
    }
    for (let i = 0; i < bullets.length; i += per) {
      pages.push({
        id: newId('sp'),
        layout: 'bullets',
        title: i === 0 ? summary.title : `${summary.title}（续）`,
        subtitle: null,
        bullets: bullets.slice(i, i + per),
        figure: null,
      });
    }
  }

  return pages;
}
