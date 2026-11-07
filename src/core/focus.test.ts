import { beforeEach, describe, expect, it } from 'vitest';
import { FocusService, localDay } from './focus.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 专注记录的测试。
 *
 * ## 重点一：本地日历，不是 UTC
 *
 * 项目里 `srs.ts` 用的是 UTC 日期串（已知问题）。专注记录是新功能，
 * 直接用本地日历 —— 北京 23:50 和 00:10 是同一天的两端，
 * 不该因为跨了 UTC 日期就被拆到两天。
 *
 * ## 重点二：轮数与时长分开算
 *
 * 中止的轮次不算「一轮」，但那段时间确实专注了，要算进时长。
 * 混在一起会让「今天专注了 5 轮」不可信。
 */
describe('localDay', () => {
  it('给的是本地日历日，不是 UTC', () => {
    /*
     * 构造一个本地时间 2026-11-08 00:30。
     * new Date(2026, 10, 8, 0, 30) 用的是本地时区，
     * 所以 localDay 必须原样返回 2026-11-08 ——
     * 而 toISOString() 在东八区会得到 2026-11-07（前一天）。
     */
    const d = new Date(2026, 10, 8, 0, 30, 0);
    expect(localDay(d)).toBe('2026-11-08');
    // 反证：UTC 写法会差一天（东八区）
    if (d.getTimezoneOffset() < 0) {
      expect(d.toISOString().slice(0, 10)).toBe('2026-11-07');
    }
  });

  it('月份与日补零', () => {
    expect(localDay(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });
});

describe('FocusService', () => {
  let storage: MemoryStorage;
  let svc: FocusService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new FocusService(storage);
  });

  it('记一轮并读回来', async () => {
    const now = new Date(2026, 10, 8, 10, 0, 0);
    await svc.record({ plannedSec: 1500, elapsedSec: 1500, completed: true }, now);
    const all = await svc.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      plannedSec: 1500,
      elapsedSec: 1500,
      completed: true,
      localDay: '2026-11-08',
      manual: false,
    });
  });

  it('实际时长被夹在 [0, 计划时长]', async () => {
    const now = new Date(2026, 10, 8, 10, 0, 0);
    const over = await svc.record({ plannedSec: 1500, elapsedSec: 99999, completed: true }, now);
    expect(over.elapsedSec).toBe(1500);

    const neg = await svc.record({ plannedSec: 1500, elapsedSec: -5, completed: false }, now);
    expect(neg.elapsedSec).toBe(0);
  });

  it('计划时长非法时拒绝', async () => {
    await expect(svc.record({ plannedSec: 0, elapsedSec: 10, completed: false })).rejects.toThrow();
    await expect(svc.record({ plannedSec: -1, elapsedSec: 10, completed: false })).rejects.toThrow();
  });

  it('任务名去首尾空格', async () => {
    const now = new Date(2026, 10, 8, 10, 0, 0);
    const s = await svc.record({ task: '  复习第三章  ', plannedSec: 600, elapsedSec: 600, completed: true }, now);
    expect(s.task).toBe('复习第三章');
  });

  describe('stats', () => {
    it('今天的轮数只数完整走完的，时长算上中止的实际时间', async () => {
      const now = new Date(2026, 10, 8, 20, 0, 0);
      await svc.record({ plannedSec: 1500, elapsedSec: 1500, completed: true }, now);
      await svc.record({ plannedSec: 1500, elapsedSec: 1500, completed: true }, now);
      // 第三轮中途停了，只专注了 300 秒
      await svc.record({ plannedSec: 1500, elapsedSec: 300, completed: false }, now);

      const st = await svc.stats(now);
      expect(st.todayRounds).toBe(2); // 中止的不算一轮
      expect(st.todaySec).toBe(1500 + 1500 + 300); // 但时长要算
    });

    it('昨天的记录不算今天', async () => {
      const yesterday = new Date(2026, 10, 7, 20, 0, 0);
      const today = new Date(2026, 10, 8, 9, 0, 0);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, yesterday);

      const st = await svc.stats(today);
      expect(st.todayRounds).toBe(0);
      expect(st.totalRounds).toBe(1);
    });

    it('连续天数：今天没练也算昨天为止的streak（不算断）', async () => {
      const d1 = new Date(2026, 10, 6, 20, 0, 0);
      const d2 = new Date(2026, 10, 7, 20, 0, 0);
      const today = new Date(2026, 10, 8, 9, 0, 0);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, d1);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, d2);

      // 今天(11-08)还没练，但连续天数应该是 2
      expect((await svc.stats(today)).streakDays).toBe(2);
    });

    it('今天也练了 → streak 包含今天', async () => {
      const d1 = new Date(2026, 10, 7, 20, 0, 0);
      const today = new Date(2026, 10, 8, 9, 0, 0);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, d1);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, today);
      expect((await svc.stats(today)).streakDays).toBe(2);
    });

    it('中间断一天 → streak 只数到断点', async () => {
      const d1 = new Date(2026, 10, 5, 20, 0, 0);
      const d2 = new Date(2026, 10, 7, 20, 0, 0); // 11-06 断了
      const today = new Date(2026, 10, 8, 9, 0, 0);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, d1);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, d2);
      // 今天没练 → 从昨天(11-07)往前数，11-06 没有 → 1
      expect((await svc.stats(today)).streakDays).toBe(1);
    });

    it('没有任何记录 → 全零', async () => {
      const st = await svc.stats(new Date(2026, 10, 8, 9, 0, 0));
      expect(st).toMatchObject({ todayRounds: 0, todaySec: 0, totalRounds: 0, totalSec: 0, streakDays: 0 });
    });

    it('0 秒的记录不算「练过一天」', async () => {
      const now = new Date(2026, 10, 8, 20, 0, 0);
      await svc.record({ plannedSec: 1500, elapsedSec: 0, completed: false }, now);
      expect((await svc.stats(now)).streakDays).toBe(0);
    });
  });

  describe('recentDays', () => {
    it('返回固定长度的连续日期，缺的那天补 0', async () => {
      const today = new Date(2026, 10, 8, 20, 0, 0);
      await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, today);

      const days = await svc.recentDays(7, today);
      expect(days).toHaveLength(7);
      expect(days[6]!.day).toBe('2026-11-08');
      expect(days[6]!.rounds).toBe(1);
      expect(days[0]!.day).toBe('2026-11-02');
      expect(days[0]!.rounds).toBe(0);
    });
  });

  it('删除一条', async () => {
    const now = new Date(2026, 10, 8, 10, 0, 0);
    const s = await svc.record({ plannedSec: 600, elapsedSec: 600, completed: true }, now);
    await svc.remove(s.id);
    expect(await svc.list()).toHaveLength(0);
  });

  it('补记（manual）能落到指定日期', async () => {
    const now = new Date(2026, 10, 8, 10, 0, 0);
    const s = await svc.record(
      { plannedSec: 2400, elapsedSec: 2400, completed: true, localDay: '2026-11-05', manual: true },
      now,
    );
    expect(s.localDay).toBe('2026-11-05');
    expect(s.manual).toBe(true);

    const st = await svc.stats(now);
    expect(st.todayRounds).toBe(0); // 补记在 11-05，不算今天
  });
});
