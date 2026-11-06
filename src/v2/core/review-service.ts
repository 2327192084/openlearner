import type { StorageAdapter } from '@/core/storage/types.ts';
import {
  addDays,
  initialState,
  schedule,
  todayUtc,
  buildTodayQueue,
  isDue,
  mastery,
  type ReviewGrade,
  type ReviewState,
} from './srs.ts';

/**
 * 复习进度的持久化与查询。
 *
 * ## 设计决定
 *
 * 一张卡 = 一条 ReviewRecord，主键用 `cardId`。
 * 为什么不用复合主键（cardId + 用户）：
 * 这是单机应用，没有多用户概念。加用户维度只会让所有查询多传一个参数。
 *
 * 为什么复习历史单独存一份（ReviewLog）：
 * 「今天复习了多少张」这类统计不该靠遍历所有 record 猜测 ——
 * 有些卡今天复习了又答错，record 里只留最终状态，
 * 算不出「今天实际刷了几张」。
 */

/** 一张卡的复习进度 */
export interface ReviewRecord {
  id: string;
  /** 卡片 id（题目 id / 知识点 id） */
  cardId: string;
  /** 卡片类型：题目还是知识点 */
  kind: 'question' | 'point';
  state: ReviewState;
  /** 首次学习日期 */
  firstSeenAt: string;
  updatedAt: string;
}

/** 一次复习的记录（用于统计） */
export interface ReviewLog {
  id: string;
  cardId: string;
  kind: 'question' | 'point';
  grade: ReviewGrade;
  /** 复习时的日期串 */
  day: string;
  /** 复习前的间隔，用于统计「这次复习把间隔推进了多少」 */
  prevIntervalDays: number;
  newIntervalDays: number;
  at: string;
}

/** 今日概览：面板直接渲染这个 */
export interface TodayOverview {
  /** 今天到期的复习数量 */
  dueCount: number;
  /** 可学的新卡数量 */
  freshCount: number;
  /** 今天已经复习过几张 */
  doneToday: number;
  /** 今天的正确率（0~1，无记录时为 null） */
  accuracyToday: number | null;
  /** 全部卡片的平均熟练度 */
  avgMastery: number;
  /** 总卡片数 */
  totalCards: number;
  /** 已学过（复习过至少一次）的卡片数 */
  learnedCards: number;
}

export class ReviewService {
  constructor(private readonly storage: StorageAdapter) {}

  /** 读取一张卡的进度 */
  async getRecord(cardId: string): Promise<ReviewRecord | null> {
    return this.storage.get('reviewRecords', `rv:${cardId}`);
  }

  /** 读取一批卡的进度（一次查询，避免 N 次 IO） */
  async getRecords(cardIds: readonly string[]): Promise<Map<string, ReviewRecord>> {
    const all = await this.storage.getAll('reviewRecords');
    const wanted = new Set(cardIds);
    const map = new Map<string, ReviewRecord>();
    for (const r of all) {
      if (wanted.has(r.cardId)) map.set(r.cardId, r);
    }
    return map;
  }

  /** 全部进度 */
  async listRecords(): Promise<ReviewRecord[]> {
    return this.storage.getAll('reviewRecords');
  }

