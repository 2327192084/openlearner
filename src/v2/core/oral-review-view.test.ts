import { describe, expect, it } from 'vitest';
import {
  anchorText,
  filterRows,
  needsQuoteWarning,
  summaryText,
  toRows,
  VERDICT_ADVICE,
  VERDICT_LABEL,
  whenText,
} from './oral-review-view.ts';
import type { OralReviewRecord } from '@/core/model.ts';

/**
 * 提问式复习回看视图的单测。
 *
 * ## 这块为什么要测
 *
 * 三条都是「界面上一眼看不出来」的规则：
 *  1. 排序 —— 顺序错了用户找不到最近那条，但他不会说「排序错了」
 *  2. 筛选 —— 「只看答错的」如果混进答对的，用户会以为判定错了
 *  3. 引文警示 —— 这是本功能唯一防止「把 AI 编的依据当原文」的关口，
 *     漏掉一次，用户就会相信一句教材里根本没有的话
 */

const mk = (over: Partial<OralReviewRecord>): OralReviewRecord => ({
  id: 'oral_1',
  scopeLabel: '第 9 页 · 1.2 离散时间信号',
  sourceId: 'src_1',
  page: 9,
  quote: '……',
  question: '两类信号怎么区分？',
  answer: '用括号',
  verdict: 'memory',
  quotedFromSource: '连续时间信号用圆括号',
  quoteVerified: true,
  explanation: '你把记号记反了',
  correction: '连续用 ()，离散用 []',
  savedAs: 'brief',
  fullText: null,
  createdAt: '2026-11-13T02:42:00.000Z',
  ...over,
});

describe('whenText', () => {
  it('格式化成 MM-DD HH:mm', () => {
    expect(whenText('2026-11-13T02:42:00.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('解析不出来给空串，不显示 NaN', () => {
    expect(whenText('不是时间')).toBe('');
  });
});

describe('toRows', () => {
  it('最近的排最前', () => {
    const rows = toRows([
      mk({ id: 'a', createdAt: '2026-11-10T00:00:00.000Z' }),
      mk({ id: 'b', createdAt: '2026-11-13T00:00:00.000Z' }),
    ]);
    expect(rows[0]?.id).toBe('b');
  });

  it('把服务层字段原样带过来（判定、引文校验、原文）', () => {
    const rows = toRows([
      mk({ verdict: 'understanding', quoteVerified: false, savedAs: 'full', fullText: '整段原文' }),
    ]);
    expect(rows[0]?.verdict).toBe('understanding');
    expect(rows[0]?.quoteVerified).toBe(false);
    expect(rows[0]?.fullText).toBe('整段原文');
  });

  it('来源说明为空时给占位，不让界面出现空白', () => {
    expect(toRows([mk({ scopeLabel: '' })])[0]?.scopeLabel).toBe('（没有来源说明）');
  });

  it('不改动传入的数组（纯函数）', () => {
    const input = [mk({ id: 'a', createdAt: '2026-11-10T00:00:00.000Z' }), mk({ id: 'b' })];
    const before = input.map((r) => r.id);
    toRows(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});

describe('filterRows', () => {
  const rows = toRows([
    mk({ id: 'ok', verdict: 'correct' }),
    mk({ id: 'mem', verdict: 'memory' }),
    mk({ id: 'und', verdict: 'understanding' }),
  ]);

  it('all 不动', () => {
    expect(filterRows(rows, 'all')).toHaveLength(3);
  });

  it('wrong 只留非 correct（两种错法都算）', () => {
    const out = filterRows(rows, 'wrong');
    expect(out.map((r) => r.id).sort()).toEqual(['mem', 'und']);
  });
});

describe('summaryText', () => {
  it('没有记录时说清「还没有」，不是「0 条」', () => {
    const s = summaryText({ memory: 0, understanding: 0, correct: 0, total: 0 }, 7);
    expect(s).toContain('还没有');
    expect(s).toContain('7');
  });

  it('全对时明确说全对', () => {
    const s = summaryText({ memory: 0, understanding: 0, correct: 5, total: 5 }, 7);
    expect(s).toContain('全部答对了');
  });

  it('有两种错法时分别报数', () => {
    const s = summaryText({ memory: 3, understanding: 5, correct: 1, total: 9 }, 7);
    expect(s).toContain('记错 3');
    expect(s).toContain('理解偏 5');
  });
});

describe('needsQuoteWarning', () => {
  it('判成答对时不要求引文', () => {
    const r = toRows([mk({ verdict: 'correct', quotedFromSource: '', quoteVerified: false })])[0]!;
    expect(needsQuoteWarning(r)).toBe(false);
  });

  it('判成错但没给引文 → 要警示', () => {
    const r = toRows([mk({ verdict: 'memory', quotedFromSource: '   ' })])[0]!;
    expect(needsQuoteWarning(r)).toBe(true);
  });

  it('判成错、有引文但校验没过（可能是编的）→ 要警示', () => {
    const r = toRows([mk({ verdict: 'understanding', quotedFromSource: '编的一句', quoteVerified: false })])[0]!;
    expect(needsQuoteWarning(r)).toBe(true);
  });

  it('判成错、引文校验通过 → 不警示', () => {
    const r = toRows([mk({ verdict: 'understanding', quoteVerified: true })])[0]!;
    expect(needsQuoteWarning(r)).toBe(false);
  });
});

describe('anchorText', () => {
  it('有页码时写清第几页', () => {
    expect(anchorText(toRows([mk({ sourceId: 's', page: 9 })])[0]!)).toBe('回到原文第 9 页');
  });

  it('有资料但没有页码时给「回到原文」', () => {
    expect(anchorText(toRows([mk({ sourceId: 's', page: null })])[0]!)).toBe('回到原文');
  });

  it('没有资料 id 时返回 null（界面据此不渲染按钮）', () => {
    expect(anchorText(toRows([mk({ sourceId: null })])[0]!)).toBeNull();
  });
});

describe('文案表', () => {
  it('三种判定都有用户侧说法', () => {
    expect(VERDICT_LABEL.correct).toBe('答对了');
    expect(VERDICT_LABEL.memory).toBe('记错了');
    expect(VERDICT_LABEL.understanding).toBe('理解偏了');
  });

  it('三种判定都有下一步建议，且不是重复的同一句', () => {
    const all = [
      VERDICT_ADVICE.correct,
      VERDICT_ADVICE.memory,
      VERDICT_ADVICE.understanding,
    ];
    expect(new Set(all).size).toBe(3);
    for (const s of all) expect(s.length).toBeGreaterThan(5);
  });
});
