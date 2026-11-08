import { describe, expect, it } from 'vitest';
import { MockQuestionBackend } from './mock-backend.ts';
import type { QuestionSourcePoint } from './backend-types.ts';

/**
 * 端到端验证：界面上的「每种题型出几道」真的会影响出题结果。
 *
 * 为什么需要这一层：`plan-kinds.test.ts` 只测了序列推导，
 * 但「后端拿到配额后是否照着出」是另一件事 —— 两者之间还有一个调用边界。
 * 用示例后端跑真调用，把这个边界也验掉。
 *
 * 用示例后端而不是真实模型：不联网、不花钱、结果可预测。
 * 真实模型是概率性的，没法断言精确分布 —— 那正是这个功能存在的理由
 * （用户要求 4/2，模型以前可能给 3/3，现在有明确配额）。
 */

/*
 * 知识点陈述必须够长（示例后端要求 >= 8 字符，且能抽出术语），
 * 否则 buildDraft 返回 null、一道题都出不来 —— 我第一版写得太短，
 * 结果是空数组而不是配额不符，差点误判成配额没生效。
 */
const points: QuestionSourcePoint[] = [
  {
    id: 'k1',
    statement: '离散时间信号只在自变量的整数值上有定义，非整数点取值为无意义。',
    quotes: ['无论这些离散时间信号的来源是什么，信号 x[n] 总是在 n 的整数值上有定义。'],
    cognitiveLevel: 'remember',
    chapter: '第1章',
    page: 3,
  },
  {
    id: 'k2',
    statement: '连续时间信号的自变量在实数范围内连续可取，因此定义域是连续的。',
    quotes: ['连续时间信号的自变量在实数范围内连续取值。'],
    cognitiveLevel: 'understand',
    chapter: '第1章',
    page: 2,
  },
  {
    id: 'k3',
    statement: '线性时不变系统的输出等于输入与系统冲激响应的卷积积分。',
    quotes: ['线性时不变系统的输出可以由输入与冲激响应的卷积求得。'],
    cognitiveLevel: 'apply',
    chapter: '第1章',
    page: 5,
  },
];

function tally(drafts: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of drafts) out[d.kind] = (out[d.kind] ?? 0) + 1;
  return out;
}

describe('示例后端按配额出题（端到端）', () => {
  it('没指定配额 → 退回轮流：5 道 2 种 = 3/2', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single', 'essay'],
      count: 5,
      levels: null,
      language: 'zh',
      signal: new AbortController().signal,
    });
    expect(tally(out.drafts)).toEqual({ single: 3, essay: 2 });
  });

  it('指定 4 单选 + 2 问答 → 严格执行，不是 3/3', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single', 'essay'],
      count: 6,
      kindCounts: { single: 4, essay: 2 },
      levels: null,
      language: 'zh',
      signal: new AbortController().signal,
    });
    expect(tally(out.drafts)).toEqual({ single: 4, essay: 2 });
  });

  it('只要单选 → 不会混入别的题型', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single'],
      count: 3,
      kindCounts: { single: 3 },
      levels: null,
      language: 'zh',
      signal: new AbortController().signal,
    });
    expect(out.drafts.every((d) => d.kind === 'single')).toBe(true);
  });

  it('levels 限定 apply → 全部题目引用 apply 层知识点', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single'],
      count: 2,
      levels: ['apply'],
      language: 'zh',
      signal: new AbortController().signal,
    });
    expect(out.drafts.length).toBeGreaterThan(0);
    expect(out.drafts.every((d) => d.knowledgePointId === 'k3')).toBe(true);
  });

  it('levels 过滤后为空 → 退回全部，不会一道都出不来', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single'],
      count: 2,
      levels: ['analyze'], // 没有 analyze 层的知识点
      language: 'zh',
      signal: new AbortController().signal,
    });
    expect(out.drafts.length).toBeGreaterThan(0);
  });

  it('配额顺序是逐种连续，不是交替', async () => {
    const out = await new MockQuestionBackend().generate(points, {
      kinds: ['single', 'essay'],
      count: 4,
      kindCounts: { single: 3, essay: 1 },
      levels: null,
      language: 'zh',
      signal: new AbortController().signal,
    });
    // 前 3 道都是单选，第 4 道是问答
    expect(out.drafts.slice(0, 3).every((d) => d.kind === 'single')).toBe(true);
    expect(out.drafts[3]?.kind).toBe('essay');
  });
});
