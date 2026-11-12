/**
 * 变式素材生成的测试（2026-11-12）。
 *
 * ## 为什么这些断言值得写
 *
 * 变式出题的质量**全压在这段素材文本上** —— 出题后端与提示词都没改，
 * 模型只能从 statement 里知道「要变什么、不能变什么」。
 * 所以这里不测「模型出得好不好」（那要真模型），
 * 只测**我们给模型的约束有没有给全**：
 *
 *  - 原题、原答案、原解析在不在
 *  - 所选维度有没有写进去
 *  - 三条硬性限制在不在（尤其是「不要引入原题没有的事实」）
 *  - 出处（anchors / quotes）有没有带，否则变式题会点不回原文
 */
import { describe, expect, it } from 'vitest';
import type { KnowledgePoint, Question } from '../model.ts';
import {
  VARIANT_AXES,
  questionToVariantMaterial,
  knowledgePointsToVariantMaterials,
  wrongQuestionsToVariantMaterials,
} from './variants.ts';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    deckId: 'd1',
    kind: 'single',
    prompt: '在离散时间复指数信号中，当频率 ω₀=π 时，信号 e^{jπn} 等于什么？',
    options: [
      { key: 'A', text: '1' },
      { key: 'B', text: '(-1)^n' },
    ],
    answer: 'B',
    explanation: '由欧拉公式，e^{jπn}=cos(πn)+j sin(πn)=(-1)^n。',
    anchors: [{ page: 9, start: 0, end: 10 } as never],
    knowledgePointId: 'kp1',
    cognitiveLevel: 'understand',
    topic: '离散时间复指数信号',
    order: 0,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...over,
  };
}

function makePoint(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp1',
    statement: '离散时间复指数信号在 ω₀=π 时取值为 (-1)^n',
    chapter: '第1章',
    cognitiveLevel: 'understand',
    tags: [],
    anchors: [{ page: 9, start: 0, end: 10 } as never],
    quotes: ['当 ω₀=π 时，e^{jπn}=(-1)^n，信号在每一点改变符号。'],
    anchorStatus: 'ok',
    origin: 'ai',
    sourceId: 's1',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...over,
  } as KnowledgePoint;
}

describe('questionToVariantMaterial：素材里必须带上原题的全部信息', () => {
  it('★ 题干、答案、解析都在（缺一样模型就会改成别的题）', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['context']);
    expect(m.statement).toContain('离散时间复指数信号');
    expect(m.statement).toContain('原答案：B');
    expect(m.statement).toContain('欧拉公式');
  });

  it('★ 明确写了「不要照抄」', () => {
    const m = questionToVariantMaterial(makeQuestion(), null, ['context']);
    expect(m.statement).toContain('不要');
    expect(m.statement).toMatch(/不要照抄|请\*\*不要\*\*照抄/);
  });

  it('选项也带上（模型要按同样的格式出新选项）', () => {
    const m = questionToVariantMaterial(makeQuestion(), null, ['context']);
    expect(m.statement).toContain('A. 1');
    expect(m.statement).toContain('B. (-1)^n');
  });

  it('没有解析时不写「原解析：」空行', () => {
    const m = questionToVariantMaterial(makeQuestion({ explanation: '' }), null, ['context']);
    expect(m.statement).not.toContain('原解析：');
  });
});

describe('变式维度', () => {
  it('★ 所选维度的说明写进了素材', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['reverse']);
    expect(m.statement).toContain('反向问');
    expect(m.statement).toContain('给结果求条件');
  });

  it('多选时每条都在', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['context', 'deepen']);
    expect(m.statement).toContain('换情境');
    expect(m.statement).toContain('加深');
  });

  it('没选维度时也给一个兜底要求，不留空', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), []);
    expect(m.statement).toContain('未指定维度');
  });

  it('四个维度的 id 与标签一一对应', () => {
    expect(VARIANT_AXES.map((a) => a.id)).toEqual(['context', 'reverse', 'combine', 'deepen']);
    for (const a of VARIANT_AXES) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.desc.length).toBeGreaterThan(0);
    }
  });
});

