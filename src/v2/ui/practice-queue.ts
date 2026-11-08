/**
 * 「开始做题」页的待做题目清单（2026-11-08）。
 *
 * ## 用户要什么
 *
 * 原话：「我希望我点击开始复习跳转后能在开始做题的界面知道待做的有哪些题，
 * 说不定有些题已经掌握了，但还是列了进去，方便进行筛选。」
 *
 * 拆成两件事：
 *  1. **看得见**：进去之前就知道这一批是哪几道题，而不是「12 道」一个数字
 *  2. **筛得掉**：已经掌握的可以剔掉，只做真正没把握的
 *
 * ## 为什么「已掌握」要能剔掉
 *
 * 到期队列是按遗忘曲线算的，但曲线不知道你今天状态如何。
 * 一道题可能上次答得很好、算法算它今天到期，而你其实刚复习过
 * 相关内容 —— 这时候硬做一遍是浪费。让用户自己决定跳过哪几道，
 * 比让算法拍板更尊重他的判断。
 *
 * ## 筛选后要如实说明
 *
 * 剔掉 N 道之后，按钮上的数字要跟着变，并且明确写出
 * 「已跳过 N 道已掌握的」。不静默改变数字 —— 用户会以为题丢了。
 */

import type { Card } from '@/v2/core/cards.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import { mastery, masteryLabel } from '@/v2/core/srs.ts';

export interface PracticeQueuePreviewProps {
  /** 这一批要做的题 */
  cards: readonly Card[];
  /** cardId → 复习状态（没有记录表示没练过） */
  states: ReadonlyMap<string, ReviewState>;
  /** 今天（用于标注到期/逾期） */
  today: string;
  /** 当前被跳过的卡片 id */
  skipped: ReadonlySet<string>;
  /** 勾选/取消勾选某道题 */
  onToggleSkip: (cardId: string) => void;
  /** 一键跳过所有「已掌握」的 */
  onSkipMastered: () => void;
  /** 恢复全部 */
  onResetSkip: () => void;
}

/** 一道题在清单里的展示信息 */
export interface QueueRow {
  card: Card;
  /** 掌握度 0~1；没练过为 0 */
  mastery: number;
  /** 档位文字（很熟/熟练/…/没学过） */
  label: string;
  /** 是否已掌握（与 srs.isMastered 的判据一致） */
  mastered: boolean;
  /** 逾期天数；未到期为 0 */
  overdueDays: number;
}

/**
 * 从卡片与状态算出清单行。
 *
 * 纯函数，单测直接喂样本 —— 这段的「已掌握」判据必须和
 * srs.ts 里的一致，否则界面上标「已掌握」但系统仍当它没掌握，
 * 用户会困惑为什么做了还说没掌握。
 */
export function buildQueueRows(
  cards: readonly Card[],
  states: ReadonlyMap<string, ReviewState>,
  today: string,
): QueueRow[] {
  return cards.map((card) => {
    const st = states.get(card.id) ?? null;
    const m = st ? mastery(st) : 0;

    return {
      card,
      mastery: m,
      label: masteryLabel(m, st ?? undefined),
      /*
       * 判据与 srs.isMastered 完全一致：
       * 间隔 >= 21 天 且 连续答对 >= 2 且 掌握度 >= 0.85。
       * 这里不直接调 isMastered 是因为它接 state 而不接 mastery，
       * 而我们已经有 m 了 —— 但条件必须逐条对上，见下面的单测。
       */
      mastered:
        st !== null &&
        st.reviewCount > 0 &&
        st.intervalDays >= 21 &&
        st.streak >= 2 &&
        m >= 0.85,
      overdueDays: st && st.dueAt < today ? daysBetween(st.dueAt, today) : 0,
    };
  });
}

/** 两个 YYYY-MM-DD 之间差几天（b 晚于 a 时为正） */
function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  if (pa.length !== 3 || pb.length !== 3) return 0;
  const ta = Date.UTC(pa[0]!, (pa[1] ?? 1) - 1, pa[2] ?? 1);
  const tb = Date.UTC(pb[0]!, (pb[1] ?? 1) - 1, pb[2] ?? 1);
  return Math.max(0, Math.round((tb - ta) / 86400000));
}

/**
 * 哪些可以被「一键跳过已掌握」。
 *
 * 只挑**已掌握**且当前没被跳过 的 —— 用户已经手动跳过的不用重复处理。
 */
export function masteredIds(rows: readonly QueueRow[], skipped: ReadonlySet<string>): string[] {
  return rows.filter((r) => r.mastered && !skipped.has(r.card.id)).map((r) => r.card.id);
}
