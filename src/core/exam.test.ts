import { beforeEach, describe, expect, it } from 'vitest';
import { ExamService } from './exam.ts';
import { MemoryStorage } from './storage/memory-storage.ts';
import type { Question } from './model.ts';

/**
 * 模拟考试的测试。
 *
 * ## 重点在哪
 *
 * 考试最容易出错的不是界面，是**算分**：
 * 跳过没答的算不算 0 分、问答类要不要计入、超时交卷怎么记。
 * 这几个判断错了，分数就是错的 —— 而分数是这个功能唯一的产出。
 */

const mkQ = (over: Partial<Question> & { id: string }): Question => ({
  deckId: 'd1',
  kind: 'single',
  prompt: '题干',
  options: [
    { key: 'A', text: '选项A' },
    { key: 'B', text: '选项B' },
  ],
  answer: 'A',
  explanation: '',
  anchors: [],
  knowledgePointId: null,
  cognitiveLevel: 'remember',
  topic: '',
  order: 0,
  createdAt: '2026-11-07',
  updatedAt: '2026-11-07',
  ...over,
});

describe('ExamService', () => {
  let storage: MemoryStorage;
  let svc: ExamService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new ExamService(storage);
  });

  describe('出卷', () => {
    const pool = [
      mkQ({ id: 'q1' }),
      mkQ({ id: 'q2' }),
      mkQ({ id: 'q3' }),
      mkQ({ id: 'q4', kind: 'essay' }),
    ];

    it('按数量抽题', () => {
      const paper = svc.buildPaper({ pool, count: 2, title: 't' });
      expect(paper).toHaveLength(2);
    });

    it('抽题数量超过池子时全用', () => {
      const paper = svc.buildPaper({ pool, count: 100, title: 't' });
      expect(paper).toHaveLength(3); // 问答类被排除
    });

    it('问答类不进模拟考（判分需要人工自评）', () => {
      const paper = svc.buildPaper({ pool, count: 100, title: 't' });
      expect(paper.some((q) => q.kind === 'essay')).toBe(false);
    });

    it('抽题不重复', () => {
      const paper = svc.buildPaper({ pool, count: 3, title: 't' });
      expect(new Set(paper.map((q) => q.id)).size).toBe(paper.length);
    });

    it('count 为 0 时给空卷（不报错）', () => {
      expect(svc.buildPaper({ pool, count: 0, title: 't' })).toHaveLength(0);
    });

    it('池子是空的也不崩', () => {
      expect(svc.buildPaper({ pool: [], count: 10, title: 't' })).toHaveLength(0);
    });
  });

  describe('判分与交卷', () => {
    const qs = [mkQ({ id: 'q1', answer: 'A' }), mkQ({ id: 'q2', answer: 'B' })];

    it('全对得满分', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        answers: [
          { questionId: 'q1', response: 'A', correct: true },
          { questionId: 'q2', response: 'B', correct: true },
        ],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 300,
        timedOut: false,
      });
      expect(a.correct).toBe(2);
      expect(a.total).toBe(2);
    });

    it('**跳过没答的题算错**（不能因为没答就不计入总分）', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        answers: [{ questionId: 'q1', response: 'A', correct: true }],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 100,
        timedOut: false,
      });
      expect(a.correct).toBe(1);
      expect(a.total).toBe(2);
      /* 缺的那题被补成「未作答」，不算对 */
      const q2 = a.answers.find((x) => x.questionId === 'q2');
      expect(q2).toBeTruthy();
      expect(q2!.response).toBe('');
      expect(q2!.correct).toBe(false);
    });

    it('作答顺序与出卷顺序对齐', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        /* 故意倒序传入 */
        answers: [
          { questionId: 'q2', response: 'B', correct: true },
          { questionId: 'q1', response: 'A', correct: true },
        ],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 100,
        timedOut: false,
      });
      expect(a.answers.map((x) => x.questionId)).toEqual(['q1', 'q2']);
    });

    it('超时交卷被记录下来', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        answers: [],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 60,
        usedSec: 61,
        timedOut: true,
      });
      expect(a.timedOut).toBe(true);
      expect(a.usedSec).toBe(61);
    });

    it('用时取整并夹掉负数', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        answers: [],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 0,
        usedSec: -5,
        timedOut: false,
      });
      expect(a.usedSec).toBe(0);
    });

    it('交卷后能读回来', async () => {
      const a = await svc.submit({
        title: '模拟考试 · 测试',
        questions: qs,
        answers: [{ questionId: 'q1', response: 'A', correct: true }],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 120,
        timedOut: false,
      });
      const back = await svc.get(a.id);
      expect(back?.title).toBe('模拟考试 · 测试');
      expect(back?.correct).toBe(1);
    });

    it('列表按交卷时间倒序', async () => {
      await svc.submit({
        title: '第一次',
        questions: qs,
        answers: [],
        startedAt: '2026-11-07T09:00:00Z',
        limitSec: 600,
        usedSec: 100,
        timedOut: false,
      });
      /* 手动把第一条的 finishedAt 改早，模拟「先考的那次」 */
      const all = await storage.getAll('examAttempts');
      const first = all[0]!;
      await storage.put('examAttempts', { ...first, finishedAt: '2026-11-06T09:00:00Z' });

      await svc.submit({
        title: '第二次',
        questions: qs,
        answers: [],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 100,
        timedOut: false,
      });

      const list = await svc.list();
      expect(list[0]!.title).toBe('第二次');
    });

    it('删除记录', async () => {
      const a = await svc.submit({
        title: 't',
        questions: qs,
        answers: [],
        startedAt: '2026-11-07T10:00:00Z',
        limitSec: 600,
        usedSec: 10,
        timedOut: false,
      });
      await svc.remove(a.id);
      expect(await svc.get(a.id)).toBeNull();
    });
  });

  describe('成绩趋势', () => {
    it('按得分率给出趋势，最旧的在前', () => {
      const mk = (at: string, correct: number, total: number) =>
        ({
          finishedAt: at,
          correct,
          total,
        }) as never;

      const trend = ExamService.trend([
        mk('2026-11-07T10:00:00Z', 9, 10), // 最近
        mk('2026-11-06T10:00:00Z', 5, 10),
        mk('2026-11-05T10:00:00Z', 1, 10), // 最早
      ]);

      expect(trend.map((t) => t.rate)).toEqual([0.1, 0.5, 0.9]);
    });

    it('0 题的空卷不进趋势（会把线砸到底）', () => {
      const trend = ExamService.trend([
        { finishedAt: '2026-11-07T10:00:00Z', correct: 0, total: 0 } as never,
        { finishedAt: '2026-11-06T10:00:00Z', correct: 5, total: 10 } as never,
      ]);
      expect(trend).toHaveLength(1);
      expect(trend[0]!.rate).toBe(0.5);
    });

    it('可以限制条数', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        finishedAt: `2026-11-${String(10 - (i % 9)).padStart(2, '0')}T10:00:00Z`,
        correct: i,
        total: 20,
      }));
      expect(ExamService.trend(rows as never, 5)).toHaveLength(5);
    });
  });
});
