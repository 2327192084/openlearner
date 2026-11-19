import { describe, expect, it } from 'vitest';
import {
  countBySource,
  explainToRows,
  filterAnswerRows,
  mergeAnswerRows,
  oralToRows,
  type OralLike,
} from './answer-record.ts';

/**
 * 「答疑记录」统一层测试。
 *
 * ## 这一层最容易犯的错
 *
 * 把两种记录合并时「顺手丢字段」—— 例如把提问记录的「判定类别」
 * （记错 / 理解偏）丢了，或者把讲解的「讲法」丢了。
 * 那些字段正是用户回看时的关键信息。
 *
 * 下面逐条钉住「每种来源该带的都带上了」。
 */

const ORAL: OralLike = {
  id: 'oral_1',
  createdAt: '2026-11-19T10:00:00.000Z',
  scopeLabel: '第 9 页 · 1.2 离散时间信号',
  question: '离散时间信号的定义是什么？',
  answer: '就是只在离散时刻有值的信号',
  verdict: 'memory',
  explanation: '你漏了「离散时刻」这个限定',
  correction: '离散时间信号：只在离散时刻取值的信号。',
  sourceId: 'src_a',
  page: 9,
};

const NOTES = [
  {
    question: { id: 'q_a', prompt: '下列各组函数中，表示同一个函数的是？\n（多行题干）' },
    notes: [
      {
        id: 'exp_1',
        given: 'B',
        styleId: 'stepwise',
        crux: '只看代数变形，忘了检查定义域',
        body: '第一段\n\n第二段',
        nextStep: '先分别求定义域',
        createdAt: '2026-11-19T11:00:00.000Z',
      },
      {
        id: 'exp_2',
        given: 'A',
        styleId: 'compare',
        crux: '误以为 √(x²) = x',
        body: '对比内容',
        nextStep: null,
        createdAt: '2026-11-19T09:00:00.000Z',
      },
    ],
  },
];

describe('oralToRows：提问式复习', () => {
  it('带上判定类别（记错 / 理解偏），不能丢', () => {
    const [row] = oralToRows([ORAL]);
    expect(row.badge).toBe('记错了');
    expect(oralToRows([{ ...ORAL, verdict: 'understanding' }])[0].badge).toBe('理解偏了');
    expect(oralToRows([{ ...ORAL, verdict: 'correct' }])[0].badge).toBe('答对');
  });

  it('标题含提问范围与问题（用户靠它回忆「问的是哪段」）', () => {
    const [row] = oralToRows([ORAL]);
    expect(row.title).toContain('第 9 页');
    expect(row.title).toContain('离散时间信号');
  });

  it('保留「我的回答」与「纠正」', () => {
    const [row] = oralToRows([ORAL]);
    expect(row.asked).toBe('就是只在离散时刻有值的信号');
    expect(row.extra).toContain('只在离散时刻取值');
  });

  it('保留跳回原文的位置', () => {
    const [row] = oralToRows([ORAL]);
    expect(row.sourceId).toBe('src_a');
    expect(row.page).toBe(9);
    expect(row.questionId).toBeNull();
  });

  it('没回答时 asked 为 null（不是空字符串）', () => {
    expect(oralToRows([{ ...ORAL, answer: '' }])[0].asked).toBeNull();
  });
});

describe('explainToRows：答错补充讲解', () => {
  it('**一条讲解一行**（同一题多条要展开，不能合并成一条）', () => {
    const rows = explainToRows(NOTES);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(['explain-exp_1', 'explain-exp_2']);
  });

  it('标题用题干（用户回忆「哪道题」比「哪种讲法」更有用）', () => {
    const [row] = explainToRows(NOTES);
    expect(row.title).toBe('下列各组函数中，表示同一个函数的是？');
    /* 多行题干只取第一行 */
    expect(row.title).not.toContain('多行题干');
  });

  it('「我问了什么」= 我当时答错了什么', () => {
    const rows = explainToRows(NOTES);
    expect(rows[0].asked).toBe('我答的是「B」');
    expect(rows[1].asked).toBe('我答的是「A」');
  });

  it('正文 = 错在哪 + 讲解（两段都要，不能只留正文）', () => {
    const [row] = explainToRows(NOTES);
    expect(row.answered).toContain('只看代数变形');
    expect(row.answered).toContain('第一段');
  });

  it('保留「下一步」；没有时为 null', () => {
    const rows = explainToRows(NOTES);
    expect(rows[0].extra).toBe('先分别求定义域');
    expect(rows[1].extra).toBeNull();
  });

  it('带上题目 id（点进去要回那道题）', () => {
    expect(explainToRows(NOTES)[0].questionId).toBe('q_a');
    expect(explainToRows(NOTES)[0].sourceId).toBeNull();
  });

  it('没有讲解的题不产生行', () => {
    expect(explainToRows([{ question: NOTES[0]!.question, notes: [] }])).toHaveLength(0);
  });
});

describe('mergeAnswerRows：合并与排序', () => {
  it('**按时间倒序**（最近的在前）', () => {
    const rows = mergeAnswerRows(oralToRows([ORAL]), explainToRows(NOTES));
    expect(rows.map((r) => r.at)).toEqual([
      '2026-11-19T11:00:00.000Z',
      '2026-11-19T10:00:00.000Z',
      '2026-11-19T09:00:00.000Z',
    ]);
  });

  it('时间相同时按 key 兜底（顺序稳定，不抖）', () => {
    const a = { ...oralToRows([ORAL])[0]!, at: 'X', key: 'b' };
    const b = { ...oralToRows([ORAL])[0]!, at: 'X', key: 'a' };
    expect(mergeAnswerRows([a], [b]).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('两种来源都在（合并不能漏掉一种）', () => {
    const rows = mergeAnswerRows(oralToRows([ORAL]), explainToRows(NOTES));
    expect(rows.filter((r) => r.source === 'oral')).toHaveLength(1);
    expect(rows.filter((r) => r.source === 'wrong-explain')).toHaveLength(2);
  });
});

describe('筛选与计数', () => {
  const all = mergeAnswerRows(oralToRows([ORAL]), explainToRows(NOTES));

  it('按来源筛选', () => {
    expect(filterAnswerRows(all, 'oral')).toHaveLength(1);
    expect(filterAnswerRows(all, 'wrong-explain')).toHaveLength(2);
    expect(filterAnswerRows(all, 'all')).toHaveLength(3);
  });

  it('计数与筛选结果一致（不能出现「显示 2 条但徽标写 3」）', () => {
    const c = countBySource(all);
    expect(c.all).toBe(all.length);
    expect(c.oral).toBe(filterAnswerRows(all, 'oral').length);
    expect(c['wrong-explain']).toBe(filterAnswerRows(all, 'wrong-explain').length);
  });

  it('筛选不修改原数组', () => {
    const before = all.length;
    filterAnswerRows(all, 'oral');
    expect(all.length).toBe(before);
  });
});