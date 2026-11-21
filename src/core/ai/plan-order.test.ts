import { describe, expect, it } from 'vitest';
import {
  buildPlanPrompt,
  flattenPlan,
  parsePlanOrder,
  planProgress,
  suggestBlockRange,
  type PlanPointInput,
} from './plan-order.ts';

/**
 * AI 学习顺序的纯逻辑（2026-11-21）。
 *
 * ## 这组测试的重点不是「happy path 能解析」
 *
 * 而是三类**坏结果**：
 *  1. 残缺 JSON 必须整轮拒绝 —— 半份排序比报错更难发现
 *  2. 编号越界/重复必须丢弃 —— 编号指错对象时宁可不排
 *  3. 难度非法必须置 null 而不是猜 —— 假难度比没有难度更糟
 *
 * 每写一条断言都问过一遍：「坏实现能不能通过它？」
 * （项目踩过「断言写得够宽 = 没在验」四次）
 */

function point(over: Partial<PlanPointInput> = {}): PlanPointInput {
  return {
    id: 'kp-x',
    statement: '默认表述',
    chapter: null,
    cognitiveLevel: 'understand',
    mastery: 0,
    wrongCount: 0,
    daysSinceReview: null,
    ...over,
  };
}

/** 造 12 条知识点，够触发「5–8 块」那一档 */
function manyPoints(n = 12): PlanPointInput[] {
  return Array.from({ length: n }, (_, i) =>
    point({ id: `kp-${i + 1}`, statement: `第${i + 1}条表述` }),
  );
}

describe('suggestBlockRange', () => {
  it('条数少时不逼模型分很多块', () => {
    /*
     * 4 条知识点逼它分 5 块，它只能拆条或编块名 —— 两者都是坏结果。
     */
    expect(suggestBlockRange(4)).toEqual({ min: 2, max: 3 });
  });

  it('条数多时给 5–8 块（一屏能扫完的层级）', () => {
    expect(suggestBlockRange(12)).toEqual({ min: 3, max: 5 });
    expect(suggestBlockRange(105)).toEqual({ min: 5, max: 8 });
  });

  it('零条也有返回值，不抛错', () => {
    expect(suggestBlockRange(0)).toEqual({ min: 1, max: 1 });
  });
});

