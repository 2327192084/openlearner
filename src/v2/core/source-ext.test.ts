/**
 * `extOf` 的单测（2026-11-17）。
 *
 * ## 为什么这个纯函数值得单独测
 *
 * 它决定两件事的成败，而且这两件事都会「静默失败」：
 *  1. **导出原件**：扩展名错 → 用户双击打不开（没有报错，只是打不开）
 *  2. **交给 MinerU**：MinerU 按扩展名分派解析器，且主进程有白名单校验；
 *     给错扩展名会被直接拒绝（`不支持转换「.txt」这类文件`）
 *
 * 而资料标题里的扩展名**基本都没有**（实测用户库两份 PDF 的标题
 * 都不带 `.pdf`），所以「取不到时按 kind 兜底」那条分支是**主路径**，
 * 不是边角情况。
 */

import { describe, expect, it } from 'vitest';
import { extOf } from './source-ext.ts';

describe('extOf：从标题或 kind 推断扩展名', () => {
  it('标题带 .pdf → 取 .pdf', () => {
    expect(extOf({ title: '高等数学.pdf', kind: 'pdf' })).toBe('.pdf');
  });

  it('★ 标题不带扩展名 → 按 kind 兜底（这是用户库的真实情况）', () => {
    /* 实测用户库里的标题就是这样，一个 .pdf 都没有 */
    expect(extOf({ title: '信号与系统（第二版）第1章 正文（不含习题）', kind: 'pdf' })).toBe('.pdf');
    expect(extOf({ title: '高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )', kind: 'pdf' })).toBe('.pdf');
  });

  it('图片按 kind 兜底成 .png', () => {
    expect(extOf({ title: '扫描件 第 3 页', kind: 'image' })).toBe('.png');
  });

  it('PPTX 按 kind 兜底成 .pptx（看原图与导出要用）', () => {
    expect(extOf({ title: '信号与系统 第三章', kind: 'pptx' })).toBe('.pptx');
    expect(extOf({ title: '课件.PPTX', kind: 'pptx' })).toBe('.pptx');
  });

  it('★ .jpeg 归一成 .jpg（Windows 常见写法）', () => {
    expect(extOf({ title: '扫描.jpeg', kind: 'image' })).toBe('.jpg');
  });

  it('大写的 .PDF 也能认', () => {
    expect(extOf({ title: '书.PDF', kind: 'pdf' })).toBe('.pdf');
  });

  it('.tif / .tiff 原样保留（都是合法扩展名）', () => {
    expect(extOf({ title: 'a.tif', kind: 'image' })).toBe('.tif');
    expect(extOf({ title: 'b.tiff', kind: 'image' })).toBe('.tiff');
  });

  it('★ 永远不返回空串（空扩展名会让导出/解析卡住）', () => {
    const kinds = ['pdf', 'docx', 'pptx', 'markdown', 'text', 'image'] as const;
    for (const kind of kinds) {
      const ext = extOf({ title: '没有扩展名的标题', kind });
      expect(ext.length).toBeGreaterThan(0);
      expect(ext.startsWith('.')).toBe(true);
    }
  });

  it('标题里夹杂点号不会误判（"1.2 节" 不该被当成扩展名）', () => {
    expect(extOf({ title: '第1.2节 导数的定义', kind: 'pdf' })).toBe('.pdf');
  });
});
