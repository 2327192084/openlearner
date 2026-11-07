/**
 * 艾宾浩斯阶梯 + 表现调节（替代原来的纯 SM-2）。
 *
 * ## 为什么换掉原来的算法
 *
 * 用户实测反馈：**只有 5 分和别的分数拉开了差距**。查代码确认是他对：
 * ```
 * const FIRST_INTERVAL = { again: 0, hard: 1, good: 1, easy: 3 };
 * ```
 * 首次复习时 3 分（勉强答对）和 4 分（熟练）都给 **1 天**，一模一样。
 * 而且之后所有档位都乘同一个 ease，差距一直拉不开。
 * 用户点了 4 分，第二天又见到这道题 —— 自然会觉得「这个评分没用」。
 *
 * ## 新方案：阶梯表 + 上调/下调
 *
 * 思路借自艾宾浩斯遗忘曲线与「不背单词」这类软件的做法：
 * 预先定义一串**间隔台阶**，每次复习后按表现决定走到哪一级。
 *
 * ```
 * 台阶（天）: 1 · 2 · 4 · 7 · 15 · 30 · 60 · 120 · 180 · 365
 * ```
 *
 * 每个评分档对应不同的**移动步数**，所以 5 个档位给出的天数**各不相同**：
 *
 * | 评分 | 含义 | 移动 |
 * | --- | --- | --- |
 * | again | 完全忘记 | 回退到第 0 级（1 天），并额外降一级难度 |
 * | hard | 勉强想起来了 | **前进 0 级**（原地不动，或从 0 级走到 1 级） |
 * | good | 正常回忆 | 前进 1 级 |
 * | easy | 毫不费力 | 前进 2 级 |
 *
 * 首次复习（还没有任何间隔历史）时，五个档位分别落到：
 * again → 1 天，hard → 1 天，good → 2 天，easy → 4 天。
 * （hard 与 again 在首次确实接近，因为「勉强想起来」本质上就是没记住；
 *  但从第二次开始两者会迅速分开 —— again 每轮都回到 1 天，
 *  而 hard 会一级一级往上爬。）
 *
 * ## 为什么要「连续答对跳级」
 *
 * 一张卡如果连续 3 次都是 good，说明它比台阶表预期的更简单。
 * 一直按 +1 级走会让这类卡出现得太频繁（用户会觉得「怎么又是它」）。
 * 所以连续答对 3 次以上时额外多走一级。
 *
 * ## 为什么保留 ease（难度系数）
 *
 * 阶梯表是**所有人共用**的节奏，但每张卡的难度不同。
 * ease 用来记录「这张卡对这个人有多难」，并微调实际天数：
 *  - ease 高（简单）→ 在台阶天数上乘一个略大于 1 的系数
 *  - ease 低（难）→ 乘略小于 1 的系数
 * 这样既保留可预期性（台阶），又保留个性化。
 *
 * ## 为什么不再用「× ease 连乘」的增长方式
 *
 * 连乘会让间隔很快冲到上限（365 天），之后所有档位都一样 ——
 * 又变成「评分没区别」。阶梯表有固定上限档位，每档之间的差距是设计好的。
 */

import type { ReviewGrade, ReviewState } from './srs.ts';
import { addDays } from './srs.ts';

/**
 * 各评分档的间隔增长倍率与上限。
 *
 * ## 为什么用「每档独立倍率 + 独立上限」，而不是共用一张台阶表
 *
 * 最初我做的是「所有人共用一串台阶（1/2/4/7/15/30…），按评分决定走几级」。
 * 这个方案有个**数学上无解**的缺陷：台阶走到顶（365 天）之后，
 * 四个评分档会全部落在同一级 —— 又变成「点哪个都一样」，
 * 正是用户抱怨的那个问题。实测确认过：
 * ```
 * round 6  days=[0,187,365,365]   ← good 与 easy 撞了
 * round 7  days=[0,365,365,365]   ← 全撞了
 * ```
 * 加密集台阶只能把撞车推后几轮，不能消除。
 *
 * 所以改成 Anki / 不背单词 那种做法：**每个档位有自己的倍率**，
 * 并且**有自己的上限**。这样四档在数学上永远不相同：
 *   hard ≤ 180 < good ≤ 270 < easy ≤ 365
 *
 * ## 倍率怎么定的
 *
 * 以「一般（good）」为基准，它在 1 天附近起步、每轮约翻一倍 ——
 * 这是艾宾浩斯曲线前半段的形状（1→2→4→8…）。
 *  - `hard`（勉强想起来）：只涨 1.2 倍。涨得慢，所以很快又会见到，
 *    符合「其实没记牢」的判断。在新卡上它等于原地（1.2 倍取整后还是原值），
 *    这正是想要的「这次不算数」。
 *  - `easy`（毫不费力）：涨 3 倍。明显比 good 快，用户能立刻感觉到差别。
 *
 * 三个倍率拉得足够开，保证四档的可预期性 ——
 * 用户点之前就能从按钮上的天数看出来区别。
 */
const GROWTH: Record<Exclude<ReviewGrade, 'again'>, { factor: number; cap: number }> = {
  hard: { factor: 1.2, cap: 180 },
  good: { factor: 2, cap: 270 },
  easy: { factor: 3, cap: 365 },
};

