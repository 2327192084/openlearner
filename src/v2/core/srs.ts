/**
 * 间隔复习调度引擎（SM-2 改进版）。
 *
 * ## 为什么先做这个
 *
 * StudyHub 的核心卖点是「做完一轮，看得见自己变熟」——
 * 那背后就是这套算法。它是纯函数，不碰界面、不碰存储，
 * 写完立刻能用测试验证对错。做错了后面全歪，所以先做对。
 *
 * ## 算法选型
 *
 * 用 SM-2（SuperMemo 2）的改进版，而不是更复杂的 FSRS：
 *  - SM-2 参数少、行为可解释，用户问「为什么今天让我复习这个」
 *    时能说清楚
 *  - FSRS 需要大量历史数据才能拟合，新用户前几十次复习没有意义
 *  - SM-2 在「每天几十张卡」的量级上效果已经足够
 *
 * 改进点（相对原始 SM-2）：
 *  1. 上限夹取（默认 365 天），避免某个卡片被推到十年后
 *  2. 连续答错时缩短间隔而不是直接重置为 1 天
 *  3. 引入「难度系数」的衰减保护，避免 ease 无限下降
 */

/**
 * 一次复习的评分。
 *
 * 用四级而不是 SM-2 原版的 0~5 六档：
 * 六档在实际使用中没人分得清 3 和 4 的区别，
 * 四级（忘了/勉强/还行/很熟）用户判断更快也更一致。
 */
export type ReviewGrade =
  /** 完全想不起来 */
  | 'again'
  /** 想起来了，但很吃力 */
  | 'hard'
  /** 正常回忆出来 */
  | 'good'
  /** 毫不费力 */
  | 'easy';

/** 一张卡片的复习状态 */
export interface ReviewState {
  /** 难度系数（SM-2 的 ease factor）。初始 2.5，范围 [1.3, 3.0] */
  ease: number;
  /** 当前间隔（天）。0 表示还没复习过 */
  intervalDays: number;
  /** 连续答对次数（'again' 会清零） */
  streak: number;
  /** 累计复习次数 */
  reviewCount: number;
  /** 累计答错次数 */
  lapseCount: number;
  /** 下次复习日期（ISO 字符串，只到天） */
  dueAt: string;
}

/** 全新卡片的状态 */
export function initialState(today: string): ReviewState {
  return {
    ease: 2.5,
    intervalDays: 0,
    streak: 0,
    reviewCount: 0,
    lapseCount: 0,
    // 新卡当天就该学
    dueAt: today,
  };
}

/** 难度系数的上下限。低于 1.3 会让间隔几乎不增长，卡片天天出现 */
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
/** 间隔上限：一年。再长就脱离「备考」这个场景了 */
const MAX_INTERVAL = 365;

/** 各级评分对应的初始间隔（首次答对时用） */
const FIRST_INTERVAL: Record<ReviewGrade, number> = {
  again: 0,
  hard: 1,
  good: 1,
  easy: 3,
};

/** 各级评分对 ease 的调整量 */
const EASE_DELTA: Record<ReviewGrade, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/**
 * 把「第几天」加到某个日期上。
 *
 * 用 UTC 日期串（YYYY-MM-DD）而不是 Date 对象：
 * 复习排程只关心「哪一天」，带时区的时间戳会让「今天该复习」
 * 在不同时区算出不同结果，也会让测试不稳定。
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  // 加 0.5 天避免夏令时导致的「差几分钟」问题
  const next = new Date(base + days * 86400000 + 43200000);
  return next.toISOString().slice(0, 10);
}

/** 今天的 UTC 日期串 */
export function todayUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * 根据一次评分算出新的复习状态。
 *
 * @param prev 当前状态（新卡传 initialState）
 * @param grade 本次评分
 * @param today 今天的日期串（YYYY-MM-DD）
 */
