/**
 * 闪卡管理：把两种来源的闪卡汇到一处（2026-11-14 按用户反馈重做）。
 *
 * ## ⚠️ 上一版错在哪
 *
 * 上一版把「错题闪卡」做成了**从复习记录推导**的东西：
 * 复习记录里最近一次答错的题 → 直接在界面上显示成卡片。
 * 后果是题目一被删，那张卡就消失；而且用户根本没有「选择」这一步。
 *
 * 用户反馈原话：
 * > 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 * >  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。」
 *
 * ## 现在的模型（与用户要求一致）
 *
 * 两种来源**都只是建卡时的素材**，一旦建成，卡就是独立内容：
 *
 * | | 知识点闪卡 | 错题闪卡 |
 * |---|---|---|
 * | 用户动作 | 从知识库挑 → 「加入闪卡」 | 从错题挑 → 「做成闪卡」 |
 * | 建卡时 | 把 knowledgePoint.statement 抄进正面 | 把题干抄进正面、答案+解析抄进背面 |
 * | 建成之后 | **独立**，知识点删了不影响 | **独立**，题目删了不影响 |
 * | 能改内容 | 能（正反面都能改） | 能 |
 * | 能删 | 能 | 能 |
 *
 * 也就是说：**这一页看到的每一张卡都是 flashcards 分区里的真记录**，
 * 不再有任何「推导出来的假卡」。所以也不再有 alive / stale 这种
 * 「来源还在不在」的状态 —— 来源与卡片无关了。
 *
 * `sourceKind` 只用于分组显示（「这张当初是从哪来的」）和追溯。
 *
 * ## 2026-11-23：三大类型改为「知识点 / 错题 / 记忆」，并加按资料分组
 *
 * 用户原话：
 * > 可以去掉手写的闪卡这一栏，让用户在编写完成后通过选择标签决定闪卡存放位置。
 * > 再增加一个在三大类型闪卡下按照所属资料进行分类的功能。
 *
 * 所以：
 *
 * | 变化 | 做法 |
 * |---|---|
 * | 去掉「手写的」这一栏 | `FlashcardGroup` 的 `manual` 换成 `memory`；**旧卡不迁移** —— `sourceKind` 仍是 `manual`/`ai`，只在展示层映射成 `memory`，用户原来手写的卡一张不丢，只是换个栏 |
 * | 按所属资料分类 | `groupBySource()`（纯函数）；资料标题由调用方注入（组件不碰存储，项目一贯分工） |
 * | 标签决定存放位置 | `UnifiedCard.tags` + `collectTags()`；标签是**第二个筛选维度**，与「所属资料」互不替代（资料=书的结构，标签=用户自己的归档口径） |
 */

import type { FlashcardView } from '@/core/flashcards.ts';
import type { FlashcardFolder } from '@/v2/core/flashcard-folders.ts';

/**
 * 三大类型（展示用分组）。
 *
 * ⚠️ `memory`（记忆闪卡）取代了原来的 `manual`（手写的）这一栏
 * （2026-11-23 用户要求「去掉手写的闪卡这一栏」）。
 * 但**数据层不动**：`Flashcard.sourceKind` 仍可能是 `manual` / `ai`，
 * 只在下面 `toUnifiedCards` 里映射成 `memory` ——
 * 用户原来手写的卡一张不丢，只是换个栏显示。
 */
export type FlashcardGroup = 'point' | 'wrong' | 'memory';