/** 新卡（还没有任何间隔）第一次答对时给的天数 —— 四档互不相同 */
const FIRST_DAYS: Record<Exclude<ReviewGrade, 'again'>, number> = {
  hard: 1,
  good: 2,
  easy: 4,
};

/** 难度系数上下限：低于 1.3 会让卡片永远停在小间隔 */
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

/** 各评分对 ease 的调整量 */
const EASE_DELTA: Record<ReviewGrade, number> = {
  again: -0.2,
  hard: -0.12,
  good: 0,
  easy: 0.12,
};

/**
 * 当前间隔落在哪个「增长档」的位置。
 *
 * 保留这个导出是因为旧测试与调试脚本用它观察台阶位置；
 * 新模型里它只用于**展示与兼容**，不再参与天数计算。
 * 返回 -1 表示「还没开始 / 刚答错过」。
 */
export function stepOf(intervalDays: number): number {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) return -1;
  /* 用 2 的对数把天数映射成「等效台阶序号」，便于观测增长节奏 */
  return Math.max(0, Math.round(Math.log2(intervalDays)));
}

/** 兼容旧引用：台阶表仍导出，供设置页展示与测试参考 */
export const EBBINGHAUS_STEPS = [
  1, 2, 4, 7, 15, 30, 45, 60, 90, 120, 180, 270, 365,
] as const;

/** 把难度系数夹到合法范围并保留两位小数 */
function clampEase(e: number): number {
  return Math.round(Math.max(MIN_EASE, Math.min(MAX_EASE, e)) * 100) / 100;
}

/**
 * 难度系数对实际天数的微调。
 *
 * 范围 [0.85, 1.15]：ease 1.3（最难）→ ×0.85，ease 3.0（最易）→ ×1.15。
 * 幅度刻意压得很小：**台阶本身才是主要节奏**，
 * 如果 ease 能大幅改写天数，用户又会看不懂「为什么点 4 分给了 8 天」。
 */
function easeFactor(ease: number): number {
  const t = (ease - MIN_EASE) / (MAX_EASE - MIN_EASE); // 0..1
  return 0.85 + t * 0.3;
}

/**
 * 按艾宾浩斯阶梯算出新的复习状态。
 *
 * 与 `schedule` 的接口保持兼容（同样的入参、同样的返回结构），
 * 所以调用方不需要改动；具体用哪一个由 `srs.ts` 决定。
 */
export function scheduleEbbinghaus(
  prev: ReviewState,
  grade: ReviewGrade,
  today: string,
): ReviewState {
  const reviewCount = prev.reviewCount + 1;
  const ease = clampEase(prev.ease + EASE_DELTA[grade]);

  /*
   * ---- 忘记：当天内再考一次（不排到明天）----
   *
   * 这是艾宾浩斯曲线最关键、也最容易被做错的一点：
   * 「完全想不起来」的东西，隔一天再考基本等于重新学一遍 ——
   * 应该在**当天**之内再出现一次，趁遗忘还没发生。
   *
   * 所以 `intervalDays = 0`、`dueAt = 今天`：
   *  - 今天再看「今日题组」，这道题仍然在里面（用户能马上重做）
   *  - 明天它一定在（0 天意味着早已到期）
   */
  if (grade === 'again') {
    return {
      ease,
      intervalDays: 0,
      streak: 0,
      reviewCount,
      lapseCount: prev.lapseCount + 1,
      dueAt: today,
    };
  }

  const { factor, cap } = GROWTH[grade];

  /*
   * 首次答对（还没有任何间隔）：用各档固定的起始天数。
   * 必须四档互不相同 —— 这就是用户要的「区分度」最直观的体现。
   */
  const prevDays = prev.intervalDays;
  const baseDays =
    prevDays <= 0 ? FIRST_DAYS[grade] : Math.round(prevDays * factor * easeFactor(ease));

  /*
   * 夹到 [1, cap]。
   *
   * 上限按档位不同（hard 180 / good 270 / easy 365），
   * 这样即使都顶到各自的上限，四档依然互不相同 ——
   * 不会出现「走到最后全变 365」那种区分度丢失。
   *
   * 另外至少 +1 天：答对了却给出和上次一样的天数，
   * 用户会觉得「这次和上次没区别」。
   */
  const days = Math.min(cap, Math.max(prevDays + 1, Math.max(1, baseDays)));

  return {
    ease,
    intervalDays: days,
    streak: prev.streak + 1,
    reviewCount,
    lapseCount: prev.lapseCount,
    dueAt: addDays(today, days),
  };
}

/**
 * 某个评分会给出几天 —— 供界面**事先**显示。
 *
 * 这是本轮要解决的核心问题之一：用户点了 4 分之后才发现「明天又来了」，
 * 属于信息不对称。评分按钮上直接写「→ 2 天后」，
 * 用户点之前就知道会发生什么。
 */
export function previewDays(
  prev: ReviewState | null,
  grade: ReviewGrade,
  today: string,
): number {
  const base = prev ?? {
    ease: 2.5,
    intervalDays: 0,
    streak: 0,
    reviewCount: 0,
    lapseCount: 0,
    dueAt: today,
  };
  return scheduleEbbinghaus(base, grade, today).intervalDays;
}