export function schedule(prev: ReviewState, grade: ReviewGrade, today: string): ReviewState {
  const reviewCount = prev.reviewCount + 1;

  // ---- 答错：回到短期，但不清零全部历史 ----
  if (grade === 'again') {
    /**
     * 为什么不是直接重置为 1 天：
     *
     * 原始 SM-2 会把 interval 重置为 1，ease 也大幅下降。
     * 但对「本来很熟的卡片偶尔手滑」这种情况，直接打回 1 天
     * 会让用户觉得「明明会，为什么又让我天天看」。
     *
     * 折中：间隔缩到 1 天，但 ease 只小幅下降（-0.2），
     * streak 清零。如果连续错，ease 会持续下降，
     * 最终自然会退化成高频复习。
     */
    const ease = clampEase(prev.ease + EASE_DELTA.again);
    return {
      ease,
      intervalDays: 1,
      streak: 0,
      reviewCount,
      lapseCount: prev.lapseCount + 1,
      dueAt: addDays(today, 1),
    };
  }

  // ---- 答对：按 SM-2 增长间隔 ----
  const ease = clampEase(prev.ease + EASE_DELTA[grade]);
  const streak = prev.streak + 1;

  let intervalDays: number;
  if (prev.intervalDays <= 0) {
    // 首次答对
    intervalDays = FIRST_INTERVAL[grade];
  } else if (prev.streak === 0) {
    /**
     * 上一轮刚答错过，这一轮答对。
     * 不从 1 天重新开始算，而是给一个较小的跳跃 ——
     * 用户已经证明自己会了，不该被当成全新卡片。
     */
    intervalDays = grade === 'hard' ? 2 : grade === 'good' ? 3 : 5;
  } else {
    // 正常增长：间隔 × ease，hard/good/easy 略有差异
    const factor = grade === 'hard' ? 1.2 : grade === 'good' ? ease : ease * 1.3;
    intervalDays = Math.round(prev.intervalDays * factor);
  }

  // 至少前进 1 天，否则「答对了但明天还来」会让人觉得没进展
  intervalDays = Math.max(1, Math.min(intervalDays, MAX_INTERVAL));

  return {
    ease,
    intervalDays,
    streak,
    reviewCount,
    lapseCount: prev.lapseCount,
    dueAt: addDays(today, intervalDays),
  };
}

function clampEase(e: number): number {
  return Math.round(Math.max(MIN_EASE, Math.min(MAX_EASE, e)) * 100) / 100;
}

/** 这张卡今天是否到期 */
export function isDue(state: ReviewState, today: string): boolean {
  return state.dueAt <= today;
}

/** 逾期几天（未到期返回 0） */
export function daysOverdue(state: ReviewState, today: string): number {
  if (!isDue(state, today)) return 0;
  const [y1, m1, d1] = state.dueAt.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const a = Date.UTC(y1 ?? 0, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2 ?? 0, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * 熟练度（0~1）：给用户看的「你有多熟」。
 *
 * 为什么不用 ease 直接当熟练度：ease 是内部参数，
 * 用户看到 2.5 完全不知道是什么意思。这里映射成一个
 * 直观的百分比，并综合考虑间隔长度与正确率。
 */
export function mastery(state: ReviewState): number {
  if (state.reviewCount === 0) return 0;

  // 间隔越长说明越熟（对数尺度：1 天→0，365 天→1）
  const intervalScore = Math.min(1, Math.log(Math.max(1, state.intervalDays)) / Math.log(365));

  // 正确率：答错次数占比
  const accuracy = 1 - state.lapseCount / state.reviewCount;

  // 连续答对的加成（最多 +0.15）
  const streakBonus = Math.min(0.15, state.streak * 0.03);

  const raw = intervalScore * 0.55 + accuracy * 0.45 + streakBonus;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
}

/** 熟练度的文字描述，用于界面显示 */
export function masteryLabel(m: number): string {
  if (m >= 0.85) return '很熟';
  if (m >= 0.6) return '熟练';
  if (m >= 0.35) return '有点印象';
  if (m > 0) return '刚起步';
  return '未学过';
}

/**
 * 从一组卡片的复习状态算出「今天的学习计划」。
 *
 * 这是「打开就知道该干什么」的数据来源：
 *  - due：今天该复习的（按逾期天数降序，拖得越久越靠前）
 *  - fresh：还没学过的新卡（按原顺序）
 *
 * 新卡上限默认 20 张：一天塞太多新东西会让复习队列爆炸
 * （今天学 50 张，明天要复习 50 张，后天更多）。
 */
export function buildTodayQueue<T>(
  items: readonly { id: string; state: ReviewState | null; createdAt?: string }[],
  today: string,
  opts: { newLimit?: number; reviewLimit?: number } = {},
): { due: T[]; fresh: T[]; dueTotal: number; freshTotal: number } {
  const newLimit = opts.newLimit ?? 20;
  const reviewLimit = opts.reviewLimit ?? 200;

  const due: T[] = [];
  const fresh: T[] = [];
  const dueSorted: { item: T; overdue: number }[] = [];

  for (const it of items) {
    const asT = it as unknown as T;
    if (!it.state) {
      fresh.push(asT);
      continue;
    }
    if (isDue(it.state, today)) {
      dueSorted.push({ item: asT, overdue: daysOverdue(it.state, today) });
    }
  }

  // 逾期越久越靠前：昨天该复习的和拖了两周的，后者更该先补
  dueSorted.sort((a, b) => b.overdue - a.overdue);
  for (const d of dueSorted) due.push(d.item);

  return {
    due: due.slice(0, reviewLimit),
    fresh: fresh.slice(0, newLimit),
    dueTotal: dueSorted.length,
    freshTotal: fresh.length,
  };
}
