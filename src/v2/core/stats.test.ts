import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewService } from './review-service.ts';
import { MemoryStorage } from '@/core/storage/memory-storage.ts';

/**
 * 统计能力的测试。
 *
 * ## 为什么连续天数必须测
 *
 * 「连续学习 N 天」是最容易算错、也最容易打击人的显示：
 *  - 今天还没学就显示 0 天 → 用户觉得前功尽弃
 *  - 中间断一天没断 → 用户觉得数字虚高，失去可信度
 *  - 时区处理错 → 半夜学的记到前一天
 *
 * 这类错误用户很难说清具体哪里不对，只能含糊地说「数字好像不准」。
 */

const at = (d: string) => new Date(`${d}T10:00:00Z`);

describe('ReviewService：连续学习天数', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  /** 造一条某天的复习日志 */
  async function logOn(day: string) {
    await storage.put('reviewLogs', {
      id: `rl:${day}:${Math.random()}`,
      cardId: 'q1',
      kind: 'question',
      grade: 'good',
      day,
      prevIntervalDays: 1,
      newIntervalDays: 2,
      at: `${day}T10:00:00Z`,
    });
  }

  it('没有记录时为 0', async () => {
    expect(await svc.streakDays(at('2026-11-06'))).toBe(0);
  });

  it('今天学了算 1 天', async () => {
    await logOn('2026-11-06');
    expect(await svc.streakDays(at('2026-11-06'))).toBe(1);
  });

  it('连续三天算 3', async () => {
    await logOn('2026-11-04');
    await logOn('2026-11-05');
    await logOn('2026-11-06');
    expect(await svc.streakDays(at('2026-11-06'))).toBe(3);
  });

  it('**今天还没学但昨天学了，仍算连续**（不能归零打击人）', async () => {
    await logOn('2026-11-04');
    await logOn('2026-11-05');
    // 今天是 11-06，还没学
    expect(await svc.streakDays(at('2026-11-06'))).toBe(2);
  });

  it('中间断一天就重新算', async () => {
    await logOn('2026-11-01');
    await logOn('2026-11-02');
    // 11-03 断了
    await logOn('2026-11-05');
    await logOn('2026-11-06');
    expect(await svc.streakDays(at('2026-11-06'))).toBe(2);
  });

  it('前天学过、昨天没学、今天没学 → 0（真的断了）', async () => {
    await logOn('2026-11-04');
    expect(await svc.streakDays(at('2026-11-06'))).toBe(0);
  });

  it('同一天多次复习只算一天', async () => {
    await logOn('2026-11-06');
    await logOn('2026-11-06');
    await logOn('2026-11-06');
    expect(await svc.streakDays(at('2026-11-06'))).toBe(1);
  });

  it('跨月连续', async () => {
    await logOn('2026-10-30');
    await logOn('2026-10-31');
    await logOn('2026-11-01');
    await logOn('2026-11-02');
    expect(await svc.streakDays(at('2026-11-02'))).toBe(4);
  });
});

describe('ReviewService：12 周热力图', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('返回 12×7 = 84 天', async () => {
    const cells = await svc.heatmap(12, at('2026-11-06'));
    expect(cells).toHaveLength(84);
  });

  it('**按周一对齐**（不按「14 天前」，否则每列错位）', async () => {
    const cells = await svc.heatmap(1, at('2026-11-06'));
    // 2026-11-06 是周五，本周一是 11-02
    expect(cells[0]!.day).toBe('2026-11-02');
  });

  it('日期连续无空洞', async () => {
    const cells = await svc.heatmap(2, at('2026-11-06'));
    for (let i = 1; i < cells.length; i++) {
      const prev = Date.parse(`${cells[i - 1]!.day}T00:00:00Z`);
      const cur = Date.parse(`${cells[i]!.day}T00:00:00Z`);
      expect(cur - prev).toBe(86400000);
    }
  });

  it('把复习量填到对应日期', async () => {
    const cell = (await svc.heatmap(2, at('2026-11-06'))).find((c) => c.day === '2026-11-05');
    expect(cell).toBeDefined();
    // 造两条 11-05 的记录
    for (let i = 0; i < 2; i++) {
      await storage.put('reviewLogs', {
        id: `rl:x${i}`,
        cardId: 'q1',
        kind: 'question',
        grade: 'good',
        day: '2026-11-05',
        prevIntervalDays: 1,
        newIntervalDays: 2,
        at: '2026-11-05T10:00:00Z',
      });
    }
    const after = (await svc.heatmap(2, at('2026-11-06'))).find((c) => c.day === '2026-11-05');
    expect(after!.count).toBe(2);
  });

  it('没记录的日期 count 为 0', async () => {
    const cells = await svc.heatmap(1, at('2026-11-06'));
    expect(cells.every((c) => c.count === 0)).toBe(true);
  });
});

describe('ReviewService：掌握度分布', () => {
  let storage: MemoryStorage;
  let svc: ReviewService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ReviewService(storage);
  });

  it('没学过时全在 unlearned', async () => {
    const d = await svc.masteryDistribution();
    expect(d).toEqual({ unlearned: 0, weak: 0, learning: 0, familiar: 0, mastered: 0 });
  });

  it('刚学一次落在 learning 档（间隔还短，但正确率 100%）', async () => {
    // 一次 good：interval=1 天 → intervalScore≈0，
    // 但 accuracy=1 与 streakBonus 把它推到 0.48，属于「学习中」。
    // 这个分档是合理的：间隔还短，不该算「薄弱」，也远不到「熟练」。
    await svc.review('q1', 'question', 'good', at('2026-11-06'));
    const d = await svc.masteryDistribution();
    expect(d.learning).toBe(1);
    expect(d.mastered).toBe(0);
  });

  it('答错过的落在 weak', async () => {
    await svc.review('q1', 'question', 'again', at('2026-11-06'));
    const d = await svc.masteryDistribution();
    expect(d.weak).toBe(1);
  });

  it('多次 easy 会推进到更高的档', async () => {
    let t = '2026-11-06';
    for (let i = 0; i < 8; i++) {
      const r = await svc.review('q1', 'question', 'easy', at(t));
      t = r.state.dueAt;
    }
    const d = await svc.masteryDistribution();
    const high = d.familiar + d.mastered;
    expect(high).toBe(1);
  });

  it('五档之和等于记录总数', async () => {
    await svc.review('q1', 'question', 'good', at('2026-11-06'));
    await svc.review('q2', 'question', 'easy', at('2026-11-06'));
    await svc.review('q3', 'question', 'again', at('2026-11-06'));
    const d = await svc.masteryDistribution();
    const sum = d.unlearned + d.weak + d.learning + d.familiar + d.mastered;
    expect(sum).toBe(3);
  });
});
