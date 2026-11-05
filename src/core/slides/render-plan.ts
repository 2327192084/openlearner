import type {
  SlideBullet,
  SlideDeck,
  SlideFigure,
  SlideImageRecord,
  SlideLayout,
  SlideOverlay,
} from '../model.ts';
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

/**
 * 图片在版面上的位置（英寸）。
 *
 * 由 render-plan 算好，预览按百分比还原、导出直接喂给 pptxgenjs。
 * 在这里算而不是各算一次：图片的等比缩放最容易两边不一致 ——
 * 预览里是 4:3、导出时被拉成 16:9，学生一看就知道图变形了。
 */
export interface RenderFigureBox {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** 图文页的图；其他版式恒为 null */
  figure: SlideFigure | null;
  /** 图在版面中的位置与尺寸；无图时为 null */
  figureBox: RenderFigureBox | null;
  /** 图注（显示在图下方）；无图为 null */
  figureCaption: string | null;
  /**
   * 叠加内容（自由摆放的图片 / 文本框），按 z 升序 = 由底到顶。
   *
   * 位置已经从 0~1 比例换算成**英寸**，预览再按百分比还原。
   * 在这里换算而不是让两边各算：图片位置最容易两边不一致
   * （预览里在右下、导出跑到左上），换一处必然漏另一处。
   */
  overlays: RenderOverlayBox[];
}

/** 一块叠加内容在版面中的绝对位置（英寸） */
export interface RenderOverlayBox {
  id: string;
  kind: 'image' | 'text';
  /** 图片的 data URL（已从 slideImages 取好）；kind='text' 时为 null */
  imageData: string | null;
  text: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  /** 不带 # 的十六进制；null 表示用主题正文色 */
  color: string | null;
}

/**
 * 把叠加内容的**比例坐标**换算成**英寸**。
 *
 * 这是「预览 = 导出」的关键一步：
 * 位置在数据里一直是 0~1，到这里才乘上真实版面尺寸。
 * 预览拿到英寸后按容器宽度还原成百分比，导出直接喂给 pptxgenjs，
 * 两边算出来的像素位置必然一致，不会因为窗口大小不同而错位。
 *
 * 换算不了的项直接跳过而不是画在 0,0：
 *  - kind='image' 但取不到图（图片被删了）→ 画上去是一块空白框，
 *    比不画更让人困惑；
 *  - 文字为空 → 没有可显示的内容。
 */
function overlaysOf(
  overlays: SlideOverlay[] | undefined,
  images: Map<string, SlideImageRecord>,
): RenderOverlayBox[] {
  if (!overlays || overlays.length === 0) return [];

  const out: RenderOverlayBox[] = [];

  // 按 z 升序 = 先画的在底层
  for (const ov of [...overlays].sort((a, b) => a.z - b.z)) {
    if (ov.kind === 'image') {
      const img = ov.imageId ? images.get(ov.imageId) : undefined;
      if (!img) continue;
      out.push({
        id: ov.id,
        kind: 'image',
        imageData: img.imageData,
        text: null,
        x: ov.x * SLIDE_SIZE.width,
        y: ov.y * SLIDE_SIZE.height,
        w: ov.w * SLIDE_SIZE.width,
        h: ov.h * SLIDE_SIZE.height,
        fontSize: 0,
        color: null,
      });
      continue;
    }

    const text = ov.text?.trim();
    if (!text) continue;
    out.push({
      id: ov.id,
      kind: 'text',
      imageData: null,
      text,
      x: ov.x * SLIDE_SIZE.width,
      y: ov.y * SLIDE_SIZE.height,
      w: ov.w * SLIDE_SIZE.width,
      h: ov.h * SLIDE_SIZE.height,
      fontSize: ov.fontSize ?? 18,
      color: ov.color ?? null,
    });
  }

  return out;
}

/**
 * 生成渲染计划。
 *
 * 关键行为：**资料来源页在这里追加，不在大纲里存**。
 * 理由是它会凭空多出一页，如果存在大纲里，用户编辑大纲时就会看到一页
 * 自己没建过的内容，删了又会被下次导出补回来 —— 那是数据在跟用户打架。
 * 它是由 citations 派生的，就让它一直保持派生。
 *
 * @param options.includeSources 是否追加「资料来源」页，默认 true。
 *   用户可以在导出时关掉它 —— 这一页对「自己看」的场景是多余的，
 *   但对「发给别人」很重要：要点右侧的 `[3]` 如果末尾没有对照表，
 *   读者就不知道它指向哪一页。所以做成开关而不是直接删掉。
 */
