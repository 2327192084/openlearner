import { describe, expect, it } from 'vitest';
import {
  clampPage,
  hasReadProgress,
  laterIso,
  mergeReadProgress,
  readLabel,
  readRatio,
  resumeSegmentIndex,
  sortByRecentRead,
  EMPTY_READ_PROGRESS,
  type ReadPosition,
} from './read-progress.ts';
import type { SourceReadProgress } from '@/core/model.ts';

/**
 * 阅读进度逻辑的单测。
 *
 * ## 钉的是哪几条
 *
 * 用户 2026-11-13 定的口径是「读过 = 翻到过的最远页码」。
 * 这个口径最容易在实现里走样的三处：
 *   1. 往回翻时 `furthestPage` 跟着退 → 进度条缩水，像被扣了进度
 *   2. `lastPage` 被 `furthestPage` 覆盖 → 「回到上次位置」回到错的页
 *   3. 乱序上报把 `lastReadAt` 倒退 → 「最近在读」排序乱跳
 *
 * 三条在界面上都**看不出是 bug**，只觉得数字怪。
 */

const pos = (over: Partial<ReadPosition> = {}): ReadPosition => ({
  page: 5,
  segmentIndex: 4,
  scrollTop: 120,
  at: '2026-11-13T10:00:00.000Z',
  ...over,
});

const prog = (over: Partial<SourceReadProgress> = {}): SourceReadProgress => ({
  furthestPage: 10,
  lastPage: 3,
  lastSegmentIndex: 2,
  lastScrollTop: 50,
  lastReadAt: '2026-11-13T09:00:00.000Z',
  ...over,
});

describe('clampPage', () => {
  it('正常值原样返回', () => {
    expect(clampPage(5, 36)).toBe(5);
  });

  it('低于 1 时给 1', () => {
    expect(clampPage(0, 36)).toBe(1);
    expect(clampPage(-3, 36)).toBe(1);
  });

  it('超过总页数时夹到最后一页', () => {
    expect(clampPage(99, 36)).toBe(36);
  });

  it('总页数未知时不夹上限', () => {
    expect(clampPage(999, null)).toBe(999);
    expect(clampPage(999, 0)).toBe(999);
  });

  it('NaN 给 1，不产生 NaN 进度', () => {
    expect(clampPage(Number.NaN, 36)).toBe(1);
  });

  it('小数取整', () => {
    expect(clampPage(5.6, 36)).toBe(6);
  });
});

describe('laterIso', () => {
  it('取较晚的那个', () => {
    expect(laterIso('2026-11-13T09:00:00.000Z', '2026-11-13T10:00:00.000Z')).toBe(
      '2026-11-13T10:00:00.000Z',
    );
  });

  it('任一侧为空串时让位给另一侧', () => {
    expect(laterIso('', '2026-11-13T10:00:00.000Z')).toBe('2026-11-13T10:00:00.000Z');
    expect(laterIso('2026-11-13T10:00:00.000Z', '')).toBe('2026-11-13T10:00:00.000Z');
    expect(laterIso('', '')).toBe('');
  });
});

