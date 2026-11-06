import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INK_WIDTH,
  HIGHLIGHTER_WIDTH,
  INK_COLORS,
  createAnnotation,
  hasContent,
  isAnnotationEmpty,
  pagesWithAnnotations,
  annotationSummary,
} from './annotations.ts';
import type { InkStroke, TextNote } from './model.ts';

/**
 * 注释工具函数的纯逻辑测试。
 *
 * 这些函数决定「什么时候该写出标记、什么时候该当作没有」，
 * 算错会让用户看到空标记（点进去什么都没有），所以钉死行为。
 */

const stroke = (): InkStroke => ({
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
  ],
  color: '#e11d48',
  width: DEFAULT_INK_WIDTH,
});

const note = (id = 'n1', text = '注释'): TextNote => ({
  id,
  text,
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.05,
  fontSize: 0.02,
  color: '#111827',
  background: null,
});

describe('常量配置', () => {
  it('笔宽用比例而不是像素（缩放时不该变粗）', () => {
    expect(DEFAULT_INK_WIDTH).toBeGreaterThan(0);
    expect(DEFAULT_INK_WIDTH).toBeLessThan(0.05);
  });

  it('荧光笔明显比画笔粗', () => {
    expect(HIGHLIGHTER_WIDTH).toBeGreaterThan(DEFAULT_INK_WIDTH * 3);
  });

  it('提供多种笔色且都是合法十六进制', () => {
    expect(INK_COLORS.length).toBeGreaterThanOrEqual(4);
    for (const c of INK_COLORS) {
      expect(c.value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('hasContent / isAnnotationEmpty', () => {
  const base = { id: 'a', sourceId: 's', page: 1, createdAt: '', updatedAt: '' };

  it('只有笔迹算有内容', () => {
    expect(hasContent({ ...base, strokes: [stroke()], texts: [] })).toBe(true);
  });

  it('只有文本框算有内容', () => {
    expect(hasContent({ ...base, strokes: [], texts: [note()] })).toBe(true);
  });

  it('都没有算空', () => {
    expect(hasContent({ ...base, strokes: [], texts: [] })).toBe(false);
    expect(isAnnotationEmpty({ ...base, strokes: [], texts: [] })).toBe(true);
  });

  it('空注释的 isAnnotationEmpty 与 hasContent 互为反义', () => {
    const a = createAnnotation('x', 's', 1, 'now');
    expect(isAnnotationEmpty(a)).toBe(!hasContent(a));
  });
});

describe('createAnnotation', () => {
  it('建出来是空的，但字段齐全', () => {
    const a = createAnnotation('id1', 'src1', 7, '2026-11-06T00:00:00Z');
    expect(a.id).toBe('id1');
    expect(a.sourceId).toBe('src1');
    expect(a.page).toBe(7);
    expect(a.strokes).toEqual([]);
    expect(a.texts).toEqual([]);
    expect(a.createdAt).toBe('2026-11-06T00:00:00Z');
  });
});

describe('pagesWithAnnotations', () => {
  const base = { sourceId: 's', createdAt: '', updatedAt: '' };

  it('只列出真的有内容的页', () => {
    const set = pagesWithAnnotations([
      { ...base, id: 'a', page: 2, strokes: [stroke()], texts: [] },
      { ...base, id: 'b', page: 5, strokes: [], texts: [] },
      { ...base, id: 'c', page: 9, strokes: [], texts: [note()] },
    ]);
    expect([...set].sort((x, y) => x - y)).toEqual([2, 9]);
  });

  it('同一页多条记录只算一次', () => {
    const set = pagesWithAnnotations([
      { ...base, id: 'a', page: 3, strokes: [stroke()], texts: [] },
      { ...base, id: 'b', page: 3, strokes: [stroke()], texts: [] },
    ]);
    expect(set.size).toBe(1);
  });

  it('空数组得到空集合', () => {
    expect(pagesWithAnnotations([]).size).toBe(0);
  });
});

describe('annotationSummary', () => {
  const base = { sourceId: 's', createdAt: '', updatedAt: '' };

  it('统计页数、笔数、文本框数', () => {
    const s = annotationSummary([
      { ...base, id: 'a', page: 1, strokes: [stroke(), stroke(), stroke()], texts: [] },
      { ...base, id: 'b', page: 2, strokes: [stroke()], texts: [note('n1'), note('n2')] },
      { ...base, id: 'c', page: 3, strokes: [], texts: [] },
    ]);
    expect(s).toEqual({ pages: 2, strokes: 4, texts: 2 });
  });

  it('全空时三项都是 0', () => {
    expect(annotationSummary([])).toEqual({ pages: 0, strokes: 0, texts: 0 });
  });
});
