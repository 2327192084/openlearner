import { describe, expect, it } from 'vitest';
import {
  buildAskPrompt,
  buildJudgePrompt,
  buildOralSystemPrompt,
  parseJudgement,
  pickMaterial,
  pointsToMaterials,
  quotesMatch,
  segmentsToMaterials,
  toBrief,
  type OralMaterial,
} from './oral-review.ts';
import type { KnowledgePoint, SourceSegment } from './model.ts';

/**
 * 提问式复习的纯逻辑（2026-11-10）。
 *
 * 最要紧的是**引文校验**：模型经常把引文改几个字或整段编造。
 * 判定错了用户还能看到依据自己纠正；依据是编的，用户就被骗了。
 */

const MATERIAL: OralMaterial = {
  id: 'seg1',
  label: '信号与系统 · 第 9 页',
  text: '连续时间信号用圆括号把自变量括起来并以 t 表示连续时间变量；离散时间信号用方括号表示，且仅在自变量的整数值上有定义。',
  sourceId: 's1',
  page: 9,
  chapter: '1.2 离散时间信号',
  pointId: null,
};

describe('segmentsToMaterials', () => {
  function seg(over: Partial<SourceSegment> = {}): SourceSegment {
    return {
      id: 'seg1',
      sourceId: 's1',
      index: 1,
      page: 9,
      chapter: '1.2',
      text: 'x'.repeat(200),
      charCount: 200,
      createdAt: '',
      updatedAt: '',
      ...over,
    } as SourceSegment;
  }

  it('段落转素材，带出处标签', () => {
    const out = segmentsToMaterials([seg()], '信号与系统');
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toContain('信号与系统');
    expect(out[0]!.label).toContain('第 9 页');
    expect(out[0]!.page).toBe(9);
  });

  it('太短的段落被跳过（页眉孤行提不出好问题）', () => {
    expect(segmentsToMaterials([seg({ text: '第 9 页' })], 'x')).toHaveLength(0);
  });

  it('不做长度截断（提问需要完整上下文）', () => {
    /*
     * 出题路径会按 maxChars 截断，但提问不能 ——
     * 截断会让模型问出「根据上文…」而上文被裁掉的情况。
     */
    const long = 'x'.repeat(5000);
    const out = segmentsToMaterials([seg({ text: long })], 'x');
    expect(out[0]!.text.length).toBe(5000);
  });
});

describe('pointsToMaterials', () => {
  function point(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
    return {
      id: 'kp1',
      statement: '提炼后的一句话',
      chapter: '第1章',
      cognitiveLevel: 'remember',
      tags: [],
      anchors: [{ sourceId: 's1', page: 3 }],
      quotes: ['这是逐字原文，比提炼语更适合判定理解偏差'],
      anchorStatus: 'located',
      origin: 'material',
      sourceId: 's1',
      backendId: null,
      createdAt: '',
      updatedAt: '',
      ...over,
    } as KnowledgePoint;
  }

  it('优先用 quotes 而不是 statement', () => {
    /*
     * 判定「理解偏差」需要看原文完整表述，一句提炼语不够。
     */
    const out = pointsToMaterials([point()]);
    expect(out[0]!.text).toContain('逐字原文');
    expect(out[0]!.text).not.toBe('提炼后的一句话');
  });

  it('没有 quotes 时退回 statement（总比没有好）', () => {
    const out = pointsToMaterials([point({ quotes: [] })]);
    expect(out[0]!.text).toBe('提炼后的一句话');
  });

  it('带上 pointId 与页码', () => {
    const out = pointsToMaterials([point()]);
    expect(out[0]!.pointId).toBe('kp1');
    expect(out[0]!.page).toBe(3);
  });

  it('statement 为空的知识点被跳过', () => {
    expect(pointsToMaterials([point({ statement: '  ' })])).toHaveLength(0);
  });
});

describe('pickMaterial', () => {
  it('空数组返回 null', () => {
    expect(pickMaterial([])).toBeNull();
  });

  it('可注入随机源（测试可复现）', () => {
    const list = [1, 2, 3].map((i) => ({ ...MATERIAL, id: 'm' + i }));
    expect(pickMaterial(list, () => 0)!.id).toBe('m1');
    expect(pickMaterial(list, () => 0.5)!.id).toBe('m2');
    expect(pickMaterial(list, () => 0.99)!.id).toBe('m3');
  });

  it('random 恰好返回 1 时不越界', () => {
    /* 浮点边界：Math.random 理论上可能返回 1（某些实现） */
    const list = [MATERIAL];
    expect(pickMaterial(list, () => 1)).not.toBeNull();
  });
});

describe('提示词', () => {
  it('system 说清了三类判定与「必须给依据」', () => {
    const s = buildOralSystemPrompt();
    expect(s).toContain('correct');
    expect(s).toContain('memory');
    expect(s).toContain('understanding');
    expect(s).toContain('逐字');
    expect(s).toContain('quotedFromSource');
  });

  it('出问题时不要求同时给答案（用户还没作答）', () => {
    const p = buildAskPrompt(MATERIAL);
    expect(p).toContain(MATERIAL.text);
    expect(p).toContain('只输出问题本身');
  });

  it('判定提示词带齐三要素：材料、问题、回答', () => {
    const p = buildJudgePrompt(MATERIAL, '两类信号怎么区分？', '用括号')
    expect(p).toContain(MATERIAL.text);
    expect(p).toContain('两类信号怎么区分？');
    expect(p).toContain('用括号');
  });

  it('空回答明确标注（不让模型以为漏传了）', () => {
    const p = buildJudgePrompt(MATERIAL, 'q', '   ');
    expect(p).toContain('没有作答');
  });
});

