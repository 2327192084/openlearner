/**
 * 方案 3：自评题型进考场（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「我选方案3（计算题和问答题都放进考场），但是除了自评还可以加入
 *   ai 评分，主要是 ai 评分，要是用户觉得评分不对可以自己再评。」
 *
 * ## 这里钉什么
 *
 * 1. **出卷不再过滤自评题型** —— 23 题就该能抽到 23 题
 * 2. **交卷时自评题标「待评」，不是「答错」** —— 这条最关键：
 *    判成 false 会先扣一笔冤枉分，用户看到「答错」才被要求自评，
 *    与事实不符
 * 3. **pendingCount 算得对** —— 界面据此说「还有 N 题没评」
 * 4. **regradeAnswer 能落库** —— AI 评或用户改都要写回，
 *    否则评到一半关软件就全丢
 * 5. **重算 correct / pendingCount** —— 改一道题的结论要影响整卷统计
 */

import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { ExamService } from './exam.ts';
import type { Question } from './model.ts';

const mkQ = (id: string, kind: Question['kind']): Question =>
  ({
    id,
    deckId: 'deck_1',
    kind,
    prompt: `题目 ${id}`,
    answer: '参考答案',
    explanation: '',
    options: null,
    createdAt: '',
    updatedAt: '',
  }) as unknown as Question;

/** 自动判分：全部判对（简化，本测试不关心对错逻辑） */
const alwaysRight = () => true;

describe('方案 3：自评题型进考场', () => {
  it('★ 出卷不再过滤自评题型（计算/问答也能抽到）', () => {
    const exam = new ExamService(new MemoryStorage());
    const pool = [
      mkQ('q1', 'single'),
      mkQ('q2', 'multiple'),
      mkQ('q3', 'essay'),
      mkQ('q4', 'calc'),
    ];

    const paper = exam.buildPaper({ pool, count: 10 } as never);

    /* 4 道题全在 —— 改之前只有 q1/q2 能进 */
    expect(paper).toHaveLength(4);
    const kinds = paper.map((q) => q.kind).sort();
    expect(kinds).toEqual(['calc', 'essay', 'multiple', 'single']);
  });

  it('★ 交卷时自评题标「待评」，**不是答错**', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const questions = [mkQ('q1', 'single'), mkQ('q2', 'essay')];

    const attempt = await exam.submit({
      title: '测试卷',
      questions,
      answers: [
        exam.grade(questions[0]!, 'A', alwaysRight),
        exam.grade(questions[1]!, '我的回答', alwaysRight),
      ],
      startedAt: new Date().toISOString(),
      limitSec: 0,
      usedSec: 10,
      timedOut: false,
    });

    const single = attempt.answers.find((a) => a.questionId === 'q1')!;
    const essay = attempt.answers.find((a) => a.questionId === 'q2')!;

    expect(single.correct).toBe(true);
    expect(single.gradedBy).toBe('auto');

    /*
     * 核心断言：essay 是 null（待评），不是 false（答错）。
     * 若改成 false 会先扣一笔冤枉分 —— 用户看到「答错」才被要求自评。
     */
    expect(essay.correct).toBeNull();
    expect(essay.gradedBy).toBe('pending');
  });

  it('★ pendingCount 数得对（界面据此说「还有 N 题没评」）', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const questions = [
      mkQ('q1', 'single'),
      mkQ('q2', 'essay'),
      mkQ('q3', 'calc'),
    ];

    const attempt = await exam.submit({
      title: '测试卷',
      questions,
      answers: [
        exam.grade(questions[0]!, 'A', alwaysRight),
        exam.grade(questions[1]!, 'x', alwaysRight),
        exam.grade(questions[2]!, 'y', alwaysRight),
      ],
      startedAt: new Date().toISOString(),
      limitSec: 0,
      usedSec: 5,
      timedOut: false,
    });

    expect(attempt.pendingCount).toBe(2);
    expect(attempt.correct).toBe(1);
    expect(attempt.total).toBe(3);
  });

  it('未作答的自评题也是「待评」，不是答错（用户可能想交卷后补评）', async () => {
    const exam = new ExamService(new MemoryStorage());
    const questions = [mkQ('q1', 'essay')];

    const attempt = await exam.submit({
      title: '测试卷',
      questions,
      /* 完全不传 answers —— 模拟「跳过没做」 */
      answers: [],
      startedAt: new Date().toISOString(),
      limitSec: 0,
      usedSec: 3,
      timedOut: false,
    });

    expect(attempt.answers[0]!.correct).toBeNull();
    expect(attempt.pendingCount).toBe(1);
  });

  it('未作答的自动题型算答错（没选就是没答对）', async () => {
    const exam = new ExamService(new MemoryStorage());
    const questions = [mkQ('q1', 'single')];

    const attempt = await exam.submit({
      title: '测试卷',
      questions,
      answers: [],
      startedAt: new Date().toISOString(),
      limitSec: 0,
      usedSec: 3,
      timedOut: false,
    });

    expect(attempt.answers[0]!.correct).toBe(false);
    expect(attempt.answers[0]!.gradedBy).toBe('auto');
  });
});

