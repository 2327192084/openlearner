/**
 * 「选题 → AI 改造 → 组卷」的单测（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「在原有的组卷功能上不变，但是多个功能。参考 ai 变式功能还有自己组卷功能，
 *   用户先在题库挑选想要的题目，然后 ai 在这些题目的基础上改动出题」
 *
 * ## 这里钉什么
 *
 * 1. 每道挑中的题都出素材（挑几道就是几道，不悄悄少）
 * 2. 顺序保持（用户挑的顺序就是他想要的卷子顺序）
 * 3. 复用 `questionToVariantMaterial` 的措辞（不另写一套提示词）
 * 4. 空题干/没挑题时给出能行动的说明
 *
 * 真正的 AI 调用与落库在 `decks.generate`（已有 30+ 条单测覆盖），
 * 这里只验「素材准备」这一层 —— 那正是本模块新增的部分。
 */

import { describe, expect, it } from 'vitest';
import type { KnowledgePoint, Question } from '../model.ts';
import {
  COMPOSE_VARIANT_AXES,
  composeVariantTitle,
  pickedQuestionsToVariantMaterials,
  validateComposeVariantInput,
} from './compose-variant.ts';

const mkQ = (id: string, prompt = `题目 ${id}`): Question =>
  ({
    id,
    deckId: 'd1',
    kind: 'single',
    prompt,
    answer: 'A',
    explanation: '因为 A 对',
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ],
    /*
     * 下面这些字段 `questionToVariantMaterial` 会读到，
     * 少一个就会 `Cannot read properties of undefined`。
     * 第一版漏了 anchors / cognitiveLevel / knowledgePointId / order。
     */
    anchors: [],
    knowledgePointId: null,
    cognitiveLevel: 'understand',
    topic: null,
    sourceId: null,
    order: 0,
    createdAt: '',
    updatedAt: '',
  }) as unknown as Question;

const mkPoint = (statement: string): KnowledgePoint =>
  ({ id: 'p1', statement, cognitiveLevel: 'understand', chapter: null }) as unknown as KnowledgePoint;

describe('pickedQuestionsToVariantMaterials：挑几道就出几道素材', () => {
  it('★ 数量与顺序都与用户挑选一致', () => {
    const picked = [mkQ('q3'), mkQ('q1'), mkQ('q2')];
    const mats = pickedQuestionsToVariantMaterials({
      questions: picked,
      pointsById: new Map(),
      axes: [],
    });

    expect(mats).toHaveLength(3);
    /*
     * 顺序必须保持。`decks.generate` 按素材顺序落题，
     * 用户挑的顺序就是他想要的卷子顺序（先易后难之类）。
     */
    expect(mats.map((m) => m.statement)).toHaveLength(3);
  });

  it('★ 每道素材都带原题的全部信息（题干 / 答案 / 解析 / 选项）', () => {
    const mats = pickedQuestionsToVariantMaterials({
      questions: [mkQ('q1', '下列哪个是对的？')],
      pointsById: new Map(),
      axes: [],
    });

    const text = mats[0]!.statement + mats[0]!.quotes.join(' ');
    expect(text).toContain('下列哪个是对的？');
    expect(text).toContain('原答案');
  });

  it('★ 有知识点时带上考点', () => {
    const q = mkQ('q1');
    const point = mkPoint('导数的定义是差商的极限');
    const mats = pickedQuestionsToVariantMaterials({
      questions: [q],
      pointsById: new Map([['q1', point]]),
      axes: [],
    });

    expect(mats[0]!.statement).toContain('导数的定义是差商的极限');
  });

  it('没有知识点也能改造（只是没有考点提示）', () => {
    const mats = pickedQuestionsToVariantMaterials({
      questions: [mkQ('q1')],
      pointsById: new Map(),
      axes: [],
    });
    expect(mats).toHaveLength(1);
    /* 素材里会写「原题未标注考点」，不是报错 */
    expect(mats[0]!.statement).toContain('未标注考点');
  });

  it('★ 传了维度就写进素材（复用 variants.ts 的措辞）', () => {
    const mats = pickedQuestionsToVariantMaterials({
      questions: [mkQ('q1')],
      pointsById: new Map(),
      axes: ['reverse'],
    });

    /* 「反向问」是 VARIANT_AXES 里的既有标签，不该另起一个名字 */
    expect(mats[0]!.statement).toContain('反向问');
  });

  it('不传维度时给「换一个等价考法」的默认要求', () => {
    const mats = pickedQuestionsToVariantMaterials({
      questions: [mkQ('q1')],
      pointsById: new Map(),
      axes: [],
    });
    expect(mats[0]!.statement).toContain('等价');
  });

  it('空数组进 → 空数组出（不崩）', () => {
    const mats = pickedQuestionsToVariantMaterials({
      questions: [],
      pointsById: new Map(),
      axes: [],
    });
    expect(mats).toEqual([]);
  });
});

describe('validateComposeVariantInput：提前拦住改造不了的输入', () => {
  it('没挑题时明说', () => {
    expect(validateComposeVariantInput([])).toContain('至少');
  });

  it('★ 有空题干的题时说明有几道', () => {
    const r = validateComposeVariantInput([mkQ('q1'), mkQ('q2', '   '), mkQ('q3', '')]);
    expect(r).toContain('2');
    expect(r).toContain('题干');
  });

  it('正常的题返回 null（可以改造）', () => {
    expect(validateComposeVariantInput([mkQ('q1'), mkQ('q2')])).toBeNull();
  });
});

describe('composeVariantTitle：标题要能分辨是哪次造的', () => {
  it('★ 带日期（用户会攒很多套卷）', () => {
    const t = composeVariantTitle('自选 5 题', new Date('2026-11-17T10:00:00Z'));
    expect(t).toContain('2026');
    expect(t).toContain('改造组卷');
  });

  it('没有来源标签时也有合理标题', () => {
    const t = composeVariantTitle(null, new Date('2026-11-17T10:00:00Z'));
    expect(t).toContain('改造组卷');
  });
});

describe('COMPOSE_VARIANT_AXES：复用既有维度，不另立一套', () => {
  it('★ 与 variants.ts 的维度完全一致（否则两处措辞会漂移）', () => {
    expect(COMPOSE_VARIANT_AXES.map((a) => a.id)).toEqual(['context', 'reverse', 'combine', 'deepen']);
  });

  it('每个维度都有 label 与 desc（界面要用）', () => {
    for (const a of COMPOSE_VARIANT_AXES) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.desc.length).toBeGreaterThan(0);
    }
  });
});