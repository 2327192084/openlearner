/**
 * 记忆闪卡服务（2026-11-10；2026-11-14 按用户反馈重做）。
 *
 * ## 它解决什么
 *
 * 知识点是「一句话 + 原文引证」，但知识库那一页是用来**翻阅**的：
 * 一屏几十条，扫过去什么也记不住。记忆需要的是「一次只面对一张卡，
 * 先自己想，再翻面核对」——那正是闪卡的形态。
 *
 * 与「今日复习」的分工：
 *  - **今日复习**：按遗忘曲线排期，只做到期的，会写复习间隔（SRS）
 *  - **记忆闪卡**：用户自己挑出来的重点，随时翻，**不参与排期**
 *
 * ## ⚠️ 2026-11-14 的核心修正
 *
 * 用户反馈原话：
 * > 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 * >  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。」
 *
 * 上一版的模型是「引用知识点」：正面抄一份 statement，背面靠知识点的
 * quotes 动态取，读取时校验「知识点还在不在」，删了就标「来源已删」。
 *
 * 那是错的 —— 会随来源消失而残缺的东西不是闪卡，是个视图。
 *
 * 现在：**内容在建卡时抄进来**（正面 + 背面都是完整独立文本），
 * 建完就与来源无关。`sourceKind` / `sourceId2` 只用于追溯
 * （界面上显示「来自：信号与系统 · 第 2 章」），删掉来源不影响卡片。
 *
 * ## 为什么不写 reviewRecords
 *
 * 闪卡翻看**不写复习记录**。理由与「自测」相同：用户在书里随手过一遍，
 * 不该改变他真实的间隔安排。想排期就去「今日复习」。
 * 这个边界如果不划清，两套东西会互相污染 —— 翻了几张闪卡，
 * 到期队列就变了，用户完全无法理解为什么。
 *
 * ## 删卡不进回收站
 *
 * 闪卡现在是**独立内容**，删了就真没了（与「引用」时代不同，
 * 那时删了还能从知识点重建）。它仍不进回收站：
 * 回收站躺 30 天会让用户以为还能还原，而闪卡往往是「临时记一下就删」
 * 的便签式内容。代价是误删不可恢复 —— 所以界面删除必须二次确认。
 *
 * ## 2026-11-23 补：**批量**删（整组 / 整个文件夹）进回收站
 *
 * 上面那条只适用于**单张**。「删这一组」是用户点一下就可能带走十几张卡，
 * 误点一次的代价与「删一张便签」不是一个量级 —— 所以 `removeMany` 走回收站，
 * 并且是一批合成一条记录（回收站里看到「删了 8 张闪卡」，而不是 8 条）。
 *
 * 两条路径刻意不对称，理由就一句：**误伤面积**。
 * 单卡：误删成本低，进回收站反而让人以为还留着；批量：误删成本高，必须能还原。
 */

import type { Flashcard, KnowledgePoint } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';
import type { TrashService, TrashEntry } from './trash.ts';
import { newId, nowIso } from './id.ts';

/** 建卡时的输入 */
export interface FlashcardDraft {
  /** 正面（问题/提示）。必填，空白会被拒绝 */
  frontText: string;
  /** 背面（答案/解释）。可为空 —— 有的卡只想记一个提示 */
  backText?: string | null;
  /**
   * 来源类型（仅追溯用）。
   *
   * 不传时按 `knowledgePointId` 推断：有就是 'point'，没有就是 'manual'。
   */
  sourceKind?: 'point' | 'wrong' | 'manual' | 'ai';
  /** 来源对象 id（知识点 id / 题目 id），仅追溯用 */
  sourceId2?: string | null;
  /** 旧字段：知识点 id。保留兼容，新代码用 sourceId2 + sourceKind */
  knowledgePointId?: string;
  /** 归属资料 id（仅追溯用） */
  sourceId?: string | null;
  origin: 'ai' | 'user';
  /**
   * 用户标签（2026-11-23）。
   *
   * 用户原话：「让用户在编写完成后通过选择标签决定闪卡存放位置。」
   * 建卡时可以不填（之后在管理页编辑），所以这里可选。
   */
  tags?: readonly string[];
  /** 卡型（2026-11-23）：缺省 'qa'；挖空卡传 'cloze' */
  format?: 'qa' | 'cloze';
}

