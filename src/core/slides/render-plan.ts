import type { SlideBullet, SlideDeck, SlideLayout } from '../model.ts';
import { SLIDE_LIMITS, continuationTitle, foldTitle, normalizeBulletText } from './limits.ts';

/**
 * 渲染计划：把大纲翻译成「每一页上有什么、放在哪」。
 *
 * ## 为什么预览和导出必须共用这一份
 *
 * 界面预览和 .pptx 导出是两条完全不同的渲染路径（React 用 CSS，导出用
 * pptxgenjs 的绝对坐标）。如果各算各的，就会出经典毛病：
 * **预览显示 12 页，导出的文件 14 页**，或者预览里一页 5 条要点、
 * 导出时溢出成两页。学生对着预览调整了半天，导出来不是那个东西。
 *
 * 所以这里把「分页 + 每页内容 + 版面坐标」算一次，两条路径都只消费结果：
 *   - 预览：把英寸按画布尺寸等比换成百分比 / px
 *   - 导出：直接把英寸喂给 pptxgenjs
 *
 * 一条规则：**任何影响页数或内容的逻辑只能写在这里**。
 */

/** 幻灯片画布尺寸（英寸）。16:9 → 13.333 × 7.5 */
export const SLIDE_SIZE = { width: 13.333, height: 7.5 } as const;

/** 版面边距与区域（英寸） */
export const SLIDE_BOX = {
  marginX: 0.85,
  /** 页标题基线区 */
  titleTop: 0.55,
  titleHeight: 0.95,
  /** 正文区起点与可用高度 */
  bodyTop: 1.75,
  bodyHeight: 4.55,
  /** 页脚（页码 + 资料名） */
  footerTop: 6.75,
  footerHeight: 0.4,
} as const;

/** 渲染出来的一行文本（预览与导出都渲染它） */
export interface RenderBullet {
  text: string;
  /** 角标编号；null = 无角标 */
  citationIndex: number | null;
}

/** 渲染页 */
export interface RenderSlide {
  layout: SlideLayout;
  title: string;
  subtitle: string | null;
  bullets: RenderBullet[];
  /** 资料来源页的行内容 */
  citationLines: string[];
  /** 页脚左侧文字（资料名），封面页为空 */
  footer: string;
  /** 页码，从 1 开始；封面页也占页码，和 PowerPoint 里看到的一致 */
  pageNumber: number;
}

/**
 * 生成渲染计划。
 *
 * 关键行为：**资料来源页在这里追加，不在大纲里存**。
 * 理由是它会凭空多出一页，如果存在大纲里，用户编辑大纲时就会看到一页
 * 自己没建过的内容，删了又会被下次导出补回来 —— 那是数据在跟用户打架。
 * 它是由 citations 派生的，就让它一直保持派生。
 */
export function buildRenderPlan(deck: SlideDeck, sourceTitleFallback = '学习资料'): RenderSlide[] {
  const slides: RenderSlide[] = [];

  // ── 正文页（封面 / 章节 / 要点） ──────────────────────────
  for (const page of deck.pages) {
    slides.push({
      layout: page.layout,
      title: page.layout === 'title' ? foldTitle(page.title, SLIDE_LIMITS.maxTitleChars) : page.title,
      subtitle: page.subtitle,
      bullets: page.bullets.map((b: SlideBullet) => ({
        // 再归一一次：库里可能存着本次修复之前写入的带换行要点，
        // 不重导库也要能正确导出。normalizeBulletText 对干净文本是幂等的。
        text: normalizeBulletText(b.text),
        citationIndex: b.citationIndex,
      })),
      citationLines: [],
      footer: page.layout === 'title' ? '' : sourceTitleFallback,
      pageNumber: slides.length + 1,
    });
  }

  // ── 资料来源页（派生，固定追加在最后） ─────────────────────
  const citations = [...deck.citations].sort((a, b) => a.index - b.index);

  if (citations.length > 0) {
    const per = SLIDE_LIMITS.maxCitationsPerPage;
    const chunks: typeof citations[] = [];
    for (let i = 0; i < citations.length; i += per) {
      chunks.push(citations.slice(i, i + per));
    }

    chunks.forEach((chunk, i) => {
      const lines = chunk.map((c) => {
        const where = formatLocation(c.page, c.chapter);
        // 引用片段同样要归一空白：原文里的换行会让这条资料占两行，
        // 而资料行的行距是按单行（0.42 英寸）排的，于是下一条编号压上来。
        // 和要点叠字是同一个根因，这里一并处理。
        const quote = normalizeBulletText(c.quote);
        const preview =
          quote.length > SLIDE_LIMITS.quotePreviewChars
            ? `${quote.slice(0, SLIDE_LIMITS.quotePreviewChars)}…`
            : quote;
        return `[${c.index}] 《${c.sourceTitle}》${where}${preview ? ` —「${preview}」` : ''}`;
      });

      slides.push({
        layout: 'sources',
        title: continuationTitle('资料来源', i, chunks.length),
        subtitle: null,
        bullets: [],
        citationLines: lines,
        footer: '',
        pageNumber: slides.length + 1,
      });
    });
  }

  return slides;
}

/**
 * 把位置格式化成人类可读的「第几页 / 哪一章」。
 *
 * DOCX/MD 这类没有固定分页的资料，`page` 其实是章节序号，
 * 这时显示「第 N 节」而不是「第 N 页」—— 说错单位会让用户去翻一个不存在的页码。
 * 判断依据：有 chapter 字段且 chapter 与页码并存时，优先显示章节名。
 */
export function formatLocation(page: number | null, chapter: string | null): string {
  const parts: string[] = [];
  if (chapter && chapter.trim().length > 0) parts.push(`「${chapter.trim()}」`);
  if (page !== null) parts.push(`第 ${page} 页`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * 统计渲染计划的信息，界面用来如实显示「会导出多少页」。
 *
 * `total` 与实际导出的页数**必须一致**——它直接显示给用户，
 * 用户导出后会数。不一致就是撒谎。
 */
export function planStats(plan: RenderSlide[]) {
  const contentPages = plan.filter((s) => s.layout !== 'sources').length;
  const sourcePages = plan.filter((s) => s.layout === 'sources').length;
  const bullets = plan.reduce((n, s) => n + s.bullets.length, 0);
  const withoutCitation = plan.reduce(
    (n, s) => n + s.bullets.filter((b) => b.citationIndex === null).length,
    0,
  );
  return { total: plan.length, contentPages, sourcePages, bullets, withoutCitation };
}
