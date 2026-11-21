import { describe, expect, it } from 'vitest';
import type { Todo } from '@/core/model.ts';
import { daysBetween, examBadgeFor, examBadgeLabel, examCountdown } from './exam-countdown.ts';

/**
 * 考期倒计时的单测。
 *
 * ## 写这些断言时问过自己的一句话
 *
 * 「一个坏实现能不能通过它？」
 *
 * 例如「今天到期 = 0 天」这条：如果实现里写成 `daysLeft = diff || 1`，
 * 或者把 `due >= today` 写成 `due > today`，就会漏掉今天到期的那场考试。
 * 所以这里断言的是 `daysLeft === 0` **而且** 返回的不是 null ——
 * 只断言后者的话，一个把今天算成「1 天」的实现也能过。
 *
 * ## 每条断言都对得上一个真实后果
 *
 * - 已完成的不算 → 考完了首页还挂「距高数期末 3 天」
 * - 无 dueAt 的不算 → 出现「距 null 天」或永远显示今天到期
 * - 过去的不算 → 考完了自动变成「已过期」，首页那块永远不再消失
 * - 多场取最近 → 用户看到的是三个月后那场，而三天后就有一场
 * - 跨夏令时 → 3 月/10 月那两周的倒计时整体差一天（每年两次，很难复现）
 */

/** 造一条最小待办；只覆盖本模块读的字段 */
function todo(over: Partial<Todo> & Pick<Todo, 'id' | 'title'>): Todo {
  return {
    note: '',
    dueAt: null,
    done: false,
    doneAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    order: 0,
    ...over,
  };
}