/**
 * 闪卡视图。
 *
 * ⚠️ 2026-11-14 起**不再有 `stale`**（不再校验来源是否还在）。
 * 闪卡是独立的，来源删了它一个字都不变 —— 这正是用户要的。
 *
 * 只保留一个「来源追溯」用的标签，供界面上写「来自 XXX」。
 * 拿不到来源就什么都不写，不是错误状态。
 */
export interface FlashcardView {
  card: Flashcard;
  /** 正面（统一取值） */
  front: string;
  /** 背面（统一取值：backText → backNote → null） */
  back: string | null;
  /** 来源标签，如「信号与系统 · 第2章」；null = 没有可显示的信息 */
  sourceLabel: string | null;
}

/** 旧卡没有 backText 时回落到 backNote（2026-11-14 的兼容规则） */
export function backOf(card: Flashcard): string | null {
  const t = (card.backText ?? '').trim();
  if (t) return t;
  const n = (card.backNote ?? '').trim();
  return n || null;
}

/**
 * 标签规范化（2026-11-23）。
 *
 * 三件事：trim、去空、去重（保序）。
 *
 * ## 为什么必须去重
 *
 * 界面上标签是 chip 逐个加的，用户很容易把同一个名字加两遍
 * （尤其是从别的卡复制过来的时候）。重复标签会让
 * 「这张卡有几个标签」与「导出写出几个 `#flashcards/xxx` 分节」不一致 ——
 * 那是本项目反复记的关系型错误。
 *
 * ## 为什么大小写敏感
 *
 * Obsidian 的嵌套标签 `#flashcards/高数` 与 `#flashcards/高等数学`
 * 是两个不同卡组；把 `math` 自动改成 `Math` 反而会让用户找不到自己的卡组。
 * 所以只做空白与重复的处理，不改字母。
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = (raw ?? '').trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 读一张卡的标签（旧卡没有这个字段 → 空数组，不报错） */
export function tagsOf(card: Flashcard): string[] {
  return Array.isArray(card.tags) ? card.tags : [];
}

/** 读一张卡的卡型（旧卡没有 → 'qa'） */
export function formatOf(card: Flashcard): 'qa' | 'cloze' {
  return card.format === 'cloze' ? 'cloze' : 'qa';
}

/**
 * 来源类型推断（旧卡没有 sourceKind 字段）。
 *
 * 规则：有 knowledgePointId → 'point'，否则 'manual'。
 * 旧数据里不存在「从错题来的卡」（那是 2026-11-14 才加的）。
 */
export function sourceKindOf(card: Flashcard): 'point' | 'wrong' | 'manual' | 'ai' {
  if (card.sourceKind) return card.sourceKind;
  return card.knowledgePointId ? 'point' : 'manual';
}

export class FlashcardService {
  constructor(
    private readonly storage: StorageAdapter,
    /** 回收站（2026-11-08），可选。不传则删除不可恢复 */
    private readonly trash?: TrashService,
  ) {}

