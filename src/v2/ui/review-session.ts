/**
 * 「今日复习」会话（2026-11-09）。
 *
 * ## 它解决什么
 *
 * 用户反复反馈：「开始复习」进去跟「做题」没区别。调研（Anki / Ebbinghaus /
 * StudyHub）后的结论是 —— 复习与做题的差别不在「做不做题」，而在三件事：
 *
 *  1. **只能做今天到期的**，不给自由挑（这是复习的约束）
 *  2. **有固定批次与结束点**，做完这批就结束，不是无限刷
 *  3. **先自己回想，再看答案**，然后自评四档（Anki 的核心交互）
 *
 * 本模块负责 1 与 2 的队列构造、3 的会话状态机，以及结束时的回顾数据。
 *
 * ## 与「做题」的分界
 *
 * | | 做题（PracticePage / ReviewPage） | 本节（今日复习） |
 * | --- | --- | --- |
 * | 选什么 | 任意题组/任意题 | 只今日到期 + 新卡 |
 * | 何时结束 | 想停就停 | 本批做完就结束 |
 * | 交互 | 选项作答 → 判分 | **先回想 → 翻面 → 自评四档** |
 * | 结束 | 本轮小结 | **今日回顾**（含「明天要复习多少」） |
 *
 * ## 为什么不复用 ReviewPage
 *
 * ReviewPage 是「做一道题 → 判对错」的流程，判分来自答案比对；
 * 复习的评分来自**用户自评**（again/hard/good/easy），两者语义不同，
 * 塞进同一个组件会让两套状态互相打架。
 */

import type { ReviewGrade } from '@/v2/core/srs.ts';

/** 一道待复习的题 */
export interface ReviewItem {
  /** 卡片 id（题目 id） */
  cardId: string;
  /** 题干（遮住答案时只显示这个） */
  prompt: string;
  /** 完整题目，用于展示答案与解析 */
  question: unknown;
  /** 是不是新卡（从没做过）。新卡与到期卡在回顾里分开计数 */
  isNew: boolean;
}

/**
 * 今日复习队列的构造结果。
 *
 * 为什么把「为什么是这些」一起返回：界面要如实说明
 * 「今天有 5 张到期 + 3 张新卡」，而不是丢一个总数让人猜。
 */
export interface ReviewQueue {
  /** 到期的（有记录且 dueAt <= today），逾期最久的在前 */
  due: ReviewItem[];
  /** 从没做过的新卡 */
  fresh: ReviewItem[];
  /** 队列总长（due + fresh，可能被批次上限截断） */
  total: number;
  /** 截断前一共有多少（用于「还剩多少」的说明） */
  availableBeforeLimit: number;
}

/** 一批最多多少张。与做题页的 BATCH 保持一致，避免两处口径不同 */
export const REVIEW_BATCH = 30;

/** 构造队列时的输入 */
export interface BuildQueueInput<T> {
  /** 卡片池里的全部卡（已按发布范围过滤） */
  cards: readonly { id: string; question: T }[];
  /** cardId → 复习状态（只用到 dueAt） */
  dueAtByCard: ReadonlyMap<string, string>;
  /** 今天（本地日期串） */
  today: string;
  /** 每题的题干提取器 */
  promptOf: (q: T) => string;
  /** 批次上限 */
  limit?: number;
}

/**
 * 构造今日复习队列。
 *
 * ## 排序的两个理由
 *
 * 1. **到期在前、新卡在后**：先还债再学新的。Anki 默认也是这个顺序
 *    （review before new），因为逾期卡拖久了更难补。
 * 2. **逾期最久的排最前**：它最可能已经被忘光了，先救它。
 */
export function buildReviewQueue<T>(input: BuildQueueInput<T>): ReviewQueue {
  const { cards, dueAtByCard, today, promptOf, limit = REVIEW_BATCH } = input;

  const dueRaw: Array<{ item: ReviewItem; dueAt: string }> = [];
  const freshRaw: ReviewItem[] = [];

  for (const c of cards) {
    const dueAt = dueAtByCard.get(c.id);
    if (dueAt === undefined) {
      freshRaw.push({
        cardId: c.id,
        prompt: promptOf(c.question),
        question: c.question,
        isNew: true,
      });
      continue;
    }
    if (dueAt <= today) {
      dueRaw.push({
        dueAt,
        item: {
          cardId: c.id,
          prompt: promptOf(c.question),
          question: c.question,
          isNew: false,
        },
      });
    }
  }

  dueRaw.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));

  const availableBeforeLimit = dueRaw.length + freshRaw.length;
  const due = dueRaw.slice(0, limit).map((x) => x.item);

  /* 到期没占满批次才补新卡 —— 先还债再学新的 */
  const roomLeft = Math.max(0, limit - due.length);
  const fresh = freshRaw.slice(0, roomLeft);

  return {
    due,
    fresh,
    total: due.length + fresh.length,
    availableBeforeLimit,
  };
}

