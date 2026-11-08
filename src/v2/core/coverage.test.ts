import { describe, expect, it } from 'vitest';
import {
  coverageOf,
  describeGap,
  gapsOf,
  toCoverSegments,
  type CoverCard,
  type CoverSegment,
} from './coverage.ts';

/**
 * 覆盖度。
 *
 * 参考 StudyHub `lib/coverage.js` 的设计：单位是叶子段落、三种状态、
 * 纯函数、给出两个百分比（按段与按字符）。
 *
 * 我们少一种状态（planned-failed），因为没有「出题计划」这个数据结构 ——
 * 这一点在实现注释里说明了，测试也不再假装有。
 */

const seg = (page: number, charCount = 100, chapter: string | null = null): CoverSegment => ({
  id: `seg_${page}`,
  sourceId: 's1',
  page,
  chapter,
  charCount,
});

const card = (id: string, pages: number[], sourceId = 's1'): CoverCard => ({
  id,
  anchors: pages.map((page) => ({ sourceId, page })),
});

describe('coverageOf：基本统计', () => {
  it('空资料 → 全零，不除零崩溃', () => {
    const c = coverageOf('s1', [], []);
    expect(c.leaves).toBe(0);
    expect(c.percentLeaves).toBe(0);
    expect(c.percentChars).toBe(0);
    expect(c.perTenK).toBe(0);
  });

  it('有题落在某页 → 那页 covered', () => {
    const c = coverageOf('s1', [seg(1), seg(2), seg(3)], [card('q1', [2])]);
    expect(c.covered).toBe(1);
    expect(c.neverPlanned).toBe(2);
    expect(c.leaves).toBe(3);
    expect(c.sections.find((s) => s.page === 2)!.state).toBe('covered');
    expect(c.sections.find((s) => s.page === 1)!.state).toBe('never-planned');
  });

  it('同一页多道题 → cards 累加，但只算一次 covered', () => {
    const c = coverageOf('s1', [seg(1), seg(2)], [card('q1', [1]), card('q2', [1])]);
    expect(c.covered).toBe(1);
    expect(c.sections.find((s) => s.page === 1)!.cards).toBe(2);
  });

  it('百分数取整，不出现小数', () => {
    // 1/3 → 33
    const c = coverageOf('s1', [seg(1), seg(2), seg(3)], [card('q1', [1])]);
    expect(c.percentLeaves).toBe(33);
    expect(Number.isInteger(c.percentLeaves)).toBe(true);
  });

  it('全部覆盖 → 100%', () => {
    const c = coverageOf('s1', [seg(1), seg(2)], [card('q1', [1]), card('q2', [2])]);
    expect(c.percentLeaves).toBe(100);
    expect(c.neverPlanned).toBe(0);
  });

  it('一道题都没有 → 0%，但 leaves 仍在（说明有资料没出题）', () => {
    const c = coverageOf('s1', [seg(1), seg(2)], []);
    expect(c.percentLeaves).toBe(0);
    expect(c.leaves).toBe(2);
    expect(c.cards).toBe(0);
  });
});

describe('coverageOf：按字符的百分比', () => {
  /*
   * 为什么要两个百分比：一段 1000 字的正文和一段 20 字的页眉，
   * 按段算权重一样，按字符算才看得出「内容主要在哪儿」。
   */
  it('字符多的段覆盖后，percentChars 明显高于 percentLeaves', () => {
    const segments = [seg(1, 1000), seg(2, 20), seg(3, 20)];
    const c = coverageOf('s1', segments, [card('q1', [1])]);
    expect(c.percentLeaves).toBe(33); // 1/3 段
    // 1000/(1040) ≈ 96%
    expect(c.percentChars).toBe(96);
    expect(c.percentChars).toBeGreaterThan(c.percentLeaves);
  });

  it('字符全是 0 时不除零', () => {
    const c = coverageOf('s1', [seg(1, 0), seg(2, 0)], [card('q1', [1])]);
    expect(c.percentChars).toBe(0);
    expect(c.perTenK).toBe(0);
  });
});

describe('coverageOf：题目归属', () => {
  it('别的资料的题不算进来', () => {
    const c = coverageOf('s1', [seg(1), seg(2)], [card('q1', [1], 's2')]);
    expect(c.cards).toBe(0);
    expect(c.covered).toBe(0);
  });

  it('一道题有多个 anchors 时只算一次 cards', () => {
    const c = coverageOf('s1', [seg(1), seg(2)], [card('q1', [1, 2])]);
    expect(c.cards).toBe(1);
    // 只计入第一个 anchor 指向的页
    expect(c.covered).toBe(1);
    expect(c.sections.find((s) => s.page === 1)!.state).toBe('covered');
  });

  it('anchor 没有页码（只有 sourceId）→ 算进 cards 但不覆盖任何段', () => {
    const cards: CoverCard[] = [{ id: 'q1', anchors: [{ sourceId: 's1' }] }];
    const c = coverageOf('s1', [seg(1)], cards);
    expect(c.cards).toBe(1);
    expect(c.covered).toBe(0); // 不知道落在哪页，就不假装覆盖了
  });

  it('页码不在资料范围内（越界）→ 忽略，不崩', () => {
    const c = coverageOf('s1', [seg(1)], [card('q1', [999])]);
    expect(c.cards).toBe(1);
    expect(c.covered).toBe(0);
  });

  it('没有 anchors 的题不计入', () => {
    const cards: CoverCard[] = [{ id: 'q1', anchors: [] }];
    expect(coverageOf('s1', [seg(1)], cards).cards).toBe(0);
  });
});

