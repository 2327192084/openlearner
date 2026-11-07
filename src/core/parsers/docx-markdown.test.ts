import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseDocx } from './docx.ts';
import { blocksToMarkdown, docxToMarkdown, type DocxBlock } from './docx-markdown.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/**
 * 用户实测反馈「word 文件的格式也是乱的」。
 *
 * 这些测试钉住的是：**结构必须留在文字里**。
 * 之前把一切拍平成纯文本，标题层级、列表、表格全丢，
 * 用户在阅读器里看到的是一坨没有层次的文字。
 */

describe('blocksToMarkdown：结构渲染', () => {
  it('标题渲染成 # 号，级别对应 Word 的 Heading N', () => {
    const blocks: DocxBlock[] = [
      { kind: 'heading', level: 1, text: '第一章 绪论' },
      { kind: 'heading', level: 2, text: '1.1 背景' },
      { kind: 'heading', level: 3, text: '更深一层' },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('# 第一章 绪论');
    expect(md).toContain('## 1.1 背景');
    expect(md).toContain('### 更深一层');
  });

  it('无序列表渲染成 - 项目', () => {
    const blocks: DocxBlock[] = [
      { kind: 'list', level: 0, text: '第一项', ordered: false },
      { kind: 'list', level: 0, text: '第二项', ordered: false },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('- 第一项');
    expect(md).toContain('- 第二项');
  });

  it('表格渲染成 Markdown 表格，首行当表头', () => {
    const blocks: DocxBlock[] = [
      {
        kind: 'table',
        level: 0,
        text: '',
        rows: [
          ['名称', '数量'],
          ['线性表', '3'],
        ],
      },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('| 名称 | 数量 |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 线性表 | 3 |');
  });

  it('表格单元格里的竖线被转义（否则切错列）', () => {
    const blocks: DocxBlock[] = [
      { kind: 'table', level: 0, text: '', rows: [['a|b', 'c']] },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('a\\|b');
  });

  it('各行列数不一致时补齐空格，不丢数据', () => {
    const blocks: DocxBlock[] = [
      { kind: 'table', level: 0, text: '', rows: [['a', 'b'], ['c']] },
    ];
    const md = blocksToMarkdown(blocks);
    // 第二行补成两列
    expect(md).toMatch(/\| c \|  \|/);
  });

  it('普通段落之间留空行', () => {
    const md = blocksToMarkdown([
      { kind: 'paragraph', level: 0, text: '第一段。' },
      { kind: 'paragraph', level: 0, text: '第二段。' },
    ]);
    expect(md).toContain('第一段。\n\n第二段。');
  });

  it('不会产生三个以上连续空行', () => {
    const md = blocksToMarkdown([
      { kind: 'paragraph', level: 0, text: 'a' },
      { kind: 'paragraph', level: 0, text: 'b' },
      { kind: 'paragraph', level: 0, text: 'c' },
    ]);
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('docxToMarkdown：真实 .docx 文件', () => {
  it('course.docx 能转出非空 Markdown', async () => {
    const data = new Uint8Array(await readFile(join(FIXTURES, 'course.docx')));
    const md = await docxToMarkdown(data);
    expect(md.length).toBeGreaterThan(10);
  });

  it('转出来的 Markdown 保留了标题层级（#）', async () => {
    const data = new Uint8Array(await readFile(join(FIXTURES, 'course.docx')));
    const md = await docxToMarkdown(data);
    expect(md).toMatch(/^#{1,6}\s+\S/m);
  });
});

describe('parseDocx：入库后的分段也带 Markdown 结构', () => {
  it('每段的文字里保留 # 标题标记（阅读器能看出层次）', async () => {
    const data = new Uint8Array(await readFile(join(FIXTURES, 'course.docx')));
    const doc = await parseDocx(data, { title: '测试' });
    const joined = doc.segments.map((s) => s.text).join('\n\n');
    expect(joined).toMatch(/^#{1,6}\s+\S/m);
  });

  it('chapter 字段仍然是干净的标题文字（不带 # 号）', async () => {
    const data = new Uint8Array(await readFile(join(FIXTURES, 'course.docx')));
    const doc = await parseDocx(data);
    const withChapter = doc.segments.filter((s) => s.chapter);
    expect(withChapter.length).toBeGreaterThan(0);
    // chapter 用于目录跳转与显示，不该带 Markdown 标记
    for (const s of withChapter) {
      expect(s.chapter).not.toMatch(/^#/);
    }
  });

  it('段数、页码仍然从 1 连续递增（定位不受影响）', async () => {
    const data = new Uint8Array(await readFile(join(FIXTURES, 'course.docx')));
    const doc = await parseDocx(data);
    expect(doc.segments.length).toBeGreaterThan(0);
    doc.segments.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.page).toBe(i + 1);
    });
  });
});