export function buildRenderPlan(
  deck: SlideDeck,
  sourceTitleFallback = '学习资料',
  options: {
    includeSources?: boolean;
    /**
     * 图片查找表（id → 记录），叠加内容里的 imageId 从这里取 data URL。
     *
     * 由调用方（SlideService.getPlan）预先读好传进来，而不是在这里
     * 异步查存储：这个函数是纯同步的，预览和导出都直接调它，
     * 变成异步会波及两边所有调用点。
     */
    images?: Map<string, SlideImageRecord>;
  } = {},
): RenderSlide[] {
  const includeSources = options.includeSources !== false;
  const images = options.images ?? new Map<string, SlideImageRecord>();
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
      // 图文页：图存在页里，这里只算它该占多大、放哪
      figure: page.layout === 'figure' ? page.figure : null,
      figureBox:
        page.layout === 'figure' && page.figure
          ? figureBoxFor(
              page.figure,
              page.bullets.length > 0,
              normalizeBulletText(page.figure.caption).length > 0,
            )
          : null,
      figureCaption:
        page.layout === 'figure' && page.figure
          ? normalizeBulletText(page.figure.caption)
          : null,
      overlays: overlaysOf(page.overlays, images),
    });
  }

  // ── 资料来源页（派生，固定追加在最后；可关闭） ─────────────
  const citations = [...deck.citations].sort((a, b) => a.index - b.index);

  if (includeSources && citations.length > 0) {
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
        figure: null,
        figureBox: null,
        figureCaption: null,
        // 资料来源页是派生页，用户不能在它上面叠加内容
        overlays: [],
      });
    });
  }

  return slides;
}

/**
 * 算出图片在正文区里的位置与尺寸。
 *
 * ## 两条规则
 *
 * 1. **等比缩放，绝不拉伸**：按图片自身的宽高比缩到框内，取小的那个比例。
 *    教材页面基本是 A4（1:1.414 竖版），硬塞进 16:9 的横框会被拉扁，
 *    公式和表格立刻就变形了。
 * 2. **右边有要点时收窄**：图 + 说明并排比「图占满、说明挤在下面」好读，
 *    但收窄后仍按同一规则等比缩放，不会变形。
 */
function figureBoxFor(
  figure: SlideFigure,
  hasBullets: boolean,
  hasCaption: boolean,
): RenderFigureBox {
  const areaX = SLIDE_BOX.marginX;
  const areaY = SLIDE_BOX.bodyTop;
  const areaW = SLIDE_SIZE.width - SLIDE_BOX.marginX * 2;
  const areaH = SLIDE_BOX.bodyHeight;

  // 有要点时右侧留 34% 给文字
  const maxW = hasBullets ? Math.round(areaW * 0.62 * 100) / 100 : areaW;

  // 图注占的高度要从图片区里扣掉。
  // 不扣的话图片会撑满 4.55 英寸，图注被挤到页脚边界上贴着图 ——
  // 真实渲染里就是「图注看起来像图片的一部分」，分不清哪句是原文哪句是说明。
  const CAPTION_BAND = 0.52;
  const maxH = hasCaption ? Math.round((areaH - CAPTION_BAND) * 100) / 100 : areaH;

  const imgW = figure.width > 0 ? figure.width : 1;
  const imgH = figure.height > 0 ? figure.height : 1;

  // 取「按宽缩」和「按高缩」里更小的那个，保证两个方向都不超框
  const scale = Math.min(maxW / imgW, maxH / imgH);

  // 极端宽高比（比如 100000:1）会让窄的那一边缩到 0.0001 英寸，
  // 四舍五入后就是 0 —— 导出的图片高度 0，Office 里是一根看不见的线。
  // 这里兜一个下限：宁可比例略有偏差，也不能产出零面积图片。
  const MIN_SIDE = 0.05;
  let w = Math.round(imgW * scale * 100) / 100;
  let h = Math.round(imgH * scale * 100) / 100;
  if (w < MIN_SIDE) w = MIN_SIDE;
  if (h < MIN_SIDE) h = MIN_SIDE;

  return {
    x: Math.round((areaX + (maxW - w) / 2) * 100) / 100,
    y: Math.round((areaY + (maxH - h) / 2) * 100) / 100,
    w,
    h,
  };
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
  const figurePages = plan.filter((s) => s.layout === 'figure').length;
  const bullets = plan.reduce((n, s) => n + s.bullets.length, 0);
  const withoutCitation = plan.reduce(
    (n, s) => n + s.bullets.filter((b) => b.citationIndex === null).length,
    0,
  );
  return { total: plan.length, contentPages, sourcePages, figurePages, bullets, withoutCitation };
}
