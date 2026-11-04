import { describe, expect, it } from 'vitest';
import { mergeRanges, splitBlocks } from './HighlightedText.tsx';

/**
 * 高亮渲染的坐标学。
 *
 * 这一层最容易出错也最难靠肉眼发现：偏移错一位，高亮就框住错的字，
 * 而「看起来有高亮」会让评审以为功能是好的。所以切块与合并两条
 * 纯函数必须有测试，尤其要保证**切块不改变坐标系**。
 */

describe('splitBlocks', () => {
  it('按空行切段，且每块的偏移对准原文', () => {
    const text = '第一段\n\n第二段\n\n第三段';
    const blocks = splitBlocks(text);

    expect(blocks.map((b) => b.text)).toEqual(['第一段', '第二段', '第三段']);
    // 关键：用原文去切，得到的必须还是同一段文字
    for (const block of blocks) {
      expect(text.slice(block.start, block.end)).toBe(block.text);
    }
  });

  it('单个换行不切段（PDF 里的行内换行不是段落）', () => {
    const text = '上半句\n下半句';
    expect(splitBlocks(text)).toHaveLength(1);
  });

  it('三个以上连续换行也只算一个段落分隔', () => {
    const text = '甲\n\n\n\n乙';
    const blocks = splitBlocks(text);
    expect(blocks.map((b) => b.text)).toEqual(['甲', '乙']);
    expect(text.slice(blocks[1].start, blocks[1].end)).toBe('乙');
  });

  it('首尾空行不产生空块', () => {
    const blocks = splitBlocks('\n\n正文\n\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('正文');
    expect(blocks[0].start).toBe(2);
  });

  it('空文本得到空数组，而不是一个空段', () => {
    expect(splitBlocks('')).toEqual([]);
  });
});

describe('mergeRanges', () => {
  it('重叠的命中合并成并集（避免嵌套 mark 重复显示文字）', () => {
    // core 允许重叠命中：「aa」在「aaa」里返回 [0,2) 与 [1,3)
    const merged = mergeRanges([
      { charStart: 0, charEnd: 2 },
      { charStart: 1, charEnd: 3 },
    ]);
    expect(merged).toEqual([{ charStart: 0, charEnd: 3 }]);
  });

  it('首尾相接但不重叠的命中保持分开', () => {
    const merged = mergeRanges([
      { charStart: 0, charEnd: 2 },
      { charStart: 2, charEnd: 4 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('乱序输入也能正确合并', () => {
    const merged = mergeRanges([
      { charStart: 10, charEnd: 12 },
      { charStart: 0, charEnd: 2 },
      { charStart: 11, charEnd: 15 },
    ]);
    expect(merged).toEqual([
      { charStart: 0, charEnd: 2 },
      { charStart: 10, charEnd: 15 },
    ]);
  });

  it('完全包含的命中不会撑大范围', () => {
    const merged = mergeRanges([
      { charStart: 0, charEnd: 10 },
      { charStart: 2, charEnd: 4 },
    ]);
    expect(merged).toEqual([{ charStart: 0, charEnd: 10 }]);
  });

  it('空输入返回空数组', () => {
    expect(mergeRanges([])).toEqual([]);
  });
});
