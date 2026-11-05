import { newId } from '../id.ts';
import type { SlideBullet, SlideCitation, SlideOutlinePage } from '../model.ts';
import { SLIDE_LIMITS, splitLongText } from './limits.ts';
import type { SourceChunk } from './source-chunk.ts';

/**
 * 从资料原文生成 PPT 大纲（确定性回退路径）。
 *
 * ## 这一版的核心变化
 *
 * 早先从 **知识点** 生成，现在从 **资料段落** 生成，与知识点那一栏
 * 用同一套取材方式（选资料 + 页码范围）。
 *
 * ## 角标：位置只从段落继承，绝不重新定位
 *
 * 每条要点的角标指向 `SlideCitation`，页码是 `SourceChunk.page`
 * **原样复制**的。这里不做任何位置推算。
 *
 * 比原来从知识点继承更可靠：不再要求「知识点定位成功」才有角标，
 * 只要段落有页码就成立。而段落是解析器直接切出来的，页码必然准确。
 *
 * ## 什么时候用它
 *
 * 只在 AI 请求失败时兜底（产品定位是必须接 AI）。它把原文按章节
 * 组织成要点页，不做提炼 —— 所以界面必须如实告诉用户
 * 「这次没用上 AI」，不能让人以为看到的是模型生成的内容。
 */

export interface OutlineInput {
  /** 本次使用的资料段落，应已按原文顺序排好 */
  chunks: SourceChunk[];
  /** 资料标题，用于资料页与封面副标题 */
  sourceTitle: string;
  /** PPT 标题；空则用资料标题 */
  title?: string;
  /** 要放进引用的资料标题查找表（sourceId → title），支持跨资料 */
  sourceTitles?: Map<string, string>;
  /** 资料 id，写进 citation */
  sourceId?: string;
}

export interface OutlineResult {
  pages: SlideOutlinePage[];
  citations: SlideCitation[];
  /** 统计：有多少条要点没有角标（段落缺页码时） */
  bulletsWithoutCitation: number;
  /** 统计：有多少段因为正文为空被跳过 */
  skippedPoints: number;
}

/**
 * 造封面页。
 *
 * 抽出来是因为现在有两条生成路径（AI 与确定性回退），
 * 封面必须长得一模一样 —— 否则用户在两条路径之间切换时，
 * 会看到封面副标题的写法突然变了，像是两个不同的功能做的。
 */
export function buildCoverPage(input: {
  deckTitle: string;
  sourceTitle: string;
  pointCount: number;
  /** 单位名称，默认「页」—— PPT 按段落取材时说的是页数而不是知识点数 */
  unit?: string;
}): SlideOutlinePage {
  const sourceTitle = input.sourceTitle.trim() || '学习资料';
  const unit = input.unit ?? '页';
  return {
    id: newId('sp'),
    layout: 'title',
    title: input.deckTitle,
    subtitle: `${sourceTitle}${input.pointCount > 0 ? ` · ${input.pointCount} ${unit}` : ''}`,
    bullets: [],
    figure: null,
  };
}

/**
 * 按章节把段落分组，顺序按章节在原文中出现的顺序。
 *
 * 顺序不按字母序：段落已按页码排好，第一次出现的位置就是它在教材里的位置。
 */
interface Group {
  chapter: string | null;
  chunks: SourceChunk[];
}

function groupByChapter(chunks: SourceChunk[]): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, number>();

  for (const chunk of chunks) {
    if (!chunk.text.trim()) continue;
    const key = chunk.chapter ?? '\u0000__none__';
    let at = index.get(key);
    if (at === undefined) {
      at = groups.length;
      index.set(key, at);
      groups.push({ chapter: chunk.chapter, chunks: [] });
    }
    groups[at]!.chunks.push(chunk);
  }

  return groups;
}

/**
 * 生成大纲。
 *
 * 结构顺序：
 *   1. 封面页（标题 + 资料名 + 页数）
 *   2. 按章节分组的要点页（章节变了插一张章节过渡页）
 *   3. 资料来源页由 assemble 阶段派生，这里只出正文页
 *
 * 章节过渡页只在「有内容的章节数 ≥ 2」时插入。只有一章时插过渡页
 * 是多余的一页 —— 翻两页才看到内容，体验上像卡住了。
 */
