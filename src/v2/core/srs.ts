/**
 * 间隔复习调度引擎。
 *
 * ## 算法演进（重要）
 *
 * 最初是纯 SM-2 改进版。用户实测后反馈：**只有 5 分和别的档位拉开了差距**。
 * 查证属实 —— 首次复习 3 分与 4 分都给 1 天，之后又乘同一个 ease，
 * 差距永远拉不开，评分形同虚设。
 *
 * 现在改为**艾宾浩斯阶梯表 + 表现调节**，实现在 `ebbinghaus.ts`：
 * 预设一串间隔台阶（1/2/4/7/15/30/60/120/180/365 天），
 * 每个评分档对应不同的前进级数，所以五档给出的天数**各不相同**。
 *
 * 本文件保留：
 *  - 评分类型 `ReviewGrade`、状态 `ReviewState`（存储结构不变 ⇒ 老数据无需迁移）
 *  - 日期工具（addDays / todayUtc / isDue / daysOverdue）
 *  - 熟练度展示（mastery / masteryLabel）
 *  - 今日队列构造（buildTodayQueue）
 *  - `schedule()` 作为转发层指向新算法
 */

/**
 * 一次复习的评分。
 *
 * 用四级而不是 SM-2 原版的 0~5 六档：
 * 六档在实际使用中没人分得清 3 和 4 的区别，
 * 四级（忘了/勉强/还行/很熟）用户判断更快也更一致。
 */
import { scheduleEbbinghaus } from './ebbinghaus.ts';

export type ReviewGrade =
  /** 完全想不起来 */
  | 'again'  /** 想起来了，但很吃力 */
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

/**
 * 调度相关的常量都搬到 `ebbinghaus.ts` 了（台阶表、ease 上下限、各档调整量）。
 *
 * 这里刻意不保留副本：原来 FIRST_INTERVAL / EASE_DELTA 就是在这份文件里，
 * 而「3 分和 4 分给同一个 1 天」的 bug 也在这里。
 * 留一份看起来能用、实际不再被调用的旧表，后来的人很容易改错地方。
 */

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

/**
 * 今天的**本地日历**日期串（YYYY-MM-DD）。
 *
 * ## 为什么不是 UTC（2026-11-08 修，对应交接文档已知问题 3）
 *
 * 原来是 `todayUtc()`：取 UTC 日期。在东八区，UTC 比本地早 8 小时，
 * 于是**本地 00:00–08:00 这段时间算「昨天」**。后果：
 *  - 早上 7:50 和 8:10 打开软件，「今天」是两个不同的日子
 *  - 凌晨做的那几张卡，到期日按「昨天」往后推，比预期早一天回来
 *
 * ## 连字符串的语义没变
 *
 * `dueAt` 仍然是 `YYYY-MM-DD`。只是「今天」按本地日历算 ——
 * 所以**已存储的复习记录不需要迁移**：日期串含义不变，
 * 变的只是「拿哪个串去比较」。
 *
 * ## 为什么不能用 toISOString()
 *
 * `new Date().toISOString().slice(0,10)` 会把本地时间转成 UTC 再取日期，
 * 正是要修的那个 bug。必须用 getFullYear/getMonth/getDate（本地字段）。
 *
 * ## 参考
 *
 * StudyHub `lib/sm2.js` 为同一问题特意偏离了 ts-fsrs 的 UTC 计数，
 * 注释原话：「ts-fsrs counts UTC days, so in Beijing 07:50 and 08:10
 * would be two days」。Anki 的同类修复也是把 `today` 换成
 * `local_time_date()`。
 */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 旧的 UTC 版，**保留但不再用于「今天」**。
 *
 * 还有一处调用：`ReviewPage` 算「各评分档的预期间隔」时用它当基准日 ——
 * 那里改用 todayLocal 更正确，但为保持改动可控，先保留这个导出，
 * 让所有「今天」的判定统一切到 todayLocal。
 *
 * @deprecated 用 `todayLocal()`。留着只为兼容尚未迁移的调用点。
 */