/** 统一后的一张卡 */
export interface UnifiedCard {
  /** 闪卡自身 id（现在就是真记录 id，不再有前缀拼装） */
  id: string;
  /** 稳定 key（React 用） */
  key: string;
  group: FlashcardGroup;
  /** 正面 */
  front: string;
  /** 背面；null = 没有 */
  back: string | null;
  /** 来源追溯标签（「来自：信号与系统 · 第2章」）；null = 没有可显示的 */
  sourceLabel: string | null;
  /**
   * 归属资料 id（2026-11-23，按资料分组要用）。
   * null = 这张卡没关联资料（手工写的、或来源知识点本来就没 sourceId）。
   */
  sourceId: string | null;
  /** 用户标签（2026-11-23）；旧卡没有 → 空数组 */
  tags: string[];
  /** 卡型（2026-11-23）：'cloze' 时正面含 ==挖空== */
  format: 'qa' | 'cloze';
  /**
   * 所在文件夹 id（2026-11-23 晚）；null = 未归入任何文件夹。
   *
   * ⚠️ 文件夹归属**不在 flashcards 记录里**，存在 settings.flashcardFolders.assigns。
   * 理由：往 Flashcard 加字段就要动备份兼容与迁移；而归属是"用户怎么归类"，
   * 不是卡本身的内容。所以这里由 toUnifiedCards 的第 2 参注入。
   */
  folderId: string | null;
}

/**
 * 把服务层的视图转成统一形状。
 *
 * 注意它**不再读 `v.point` / `v.stale`** —— 那两个字段在
 * 2026-11-14 的模型里已经不存在了（闪卡独立，无来源依赖）。
 *
 * 第 2 参 `assigns` 是文件夹归属（2026-11-23 晚，settings.flashcardFolders.assigns）。
 * 不传 = 所有卡都「未归入文件夹」，现有调用点不受影响。
 */
export function toUnifiedCards(
  views: readonly FlashcardView[],
  assigns: Readonly<Record<string, string>> = {},
): UnifiedCard[] {
  return views.map((v) => {
    /*
     * 分组：按 sourceKind。旧卡没有这个字段时，服务层会用
     * knowledgePointId 推断成 'point' 或 'manual'（见 sourceKindOf）。
     *
     * ⚠️ 'manual' 与 'ai' 都归进 'memory'（记忆闪卡）——
     * 数据层不改名（改了要迁移全库），只在展示层合并这一栏。
     */
    const kind = v.card.sourceKind ?? (v.card.knowledgePointId ? 'point' : 'manual');
    const group: FlashcardGroup =
      kind === 'point' ? 'point' : kind === 'wrong' ? 'wrong' : 'memory';

    return {
      id: v.card.id,
      key: v.card.id,
      group,
      front: v.front,
      back: v.back,
      sourceLabel: v.sourceLabel,
      sourceId: v.card.sourceId ?? null,
      tags: Array.isArray(v.card.tags) ? v.card.tags : [],
      format: v.card.format === 'cloze' ? 'cloze' : 'qa',
      folderId: assigns[v.card.id] ?? null,
    };
  });
}

export interface CardFilter {
  group: FlashcardGroup | 'all';
  /** 搜索词（正面/背面都搜），空 = 不过滤 */
  query: string;
  /**
   * 只看某一份资料的卡（2026-11-23）。
   * 缺省 = 不按资料筛；`'__none__'` = 只看没关联资料的卡
   * （界面上那一组叫「未关联资料」）。
   */
  sourceId?: string | null;
  /** 只看带某个标签的卡（2026-11-23）；null/空 = 不按标签筛 */
  tag?: string | null;
  /**
   * 只看某个文件夹里的卡（2026-11-23 晚）。
   * 缺省 = 不按文件夹筛；`'__nofolder__'` = 只看未归入文件夹的卡。
   */
  folder?: string | null;
}

export const DEFAULT_FILTER: CardFilter = { group: 'all', query: '' };

/** 「没有所属资料」那一组的哨兵值（与 sourceId=null 对应） */
export const NO_SOURCE = '__none__';

/** 「未归入文件夹」那一组的哨兵值（与 folderId=null 对应） */
export const NO_FOLDER = '__nofolder__';

/**
 * 按当前筛选条件过滤。
 *
 * 搜索**同时搜正反面**：用户多半只记得那句话，不记得在哪一面。
 *
 * ## 资料与标签是两个独立维度（2026-11-23）
 *
 * 用户要的是「三大类型下按所属资料分类」+「通过标签决定存放位置」，
 * 两者**都要能筛**，所以这里是 AND 关系叠加：
 * 类型 → 资料 → 标签 → 关键词，逐层收窄。
 * 少任何一层都会出现"筛了资料就丢标签"那种半套功能。
 */