describe('buildPlanPrompt', () => {
  it('知识点用编号列出，不给模型 id', () => {
    const points = manyPoints(3);
    const { user } = buildPlanPrompt(points);
    expect(user).toContain('1. 第1条表述');
    expect(user).toContain('3. 第3条表述');
    expect(user).not.toContain('kp-');
  });

  it('提示词明确区分「难度」与「掌握度」', () => {
    /*
     * 这是 LogiNote 最值得学的一条：它明确防过
     * 「把已有笔记等同于已经掌握」。我们比它更强 ——
     * 难度由模型给、掌握度由本地算，两者在提示词里分开写。
     *
     * 断言查**具体表述**而不是「包含难度二字」：
     * 一句泛泛的「注意难度」也能过后者。
     */
    const { system } = buildPlanPrompt(manyPoints(3));
    expect(system).toContain('难度由你判断');
    expect(system).toContain('掌握度不是你的事');
    /* 反向证据：要写清「没练过 ≠ 很难」 */
    expect(system).toContain('没练过');
    expect(system).toContain('不要因为');
  });

  it('提示词要求理由与依据（与 LogiNote 刻意相反）', () => {
    /*
     * LogiNote 为省 token 砍掉了理由字段，代价是用户看不懂为什么这么排。
     * 这里必须保留：reason 给用户看，basis 说明凭什么。
     */
    const { system } = buildPlanPrompt(manyPoints(3));
    expect(system).toContain('必须给理由');
    expect(system).toContain('"reason"');
    expect(system).toContain('"basis"');
    expect(system).toContain('没有理由的排序对用户没有价值');
  });

  it('提示词声明残缺 JSON 会被整份丢弃', () => {
    const { system } = buildPlanPrompt(manyPoints(3));
    expect(system).toContain('JSON 必须完整');
    expect(system).toContain('残缺');
  });

  it('块数范围写进提示词', () => {
    const { system, user } = buildPlanPrompt(manyPoints(12));
    expect(system).toContain('3–5 块');
    expect(user).toContain('3–5 块');
  });

  it('掌握度写成文字，不写数字', () => {
    /*
     * 数字 0.03 会被模型拿去做奇怪的事（当成难度）。
     * 写「没练过」是人话，也不给「把掌握度当难度」留诱导。
     */
    const points = [
      point({ id: 'a', statement: '线性表是有限序列', mastery: 0.03, daysSinceReview: 3 }),
    ];
    const { user } = buildPlanPrompt(points);
    expect(user).toContain('刚起步');
    expect(user).not.toContain('0.03');
  });

  it('从没练过时写「没练过」，不写「0」', () => {
    /* mastery > 0 而 daysSinceReview 为 null 是自相矛盾的输入（练过才有分） */
    const points = [point({ id: 'a', statement: 'x', mastery: 0, daysSinceReview: null })];
    const { user } = buildPlanPrompt(points);
    expect(user).toContain('没练过');
  });

  it('错过题时优先说「错过 N 次」（信息量比档位大）', () => {
    const points = [
      point({ id: 'a', statement: 'x', mastery: 0.4, wrongCount: 3, daysSinceReview: 2 }),
    ];
    const { user } = buildPlanPrompt(points);
    expect(user).toContain('错过3次');
  });

  it('没有章节时不写「无章节」占位（否则模型可能开始编章节名）', () => {
    const points = [point({ id: 'a', statement: 'x', chapter: null })];
    const { user } = buildPlanPrompt(points);
    expect(user).not.toContain('无章节');
    expect(user).not.toContain('null');
  });

  it('有章节时带上章节名', () => {
    const points = [point({ id: 'a', statement: 'x', chapter: '第2章' })];
    const { user } = buildPlanPrompt(points);
    expect(user).toContain('第2章');
  });
});

describe('parsePlanOrder：整轮拒绝', () => {
  const points = manyPoints(5);

  it('空内容整轮拒绝', () => {
    const r = parsePlanOrder('', points);
    expect(r.ok).toBe(false);
  });

  it('截断的 JSON 整轮拒绝（不修补括号）', () => {
    /*
     * 这条是本模块最重要的一条断言。
     * 与 LogiNote 一致：绝不修补括号、绝不续写残片。
     * 半份排序比报错更难发现 —— 用户以为排完了。
     */
    const truncated = '{"blocks":[{"title":"块1","items":[{"n":1,"difficulty":2}]}';
    const r = parsePlanOrder(truncated, points);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不完整');
  });

  it('括号不配对但看起来能解析的也不放过', () => {
    const r = parsePlanOrder('{"blocks": [{"title":"a","items":[]}]]}', points);
    expect(r.ok).toBe(false);
  });

  it('没有 blocks 数组整轮拒绝', () => {
    const r = parsePlanOrder('{"list":[{"n":1}]}', points);
    expect(r.ok).toBe(false);
  });

  it('blocks 是空数组整轮拒绝（不是「排完了」）', () => {
    const r = parsePlanOrder('{"blocks":[]}', points);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('没有任何一条有效知识点');
  });

  it('全是无效编号时整轮拒绝（否则会返回一个空路径当成功）', () => {
    const r = parsePlanOrder('{"blocks":[{"title":"a","items":[{"n":99},{"n":100}]}]}', points);
    expect(r.ok).toBe(false);
  });

  it('顶层是数组不算成功', () => {
    const r = parsePlanOrder('[{"n":1}]', points);
    expect(r.ok).toBe(false);
  });

  it('知识点清单为空时拒绝', () => {
    const r = parsePlanOrder('{"blocks":[{"title":"a","items":[{"n":1}]}]}', []);
    expect(r.ok).toBe(false);
  });
});

