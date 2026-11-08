import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewService } from './review-service.ts';
import { MemoryStorage } from '@/core/storage/memory-storage.ts';
import { todayUtc } from './srs.ts';

/**
 * 复习服务的测试。
 *
 * 重点验「面板上的数字必须来自同一时刻的快照」——
 * 早先的功能里出现过「显示到期 5 张但列表只有 3 张」这类矛盾，
 * 用户会觉得软件在乱报数字。
 */

const at = new Date('2026-11-06T10:00:00Z');

describe('ReviewService：复习与进度', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('首次复习会建记录', async () => {
    const r = await svc.review('q1', 'question', 'good', at);
    expect(r.cardId).toBe('q1');
    expect(r.state.reviewCount).toBe(1);
    /*
     * 改成艾宾浩斯阶梯后，首次 good 落到第 1 级 = 2 天。
     * （旧 SM-2 给 1 天，和 hard 相同 —— 那正是用户抱怨「没区分度」的根源。）
     * 精确天数由 ebbinghaus.test.ts 覆盖，这里只关心「记录建对了、间隔合理」。
     */
    expect(r.state.intervalDays).toBeGreaterThanOrEqual(1);
    expect(r.state.dueAt).toBeTruthy();
  });

  it('再次复习在旧状态上累加', async () => {
    await svc.review('q1', 'question', 'good', at);
    const r2 = await svc.review('q1', 'question', 'good', at);
    expect(r2.state.reviewCount).toBe(2);
    expect(r2.state.intervalDays).toBeGreaterThan(1);
  });

  it('答错会缩短间隔（回到当天内重考）', async () => {
    await svc.review('q1', 'question', 'easy', at);
    await svc.review('q1', 'question', 'easy', at);
    const before = (await svc.getRecord('q1'))!.state.intervalDays;
    const after = await svc.review('q1', 'question', 'again', at);
    // 艾宾浩斯：忘了就当天再补，所以是 0 天
    expect(after.state.intervalDays).toBe(0);
    expect(before).toBeGreaterThan(1);
  });

  it('每次复习都记一条历史', async () => {
    await svc.review('q1', 'question', 'good', at);
    await svc.review('q1', 'question', 'again', at);
    const logs = await storage.getAll('reviewLogs');
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.grade)).toEqual(['good', 'again']);
  });

  it('不同卡片互不影响', async () => {
    await svc.review('q1', 'question', 'easy', at);
    await svc.review('q2', 'question', 'again', at);
    const q1 = (await svc.getRecord('q1'))!.state.intervalDays;
    const q2 = (await svc.getRecord('q2'))!.state.intervalDays;
    // easy 的间隔必须明显大于 again；again 是 0 天（当天内重考）
    expect(q1).toBeGreaterThan(q2);
    expect(q2).toBe(0);
  });

  it('批量查询一次拿到多张卡', async () => {
    await svc.review('q1', 'question', 'good', at);
    await svc.review('q2', 'question', 'good', at);
    const map = await svc.getRecords(['q1', 'q2', 'q3']);
    expect(map.size).toBe(2);
    expect(map.has('q3')).toBe(false);
  });
});

describe('ReviewService：今日概览', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('全没学过时：全是新卡，到期 0', async () => {
    const o = await svc.todayOverview(['q1', 'q2', 'q3'], at);
    expect(o.freshCount).toBe(3);
    expect(o.dueCount).toBe(0);
    expect(o.totalCards).toBe(3);
    expect(o.learnedCards).toBe(0);
    expect(o.avgMastery).toBe(0);
  });

  it('学过但未到期：不算 due', async () => {
    await svc.review('q1', 'question', 'easy', at); // 3 天后
    const o = await svc.todayOverview(['q1', 'q2'], at);
    expect(o.dueCount).toBe(0);
    expect(o.learnedCards).toBe(1);
  });

  it('今天的复习计入 doneToday 与正确率', async () => {
    await svc.review('q1', 'question', 'good', at);
    await svc.review('q2', 'question', 'again', at);
    const o = await svc.todayOverview(['q1', 'q2'], at);
    expect(o.doneToday).toBe(2);
    // 2 次里 1 次答对
    expect(o.accuracyToday).toBe(0.5);
  });

  it('没有复习记录时正确率为 null（不编造 0）', async () => {
    const o = await svc.todayOverview(['q1'], at);
    expect(o.accuracyToday).toBeNull();
  });

  it('概览数字只统计池子里的卡', async () => {
    await svc.review('q1', 'question', 'good', at);
    await svc.review('not-in-pool', 'question', 'good', at);
    const o = await svc.todayOverview(['q1', 'q2'], at);
    expect(o.learnedCards).toBe(1);  // 只算 q1
    expect(o.totalCards).toBe(2);
  });

  it('平均熟练度随复习提升', async () => {
    const before = await svc.todayOverview(['q1'], at);
    await svc.review('q1', 'question', 'easy', at);
    await svc.review('q1', 'question', 'easy', at);
    const after = await svc.todayOverview(['q1'], at);
    expect(after.avgMastery).toBeGreaterThan(before.avgMastery);
  });
});