export function buildOutline(input: OutlineInput): OutlineResult {
  const { chunks } = input;
  const sourceTitle = input.sourceTitle.trim() || '学习资料';
  const sourceTitles = input.sourceTitles ?? new Map<string, string>();
  const deckTitle = (input.title ?? '').trim() || sourceTitle;

  const pages: SlideOutlinePage[] = [];
  const citations: SlideCitation[] = [];

  /** 段 id → 角标编号。同一段只占一个号 */
  const citationByChunk = new Map<string, number>();

  let bulletsWithoutCitation = 0;
  let skippedPoints = 0;

  /** 取某段的角标下标；没有页码则返回 null（不给假角标） */
  const citationFor = (chunk: SourceChunk): number | null => {
    const existing = citationByChunk.get(chunk.segmentId);
    if (existing !== undefined) return existing;

    // 没有页码就不建角标 —— 位置不可验证时不冒充可信
    if (!Number.isFinite(chunk.page) || chunk.page <= 0) return null;

    const citation: SlideCitation = {
      index: citations.length + 1,
      // 从原文段落出发，出处就是这一段；知识点的字段不再参与
      segmentId: chunk.segmentId,
      sourceId: input.sourceId ?? '',
      sourceTitle: sourceTitles.get(input.sourceId ?? '') ?? sourceTitle,
      page: chunk.page,
      chapter: chunk.chapter,
      // 引用片段取这一段开头，资料页据此核对
      // 与界面显示同一口径：压平空白但与原文逐字可比对
      quote: chunk.text.replace(/\s+/g, ' ').slice(0, 120),
    };
    citations.push(citation);
    citationByChunk.set(chunk.segmentId, citation.index);
    return citation.index;
  };

  /** 把一段原文变成 1~N 条要点（长文本按标点拆开） */
  const bulletsOf = (chunk: SourceChunk): SlideBullet[] => {
    const citationIndex = citationFor(chunk);
    if (citationIndex === null) bulletsWithoutCitation += 1;

    return splitLongText(chunk.text).map((text) => ({
      id: newId('sb'),
      text,
      // 同一段拆出的多条要点共用同一个角标编号：
      // 它们是同一处原文的连续内容，标两个号会让人以为引了两处。
      citationIndex,
    }));
  };

  const groups = groupByChapter(chunks);
  skippedPoints = chunks.filter((c) => !c.text.trim()).length;

  // ── 封面 ──────────────────────────────────────────────────
  pages.push(
    buildCoverPage({
      deckTitle,
      sourceTitle,
      pointCount: chunks.length,
      unit: '段原文',
    }),
  );

  // ── 正文页 ────────────────────────────────────────────────
  const needSectionPages = groups.length >= 2;

  for (const group of groups) {
    const chapterTitle = group.chapter?.trim() || '主要内容';

    if (needSectionPages) {
      pages.push({
        id: newId('sp'),
        layout: 'section',
        title: chapterTitle,
        subtitle: null,
        bullets: [],
        figure: null,
      });
    }

    const allBullets: SlideBullet[] = [];
    for (const chunk of group.chunks) {
      allBullets.push(...bulletsOf(chunk));
    }
    if (allBullets.length === 0) continue;

    // 按每页上限切页，超出的拆成续页（不截断）
    const per = SLIDE_LIMITS.maxBulletsPerPage;
    const pageChunks: SlideBullet[][] = [];
    for (let i = 0; i < allBullets.length; i += per) {
      pageChunks.push(allBullets.slice(i, i + per));
    }

    pageChunks.forEach((chunk, i) => {
      pages.push({
        id: newId('sp'),
        layout: 'bullets',
        title: i === 0 ? chapterTitle : `${chapterTitle}（续）`,
        subtitle: null,
        bullets: chunk,
        figure: null,
      });
    });
  }

  return { pages, citations, bulletsWithoutCitation, skippedPoints };
}
