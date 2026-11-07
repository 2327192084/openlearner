import { describe, expect, it } from 'vitest';
import { needsConversion } from './convert.ts';
import { parseMarkdown } from './markdown.ts';
import { toSegments, summarize } from './write-back.ts';

/**
 * 核心是**页码 1:1 对应**。
 *
 * 用户原话：「转换的文档要与原文件对应的转换页数一一相对，
 * 方便用户对照生成的文档是否有错误」。
 * 任何「跳过空页」「按内容猜着切页」的行为都是 bug，
 * 而这类 bug 在界面上看不出来 —— 只有拿页码去比才发现错位。
 */

/** 造一段 MinerU 风格的 Markdown（形状照 2026-11-07 实测输出） */
function md(
  pages: Array<{ no: number; total?: number; title?: string; body?: string }>,
  total?: number,
): string {
  const t = total ?? pages.length;
  return pages
    .map((p) => {
      const head = `<!-- page ${p.no} of ${p.total ?? t} -->`;
      const title = p.title ? `\n## ${p.title}\n` : '\n';
      const body = p.body ? `\n${p.body}\n` : '\n';
      return `${head}${title}${body}`;
    })
    .join('');
}

describe('parseMarkdown：分页标记', () => {
  it('按 <!-- page N of M --> 拆成多页', () => {
    const r = parseMarkdown(
      md([
        { no: 1, title: '第一章 绪论', body: '第一页正文。' },
        { no: 2, title: '第二章 线性表', body: '第二页正文。' },
      ]),
    );
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    // 正文现在是 Markdown 形式（含标题标记）
    expect(r.pages[0]!.text).toContain('第一页正文。');
    expect(r.pages[1]!.text).toContain('第二页正文。');
  });

  it('页首标题既进 chapter，也以 Markdown # 形式留在正文里', () => {
    const r = parseMarkdown(md([{ no: 1, title: '第一章 数据结构绪论', body: '正文一句。' }]));
    // chapter 供目录跳转（不带 # 号）
    expect(r.pages[0]!.chapter).toBe('第一章 数据结构绪论');
    expect(r.pages[0]!.chapter).not.toMatch(/^#/);
    // 正文里保留 Markdown 标题 —— 用户要求「也要是 Markdown 形式」
    expect(r.pages[0]!.text).toContain('## 第一章 数据结构绪论');
    expect(r.pages[0]!.text).toContain('正文一句。');
  });

  it('没有分页标记时整段算第 1 页（不猜着切）', () => {
    const r = parseMarkdown('## 标题\n\n一段正文。\n\n另一段。');
    expect(r.pageCount).toBe(1);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.text).toContain('一段正文');
  });

  it('声明页数比实际多时补空页，不让后面的页前移', () => {
    const r = parseMarkdown(
      md([
        { no: 1, total: 3, body: '第一页' },
        { no: 3, total: 3, body: '第三页' },
      ]),
    );
    expect(r.pageCount).toBe(3);
    expect(r.pages[1]!.text).toBe(''); // 第 2 页占位
    expect(r.pages[2]!.text).toBe('第三页'); // 仍是第 3 页
  });

  it('实际页号超过声明页数时以实际为准（宁可多留也不少）', () => {
    const r = parseMarkdown(
      md([
        { no: 1, total: 2, body: 'a' },
        { no: 5, total: 2, body: 'e' },
      ]),
    );
    expect(r.pageCount).toBe(5);
    expect(r.pages[4]!.page).toBe(5);
  });

  it('整份结果的正文里保留了 Markdown 标题标记（用户要求）', () => {
    const r = parseMarkdown(md([
      { no: 1, title: '第一章 绪论', body: '正文一。' },
      { no: 2, title: '第二章 线性表', body: '正文二。' },
    ]));
    const joined = r.pages.map((p) => p.text).join('\n');
    expect(joined).toMatch(/^#{1,6}\s+\S/m);
    expect(joined).toContain('## 第一章 绪论');
    expect(joined).toContain('## 第二章 线性表');
  });

  it('空输入报错而不是静默返回空结果', () => {
    expect(() => parseMarkdown('')).toThrow();
    expect(() => parseMarkdown('   \n  ')).toThrow();
  });
});

describe('parseMarkdown：内容清理', () => {
  it('丢掉图片链接行（会污染搜索与锚点）', () => {
    const r = parseMarkdown(md([{ no: 1, body: '正文。\n\n![](images/a.png)\n\n继续。' }]));
    expect(r.pages[0]!.text).not.toContain('images/a.png');
    expect(r.pages[0]!.text).toContain('正文');
    expect(r.pages[0]!.text).toContain('继续');
  });

  it('页中间的标题保留文字、去掉井号', () => {
    const r = parseMarkdown(
      md([{ no: 1, title: '章标题', body: '正文。\n\n## 小节标题\n\n更多正文。' }]),
    );
    expect(r.pages[0]!.chapter).toBe('章标题');
    // 页中间的标题同样保留 # 号
    expect(r.pages[0]!.text).toContain('## 小节标题');
  });

  it('页首是正文时，中间的标题不算本章标题（不猜）', () => {
    const r = parseMarkdown(md([{ no: 1, body: '开头正文。\n\n## 中间的标题\n\n后续。' }]));
    expect(r.pages[0]!.chapter).toBeNull();
    expect(r.pages[0]!.text).toContain('中间的标题');
  });

  it('合并多余空行，去掉首尾空白', () => {
    const r = parseMarkdown(md([{ no: 1, body: '正文。\n\n\n\n\n结尾。' }]));
    expect(r.pages[0]!.text).toBe('正文。\n\n结尾。');
  });

  it('保留段落之间的空行（可读性）', () => {
    const r = parseMarkdown(md([{ no: 1, body: '第一段。\n\n第二段。' }]));
    expect(r.pages[0]!.text).toBe('第一段。\n\n第二段。');
  });
});

describe('toSegments：与原文逐页对应', () => {
  it('段数等于页数，页号连续从 1 开始', () => {
    const r = parseMarkdown(
      md([{ no: 1, body: 'a' }, { no: 2, body: 'b' }, { no: 3, body: 'c' }]),
    );
    const segs = toSegments(r);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it('空页也占一个段（供用户对照原书）', () => {
    const r = parseMarkdown(
      md([
        { no: 1, total: 3, body: 'a' },
        { no: 2, total: 3, body: '' },
        { no: 3, total: 3, body: 'c' },
      ]),
    );
    const segs = toSegments(r);
    expect(segs).toHaveLength(3);
    expect(segs[1]!.text).toBe('');
    expect(segs[2]!.page).toBe(3);
  });
});

describe('summarize：如实汇报', () => {
  it('空页页码单独列出来', () => {
    const source = { id: 's1', title: '测试资料' } as unknown as Parameters<typeof summarize>[0];
    const r = parseMarkdown(
      md([
        { no: 1, total: 3, body: 'a' },
        { no: 2, total: 3, body: '' },
        { no: 3, total: 3, body: 'c' },
      ]),
    );
    const report = summarize(source, r, toSegments(r));
    expect(report.pageCount).toBe(3);
    expect(report.pagesWithText).toBe(2);
    expect(report.emptyPages).toEqual([2]);
  });
});

describe('needsConversion：什么情况该走 MinerU', () => {
  it('扫描件要转', () => {
    expect(needsConversion('no-text-layer', 'pdf')).toBe(true);
  });

  it('解码失败也要转（是我们的问题，不是让用户换文件）', () => {
    expect(needsConversion('decode-failed', 'pdf')).toBe(true);
  });

  it('图片资料要转', () => {
    expect(needsConversion('ready', 'image')).toBe(true);
  });

  it('已经有文字层的不要转（白费时间）', () => {
    expect(needsConversion('ready', 'pdf')).toBe(false);
    expect(needsConversion('ready', 'text')).toBe(false);
  });
});