// ---------------------------------------------------------------------------
// 会话状态机
// ---------------------------------------------------------------------------

/** 复习会话的一步 */
export type ReviewPhase =
  /** 只显示题干，等用户自己在心里回想 */
  | 'prompt'
  /** 已翻面，显示答案与解析，等用户自评 */
  | 'reveal';

/** 一条已完成的复习 */
export interface ReviewDone {
  cardId: string;
  grade: ReviewGrade;
  /** 当时是不是新卡（回顾里要分开统计） */
  wasNew: boolean;
}

export interface ReviewSession {
  /** 会话队列（due 在前，fresh 在后） */
  items: ReviewItem[];
  /** 当前第几题（0 基） */
  index: number;
  phase: ReviewPhase;
  /** 已评完的 */
  done: ReviewDone[];
}

/** 开始一个会话 */
export function startSession(queue: ReviewQueue): ReviewSession {
  return { items: [...queue.due, ...queue.fresh], index: 0, phase: 'prompt', done: [] };
}

/** 当前题；队列空或已走完则为 null */
export function currentItem(s: ReviewSession): ReviewItem | null {
  return s.items[s.index] ?? null;
}

/** 翻面看答案 */
export function reveal(s: ReviewSession): ReviewSession {
  if (s.phase === 'reveal') return s;
  return { ...s, phase: 'reveal' };
}

/**
 * 自评一档并进入下一题。
 *
 * 只能在 `reveal` 阶段调用 —— 「没看答案就评自己」会让评分失真
 * （用户还没确认自己答得对不对）。`prompt` 阶段调用返回原状态。
 */
export function grade(s: ReviewSession, g: ReviewGrade): ReviewSession {
  if (s.phase !== 'reveal') return s;
  const item = currentItem(s);
  if (!item) return s;

  const done = [...s.done, { cardId: item.cardId, grade: g, wasNew: item.isNew }];
  const nextIndex = s.index + 1;
  return {
    ...s,
    index: nextIndex,
    /* 下一题回到「只显示题干」—— 先回想再看答案 */
    phase: 'prompt',
    done,
  };
}

/** 会话是否已结束（全部评完） */
export function isFinished(s: ReviewSession): boolean {
  return s.index >= s.items.length;
}

/** 进度：已评 / 总数 */
export function progressOf(s: ReviewSession): { done: number; total: number } {
  return { done: s.done.length, total: s.items.length };
}

// ---------------------------------------------------------------------------
// 今日回顾
// ---------------------------------------------------------------------------

/** 会话结束后的回顾数据 */
export interface ReviewRecap {
  /** 本次评了几张 */
  total: number;
  /** 其中新卡 */
  newCount: number;
  /** 其中到期卡 */
  dueCount: number;
  /** 各档位分别几张 */
  byGrade: Record<ReviewGrade, number>;
  /**
   * 自评「还行 / 很熟」的占比（0~1）。没有记录时为 null —— 不显示假的 0%。
   *
   * 为什么只看这两档：again/hard 表示没记住，good/easy 表示记住了。
   * 这是「这次复习有多少真的记住了」的最直接度量。
   */
  rememberedRatio: number | null;
}

/** 从会话算出回顾 */
export function recapOf(s: ReviewSession): ReviewRecap {
  const byGrade: Record<ReviewGrade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  let newCount = 0;
  let dueCount = 0;

  for (const d of s.done) {
    byGrade[d.grade] += 1;
    if (d.wasNew) newCount += 1;
    else dueCount += 1;
  }

  const total = s.done.length;
  const remembered = byGrade.good + byGrade.easy;

  return {
    total,
    newCount,
    dueCount,
    byGrade,
    rememberedRatio: total > 0 ? remembered / total : null,
  };
}

/** 四档的界面文案与含义（与 Anki 对齐，措辞按中文习惯） */
export const GRADE_META: Array<{
  grade: ReviewGrade;
  label: string;
  hint: string;
}> = [
  { grade: 'again', label: '忘了', hint: '完全想不起来' },
  { grade: 'hard', label: '勉强', hint: '想起来了，但很吃力' },
  { grade: 'good', label: '还行', hint: '正常回忆出来' },
  { grade: 'easy', label: '很熟', hint: '毫不费力' },
];
