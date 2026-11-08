/**
 * 专注记录服务（番茄钟）。
 *
 * ## 为什么「今天专注了几轮」要用**本地日历**
 *
 * `srs.ts` 的复习日期判定原先用 UTC 计数，2026-11-08 已统一改为本地日历
 * （`todayLocal()`）—— 与这里完全一致，两套口径不再并存。
 * 当时专注记录作为新功能先用了本地日历，理由同样成立：
 *
 *   北京 23:50 和 00:10 是两天 —— 用户熬到半夜，那 20 分钟应该算「今天」，
 *   不该因为跨了 UTC 日期就被算到前一天。
 *
 * 依据：StudyHub 的 `lib/sm2.js` 明确写过这个问题
 * （"ts-fsrs counts UTC days, so in Beijing 07:50 and 08:10 would be two days"），
 * 它为此偏离了上游库的行为。新代码没有理由再犯一次。
 *
 * ## 为什么记录里同时存 startedAt 和 localDay
 *
 * `startedAt` 是精确时刻（做统计、排序用）；
 * `localDay` 是当时算好的本地日期串。
 * 存下来而不是每次现算，是因为用户换时区/改系统时间后，
 * 旧记录仍应按「当时那一天」统计 —— 那才是他真实的经历。
 */

import type { FocusSession } from '@/core/model.ts';
import type { StorageAdapter } from '@/core/storage/types.ts';
import { newId, nowIso } from '@/core/id.ts';

/** 一轮专注的输入 */
export interface FocusInput {
  task?: string;
  plannedSec: number;
  elapsedSec: number;
  /** 是否完整走完（中止的轮次 false） */
  completed: boolean;
  /** 补记时用的日期（YYYY-MM-DD，本地日历）；不传就是现在 */
  localDay?: string;
  /** 补记标记 */
  manual?: boolean;
}

/** 本地日历日（YYYY-MM-DD）。不用 toISOString，那会转成 UTC */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface FocusStats {
  /** 今天完整走完的轮数 */
  todayRounds: number;
  /** 今天专注的秒数（含中止，中止只计实际时长） */
  todaySec: number;
  /** 累计轮数 */
  totalRounds: number;
  /** 累计专注秒数 */
  totalSec: number;
  /** 连续天数（按本地日历，今天没练则从昨天往前数） */
  streakDays: number;
}

export class FocusService {
  constructor(private readonly storage: StorageAdapter) {}

  /** 全部记录，按开始时间升序 */
  async list(): Promise<FocusSession[]> {
    const all = await this.storage.getAll('focusSessions');
    return [...all].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  }

  /** 记一轮 */
  async record(input: FocusInput, now: Date = new Date()): Promise<FocusSession> {
    if (!Number.isFinite(input.plannedSec) || input.plannedSec <= 0) {
      throw new Error('计划时长必须大于 0');
    }
    /*
     * 实际时长夹在 [0, plannedSec]。
     * 上限是为了防「计时器算错导致记录 3 小时」——
     * 一轮专注一旦超过计划时长，多出来的部分是它自己没停，
     * 不该记成用户真的专注了那么久。
     */
    const elapsedSec = Math.max(0, Math.min(input.plannedSec, Math.round(input.elapsedSec)));

    const session: FocusSession = {
      id: newId('focus'),
      task: (input.task ?? '').trim(),
      plannedSec: Math.round(input.plannedSec),
      elapsedSec,
      completed: input.completed,
      startedAt: nowIso(),
      localDay: input.localDay ?? localDay(now),
      manual: input.manual === true,
    };
    await this.storage.put('focusSessions', session);
    return session;
  }

  /** 删一条（记错了） */
  async remove(id: string): Promise<void> {
    await this.storage.remove('focusSessions', id);
  }

  /**
   * 统计。
   *
   * 「轮数」只数完整走完的 —— 中止的轮次说明中途有事，
   * 把它算一轮会让「今天专注了 5 轮」变得不可信。
   * 但**时长**要算上中止的那部分实际时间：那 12 分钟确实专注了。
   */
  async stats(now: Date = new Date()): Promise<FocusStats> {
    const all = await this.list();
    const today = localDay(now);

    let todayRounds = 0;
    let todaySec = 0;
    let totalRounds = 0;
    let totalSec = 0;
    const days = new Set<string>();

    for (const s of all) {
      totalSec += s.elapsedSec;
      if (s.completed) totalRounds += 1;
      if (s.elapsedSec > 0) days.add(s.localDay);

      if (s.localDay === today) {
        todaySec += s.elapsedSec;
        if (s.completed) todayRounds += 1;
      }
    }

    return {
      todayRounds,
      todaySec,
      totalRounds,
      totalSec,
      streakDays: streakOf(days, today),
    };
  }

  /** 按本地日历日聚合最近 N 天（供柱状图） */
  async recentDays(
    count = 7,
    now: Date = new Date(),
  ): Promise<{ day: string; rounds: number; sec: number }[]> {
    const all = await this.list();
    const byDay = new Map<string, { rounds: number; sec: number }>();
    for (const s of all) {
      const cur = byDay.get(s.localDay) ?? { rounds: 0, sec: 0 };
      cur.sec += s.elapsedSec;
      if (s.completed) cur.rounds += 1;
      byDay.set(s.localDay, cur);
    }

    const out: { day: string; rounds: number; sec: number }[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = localDay(d);
      const v = byDay.get(key) ?? { rounds: 0, sec: 0 };
      out.push({ day: key, rounds: v.rounds, sec: v.sec });
    }
    return out;
  }
}

/**
 * 连续天数。
 *
 * 与 `ReviewService.streakDays` 同一个规则：**今天没练不算断**，
 * 从昨天开始往前数。理由已经写在那边的注释里 ——
 * 早上打开看到「0 天」是最打击人的一种显示。
 */
function streakOf(days: ReadonlySet<string>, today: string): number {
  if (days.size === 0) return 0;

  const shift = (dayStr: string, delta: number): string => {
    const [y, m, d] = dayStr.split('-').map(Number);
    const dt = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta);
    return localDay(dt);
  };

  let cursor = days.has(today) ? today : shift(today, -1);
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = shift(cursor, -1);
  }
  return n;
}
