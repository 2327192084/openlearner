import { describe, expect, it } from 'vitest';
import { daysBetween, makeLearnedPredicate, planChapterCandidates } from './plan-inputs.ts';
import type { KnowledgePoint } from '@/core/model.ts';

/**
 * 学习顺序装配层的纯部分（2026-11-21）。
 *
 * `loadPlanInputs` 要读三张表，得靠集成测试；
 * 这里测的是它依赖的几个纯函数 —— 它们更容易写错且错了很难看出来。
 */

describe('daysBetween', () => {
  it('同一天差 0', () => {
    expect(daysBetween('2026-11-21', '2026-11-21')).toBe(0);
  });

  it('跨月正确', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
  });

  it('跨年正确', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('闰年 2 月正确', () => {
    /* 2024 是闰年，2 月有 29 天 */
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    /* 2025 不是 */
    expect(daysBetween('2025-02-28', '2025-03-01')).toBe(1);
  });

  it('反过来是负数（调用方要自己决定要不要 abs）', () => {
    expect(daysBetween('2026-11-21', '2026-11-20')).toBe(-1);
  });

  it('⚠️ 不受本地时区/夏令时影响（这是不用 Date 相减的原因）', () => {
    /*
     * 用 `new Date('2026-11-21')` 解析再相减，在带夏令时的时区
     * 会差一小时，向下取整就变成 0 天而不是 1 天。
     * 这里按 UTC 解析日期串，结果必须是精确的整数天。
     */
    expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1);
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
  });

  it('非法输入返回 0 而不抛错', () => {
    expect(daysBetween('', '2026-11-21')).toBe(0);
    expect(daysBetween('2026-11-21', 'not-a-date')).toBe(0);
  });

  it('带时间的 ISO 串不认（只接受 YYYY-MM-DD）', () => {
    /* 混进来会静默算错，宁可当非法 */
    expect(daysBetween('2026-11-21T10:00:00Z', '2026-11-22')).toBe(0);
  });
});

describe('makeLearnedPredicate', () => {
  const questionIdsByPoint = new Map<string, string[]>([
    ['kp-1', ['q-1', 'q-2']],
    ['kp-2', ['q-3']],
  ]);

  it('知识点自己复习过就算学过', () => {
    const pred = makeLearnedPredicate(
      [{ cardId: 'kp-1', state: { reviewCount: 3 } }],
      questionIdsByPoint,
    );
    expect(pred('kp-1')).toBe(true);
  });

  it('引用它的题目复习过也算学过', () => {
    const pred = makeLearnedPredicate(
      [{ cardId: 'q-3', state: { reviewCount: 1 } }],
      questionIdsByPoint,
    );
    expect(pred('kp-2')).toBe(true);
  });

  it('一条记录都没有 → 没学过', () => {
    const pred = makeLearnedPredicate([], questionIdsByPoint);
    expect(pred('kp-1')).toBe(false);
  });

  it('⚠️ reviewCount 为 0 的记录不算学过', () => {
    /*
     * 有记录但一次都没复习（如刚建卡）：掌握度是 0，
     * 如果按「有记录就算学过」，进度会虚高。
     */
    const pred = makeLearnedPredicate(
      [{ cardId: 'kp-1', state: { reviewCount: 0 } }],
      questionIdsByPoint,
    );
    expect(pred('kp-1')).toBe(false);
  });

  it('没有关联题目的知识点不崩', () => {
    const pred = makeLearnedPredicate([], new Map());
    expect(pred('kp-unknown')).toBe(false);
  });
});

describe('planChapterCandidates', () => {
  function kp(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
    return {
      id: 'kp-1',
      statement: '默认',
      chapter: null,
      cognitiveLevel: 'understand',
      tags: [],
      anchors: [],
      quotes: [],
      anchorStatus: 'located',
      origin: 'material',
      sourceId: 's1',
      backendId: null,
      createdAt: '',
      updatedAt: '',
      ...over,
    } as KnowledgePoint;
  }

  it('只收没有章节的', () => {
    const out = planChapterCandidates([
      kp({ id: 'a', chapter: null }),
      kp({ id: 'b', chapter: '第1章' }),
      kp({ id: 'c', chapter: '  ' }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('带上 sourceId（提示词按资料分组，章节命名要在同一份资料内一致）', () => {
    const out = planChapterCandidates([kp({ id: 'a', sourceId: 'src-9' })]);
    expect(out[0]!.sourceId).toBe('src-9');
  });
});