describe('daysBetween', () => {
  it('同一天是 0', () => {
    expect(daysBetween('2026-11-21', '2026-11-21')).toBe(0);
  });

  it('往后是正数、往前是负数', () => {
    expect(daysBetween('2026-11-21', '2026-11-24')).toBe(3);
    expect(daysBetween('2026-11-24', '2026-11-21')).toBe(-3);
  });

  it('跨月、跨年算得对', () => {
    expect(daysBetween('2026-11-30', '2026-12-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('跨夏令时切换的日子不差一天（不依赖运行机器的时区）', () => {
    /*
     * 3 月 8 日（美）/ 3 月 29 日（欧）是 2026 年的 DST 切换日，
     * 10 月同理。用 Date 相减除以 86400000 会得到 0.958 / 1.042，
     * 一旦实现里用了 floor 就会整整差一天。
     */
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('闰年 2 月 29 日算得对', () => {
    expect(daysBetween('2028-02-28', '2028-02-29')).toBe(1);
    expect(daysBetween('2028-02-29', '2028-03-01')).toBe(1);
  });

  it('格式不对返回 null（宽进会让「脏数据」变成「差几天」）', () => {
    expect(daysBetween('2026-1-1', '2026-01-02')).toBeNull();
    expect(daysBetween('2026-01-01T00:00', '2026-01-02')).toBeNull();
    expect(daysBetween('', '2026-01-02')).toBeNull();
    expect(daysBetween('2026-02-30', '2026-03-02')).toBeNull();
    expect(daysBetween('2026-13-01', '2026-12-31')).toBeNull();
  });
});

describe('examCountdown', () => {
  const TODAY = '2026-11-21';

  it('没有考期时返回 null', () => {
    expect(examCountdown([], TODAY)).toBeNull();
    expect(examCountdown([todo({ id: 'a', title: '普通待办', dueAt: '2026-11-25' })], TODAY)).toBeNull();
  });

  it('取最近的一场未来考期，并给出标题/日期/天数', () => {
    const list = [
      todo({ id: 'e1', title: '高数期末', dueAt: '2026-12-20', isExam: true }),
      todo({ id: 'e2', title: '英语四级', dueAt: '2026-12-05', isExam: true }),
    ];
    const r = examCountdown(list, TODAY);
    expect(r).toEqual({
      id: 'e2',
      title: '英语四级',
      dueAt: '2026-12-05',
      daysLeft: 14,
    });
  });

  it('**今天到期 = 0 天**（不是 1 天，也不是漏掉）', () => {
    const r = examCountdown([todo({ id: 'e', title: '今天考', dueAt: TODAY, isExam: true })], TODAY);
    expect(r).not.toBeNull();
    expect(r?.daysLeft).toBe(0);
  });

  it('过去的不算（考期一旦过了就不再是倒计时）', () => {
    const past = [todo({ id: 'e', title: '上周考完的', dueAt: '2026-11-14', isExam: true })];
    expect(examCountdown(past, TODAY)).toBeNull();
  });

  it('过去的被忽略、未来的仍然选中', () => {
    const list = [
      todo({ id: 'old', title: '上周', dueAt: '2026-11-14', isExam: true }),
      todo({ id: 'next', title: '下月', dueAt: '2026-12-14', isExam: true }),
    ];
    expect(examCountdown(list, TODAY)?.id).toBe('next');
  });

  it('**已完成的考试不算**（考完了首页不该还挂着倒计时）', () => {
    const list = [
      todo({
        id: 'e',
        title: '刚考完',
        dueAt: '2026-11-30',
        isExam: true,
        done: true,
        doneAt: '2026-11-20',
      }),
    ];
    expect(examCountdown(list, TODAY)).toBeNull();
  });

  it('已完成的近期考试不影响更远那场的选中', () => {
    const list = [
      todo({ id: 'done', title: '已考', dueAt: '2026-11-25', isExam: true, done: true, doneAt: '2026-11-20' }),
      todo({ id: 'next', title: '期末', dueAt: '2026-12-25', isExam: true }),
    ];
    expect(examCountdown(list, TODAY)?.id).toBe('next');
  });

  it('**dueAt 为 null 的考试不算**（无法倒计时）', () => {
    const list = [todo({ id: 'e', title: '忘了填日期', isExam: true })];
    expect(examCountdown(list, TODAY)).toBeNull();
  });

  it('isExam 为 undefined 的当普通待办', () => {
    const list = [todo({ id: 'x', title: '普通待办', dueAt: '2026-11-25' })];
    expect(examCountdown(list, TODAY)).toBeNull();
  });

  it('isExam 为 false 的当普通待办', () => {
    const list = [todo({ id: 'x', title: '普通待办', dueAt: '2026-11-25', isExam: false })];
    expect(examCountdown(list, TODAY)).toBeNull();
  });

  it('日期串坏掉的考期跳过，不影响后面那场', () => {
    const list = [
      todo({ id: 'bad', title: '坏日期', dueAt: '2026-11-2', isExam: true }),
      todo({ id: 'ok', title: '正常', dueAt: '2026-12-01', isExam: true }),
    ];
    const r = examCountdown(list, TODAY);
    expect(r?.id).toBe('ok');
    expect(r?.daysLeft).toBe(10);
  });

  it('**更远的未来不算错**：一个月/一年后的天数都对得上', () => {
    const list = [
      todo({ id: 'y', title: '明年', dueAt: '2027-11-21', isExam: true }),
      todo({ id: 'm', title: '下月', dueAt: '2026-12-21', isExam: true }),
    ];
    const r = examCountdown(list, TODAY);
    expect(r?.id).toBe('m');
    expect(r?.daysLeft).toBe(30);

    /* 单条一年后的：2026-11-21 → 2027-11-21 = 365 天（2027 不是闰年） */
    const only = examCountdown([todo({ id: 'y', title: '明年', dueAt: '2027-11-21', isExam: true })], TODAY);
    expect(only?.daysLeft).toBe(365);
  });

  it('**多场考试取最近**，且与输入顺序无关', () => {
    const far = todo({ id: 'far', title: '六月', dueAt: '2027-06-15', isExam: true });
    const near = todo({ id: 'near', title: '下周五', dueAt: '2026-11-27', isExam: true });
    const mid = todo({ id: 'mid', title: '元旦', dueAt: '2027-01-01', isExam: true });
    expect(examCountdown([far, near, mid], TODAY)?.id).toBe('near');
    expect(examCountdown([near, far, mid], TODAY)?.id).toBe('near');
    expect(examCountdown([mid, near, far], TODAY)?.id).toBe('near');
  });

  it('同一天两场考试时结果稳定（不随输入顺序跳）', () => {
    const a = todo({ id: 'a', title: '乙科目', dueAt: '2026-12-01', isExam: true });
    const b = todo({ id: 'b', title: '甲科目', dueAt: '2026-12-01', isExam: true });
    const r1 = examCountdown([a, b], TODAY);
    const r2 = examCountdown([b, a], TODAY);
    expect(r1?.title).toBe(r2?.title);
    expect(r1?.dueAt).toBe('2026-12-01');
    expect(r1?.daysLeft).toBe(10);
  });

  it('today 串坏掉时返回 null，而不是拿 NaN 去算', () => {
    expect(examCountdown([todo({ id: 'e', title: 'x', dueAt: '2026-12-01', isExam: true })], '2026-11-2')).toBeNull();
  });

  it('普通待办里最近的那条不会被误选（只认 isExam）', () => {
    const list = [
      todo({ id: 'plain', title: '明天交作业', dueAt: '2026-11-22' }),
      todo({ id: 'exam', title: '期末', dueAt: '2026-12-20', isExam: true }),
    ];
    expect(examCountdown(list, TODAY)?.id).toBe('exam');
  });
});

describe('examBadgeLabel', () => {
  it('今天 / 未来 / 过去三档', () => {
    expect(examBadgeLabel(0)).toBe('今天');
    expect(examBadgeLabel(1)).toBe('距 1 天');
    expect(examBadgeLabel(14)).toBe('距 14 天');
    expect(examBadgeLabel(-1)).toBe('已过期');
    expect(examBadgeLabel(-30)).toBe('已过期');
  });
});

describe('examBadgeFor', () => {
  const TODAY = '2026-11-21';

  it('未来考期显示「距 N 天」', () => {
    const t = todo({ id: 'e', title: '期末', dueAt: '2026-12-05', isExam: true });
    expect(examBadgeFor(t, TODAY)).toEqual({ label: '距 14 天', daysLeft: 14 });
  });

  it('今天到期显示「今天」', () => {
    const t = todo({ id: 'e', title: '今天考', dueAt: TODAY, isExam: true });
    expect(examBadgeFor(t, TODAY)?.label).toBe('今天');
  });

  it('过期未勾显示「已过期」', () => {
    const t = todo({ id: 'e', title: '上周', dueAt: '2026-11-14', isExam: true });
    expect(examBadgeFor(t, TODAY)?.label).toBe('已过期');
  });

  it('普通待办没有徽标（不能给每条待办都挂一个倒计时）', () => {
    expect(examBadgeFor(todo({ id: 'p', title: 'x', dueAt: '2026-12-01' }), TODAY)).toBeNull();
  });

  it('已完成没有徽标', () => {
    const t = todo({ id: 'e', title: 'x', dueAt: '2026-12-01', isExam: true, done: true });
    expect(examBadgeFor(t, TODAY)).toBeNull();
  });

  it('没有截止日的考期没有徽标', () => {
    expect(examBadgeFor(todo({ id: 'e', title: 'x', isExam: true }), TODAY)).toBeNull();
  });
});