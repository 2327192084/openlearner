import { describe, expect, it } from 'vitest';

/**
 * 「这一页该显示什么」的判据。
 *
 * ## 锁的是一个真实的错误判断
 *
 * 上一版写成 `source.textStatus === 'no-text-layer'` 才渲染页面图。
 * 逻辑上看着合理，实际会造成：
 *
 *   扫描件被 OCR 过 → textStatus 变成 'ready' → 整份资料再也不渲染图
 *   但 OCR 往往只识别了前几页 → 第 1、2 页有文字，第 3 页起一片空白
 *   → 用户看到「628 页的教材只能看前两页」
 *
 * 根因是把两个不同的问题混成了一个：
 *   - 「这份资料有没有文字层」→ 影响搜索是否可用、要不要提示去 OCR
 *   - 「这一页该显示什么」    → 影响阅读器渲染文字还是渲染图
 *
 * 后者必须落到**当前页有没有正文**上。
 */

/** 与 SourceReader 中保持一致：这一页要不要渲染成图片 */
function needsPageImage(source: { kind: string }, text: string | undefined, hasSegments: boolean): boolean {
  return source.kind === 'pdf' && hasSegments && (text ?? '').trim().length === 0;
}

describe('扫描件渲染判据：按「这一页有没有正文」而不是资料整体状态', () => {
  it('扫描件未 OCR：空正文 → 渲染图', () => {
    expect(needsPageImage({ kind: 'pdf' }, '', true)).toBe(true);
  });

  it('OCR 过的资料：已识别页显示文字，不渲染图', () => {
    expect(needsPageImage({ kind: 'pdf' }, '第 1 页识别出的正文', true)).toBe(false);
  });

  it('**OCR 过但这一页还没识别：仍然要渲染图**（这就是「只能看前两页」的修复）', () => {
    // 同一份资料：第 1 页有正文，第 3 页是空字符串
    const pageWithText = '封面文字';
    const pageWithoutText = '';
    expect(needsPageImage({ kind: 'pdf' }, pageWithText, true)).toBe(false);
    expect(needsPageImage({ kind: 'pdf' }, pageWithoutText, true)).toBe(true);
  });

  it('只有空白字符也算没有正文', () => {
    expect(needsPageImage({ kind: 'pdf' }, '   \n\t  ', true)).toBe(true);
  });

  it('非 PDF 不渲染页面图（图片有自己的显示路径）', () => {
    expect(needsPageImage({ kind: 'image' }, '', true)).toBe(false);
    expect(needsPageImage({ kind: 'docx' }, '', true)).toBe(false);
  });

  it('还没有任何分段时不渲染（避免无意义的渲染请求）', () => {
    expect(needsPageImage({ kind: 'pdf' }, '', false)).toBe(false);
  });
});
