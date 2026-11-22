/**
 * 把「已确认的路线 + 资料段落」装配成一棵**带真实小节的树**（2026-11-22）。
 *
 * ## 为什么需要这一层（它补的是第 3 步还没做时的空档）
 *
 * 施工顺序（方案第十二节）里第 3 步是「提示词加小节 + 前置关系」，
 * 第 4 步才是树的渲染器。但第 4 步一旦要做，就会撞上一个现实问题：
 *
 * > 用户库里**现在**只有一条 v2 的扁平路线（信号与系统，3 块 3 步），
 * > 它没有小节数据。如果树只认「第 3 步产出的新数据」，
 * > 那第 4 步交付时树是空的 —— 又变成"断言绿了但界面上什么都没有"。
 *
 * 所以这一层负责：**用现有数据也能长出真的树**。
 * 做法是把 v2 路线转成树（`source-tree.ts` 的 `fromLegacyRoute`），
 * 再用 `section-split.ts` 从正文里现切小节，替换掉占位节点。
 *
 * 信号与系统那份能切出 26 个 `## 1.1 xxx`，所以树上会真的有分叉。
 * 等第 3 步做完，AI 给的 `sections` 会走另一条路进来（见 `mergeAiSections`）。
 *
 * ## 三个不许违背的规则
 *
 * 1. **任务状态不能丢**。已保存的树里 `tasks` 是用户勾的，
 *    重新装配时必须原样保留 —— 否则用户勾了 20 个小节，重新进页面全没了。
 * 2. **小节按章归属，绝不按编号全局分组**（`section-split` 的核心，
 *    这里只是用它，别在这层重新实现）。
 * 3. **切不出就如实退化**成 `whole-chapter` 单节点，界面会说
 *    「这一章没有小节结构，按整章学」，不假装有结构。
 *
 * ## 纯函数
 *
 * 不碰 I/O、不碰 React。调用方把段数组给它，它把树给它。
 */

import type { SourceRoute } from '@/core/ai/source-route.ts';
import type { SourceSegment } from '@/core/model.ts';
import { splitSections, type SplitChapter, type SplitResult } from './section-split.ts';
import { fromLegacyRoute, isSectionDone, type ChapterNode, type SectionNode, type SourceTree } from './source-tree.ts';

/** 装配结果 + 诊断 */
export interface BuiltTree {
  tree: SourceTree;
  /**
   * 切分出的小节来自哪里（界面要如实说明）。
   *
   * - `heading`：正文有标题，真切出来了
   * - `mixed`：部分章切出来了，部分退化
   * - `none`：一个都没切出来（全靠整章退化，等第 3 步的 AI 兜底）
   */
  sectionsFrom: 'heading' | 'mixed' | 'none';
  /** 诊断：每章切出几个小节（`chapterNumber` → 数量） */
  stats: { chapterNumber: number; sections: number }[];
  /** 被替换成真实小节的章数 */
  drilledChapters: number;
}

/**
 * v2 扁平路线 + 段落 → 带小节的树。
 *
 * ## 章怎么对上
 *
 * 路线里的 `RouteStep.chapterNumber` 与 `splitSections` 出来的
 * `SplitChapter.number` 是同一套章号（都从「第N章」认出来）。
 * 所以按章号匹配。**匹配不上就保留退化节点** —— 那种情况下
 * 说明 AI 排的这一章在正文里找不到，界面本来就要如实说明。
 */
export function buildTreeFromRoute(options: {
  route: SourceRoute;
  sourceId: string;
  segments: readonly SourceSegment[];
}): BuiltTree {
  const { route, sourceId, segments } = options;

  const base = fromLegacyRoute(route, sourceId);
  const split = splitSections(segments);

  return drillSections(base, split);
}

/**
 * 已经切过一次的树（例如已保存的）→ 按新段落重新切小节。
 *
 * ⚠️ **任务状态按小节 id 保留**。重新切出来小节的 id 是新的
 * （`section-split` 不知道上次的 id），所以直接按位对齐不可靠。
 * 这里按**标题**对齐：同一个标题的小节任务状态继承下来。
 * 标题对上但数量变了（资料重新解析过），多出来的按新小节处理。
 *
 * 为什么按标题而不是按 id：id 在每次装配时都会重新生成，
 * 而标题是资料里的原文，跨次稳定。第 3 步 AI 给的小节标题同理。
 */
export function rebuildSections(
  tree: SourceTree,
  segments: readonly SourceSegment[],
): BuiltTree {
  const split = splitSections(segments);
  const prevByTitle = new Map<string, SectionNode>();
  for (const ch of tree.chapters) {
    for (const sec of ch.sections) prevByTitle.set(sectionTitleKey(sec.title), sec);
  }
  return drillSections(tree, split, prevByTitle);
}

