/**
 * 今日学习卡的数据（2026-11-08）。
 *
 * ## 为什么要单独拆出「到期 / 薄弱」两类
 *
 * 原来首页只说「还有 N 张新卡没学过」，用户看不出**这 N 张里在考什么**。
 * StudyHub 的做法值得学（视频里首页卡片写的是「3 题待学 · 1 题到期 2 题薄弱」）：
 * 把数字拆开，用户就知道今天该对付的是「该复习的」还是「一直没掌握的」，
 * 心理预期完全不同 —— 前者是例行公事，后者是要花脑子的。
 *
 * ## 「薄弱」怎么定义（这里必须写清，否则界面上一个词会有多种理解）
 *
 * 薄弱 = **练过、但没掌握**。具体两条，满足任一即算：
 *  1. 练过至少一次，但掌握度低于「熟练」线（0.6）
 *  2. 有过错题记录（曾经答错过），且当前仍未达到「很熟」（0.85）
 *
 * 为什么第二条要单列：一道题可能历史间隔很长（分数不低），
 * 但最近答错过 —— 只看分数会漏掉这种「假熟练」。这与 masteryLabel
 * 里「很熟要求间隔 ≥21 天且连续答对 ≥2 次」是同一个考虑。
 *
 * **刻意不把「从没练过」算进薄弱**：那是「没学过」，不是「弱」。
 * 混在一起会让用户永远看到一堆「薄弱」，而其实只是还没开始。
 */

import type { ReviewRecord } from '@/v2/core/review-service.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import { isDue, mastery } from '@/v2/core/srs.ts';

/** 一张卡的分类结果 */
export type CardBucket = 'due' | 'weak' | 'fresh' | 'settled';

/** 分类的阈值，集中在这里便于以后调 */
const WEAK_MASTERY = 0.6;
const SOLID_MASTERY = 0.85;
const WEAK_MIN_REVIEWS = 1;

/**
 * 把一张卡归到哪一档。
 *
 * 优先级：到期 > 薄弱 > 没学过 > 已稳。
 * 为什么到期优先：今天有明确动作要做（复习），那就先做；
 * 同时它可能也薄弱，但对用户来说「今天该复习」是更可执行的提示。
 *
 * @param state 这张卡的复习状态；null/undefined 表示从没练过
 * @param today 本地日期 `YYYY-MM-DD`
 * @param hasWrongHistory 是否有过错题记录（由调用方从 reviewLogs 聚合）
 */
export function bucketOf(
  state: ReviewState | null | undefined,
  today: string,
  hasWrongHistory: boolean,
): CardBucket {
  if (!state || state.reviewCount === 0) return 'fresh';

  if (isDue(state, today)) return 'due';

  const m = mastery(state);
  const practiced = state.reviewCount >= WEAK_MIN_REVIEWS;

  if (practiced && m < WEAK_MASTERY) return 'weak';
  if (hasWrongHistory && m < SOLID_MASTERY) return 'weak';

  return 'settled';
}

/** 一张卡的最小输入（只需要判断分类的字段） */
export interface TodayCardInput {
  cardId: string;
  state: ReviewState | null;
  /** 这张卡是否有过错题记录 */
  hadWrong: boolean;
}

/** 今日学习卡的汇总 */
export interface TodayPlan {
  /** 到期（今天就该复习）的张数 */
  due: number;
  /** 薄弱（练过但没掌握）的张数，不含到期的 */
  weak: number;
  /** 没学过（一次都没练）的张数 */
  fresh: number;
  /** 已经稳的（练过、不薄弱、不到期） */
  settled: number;
  /** 合计 */
  total: number;
  /**
   * 今天最该做的动作。
   *
   * 与 dueCount/weak 的关系：有到期就复习，没到期但有薄弱就练薄弱，
   * 都没学过的优先（那是「开始学」而不是「复习」）。
   */
  focus: 'review' | 'drill-weak' | 'learn-new' | 'done';
}

/**
 * 汇总今日学习卡。
 *
 * 纯函数：输入卡片状态，输出计数。**不查库、不看时间** ——
 * today 由调用方传入，这样测试能固定日期，不会「半夜跑测试就红」。
 */
export function summarizeToday(cards: readonly TodayCardInput[], today: string): TodayPlan {
  let due = 0;
  let weak = 0;
  let fresh = 0;
  let settled = 0;

  for (const c of cards) {
    switch (bucketOf(c.state, today, c.hadWrong)) {
      case 'due':
        due += 1;
        break;
      case 'weak':
        weak += 1;
        break;
      case 'fresh':
        fresh += 1;
        break;
      case 'settled':
        settled += 1;
        break;
    }
  }

  /*
   * 今天该干什么。
   *
   * 顺序是有讲究的：
   *  - 有到期 → 先复习（遗忘曲线排好的，逾期越久越亏）
   *  - 没到期但有薄弱 → 练薄弱（这些是「学过但没掌握」，最值得补）
   *  - 都没学过 → 开始学新的
   *  - 什么都不剩 → 完成了
   *
   * 注意「薄弱」优先于「没学过」：先把学过的补牢，比不断开新课更划算。
   * 这也符合项目里「最该补的是…」那套既有表达。
   */
  const focus: TodayPlan['focus'] =
    due > 0 ? 'review' : weak > 0 ? 'drill-weak' : fresh > 0 ? 'learn-new' : 'done';

  return { due, weak, fresh, settled, total: due + weak + fresh + settled, focus };
}

/**
 * 从复习记录里算出「哪些卡有过错题」。
 *
 * 为什么看记录而不是只看当前状态：`reviewLogs` 里有历史评分，
 * 而 `ReviewState.lapseCount` 也可能因为记录被清理而失真。
 * 两者取并集最稳（宁可多算一个薄弱，也别漏掉一个真正没掌握的）。
 */
export function wrongCardIds(records: readonly ReviewRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.state.lapseCount > 0) out.add(r.cardId);
  }
  return out;
}

/** 从 ReviewRecord 数组建 cardId → state 索引 */
export function stateByCard(records: readonly ReviewRecord[]): Map<string, ReviewState> {
  const out = new Map<string, ReviewState>();
  for (const r of records) out.set(r.cardId, r.state);
  return out;
}
