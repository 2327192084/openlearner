import { newId } from '../id.ts';
import type {
  KnowledgePoint,
  SlideBullet,
  SlideCitation,
  SlideOutlinePage,
} from '../model.ts';
import { SLIDE_LIMITS, splitLongText } from './limits.ts';

/**
 * 从知识点生成 PPT 大纲。
 *
 * ## 核心原则：引用只从知识点继承，绝不在这里重新定位
 *
 * 每条要点的角标指向 `SlideCitation`，而 `SlideCitation` 的页码是从
 * `KnowledgePoint.anchors[0]` **原样复制**的。这里不做任何位置推算。
 *
 * 理由和 P3 出题完全一致：位置只能有一个权威来源。
 * 如果 PPT 这层也"估一下页码"，就会出现「知识点说第 3 页、PPT 说第 5 页」，
 * 而学生无从判断该信哪个。计划书说得很直接：**指错页比不能跳转更糟**，
 * 因为它冒充可信。
 *
 * 因此：
 *   - 知识点定位成功（anchorStatus='located' 且有 anchors）→ 角标带页码
 *   - 知识点定位失败/被豁免 → 要点照常生成，但 `citationIndex = null`，
 *     PPT 上这条要点**没有角标**，资料页也不列它
 *
 * 不给假角标，比给一个点不到位置的角标诚实。
 */

export interface OutlineInput {
  /** 本次使用的知识点，应已按原文顺序排好 */
  points: KnowledgePoint[];
  /** 资料标题，用于资料页与封面副标题 */
  sourceTitle: string;
  /** PPT 标题；空则用资料标题 */
  title?: string;
  /** 要放进引用的资料标题查找表（sourceId → title），支持跨资料 */
  sourceTitles?: Map<string, string>;
}

export interface OutlineResult {
  pages: SlideOutlinePage[];
  citations: SlideCitation[];
  /** 统计：有多少条要点因为知识点未定位而没有角标 */
  bulletsWithoutCitation: number;
  /** 统计：有多少条知识点因为正文为空被跳过 */
  skippedPoints: number;
}

/**
 * 生成大纲。
 *
 * 结构顺序：
 *   1. 封面页（标题 + 资料名 + 知识点数）
 *   2. 按章节分组的要点页（章节变了插一张章节过渡页）
 *   3. 资料来源页（固定最后，由 assemble 阶段生成，这里只出正文页）
 *
 * 章节过渡页只在「章节数 ≥ 2」时插入。只有一章时插过渡页是多余的一页 ——
 * 翻两页才看到内容，体验上像卡住了。
 */
export function buildOutline(input: OutlineInput): OutlineResult {
  const { points } = input;
  // 资料标题为空时统一兜底一次。早先只有 deckTitle 兜了底，
  // 副标题直接拼 sourceTitle，结果封面副标题变成「 · 1 个知识点」——
  // 开头空悬一个间隔号，看起来像程序漏了个变量。
  const sourceTitle = input.sourceTitle.trim() || '学习资料';
  const sourceTitles = input.sourceTitles ?? new Map<string, string>();
  const deckTitle = (input.title ?? '').trim() || sourceTitle;

  const pages: SlideOutlinePage[] = [];
  const citations: SlideCitation[] = [];

  // 引用去重：同一知识点只占一个角标编号。
  // 用 knowledgePointId 做 key，避免同一页要点里两条要点引用同一条知识点时出现两个号。
  const citationByPoint = new Map<string, number>();

  let bulletsWithoutCitation = 0;
  let skippedPoints = 0;

  /**
   * 取某知识点的角标下标；没有可用位置则返回 null（不给假角标）。
   */
  const citationFor = (point: KnowledgePoint): number | null => {
    const existing = citationByPoint.get(point.id);
    if (existing !== undefined) return existing;

    // 定位失败或被人工豁免 → 不建角标
    if (point.anchorStatus !== 'located') return null;
    const anchor = point.anchors[0];
    if (!anchor) return null;

    const citation: SlideCitation = {
      index: citations.length + 1,
      knowledgePointId: point.id,
      sourceId: anchor.sourceId || point.sourceId || '',
      sourceTitle: sourceTitles.get(anchor.sourceId) ?? sourceTitle,
      page: anchor.page ?? null,
      chapter: anchor.chapter ?? point.chapter,
      quote: point.quotes[0] ?? '',
    };
    citations.push(citation);
    citationByPoint.set(point.id, citation.index);
    return citation.index;
  };

  /** 把一条知识点变成 1~N 条要点（长文本按标点拆开） */
  const bulletsOf = (point: KnowledgePoint): SlideBullet[] => {
    const citationIndex = citationFor(point);
    if (citationIndex === null) bulletsWithoutCitation += 1;

    return splitLongText(point.statement).map((text) => ({
      id: newId('sb'),
      text,
      // 同一条知识点拆出的多条要点，共用同一个角标编号。
      // 这是刻意的：它们是同一处原文的连续内容，标两个号会让人以为引了两处。
      citationIndex,
    }));
  };

  // ── 按章节分组 ────────────────────────────────────────────
  // 章节顺序按知识点第一次出现的顺序，不按字母序：
  // 知识点已按页码排好，第一次出现的位置就是它在教材里的位置。
  interface Group {
    chapter: string | null;
    points: KnowledgePoint[];
  }
  const groups: Group[] = [];
  const groupIndex = new Map<string, number>();

  for (const point of points) {
    const statement = point.statement?.trim() ?? '';
    if (statement.length === 0) {
      skippedPoints += 1;
      continue;
    }
    const key = point.chapter ?? '\u0000__none__';
    let at = groupIndex.get(key);
    if (at === undefined) {
      at = groups.length;
      groupIndex.set(key, at);
      groups.push({ chapter: point.chapter, points: [] });
    }
    groups[at].points.push(point);
  }

  // ── 封面 ──────────────────────────────────────────────────
  pages.push({
    id: newId('sp'),
    layout: 'title',
    title: deckTitle,
    subtitle: `${sourceTitle}${points.length > 0 ? ` · ${points.length} 个知识点` : ''}`,
    bullets: [],
  });

  // ── 正文页 ────────────────────────────────────────────────
  const needSectionPages = groups.length >= 2;

  for (const group of groups) {
    const chapterTitle = group.chapter?.trim() || '未分章';

    if (needSectionPages) {
      pages.push({
        id: newId('sp'),
        layout: 'section',
        title: chapterTitle,
        subtitle: null,
        bullets: [],
      });
    }

    // 收集本章全部要点
    const allBullets: SlideBullet[] = [];
    for (const point of group.points) {
      allBullets.push(...bulletsOf(point));
    }
    if (allBullets.length === 0) continue;

    // 按每页上限切页，超出的拆成续页（不截断）
    const per = SLIDE_LIMITS.maxBulletsPerPage;
    const chunks: SlideBullet[][] = [];
    for (let i = 0; i < allBullets.length; i += per) {
      chunks.push(allBullets.slice(i, i + per));
    }

    chunks.forEach((chunk, i) => {
      pages.push({
        id: newId('sp'),
        layout: 'bullets',
        title: i === 0 ? chapterTitle : `${chapterTitle}（续）`,
        subtitle: null,
        bullets: chunk,
      });
    });
  }

  return { pages, citations, bulletsWithoutCitation, skippedPoints };
}
