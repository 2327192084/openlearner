import { describe, expect, it } from 'vitest';
import {
  normalizeStudyPlan,
  planToSteps,
  routeProgress,
  type StudyPlan,
} from './study-plan-store.ts';

/**
 * 学习顺序路线的存储规范化（2026-11-21）。
 *
 * 重点在**坏数据不崩界面**：这个值来自用户库里的一条记录，
 * 可能是手改备份留下的半截对象、上个版本写的、或压根不是我们写的。
 * 强转之后界面会在某个 `steps.map` 上崩掉，用户看到的是整页白屏。
 */

describe('normalizeStudyPlan：拒绝坏数据', () => {
  it('null / undefined / 数组 / 字符串都返回 null', () => {
    expect(normalizeStudyPlan(null)).toBeNull();
    expect(normalizeStudyPlan(undefined)).toBeNull();
    expect(normalizeStudyPlan([])).toBeNull();
    expect(normalizeStudyPlan('abc')).toBeNull();
    expect(normalizeStudyPlan(42)).toBeNull();
  });

  it('没有 steps 数组返回 null', () => {
    expect(normalizeStudyPlan({})).toBeNull();
    expect(normalizeStudyPlan({ steps: 'nope' })).toBeNull();
    expect(normalizeStudyPlan({ steps: {} })).toBeNull();
  });

  it('steps 是空数组返回 null（空路线等于没有路线）', () => {
    expect(normalizeStudyPlan({ steps: [] })).toBeNull();
  });

  it('全部步骤都无效时返回 null（不是「返回到一半」）', () => {
    const r = normalizeStudyPlan({
      steps: [{ pointId: '', order: 1 }, { order: 2 }, { pointId: 'kp-1', order: 0 }],
    });
    expect(r).toBeNull();
  });
});