describe('regradeAnswer：AI 评 / 用户改都要落库', () => {
  const seed = async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const questions = [mkQ('q1', 'single'), mkQ('q2', 'essay')];
    const attempt = await exam.submit({
      title: '测试卷',
      questions,
      answers: [
        exam.grade(questions[0]!, 'A', alwaysRight),
        exam.grade(questions[1]!, '我的回答', alwaysRight),
      ],
      startedAt: new Date().toISOString(),
      limitSec: 0,
      usedSec: 10,
      timedOut: false,
    });
    return { storage, exam, attempt };
  };

  it('★ AI 判对 → 落库，correct/pendingCount 重算', async () => {
    const { exam, attempt } = await seed();

    const next = await exam.regradeAnswer(attempt.id, 'q2', {
      correct: true,
      gradedBy: 'ai',
      aiGrade: { coveredCount: 3, total: 3, level: 'correct', comment: '答得完整', points: [] },
      aiComment: '答得完整',
    });

    expect(next).not.toBeNull();
    const q2 = next!.answers.find((a) => a.questionId === 'q2')!;
    expect(q2.correct).toBe(true);
    expect(q2.gradedBy).toBe('ai');
    expect(q2.aiComment).toBe('答得完整');

    /* 整卷统计要跟着变 */
    expect(next!.correct).toBe(2);
    expect(next!.pendingCount).toBe(0);

    /* 真的写进库了（不是只改内存） */
    const reread = await exam.get(attempt.id);
    expect(reread!.correct).toBe(2);
    expect(reread!.pendingCount).toBe(0);
  });

  it('★ 用户覆盖 AI 的结论 → gradedBy 变 self，但保留 AI 当时的说法', async () => {
    const { exam, attempt } = await seed();

    /* 先让 AI 判错 */
    await exam.regradeAnswer(attempt.id, 'q2', {
      correct: false,
      gradedBy: 'ai',
      aiGrade: { coveredCount: 1, total: 3, level: 'wrong', comment: '漏了关键步骤', points: [] },
      aiComment: '漏了关键步骤',
    });

    /* 用户觉得不对，改成对 */
    const next = await exam.regradeAnswer(attempt.id, 'q2', { correct: true, gradedBy: 'self' });

    const q2 = next!.answers.find((a) => a.questionId === 'q2')!;
    expect(q2.correct).toBe(true);
    expect(q2.gradedBy).toBe('self');
    /*
     * AI 的点评要留着 —— 事后想对照「AI 当时说了什么」还有据可查。
     */
    expect(q2.aiComment).toBe('漏了关键步骤');
  });

  it('找不到卷子时返回 null（不抛错）', async () => {
    const exam = new ExamService(new MemoryStorage());
    const r = await exam.regradeAnswer('nope', 'q1', { correct: true, gradedBy: 'self' });
    expect(r).toBeNull();
  });

  it('★ 只改目标那一题，别的题不受影响', async () => {
    const { exam, attempt } = await seed();
    const before = attempt.answers.find((a) => a.questionId === 'q1')!;

    const next = await exam.regradeAnswer(attempt.id, 'q2', { correct: false, gradedBy: 'self' });

    const after = next!.answers.find((a) => a.questionId === 'q1')!;
    expect(after.correct).toBe(before.correct);
    expect(after.gradedBy).toBe(before.gradedBy);
  });
});