  /**
   * 全部闪卡。
   *
   * 排序：新建的在前 —— 用户刚加完一张会想立刻看到它。
   */
  async list(): Promise<Flashcard[]> {
    const all = await this.storage.getAll('flashcards');
    return [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * 带展示字段的列表。
   *
   * 来源标签通过 `labelOfSource` 注入（它要读知识点/题目表，
   * 让调用方决定要不要付这个成本 —— 有的界面不需要来源）。
   *
   * ⚠️ 这里**不再判断来源是否还在**：闪卡独立，来源没了不影响它。
   * `labelOfSource` 返回 null 就是「没有可显示的信息」，不是错误。
   */
  async listWithLabels(
    labelOfSource?: (card: Flashcard) => string | null,
  ): Promise<FlashcardView[]> {
    const cards = await this.list();
    return cards.map((card) => ({
      card,
      front: card.frontText,
      back: backOf(card),
      sourceLabel: labelOfSource ? labelOfSource(card) : null,
    }));
  }

  /**
   * 兼容旧调用方（上一版叫 listWithPoints）。
   *
   * 内部已经不再依赖知识点表 —— 闪卡独立之后，
   * 「知识点还在不在」与卡片显示无关了。
   */
  async listWithPoints(): Promise<FlashcardView[]> {
    return this.listWithLabels();
  }

  /**
   * 批量建卡。
   *
   * ## 去重规则变了（2026-11-14）
   *
   * 上一版按 `knowledgePointId` 去重（一个知识点只能有一张卡）。
   * 现在闪卡是**独立内容**，同一个知识点用户可能想做成两张角度不同的卡
   * （一张背定义、一张背公式）。所以只有**正面完全相同**时才跳过。
   *
   * ## 为什么空白正面被拒绝
   *
   * 空白正面的卡翻开来是白的，用户会以为坏了。宁可建卡时就拒绝。
   */
  async addMany(drafts: readonly FlashcardDraft[]): Promise<Flashcard[]> {
    const existing = await this.storage.getAll('flashcards');
    /** 按「正面全文」判重（trim 后比较） */
    const takenFront = new Set(existing.map((c) => c.frontText.trim()));

    const ts = nowIso();
    const created: Flashcard[] = [];

    for (const d of drafts) {
      const front = d.frontText.trim();
      if (!front) continue;
      if (takenFront.has(front)) continue;

      const card: Flashcard = {
        id: newId('fc'),
        frontText: front,
        backText: d.backText?.trim() || null,
        backNote: null,
        sourceKind: d.sourceKind ?? (d.knowledgePointId ? 'point' : 'manual'),
        sourceId2: d.sourceId2 ?? d.knowledgePointId ?? null,
        ...(d.knowledgePointId ? { knowledgePointId: d.knowledgePointId } : {}),
        origin: d.origin,
        sourceId: d.sourceId ?? null,
        /*
         * 标签与卡型（2026-11-23）。
         *
         * ⚠️ 标签在这里过一次 normalizeTags：去空、去重、trim。
         * 不规范化会出现 `['高数', ' 高数']` 这种两条同名标签 ——
         * 导出时就会写成两个 `#flashcards/高数` 分节，
         * 那是"界面显示的标签数"与"导出的分节数"对不上的关系错误。
         */
        tags: normalizeTags(d.tags ?? []),
        ...(d.format === 'cloze' ? { format: 'cloze' as const } : {}),
        createdAt: ts,
        updatedAt: ts,
      };
      await this.storage.put('flashcards', card);
      takenFront.add(front);
      created.push(card);
    }

    return created;
  }

  /** 建一张 */
  async add(draft: FlashcardDraft): Promise<Flashcard | null> {
    const out = await this.addMany([draft]);
    return out[0] ?? null;
  }

  /** 改内容（正面/背面都能改 —— 它们现在是这张卡自己的内容） */
  async update(
    id: string,
    patch: {
      frontText?: string;
      backText?: string | null;
      /** 标签（2026-11-23）：传了就整体替换（界面是"编辑这一组标签"的语义） */
      tags?: readonly string[];
      /** 卡型（2026-11-23） */
      format?: 'qa' | 'cloze';
      /**
       * 归属类型（2026-11-24，用户要求「写完闪卡后再决定归属」）。
       *
       * 传了就把这张卡挪到那一栏（知识点 / 错题 / 记忆）。
       *
       * ⚠️ 只改 `sourceKind`，**不动 `sourceId2`**：
       * 那是"这张卡原来从哪抄来的"的线索，用户改归属不代表它换了来源。
       * 跟着一起改写会出现「标成知识点、点进去却指向一道错题」。
       */
      sourceKind?: 'point' | 'wrong' | 'manual';
    },
  ): Promise<Flashcard | null> {
    const card = await this.storage.get('flashcards', id);
    if (!card) return null;

    const front = patch.frontText !== undefined ? patch.frontText.trim() : card.frontText;
    if (!front) return null; // 正面不能改成空

    const next: Flashcard = {
      ...card,
      frontText: front,
      ...(patch.backText !== undefined ? { backText: patch.backText?.trim() || null } : {}),
      /*
       * 标签同样过 normalizeTags —— 编辑路径与建卡路径必须一套规则，
       * 否则建卡去了重、编辑时又能塞回重复的。
       */
      ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
      ...(patch.format !== undefined ? { format: patch.format } : {}),
      ...(patch.sourceKind !== undefined ? { sourceKind: patch.sourceKind } : {}),
      updatedAt: nowIso(),
    };
    await this.storage.put('flashcards', next);
    return next;
  }

  /** 改背面补充（旧接口，保留兼容） */
  async setBackNote(id: string, note: string | null): Promise<Flashcard | null> {
    const card = await this.storage.get('flashcards', id);
    if (!card) return null;
    const next: Flashcard = {
      ...card,
      backNote: note && note.trim() ? note.trim() : null,
      updatedAt: nowIso(),
    };
    await this.storage.put('flashcards', next);
    return next;
  }

  /** 删一张（不进回收站，见头注释） */
  async remove(id: string): Promise<boolean> {
    const card = await this.storage.get('flashcards', id);
    if (!card) return false;
    await this.storage.remove('flashcards', id);
    return true;
  }

  /**
   * 批量删卡（「删这一组」/「删这个文件夹」用）—— **进回收站**。
   *
   * 与 `remove` 刻意不对称（理由见头注释末尾）。一批合成一条回收站记录：
   * `moveToTrash` 的语义就是「同一次删除动作」合成一条，还原时整批一起回来。
   *
   * @returns 实际删掉的张数（传进来的 id 有已经不存在的，不计数）
   */
  async removeMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const want = new Set(ids);
    const hit = (await this.storage.getAll('flashcards')).filter((c) => want.has(c.id));
    if (hit.length === 0) return 0;

    /*
     * 先收进回收站，再从原分区删。
     * 顺序不能反：反了就是「先真删、后备份」，中间崩一次数据就没了。
     */
    if (this.trash) {
      const entries: TrashEntry[] = hit.map((c) => ({
        kind: 'flashcards',
        title: c.frontText.slice(0, 40),
        summary: '闪卡',
        payload: c,
      }));
      await this.trash.moveToTrash(entries);
    }

    for (const c of hit) await this.storage.remove('flashcards', c.id);
    return hit.length;
  }

  /** 某个知识点是否已经建过卡（界面用它显示「已加入」而不是重复按钮） */
  async hasForPoint(knowledgePointId: string): Promise<boolean> {
    const all = await this.storage.getAll('flashcards');
    return all.some(
      (c) => c.knowledgePointId === knowledgePointId || c.sourceId2 === knowledgePointId,
    );
  }

  /** 删掉某个知识点建的所有卡 */
  async removeForPoint(knowledgePointId: string): Promise<number> {
    const all = await this.storage.getAll('flashcards');
    const hit = all.filter(
      (c) => c.knowledgePointId === knowledgePointId || c.sourceId2 === knowledgePointId,
    );
    for (const c of hit) await this.storage.remove('flashcards', c.id);
    return hit.length;
  }

  /** 某份资料下的闪卡（按冗余的 sourceId 筛，不反查知识点表） */
  async listBySource(sourceId: string): Promise<Flashcard[]> {
    const all = await this.list();
    return all.filter((c) => c.sourceId === sourceId);
  }
}

/**
 * 从知识点生成一张卡的草稿（界面「加入闪卡」时用）。
 *
 * 注意：**内容在这里就被抄进草稿了**，之后与知识点无关 ——
 * 这正是用户要的「独立」。
 */
export function draftFromPoint(
  point: KnowledgePoint,
  origin: 'ai' | 'user' = 'user',
): FlashcardDraft {
  return {
    frontText: point.statement,
    /*
     * 背面留空：知识点的 quotes 是为了「点回原文」的引证，
     * 不是「这张卡的答案」—— 两者语义不同，不能直接顶替。
     * 用户/AI 想给背面就显式给。
     */
    backText: null,
    sourceKind: 'point',
    sourceId2: point.id,
    knowledgePointId: point.id,
    sourceId: point.sourceId ?? null,
    origin,
  };
}
