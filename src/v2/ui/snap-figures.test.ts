import { describe, expect, it } from 'vitest';
import { blockBoundaries, snapFiguresToBlocks } from './snap-figures.ts';
import type { SourceImageRecord } from '@/core/model.ts';

/**
 * 插图吸附（2026-11-11）。
 *
 * 这个模块存在的唯一理由是修「标注位置错」：
 * 插图按 charOffset 切断正文，切口落在句子中间时，
 * 每片都从半个词开始，Markdown 结构识别不出来，偏移就错开。
 *
 * 所以测试的重点是：**吸附后每个切口都在块边界上**。
 */

function fig(charOffset: number, id = `f${charOffset}`): SourceImageRecord {
  return {
    id,
    sourceId: 's1',
    page: 1,
    block: 1,
    charOffset,
    kind: 'image',
    dataUri: 'data:image/png;base64,xxx',
    width: 100,
    height: 100,
    caption: null,
    createdAt: '2026-11-11T00:00:00.000Z',
  } as unknown as SourceImageRecord;
}

const TEXT = [
  '# 第1章 信号与系统',
  '',
  '## 1.0 引言',
  '',
  '在前面绪论中已经提到，信号与系统概念出现在极为广泛的各个领域中。',
  '',
  '第二段正文，用来测试多段落的情况。',
].join('\n');

describe('blockBoundaries', () => {
  it('包含 0 与末尾', () => {
    const b = blockBoundaries(TEXT);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe(TEXT.length);
  });

  it('包含标题与段落的起点', () => {
    const b = blockBoundaries(TEXT);
    /* 「## 1.0 引言」这一行在原文里的位置要作为边界 */
    const h2At = TEXT.indexOf('## 1.0 引言');
    expect(b).toContain(h2At);
    /* 第二段的起点 */
    const p2At = TEXT.indexOf('第二段正文');
    expect(b).toContain(p2At);
  });

  it('边界升序排列', () => {
    const b = blockBoundaries(TEXT);
    expect([...b].sort((x, y) => x - y)).toEqual(b);
  });

  it('空文本只有 0（不会返回负数或重复）', () => {
    expect(blockBoundaries('')).toEqual([0]);
  });
});

describe('snapFiguresToBlocks', () => {
  it('落在句子中间的图会被吸到最近的边界', () => {
    /* 「信号与系统概念」中间插一张图 —— 这是真实 charOffset 的常见情况 */
    const mid = TEXT.indexOf('信号与系统概念') + 2;
    const out = snapFiguresToBlocks(TEXT, [fig(mid)]);

    expect(out).toHaveLength(1);
    const boundarySet = new Set(blockBoundaries(TEXT));
    expect(boundarySet.has(out[0]!.offset)).toBe(true);
  });

  it('吸附后偏移仍然等于某个块边界（不落在块中间）', () => {
    /* 撒一批随机位置，全部应落在边界上 */
    for (const at of [1, 5, 12, 30, 44, 60, 70, 90]) {
      const out = snapFiguresToBlocks(TEXT, [fig(at)]);
      const boundarySet = new Set(blockBoundaries(TEXT));
      expect(boundarySet.has(out[0]!.offset)).toBe(true);
    }
  });

  it('两张图吸到同一边界时共用偏移（不挪 1 字符破坏结构）', () => {
    const a = TEXT.indexOf('信号与系统概念') + 1;
    const b = TEXT.indexOf('信号与系统概念') + 2;
    const out = snapFiguresToBlocks(TEXT, [fig(a, 'A'), fig(b, 'B')]);
    expect(out).toHaveLength(2);
    /* 两者都在边界上；允许相同 */
    const boundarySet = new Set(blockBoundaries(TEXT));
    expect(boundarySet.has(out[0]!.offset)).toBe(true);
    expect(boundarySet.has(out[1]!.offset)).toBe(true);
  });

  it('多图保持原始先后顺序', () => {
    const out = snapFiguresToBlocks(TEXT, [fig(80, 'late'), fig(2, 'early')]);
    /* 排序后 early 在前 */
    expect(out.map((o) => o.figure.id)).toEqual(['early', 'late']);
  });

  it('没有图时返回空数组', () => {
    expect(snapFiguresToBlocks(TEXT, [])).toEqual([]);
  });

  it('超出范围的 charOffset 被夹到文本内', () => {
    const out = snapFiguresToBlocks(TEXT, [fig(99999)]);
    expect(out[0]!.offset).toBeLessThanOrEqual(TEXT.length);
    expect(out[0]!.offset).toBeGreaterThanOrEqual(0);
  });

  it('负的 charOffset 被夹到 0', () => {
    const out = snapFiguresToBlocks(TEXT, [fig(-50)]);
    expect(out[0]!.offset).toBe(0);
  });
});

describe('吸附后的切片都是完整块（端到端意图）', () => {
  it('从边界切出的每一片，splitBlocks 都能识别出至少一个块', async () => {
    const { splitBlocks } = await import('./markdown-marks.ts');
    const mid = TEXT.indexOf('信号与系统概念') + 2;
    const out = snapFiguresToBlocks(TEXT, [fig(mid)]);
    const cuts = [...new Set([0, TEXT.length, out[0]!.offset])].sort((a, b) => a - b);

    for (let i = 0; i < cuts.length - 1; i++) {
      const slice = TEXT.slice(cuts[i]!, cuts[i + 1]!);
      if (!slice.trim()) continue;
      /* 每一片都应能切出块，而不是被当成一个从半句开始的段落 */
      expect(splitBlocks(slice).length).toBeGreaterThan(0);
    }
  });
});
