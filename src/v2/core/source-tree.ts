/**
 * 学习路线的**树**结构与存储规范化（2026-11-22）。
 *
 * ## 为什么是树（这是学习地图的第三个版本）
 *
 * | 版本 | 形态 | 为什么被换掉 |
 * |---|---|---|
 * | v1 | 横板爬塔，依据**知识点** | 用户要求改成依据资料本体 |
 * | v2 | 资料级扁平步骤（`SourceRoute`） | 用户要求改成**树**，且要"点章局部放大" |
 * | **v3（本文件）** | **资料 → 章 → 小节** | 当前 |
 *
 * 用户原话：
 *
 * > 我设想的地图应该是和图二的树状图一样的，从资料延伸出各个章节，
 * > 然后章节中延伸各个小节。点击一个章节节点后局部放大（只专注于该节点
 * > 和节点后延伸出的小节点），通过完成小节任务来完成这一章节。
 * > 一个资料的不同的章节可以同时进行，不用按照顺序，但是如果是和前几章
 * > 有关联需要前置知识点的章节要给用户一个提醒。
 *
 * ## 三个关键设计决定
 *
 * ### 1. 任务状态存路线里，不新建表
 *
 * 一条路线一次写入天然原子。新建表要动迁移四件套
 * （`STORES` / `BACKUP_STORES` / `StoreRecordMap` / `DB_VERSION`），
 * 而这些状态**只对这一条路线有意义** —— 重排路线后旧状态本就该失效。
 *
 * ### 2. 任务二（闪卡）不存卡 id 列表
 *
 * `Flashcard` 的注释明确写了「闪卡是独立的，不会因来源消失而消失」。
 * 存 id 列表必然与闪卡表漂移（用户删一张卡，路线里就留个死 id）。
 * 改成**运行时按知识点反查**（`flashcards.ts` 已有这个能力）。
 *
 * ### 3. 完成判定交给用户
 *
 * 用户明确要求：「任务完成判定交给用户自己决定」。
 * 所以只有 `resourceDone` / `flashcardsDone` / `exerciseDone` 三个布尔，
 * 由用户勾。**不做任何自动判定**（不用掌握度、不用题目对错推算）。
 *
 * ## 零迁移
 *
 * 存 `settings.sourceTree`（可选字段，旧库读出来是 undefined）。
 * 旧路线 `settings.sourceRoute` 保留，读取时自动转换（`fromLegacyRoute`）。
 */

import type { SourceRoute } from '@/core/ai/source-route.ts';
import type { SplitChapter } from './section-split.ts';

/** 一条小节任务（外部资料） */
export interface SectionResource {
  id: string;
  title: string;
  url: string;
  /**
   * 来源：规划时搜到的 / 用户手工加的。
   *
   * 与 LogiNote 截图里的「LLM 联网收集 / 人工整理」是同一个区分 ——
   * 用户看到「这条是机器找的」和「这条是我自己存的」，判断依据不同。
   */
  source: 'search' | 'manual';
}

/** 一个小节的三项任务 + 自定义任务 */
export interface SectionTasks {
  /** 任务一：外部资料（网课/文档），可多条 */
  resources: SectionResource[];
  /** 任务一是否完成（看过了） */
  resourceDone: boolean;
  /** 任务二：闪卡是否学完 */
  flashcardsDone: boolean;
  /** 任务三：习题是否做完 */
  exerciseDone: boolean;
  /** 用户自定义任务 */
  custom: { id: string; text: string; done: boolean }[];
}

/** 一个小节节点 */
export interface SectionNode {
  /** `sec_<uuid>`，稳定标识（重排路线时尽量保持） */
  id: string;
  title: string;
  /** 该小节覆盖的段 id —— 用于算"这一节有多少正文/多少题" */
  segmentIds: string[];
  /**
   * 小节从哪来：
   * - `heading`：从正文标题切出来的（最可信）
   * - `ai`：正文没标题，让 AI 按内容拆的
   * - `whole-chapter`：切不出也拆不出，整章当一个节点（如实退化）
   */
  origin: 'heading' | 'ai' | 'whole-chapter';
  tasks: SectionTasks;
}