describe('mergeReadProgress', () => {
  it('第一次读会建出完整记录', () => {
    const r = mergeReadProgress(undefined, pos(), 36);
    expect(r.furthestPage).toBe(5);
    expect(r.lastPage).toBe(5);
    expect(r.lastSegmentIndex).toBe(4);
    expect(r.lastScrollTop).toBe(120);
    expect(r.lastReadAt).toBe('2026-11-13T10:00:00.000Z');
  });

  it('★ 往回翻：furthestPage 不退，lastPage 跟着变小', () => {
    const r = mergeReadProgress(prog({ furthestPage: 10 }), pos({ page: 3 }), 36);
    expect(r.furthestPage).toBe(10); // 读过的最远还是 10
    expect(r.lastPage).toBe(3); // 上次停留是 3
  });

  it('★ 往前翻超过纪录时 furthestPage 才增长', () => {
    const r = mergeReadProgress(prog({ furthestPage: 10 }), pos({ page: 20 }), 36);
    expect(r.furthestPage).toBe(20);
    expect(r.lastPage).toBe(20);
  });

  it('时间戳只往前走（乱序上报不倒退）', () => {
    const r = mergeReadProgress(
      prog({ lastReadAt: '2026-11-13T12:00:00.000Z' }),
      pos({ at: '2026-11-13T08:00:00.000Z' }),
      36,
    );
    expect(r.lastReadAt).toBe('2026-11-13T12:00:00.000Z');
  });

  it('上报的页码超出总页数时夹取', () => {
    const r = mergeReadProgress(undefined, pos({ page: 999 }), 36);
    expect(r.lastPage).toBe(36);
    expect(r.furthestPage).toBe(36);
  });

  it('负的滚动位置归零（布局异常不该留负数）', () => {
    const r = mergeReadProgress(undefined, pos({ scrollTop: -50, segmentIndex: -2 }), 36);
    expect(r.lastScrollTop).toBe(0);
    expect(r.lastSegmentIndex).toBe(0);
  });

  it('不改动传入对象（纯函数）', () => {
    const base = prog();
    const snapshot = JSON.stringify(base);
    mergeReadProgress(base, pos(), 36);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('readRatio', () => {
  it('按最多到过的页算', () => {
    expect(readRatio(prog({ furthestPage: 18 }), 36)).toBeCloseTo(0.5, 5);
  });

  it('没读过返回 0', () => {
    expect(readRatio(undefined, 36)).toBe(0);
    expect(readRatio(EMPTY_READ_PROGRESS, 36)).toBe(0);
  });

  it('总页数未知返回 0（不编一个百分比）', () => {
    expect(readRatio(prog({ furthestPage: 18 }), null)).toBe(0);
    expect(readRatio(prog({ furthestPage: 18 }), 0)).toBe(0);
  });

  it('不超过 1（数据写坏时也不越界）', () => {
    expect(readRatio(prog({ furthestPage: 999 }), 36)).toBe(1);
  });
});

describe('readLabel', () => {
  it('没读过说「还没读过」', () => {
    expect(readLabel(undefined, 36)).toBe('还没读过');
    expect(readLabel(EMPTY_READ_PROGRESS, 36)).toBe('还没读过');
  });

  it('★ 写「到过第 N/M 页」，不写「已读 N 页」', () => {
    const label = readLabel(prog({ furthestPage: 18 }), 36);
    expect(label).toBe('到过第 18/36 页');
    /*
     * 这一条是口径问题：用户选的「最远页码」意味着跳读也算。
     * 界面写「已读」会让人以为逐页读完，比实际更强 —— 不许。
     */
    expect(label).not.toContain('已读');
  });

  it('总页数未知时只报页码', () => {
    expect(readLabel(prog({ furthestPage: 18 }), null)).toBe('到过第 18 页');
  });
});

describe('hasReadProgress', () => {
  it('有读到过才算有记录', () => {
    expect(hasReadProgress(prog({ furthestPage: 5 }))).toBe(true);
    expect(hasReadProgress(EMPTY_READ_PROGRESS)).toBe(false);
    expect(hasReadProgress(undefined)).toBe(false);
    expect(hasReadProgress(null)).toBe(false);
  });
});

describe('resumeSegmentIndex', () => {
  it('有记录时回到上次那一段', () => {
    expect(resumeSegmentIndex(prog({ lastSegmentIndex: 7 }), 36)).toBe(7);
  });

  it('没记录返回 null（调用方从第一段开始）', () => {
    expect(resumeSegmentIndex(undefined, 36)).toBeNull();
    expect(resumeSegmentIndex(EMPTY_READ_PROGRESS, 36)).toBeNull();
  });

  it('索引越界返回 null（资料被重新解析、段数变少）', () => {
    expect(resumeSegmentIndex(prog({ lastSegmentIndex: 50 }), 36)).toBeNull();
    expect(resumeSegmentIndex(prog({ lastSegmentIndex: -1 }), 36)).toBeNull();
  });

  it('资料没有正文时返回 null', () => {
    expect(resumeSegmentIndex(prog({ lastSegmentIndex: 3 }), 0)).toBeNull();
  });
});

describe('sortByRecentRead', () => {
  it('最近读的排前面，没读过的排最后', () => {
    const items = [
      { id: 'never' },
      { id: 'old', readProgress: prog({ lastReadAt: '2026-11-10T00:00:00.000Z' }) },
      { id: 'new', readProgress: prog({ lastReadAt: '2026-11-13T00:00:00.000Z' }) },
    ];
    expect(sortByRecentRead(items).map((x) => x.id)).toEqual(['new', 'old', 'never']);
  });

  it('不改动传入数组', () => {
    const items = [{ id: 'a' }, { id: 'b', readProgress: prog() }];
    const before = items.map((x) => x.id);
    sortByRecentRead(items);
    expect(items.map((x) => x.id)).toEqual(before);
  });
});
