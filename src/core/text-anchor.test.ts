import { describe, expect, it } from 'vitest';
import {
  describeTextAnchor,
  resolveTextAnchor,
  sliceByOffset,
  MARK_COLORS,
  MARK_LABELS,
} from './text-anchor.ts';

/**
 * 文本锚点的测试。
 *
 * ## 这套逻辑为什么必须有测试
 *
 * 高亮错了用户很难描述清楚：「我标的那句话跑到别处去了」。
 * 而错的原因可能有很多种：偏移量变了、同一句话出现多次、
 * 重新解析后文字改了。只有把每种情况钉死在这里，
 * 才不会让用户每隔几天就遇到一次「标记漂移」。
 */

const PAGE = '数据结构研究的是数据元素之间的关系。线性结构包括线性表、栈、队列。非线性结构包括树与图。';

describe('describeTextAnchor：建锚点', () => {
  it('记录引文、前后文与偏移', () => {
    const idx = PAGE.indexOf('线性结构包括');
    const a = describeTextAnchor(PAGE, idx, idx + '线性结构包括'.length, 3);
    expect(a).not.toBeNull();
    expect(a!.exact).toBe('线性结构包括');
    expect(a!.page).toBe(3);
    expect(a!.start).toBe(idx);
    expect(a!.end).toBe(idx + 6);
    // 前文应该是选中内容之前的若干字
    expect(a!.prefix.length).toBeGreaterThan(0);
    expect(PAGE.startsWith(a!.prefix + a!.exact)).toBe(true);
  });

  it('选区为空或全是空白时返回 null（不建无意义的锚点）', () => {
    expect(describeTextAnchor(PAGE, 5, 5, 1)).toBeNull();
    expect(describeTextAnchor('abc   def', 3, 6, 1)).toBeNull();
  });

  it('越界偏移被夹到合法范围，不抛错', () => {
    const a = describeTextAnchor(PAGE, -10, 99999, 1);
    expect(a).not.toBeNull();
    expect(a!.start).toBe(0);
    expect(a!.end).toBe(PAGE.length);
  });

  it('前文与后文最长取 32 字（够消歧又不冗长）', () => {
    const long = 'A'.repeat(100) + '目标' + 'B'.repeat(100);
    const a = describeTextAnchor(long, 100, 102, 1);
    expect(a!.prefix.length).toBe(32);
    expect(a!.suffix.length).toBe(32);
  });
});

