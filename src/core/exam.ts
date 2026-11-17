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
import { isAutoGraded } from '@/core/questions/kinds.ts';

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
   * ## 2026-11-17 方案 3：自评题型也进考场
   *
   * 用户原话：「我选方案3（计算题和问答题都放进考场），但是除了自评
   * 还可以加入 ai 评分，主要是 ai 评分，要是用户觉得评分不对可以自己再评。」
   *
   * 所以这里**不再按 `isAutoGraded` 过滤** —— 全部题型都能进考场。
   *
   * ## 但「能进考场」不等于「能自动判分」
   *
   * 自评题型交卷时没有结论，要标成「待评」等 AI / 用户来评。
   * 因此 `submit()` 会算出 `pendingCount`，界面据此说清
   * 「还有 N 题没评」，而不是拿半截分数当最终成绩。
   *
   * ## 历史教训（保留，别改回去）
   *
   * 原来这里写 `q.kind !== 'essay'`，2026-11-12 加计算题时
   * 计算题混进考场、交卷时被当成简答走字符串相似度判分。
   * 那次教训是「别写死题型」，不是「别让自评题进考场」——
   * 现在既然要它们进来，就**必须**同时给出「待评」这条状态，
   * 否则又回到「拿错误的方式判分」。
   */
  buildPaper(input: BuildExamInput): Question[] {
    const pool = [...input.pool];

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
   *
   * 自评题型（计算/问答）**不在这里判**：它们返回 `correct: null` +
   * `gradedBy: 'pending'`，等 AI 评分或用户自评。
   */
  grade(question: Question, response: string, isCorrectFn: (q: Question, given: string) => boolean): ExamAnswer {
    /*
     * 自评题型：交卷那一刻没有结论。
     *
     * ⚠️ 不能返回 `correct: false` —— 那会先扣一笔冤枉分，
     * 用户看到「答错」再被要求自评，体验与事实都不对。
     */
    if (!isAutoGraded(question.kind)) {
      return {
        questionId: question.id,
        response,
        correct: null,
        gradedBy: 'pending',
        aiGrade: null,
        aiComment: null,
      };
    }
    return {
      questionId: question.id,
      response,
      correct: isCorrectFn(question, response),
      gradedBy: 'auto',
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
    const aligned: ExamAnswer[] = input.questions.map((q) => {
      const existing = byId.get(q.id);
      if (existing) return existing;

      /*
       * 没作答的题：自评题型仍是「待评」，自动题型算错。
       *
       * 为什么不一律算错：一道问答/计算题没写，用户可能就是想
       * 交卷后再补评 —— 直接判错会让他连补评的机会都没有。
       * 而自动题型确实错了（没选就是没答对）。
       *
       * ⚠️ `response` 必须显式给空串。第一版用 `as ExamAnswer` 断言
       * 绕过了类型检查，漏了它 —— 结果补位题的 response 是 undefined，
       * 界面显示「你的答案：undefined」。类型断言不等于不用填字段。
       */
      const auto = isAutoGraded(q.kind);
      return {
        questionId: q.id,
        response: '',
        correct: auto ? false : null,
        gradedBy: auto ? 'auto' : 'pending',
      };
    });

    /*
     * 待评题数（2026-11-17 方案 3）。
     *
     * `correct === null` 就是「还没评」。成绩页据此说
     * 「还有 N 题没评」，统计聚合据此跳过未评完的卷子。
     */
    const pendingCount = aligned.filter((a) => a.correct === null).length;

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
      pendingCount,
      timedOut: input.timedOut,
    };

    await this.storage.put('examAttempts', attempt);

    /*
     * 交卷时把确定答错的题记进错题本（2026-11-17 用户要求：
     * 「在错题巩固栏目增加试卷的错题」）。
     *
     * 放在落库之后：先保证考试记录本身存好，再去做附加动作。
     * 出错也不该让交卷失败 —— 用户考完点交卷，最怕的是「没交上」。
     */
    try {
      await this.recordWrongAnswers(attempt);
    } catch {
      /* 记错题失败不影响交卷；考试记录已经存下了 */
    }

    return attempt;
  }

  /**
   * 把这份卷子的错题记进「错题本」（2026-11-17 用户要求）。
   *
   * 用户原话：「在错题巩固栏目增加试卷的错题」。
   *
   * ## 为什么写 `reviewLogs` 而不是另建一张表
   *
   * 「错题与待巩固」页读的是 `reviewService.wrongCardsDetailed()`，
   * 它扫的就是 `reviewLogs` 里 `kind === 'question'` 且 `grade === 'again'`
   * 的记录。写进那里，试卷错题**自动**出现在错题本里，不用改错题本一行代码。
   *
   * 另建一张表的话，错题本要同时读两处并去重、排序 ——
   * 那是将来必然漂移的地方（本项目的老毛病）。
   *
   * ## 只记「确定答错」的题
   *
   * - `correct === false` → 记一条 `again`
   * - `correct === null`（待评）→ **不记**。还没评就说人家错，不公平；
   *   等 AI 或用户评完再决定（`regradeAnswer` 那里会补记）。
   * - `correct === true` → 不记
   *
   * ## 幂等
   *
   * id 用 `exam:<attemptId>:<questionId>` —— 同一场考试重复调用只留一条，
   * 不会因为用户反复点「重新评分」把错题次数刷上去。
   */
  async recordWrongAnswers(attempt: ExamAttempt): Promise<number> {
    const wrong = attempt.answers.filter((a) => a.correct === false);
    if (wrong.length === 0) return 0;

    const day = attempt.finishedAt.slice(0, 10);
    let n = 0;
    for (const a of wrong) {
      const id = `exam:${attempt.id}:${a.questionId}`;
      const existing = await this.storage.get('reviewLogs', id);
      /* 已经记过就不重复记（幂等） */
      if (existing) continue;
      await this.storage.put('reviewLogs', {
        id,
        cardId: a.questionId,
        kind: 'question',
        grade: 'again',
        day,
        /*
         * 间隔字段给 0：考试错题不参与间隔排期推算，
         * 它只是一个「这里错了」的记录。错题本读的是 grade，
         * 排期读的是别处（做题页写的那些）。
         */
        prevIntervalDays: 0,
        newIntervalDays: 0,
        at: attempt.finishedAt,
      });
      n += 1;
    }
    return n;
  }

  /**
   * 更新某一道题的评分结论（2026-11-17 方案 3）。
   *
   * ## 谁调它
   *
   * - AI 评分完成后（`gradedBy: 'ai'`）
   * - 用户覆盖 AI 的结论时（`gradedBy: 'self'`）
   *
   * ## 为什么必须重新落库而不是只改界面状态
   *
   * 用户可能评分到一半关掉软件。只改内存的话，已花掉的 AI 调用
   * 和用户的手动判断全丢，下次打开又得重评一遍。
   *
   * @returns 更新后的整份卷子；找不到返回 null
   */
  async regradeAnswer(
    attemptId: string,
    questionId: string,
    patch: {
      correct: boolean;
      gradedBy: 'ai' | 'self';
      aiGrade?: ExamAnswer['aiGrade'];
      aiComment?: string | null;
    },
  ): Promise<ExamAttempt | null> {
    const attempt = await this.storage.get('examAttempts', attemptId);
    if (!attempt) return null;

    const answers = attempt.answers.map((a) =>
      a.questionId === questionId
        ? {
            ...a,
            correct: patch.correct,
            gradedBy: patch.gradedBy,
            /*
             * AI 结果保留下来了：用户改成 'self' 时也要留着
             * 「AI 当时怎么说的」，否则事后无从对照。
             */
            ...(patch.aiGrade !== undefined ? { aiGrade: patch.aiGrade } : {}),
            ...(patch.aiComment !== undefined ? { aiComment: patch.aiComment } : {}),
          }
        : a,
    );

    const next: ExamAttempt = {
      ...attempt,
      answers,
      correct: answers.filter((a) => a.correct === true).length,
      pendingCount: answers.filter((a) => a.correct === null).length,
    };
    await this.storage.put('examAttempts', next);

    /*
     * 评成「错」时补记进错题本（2026-11-17）。
     *
     * 交卷时待评的题还没结论，所以 `recordWrongAnswers` 跳过了它们。
     * 现在 AI 或用户评成了错，就该出现在错题本里 ——
     * 否则「待评的题答错了却永远进不了错题本」。
     *
     * 幂等由 `recordWrongAnswers` 里的 id 保证，评几次都只有一条。
     */
    if (patch.correct === false) {
      await this.recordWrongAnswers(next);
    }

    return next;
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
   *
   * ## 待评的题要从分母里去掉（2026-11-17 方案 3）
   *
   * 自评题型进考场后，一份卷子可能在交卷时还有几题「待评」
   * （`pendingCount > 0`）。此时 `correct / total` 会**低估**得分率 ——
   * 4 道题还没评，就把分母算成 23，分数看起来像考砸了。
   *
   * 所以分母改成「已评题数」：
   *  - 全评完 → 与原来完全一致
   *  - 全部待评（已评 0 题）→ **跳过这条**，不给趋势点
   *    （否则会画一个 0% 把线砸下去，和空卷同理）
   */
  static trend(attempts: ExamAttempt[], limit = 10): { at: string; rate: number }[] {
    return attempts
      .filter((a) => a.total > 0)
      .filter((a) => a.total - (a.pendingCount ?? 0) > 0)
      .slice(0, limit)
      .map((a) => {
        const graded = a.total - (a.pendingCount ?? 0);
        return { at: a.finishedAt, rate: a.correct / graded };
      })
      .reverse();
  }
}