describe('coverageOf：段排序与章节', () => {
  it('段按页码升序，与传入顺序无关', () => {
    const c = coverageOf('s1', [seg(3), seg(1), seg(2)], []);
    expect(c.sections.map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it('章节名带到段上，供界面分组', () => {
    const c = coverageOf('s1', [seg(1, 100, '第1章')], []);
    expect(c.sections[0]!.chapter).toBe('第1章');
  });
});

describe('gapsOf：把没题的页合成区间', () => {
  it('连续没题 → 合成一个区间', () => {
    const c = coverageOf('s1', [seg(1), seg(2), seg(3), seg(4)], [card('q1', [1])]);
    const gaps = gapsOf(c);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 2, to: 4, pages: 3 });
  });

  it('间隔超过 maxGap → 分成两个区间（避免误导成「第 1–36 页」）', () => {
    // 第 2 页和第 10 页都没题，中间隔了 7 页（超过默认 2）
    const segments = Array.from({ length: 12 }, (_, i) => seg(i + 1));
    // 覆盖 3..9 之外都空
    const cards = [3, 4, 5, 6, 7, 8, 9].map((p, i) => card(`q${i}`, [p]));
    const c = coverageOf('s1', segments, cards);
    const gaps = gapsOf(c, 2);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps[0]!.from).toBe(1);
    expect(gaps[gaps.length - 1]!.to).toBe(12);
  });

  it('全都覆盖 → 没有区间', () => {
    const c = coverageOf('s1', [seg(1)], [card('q1', [1])]);
    expect(gapsOf(c)).toEqual([]);
  });

  it('全都没覆盖 → 一个覆盖全范围的大区间', () => {
    const c = coverageOf('s1', [seg(1), seg(2), seg(3)], []);
    const gaps = gapsOf(c);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from: 1, to: 3, pages: 3 });
  });

  it('单页区间', () => {
    const c = coverageOf('s1', [seg(1), seg(2), seg(3)], [card('q1', [1]), card('q2', [3])]);
    const gaps = gapsOf(c);
    expect(gaps).toHaveLength(1);
    expect(describeGap(gaps[0]!)).toBe('第 2 页');
  });
});

describe('describeGap：中文表述', () => {
  it('单页说「第 N 页」', () => {
    expect(describeGap({ from: 5, to: 5, pages: 1 })).toBe('第 5 页');
  });

  it('多页说「第 A–B 页」', () => {
    expect(describeGap({ from: 13, to: 24, pages: 12 })).toBe('第 13–24 页');
  });
});

describe('toCoverSegments：从完整段转换', () => {
  it('只取需要的字段', () => {
    const out = toCoverSegments([
      {
        id: 's1',
        sourceId: 'src',
        index: 1,
        page: 1,
        chapter: 'ch',
        text: '很长的正文……',
        charCount: 7,
      },
    ]);
    expect(out).toEqual([{ id: 's1', sourceId: 'src', page: 1, chapter: 'ch', charCount: 7 }]);
  });
});

/*
 * 真实形状的回归：用户的《信号与系统》36 页，8 道题散在第 2/4/5/8/9/16/18/27 页。
 * 如果这些题都在已发布的题组里，覆盖度应该算出 8/36。
 */
describe('coverageOf：真实资料形状', () => {
  it('36 页资料上 8 道散落的题 → 8 页覆盖', () => {
    const segments = Array.from({ length: 36 }, (_, i) => seg(i + 1, 500));
    const pages = [2, 4, 5, 8, 9, 16, 18, 27];
    const cards = pages.map((p, i) => card(`q${i}`, [p]));
    const c = coverageOf('s1', segments, cards);
    expect(c.leaves).toBe(36);
    expect(c.covered).toBe(8);
    expect(c.neverPlanned).toBe(28);
    expect(c.percentLeaves).toBe(22); // 8/36 ≈ 22%
    expect(c.cards).toBe(8);

    const gaps = gapsOf(c, 2);
    /*
     * 实际算出来的区间（手算核对过）：
     *   有题页 2,4,5,8,9,16,18,27 → 空页 1,3,6,7,10..36
     *   maxGap=2 合并后：[1,3]、[6,7]、[10,36]
     * 最后一段从第 10 页一直到结尾 —— 这正是要给用户看的那句话：
     * 「第 10–36 页从没出过题」。
     */
    expect(gaps).toHaveLength(3);
    expect(gaps[gaps.length - 1]).toMatchObject({ from: 10, to: 36 });
  });
});
