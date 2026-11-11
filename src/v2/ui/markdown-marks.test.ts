import { describe, expect, it } from 'vitest';
import { intersect, sliceForMark, splitBlocks } from './markdown-marks.ts';

/**
 * 这些用例的重点是**偏移准确**。
 *
 * 用户报的 bug 就是偏移错位（「标注的文字与实际显示效果不匹配」），
 * 而偏移错了在界面上表现为「标注跑到别的字上」，单靠肉眼很难定位。
 * 所以每个块都要能反查出它在原文里的位置。
 */

const RAW = [
  '# 第1章 信号与系统',
  '',
  '## 1.0 引言',
  '',
  '在前面绪论中已经提到，信号与系统概念出现在极为广泛的各个领域中。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '1. 编号一',
  '2. 编号二',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| a1 | b1 |',
].join('\n');

describe('splitBlocks 结构与原文对应', () => {
  it('识别标题并去掉 # 号', () => {
    const blocks = splitBlocks(RAW);
    const h1 = blocks.find((b) => b.kind === 'heading' && b.level === 1)!;
    expect(h1.kind === 'heading' && h1.text).toBe('第1章 信号与系统');
  });

  it('标题的偏移指向去 # 后的文字，而不是行首', () => {
    const blocks = splitBlocks(RAW);
    const h1 = blocks.find((b) => b.kind === 'heading' && b.level === 1)!;
    if (h1.kind !== 'heading') throw new Error('not heading');
    /* 用偏移从原文里反查，必须正好拿到标题文字 */
    expect(RAW.slice(h1.from, h1.to)).toBe('第1章 信号与系统');
  });

  it('二级标题偏移同样准确', () => {
    const blocks = splitBlocks(RAW);
    const h2 = blocks.find((b) => b.kind === 'heading' && b.level === 2)!;
    if (h2.kind !== 'heading') throw new Error('not heading');
    expect(RAW.slice(h2.from, h2.to)).toBe('1.0 引言');
  });

  it('段落偏移准确覆盖整段', () => {
    const blocks = splitBlocks(RAW);
    const p = blocks.find((b) => b.kind === 'para')!;
    if (p.kind !== 'para') throw new Error('not para');
    expect(RAW.slice(p.from, p.to)).toContain('在前面绪论中已经提到');
  });

  it('列表项偏移准确（跳过 - 与空格）', () => {
    const blocks = splitBlocks(RAW);
    const list = blocks.find((b) => b.kind === 'list' && !b.ordered)!;
    if (list.kind !== 'list') throw new Error('not list');
    expect(list.items).toHaveLength(2);
    expect(RAW.slice(list.items[0]!.from, list.items[0]!.to)).toBe('第一项');
    expect(RAW.slice(list.items[1]!.from, list.items[1]!.to)).toBe('第二项');
  });

  it('有序列表项偏移准确（跳过 "1. "）', () => {
    const blocks = splitBlocks(RAW);
    const list = blocks.find((b) => b.kind === 'list' && b.ordered)!;
    if (list.kind !== 'list') throw new Error('not list');
    expect(RAW.slice(list.items[0]!.from, list.items[0]!.to)).toBe('编号一');
  });

  it('表格识别出表头与一行数据', () => {
    const blocks = splitBlocks(RAW);
    const t = blocks.find((b) => b.kind === 'table')!;
    if (t.kind !== 'table') throw new Error('not table');
    expect(t.head).toEqual(['列A', '列B']);
    expect(t.body).toHaveLength(1);
    expect(t.body[0]).toEqual(['a1', 'b1']);
  });

  it('块按出现顺序排列（渲染顺序不能乱）', () => {
    const kinds = splitBlocks(RAW).map((b) => b.kind);
    expect(kinds).toEqual(['heading', 'heading', 'para', 'list', 'list', 'table']);
  });

  it('空段落不产生块', () => {
    const blocks = splitBlocks('\n\n\n');
    expect(blocks).toHaveLength(0);
  });

  it('没有 Markdown 的纯文本仍是一段', () => {
    const blocks = splitBlocks('就一句话。');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('para');
  });
});

describe('intersect', () => {
  it('高亮完全落在块内', () => {
    expect(intersect(100, 200, 120, 150)).toEqual({ start: 20, end: 50 });
  });

  it('高亮跨越块起点时被裁到块首', () => {
    expect(intersect(100, 200, 80, 150)).toEqual({ start: 0, end: 50 });
  });

  it('高亮跨越块末尾时被裁到块尾', () => {
    expect(intersect(100, 200, 150, 260)).toEqual({ start: 50, end: 100 });
  });

  it('高亮完全覆盖块', () => {
    expect(intersect(100, 200, 50, 260)).toEqual({ start: 0, end: 100 });
  });

  it('不相交返回 null（不能返回 0 长度区间）', () => {
    expect(intersect(100, 200, 300, 400)).toBeNull();
    expect(intersect(100, 200, 0, 100)).toBeNull();
  });

  it('恰好贴在边界上算不相交（避免空 mark）', () => {
    expect(intersect(100, 200, 200, 300)).toBeNull();
  });
});

describe('sliceForMark', () => {
  it('切成前三段，拼回去等于原文', () => {
    const { before, hit, after } = sliceForMark('abcdef', 2, 4);
    expect(before).toBe('ab');
    expect(hit).toBe('cd');
    expect(after).toBe('ef');
    expect(before + hit + after).toBe('abcdef');
  });

  it('区间超出范围时被夹紧，不抛错', () => {
    const { before, hit, after } = sliceForMark('abc', -5, 100);
    expect(before).toBe('');
    expect(hit).toBe('abc');
    expect(after).toBe('');
  });

  it('start > end 时给空 hit（不产生反向切片）', () => {
    const { hit } = sliceForMark('abcdef', 4, 2);
    expect(hit).toBe('');
  });
});

describe('端到端：偏移与结构同时成立', () => {
  it('在原文里找「概念」二字，能定位到唯一一个块', () => {
    const word = '概念';
    const at = RAW.indexOf(word);
    expect(at).toBeGreaterThan(0);

    const blocks = splitBlocks(RAW);
    const hits = blocks.filter((b) => {
      if (b.kind === 'list') return b.items.some((it) => intersect(it.from, it.to, at, at + word.length));
      return intersect(b.from, b.to, at, at + word.length) !== null;
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('para');
  });

  it('在标题里定位时不会命中任何正文块', () => {
    const at = RAW.indexOf('引言');
    const blocks = splitBlocks(RAW);
    const hits = blocks.filter((b) => intersect(b.from, b.to, at, at + 2) !== null);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('heading');
  });
});
