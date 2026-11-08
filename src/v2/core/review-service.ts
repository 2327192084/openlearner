import type { StorageAdapter } from '@/core/storage/types.ts';
import {
  addDays,
  initialState,
  schedule,
  todayLocal,
  buildTodayQueue,
  isDue,
  isMastered,
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
   * 全部复习日志（按写入顺序，最旧在前）。
   *
   * 为什么要暴露这一层：首页要显示「最近在练的题」，
   * 而 `reviewRecords` 只有最终状态、没有时间先后。
   * 让页面自己去 `storage.getAll('reviewLogs')` 也能做，但那样
   * 「日志长什么样」就泄漏到了界面层 —— 以后改日志结构要同时改几个页面。
   * 统一从这里出。
   */
  async listLogs(): Promise<ReviewLog[]> {
    return this.storage.getAll('reviewLogs');
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
    const today = todayLocal(now);
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
    const today = todayLocal(now);
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
    const today = todayLocal(now);
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
    const today = todayLocal(now);

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

    const today = todayLocal(now);
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
  /**
   * 掌握度分布。
   *
   * @param cardPool 当前题库里的卡片 id。**必须传**（2026-11-08 修）。
   *
   * ## 为什么必须按池子过滤
   *
   * 原来这个方法遍历**全部** reviewRecords —— 包括「题已被删掉」的孤儿记录。
   * 统计页上于是出现两个对不上的数字：
   *   顶部「总卡片 16 张」（来自 cardPool，只含已发布题组的题）
   *   分布「0+9+0+1+0 = 10 张」（来自全部记录，含已删除的 6 条）
   * 用户看到两者差 6 张，会以为统计坏了。
   *
   * 这正是项目反复踩的坑：「同一屏的数字必须来自同一个池子」。
   *
   * @param cardPool 省略时退回旧行为（数全部记录）。
   *   保留这个默认只为兼容尚未迁移的调用点 —— **新代码一律传**。
   */
  async masteryDistribution(cardPool?: readonly string[]): Promise<{
    unlearned: number;
    weak: number;
    learning: number;
    familiar: number;
    mastered: number;
  }> {
    const records = await this.listRecords();
    /*
     * 只统计池子里的卡。
     * 不传 cardPool 时不加这个限制（旧行为）；
     * 传了就严格限定 —— 与 `todayOverview` 同一个口径。
     */
    const pool = cardPool ? new Set(cardPool) : null;
    const out = { unlearned: 0, weak: 0, learning: 0, familiar: 0, mastered: 0 };

    /*
     * ⚠️ 「从没练过」的卡不在 reviewRecords 里。
     *
     * 2026-11-08 查出的第二个问题：题库池 16 道、记录只有 10 条，
     * 于是分布加起来是 10，而顶部写「总卡片 16 张」—— 差 6 张。
     *
     * 原因是 reviewRecords 只在**第一次复习时**才创建。
     * 从没点过的题在里面根本没有条目，所以光遍历记录永远数不到它们。
     *
     * 修法：先按池子把「有记录的」分类，再把池子里没记录的补进 unlearned。
     * 这样五档之和 == 池子大小，与顶部的「总卡片」永远一致。
     */
    const seen = new Set<string>();
    for (const r of records) {
      if (pool && !pool.has(r.cardId)) continue;
      seen.add(r.cardId);
      if (r.state.reviewCount === 0) {
        out.unlearned += 1;
        continue;
      }
      /*
       * 「已掌握」用 `isMastered()` 判定，不再只看数值（2026-11-08）。
       *
       * 原来这里是 `m >= 0.8` 就算 mastered，而 `masteryLabel` 另有分档 ——
       * 两处口径不同，会出现「标签显示很熟，但统计里不算已掌握」的矛盾。
       *
       * 现在统一到 `isMastered()`（间隔 >= 21 天 且 连续答对 >= 2 且 分值 >= 0.85），
       * 与界面上的「很熟」是同一个条件。统计数字和标签必须来自同一套判断。
       */
      if (isMastered(r.state)) {
        out.mastered += 1;
        continue;
      }
      const m = mastery(r.state);
      if (m < 0.3) out.weak += 1;
      else if (m < 0.55) out.learning += 1;
      else out.familiar += 1;
    }

    /*
     * 池子里还没有任何复习记录的卡 → 一律算「未学」。
     *
     * 这一步是让「五档之和 == 池子大小」成立的关键。
     * 少了它，从没练过的题在分布里凭空消失，
     * 用户看到「总卡片 16 张」而五档加起来 10 张，会以为统计坏了。
     */
    if (pool) {
      for (const cardId of pool) {
        if (!seen.has(cardId)) out.unlearned += 1;
      }
    }

    return out;
  }

  /**
   * 错题集：**最近一次评审判为「忘记」的题卡**。
   *
   * ## 为什么从 reviewLogs 推导，而不是读 answerRecords
   *
   * `answerRecords` 是 v1 留下的作答表，v2 的做题流程**从不写它** ——
   * 实测真实库里该表 0 条记录。而 `DeckService.getWrongQuestions()` 只读那张表，
   * 所以「错题巩固」一度是个永远为空的功能：用户答错了，错题集不记录。
   *
   * 现在改为从 `reviewLogs` 推导：做题时本来就每评一次写一条日志，
   * `grade === 'again'` 就是「答错了」。不新增数据表、不双写、不会出现
   * 「两套进度不一致」这种老问题。
   *
   * ## 「错题」的定义
   *
   * **最近一次评级是 again。** 不是「曾经错过」——
   * 改对了之后就该从错题集消失，否则它会越攒越长、最后没人看。
   *
   * ## 为什么按日志数组顺序判断「最近一次」
   *
   * reviewLogs 的 id 带随机后缀，无法按 id 排序；`at` 是 ISO 字符串，
   * 但同一毫秒内的两次提交会相同。这里用**数组顺序**：
   * getAll 返回的是插入顺序（IndexedDB 主键游标顺序对同一 store 是稳定的），
   * 而复习是顺序发生的，所以后出现的即更近的一次。
   * 这个假设已在 `wrongCardsAfterReview()` 的单测里覆盖。
   */
  async wrongCards(): Promise<string[]> {
    const logs = await this.storage.getAll('reviewLogs');
    /** cardId → 最近一次的 grade */
    const last = new Map<string, ReviewLog>();
    for (const l of logs) {
      last.set(l.cardId, l);
    }
    const out: string[] = [];
    for (const [cardId, log] of last) {
      if (log.grade === 'again') out.push(cardId);
    }
    return out;
  }

  /**
   * 错题集的详细视图。
   *
   * 只统计 `kind === 'question'` 的卡片 —— 知识点没有「答错」这回事
   * （它只有阅读时长对应的评级），混进来会让错题集莫名其妙变长。
   *
   * 返回的信息是「错题与待巩固」页要展示的全部：
   *  - `wrongCount`：累计错了几次（不是连续错）
   *  - `reviewCount`：一共做过几次（用来算「错的比例」）
   *  - `lastWrongDay`：最近一次答错是哪天（可按「多久没碰」排序）
   *  - `lastGrade`：最近一次评级（必然 again，保留字段便于将来扩展）
   */
  async wrongCardsDetailed(): Promise<
    {
      cardId: string;
      wrongCount: number;
      reviewCount: number;
      lastWrongDay: string;
    }[]
  > {
    const logs = await this.storage.getAll('reviewLogs');
    const last = new Map<string, ReviewLog>();
    const wrongCount = new Map<string, number>();
    const reviewCount = new Map<string, number>();
    const lastWrongDay = new Map<string, string>();

    for (const l of logs) {
      last.set(l.cardId, l);
      reviewCount.set(l.cardId, (reviewCount.get(l.cardId) ?? 0) + 1);
      if (l.grade === 'again') {
        wrongCount.set(l.cardId, (wrongCount.get(l.cardId) ?? 0) + 1);
        lastWrongDay.set(l.cardId, l.day);
      }
    }

    const out: {
      cardId: string;
      wrongCount: number;
      reviewCount: number;
      lastWrongDay: string;
    }[] = [];
    for (const [cardId, log] of last) {
      if (log.grade !== 'again') continue;
      if (log.kind !== 'question') continue;
      out.push({
        cardId,
        wrongCount: wrongCount.get(cardId) ?? 1,
        reviewCount: reviewCount.get(cardId) ?? 1,
        lastWrongDay: lastWrongDay.get(cardId) ?? log.day,
      });
    }
    // 错得最多的排前面
    return out.sort((a, b) => b.wrongCount - a.wrongCount);
  }

  /** 最近 N 天的复习量（用于画趋势） */
  async recentActivity(days = 7, now: Date = new Date()): Promise<{ day: string; count: number }[]> {
    const logs = await this.storage.getAll('reviewLogs');
    const today = todayLocal(now);
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