describe('★ 硬性限制：防止模型编造事实', () => {
  it('三条限制都写进去了', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['context']);
    expect(m.statement).toContain('不要引入两者都没有的事实');
    expect(m.statement).toContain('考点必须与原题一致');
    /* 学生会看不到原题，所以不能出现「上题」这种指代 */
    expect(m.statement).toContain('不要出现「原题」「上题」');
  });
});

describe('★ 出处必须带上（否则变式题点不回原文）', () => {
  it('有知识点时：anchors 与 quotes 来自知识点', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['context']);
    expect(m.anchors).toEqual(makePoint().anchors);
    expect(m.quotes.length).toBeGreaterThan(0);
    expect(m.quotes[0]).toContain('离散时间复指数信号');
    expect(m.id).toBe('kp1');
  });

  it('没有知识点时：退回原题的 anchors，id 用 variant: 前缀', () => {
    const m = questionToVariantMaterial(makeQuestion(), null, ['context']);
    expect(m.anchors).toEqual(makeQuestion().anchors);
    expect(m.anchors.length).toBeGreaterThan(0);
    expect(m.id).toBe('variant:q1');
  });

  it('原题也没 anchors 时，不伪造位置（留空比编一个页码好）', () => {
    const q = makeQuestion({ anchors: [], knowledgePointId: null });
    const m = questionToVariantMaterial(q, null, ['context']);
    expect(m.anchors).toEqual([]);
    expect(m.page).toBeNull();
  });

  it('origin 记 knowledge —— 变式来自知识点而非原文段落', () => {
    const m = questionToVariantMaterial(makeQuestion(), makePoint(), ['context']);
    expect(m.origin).toBe('knowledge');
  });
});

describe('wrongQuestionsToVariantMaterials：从错题批量转', () => {
  it('★ 每条错题都转成一条素材', () => {
    const items = [
      { question: makeQuestion({ id: 'q1' }), wrongCount: 3 },
      { question: makeQuestion({ id: 'q2', prompt: '第二题' }), wrongCount: 1 },
    ];
    const points = new Map([['kp1', makePoint()]]);
    const ms = wrongQuestionsToVariantMaterials(items, points, ['context']);
    expect(ms).toHaveLength(2);
    expect(ms[1]?.statement).toContain('第二题');
  });

  it('limit 生效（用户选了只出 3 道就不要转 10 条）', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      question: makeQuestion({ id: `q${i}` }),
      wrongCount: 1,
    }));
    const ms = wrongQuestionsToVariantMaterials(items, new Map(), ['context'], 3);
    expect(ms).toHaveLength(3);
  });

  it('limit 为 0 表示不限', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      question: makeQuestion({ id: `q${i}` }),
      wrongCount: 1,
    }));
    expect(wrongQuestionsToVariantMaterials(items, new Map(), ['context'], 0)).toHaveLength(5);
  });

  it('知识点找不到时不炸，退回原题出处', () => {
    const items = [{ question: makeQuestion(), wrongCount: 2 }];
    const ms = wrongQuestionsToVariantMaterials(items, new Map(), ['context']);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.origin).toBe('knowledge');
  });
});

describe('knowledgePointsToVariantMaterials：直接从知识点出变式', () => {
  it('★ 每个知识点一条，statement 里带考点原文与引用', () => {
    const ms = knowledgePointsToVariantMaterials([makePoint()], ['context', 'reverse']);
    expect(ms).toHaveLength(1);
    expect(ms[0]?.statement).toContain('离散时间复指数信号在 ω₀=π 时取值为 (-1)^n');
    expect(ms[0]?.statement).toContain('换情境');
    expect(ms[0]?.statement).toContain('反向问');
    expect(ms[0]?.quotes.some((q) => q.includes('每一点改变符号'))).toBe(true);
  });

  it('anchors 原样继承（不重算页码）', () => {
    const p = makePoint();
    const ms = knowledgePointsToVariantMaterials([p], ['context']);
    expect(ms[0]?.anchors).toEqual(p.anchors);
    expect(ms[0]?.page).toBe(9);
  });

  it('知识点没有 quotes 时，quotes 里至少有考点本身', () => {
    const ms = knowledgePointsToVariantMaterials([makePoint({ quotes: [] })], ['context']);
    expect(ms[0]?.quotes.length).toBe(1);
    expect(ms[0]?.quotes[0]).toContain('离散时间复指数信号');
  });
});
