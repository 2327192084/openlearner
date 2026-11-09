import { describe, expect, it } from 'vitest';
import { anchorPrecision, precisionCopy, WHOLE_BLOCK_RATIO } from './anchor-precision.ts';
import type { SourceLocation } from '../model.ts';

/**
 * 定位精度判定（2026-11-09）。
 *
 * 这组测试守的是「界面不许承诺做不到的事」：
 * 从原文出的题只到段落级，就不能显示成「可点回原句」。
 */

describe('anchorPrecision', () => {
  it('没有锚点 → none', () => {
    expect(anchorPrecision(null)).toBe('none');
    expect(anchorPrecision(undefined)).toBe('none');
    expect(anchorPrecision({} as SourceLocation)).toBe('none');
  });

  it('有引文就是 exact，哪怕偏移量是整段', () => {
    /*
     * 这是本项目最重要的判据：引文能让 indexOf 精确定位到那句话，
     * 比只看偏移量可信。所以引文优先于跨度判断。
     */
    const a: SourceLocation = {
      sourceId: 's1',
      page: 9,
      charStart: 0,
      charEnd: 1301,
      quote: '信号与系统的分类',
    };
    expect(anchorPrecision(a, { segmentLength: 1301 })).toBe('exact');
  });

  it('空白引文不算（防「有个空格就当引文」）', () => {
    const a: SourceLocation = {
      sourceId: 's1',
      page: 9,
      charStart: 0,
      charEnd: 1301,
      quote: '   ',
    };
    expect(anchorPrecision(a, { segmentLength: 1301 })).toBe('block');
  });

  it('跨度占整段 ≥ 阈值 → block（从原文出题的典型情况）', () => {
    const a: SourceLocation = { sourceId: 's1', page: 9, charStart: 0, charEnd: 1000 };
    expect(anchorPrecision(a, { segmentLength: 1000 })).toBe('block');
  });

  it('跨度远小于整段 → exact', () => {
    const a: SourceLocation = { sourceId: 's1', page: 9, charStart: 100, charEnd: 180 };
    expect(anchorPrecision(a, { segmentLength: 1000 })).toBe('exact');
  });

  it('刚好在阈值边界上按 block 算', () => {
    const segLen = 1000;
    const span = Math.ceil(segLen * WHOLE_BLOCK_RATIO);
    const a: SourceLocation = { sourceId: 's1', page: 1, charStart: 0, charEnd: span };
    expect(anchorPrecision(a, { segmentLength: segLen })).toBe('block');
  });

  it('查不到段落长度时按跨度绝对值兜底', () => {
    /* 长跨度多半是整段 */
    expect(
      anchorPrecision({ sourceId: 's1', page: 1, charStart: 0, charEnd: 700 }),
    ).toBe('block');
    /* 短跨度像是引文 */
    expect(
      anchorPrecision({ sourceId: 's1', page: 1, charStart: 10, charEnd: 90 }),
    ).toBe('exact');
  });

  it('只有页码没有偏移 → block（页码本身是真信息，不当成 none）', () => {
    expect(anchorPrecision({ sourceId: 's1', page: 12 })).toBe('block');
  });

  it('偏移起点终点相等（空区间）→ 退化成 block 或 none，不报 exact', () => {
    const a: SourceLocation = { sourceId: 's1', page: 3, charStart: 50, charEnd: 50 };
    expect(anchorPrecision(a, { segmentLength: 500 })).not.toBe('exact');
  });
});

describe('precisionCopy', () => {
  it('三档文案互不相同，且都不为空', () => {
    const ex = precisionCopy('exact', 9);
    const bl = precisionCopy('block', 9);
    const no = precisionCopy('none', null);
    const all = [ex, bl, no];
    for (const c of all) {
      expect(c.badge.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
    }
    expect(new Set(all.map((c) => c.badge)).size).toBe(3);
  });

  it('exact 与 block 的徽章必须不同 —— 这是「不说假话」的关键', () => {
    /*
     * 如果两档写同一个徽章，界面就退回到「都承诺能精确定位」，
     * 那这个模块等于没做。
     */
    expect(precisionCopy('exact', 1).badge).not.toBe(precisionCopy('block', 1).badge);
  });

  it('block 的提示要说清「整段」，不能让用户以为能圈到句子', () => {
    expect(precisionCopy('block', 9).hint).toContain('整段');
  });

  it('带页码时提示里出现页码', () => {
    expect(precisionCopy('exact', 9).hint).toContain('第 9 页');
    expect(precisionCopy('block', 12).hint).toContain('第 12 页');
  });

  it('没有页码时不说「第 undefined 页」', () => {
    const c = precisionCopy('exact', null);
    expect(c.hint).not.toContain('undefined');
    expect(c.hint).not.toContain('第');
  });

  it('none 档明说没有位置，不假装', () => {
    const c = precisionCopy('none', 5);
    expect(c.hint).toContain('没有定位');
  });
});