  /**
   * 提交一次复习评分。
   *
   * @returns 更新后的进度；若卡片不存在则新建
   */
  async review(
    cardId: string,
    kind: 'question' | 'point',
    grade: ReviewGrade,
    now: Date = new Date(),
  ): Promise<ReviewRecord> {
    const today = todayUtc(now);
    const existing = await this.getRecord(cardId);
    const prev = existing?.state ?? initialState(today);
    const next = schedule(prev, grade, today);

    const record: ReviewRecord = {
      id: `rv:${cardId}`,
      cardId,
      kind,
      state: next,
      firstSeenAt: existing?.firstSeenAt ?? today,
      updatedAt: now.toISOString(),
    };
    await this.storage.put('reviewRecords', record);

    /**
     * 历史记录 id 必须唯一。
     *
     * ⚠️ 早先用 `rl:${cardId}:${now.getTime()}`，同一毫秒内
     * 对同一张卡复习两次（程序化批量复习、或用户快速连点）
     * 会产生相同 id，后者覆盖前者 —— 表现为「今天明明刷了 10 张，
     * 统计里只有 9 张」。
     *
     * 加一个随机后缀，代价可忽略，但保证不丢历史。
     */
    const log: ReviewLog = {
      id: `rl:${cardId}:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
      cardId,
      kind,
      grade,
      day: today,
      prevIntervalDays: prev.intervalDays,
      newIntervalDays: next.intervalDays,
      at: now.toISOString(),
    };
    await this.storage.put('reviewLogs', log);

    return record;
  }

  /**
   * 今日概览。
   *
   * 一次性把面板需要的所有数字算好，避免界面里散落多个查询 ——
   * 那几个数字必须来自同一时刻的快照，否则会互相矛盾
   * （比如显示「到期 5 张」但列表只有 3 张）。
   */
  async todayOverview(cardPool: readonly string[], now: Date = new Date()): Promise<TodayOverview> {
    const today = todayUtc(now);
    const records = await this.listRecords();
    const logs = await this.storage.getAll('reviewLogs');

    const byCard = new Map(records.map((r) => [r.cardId, r]));
    const pool = new Set(cardPool);

    let dueCount = 0;
    let learnedCards = 0;
    let masterySum = 0;
    for (const r of records) {
      /**
       * 只统计池子里的卡。
       *
       * ⚠️ 这一步曾经漏过：`learnedCards` 与 `avgMastery` 直接遍历了
       * 全部记录，把「已删除资料的卡」也算进来 ——
       * 表现是概览说「已学 10 张」但列表里只有 3 张，用户会觉得数字在瞎报。
       *
       * 概览上的每个数字都必须限定在同一个范围内，否则互相矛盾。
       */
      if (!pool.has(r.cardId)) continue;

      if (r.state.reviewCount > 0) {
        learnedCards += 1;
        masterySum += mastery(r.state);
      }
      if (isDue(r.state, today)) dueCount += 1;
    }

    // 池子里还没进度的都算新卡
    const freshCount = [...pool].filter((id) => !byCard.has(id)).length;

    const todayLogs = logs.filter((l) => l.day === today);
    const doneToday = todayLogs.length;
    const correctToday = todayLogs.filter((l) => l.grade !== 'again').length;

    return {
      dueCount,
      freshCount,
      doneToday,
      accuracyToday: doneToday > 0 ? Math.round((correctToday / doneToday) * 100) / 100 : null,
      avgMastery: learnedCards > 0 ? Math.round((masterySum / learnedCards) * 100) / 100 : 0,
      totalCards: pool.size,
      learnedCards,
    };
  }

  /** 今天该复习的卡片 id（逾期优先） */
  async dueCards(cardPool: readonly string[], now: Date = new Date()): Promise<string[]> {
    const today = todayUtc(now);
    const records = await this.listRecords();
    const pool = new Set(cardPool);

    const due = records
      .filter((r) => pool.has(r.cardId) && isDue(r.state, today))
      .map((r) => r.cardId);

    return buildTodayQueue(
      due.map((id) => ({ id, state: records.find((r) => r.cardId === id)?.state ?? null })),
      today,
    ).due.map((x) => (x as { id: string }).id);
  }

  /**
   * 连续学习天数。
   *
   * ## 为什么「今天没学」不等于「断了」
   *
   * 如果今天还没开始学，连续天数应该显示**昨天为止的**连续天数，
   * 而不是归零。否则用户早上打开软件看到「0 天」，会觉得自己
   * 前功尽弃 —— 那是最打击人的一种显示。
   *
   * 所以判定：今天有记录就从今天往前数；今天没有就从昨天往前数。
   */
  async streakDays(now: Date = new Date()): Promise<number> {
    const logs = await this.storage.getAll('reviewLogs');
    if (logs.length === 0) return 0;

    const days = new Set(logs.map((l) => l.day));
    const today = todayUtc(now);

    // 从今天或昨天起算
    let cursor = days.has(today) ? today : addDays(today, -1);
    if (!days.has(cursor)) return 0;

    let streak = 0;
    while (days.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
      // 防御：库里若有异常久远的数据，最多数 5 年
      if (streak > 1825) break;
    }
    return streak;
  }

  /**
   * 12 周热力图数据（每周 7 天，按周对齐）。
   *
   * 对齐到「周一」而不是「14 天前」：热力图按周排，
   * 不按周对齐的话每一列会错位，看起来像随机的方格。
   */
  async heatmap(weeks = 12, now: Date = new Date()): Promise<{ day: string; count: number }[]> {
    const logs = await this.storage.getAll('reviewLogs');
    const byDay = new Map<string, number>();
    for (const l of logs) byDay.set(l.day, (byDay.get(l.day) ?? 0) + 1);

    const today = todayUtc(now);
    // 找本周一
    const [y, m, d] = today.split('-').map(Number);
    const todayMs = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
    const dow = new Date(todayMs).getUTCDay(); // 0=周日
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const thisMonday = todayMs + mondayOffset * 86400000;
    const startMs = thisMonday - (weeks - 1) * 7 * 86400000;

    const out: { day: string; count: number }[] = [];
    for (let i = 0; i < weeks * 7; i++) {
      const t = new Date(startMs + i * 86400000);
      const day = t.toISOString().slice(0, 10);
      out.push({ day, count: byDay.get(day) ?? 0 });
    }
    return out;
  }

  /**
   * 掌握度分布（五档各有多少张）。
   *
   * 分档用与显示一致的固定阈值：
   * 未学 0 / 薄弱 <0.3 / 学习中 <0.55 / 熟悉 <0.8 / 已掌握 ≥0.8
   */
  async masteryDistribution(): Promise<{
    unlearned: number;
    weak: number;
    learning: number;
    familiar: number;
    mastered: number;
  }> {
    const records = await this.listRecords();
    const out = { unlearned: 0, weak: 0, learning: 0, familiar: 0, mastered: 0 };
    for (const r of records) {
      if (r.state.reviewCount === 0) {
        out.unlearned += 1;
        continue;
      }
      const m = mastery(r.state);
      if (m < 0.3) out.weak += 1;
      else if (m < 0.55) out.learning += 1;
      else if (m < 0.8) out.familiar += 1;
      else out.mastered += 1;
    }
    return out;
  }

  /** 最近 N 天的复习量（用于画趋势） */
  async recentActivity(days = 7, now: Date = new Date()): Promise<{ day: string; count: number }[]> {
    const logs = await this.storage.getAll('reviewLogs');
    const today = todayUtc(now);
    const out: { day: string; count: number }[] = [];

    // 从今天往前数 N 天（含今天）
    const [y, m, d] = today.split('-').map(Number);
    for (let i = days - 1; i >= 0; i--) {
      const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - i));
      const day = t.toISOString().slice(0, 10);
      out.push({ day, count: logs.filter((l) => l.day === day).length });
    }
    return out;
  }
}
