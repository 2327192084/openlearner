import { describe, expect, it } from 'vitest';
import {
  chapterKey,
  columnSpan,
  edgeSpan,
  layoutTree,
  ROOT_KEY,
  sectionKey,
  TREE_METRICS,
} from './tree-layout.ts';

/**
 * 树状学习地图的布局（2026-11-22，第 4 步）。
 *
 * 这组测试的目标不是"数字对不对"，而是**三个会真的画错的地方**：
 *
 * 1. 根节点随展开移动 → 点开一章整棵树跳一下，视线被拽走
 * 2. 章→小节画成链而不是分叉 → 树看起来像一条折线
 * 3. 折叠时根→章的线消失 → 收起后图变成"孤零零几个卡片"
 *
 * 每一条都写了"坏实现能通过它吗"的注释。
 */

const M = TREE_METRICS;

/** 造 N 个章，每章 `per[]` 指定小节数 */
function input(per: number[], expanded: number | null) {
  return { chapters: per.map((n) => ({ sectionCount: n })), expanded };
}

describe('layoutTree：基本几何', () => {
  it('根节点在最左列，章在中间，小节在右列（x 严格递增）', () => {
    const r = layoutTree(input([3, 3, 3], 1));
    expect(r.root.x).toBe(0);
    expect(r.chapters[0]!.x).toBeGreaterThan(r.root.x + r.root.w);
    expect(r.sections[0]!.x).toBeGreaterThan(r.chapters[0]!.x + r.chapters[0]!.w);
  });

  it('根节点与章节点不在同一 x 上重叠（有列间距）', () => {
    const r = layoutTree(input([2], null));
    /* 坏实现：把根和章都放 x=0 → 卡片直接叠在一起 */
    expect(r.chapters[0]!.x).toBe(r.root.x + r.root.w + M.colGap);
  });

  it('章与章竖直等距，互不重叠', () => {
    const r = layoutTree(input([2, 2, 2], null));
    for (let i = 1; i < r.chapters.length; i += 1) {
      const prev = r.chapters[i - 1]!;
      const cur = r.chapters[i]!;
      expect(cur.y).toBe(prev.y + prev.h + M.chapterGap);
      expect(cur.y).toBeGreaterThan(prev.y + prev.h);
    }
  });

  it('折叠时一行小节都不产生', () => {
    const r = layoutTree(input([5, 5], null));
    expect(r.sections).toEqual([]);
    /* 折叠时宽度只到章那一列 */
    expect(r.width).toBe(M.rootW + M.colGap + M.chapterW);
  });

  it('零章：只有根节点，尺寸不崩', () => {
    const r = layoutTree(input([], null));
    expect(r.chapters).toEqual([]);
    expect(r.sections).toEqual([]);
    expect(r.root.y).toBe(0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBe(M.rootH);
  });
});

describe('layoutTree：⚠️ 根节点不能随展开移动', () => {
  /**
   * 这是本文件最重要的一条。
   *
   * 坏实现：根节点按**整图**高度居中。那样展开一个靠下的章时，
   * 图变高了，根节点跟着下移 —— 用户点一下，整棵树的根在眼前跳走。
   *
   * 判据必须覆盖「展开靠下的章」这种最容易露馅的情形，
   * 只测第 0 章的话坏实现也能通过。
   */
  it('展开第 0 章 / 中间章 / 最后一章，根节点 y 完全相同', () => {
    const base = layoutTree(input([3, 3, 3, 3], null)).root.y;
    for (const idx of [0, 1, 2, 3]) {
      expect(layoutTree(input([3, 3, 3, 3], idx)).root.y).toBe(base);
    }
  });

  it('展开小节很多的靠下的章，根节点也不动', () => {
    /* 最后一章 12 个小节 → 小节列远比章列高，整图居中会把根拉下去 */
    const base = layoutTree(input([2, 2, 12], null)).root.y;
    expect(layoutTree(input([2, 2, 12], 2)).root.y).toBe(base);
  });

  it('根节点垂直居中于章那一列', () => {
    const r = layoutTree(input([2, 2, 2, 2], null));
    const stackH = columnSpan(r.chapters);
    const rootCenter = r.root.y + r.root.h / 2;
    const stackCenter = r.chapters[0]!.y + stackH / 2;
    /* 允许 1px 取整误差 */
    expect(Math.abs(rootCenter - stackCenter)).toBeLessThanOrEqual(1);
  });
});

describe('layoutTree：⚠️ 章→小节必须是分叉，不是链', () => {
  /**
   * 坏实现：`for (i) edge(section[i-1], section[i])` —— 画成一条竖链，
   * 看起来像"小节要按顺序走完"，而用户明确要求章节可以并行、
   * 小节是同一个父章的并列组成。
   *
   * 判据：所有章→小节的边**起点坐标相同**（同一个分叉点）。
   */
  it('所有章→小节的边起点相同（同一个分叉点）', () => {
    const r = layoutTree(input([4], 0));
    const secEdges = r.edges.filter((e) => e.kind === 'chapter-section');
    expect(secEdges.length).toBe(4);

    const starts = secEdges.map((e) => {
      /* path 形如 `M x y C ...`，取前两个数字 */
      const m = /^M (-?[0-9.]+) (-?[0-9.]+)/.exec(e.d);
      expect(m).not.toBeNull();
      return `${m![1]},${m![2]}`;
    });
    /* 4 条边的起点必须完全一致 */
    expect(new Set(starts).size).toBe(1);
  });

  it('章→小节的边起点在父章卡片的右缘中点', () => {
    const r = layoutTree(input([3], 0));
    const parent = r.chapters[0]!;
    const wantX = parent.x + parent.w;
    const wantY = parent.y + parent.h / 2;

    for (const e of r.edges.filter((x) => x.kind === 'chapter-section')) {
      const m = /^M (-?[0-9.]+) (-?[0-9.]+)/.exec(e.d);
      expect(Number(m![1])).toBe(wantX);
      expect(Number(m![2])).toBe(wantY);
    }
  });

  it('每条边的终点落在目标卡片的左缘中点', () => {
    const r = layoutTree(input([2, 3], 1));
    const byKey = new Map<string, (typeof r.chapters)[number]>();
    for (const b of [...r.chapters, ...r.sections]) byKey.set(b.key, b);
    byKey.set(ROOT_KEY, r.root);

    for (const e of r.edges) {
      const to = byKey.get(e.to);
      expect(to).toBeDefined();
      const m = /(-?[0-9.]+) (-?[0-9.]+)$/.exec(e.d);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(to!.x);
      expect(Number(m![2])).toBe(to!.y + to!.h / 2);
    }
  });

  it('只画展开那一章的章→小节边（其余章没有边）', () => {
    const r = layoutTree(input([2, 5, 2], 1));
    const secEdges = r.edges.filter((e) => e.kind === 'chapter-section');
    expect(secEdges.length).toBe(5);
    /* 全部来自 ch-1 */
    expect(secEdges.every((e) => e.from === chapterKey(1))).toBe(true);
    /* 别的章的 key 一条都不该出现 */
    expect(secEdges.some((e) => e.from === chapterKey(0))).toBe(false);
    expect(secEdges.some((e) => e.from === chapterKey(2))).toBe(false);
  });
});

describe('layoutTree：折叠时骨架仍在', () => {
  /**
   * 坏实现：只在"有展开"时才画根→章的线。
   * 那样全部折叠后图只剩几个孤立卡片 —— 用户看不出这是"一棵树"。
   */
  it('全部折叠时根→章的边一条不少', () => {
    const r = layoutTree(input([2, 2, 2, 2, 2], null));
    const rootEdges = r.edges.filter((e) => e.kind === 'root-chapter');
    expect(rootEdges.length).toBe(5);
    expect(rootEdges.every((e) => e.from === ROOT_KEY)).toBe(true);
  });

  it('根→章的边终点在章卡片左缘中点（没连到小节上去）', () => {
    const r = layoutTree(input([3, 3], 0));
    const rootEdges = r.edges.filter((e) => e.kind === 'root-chapter');
    expect(rootEdges.length).toBe(2);
    for (const e of rootEdges) {
      const m = /(-?[0-9.]+) (-?[0-9.]+)$/.exec(e.d);
      const ch = r.chapters.find((c) => c.key === e.to)!;
      expect(Number(m![1])).toBe(ch.x);
      expect(Number(m![2])).toBe(ch.y + ch.h / 2);
    }
  });
});

describe('layoutTree：小节的竖直位置', () => {
  /**
   * ⚠️ 居中与不越界是**有冲突**的，这里明确取了后者。
   *
   * 第 0 章的章中心只有 34px，而 3 个小节高 182px。真居中就要
   * top = 34 - 91 = -57 —— 负坐标会被 SVG viewBox 裁掉上半截。
   *
   * 所以：**能居中就居中，不能就贴顶**。
   * 代价是第一章节多时，分叉点比小节列中心高一点；
   * 视觉上反而更像"从章往下扇开"，可接受。
   *
   * 下面这条测「不会越界的情形」确实居中 ——
   * 只测第 0 章的话，坏实现（永远贴顶）也能通过。
   */
  it('空间够时，小节竖直居中于父章中心', () => {
    /* 第 2 章的章中心在 198px，2 个小节只要 118px，够居中 */
    const r = layoutTree(input([1, 1, 2, 1], 2));
    const parent = r.chapters[2]!;
    const parentCenter = parent.y + parent.h / 2;
    const top = r.sections[0]!.y;
    const bottom = r.sections[1]!.y + r.sections[1]!.h;
    const mid = (top + bottom) / 2;
    expect(Math.abs(mid - parentCenter)).toBeLessThanOrEqual(1);
  });

  it('空间不够时贴顶（宁可偏上也不产生负坐标 —— 负坐标会被裁掉）', () => {
    const r = layoutTree(input([3], 0));
    expect(r.sections[0]!.y).toBe(0);
    /*
     * 贴顶之后就不再居中 —— 这是刻意的取舍。
     * 如果有人把 max(0, …) 去掉来"修"这条，下面的断言会红。
     */
    const parentCenter = r.chapters[0]!.y + r.chapters[0]!.h / 2;
    const mid = (r.sections[0]!.y + r.sections[2]!.y + r.sections[2]!.h) / 2;
    expect(mid).toBeGreaterThan(parentCenter);
  });

  it('小节之间不重叠，间距等于 sectionGap', () => {
    const r = layoutTree(input([4], 0));
    for (let i = 1; i < r.sections.length; i += 1) {
      const prev = r.sections[i - 1]!;
      const cur = r.sections[i]!;
      expect(cur.y).toBe(prev.y + prev.h + M.sectionGap);
    }
  });

  it('⚠️ 小节很多时会把整列下移到 0 起（不产生负坐标）', () => {
    /*
     * 第 0 章只有 1 章时，章中心在 34px。如果这一章有 10 个小节
     * （列高约 640px），居中会算出负的 top —— SVG viewBox 会裁掉上半截。
     * 坏实现：直接 `parentCenterY - stackH/2` 不做 max(0, ...)。
     */
    const r = layoutTree(input([10], 0));
    expect(r.sections[0]!.y).toBeGreaterThanOrEqual(0);
    /* 而且不能让任何一个盒子有负 y */
    for (const b of [...r.chapters, ...r.sections, r.root]) {
      expect(b.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('整图高度覆盖到最后一个小的底部（不裁掉）', () => {
    const r = layoutTree(input([12], 0));
    const last = r.sections[r.sections.length - 1]!;
    expect(r.height).toBeGreaterThanOrEqual(last.y + last.h);
  });
});

describe('layoutTree：坏输入不崩', () => {
  it('展开索引越界按「没展开」处理，不抛错', () => {
    expect(() => layoutTree(input([2, 2], 5))).not.toThrow();
    const r = layoutTree(input([2, 2], 5));
    expect(r.sections).toEqual([]);
    expect(r.edges.filter((e) => e.kind === 'chapter-section')).toEqual([]);
  });

  it('展开索引为负也按「没展开」处理', () => {
    const r = layoutTree(input([2], -1));
    expect(r.sections).toEqual([]);
  });

  it('展开一个 0 小节的章：不产生小节、也不产生章→小节边', () => {
    /*
     * 真实会发生：`normalizeSourceTree` 保证每章至少一个节点，
     * 但 AI 兜底失败的章可能是 0 —— 界面不该因此画出空连线。
     */
    const r = layoutTree(input([0, 3], 0));
    expect(r.sections).toEqual([]);
    expect(r.edges.filter((e) => e.kind === 'chapter-section')).toEqual([]);
    /* 但根→章的骨架还在 */
    expect(r.edges.filter((e) => e.kind === 'root-chapter').length).toBe(2);
  });
});

describe('key 与辅助函数', () => {
  it('小节 key 带父章索引 —— 不同章的同号小节不撞 key', () => {
    expect(sectionKey(0, 1)).not.toBe(sectionKey(1, 1));
  });

  it('章 key 可区分', () => {
    expect(chapterKey(0)).not.toBe(chapterKey(1));
  });

  it('edgeSpan 是正的，且在水平方向上至少跨过列间距', () => {
    const r = layoutTree(input([2], 0));
    const span = edgeSpan(r.chapters[0]!, r.sections[0]!);
    expect(span).toBeGreaterThanOrEqual(M.colGap);
  });

  it('columnSpan 空数组返回 0', () => {
    expect(columnSpan([])).toBe(0);
  });
});