export function filterCards(cards: readonly UnifiedCard[], f: CardFilter): UnifiedCard[] {
  const q = f.query.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.group !== 'all' && c.group !== f.group) return false;
    if (f.sourceId !== undefined && f.sourceId !== null) {
      const want = f.sourceId === NO_SOURCE ? null : f.sourceId;
      if (c.sourceId !== want) return false;
    }
    if (f.folder !== undefined && f.folder !== null) {
      const want = f.folder === NO_FOLDER ? null : f.folder;
      if (c.folderId !== want) return false;
    }
    if (f.tag !== undefined && f.tag !== null && f.tag.length > 0) {
      if (c.tags.indexOf(f.tag) < 0) return false;
    }
    if (!q) return true;
    const hay = `${c.front}\n${c.back ?? ''}`.toLowerCase();
    return hay.indexOf(q) !== -1;
  });
}

/**
 * 判断一个标签筛选是否还该保留（2026-11-23 晚修 bug 用）。
 *
 * ## 修的是什么
 *
 * 用户反馈原话：「闪卡打上标签后，选择了特定的标签分组，之后删掉标签后
 * 界面会显示没有符合条件的卡。」
 *
 * 根因：标签 chip 那一行是从**当前数据**算出来的（`collectTags`），
 * 标签被删光后 chip 消失；但 `filter.tag` 还留着旧值，
 * 于是筛出 0 张 —— 而用户**看不到那个 chip，也就没有任何地方能取消它**，
 * 界面就永久卡在空列表上。这类"状态还在、入口没了"是死锁，
 * 不是简单的筛得严。
 *
 * ## 做法
 *
 * 纯函数：标签仍在 → 原样返回（保留用户的筛选）；
 * 标签已不存在 → 返回 null（调用方据此清掉 filter.tag）。
 * **不要**在 filterCards 里悄悄忽略不存在的标签 ——
 * 那样用户以为筛着某个标签，实际看到的是全部，是反向的错觉。
 */
export function reconcileTag(tag: string | null | undefined, known: readonly string[]): string | null {
  if (tag === undefined || tag === null || tag.length === 0) return null;
  return known.indexOf(tag) >= 0 ? tag : null;
}

/** 计数（界面上的数字都来自同一份数据，不各算一遍） */
export function countByGroup(cards: readonly UnifiedCard[]): {
  point: number;
  wrong: number;
  memory: number;
  total: number;
} {
  let point = 0;
  let wrong = 0;
  let memory = 0;
  for (const c of cards) {
    if (c.group === 'point') point++;
    else if (c.group === 'wrong') wrong++;
    else memory++;
  }
  return { point, wrong, memory, total: cards.length };
}

/** 按资料分组的结果 */
export interface SourceGroup {
  /** 资料 id；null = 未关联资料那一组 */
  sourceId: string | null;
  /** 界面上显示的组名（资料标题；null 时是「未关联资料」） */
  title: string;
  count: number;
  cards: UnifiedCard[];
}

/**
 * 把一批卡按所属资料分组（2026-11-23，用户要求）。
 *
 * ## 顺序规则（必须确定，不能靠 Map 的插入顺序）
 *
 * 有资料的组按**卡数多的在前**，并列时按标题排 ——
 * 「未关联资料」永远排最后（它是兜底组，不该抢在前面）。
 * 不这么定的话，同一份库每次打开顺序可能不同，
 * 用户记不住"我那组卡在第几个"。
 *
 * ## 标题由调用方给（组件不碰存储）
 *
 * `titleOf` 找不到标题时**如实回落到「（资料名读不到）」**，
 * 而不是显示裸 id —— 那类 `__all__` 显示事故项目记过。
 */