describe('resolveTextAnchor：还原位置', () => {
  it('文本没变时按偏移直接命中（confidence=exact）', () => {
    const idx = PAGE.indexOf('非线性结构');
    const a = describeTextAnchor(PAGE, idx, idx + 5, 1)!;
    const r = resolveTextAnchor(PAGE, a);
    expect(r.ok).toBe(true);
    expect(r.confidence).toBe('exact');
    expect(PAGE.slice(r.start, r.end)).toBe('非线性结构');
  });

  it('**文本变了（前面插了字）也能靠引文找回**（OCR 补全后的常见情况）', () => {
    const idx = PAGE.indexOf('线性表');
    const a = describeTextAnchor(PAGE, idx, idx + 3, 1)!;

    // 模拟 OCR 在页首补了一段文字，所有偏移量都变了
    const changed = '【识别补全的前置内容】' + PAGE;
    const r = resolveTextAnchor(changed, a);

    expect(r.ok).toBe(true);
    expect(r.confidence).toBe('quote'); // 偏移失效，靠引文找回
    expect(changed.slice(r.start, r.end)).toBe('线性表');
  });

  it('同一句话出现多次时，靠前后文选对那一处', () => {
    // 「线性结构」在原文里出现两次，前文不同
    const text = '第一部分讲线性结构。中间无关内容。第二部分又提到线性结构。';
    const first = text.indexOf('线性结构');
    const a = describeTextAnchor(text, first, first + 4, 1)!;

    const r = resolveTextAnchor(text, a);
    expect(r.ok).toBe(true);
    expect(r.start).toBe(first); // 选的是第一处，不是后面那处
  });

  it('偏移失效且多处出现时，仍用前后文挑最近的', () => {
    const original = '前文甲线性结构后文乙';
    const idx = original.indexOf('线性结构');
    const a = describeTextAnchor(original, idx, idx + 4, 1)!;

    // 前面插字，偏移全错；且制造第二处「线性结构」
    const changed = '插入一些字' + original + '另外也提到线性结构，但上下文不同。';
    const r = resolveTextAnchor(changed, a);
    expect(r.ok).toBe(true);
    // 应该命中带「前文甲…后文乙」上下文的那个
    expect(changed.slice(r.start - 3, r.start)).toBe('前文甲');
  });

  it('引文完全消失时返回 lost，不假装成功', () => {
    const a = describeTextAnchor(PAGE, 0, 5, 1)!;
    const r = resolveTextAnchor('完全不同的内容，一个字都不一样。', a);
    expect(r.ok).toBe(false);
    expect(r.confidence).toBe('lost');
  });

  it('轻度错字（OCR 修错）能模糊找回，并标注 confidence=fuzzy', () => {
    const text = '这是一段用来测试模糊匹配能力的较长的中文文本内容';
    const a = describeTextAnchor(text, 0, text.length, 1)!;
    // 中间错一个字
    const changed = text.slice(0, 10) + '错' + text.slice(11);
    const r = resolveTextAnchor(changed, a);
    expect(r.ok).toBe(true);
    expect(r.confidence).toBe('fuzzy');
  });

  it('太短的引文不做模糊匹配（2 个字到处都能匹配上，等于噪音）', () => {
    const a = describeTextAnchor('甲乙', 0, 2, 1)!;
    const r = resolveTextAnchor('完全不同的一长串文字内容在这里', a);
    expect(r.confidence).toBe('lost');
  });

  it('空引文直接返回 lost', () => {
    const r = resolveTextAnchor(PAGE, {
      page: 1, exact: '', prefix: '', suffix: '', start: 0, end: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('偏移越界但引文存在时，仍能找回', () => {
    const idx = PAGE.indexOf('树与图');
    const a = describeTextAnchor(PAGE, idx, idx + 3, 1)!;
    // 人为把偏移改坏
    a.start = 99999;
    a.end = 100002;
    const r = resolveTextAnchor(PAGE, a);
    expect(r.ok).toBe(true);
    expect(PAGE.slice(r.start, r.end)).toBe('树与图');
  });
});

describe('sliceByOffset：把偏移切成节点片段', () => {
  /** 造几个假文本节点，模拟「一句话被拆在多个 span 里」 */
  function fakeNodes(texts: string[]) {
    const nodes: { node: Text; start: number }[] = [];
    let offset = 0;
    for (const t of texts) {
      // 用最小可用的 Text 替身：只需要 data 属性
      const node = { data: t } as unknown as Text;
      nodes.push({ node, start: offset });
      offset += t.length;
    }
    return nodes;
  }

  it('区间落在一个节点内', () => {
    const nodes = fakeNodes(['abcde', 'fghij']);
    const out = sliceByOffset(nodes, 1, 3);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(1);
    expect(out[0]!.end).toBe(3);
  });

  it('区间跨多个节点时逐段切开', () => {
    const nodes = fakeNodes(['abc', 'def', 'ghi']);
    const out = sliceByOffset(nodes, 2, 7);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ start: 2, end: 3 });
    expect(out[1]).toMatchObject({ start: 0, end: 3 });
    expect(out[2]).toMatchObject({ start: 0, end: 1 });
  });

  it('完全不相交的节点不返回', () => {
    const nodes = fakeNodes(['abc', 'def', 'ghi']);
    const out = sliceByOffset(nodes, 0, 2);
    expect(out).toHaveLength(1);
  });

  it('空节点列表返回空', () => {
    expect(sliceByOffset([], 0, 10)).toEqual([]);
  });
});

describe('颜色与标签常量', () => {
  it('三种标记都有颜色与中文名', () => {
    for (const k of ['highlight', 'underline', 'strikethrough'] as const) {
      expect(MARK_COLORS[k]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(MARK_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});
