import { describe, expect, it } from 'vitest';
import {
  answerQuestion,
  currentQuestionId,
  judgeAnswer,
  nextQuestion,
  normalizeAnswer,
  overrideAnswer,
  prevQuestion,
  selfTestScore,
  startSelfTest,
} from './self-test.ts';
import type { Question } from '@/core/model.ts';

/**
 * 复习巩固页的自测判定（2026-11-09）。
 *
 * 这一层最容易出**看不出**的错：判错一道题，用户会以为是自己记错了，
 * 而不是软件判错了。所以每条规则都要钉死。
 */

function q(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    deckId: 'd1',
    kind: 'single',
    prompt: 'p',
    options: [
      { key: 'A', text: 'a' },
      { key: 'B', text: 'b' },
    ],
    answer: 'A',
    explanation: '',
    anchors: [],
    knowledgePointId: null,
    cognitiveLevel: 'understand',
    topic: null,
    order: 1,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    ...over,
  } as Question;
}

describe('normalizeAnswer', () => {
  it('去首尾空白并忽略大小写', () => {
    expect(normalizeAnswer('  Apple  ')).toBe('apple');
  });

  it('全角转半角（用户复制粘贴常见）', () => {
    expect(normalizeAnswer('Ａ')).toBe('a');
    expect(normalizeAnswer('（信号）')).toBe('(信号)');
  });

  it('去掉包裹的引号', () => {
    expect(normalizeAnswer('"信号"')).toBe('信号');
    expect(normalizeAnswer('「信号」')).toBe('信号');
  });

  it('去掉句末标点', () => {
    expect(normalizeAnswer('信号。')).toBe('信号');
    expect(normalizeAnswer('周期信号，')).toBe('周期信号');
  });

  it('折叠内部多余空白', () => {
    expect(normalizeAnswer('a   b')).toBe('a b');
  });

  it('非字符串安全返回空串', () => {
    expect(normalizeAnswer(null as never)).toBe('');
    expect(normalizeAnswer(undefined as never)).toBe('');
  });
});

describe('judgeAnswer 单选', () => {
  it('答对为 true、答错为 false', () => {
    expect(judgeAnswer(q({ kind: 'single', answer: 'A' }), 'A')).toBe(true);
    expect(judgeAnswer(q({ kind: 'single', answer: 'A' }), 'B')).toBe(false);
  });

  it('小写也认', () => {
    expect(judgeAnswer(q({ kind: 'single', answer: 'A' }), 'a')).toBe(true);
  });

  it('空答案算错（不猜）', () => {
    expect(judgeAnswer(q({ kind: 'single', answer: 'A' }), '')).toBe(false);
    expect(judgeAnswer(q({ kind: 'single', answer: 'A' }), '   ')).toBe(false);
  });
});

describe('judgeAnswer 多选', () => {
  const multi = q({ kind: 'multiple', answer: 'A,C' });

  it('顺序不同也算对（勾选顺序不该影响判定）', () => {
    expect(judgeAnswer(multi, 'C,A')).toBe(true);
    expect(judgeAnswer(multi, 'A,C')).toBe(true);
  });

  it('少选算错', () => {
    expect(judgeAnswer(multi, 'A')).toBe(false);
  });

  it('多选算错', () => {
    expect(judgeAnswer(multi, 'A,B,C')).toBe(false);
  });

  it('空格/逗号分隔都认', () => {
    expect(judgeAnswer(multi, 'A C')).toBe(true);
    expect(judgeAnswer(multi, 'c , a')).toBe(true);
  });

  it('重复同一个 key 不影响（集合比较）', () => {
    expect(judgeAnswer(multi, 'A,A,C')).toBe(true);
  });
});

describe('judgeAnswer 填空', () => {
  it('忽略引号与句号', () => {
    const blank = q({ kind: 'blank', answer: '周期信号' });
    expect(judgeAnswer(blank, '"周期信号"')).toBe(true);
    expect(judgeAnswer(blank, '周期信号。')).toBe(true);
  });

  it('答错为 false', () => {
    expect(judgeAnswer(q({ kind: 'blank', answer: '周期信号' }), '非周期')).toBe(false);
  });
});