export function groupBySource(
  cards: readonly UnifiedCard[],
  titleOf: (sourceId: string) => string | null,
): SourceGroup[] {
  const byId = new Map<string | null, UnifiedCard[]>();
  for (const c of cards) {
    const list = byId.get(c.sourceId);
    if (list) list.push(c);
    else byId.set(c.sourceId, [c]);
  }

  const out: SourceGroup[] = [];
  for (const [sourceId, list] of byId) {
    out.push({
      sourceId,
      title:
        sourceId === null
          ? '未关联资料'
          : titleOf(sourceId) ?? '（资料名读不到）',
      count: list.length,
      cards: list,
    });
  }

  out.sort((a, b) => {
    if (a.sourceId === null) return 1;
    if (b.sourceId === null) return -1;
    if (b.count !== a.count) return b.count - a.count;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
  return out;
}

/**
 * 汇总每个标签**有多少张卡**（标签筛选条用）。
 *
 * ## 为什么按卡去重而不是数出现次数
 *
 * 脏数据里一张卡可能带两次同名标签（normalizeTags 在建卡/编辑时挡，
 * 但历史数据、别的入口写进来的都可能漏）。若这里数出现次数，
 * chip 会显示「高数 3」而实际只有 2 张卡带它 ——
 * 那正是本项目反复记的**重复计数**盲区（11-22「0/26 与 0/78」同一类）。
 * 所以一张卡对同一个标签最多贡献 1。
 *
 * 按卡数多的在前，并列按名字排 —— 与 groupBySource 同一套确定性规则。
 */
export function collectTags(cards: readonly UnifiedCard[]): { tag: string; count: number }[] {
  const n = new Map<string, number>();
  for (const c of cards) {
    /* 一张卡内的同名标签只算一次 */
    for (const t of new Set(c.tags)) n.set(t, (n.get(t) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag.localeCompare(b.tag, 'zh-Hans-CN')));
}

/** 按文件夹分组的结果 */
export interface FolderGroup {
  /** 文件夹 id；null = 「未归入文件夹」那一组 */
  folderId: string | null;
  /** 界面上显示的组名 */
  title: string;
  count: number;
  cards: UnifiedCard[];
}

/**
 * 把一批卡按用户自建的文件夹分组（2026-11-23 晚，用户要求"像新建文件夹一样管理"）。
 *
 * ## 顺序与"空文件夹"规则（两条都是刻意的）
 *
 * 1. **按用户建文件夹的先后顺序**排，不按卡数排 ——
 *    文件夹是用户自己搭的结构，位置被人为安排过，
 *    按卡数重排会让"我刚建的文件夹跑到第 5 个"（与按资料分组不同：
 *    资料顺序来自书本结构，用户没排过）。
 * 2. **空文件夹照样显示，计数 0** ——
 *    否则"新建文件夹"点完界面上什么都没出现，看上去像没生效
 *    （本项目记过的"做了没接上"同类体验事故）。它也是拖卡的落点。
 * 3. **「未归入文件夹」有卡才出现** —— 它是兜底桶不是用户建的，
 *    没有落单的卡时不该占一行。
 *
 * ## 不属于任何已知文件夹的卡
 *
 * `normalizeFolderSettings` 已经把指向不存在文件夹的 assigns 清掉了，
 * 所以这里不会出现"孤儿归属"。万一将来有别的入口写坏数据，
 * 这里按「未归入文件夹」处理（`assigns[id]` 不在 folders 里 → 落到 null 组），
 * 而不是让卡凭空消失。
 */
export function groupByFolder(
  cards: readonly UnifiedCard[],
  folders: readonly FlashcardFolder[],
): FolderGroup[] {
  const known = new Set(folders.map((f) => f.id));
  const byId = new Map<string | null, UnifiedCard[]>();
  for (const c of cards) {
    const key = c.folderId !== null && known.has(c.folderId) ? c.folderId : null;
    const list = byId.get(key);
    if (list) list.push(c);
    else byId.set(key, [c]);
  }

  const out: FolderGroup[] = folders.map((f) => {
    const list = byId.get(f.id) ?? [];
    return { folderId: f.id, title: f.name, count: list.length, cards: list };
  });

  const loose = byId.get(null) ?? [];
  if (loose.length > 0) {
    out.push({ folderId: null, title: '未归入文件夹', count: loose.length, cards: loose });
  }
  return out;
}