/** 小节标题归一（用于跨次对齐） */
function sectionTitleKey(title: string): string {
  return title.replace(/\s+/g, '').trim();
}

/**
 * 从一组小节里取出「第 idx 份（共 total 份）」。
 *
 * ## 怎么分
 *
 * 尽量均分，**余数给前面的份**。例：26 个小节分 3 份 →
 * 9 / 9 / 8（前两份各多一个）。
 *
 * 这样保证：
 *  - 每份非空（除非 total > 小节数，那种情况后面的份为空 → 调用方退化）
 *  - 所有份加起来正好等于总数（不重复、不漏）
 *
 * ## 为什么不按标题对齐
 *
 * 小节标题是 `1.1` / `1.2`（资料里的编号），步骤标题是
 * 「基本连续信号与运算」（AI 起的名字），字面完全不同，没有可靠
 * 的对齐依据。硬猜出来的对应关系比"均分"更难向用户解释。
 */
function shareSections<T>(sections: readonly T[], idx: number, total: number): T[] {
  if (total <= 1) return [...sections];
  if (idx < 0 || idx >= total) return [];

  const n = sections.length;
  const base = Math.floor(n / total);
  const extra = n % total;

  /* 前 extra 份各多一个 */
  const start =
    idx * base + Math.min(idx, extra);
  const count = base + (idx < extra ? 1 : 0);

  return sections.slice(start, start + count);
}

/**
 * 真正的钻取：把每章的占位节点换成切实的小节。
 *
 * ## ⚠️ 同一个章号可能有多步（2026-11-22 截图发现的真实 bug）
 *
 * 用户库里那条 v2 路线是 AI 对**同一章**（第 1 章）做的三段细分：
 *
 * ```
 * ch=1 信号的描述与分类
 * ch=1 基本连续信号与运算
 * ch=1 系统的描述与线性时不变性
 * ```
 *
 * 原来的实现按章号匹配（`byNumber.get(ch.number)`），于是**三步都
 * 命中同一个切分章、都拿到全部 26 个小节** —— 界面上三个章各显示
 * 「0 / 26」，标题栏是 `0 / 78`（3 × 26）。截图一看就错，而 32 条
 * 断言全绿：它们只查"章数对不对""分不分叉"，没人查"总数是不是重复计了"。
 *
 * ## 修法：先把同号的多步认出来，再**分摊**小节
 *
 * 按章号分组；一组里有 N 步时，该章切出的 M 个小节按顺序切成 N 份
 * （尽量均分，前面的组多分一个）。这样：
 *  - 每步只拿到自己那段小节，不会重复
 *  - 小节总数 = 切出来的总数（标题栏不再虚高）
 *  - 只有 1 步时行为与原来完全一致（不分摊）
 *
 * 为什么按顺序均分而不是按标题相似度对齐：这些小节的标题（`1.1`、
 * `1.2`…）与 AI 给的步骤标题（「基本连续信号与运算」）字面完全不同，
 * 没有可靠的对齐依据。均分至少保证「不重复、不漏」，而错的分配比
 * 均分更难解释。第 3 步的 AI 会给真正的小节结构，那时不需要分摊。
 *
 * @param prevByTitle 上次的小节（按标题索引），有就继承任务状态
 */
function drillSections(
  base: SourceTree,
  split: SplitResult,
  prevByTitle?: ReadonlyMap<string, SectionNode>,
): BuiltTree {
  /** 章号 → 切出的章 */
  const byNumber = new Map<number, SplitChapter>();
  for (const ch of split.chapters) byNumber.set(ch.number, ch);

  /*
   * 同号多步的「第几步」计数：每遇到一个同号的章节点就 +1，
   * 用来知道它是该组里的第几个，从而分摊小节。
   */
  const seenOfNumber = new Map<number, number>();
  /** 章号 → 该号一共有几步 */
  const totalOfNumber = new Map<number, number>();
  for (const ch of base.chapters) {
    totalOfNumber.set(ch.number, (totalOfNumber.get(ch.number) ?? 0) + 1);
  }

  let drilledChapters = 0;
  let keptWhole = 0;

  const chapters: ChapterNode[] = base.chapters.map((ch) => {
    const match = byNumber.get(ch.number);

    /* 这一步是同号里的第几个 */
    const idx = seenOfNumber.get(ch.number) ?? 0;
    seenOfNumber.set(ch.number, idx + 1);
    const total = totalOfNumber.get(ch.number) ?? 1;

    /* 把它该拿的那份小节切出来（total === 1 时就是全部） */
    const mine = match ? shareSections(match.sections, idx, total) : [];

    /*
     * 切不出 ≥2 个小节 → 保留退化节点。
     *
     * 阈值是 2 而不是 1：只切出一个节点时，界面上的"树"和
     * "整章学"长得一模一样，没有分叉可看。`chaptersNeedingAiSplit`
     * 用的是同一套判据，两处保持一致。
     */
    if (mine.length < 2) {
      keptWhole += 1;
      /* 退化时若这次切出了 1 个，用它比用章标题更贴近内容 */
      if (mine.length === 1) {
        const only = mine[0]!;
        const section = makeSection(only.title, only.segmentIds, 'whole-chapter', prevByTitle);
        return { ...ch, sections: [section] };
      }
      return ch;
    }

    drilledChapters += 1;
    const sections: SectionNode[] = mine.map((s) =>
      makeSection(s.title, s.segmentIds, 'heading', prevByTitle),
    );
    return { ...ch, sections };
  });

  const tree: SourceTree = { ...base, chapters };

  const total = chapters.length;
  const sectionsFrom: BuiltTree['sectionsFrom'] =
    drilledChapters === 0 ? 'none' : drilledChapters === total ? 'heading' : 'mixed';

  return { tree, sectionsFrom, stats: split.stats, drilledChapters };
}

