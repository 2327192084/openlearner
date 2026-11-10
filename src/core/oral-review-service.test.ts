import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { OralReviewService } from './oral-review-service.ts';
import type { OralJudgement, OralMaterial } from './oral-review.ts';

/**
 * 提问式复习的存档（2026-11-10）。
 *
 * 重点在两种保存形态的差别：
 *  - full：连原文一起留（「我以后要回来读」）
 *  - brief：只留说明与纠正（「我只想知道错在哪」）
 *
 * brief 若把原文也存了，这个形态就失去意义了 —— 用户选它就是
 * 不想让库变大。所以测试里专门断言 fullText 为 null。
 */

const MATERIAL: OralMaterial = {
  id: 'seg1',
  label: '信号与系统 · 第 9 页',
  text: '连续时间信号用圆括号表示；离散时间信号用方括号表示。',
  sourceId: 's1',
  page: 9,
  chapter: '1.2',
  pointId: null,
};

const JUDGEMENT: OralJudgement = {
  verdict: 'memory',
  quotedFromSource: '离散时间信号用方括号表示',
  explanation: '你把方括号记成圆括号了',
  correction: '离散时间信号应该用方括号 []',
  quoteVerified: true,
};

async function setup() {
  const storage = new MemoryStorage();
  await storage.init();
  return { storage, svc: new OralReviewService(storage) };
}

describe('save', () => {
  it('full 形态存下完整原文', async () => {
    const { svc } = await setup();
    const rec = await svc.save({
      material: MATERIAL,
      question: '两类信号怎么区分？',
      answer: '都用圆括号',
      judgement: JUDGEMENT,
      savedAs: 'full',
    });

    expect(rec.savedAs).toBe('full');
    expect(rec.fullText).toBe(MATERIAL.text);
    expect(rec.verdict).toBe('memory');
    expect(rec.scopeLabel).toBe(MATERIAL.label);
  });

  it('brief 形态**不存**完整原文', async () => {
    /*
     * 这是这个形态的全部意义：用户选它就是不想让库变大。
     */
    const { svc } = await setup();
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: JUDGEMENT,
      savedAs: 'brief',
    });

    expect(rec.savedAs).toBe('brief');
    expect(rec.fullText).toBeNull();
  });

  it('brief 形态截短说明与纠正', async () => {
    const { svc } = await setup();
    const long: OralJudgement = {
      ...JUDGEMENT,
      explanation: '说'.repeat(500),
      correction: '改'.repeat(500),
    };
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: long,
      savedAs: 'brief',
    });
    expect(rec.explanation.length).toBeLessThanOrEqual(120);
    expect(rec.correction.length).toBeLessThanOrEqual(200);
  });

  it('full 形态保留完整说明（不截短）', async () => {
    const { svc } = await setup();
    const long: OralJudgement = {
      ...JUDGEMENT,
      explanation: '说'.repeat(200),
    };
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: long,
      savedAs: 'full',
    });
    expect(rec.explanation.length).toBe(200);
  });

  it('存下判定依据与校验结果（用户以后要能复查）', async () => {
    const { svc } = await setup();
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: JUDGEMENT,
      savedAs: 'brief',
    });
    expect(rec.quotedFromSource).toBe('离散时间信号用方括号表示');
    expect(rec.quoteVerified).toBe(true);
  });

  it('引文没通过校验时如实存 false', async () => {
    const { svc } = await setup();
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: { ...JUDGEMENT, quoteVerified: false },
      savedAs: 'brief',
    });
    expect(rec.quoteVerified).toBe(false);
  });

  it('带上出处（跳回原文用）', async () => {
    const { svc } = await setup();
    const rec = await svc.save({
      material: MATERIAL,
      question: 'q',
      answer: 'a',
      judgement: JUDGEMENT,
      savedAs: 'brief',
    });
    expect(rec.sourceId).toBe('s1');
    expect(rec.page).toBe(9);
    expect(rec.quote).toBeTruthy();
  });

  it('sourceId 为空时存 null（不存空串）', async () => {
    const { svc } = await setup();
    const rec = await svc.save({
      material: { ...MATERIAL, sourceId: '' },
      question: 'q',
      answer: 'a',
      judgement: JUDGEMENT,
      savedAs: 'brief',
    });
    expect(rec.sourceId).toBeNull();
  });
});

describe('list / remove', () => {
  it('按时间倒序（最近的在前）', async () => {
    const { storage, svc } = await setup();
    await storage.put('oralReviews', {
      id: 'oral_old', scopeLabel: 'old', sourceId: null, page: null, quote: null,
      question: 'q', answer: 'a', verdict: 'memory', quotedFromSource: '',
      quoteVerified: false, explanation: '', correction: '', savedAs: 'brief',
      fullText: null, createdAt: '2026-11-01T00:00:00.000Z',
    });
    await svc.save({
      material: MATERIAL, question: 'q2', answer: 'a', judgement: JUDGEMENT, savedAs: 'brief',
    });

    const list = await svc.list();
    expect(list[0]!.question).toBe('q2');
  });

  it('listBySource 只返回该资料', async () => {
    const { svc } = await setup();
    await svc.save({ material: MATERIAL, question: 'q1', answer: 'a', judgement: JUDGEMENT, savedAs: 'brief' });
    await svc.save({
      material: { ...MATERIAL, sourceId: 's2' }, question: 'q2', answer: 'a', judgement: JUDGEMENT, savedAs: 'brief',
    });
    expect(await svc.listBySource('s1')).toHaveLength(1);
  });

  it('删一条', async () => {
    const { svc } = await setup();
    const rec = await svc.save({ material: MATERIAL, question: 'q', answer: 'a', judgement: JUDGEMENT, savedAs: 'brief' });
    expect(await svc.remove(rec.id)).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  it('删不存在的返回 false', async () => {
    const { svc } = await setup();
    expect(await svc.remove('nope')).toBe(false);
  });
});

describe('recentStats', () => {
  it('按判定类别计数', async () => {
    const { svc } = await setup();
    await svc.save({ material: MATERIAL, question: '1', answer: 'a', judgement: { ...JUDGEMENT, verdict: 'memory' }, savedAs: 'brief' });
    await svc.save({ material: MATERIAL, question: '2', answer: 'a', judgement: { ...JUDGEMENT, verdict: 'memory' }, savedAs: 'brief' });
    await svc.save({ material: MATERIAL, question: '3', answer: 'a', judgement: { ...JUDGEMENT, verdict: 'understanding' }, savedAs: 'brief' });

    const s = await svc.recentStats(7);
    expect(s.memory).toBe(2);
    expect(s.understanding).toBe(1);
    expect(s.total).toBe(3);
  });

  it('超出时间窗的不计入', async () => {
    const { storage, svc } = await setup();
    await storage.put('oralReviews', {
      id: 'old', scopeLabel: '', sourceId: null, page: null, quote: null,
      question: 'q', answer: 'a', verdict: 'memory', quotedFromSource: '',
      quoteVerified: false, explanation: '', correction: '', savedAs: 'brief',
      fullText: null, createdAt: '2020-01-01T00:00:00.000Z',
    });
    const s = await svc.recentStats(7);
    expect(s.total).toBe(0);
  });

  it('空库不炸', async () => {
    const { svc } = await setup();
    const s = await svc.recentStats();
    expect(s.total).toBe(0);
    expect(s.memory).toBe(0);
  });
});
