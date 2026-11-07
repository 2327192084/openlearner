/**
 * 模拟考试服务。
 *
 * ## 和「做题」的区别
 *
 * | | 做题（复习） | 模拟考试 |
 * | --- | --- | --- |
 * | 目的 | 记住（间隔复习） | **检验**（一次考完看分数） |
 * | 判分 | 每题即时揭晓 | 交卷后统一批改 |
 * | 影响 | 改复习进度 | **不改**复习进度 |
 * | 计时 | 每题单独计时 | 整卷倒计时 |
 *
 * 「不改复习进度」是刻意的：考试时紧张、状态不好，
 * 用它去改间隔会把复习计划带偏。考试成绩单独记录，两者互不干扰。
 *
 * ## 为什么抽题要洗牌
 *
 * 按题组顺序出卷，用户会记住「第 3 题是那道填空题」，
 * 下次考同一份资料时位置不变，分数就失真了。
 * 用 Fisher–Yates（项目里已经因为这个理由用过两次）。
 */

import type { ExamAnswer, ExamAttempt, Question } from '@/core/model.ts';
import type { StorageAdapter } from '@/core/storage/types.ts';
import { newId, nowIso } from '@/core/id.ts';

/** 出卷参数 */
export interface BuildExamInput {
  /** 候选题目（调用方从已发布题组里取） */
  pool: Question[];
  /** 抽多少道；超过池子大小时全用 */
  count: number;
  /** 试卷名 */
  title: string;
}

export class ExamService {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * 出卷：从池子里随机抽若干道。
   *
   * 只抽客观题（单选/多选/填空）：问答类判分需要人工自评，
   * 放进模拟考会让「分数」这个数字失去意义。
   */
  buildPaper(input: BuildExamInput): Question[] {
    const answerable = input.pool.filter((q) => q.kind !== 'essay');
    const pool = [...answerable];

    /* Fisher–Yates：不用 sort(() => Math.random() - 0.5)，那个分布不均匀 */
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }

    return pool.slice(0, Math.max(0, Math.min(input.count, pool.length)));
  }

  /**
   * 判分。
   *
   * 与 `ReviewPage` 用的是同一套 `isCorrect` 语义（通过调用方传入判定函数，
   * 避免这个服务反向依赖 v2 的卡片层）。
   */
  grade(question: Question, response: string, isCorrectFn: (q: Question, given: string) => boolean): ExamAnswer {
    return {
      questionId: question.id,
      response,
      correct: isCorrectFn(question, response),
    };
  }

  /** 交卷：算分并落库 */
  async submit(input: {
    title: string;
    questions: Question[];
    answers: ExamAnswer[];
    startedAt: string;
    limitSec: number;
    usedSec: number;
    timedOut: boolean;
  }): Promise<ExamAttempt> {
    /*
     * 逐题对齐：用户可能中途跳过某题，所以不能假设 answers 的长度
     * 等于 questions 的长度。按 questionId 建表，缺的补「未作答」。
     */
    const byId = new Map(input.answers.map((a) => [a.questionId, a]));
    const aligned: ExamAnswer[] = input.questions.map(
      (q) =>
        byId.get(q.id) ?? {
          questionId: q.id,
          response: '',
          correct: false,
        },
    );

    const correct = aligned.filter((a) => a.correct === true).length;

    const attempt: ExamAttempt = {
      id: newId('exam'),
      title: input.title,
      questionIds: input.questions.map((q) => q.id),
      startedAt: input.startedAt,
      finishedAt: nowIso(),
      limitSec: input.limitSec,
      usedSec: Math.max(0, Math.round(input.usedSec)),
      answers: aligned,
      correct,
      total: input.questions.length,
      timedOut: input.timedOut,
    };

    await this.storage.put('examAttempts', attempt);
    return attempt;
  }

  /** 全部考试记录，最近的在前面 */
  async list(): Promise<ExamAttempt[]> {
    const all = await this.storage.getAll('examAttempts');
    return all.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  }

  async get(id: string): Promise<ExamAttempt | null> {
    return this.storage.get('examAttempts', id);
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove('examAttempts', id);
  }

  /**
   * 成绩趋势：最近 N 次的得分率。
   *
   * 只取真实举行过的考试（total > 0）——
   * 0 题的空卷算出的 0% 会把趋势线砸到底，那没有意义。
   */
  static trend(attempts: ExamAttempt[], limit = 10): { at: string; rate: number }[] {
    return attempts
      .filter((a) => a.total > 0)
      .slice(0, limit)
      .map((a) => ({ at: a.finishedAt, rate: a.correct / a.total }))
      .reverse();
  }
}