describe('judgeAnswer 问答', () => {
  it('返回 null（无法自动判，交给用户自评）', () => {
    expect(judgeAnswer(q({ kind: 'essay', answer: '参考答案' }), '随便写的')).toBeNull();
  });

  it('问答即使答了空也返回 null —— 不擅自判错', () => {
    /*
     * 这条很重要：如果空答案判 false，用户点开问答看到「错」会很困惑
     * （他可能还没答）。null 表示「等你自己说」。
     */
    expect(judgeAnswer(q({ kind: 'essay', answer: 'x' }), '')).toBeNull();
  });
});

describe('judgeAnswer 判断题', () => {
  it('勾选项 T/F 判定', () => {
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'T' }), 'T')).toBe(true);
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'T' }), 'F')).toBe(false);
  });

  it('认「对/错」这类中文写法', () => {
    /*
     * 判断题的答案存 T/F，但用户很可能在输入框里敲「对」。
     * 不认的话判断题会被判得一塌糊涂，而用户以为自己记错了。
     */
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'T' }), '对')).toBe(true);
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'T' }), '错')).toBe(false);
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'F' }), '错误')).toBe(true);
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'F' }), 'false')).toBe(true);
  });

  it('认不出时判错，不猜', () => {
    expect(judgeAnswer(q({ kind: 'truefalse', answer: 'T' }), '也许吧')).toBe(false);
  });
});

describe('会话流转', () => {
  it('startSelfTest 从第一题开始、无作答', () => {
    const s = startSelfTest(['a', 'b', 'c']);
    expect(s.index).toBe(0);
    expect(currentQuestionId(s)).toBe('a');
    expect(s.answers).toEqual({});
  });

  it('next/prev 在边界返回 null（不改状态）', () => {
    const s = startSelfTest(['a', 'b']);
    expect(prevQuestion(s)).toBeNull();
    const s2 = nextQuestion(s)!;
    expect(currentQuestionId(s2)).toBe('b');
    expect(nextQuestion(s2)).toBeNull();
  });

  it('answerQuestion 记录判定结果', () => {
    const s = startSelfTest(['q1']);
    const s2 = answerQuestion(s, q({ kind: 'single', answer: 'A' }), 'A');
    expect(s2.answers.q1!.correct).toBe(true);
  });

  it('overrideAnswer 改判（问答自评 / 纠正）', () => {
    const s = startSelfTest(['q1']);
    const s2 = answerQuestion(s, q({ kind: 'essay', answer: 'x' }), '我的答案');
    expect(s2.answers.q1!.correct).toBeNull();
    const s3 = overrideAnswer(s2, 'q1', true);
    expect(s3.answers.q1!.correct).toBe(true);
  });

  it('overrideAnswer 对没作答的题不动（不凭空造记录）', () => {
    const s = startSelfTest(['q1']);
    expect(overrideAnswer(s, 'q1', true)).toBe(s);
  });
});

describe('selfTestScore', () => {
  it('统计答对/答错/未答', () => {
    let s = startSelfTest(['q1', 'q2', 'q3']);
    s = answerQuestion(s, q({ id: 'q1', kind: 'single', answer: 'A' }), 'A');
    s = answerQuestion(s, q({ id: 'q2', kind: 'single', answer: 'A' }), 'B');

    const sc = selfTestScore(s);
    expect(sc.answered).toBe(2);
    expect(sc.correct).toBe(1);
    expect(sc.wrong).toBe(1);
    expect(sc.unanswered).toBe(1);
    expect(sc.accuracy).toBeCloseTo(0.5);
  });

  it('完全没作答时正确率是 null，不是 0', () => {
    /*
     * 显示 0% 会让用户以为「我全错了」，而实际是他还没开始。
     * 这类「假数据」是项目反复强调要避免的。
     */
    const sc = selfTestScore(startSelfTest(['q1', 'q2']));
    expect(sc.accuracy).toBeNull();
    expect(sc.answered).toBe(0);
  });

  it('只有待自评的问答时，正确率是 null（分子分母都为 0）', () => {
    let s = startSelfTest(['q1']);
    s = answerQuestion(s, q({ id: 'q1', kind: 'essay', answer: 'x' }), '我的答案');
    const sc = selfTestScore(s);
    expect(sc.answered).toBe(1);
    expect(sc.accuracy).toBeNull();
  });

  it('空队列不炸', () => {
    const sc = selfTestScore(startSelfTest([]));
    expect(sc.unanswered).toBe(0);
    expect(sc.accuracy).toBeNull();
    expect(currentQuestionId(startSelfTest([]))).toBeNull();
  });
});