export function todayUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * 根据一次评分算出新的复习状态。
 *
 * ## 这个函数现在是一个「转发层」
 *
 * 原来的实现是纯 SM-2（间隔 × ease 连乘）。用户实测反馈：
 * **只有 5 分和别的档位拉开了差距**，3 分和 4 分给的间隔完全一样。
 * 根因是 `FIRST_INTERVAL = { hard: 1, good: 1, easy: 3 }` 加上连乘增长 ——
 * 首次 3 分和 4 分都是 1 天，之后又乘同一个 ease，差距永远拉不开。
 *
 * 现在真正的算法在 `ebbinghaus.ts`（阶梯表 + 表现调节），
 * 这里只做转发。保留这个函数是为了：
 *  1. 现有 11 处调用与测试不用改；
 *  2. 状态结构不变（ease / intervalDays / streak / reviewCount / lapseCount / dueAt），
 *     所以**已有用户的复习记录不需要迁移**；
 *  3. 将来如果想再换算法，只改这一个转发点。
 *
 * @param prev 当前状态（新卡传 initialState）
 * @param grade 本次评分
 * @param today 今天的日期串（YYYY-MM-DD）
 */
export function schedule(prev: ReviewState, grade: ReviewGrade, today: string): ReviewState {
  return scheduleEbbinghaus(prev, grade, today);
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

/**
 * 熟练度的文字描述，用于界面显示。
 *
 * ## 为什么「很熟」需要连续答对，而不只看分数（2026-11-08）
 *
 * 纯按数值分档会出现「蒙对一次就显示很熟」：一道题如果当前间隔很长
 * （说明历史不错）但最近刚答错一次、连续答对为 0，分数仍可能很高。
 * 用户看到「很熟」会以为不用再看了，实际下次大概率又想不起来。
 *
 * 所以「很熟」加了两条门槛（参考 StudyHub `lib/mastery.js` 的 cardLevel）：
 *   - 当前间隔 >= 21 天
 *   - 连续答对 >= 2 次
 *
 * 为什么是 21 天 / 2 次：
 *  - 21 天：超过三周还记得，说明进了长期记忆；本项目间隔上限 365 天，
 *    21 天在这个尺度上属于前段（约 1/17）
 *  - 2 次：StudyHub 的注释写得很清楚 ——「没有任何调度器设置能靠一次作答
 *    就让人『已掌握』」。一次答对可能是刚看过、可能是蒙的
 *
 * 这两条只影响**显示档位**，不改调度（intervals 仍由 ebbinghaus 决定）。
 * 界面上说「很熟」是给用户的判断，不该反过来影响算法。
 *
 * @param m      mastery() 的分值
 * @param state  可选。不传时退回纯数值分档（旧行为），
 *               因为有些调用点只拿到分数（如聚合后的平均值）
 */
export function masteryLabel(m: number, state?: ReviewState): string {
  if (m >= 0.85) {
    if (!state) return '很熟';
    const longEnough = state.intervalDays >= 21;
    const steady = state.streak >= 2;
    // 两条都满足才算很熟；只满足一条算「熟练」——差一口气，不是差一半
    if (longEnough && steady) return '很熟';
    return '熟练';
  }
  if (m >= 0.6) return '熟练';
  if (m >= 0.35) return '有点印象';
  if (m > 0) return '刚起步';
  return '未学过';
}

/**
 * 「已掌握」的判定（供统计与筛选用）。
 *
 * 与 `masteryLabel` 返回「很熟」的条件一致 —— 两处必须同一个口径，
 * 否则会出现「标签说很熟，筛『已掌握』却筛不出来」。
 */
export function isMastered(state: ReviewState | null | undefined): boolean {
  if (!state) return false;
  if (state.reviewCount === 0) return false;
  return state.intervalDays >= 21 && state.streak >= 2 && mastery(state) >= 0.85;
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
