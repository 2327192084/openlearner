import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_CHARS,
  SHORT_QUOTE_CHARS,
  evidenceText,
  locateSelection,
  passageKey,
  passageToMaterial,
} from './selection-passage.ts';
import type { PassageSelection } from './selection-passage.ts';

const PAGE = [
  '离散时间信号可以表示为一个序列。',
  '当序列中只有一个元素不为零时，称为单位脉冲序列。',
  '单位脉冲序列是离散系统分析的基础。',
  '离散时间信号可以表示为一个序列。',
].join('');

function sel(over: Partial<PassageSelection> = {}): PassageSelection {
  return {
    sourceId: 'src_1',
    page: 9,
    quote: '单位脉冲序列',
    start: -1,
    end: -1,
    chapter: '1.2 离散时间信号',
    ...over,
  };
}

describe('locateSelection', () => {
  it('提示位置正中靶心时直接采信', () => {
    const at = PAGE.indexOf('单位脉冲序列');
    const out = locateSelection(PAGE, '单位脉冲序列', at);
    expect(out).toEqual({ start: at, end: at + '单位脉冲序列'.length });
  });

  it('提示位置差几个字时在附近找回来', () => {
    const at = PAGE.indexOf('单位脉冲序列', PAGE.indexOf('单位脉冲') + 1);
    const near = locateSelection(PAGE, '单位脉冲序列', at + 6);
    expect(near.start).toBe(at);
  });

  it('同一句出现两次时按提示位置选第二个，不退化成第一个', () => {
    const first = PAGE.indexOf('离散时间信号可以表示为一个序列。');
    const second = PAGE.indexOf('离散时间信号可以表示为一个序列。', first + 1);
    expect(second).toBeGreaterThan(first);

    const out = locateSelection(PAGE, '离散时间信号可以表示为一个序列。', second);
    expect(out.start).toBe(second);
  });

  it('提示位置完全不对时全段兜底，仍能找到', () => {
    const at = PAGE.indexOf('单位脉冲序列是离散系统分析的基础。');
    const out = locateSelection(PAGE, '单位脉冲序列是离散系统分析的基础。', 9999);
    expect(out.start).toBe(at);
  });

  it('正文里没有这句话时返回 -1，不猜 0', () => {
    const out = locateSelection(PAGE, '这句话根本不在正文里', 0);
    expect(out).toEqual({ start: -1, end: -1 });
  });

  it('空选区和空正文都不抛错', () => {
    expect(locateSelection(PAGE, '   ', 0)).toEqual({ start: -1, end: -1 });
    expect(locateSelection('', '单位脉冲序列', 0)).toEqual({ start: -1, end: -1 });
  });
});

