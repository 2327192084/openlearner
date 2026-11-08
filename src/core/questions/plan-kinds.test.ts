import { describe, expect, it } from 'vitest';
import { planKinds } from './backend-types.ts';
import type { QuestionKind } from '@/core/model.ts';

/**
 * 题型配额展开。
 *
 * 2026-11-08：原来只有「总数 + 题型列表」，配比由模型/mock 自己决定：
 *  - 真实后端只能靠提示词「尽量平均」，模型不遵守时用户没辙
 *  - mock 后端 `kinds[i % len]` 硬轮转，6 道 3 种必然 2/2/2
 *
 * 现在界面可以逐种填数量。这个函数把配额展开成「第 i 道出什么题型」，
 * mock 后端与真实后端的批次配额都从它推导 —— 两处必须一致。
 */
describe('planKinds：有配额时按配额展开', () => {
  it('5 单选 + 1 问答', () => {
    const plan = planKinds(['single', 'essay'], 6, { single: 5, essay: 1 });
    expect(plan).toEqual(['single', 'single', 'single', 'single', 'single', 'essay']);
  });

  it('同一题型连续出现（便于阅读，不交替）', () => {
    const plan = planKinds(['single', 'multiple', 'truefalse'], 6, {
      single: 2,
      multiple: 2,
      truefalse: 2,
    });
    expect(plan).toEqual(['single', 'single', 'multiple', 'multiple', 'truefalse', 'truefalse']);
  });

  it('配额总和大于 count 时截断', () => {
    const plan = planKinds(['single'], 3, { single: 10 });
    expect(plan).toHaveLength(3);
  });

  it('配额总和小于 count 时按配额给出（不补足）', () => {
    /*
     * 为什么补足：补足要用哪种题型？没有依据。
     * 少出几道比瞎凑强 —— 界面上「合计 N 道」就是用户自己填的和，
     * 两者一致才是诚实的。
     */
    const plan = planKinds(['single', 'essay'], 10, { single: 2, essay: 1 });
    expect(plan).toEqual(['single', 'single', 'essay']);
  });

  it('配额里出现未勾选的题型 → 忽略它', () => {
    // kinds 里没有 essay，即使 counts 里有也不该出
    const plan = planKinds(['single'], 5, { single: 2, essay: 3 });
    expect(plan).toEqual(['single', 'single']);
  });

  it('配额全是 0 → 退回轮转', () => {
    const plan = planKinds(['single', 'essay'], 4, { single: 0, essay: 0 });
    expect(plan).toEqual(['single', 'essay', 'single', 'essay']);
  });

  it('负数按 0 处理', () => {
    const plan = planKinds(['single', 'essay'], 2, { single: -5, essay: 2 });
    expect(plan).toEqual(['essay', 'essay']);
  });
});

describe('planKinds：没有配额时退旧行为', () => {
  it('按 kinds 轮流', () => {
    expect(planKinds(['single', 'essay'], 5)).toEqual([
      'single',
      'essay',
      'single',
      'essay',
      'single',
    ]);
  });

  it('6 道 3 种 → 2/2/2', () => {
    const plan = planKinds(['single', 'multiple', 'blank'], 6);
    const count = plan.reduce<Record<string, number>>((acc, k) => {
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    expect(count).toEqual({ single: 2, multiple: 2, blank: 2 });
  });
});

describe('planKinds：边界', () => {
  it('kinds 为空 → 空计划', () => {
    expect(planKinds([], 5)).toEqual([]);
  });

  it('count 为 0 → 空计划', () => {
    expect(planKinds(['single'], 0)).toEqual([]);
  });

  it('count 为负 → 空计划', () => {
    expect(planKinds(['single'], -3)).toEqual([]);
  });

  it('小数配额向下取整', () => {
    const plan = planKinds(['single'], 5, { single: 2.9 });
    expect(plan).toEqual(['single', 'single']);
  });
});

/*
 * 真实场景回归：用户勾了单选+判断+填空，想要 4/3/3。
 * 旧行为会给 4/3/3 吗？6 道 3 种是 2/2/2，10 道才是 4/3/3 —— 但不保证顺序与比例。
 * 现在可以精确指定。
 */
describe('真实场景', () => {
  it('10 道：4 单选 + 3 判断 + 3 填空', () => {
    const kinds: QuestionKind[] = ['single', 'truefalse', 'blank'];
    const plan = planKinds(kinds, 10, { single: 4, truefalse: 3, blank: 3 });
    expect(plan.filter((k) => k === 'single')).toHaveLength(4);
    expect(plan.filter((k) => k === 'truefalse')).toHaveLength(3);
    expect(plan.filter((k) => k === 'blank')).toHaveLength(3);
    expect(plan).toHaveLength(10);
  });

  it('批次切分：全局 10 道，每批 4 道 → 各批数量相加等于 10', () => {
    /*
     * 真实后端分批请求（countPerRequest）。每批的配额必须由全局序列切出，
     * 而不是「每批都按全局比例重新算」—— 那样会累计漂移。
     */
    const kinds: QuestionKind[] = ['single', 'essay'];
    const global = planKinds(kinds, 10, { single: 7, essay: 3 });

    const batches = [global.slice(0, 4), global.slice(4, 8), global.slice(8, 10)];
    const flat = batches.flat();
    expect(flat).toEqual(global);
    expect(flat.filter((k) => k === 'single')).toHaveLength(7);
    expect(flat.filter((k) => k === 'essay')).toHaveLength(3);
  });
});
