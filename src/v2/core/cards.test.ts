import { describe, expect, it } from 'vitest';
import {
  isCorrect,
  looseMatch,
  inferGrade,
  isAnswerable,
  CARD_KIND_LABEL,
  type Card,
} from './cards.ts';

/**
 * 判分逻辑的测试。
 *
 * ## 为什么这块必须有测试
 *
 * 判错了用户会直接说「软件判错了」，但很难说清具体哪里错。
 * 尤其填空/简答的宽松匹配 —— 太严会让答对的判错，
 * 太松会让答错的判对，两种都是灾难。
 */

const mk = (over: Partial<Card>): Card => ({
  id: 'c1',
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

describe('isCorrect：单选', () => {
  it('完全一致算对', () => {
    expect(isCorrect(mk({ kind: 'single', answer: 'A' }), 'A')).toBe(true);
  });

  it('不一致算错', () => {
    expect(isCorrect(mk({ kind: 'single', answer: 'A' }), 'B')).toBe(false);
  });

  it('单选严格比对（选项 key 由系统生成，不会有不一致）', () => {
    // 保持严格：如果这里放宽，一个拼错的答案可能被误判为正确
    expect(isCorrect(mk({ kind: 'single', answer: 'A' }), 'a')).toBe(false);
  });

  it('首尾空格被忽略', () => {
    expect(isCorrect(mk({ kind: 'single', answer: 'A' }), ' A ')).toBe(true);
  });
});

describe('isCorrect：多选', () => {
  const card = mk({ kind: 'multiple', answer: 'A,C' });

  it('顺序无关', () => {
    expect(isCorrect(card, 'C,A')).toBe(true);
  });

  it('全对才算对', () => {
    expect(isCorrect(card, 'A')).toBe(false);
    expect(isCorrect(card, 'A,B,C')).toBe(false);
  });

  it('支持中文逗号与空格分隔', () => {
    expect(isCorrect(card, 'A，C')).toBe(true);
    expect(isCorrect(card, 'A C')).toBe(true);
  });

  it('小写也认', () => {
    expect(isCorrect(card, 'a,c')).toBe(true);
  });

  it('重复选项不误判', () => {
    expect(isCorrect(card, 'A,A,C')).toBe(false);
  });
});

describe('looseMatch：文本答案的宽松匹配', () => {
  it('完全一致', () => {
    expect(looseMatch('顺序存储', '顺序存储')).toBe(true);
  });

  it('忽略空白与标点', () => {
    expect(looseMatch('顺序 存储', '顺序存储')).toBe(true);
    expect(looseMatch('顺序存储。', '顺序存储')).toBe(true);
  });

  it('全角转半角', () => {
    expect(looseMatch('ABC', 'ＡＢＣ')).toBe(true);
  });

  it('答案包含用户输入且占比够高', () => {
    expect(looseMatch('顺序存储结构', '顺序存储')).toBe(true);
  });

  it('**用户答得太少判错**（只对两个字不能算对）', () => {
    expect(looseMatch('顺序存储结构的特点', '顺序')).toBe(false);
  });

  it('用户答得更详细也算对（但差距不能太大）', () => {
    // 标准答案 4 字，用户答 5 字：0.8 ≥ 0.7 阈值，算对
    expect(looseMatch('顺序存储', '顺序存储结构')).toBe(true);
    // 标准答案只有 2 字，用户答 4 字：0.5 < 0.7
    // 这种情况判错是刻意的 —— 答案越短，多答的部分越可能是别的意思
    expect(looseMatch('顺序', '顺序存储')).toBe(false);
  });

  it('错字太多判错', () => {
    expect(looseMatch('顺序存储结构', '链式存储方式')).toBe(false);
  });

  it('空答案：两个都空算对，一个空一个非空算错', () => {
    expect(looseMatch('', '')).toBe(true);
    expect(looseMatch('', '有内容')).toBe(false);
    expect(looseMatch('有内容', '')).toBe(false);
  });
});

describe('isCorrect：填空与简答', () => {
  it('填空用宽松匹配', () => {
    const c = mk({ kind: 'blank', answer: '顺序存储' });
    expect(isCorrect(c, '顺序 存储')).toBe(true);
    expect(isCorrect(c, '链式存储')).toBe(false);
  });

  it('简答同样宽松', () => {
    const c = mk({ kind: 'short', answer: '线性表是一种线性结构' });
    expect(isCorrect(c, '线性表 是一种线性结构。')).toBe(true);
  });

  it('知识点卡片永远算对（没有对错）', () => {
    expect(isCorrect(mk({ kind: 'point' }), '')).toBe(true);
  });
});

describe('inferGrade：从作答推断复习评分', () => {
  it('答错 → again', () => {
    expect(inferGrade(mk({}), false, 5000)).toBe('again');
    expect(inferGrade(mk({}), false, 60000)).toBe('again');
  });

  it('答对且很快 → easy', () => {
    expect(inferGrade(mk({}), true, 3000)).toBe('easy');
  });

  it('答对但想很久 → hard', () => {
    expect(inferGrade(mk({}), true, 30000)).toBe('hard');
  });

  it('答对、时间正常 → good', () => {
    expect(inferGrade(mk({}), true, 12000)).toBe('good');
  });

  it('知识点卡片按停留时间推断（没有对错）', () => {
    const point = mk({ kind: 'point' });
    expect(inferGrade(point, null, 2000)).toBe('easy');
    expect(inferGrade(point, null, 10000)).toBe('good');
    expect(inferGrade(point, null, 30000)).toBe('hard');
  });

  it('答错时不管多快都是 again（不能因为手快就放宽）', () => {
    expect(inferGrade(mk({}), false, 500)).toBe('again');
  });
});

describe('辅助函数', () => {
  it('知识点不需要作答', () => {
    expect(isAnswerable(mk({ kind: 'point' }))).toBe(false);
    expect(isAnswerable(mk({ kind: 'single' }))).toBe(true);
    expect(isAnswerable(mk({ kind: 'blank' }))).toBe(true);
  });

  it('每种卡片类型都有中文名', () => {
    for (const k of ['single', 'multiple', 'blank', 'short', 'point'] as const) {
      expect(CARD_KIND_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});