describe('parsePlanOrder：正常解析', () => {
  const points = manyPoints(5);

  it('编号映射回真实 id，order 按数组位置连续递增', () => {
    const content = JSON.stringify({
      blocks: [
        {
          title: '基础',
          why: '先打地基',
          items: [
            { n: 3, difficulty: 1, reason: '最简单', basis: '认知层级最低' },
            { n: 1, difficulty: 2, reason: '其次', basis: '前置' },
          ],
        },
        {
          title: '进阶',
          why: '再往上',
          items: [{ n: 5, difficulty: 4, reason: '最难放最后', basis: '应用层' }],
        },
      ],
    });

    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.plan.blocks).toHaveLength(2);
    expect(r.plan.blocks[0]!.title).toBe('基础');

    /* 编号 3 → points[2] 的 id */
    expect(r.plan.blocks[0]!.items[0]!.pointId).toBe('kp-3');
    expect(r.plan.blocks[0]!.items[1]!.pointId).toBe('kp-1');
    expect(r.plan.blocks[1]!.items[0]!.pointId).toBe('kp-5');

    /*
     * order 是本地派的：1,2,3 —— 不管模型怎么写。
     * 让模型同时写块顺序和条内序号会多一个出错面：
     * 它的块顺序和序号完全可能互相矛盾。
     */
    const flat = flattenPlan(r.plan);
    expect(flat.map((i) => i.order)).toEqual([1, 2, 3]);
    expect(flat.map((i) => i.blockIndex)).toEqual([0, 0, 1]);
  });

  it('没被排进来的编号如实返回（不许悄悄消失）', () => {
    /* 5 条里只排了 2 条 */
    const content = '{"blocks":[{"title":"a","why":"","items":[{"n":1},{"n":2}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.unplaced).toEqual([3, 4, 5]);
  });

  it('带 markdown 围栏也能解析（模型常包一层）', () => {
    const content = '好的，这是结果：\n```json\n{"blocks":[{"title":"a","items":[{"n":1}]}]}\n```\n以上。';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.items[0]!.pointId).toBe('kp-1');
  });

  it('n 是字符串 "3" 也能认（实测会遇到）', () => {
    const r = parsePlanOrder('{"blocks":[{"title":"a","items":[{"n":"3"}]}]}', points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.items[0]!.pointId).toBe('kp-3');
  });

  it('字符串里的花括号不干扰配对扫描', () => {
    /*
     * 自己扫括号深度的理由：statement 或 reason 里出现 "{" 是可能的。
     * 不跳过字符串内部就会误判配对位置。
     */
    const content = '{"blocks":[{"title":"a","items":[{"n":1,"reason":"用 {x} 表示"}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.items[0]!.reason).toBe('用 {x} 表示');
  });
});

