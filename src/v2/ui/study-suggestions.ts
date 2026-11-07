/**
 * 待办页的「学习建议」：从已有数据推导出「现在该做什么」。
 *
 * ## 为什么需要这个（用户 2026-11-08 要求「参考市面上的软件」）
 *
 * 待办列表回答的是「我自己记了什么」。但用户打开学习软件时，
 * 更常见的情况是**根本没记待办** —— 那就需要系统告诉他「还有这些事没做完」。
 *
 * 参考 StudyHub 的做法（`ui/study-map/next-step.js`）：
 * 它把这件事做成一个**固定优先级的状态机**，第一个成立的条件胜出，
 * 全部从本地快照算，不调模型。这里沿用同样的思路，但只取我们真有的数据。
 *
 * ## 和 StudyHub 的差异（照搬前想清楚）
 *
 * StudyHub 有「考试日期」「复习全书」「课程」这些概念，我们都没有：
 *  - `courses` 分区实测是空的
 *  - 没有考试日期字段
 *  - 复习全书是按资料聚合的题，不是独立计划
 *
 * 所以这里只用三条我们**确实有**的判断：
 *   1. 有资料但没出题       → 去出题
 *   2. 题组没练完           → 去练
 *   3. 有错题没巩固         → 去练错题
 *
 * ## 为什么是「建议」而不是「待办」
 *
 * 这些条目**不落库**。落库的话，用户每改一次数据就要同步一次待办列表，
 * 而同步必然出错（做完一道题就该少一条，谁去删？）。
 * 现算的代价只是每次进页面算一遍，而数据量很小（题组几十个）。
 */

import type { Todo } from '@/core/model.ts';

/** 建议的类型 */
export type SuggestionKind = 'make-questions' | 'practice-deck' | 'review-wrong';

export interface Suggestion {
  /** 稳定 key，用作 React key 与「已忽略」记录 */
  key: string;
  kind: SuggestionKind;
  /** 一句话说清这件事 */
  title: string;
  /** 为什么建议它（给用户一个理由，而不是命令） */
  reason: string;
  /** 让用户知道规模 */
  detail: string | null;
}

/** 推导建议所需的输入（全部来自已有数据） */
export interface SuggestionInput {
  /** 每题组：id、标题、总题数、练过几道、错几道 */
  decks: {
    id: string;
    title: string;
    total: number;
    done: number;
    wrong: number;
  }[];
  /** 有资料但一个题组都没有 */
  sourcesWithoutQuestions: number;
  /** 全库错题数 */
  wrongTotal: number;
  /** 已有待办（用于去重：用户已经自己记了就不要再建议同一条） */
  todos: readonly Todo[];
}

/**
 * 生成建议列表（按重要性排序）。
 *
 * 排序理由：**能立刻做且见效快的排前面**。
 * 「有 3 道错题没巩固」比「这份新资料还没出题」更该先做 ——
 * 前者十分钟能清完，后者要先跑模型。
 */
export function suggestionsOf(input: SuggestionInput): Suggestion[] {
  const out: Suggestion[] = [];

  /* ---- 1. 错题待巩固 ---- */
  if (input.wrongTotal > 0) {
    out.push({
      key: 'wrong',
      kind: 'review-wrong',
      title: `巩固 ${input.wrongTotal} 道错题`,
      reason: '这些题最近一次作答是错的，重做答对之后才会从错题列表里消失',
      detail: '十来分钟能清完一批',
    });
  }

  /* ---- 2. 没练完的题组 ---- */
  const unfinished = input.decks
    .filter((d) => d.total > 0 && d.done > 0 && d.done < d.total)
    // 练得越多的排前面：快做完的先收尾，比同时开五个组更有效
    .sort((a, b) => b.done / b.total - a.done / a.total)
    .slice(0, 2);

  for (const d of unfinished) {
    out.push({
      key: `deck:${d.id}`,
      kind: 'practice-deck',
      title: `继续练「${d.title}」`,
      reason: `这组 ${d.total} 道题，你练过 ${d.done} 道`,
      detail: d.wrong > 0 ? `其中 ${d.wrong} 道答错过` : null,
    });
  }

  /* ---- 3. 从没练过的题组 ---- */
  const untouched = input.decks.filter((d) => d.total > 0 && d.done === 0).slice(0, 1);
  for (const d of untouched) {
    out.push({
      key: `deck-new:${d.id}`,
      kind: 'practice-deck',
      title: `开始练「${d.title}」`,
      reason: `这组 ${d.total} 道题还没做过，做一遍才会进入复习安排`,
      detail: null,
    });
  }

  /* ---- 4. 有资料但没出题 ---- */
  if (input.sourcesWithoutQuestions > 0) {
    out.push({
      key: 'make-questions',
      kind: 'make-questions',
      title:
        input.sourcesWithoutQuestions === 1
          ? '给这份资料出题'
          : `给 ${input.sourcesWithoutQuestions} 份资料出题`,
      reason: '这些资料还没有题目，出了题才能开始练',
      detail: '要跑模型，花的时间比练题长',
    });
  }

  /*
   * 与已有待办去重。
   *
   * 用户已经自己记了「复习第3章」，就不该再建议「继续练第3章」——
   * 同一条建议出现在两个地方会让人以为要重复做一次。
   * 判断用标题包含：待办标题是用户手写的，不可能精确匹配，
   * 但「题组名出现在待办里」这个信号已经足够可靠。
   */
  const todoTitles = input.todos.filter((t) => !t.done).map((t) => t.title);
  return out.filter((s) => {
    if (s.kind === 'make-questions' || s.kind === 'review-wrong') return true;
    const deckName = s.title.replace(/^(继续练|开始练)「|」$/g, '');
    if (deckName.length < 2) return true;
    return !todoTitles.some((t) => t.includes(deckName));
  });
}