describe('ReviewService：到期列表与趋势', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('到期列表按逾期优先', async () => {
    // 造两张逾期不同的卡
    await storage.put('reviewRecords', {
      id: 'rv:old', cardId: 'old', kind: 'question',
      state: { ease: 2.5, intervalDays: 1, streak: 1, reviewCount: 1, lapseCount: 0, dueAt: '2026-10-01' },
      firstSeenAt: '2026-09-30', updatedAt: '2026-09-30T00:00:00Z',
    });
    await storage.put('reviewRecords', {
      id: 'rv:new', cardId: 'new', kind: 'question',
      state: { ease: 2.5, intervalDays: 1, streak: 1, reviewCount: 1, lapseCount: 0, dueAt: '2026-11-05' },
      firstSeenAt: '2026-11-04', updatedAt: '2026-11-04T00:00:00Z',
    });
    const due = await svc.dueCards(['old', 'new'], at);
    expect(due[0]).toBe('old'); // 逾期更久
  });

  it('趋势返回指定天数且含今天', async () => {
    await svc.review('q1', 'question', 'good', at);
    const trend = await svc.recentActivity(7, at);
    expect(trend).toHaveLength(7);
    expect(trend[trend.length - 1]!.day).toBe(todayUtc(at));
    expect(trend[trend.length - 1]!.count).toBe(1);
  });
});

/**
 * 错题集。
 *
 * ## 这一组测试的由来（重要）
 *
 * 用户要求「答错了直接记入错题就行」。实现时发现一个**假功能**：
 * 原来的错题列表读 `answerRecords`，而 v2 做题流程从不写那张表
 * （实测真实库里 0 条）—— 于是「错题巩固」永远显示空，
 * 用户答错了也不会进错题集。
 *
 * 现在改为从 `reviewLogs` 派生（grade === 'again' 即答错）。
 * 下面这些用例把「答错 → 进错题 → 答对 → 离开错题」整条链路钉死。
 */
describe('错题集（从 reviewLogs 派生）', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('答错后进入错题集', async () => {
    await svc.review('q1', 'question', 'again', at);
    expect(await svc.wrongCards()).toEqual(['q1']);
  });

  it('答对不进错题集', async () => {
    await svc.review('q1', 'question', 'good', at);
    expect(await svc.wrongCards()).toEqual([]);
  });

  it('答错后改对 → 从错题集消失（不是「曾经错过」）', async () => {
    await svc.review('q1', 'question', 'again', at);
    expect(await svc.wrongCards()).toEqual(['q1']);

    await svc.review('q1', 'question', 'good', at);
    expect(await svc.wrongCards()).toEqual([]);
  });

  it('多道题：只保留最近一次答错的', async () => {
    await svc.review('q1', 'question', 'again', at);
    await svc.review('q2', 'question', 'again', at);
    await svc.review('q3', 'question', 'good', at);
    const wrong = await svc.wrongCards();
    expect(wrong.sort()).toEqual(['q1', 'q2']);
  });

  it('同一题错两次再对：顺序不会把它误判成错题', async () => {
    /*
     * 「最近一次」必须按日志的**写入顺序**判断，不能按时间戳 ——
     * 因为同一毫秒内两次提交的时间戳完全相同。
     */
    await svc.review('q1', 'question', 'again', at);
    await svc.review('q1', 'question', 'again', at);
    await svc.review('q1', 'question', 'good', at);
    expect(await svc.wrongCards()).toEqual([]);
  });

  it('详细视图带「错了几次」', async () => {
    await svc.review('q1', 'question', 'again', at);
    await svc.review('q1', 'question', 'good', at);
    await svc.review('q1', 'question', 'again', at);
    const detail = await svc.wrongCardsDetailed();
    expect(detail).toHaveLength(1);
    expect(detail[0]!.cardId).toBe('q1');
    // 累计答错 2 次（中间答对过也算历史）
    expect(detail[0]!.wrongCount).toBe(2);
  });

  it('详细视图排除知识点（知识点没有「答错」）', async () => {
    await svc.review('p1', 'point', 'again', at);
    await svc.review('q1', 'question', 'again', at);
    const detail = await svc.wrongCardsDetailed();
    expect(detail.map((d) => d.cardId)).toEqual(['q1']);
  });

  it('错得多的排前面', async () => {
    await svc.review('q1', 'question', 'again', at);
    await svc.review('q2', 'question', 'again', at);
    await svc.review('q2', 'question', 'good', at);
    await svc.review('q2', 'question', 'again', at);
    const detail = await svc.wrongCardsDetailed();
    expect(detail[0]!.cardId).toBe('q2');
    expect(detail[0]!.wrongCount).toBe(2);
  });

  it('空库返回空数组（不是报错）', async () => {
    expect(await svc.wrongCards()).toEqual([]);
    expect(await svc.wrongCardsDetailed()).toEqual([]);
  });
});