/** 一个章节点 */
export interface ChapterNode {
  /** 章号；0 = 认不出章号（pptx 那种无章节结构的资料） */
  number: number;
  title: string;
  /**
   * 前置章号（AI 规划时给出）。
   *
   * ⚠️ **只提醒、不锁** —— 用户明确要求「章节可以同时进行，不用按顺序」。
   * 界面据它显示提醒条，但章节点始终可点。
   */
  prerequisites: number[];
  /** 为什么需要这些前置（给用户看，AI 生成，可空） */
  prereqReason: string;
  /** 难度 1–5。沿用既有口径：这一步**内容本身**有多难，不是用户掌握度 */
  difficulty: number | null;
  /** 依据来源 */
  basis: 'toc' | 'search' | 'model';
  sections: SectionNode[];
}

/** 整条树 */
export interface SourceTree {
  /** 学科名（用户确认过的） */
  subject: string;
  /** 教材版本信息（可空） */
  edition: string;
  /** 路线基于哪份资料 */
  sourceId: string;
  chapters: ChapterNode[];
  /**
   * 资料没覆盖、但按学科该有的部分。
   *
   * 沿用 v2 `SourceRoute.beyond` 的语义：如实告知「资料里没有」，
   * 与「不超出资料范围」不冲突。
   */
  beyond: { title: string; note: string }[];
  /** 这次规划用没用联网检索 */
  usedSearch: boolean;
  /** 越界被丢掉的条数（诊断用） */
  droppedOutOfScope: number;
  savedAt: string;
}

/** 空的默认任务状态 */
export function emptyTasks(): SectionTasks {
  return {
    resources: [],
    resourceDone: false,
    flashcardsDone: false,
    exerciseDone: false,
    custom: [],
  };
}

/**
 * 一个小节是否完成。
 *
 * ## 判据（严格照用户要求）
 *
 * 三项任务都勾 **且** 所有自定义任务都勾。
 *
 * 为什么自定义任务也要全勾：用户自己加的任务是他自己定义的"这一节要做的"，
 * 漏着一条就说完成，等于把他自己的定义当空气。
 *
 * **不看**：正文读没读、题目对错、闪卡掌握度 —— 用户说判定交给他自己。
 */
export function isSectionDone(section: SectionNode): boolean {
  const t = section.tasks;
  if (!t.resourceDone || !t.flashcardsDone || !t.exerciseDone) return false;
  return t.custom.every((c) => c.done);
}

/** 一章的完成进度 */
export function chapterProgress(chapter: ChapterNode): { done: number; total: number } {
  const total = chapter.sections.length;
  const done = chapter.sections.filter(isSectionDone).length;
  return { done, total };
}

/** 整条路线的完成进度 */
export function treeProgress(tree: SourceTree): {
  chaptersDone: number;
  chaptersTotal: number;
  sectionsDone: number;
  sectionsTotal: number;
} {
  let sectionsDone = 0;
  let sectionsTotal = 0;
  let chaptersDone = 0;
  for (const c of tree.chapters) {
    const p = chapterProgress(c);
    sectionsDone += p.done;
    sectionsTotal += p.total;
    /* 章完成 = 所有小节都完成（且至少有一个小节） */
    if (p.total > 0 && p.done === p.total) chaptersDone += 1;
  }
  return {
    chaptersDone,
    chaptersTotal: tree.chapters.length,
    sectionsDone,
    sectionsTotal,
  };
}

/**
 * 把切好的章节（`section-split.ts` 的输出）转成树里的章节点。
 *
 * @param split      `splitSections` 的结果
 * @param meta       每章的 AI 附加信息（难度/前置/依据），按章号索引；
 *                   切不出小节的章会被 AI 兜底填充，所以这个 map 可能不全
 * @param segmentsOf 章号 → 该章覆盖的段 id（切不出小节时整章一个节点要用）
 */
