import { describe, expect, it } from 'vitest';
import {
  clockOf,
  dueRows,
  promptPreview,
  reviewedRows,
  todayDetailEmpty,
  gradeLabel,
} from '@/v2/core/stats-today.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { ReviewLog, ReviewRecord } from '@/v2/core/review-service.ts';

const mkCard = (over: Partial<Card>): Card => ({
  id: 'q1',
  sourceId: 's1',
  kind: 'single',
  prompt: '题干',
  options: [],
  answer: 'A',
  explanation: '',
  anchors: [],
  deckId: 'd1',
  createdAt: '2026-11-06',
  ...over,
});

const mkLog = (over: Partial<ReviewLog>): ReviewLog => ({
  id: 'rl:q1:1:abc',
  cardId: 'q1',
  kind: 'question',
  grade: 'good',
  day: '2026-11-13',
  prevIntervalDays: 1,
  newIntervalDays: 3,
  at: '2026-11-13T01:30:00.000Z',
  ...over,
});

const mkRecord = (over: Partial<ReviewRecord>): ReviewRecord => ({
  id: 'rv:q1',
  cardId: 'q1',
  kind: 'question',
  state: {
    ease: 2.5,
    intervalDays: 1,
    streak: 1,
    reviewCount: 1,
    lapseCount: 0,
    dueAt: '2026-11-13',
  },
  firstSeenAt: '2026-11-10',
  updatedAt: '2026-11-10T00:00:00.000Z',
  ...over,
});

describe('promptPreview', () => {
  it('题被删掉时给一句说明，不留空行', () => {
    expect(promptPreview(undefined)).toBe('（这道题已不在题库里）');
  });

  it('折叠换行与多余空格', () => {
    expect(promptPreview(mkCard({ prompt: '  一阶  系统\n\n的 响应 ' }))).toBe(
      '一阶 系统 的 响应',
    );
  });

  it('超长题干截断并加省略号', () => {
    const long = '信'.repeat(200);
    const out = promptPreview(mkCard({ prompt: long }));
    expect(out.length).toBe(73);
    expect(out.endsWith('…')).toBe(true);
  });

  it('空题干不显示成空白', () => {
    expect(promptPreview(mkCard({ prompt: '   ' }))).toBe('（这道题没有题干）');
  });
});

describe('clockOf', () => {
  it('解析 ISO 时间串', () => {
    const out = clockOf('2026-11-13T01:30:00.000Z');
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it('解析不出来时返回空串而不是 NaN', () => {
    expect(clockOf('不是时间')).toBe('');
  });
});

describe('reviewedRows', () => {
  const cards = new Map<string, Card>([
    ['q1', mkCard({ id: 'q1', kind: 'single', prompt: '一阶系统的单位阶跃响应' })],
    ['q2', mkCard({ id: 'q2', kind: 'blank', prompt: '二阶系统的阻尼比公式' })],
  ]);

  it('只取当天的日志', () => {
    const logs = [
      mkLog({ id: 'a', cardId: 'q1', day: '2026-11-13' }),
      mkLog({ id: 'b', cardId: 'q2', day: '2026-11-12' }),
    ];
    const rows = reviewedRows(logs, '2026-11-13', cards);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cardId).toBe('q1');
  });

  it('题目被删掉也保留这一行，并标记 missing', () => {
    const logs = [mkLog({ id: 'a', cardId: 'q_gone', day: '2026-11-13' })];
    const rows = reviewedRows(logs, '2026-11-13', cards);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missing).toBe(true);
    expect(rows[0]?.kind).toBeNull();
    expect(rows[0]?.prompt).toBe('（这道题已不在题库里）');
  });

  it('行数等于当天日志数（含已删除的题）', () => {
    const logs = [
      mkLog({ id: 'a', cardId: 'q1', day: '2026-11-13' }),
      mkLog({ id: 'b', cardId: 'q2', day: '2026-11-13' }),
      mkLog({ id: 'c', cardId: 'q_gone', day: '2026-11-13' }),
    ];
    expect(reviewedRows(logs, '2026-11-13', cards)).toHaveLength(3);
  });

  it('按时间倒序，最近的在前', () => {
    const logs = [
      mkLog({ id: 'a', cardId: 'q1', at: '2026-11-13T01:00:00.000Z' }),
      mkLog({ id: 'b', cardId: 'q2', at: '2026-11-13T09:00:00.000Z' }),
    ];
    const rows = reviewedRows(logs, '2026-11-13', cards);
    expect(rows[0]?.cardId).toBe('q2');
  });

  it('带出评级与题型，供界面标注', () => {
    const logs = [mkLog({ id: 'a', cardId: 'q2', grade: 'again' })];
    const rows = reviewedRows(logs, '2026-11-13', cards);
    expect(rows[0]?.grade).toBe('again');
    expect(rows[0]?.kind).toBe('blank');
  });
});

describe('dueRows', () => {
  const cards = new Map<string, Card>([
    ['q1', mkCard({ id: 'q1', prompt: '待复习的一题' })],
    ['q2', mkCard({ id: 'q2', prompt: '逾期的另一题' })],
  ]);

  it('逾期越久越靠前', () => {
    const records = new Map<string, ReviewRecord>([
      ['q1', mkRecord({ cardId: 'q1', state: { ...mkRecord({}).state, dueAt: '2026-11-13' } })],
      ['q2', mkRecord({ cardId: 'q2', state: { ...mkRecord({}).state, dueAt: '2026-11-06' } })],
    ]);
    const rows = dueRows(['q1', 'q2'], records, cards, '2026-11-13');
    expect(rows[0]?.cardId).toBe('q2');
    expect(rows[0]?.overdueDays).toBe(7);
    expect(rows[1]?.overdueDays).toBe(0);
  });

  it('待复习行不带评级与时间', () => {
    const records = new Map<string, ReviewRecord>([
      ['q1', mkRecord({ cardId: 'q1' })],
    ]);
    const rows = dueRows(['q1'], records, cards, '2026-11-13');
    expect(rows[0]?.grade).toBeNull();
    expect(rows[0]?.time).toBeNull();
  });

  it('缺进度时按逾期 0 天算，不抛错', () => {
    const rows = dueRows(['q1'], new Map(), cards, '2026-11-13');
    expect(rows[0]?.overdueDays).toBe(0);
  });

  it('题被删掉也保留行', () => {
    const rows = dueRows(['q_gone'], new Map(), cards, '2026-11-13');
    expect(rows[0]?.missing).toBe(true);
  });
});

describe('todayDetailEmpty', () => {
  it('两种空态文案不同且都不为空', () => {
    expect(todayDetailEmpty('done')).toContain('今天还没复习');
    expect(todayDetailEmpty('due')).toContain('今天没有到期的卡');
  });
});

describe('gradeLabel', () => {
  it('四级评分都有中文短名', () => {
    expect(gradeLabel('again')).toBe('需要重来');
    expect(gradeLabel('hard')).toBe('想了一会儿');
    expect(gradeLabel('good')).toBe('正常速度');
    expect(gradeLabel('easy')).toBe('一眼就会');
  });
});