describe('evidenceText', () => {
  it('长选区直接用引文，不扩', () => {
    const quote = '当序列中只有一个元素不为零时，称为单位脉冲序列。';
    const at = PAGE.indexOf(quote);
    const out = evidenceText(PAGE, quote, at, at + quote.length);
    expect(out.expanded).toBe(false);
    expect(out.text).toBe(quote);
  });

  it('短选区向两侧扩上下文，并标出扩过', () => {
    const quote = '单位脉冲序列';
    const at = PAGE.indexOf(quote);
    const out = evidenceText(PAGE, quote, at, at + quote.length);
    expect(out.expanded).toBe(true);
    /* 扩出来的必须包含原选中的那句话 */
    expect(out.text).toContain(quote);
    /* 超长正文才加省略号；这段正文短，两侧都没到边界 */
    expect(out.text.length).toBeGreaterThanOrEqual(quote.length);
  });

  it('短选区扩到边界时不加多余的省略号', () => {
    const page = '单位脉冲序列';
    const out = evidenceText(page, '单位脉冲序列', 0, page.length);
    expect(out.text).toBe(page);
    expect(out.text).not.toContain('…');
  });

  it('正文很长时扩出的窗口有上限，不会塞整页', () => {
    const filler = '填'.repeat(3000);
    const quote = '单位脉冲序列';
    const page = filler + quote + filler;
    const at = page.indexOf(quote);
    const out = evidenceText(page, quote, at, at + quote.length);
    expect(out.expanded).toBe(true);
    /* 两侧各 300 + 选中的 6 字 + 两个省略号 */
    expect(out.text.length).toBeLessThanOrEqual(CONTEXT_WINDOW_CHARS * 2 + quote.length + 2);
    expect(out.text.startsWith('…')).toBe(true);
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('偏移不可用时只给引文，不瞎扩', () => {
    const out = evidenceText(PAGE, '单位脉冲序列', -1, -1);
    expect(out).toEqual({ text: '单位脉冲序列', expanded: false });
  });

  it('短于门槛才算短选区，刚好等于门槛时不扩', () => {
    const quote = 'x'.repeat(SHORT_QUOTE_CHARS);
    const page = 'y'.repeat(500) + quote + 'y'.repeat(500);
    const at = page.indexOf(quote);
    const out = evidenceText(page, quote, at, at + quote.length);
    expect(out.expanded).toBe(false);
  });
});

describe('passageToMaterial', () => {
  it('label 与 segmentsToMaterials 的拼法一致（资料 · 章节 · 页码）', () => {
    const at = PAGE.indexOf('单位脉冲序列');
    const m = passageToMaterial(sel({ start: at, end: at + 6 }), PAGE, '信号与系统');
    expect(m.label).toBe('信号与系统 · 1.2 离散时间信号 · 第 9 页');
  });

  it('没有章节时不出现空的分隔符', () => {
    const at = PAGE.indexOf('单位脉冲序列');
    const m = passageToMaterial(sel({ start: at, end: at + 6, chapter: null }), PAGE, '信号与系统');
    expect(m.label).toBe('信号与系统 · 第 9 页');
  });

  it('划选素材不带知识点 id（它来自正文）', () => {
    const at = PAGE.indexOf('单位脉冲序列');
    const m = passageToMaterial(sel({ start: at, end: at + 6 }), PAGE, '信号与系统');
    expect(m.pointId).toBeNull();
    expect(m.sourceId).toBe('src_1');
    expect(m.page).toBe(9);
  });

  it('素材 id 带 passage: 前缀，不与段落 id 混用', () => {
    const at = PAGE.indexOf('单位脉冲序列');
    const m = passageToMaterial(sel({ start: at, end: at + 6 }), PAGE, '信号与系统');
    expect(m.id.startsWith('passage:')).toBe(true);
    expect(m.id).toContain('src_1');
  });

  it('同一段同一位置 → 同一个 id；换位置 → 不同 id', () => {
    const first = PAGE.indexOf('离散时间信号可以表示为一个序列。');
    const second = PAGE.indexOf('离散时间信号可以表示为一个序列。', first + 1);
    const a = passageToMaterial(sel({ quote: '离散时间信号可以表示为一个序列。', start: first, end: first + 17 }), PAGE, 'x');
    const b = passageToMaterial(sel({ quote: '离散时间信号可以表示为一个序列。', start: second, end: second + 17 }), PAGE, 'x');
    expect(a.id).not.toBe(b.id);
  });

  it('页码 0 时 page 置 null（没有页码可回查）', () => {
    const m = passageToMaterial(sel({ page: 0, start: 0, end: 6 }), PAGE, '信号与系统');
    expect(m.page).toBeNull();
    expect(m.label).not.toContain('第 0 页');
  });
});

describe('passageKey', () => {
  it('同资料同位置同键', () => {
    expect(passageKey(sel({ start: 10, end: 20 }))).toBe(passageKey(sel({ start: 10, end: 20 })));
  });

  it('同资料不同位置不同键', () => {
    expect(passageKey(sel({ start: 10, end: 20 }))).not.toBe(passageKey(sel({ start: 10, end: 21 })));
  });

  it('不同页码不同键（跨页同偏移不能算同一段）', () => {
    expect(passageKey(sel({ page: 1, start: 0, end: 5 }))).not.toBe(passageKey(sel({ page: 2, start: 0, end: 5 })));
  });

  it('偏移不可用时退回引文，仍能判同', () => {
    expect(passageKey(sel({ start: -1, end: -1 }))).toBe(passageKey(sel({ start: -1, end: -1 })));
    expect(passageKey(sel({ start: -1, end: -1, quote: '别的' }))).not.toBe(passageKey(sel({ start: -1, end: -1 })));
  });
});