describe('normalizeStudyPlan：逐条容错', () => {
  it('缺 pointId 的步骤被丢掉，其余保留', () => {
    const r = normalizeStudyPlan({
      steps: [
        { pointId: 'kp-1', order: 1, statement: '一' },
        { order: 2, statement: '缺 id' },
        { pointId: 'kp-3', order: 3, statement: '三' },
      ],
    });
    expect(r?.steps.map((s) => s.pointId)).toEqual(['kp-1', 'kp-3']);
  });

  it('order 非法（0 / 负数 / 非整数）的步骤被丢掉', () => {
    const r = normalizeStudyPlan({
      steps: [
        { pointId: 'a', order: 1 },
        { pointId: 'b', order: 0 },
        { pointId: 'c', order: -5 },
        { pointId: 'd', order: 1.5 },
        { pointId: 'e', order: 'x' },
      ],
    });
    expect(r?.steps.map((s) => s.pointId)).toEqual(['a']);
  });

  it('order 乱序时按 order 排好并重新连续编号', () => {
    /*
     * 「第几步」是相对位置，必须连续。
     * 一个坏记录写着 order: 5, 7, 100 直接信它，
     * 界面上会出现「第 5 步、第 7 步、第 100 步」而学员实际只有 3 步。
     */
    const r = normalizeStudyPlan({
      steps: [
        { pointId: 'c', order: 100 },
        { pointId: 'a', order: 5 },
        { pointId: 'b', order: 7 },
      ],
    });
    expect(r?.steps.map((s) => s.pointId)).toEqual(['a', 'b', 'c']);
    expect(r?.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('重复的 order 也能收敛（sort 稳定，重排后连续）', () => {
    const r = normalizeStudyPlan({
      steps: [
        { pointId: 'a', order: 1 },
        { pointId: 'b', order: 1 },
      ],
    });
    expect(r?.steps.map((s) => s.order)).toEqual([1, 2]);
  });

  it('难度越界/缺失置 null，不夹到边界值', () => {
    const r = normalizeStudyPlan({
      steps: [
        { pointId: 'a', order: 1, difficulty: 9 },
        { pointId: 'b', order: 2, difficulty: 0 },
        { pointId: 'c', order: 3, difficulty: 3 },
        { pointId: 'd', order: 4 },
      ],
    });
    expect(r?.steps.map((s) => s.difficulty)).toEqual([null, null, 3, null]);
  });

  it('超长文本被截断，不整条丢', () => {
    const r = normalizeStudyPlan({
      steps: [{ pointId: 'a', order: 1, reason: 'x'.repeat(200), statement: 'y'.repeat(500) }],
    });
    expect(r?.steps[0]!.reason.length).toBe(60);
    expect(r?.steps[0]!.statement.length).toBe(200);
  });

  it('文本字段类型不对时置空串（不崩）', () => {
    const r = normalizeStudyPlan({
      steps: [{ pointId: 'a', order: 1, reason: 42, basis: {}, statement: null }],
    });
    expect(r?.steps[0]!.reason).toBe('');
    expect(r?.steps[0]!.basis).toBe('');
    expect(r?.steps[0]!.statement).toBe('');
  });

  it('savedAt / unplaced 缺失时不崩', () => {
    const r = normalizeStudyPlan({ steps: [{ pointId: 'a', order: 1 }] });
    expect(r?.savedAt).toBe('');
    expect(r?.unplaced).toBe(0);
  });

  it('savedAt / unplaced 原样保留', () => {
    const r = normalizeStudyPlan({
      steps: [{ pointId: 'a', order: 1 }],
      savedAt: '2026-11-21T10:00:00.000Z',
      unplaced: 7,
    });
    expect(r?.savedAt).toBe('2026-11-21T10:00:00.000Z');
    expect(r?.unplaced).toBe(7);
  });
});

describe('planToSteps', () => {
  it('摊平块与条，带上块标题与陈述快照', () => {
    const steps = planToSteps(
      {
        blocks: [
          {
            title: '基础',
            items: [
              { pointId: 'a', order: 1, blockIndex: 0, difficulty: 1, reason: '最简单', basis: '前置' },
            ],
          },
          {
            title: '进阶',
            items: [
              { pointId: 'b', order: 2, blockIndex: 1, difficulty: 4, reason: '难', basis: '综合' },
            ],
          },
        ],
      },
      (id) => `陈述-${id}`,
    );

    expect(steps).toHaveLength(2);
    expect(steps[0]!.blockTitle).toBe('基础');
    expect(steps[0]!.statement).toBe('陈述-a');
    expect(steps[1]!.blockTitle).toBe('进阶');
    expect(steps[1]!.difficulty).toBe(4);
  });

  it('陈述取不到时存空串，不塞 undefined', () => {
    /* 存 undefined 会被 JSON 序列化丢掉，恢复后那条 step 形状就变了 */
    const steps = planToSteps(
      {
        blocks: [
          { title: 'x', items: [{ pointId: 'a', order: 1, blockIndex: 0, difficulty: null, reason: '', basis: '' }] },
        ],
      },
      () => '',
    );
    expect(steps[0]!.statement).toBe('');
  });
});

describe('routeProgress', () => {
  function plan(...ids: string[]): StudyPlan {
    return {
      steps: ids.map((id, i) => ({
        pointId: id,
        order: i + 1,
        blockIndex: 0,
        blockTitle: '',
        difficulty: null,
        reason: '',
        basis: '',
        statement: '',
      })),
      savedAt: '',
      unplaced: 0,
    };
  }

  it('一条没学过：下一步是第 1 步', () => {
    expect(routeProgress(plan('a', 'b'), () => false)).toEqual({
      learnedCount: 0,
      total: 2,
      nextPointId: 'a',
      nextOrder: 1,
    });
  });

  it('第一条学过：下一步是第 2 步', () => {
    const p = routeProgress(plan('a', 'b'), (id) => id === 'a');
    expect(p.learnedCount).toBe(1);
    expect(p.nextPointId).toBe('b');
    expect(p.nextOrder).toBe(2);
  });

  it('全部学过：没有下一步', () => {
    const p = routeProgress(plan('a', 'b'), () => true);
    expect(p.learnedCount).toBe(2);
    expect(p.nextPointId).toBeNull();
    expect(p.nextOrder).toBeNull();
  });

  it('⚠️ 学过的跳着时，下一步取**顺序上第一条**没学过的', () => {
    /*
     * 用户可能先学了靠后的（比如他有基础）。
     * 「推到哪一步」应指向路径上第一条还没学的，不是「最后学的下一条」。
     */
    const p = routeProgress(plan('a', 'b', 'c'), (id) => id === 'a' || id === 'c');
    expect(p.learnedCount).toBe(2);
    expect(p.nextPointId).toBe('b');
    expect(p.nextOrder).toBe(2);
  });

  it('空路线不崩', () => {
    const p = routeProgress({ steps: [], savedAt: '', unplaced: 0 }, () => false);
    expect(p).toEqual({ learnedCount: 0, total: 0, nextPointId: null, nextOrder: null });
  });
});