describe('趋势：待评的题不进分母（2026-11-17 方案 3）', () => {
  const mkAttempt = (correct: number, total: number, pendingCount?: number) =>
    ({
      id: `a_${correct}_${total}_${pendingCount ?? 'x'}`,
      title: 't',
      questionIds: [],
      startedAt: '',
      finishedAt: '2026-11-17T00:00:00Z',
      limitSec: 0,
      usedSec: 10,
      answers: [],
      correct,
      total,
      ...(pendingCount !== undefined ? { pendingCount } : {}),
      timedOut: false,
    }) as never;

  it('★ 还有待评题时，分母用「已评题数」而不是总题数', () => {
    /* 23 题里 4 题没评、答对 19 —— 真实正确率是 100%，不是 83% */
    const trend = ExamService.trend([mkAttempt(19, 23, 4)]);
    expect(trend).toHaveLength(1);
    expect(trend[0]!.rate).toBe(1);
  });

  it('★ 全部待评的卷子跳过（不画一个 0% 把线砸到底）', () => {
    const trend = ExamService.trend([mkAttempt(0, 5, 5)]);
    expect(trend).toHaveLength(0);
  });

  it('没有待评字段（旧数据）时行为不变', () => {
    const trend = ExamService.trend([mkAttempt(3, 4)]);
    expect(trend[0]!.rate).toBe(0.75);
  });
});
/**
 * 试卷错题进错题本（2026-11-17 用户要求）。
 *
 * 用户原话：「在错题巩固栏目增加试卷的错题」。
 *
 * 实现方式是写 `reviewLogs`（kind: 'question'、grade: 'again'）——
 * 错题本页读的就是那里，所以不用改错题本一行代码。
 */
describe('试卷错题进错题本', () => {
  const mkQ2 = (id: string, kind: Question['kind']): Question =>
    ({ id, deckId: 'd1', kind, prompt: `题 ${id}`, answer: 'A', explanation: '', options: null, createdAt: '', updatedAt: '' }) as never;

  const readLogs = async (storage: MemoryStorage) =>
    (await storage.getAll('reviewLogs')) as { id: string; cardId: string; kind: string; grade: string }[];

  it('★ 答错的题会进错题本（写一条 grade=again 的 reviewLog）', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const questions = [mkQ2('q1', 'single'), mkQ2('q2', 'single')];

    await exam.submit({
      title: 't',
      questions,
      answers: [
        { questionId: 'q1', response: 'A', correct: true, gradedBy: 'auto' },
        { questionId: 'q2', response: 'B', correct: false, gradedBy: 'auto' },
      ],
      startedAt: '2026-11-17T00:00:00Z',
      limitSec: 0,
      usedSec: 10,
      timedOut: false,
    });

    const logs = await readLogs(storage);
    /* 只记答错的 q2，答对的 q1 不记 */
    expect(logs).toHaveLength(1);
    expect(logs[0]!.cardId).toBe('q2');
    expect(logs[0]!.grade).toBe('again');
    expect(logs[0]!.kind).toBe('question');
  });

  it('★ 待评的题**不**记（还没评就说人家错，不公平）', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    await exam.submit({
      title: 't',
      questions: [mkQ2('e1', 'essay')],
      answers: [],
      startedAt: '2026-11-17T00:00:00Z',
      limitSec: 0,
      usedSec: 5,
      timedOut: false,
    });

    expect(await readLogs(storage)).toHaveLength(0);
  });

  it('★ 待评的题后来被评成错 → 补记进错题本', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const attempt = await exam.submit({
      title: 't',
      questions: [mkQ2('e1', 'essay')],
      answers: [],
      startedAt: '2026-11-17T00:00:00Z',
      limitSec: 0,
      usedSec: 5,
      timedOut: false,
    });
    expect(await readLogs(storage)).toHaveLength(0);

    await exam.regradeAnswer(attempt.id, 'e1', { correct: false, gradedBy: 'self' });

    const logs = await readLogs(storage);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.cardId).toBe('e1');
  });

  it('★ 幂等：反复评成错不会把错题次数刷上去', async () => {
    const storage = new MemoryStorage();
    const exam = new ExamService(storage);
    const attempt = await exam.submit({
      title: 't',
      questions: [mkQ2('e1', 'essay')],
      answers: [],
      startedAt: '2026-11-17T00:00:00Z',
      limitSec: 0,
      usedSec: 5,
      timedOut: false,
    });

    await exam.regradeAnswer(attempt.id, 'e1', { correct: false, gradedBy: 'self' });
    await exam.regradeAnswer(attempt.id, 'e1', { correct: false, gradedBy: 'ai' });
    await exam.regradeAnswer(attempt.id, 'e1', { correct: false, gradedBy: 'self' });

    /* 只有一条 —— id 是 exam:<attemptId>:<questionId>，天然去重 */
    expect(await readLogs(storage)).toHaveLength(1);
  });
});