describe('quotesMatch 引文校验', () => {
  it('逐字一致 → true', () => {
    expect(quotesMatch('连续时间信号用圆括号', MATERIAL.text)).toBe(true);
  });

  it('忽略空白差异（模型复制时常改换行）', () => {
    expect(quotesMatch('连续时间信号  用圆括号', MATERIAL.text)).toBe(true);
  });

  it('忽略全角半角差异', () => {
    expect(quotesMatch('连续时间信号用圆括号', MATERIAL.text)).toBe(true);
  });

  it('改字 → false（这是核心：抓编造）', () => {
    /*
     * 模型经常把「圆括号」写成「方括号」—— 那不是笔误，
     * 是把依据改了。必须抓出来。
     */
    expect(quotesMatch('连续时间信号用方括号', MATERIAL.text)).toBe(false);
  });

  it('整段编造 → false', () => {
    expect(quotesMatch('这段话根本不在材料里', MATERIAL.text)).toBe(false);
  });

  it('空引文 → false', () => {
    expect(quotesMatch('', MATERIAL.text)).toBe(false);
    expect(quotesMatch('   ', MATERIAL.text)).toBe(false);
  });

  it('字的顺序变了 → false', () => {
    expect(quotesMatch('圆括号用连续时间信号', MATERIAL.text)).toBe(false);
  });
});

describe('parseJudgement', () => {
  it('正常解析 correct', () => {
    const j = parseJudgement(
      '{"verdict":"correct","quotedFromSource":"","explanation":"答对了","correction":""}',
      MATERIAL,
    );
    expect(j.verdict).toBe('correct');
    expect(j.explanation).toBe('答对了');
  });

  it('memory 且引文真实 → quoteVerified 为 true', () => {
    const j = parseJudgement(
      JSON.stringify({
        verdict: 'memory',
        quotedFromSource: '离散时间信号用方括号表示',
        explanation: '你把方括号记成圆括号了',
        correction: '离散时间信号用方括号',
      }),
      MATERIAL,
    );
    expect(j.verdict).toBe('memory');
    expect(j.quoteVerified).toBe(true);
  });

  it('memory 但引文是编的 → quoteVerified 为 false', () => {
    /*
     * 这条最重要：判定看似合理，但依据是编的。
     * 界面必须据此提示「它没给出可靠依据」。
     */
    const j = parseJudgement(
      JSON.stringify({
        verdict: 'memory',
        quotedFromSource: '材料里没有这句话',
        explanation: 'x',
        correction: 'y',
      }),
      MATERIAL,
    );
    expect(j.verdict).toBe('memory');
    expect(j.quoteVerified).toBe(false);
  });

  it('memory 但没给引文 → quoteVerified 为 false（如实反映）', () => {
    const j = parseJudgement(
      '{"verdict":"memory","quotedFromSource":"","explanation":"x","correction":"y"}',
      MATERIAL,
    );
    expect(j.quoteVerified).toBe(false);
    expect(j.quotedFromSource).toBe('');
  });

  it('verdict 大小写与空格容错', () => {
    expect(parseJudgement('{"verdict":" MEMORY "}', MATERIAL).verdict).toBe('memory');
  });

  it('认不出的 verdict 退回 understanding（最需要讲解的一类）', () => {
    const j = parseJudgement('{"verdict":"???","explanation":"x"}', MATERIAL);
    expect(j.verdict).toBe('understanding');
  });

  it('不是 JSON 时给可读的兜底结果，不抛错', () => {
    const j = parseJudgement('我判断不了', MATERIAL);
    expect(j.verdict).toBe('understanding');
    expect(j.explanation).toContain('没有返回可解析');
  });

  it('带围栏也能解析', () => {
    const c = '```json\n{"verdict":"correct","explanation":"对"}\n```';
    expect(parseJudgement(c, MATERIAL).verdict).toBe('correct');
  });

  it('explanation / correction 过长时截断（防小作文）', () => {
    const long = 'x'.repeat(1000);
    const j = parseJudgement(
      JSON.stringify({ verdict: 'memory', explanation: long, correction: long }),
      MATERIAL,
    );
    expect(j.explanation.length).toBeLessThanOrEqual(300);
    expect(j.correction.length).toBeLessThanOrEqual(600);
  });
});

describe('toBrief 精简形式', () => {
  it('只留说明与纠正，不留原文', () => {
    const b = toBrief({
      verdict: 'memory',
      quotedFromSource: '很长的一段原文'.repeat(50),
      explanation: '你把条件记反了',
      correction: '应该是 x>0',
      quoteVerified: true,
    });
    expect(b.explanation).toBe('你把条件记反了');
    expect(b.correction).toBe('应该是 x>0');
    expect(JSON.stringify(b)).not.toContain('很长的一段原文');
  });

  it('过长时截断', () => {
    const b = toBrief({
      verdict: 'understanding',
      quotedFromSource: '',
      explanation: 'e'.repeat(500),
      correction: 'c'.repeat(500),
      quoteVerified: false,
    });
    expect(b.explanation.length).toBeLessThanOrEqual(120);
    expect(b.correction.length).toBeLessThanOrEqual(200);
  });
});