describe('parsePlanOrder：单条丢弃', () => {
  const points = manyPoints(5);

  it('编号越界丢弃，其余保留', () => {
    const content = '{"blocks":[{"title":"a","items":[{"n":1},{"n":99},{"n":2}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flat = flattenPlan(r.plan);
    expect(flat.map((i) => i.pointId)).toEqual(['kp-1', 'kp-2']);
    expect(r.plan.dropped).toBe(1);
  });

  it('编号为 0 或负数丢弃（编号是 1 基）', () => {
    const content = '{"blocks":[{"title":"a","items":[{"n":0},{"n":-1},{"n":1}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(flattenPlan(r.plan)).toHaveLength(1);
  });

  it('重复编号只留第一次出现的位置', () => {
    const content =
      '{"blocks":[{"title":"a","items":[{"n":2}]},{"title":"b","items":[{"n":2},{"n":3}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flat = flattenPlan(r.plan);
    expect(flat.map((i) => i.pointId)).toEqual(['kp-2', 'kp-3']);
    /* 重复的那个被丢 */
    expect(r.plan.dropped).toBe(1);
  });

  it('n 是非整数的数字丢弃（不四舍五入猜）', () => {
    const content = '{"blocks":[{"title":"a","items":[{"n":1.5},{"n":1}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(flattenPlan(r.plan)).toHaveLength(1);
  });

  it('难度越界置 null，条目保留（不是丢掉条目）', () => {
    /*
     * 与「编号越界就丢」不同：编号错了不知道它指哪条，只能丢；
     * 难度错了条目本身还是对的，丢掉反而损失顺序信息。
     * 夹到边界值也不行 —— 那是替模型编了一个它没说过的判断。
     */
    const content = '{"blocks":[{"title":"a","items":[{"n":1,"difficulty":9}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.plan.blocks[0]!.items[0]!;
    expect(item.pointId).toBe('kp-1');
    expect(item.difficulty).toBeNull();
  });

  it('难度缺失/非数字也置 null', () => {
    const content = '{"blocks":[{"title":"a","items":[{"n":1},{"n":2,"difficulty":"难"}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocks[0]!.items[0]!.difficulty).toBeNull();
    expect(r.plan.blocks[0]!.items[1]!.difficulty).toBeNull();
  });

  it('难度合法值原样保留', () => {
    const content = '{"blocks":[{"title":"a","items":[{"n":1,"difficulty":5}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.items[0]!.difficulty).toBe(5);
  });

  it('空块被丢弃，块序号重排（不留「第 2 块不见了」的空洞）', () => {
    const content =
      '{"blocks":[{"title":"甲","items":[{"n":1}]},{"title":"空","items":[]},{"title":"丙","items":[{"n":2}]}]}';
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocks).toHaveLength(2);
    expect(r.plan.blocks.map((b) => b.title)).toEqual(['甲', '丙']);
    /* blockIndex 连续，order 也连续 */
    expect(r.plan.blocks[1]!.items[0]!.blockIndex).toBe(1);
    expect(r.plan.blocks[1]!.items[0]!.order).toBe(2);
  });

  it('块没给标题时用「第 N 块」兜底，不留空标题', () => {
    const r = parsePlanOrder('{"blocks":[{"items":[{"n":1}]}]}', points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.title).toBe('第 1 块');
  });

  it('reason 超长被截断，不整条丢', () => {
    const long = 'x'.repeat(200);
    const content = JSON.stringify({ blocks: [{ title: 'a', items: [{ n: 1, reason: long }] }] });
    const r = parsePlanOrder(content, points);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.blocks[0]!.items[0]!.reason.length).toBe(60);
  });
});

describe('planProgress', () => {
  const points = manyPoints(4);
  const plan = parsePlanOrder(
    JSON.stringify({
      blocks: [
        { title: 'a', items: [{ n: 1 }, { n: 2 }] },
        { title: 'b', items: [{ n: 3 }, { n: 4 }] },
      ],
    }),
    points,
  );
  if (!plan.ok) throw new Error('夹具解析失败');

  it('一条都没学过：下一步是第 1 条', () => {
    const p = planProgress(plan.plan, () => false);
    expect(p).toEqual({ learnedCount: 0, total: 4, nextPointId: 'kp-1', nextOrder: 1 });
  });

  it('前两条学过：下一步是第 3 条', () => {
    const learned = new Set(['kp-1', 'kp-2']);
    const p = planProgress(plan.plan, (id) => learned.has(id));
    expect(p.learnedCount).toBe(2);
    expect(p.nextPointId).toBe('kp-3');
    expect(p.nextOrder).toBe(3);
  });

  it('全部学过：没有下一步', () => {
    const p = planProgress(plan.plan, () => true);
    expect(p.learnedCount).toBe(4);
    expect(p.nextPointId).toBeNull();
    expect(p.nextOrder).toBeNull();
  });

  it('学过的是跳着的时候，下一步取**顺序上第一条**没学过的', () => {
    /*
     * 这条例子的意义：用户可能先学了靠后的块（比如他有基础）。
     * 「推到哪一步」应该指向路径上第一条还没学的，不是「最后学的下一条」。
     */
    const learned = new Set(['kp-1', 'kp-3']);
    const p = planProgress(plan.plan, (id) => learned.has(id));
    expect(p.learnedCount).toBe(2);
    expect(p.nextPointId).toBe('kp-2');
    expect(p.nextOrder).toBe(2);
  });
});