export function chaptersFromSplit(
  split: readonly SplitChapter[],
  meta: ReadonlyMap<number, { difficulty: number | null; prerequisites: number[]; prereqReason: string; basis: ChapterNode['basis'] }>,
  segmentsOf: (chapterNumber: number) => string[],
): ChapterNode[] {
  const out: ChapterNode[] = [];

  for (const ch of split) {
    const m = meta.get(ch.number);
    const sections: SectionNode[] = [];

    if (ch.sections.length > 0) {
      for (const s of ch.sections) {
        sections.push({
          id: newSectionId(),
          title: s.title,
          segmentIds: [...s.segmentIds],
          origin: 'heading',
          tasks: emptyTasks(),
        });
      }
    } else {
      /*
       * 切不出小节 → 整章一个节点，如实标 `whole-chapter`。
       *
       * 界面会写「这一章没有小节结构，按整章学」——
       * 不假装它有结构，也不让它变成空白节点。
       */
      sections.push({
        id: newSectionId(),
        title: ch.title,
        segmentIds: segmentsOf(ch.number),
        origin: 'whole-chapter',
        tasks: emptyTasks(),
      });
    }

    out.push({
      number: ch.number,
      title: ch.title,
      prerequisites: m?.prerequisites ?? [],
      prereqReason: m?.prereqReason ?? '',
      difficulty: m?.difficulty ?? null,
      basis: m?.basis ?? 'toc',
      sections,
    });
  }

  return out;
}

/** 生成小节 id。用时间戳 + 随机，不依赖 crypto（Electron 与 Node 都有，但没必要） */
function newSectionId(): string {
  return 'sec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ==========================================================================
 * 旧数据兼容：v2 的扁平 SourceRoute → 树
 * ========================================================================== */

/**
 * 把 v2 的扁平路线转成树。
 *
 * ## 为什么要转而不是丢掉
 *
 * 用户库里有一条已确认的路线（信号与系统，3 块 3 步），
 * 且他明确选择了「旧的自动转成树的章节点」。
 *
 * ## 转换规则
 *
 * - 每个 `block.steps[i]` → 一个 `ChapterNode`
 * - 章号取 `step.chapterNumber`；标题取 `step.title`
 * - **小节不在这里切**（那是 `section-split.ts` 的活，需要段落数据）：
 *   先放一个 `origin: 'whole-chapter'` 的占位节点，
 *   调用方拿到段落后再用 `splitSections` 替换它。
 *   这样即使转换时拿不到段落，路线也不会是空的。
 *
 * ## 丢不掉的东西
 *
 * `beyond` / `usedSearch` / `droppedOutOfScope` 原样带过来。
 */
export function fromLegacyRoute(route: SourceRoute, sourceId: string): SourceTree {
  const chapters: ChapterNode[] = [];

  for (const block of route.blocks) {
    for (const step of block.steps) {
      chapters.push({
        number: step.chapterNumber,
        title: step.title,
        prerequisites: [],
        prereqReason: '',
        difficulty: step.difficulty,
        basis: step.basis,
        sections: [
          {
            id: newSectionId(),
            title: step.title,
            /* 旧数据的 segmentIds 是空的（v2 的 RouteStep 有这个字段但没填过） */
            segmentIds: [...step.segmentIds],
            origin: 'whole-chapter',
            tasks: emptyTasks(),
          },
        ],
      });
    }
  }

  return {
    subject: route.subject,
    edition: route.edition,
    sourceId,
    chapters,
    beyond: route.beyond.map((b) => ({ title: b.title, note: b.note })),
    usedSearch: route.usedSearch,
    droppedOutOfScope: route.droppedOutOfScope,
    savedAt: new Date().toISOString(),
  };
}

/* ==========================================================================
 * 存储规范化（坏数据不能崩界面）
 * ========================================================================== */

/**
 * 把 unknown 变成可信的树。
 *
 * 与 `study-plan-store.ts` / `source-route-store.ts` 同一套思路：
 * 这个值来自用户库里的一条记录，可能是手改备份留下的半截对象、
 * 上个版本写的、或压根不是我们写的。**强转会让界面在某个 `.map` 上崩掉**。
 */
export function normalizeSourceTree(raw: unknown): SourceTree | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawChapters = o.chapters;
  if (!Array.isArray(rawChapters)) return null;

  const chapters: ChapterNode[] = [];
  for (const rc of rawChapters) {
    if (!rc || typeof rc !== 'object') continue;
    const c = rc as Record<string, unknown>;

    const title = typeof c.title === 'string' ? c.title.trim().slice(0, 80) : '';
    if (title.length === 0) continue;

    const rawSections = c.sections;
    const sections: SectionNode[] = [];
    if (Array.isArray(rawSections)) {
      for (const rs of rawSections) {
        const s = normalizeSection(rs);
        if (s) sections.push(s);
      }
    }
    /* 一个章至少有一个小节节点，否则界面上是个空壳 */
    if (sections.length === 0) {
      sections.push({
        id: newSectionId(),
        title,
        segmentIds: [],
        origin: 'whole-chapter',
        tasks: emptyTasks(),
      });
    }

    chapters.push({
      number: toInt(c.number) ?? 0,
      title,
      prerequisites: Array.isArray(c.prerequisites)
        ? c.prerequisites.map((x) => toInt(x)).filter((x): x is number => x !== null)
        : [],
      prereqReason: typeof c.prereqReason === 'string' ? c.prereqReason.slice(0, 200) : '',
      difficulty: toDifficulty(c.difficulty),
      basis: c.basis === 'search' || c.basis === 'model' ? c.basis : 'toc',
      sections,
    });
  }

  if (chapters.length === 0) return null;

  return {
    subject: typeof o.subject === 'string' ? o.subject.slice(0, 60) : '',
    edition: typeof o.edition === 'string' ? o.edition.slice(0, 80) : '',
    sourceId: typeof o.sourceId === 'string' ? o.sourceId : '',
    chapters,
    beyond: Array.isArray(o.beyond)
      ? o.beyond
          .map((b) => {
            if (!b || typeof b !== 'object') return null;
            const x = b as Record<string, unknown>;
            const t = typeof x.title === 'string' ? x.title.trim().slice(0, 80) : '';
            if (t.length === 0) return null;
            return { title: t, note: typeof x.note === 'string' ? x.note.slice(0, 200) : '' };
          })
          .filter((x): x is { title: string; note: string } => x !== null)
      : [],
    usedSearch: o.usedSearch === true,
    droppedOutOfScope: toInt(o.droppedOutOfScope) ?? 0,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
  };
}