/**
 * 造一个小节节点，任务状态尽量从上一次继承。
 *
 * ⚠️ 继承的是**三项布尔 + 自定义任务**，不是 resources 列表的新旧 ——
 * resources 里可能有用户手工加的链接，那个必须留住，
 * 而联网搜来的旧链接已被新一次规划取代，这里不区别对待：
 * 一律继承，因为「删掉用户看得见的东西」比「留一条旧链接」更糟。
 */
function makeSection(
  title: string,
  segmentIds: readonly string[],
  origin: SectionNode['origin'],
  prevByTitle?: ReadonlyMap<string, SectionNode>,
): SectionNode {
  const prev = prevByTitle?.get(sectionTitleKey(title));

  return {
    id: newSectionId(),
    title,
    segmentIds: [...segmentIds],
    origin,
    tasks: prev
      ? {
          resources: prev.tasks.resources.map((r) => ({ ...r })),
          resourceDone: prev.tasks.resourceDone,
          flashcardsDone: prev.tasks.flashcardsDone,
          exerciseDone: prev.tasks.exerciseDone,
          custom: prev.tasks.custom.map((c) => ({ ...c })),
        }
      : {
          resources: [],
          resourceDone: false,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
  };
}

/** 小节 id（与 `source-tree.ts` 同一套格式） */
function newSectionId(): string {
  return 'sec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ==========================================================================
 * 前置关系：文案 + 校验
 * ========================================================================== */

/** 一条前置提醒（界面直接渲染） */
export interface PrereqNote {
  /** 需要先学哪几章（已按章号升序、已去掉无效项） */
  chapters: number[];
  /** 给用户看的完整文案 */
  text: string;
}

/**
 * 算出某章的前置提醒文案。
 *
 * ## 三条校验（方案第九节要求解析层做的，这里再做一次是因为界面也要保证）
 *
 * 1. **不存在的章号丢弃** —— AI 可能给出这份资料里没有的章
 * 2. **自引用丢弃** —— 「第 3 章需要先学第 3 章」是废话
 * 3. **已满足的不提醒** —— 前置章本身已经完成时，不再催用户
 *
 * ## ⚠️ 只提醒、不锁
 *
 * 用户明确要求「章节可以同时进行，不用按顺序」。
 * 所以这个函数只产出**文案**，调用方绝不能拿它去 `disabled` 按钮。
 *
 * @param chapter     要判断的章
 * @param allChapters 整棵树的所有章（用于校验章号存在）
 */
export function prereqNote(
  chapter: ChapterNode,
  allChapters: readonly ChapterNode[],
): PrereqNote | null {
  if (chapter.prerequisites.length === 0) return null;

  const existing = new Set(allChapters.map((c) => c.number));
  const doneNumbers = new Set(
    allChapters
      .filter((c) => c.sections.length > 0 && c.sections.every(isSectionDone))
      .map((c) => c.number),
  );

  const valid = [...new Set(chapter.prerequisites)]
    .filter((n) => existing.has(n))
    .filter((n) => n !== chapter.number)
    /* 已完成的前置不再提醒 —— 提醒"先学你已经学过的章"是噪音 */
    .filter((n) => !doneNumbers.has(n))
    .sort((a, b) => a - b);

  if (valid.length === 0) return null;

  const nums = valid.map((n) => `第 ${n} 章`).join('、');
  const reason = chapter.prereqReason.trim();
  const text = reason
    ? `建议先学 ${nums} —— ${reason}（不拦你，可以照常学）`
    : `建议先学 ${nums}（不拦你，可以照常学）`;

  return { chapters: valid, text };
}