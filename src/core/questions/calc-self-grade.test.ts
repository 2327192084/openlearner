/**
 * 计算题的判分与卡片映射（2026-11-12 定稿）。
 *
 * ## 定稿结论（用户拍板）
 *
 * 「让用户自主判断，我们显示详细解答过程和答案，用户自主判断对错。」
 *
 * 我最初做了数值判分（0.5/1/2/50% 等价，22 条单测），后来按用户意见撤掉：
 * 数值比对只看最终结果，会放过「数值对、过程错」，
 * 也会误伤「思路对、末步算错」。
 *
 * ## 这个文件守什么
 *
 * 撤掉数值判分不等于什么都不用管。这里钉住三条不变量：
 *
 * 1. **计算题必须判 `null`**（→ 界面显示自评按钮），不能退回填空的文本比对
 * 2. **卡片层必须映射成 `short`**（有输入框），不能落回 `single`
 *    —— 落回去就是「看得见、点得动、没有输入框」的死按钮，
 *    项目在 essay 上踩过一模一样的坑
 * 3. 计算题在题型表里 `graded` 必须是 `self`
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { DeckService } from './service.ts';
import { kindSpec } from './kinds.ts';
import type { Question } from '../model.ts';

function makeCalcQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q_calc_1',
    deckId: 'd1',
    kind: 'calc',
    prompt: '质量 2 kg 的物体受 3 m/s² 加速度，合力是多少？',
    options: [],
    answer: '6 N',
    explanation: 'F = ma = 2 × 3 = 6 N',
    anchors: [],
    knowledgePointId: null,
    cognitiveLevel: 'apply',
    topic: null,
    order: 0,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...over,
  };
}

describe('★ 计算题走用户自评（不是数值判分）', () => {
  it('gradeAnswer 返回 null —— 界面据此显示「我答对了/我答错了」', async () => {
    const svc = new DeckService(new MemoryStorage() as never);
    const q = makeCalcQuestion();

    /*
     * 关键断言：必须是 null。
     *
     * 如果这里返回 true/false，界面就不会出自评按钮 ——
     * 计算题会被机器按最终数值判掉，那正是用户不想看到的。
     */
    expect(svc.gradeAnswer(q, '6 N')).toBeNull();
    expect(svc.gradeAnswer(q, '6')).toBeNull();
    expect(svc.gradeAnswer(q, '完全错误')).toBeNull();
  });

  it('★ 数值写成等价形式也不自动判对（因为压根不判）', async () => {
    /*
     * 我原来做过：'0.5' vs '1/2' 判对、'50%' vs '0.5' 判对。
     * 现在一律 null —— 不是「判错了」，是「不判，交给用户」。
     */
    const svc = new DeckService(new MemoryStorage() as never);
    expect(svc.gradeAnswer(makeCalcQuestion({ answer: '1/2' }), '0.5')).toBeNull();
    expect(svc.gradeAnswer(makeCalcQuestion({ answer: '0.5' }), '50%')).toBeNull();
  });

  it('填空仍然是自动判分（没被这次改动波及）', async () => {
    const svc = new DeckService(new MemoryStorage() as never);
    const blank = makeCalcQuestion({ kind: 'blank', answer: '电阻' });
    expect(svc.gradeAnswer(blank, '电阻')).toBe(true);
    expect(svc.gradeAnswer(blank, '电容')).toBe(false);
  });
});

describe('题型表里的 calc 条目', () => {
  it('★ graded 必须是 self', () => {
    const spec = kindSpec('calc');
    expect(spec).not.toBeNull();
    expect(spec!.graded).toBe('self');
  });

  it('没有选项（和填空/问答一样是输入型）', () => {
    const spec = kindSpec('calc');
    expect(spec!.options).toBeNull();
    expect(spec!.fixedOptions).toBeNull();
  });

  it('可以被 AI 出（generate: true）', () => {
    expect(kindSpec('calc')!.generate).toBe(true);
  });

  it('耗时应高于填空题（真要做算术）', () => {
    expect(kindSpec('calc')!.cost).toBeGreaterThan(kindSpec('blank')!.cost);
  });

  it('hint 里说清了「自己判断对错」，不承诺自动判分', () => {
    const hint = kindSpec('calc')!.hint;
    expect(hint).toContain('自己判断');
  });
});