/**
 * 掌握度分布必须按卡片池过滤（2026-11-08 修）。
 *
 * 踩过的问题：统计页顶部写「总卡片 16 张」（来自 cardPool），
 * 而分布数字加起来只有 10 —— 因为分布遍历了**全部** reviewRecords，
 * 其中包括「题已被删掉」的孤儿记录。用户看到差 6 张，以为统计坏了。
 *
 * 这就是「同一屏的数字必须来自同一个池子」那条规矩的又一次验证。
 */
describe('masteryDistribution：按池子过滤', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(async () => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
    // 三条记录：两条在池子里，一条是已删除题的孤儿
    await svc.review('q_keep_1', 'question', 'good', at);
    await svc.review('q_keep_2', 'question', 'again', at);
    await svc.review('q_deleted', 'question', 'good', at);
  });

  it('传池子时只数池子里的卡', async () => {
    const dist = await svc.masteryDistribution(['q_keep_1', 'q_keep_2']);
    const total = dist.unlearned + dist.weak + dist.learning + dist.familiar + dist.mastered;
    expect(total).toBe(2);
  });

  it('不传池子时退回旧行为（数全部记录）', async () => {
    const dist = await svc.masteryDistribution();
    const total = dist.unlearned + dist.weak + dist.learning + dist.familiar + dist.mastered;
    expect(total).toBe(3);
  });

  it('池子是空 → 全零（不是数出全部记录）', async () => {
    const dist = await svc.masteryDistribution([]);
    const total = dist.unlearned + dist.weak + dist.learning + dist.familiar + dist.mastered;
    expect(total).toBe(0);
  });

  /*
   * 这一条锁的是 2026-11-08 查出的第二个问题：
   * 题库池 16 道、复习记录只有 10 条 —— 因为 reviewRecords 只在
   * **第一次复习时**才创建，从没点过的题在里面没有条目。
   *
   * 于是分布五档加起来 10，而顶部写「总卡片 16 张」。
   * 用户看到差 6 张会以为统计坏了。
   *
   * 修法：池子里没有记录的一律算「未学」，保证
   * **五档之和 == 池子大小**，与顶部数字永远一致。
   */
  it('池子里没记录的卡算「未学」—— 五档之和等于池子大小', async () => {
    // 只有 q_keep_1 有记录，但池子里有 5 道
    const pool = ['q_keep_1', 'q_never_1', 'q_never_2', 'q_never_3', 'q_never_4'];
    const dist = await svc.masteryDistribution(pool);
    const total = dist.unlearned + dist.weak + dist.learning + dist.familiar + dist.mastered;

    expect(total).toBe(pool.length);
    // 四道没练过的都在「未学」里
    expect(dist.unlearned).toBeGreaterThanOrEqual(4);
  });

  it('池子里全都没记录 → 全部算未学', async () => {
    const dist = await svc.masteryDistribution(['a', 'b', 'c']);
    expect(dist.unlearned).toBe(3);
    expect(dist.weak + dist.learning + dist.familiar + dist.mastered).toBe(0);
  });
});
