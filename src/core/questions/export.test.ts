import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_OPTIONS,
  exportFileName,
  exportToJson,
  exportToMarkdown,
} from './export.ts';
import type { Deck, Question } from '../model.ts';

/**
 * 导出测试。
 *
 * 计划书 P3 验收：「导出的文件在 Word/WPS 里打开排版正常」。
 * 这里能验证的是**内容完整性与格式可解析性**，
 * 真正的排版要到 Word 里打开才知道 —— 这一点在验收报告里如实说明。
 */

function makeDeck(over: Partial<Deck> = {}): Deck {
  return {
    id: 'd1',
    title: '数据结构 第二章 练习',
    courseId: null,
    status: 'published',
    sourceId: null,
    backendId: 'mock',
    questionCount: 2,
    blockingIssues: 0,
    publishedAt: '2026-11-04T10:00:00.000Z',
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    ...over,
  };
}

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    deckId: 'd1',
    kind: 'single',
    prompt: '线性表的定义是什么？',
    options: [
      { key: 'A', text: '有限序列' },
      { key: 'B', text: '无限序列' },
      { key: 'C', text: '树结构' },
      { key: 'D', text: '图结构' },
    ],
    answer: 'A',
    explanation: '线性表是由 n 个数据元素构成的有限序列。',
    anchors: [{ sourceId: 's1', page: 2, chapter: '第二章 线性表', charStart: 10, charEnd: 40 }],
    knowledgePointId: 'kp1',
    cognitiveLevel: 'remember',
    topic: '第二章 线性表',
    order: 0,
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T09:00:00.000Z',
    ...over,
  };
}

describe('Markdown 导出', () => {
  const deck = makeDeck();
  const questions = [
    makeQuestion(),
    makeQuestion({
      id: 'q2',
      kind: 'blank',
      prompt: '顺序表支持______访问。',
      options: [],
      answer: '随机',
      order: 1,
      anchors: [{ sourceId: 's1', page: 2, charStart: 100, charEnd: 140 }],
    }),
  ];

  it('标题与题数在开头', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('# 数据结构 第二章 练习');
    expect(md).toContain('共 2 题');
  });

  it('题目按顺序编号，含题型与难度', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('## 第 1 题（单选题·识记）');
    expect(md).toContain('## 第 2 题（填空题·识记）');
  });

  it('选择题的选项都导出', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('A. 有限序列');
    expect(md).toContain('D. 图结构');
  });

  it('填空题有作答区', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('答：______');
  });

  it('答案区在题目区之后（避免学生瞄到答案）', () => {
    const md = exportToMarkdown(deck, questions);
    const questionIdx = md.indexOf('## 第 1 题');
    const answerIdx = md.indexOf('# 答案与解析');
    expect(questionIdx).toBeGreaterThan(-1);
    expect(answerIdx).toBeGreaterThan(questionIdx);
  });

  it('答案带选项文字而不只是字母', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('**答案：**A. 有限序列');
  });

  it('解析被导出', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('线性表是由 n 个数据元素构成的有限序列');
  });

  it('出处带章节与页码', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).toContain('第二章 线性表');
    expect(md).toContain('第 2 页');
  });

  it('includeAnswers: false 时不出现答案区', () => {
    const md = exportToMarkdown(deck, questions, {
      includeAnswers: false,
      includeAnchors: true,
    });
    expect(md).not.toContain('# 答案与解析');
    expect(md).not.toContain('**答案：**');
  });

  it('includeAnchors: false 时不出现出处', () => {
    const md = exportToMarkdown(deck, questions, {
      includeAnswers: true,
      includeAnchors: false,
    });
    expect(md).not.toContain('出处：');
  });

  it('草稿状态的题集会被标出来', () => {
    const md = exportToMarkdown(makeDeck({ status: 'draft' }), questions);
    expect(md).toContain('草稿');
  });

  it('没有连续三个以上空行（排版整洁）', () => {
    const md = exportToMarkdown(deck, questions);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('问答题有作答留白', () => {
    const md = exportToMarkdown(deck, [
      makeQuestion({ kind: 'essay', options: [], answer: '要点', prompt: '请说明…' }),
    ]);
    expect(md).toContain('答：');
  });

  it('多选题答案列出所有选项文字', () => {
    const md = exportToMarkdown(deck, [
      makeQuestion({ kind: 'multiple', answer: 'A,C' }),
    ]);
    expect(md).toContain('A. 有限序列');
    expect(md).toContain('C. 树结构');
  });
});

describe('JSON 导出', () => {
  const deck = makeDeck();
  const questions = [makeQuestion()];

  it('带格式标记与版本号', () => {
    const parsed = JSON.parse(exportToJson(deck, questions));
    expect(parsed.format).toBe('openleaner-deck');
    expect(parsed.version).toBe(1);
  });

  it('包含完整字段（给程序读，不是给人读）', () => {
    const parsed = JSON.parse(exportToJson(deck, questions));
    const q = parsed.questions[0];

    expect(q.kind).toBe('single');
    expect(q.options).toHaveLength(4);
    expect(q.answer).toBe('A');
    expect(q.explanation).toBeTruthy();
    // anchors 带字符偏移，便于精确定位
    expect(q.anchors[0].charStart).toBe(10);
    expect(q.anchors[0].charEnd).toBe(40);
    expect(q.knowledgePointId).toBe('kp1');
  });

  it('includeAnswers: false 时不含答案与解析', () => {
    const parsed = JSON.parse(
      exportToJson(deck, questions, { includeAnswers: false, includeAnchors: true }),
    );
    expect(parsed.questions[0].answer).toBeUndefined();
    expect(parsed.questions[0].explanation).toBeUndefined();
  });

  it('includeAnchors: false 时不含出处', () => {
    const parsed = JSON.parse(
      exportToJson(deck, questions, { includeAnswers: true, includeAnchors: false }),
    );
    expect(parsed.questions[0].anchors).toBeUndefined();
  });

  it('是合法 JSON 且能解析回来', () => {
    const json = exportToJson(deck, questions);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).questions).toHaveLength(1);
  });
});

describe('导出文件名', () => {
  it('带日期与扩展名', () => {
    const name = exportFileName(makeDeck(), 'md');
    expect(name).toMatch(/^数据结构 第二章 练习-\d{8}\.md$/);
  });

  it('替换掉 Windows 非法字符', () => {
    const name = exportFileName(makeDeck({ title: 'a/b:c*d?e"f<g>h|i' }), 'json');
    expect(name).not.toMatch(/[/:*?"<>|]/);
  });

  it('标题为空时用默认名', () => {
    expect(exportFileName(makeDeck({ title: '   ' }), 'md')).toMatch(/习题集-/);
  });
});

describe('默认导出选项', () => {
  it('默认包含答案与出处', () => {
    expect(DEFAULT_EXPORT_OPTIONS.includeAnswers).toBe(true);
    expect(DEFAULT_EXPORT_OPTIONS.includeAnchors).toBe(true);
  });
});