function normalizeSection(raw: unknown): SectionNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  const title = typeof s.title === 'string' ? s.title.trim().slice(0, 120) : '';
  if (title.length === 0) return null;

  const rawTasks = s.tasks;
  const t = rawTasks && typeof rawTasks === 'object' ? (rawTasks as Record<string, unknown>) : {};

  const resources: SectionResource[] = [];
  if (Array.isArray(t.resources)) {
    for (const rr of t.resources) {
      if (!rr || typeof rr !== 'object') continue;
      const r = rr as Record<string, unknown>;
      const rt = typeof r.title === 'string' ? r.title.trim().slice(0, 120) : '';
      const url = typeof r.url === 'string' ? r.url.trim() : '';
      /* 没有 url 的资源是废数据（点不开），丢掉 */
      if (rt.length === 0 || url.length === 0) continue;
      resources.push({
        id: typeof r.id === 'string' ? r.id : 'res_' + Math.random().toString(36).slice(2, 10),
        title: rt,
        url,
        source: r.source === 'search' ? 'search' : 'manual',
      });
    }
  }

  const custom: { id: string; text: string; done: boolean }[] = [];
  if (Array.isArray(t.custom)) {
    for (const rc of t.custom) {
      if (!rc || typeof rc !== 'object') continue;
      const c = rc as Record<string, unknown>;
      const text = typeof c.text === 'string' ? c.text.trim().slice(0, 200) : '';
      if (text.length === 0) continue;
      custom.push({
        id: typeof c.id === 'string' ? c.id : 'cus_' + Math.random().toString(36).slice(2, 10),
        text,
        done: c.done === true,
      });
    }
  }

  return {
    id: typeof s.id === 'string' && s.id.length > 0 ? s.id : newSectionId(),
    title,
    segmentIds: Array.isArray(s.segmentIds)
      ? s.segmentIds.filter((x): x is string => typeof x === 'string')
      : [],
    origin:
      s.origin === 'ai' || s.origin === 'whole-chapter' ? s.origin : 'heading',
    tasks: {
      resources,
      resourceDone: t.resourceDone === true,
      flashcardsDone: t.flashcardsDone === true,
      exerciseDone: t.exerciseDone === true,
      custom,
    },
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toDifficulty(v: unknown): number | null {
  const n = toInt(v);
  /* 只认 1–5；越界不夹到边界值（夹值等于替模型编了个它没说过的判断） */
  if (n === null || n < 1 || n > 5) return null;
  return n;
}