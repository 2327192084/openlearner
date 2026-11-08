/**
 * 「为什么是 N 天？」——把间隔重复的排期讲成人话（2026-11-08）。
 *
 * ## 为什么要做这个
 *
 * 做完一道题，界面会说「下次大约 1 天后再见」。用户的第一反应是
 * 「凭什么 1 天？」—— 现在的界面答不上来。而答不上来会让人觉得
 * 这个排期是随便给的，于是不信任它，甚至手动去背。
 *
 * StudyHub 的解析页有个「为什么是 1 天？」可展开（视频里能看到），
 * 点开就是讲清楚这次的评分如何影响间隔。我们缺这一块。
 *
 * ## 讲什么、不讲什么
 *
 * 讲**可观察的三件事**：
 *  1. 这次评的什么档（again/hard/good/easy）
 *  2. 上一次的间隔是多少（节奏是从历史来的）
 *  3. 连续答对 / 累计答错对这个选择的影响
 *
 * 不讲 ease 的具体数值、不讲乘数公式 —— 那是内部参数，
 * 用户看到「ease 2.36」不会因此更懂，只会觉得这是黑箱。
 * 这与项目里「不给用户看内部参数」的一贯做法一致。
 *
 * ## 为什么纯函数
 *
 * 这段逻辑对错难验证（间隔算法本身复杂），所以把它从 UI 里拆出来，
 * 用固定输入写单测。UI 只负责显示返回的句子。
 */

import type { ReviewGrade, ReviewState } from './srs.ts';

/** 评分档的可读名 */
const GRADE_LABEL: Record<ReviewGrade, string> = {
  again: '重来（没想起来）',
  hard: '困难（想起来了但很吃力）',
  good: '良好（正常想起来）',
  easy: '简单（一眼就会）',
};

/** 一句解释 */
export interface IntervalReason {
  /** 一句话结论，直接显示 */
  headline: string;
  /** 逐条说明，按重要性排列 */
  details: string[];
}

/**
 * 生成「为什么是这个间隔」的解释。
 *
 * @param prev     评分前的状态（null 表示第一次学这张卡）
 * @param grade    这次选的评分档
 * @param days     系统算出的新间隔（天）
 */
export function explainInterval(
  prev: ReviewState | null,
  grade: ReviewGrade,
  days: number,
): IntervalReason {
  const details: string[] = [];

  const firstTime = !prev || prev.reviewCount === 0;

  if (firstTime) {
    /*
     * 第一次学：必须讲清楚「新卡按最短间隔起步」。
     * 否则用户会奇怪「为什么我第一次做对只隔 1 天，而不是 10 天」。
     */
    details.push('这是第一次学这张卡，所以从最短的间隔起步。');
    if (grade === 'again') {
      details.push('这次没想起来，明天（或今天内）会再考一次。');
    } else {
      details.push(
        '答对后间隔会逐次拉长 —— 下次 1 天，再下次通常几天，之后几周。',
      );
    }
    return {
      headline: `第 1 次学，${fmtDays(days)}后再见`,
      details,
    };
  }

  const s = prev!;

  // ---- 1. 这次评的档 ----
  details.push(`你选的是「${GRADE_LABEL[grade]}」。`);

  // ---- 2. 上次的间隔（节奏的来处）----
  if (s.intervalDays > 0) {
    details.push(`上一次的间隔是 ${fmtDays(s.intervalDays)}。`);
  } else {
    details.push('上一次还没排出正式间隔（刚学过第一次）。');
  }

  // ---- 3. 评分如何改变间隔 ----
  if (grade === 'again') {
    details.push(
      '答错会把间隔打回最短，并记录一次「答错」——' +
        '这是为了让没记牢的东西尽快重来，而不是硬拖到很久以后。',
    );
  } else if (grade === 'hard') {
    details.push('「困难」会拉长间隔，但比「良好」短，因为这次费了劲。');
  } else if (grade === 'good') {
    details.push('「良好」按正常节奏拉长间隔。');
  } else {
    details.push('「简单」拉得最长 —— 一眼就会的东西不必频繁打扰。');
  }

  // ---- 4. 连续答对 / 累计答错的影响 ----
  if (grade !== 'again') {
    const nextStreak = s.streak + 1;
    if (nextStreak >= 2) {
      details.push(`已经连续答对 ${nextStreak} 次，间隔会因此涨得更快。`);
    } else {
      details.push('这是连续答对的第 1 次，再多几次间隔会长得更快。');
    }
  }

  if (s.lapseCount > 0) {
    details.push(
      `这张卡累计答错过 ${s.lapseCount} 次 —— 错过的东西间隔会偏保守。`,
    );
  }

  return {
    headline: `${fmtDays(days)}后再见`,
    details,
  };
}

/** 天数的人话写法。与 ReviewPage 的 fmtInterval 保持一致（0 天说「今天内」） */
export function fmtDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '今天内';
  if (days === 1) return '1 天';
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return '1 年';
}
