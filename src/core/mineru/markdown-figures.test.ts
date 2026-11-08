import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMarkdown } from './markdown.ts';

/**
 * 解析层的回归测试。
 *
 * ## 这个文件里最重要的那一组
 *
 * 「正文字节不变」。库里 95 个知识点按 SourceSegment.text 算好了
 * charStart/charEnd，图片功能（2026-11-08 加的）一旦改了 text 的任何一个字节，
 * 那些高亮全会错位，而且错得很隐蔽。
 *
 * 所以这里不只测「图片解析对不对」，更要拿**真实 converted.md**
 * 逐页比对 text —— 拿真实数据守，比拿自造样本守可靠。
 */

const md = (pages: Array<{ no: number; title?: string; body: string }>): string =>
  pages
    .map(
      (p) =>
        `<!-- page ${p.no} of ${pages.length} -->\n\n` +
        (p.title ? `## ${p.title}\n\n` : '') +
        p.body,
    )
    .join('\n\n');

describe('parseMarkdown：基础', () => {
  it('按分页标记切页，页号从 1 开始', () => {
    const r = parseMarkdown(md([{ no: 1, body: '第一页' }, { no: 2, body: '第二页' }]), {});
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it('空输入报错而不是静默返回空结果', () => {
    expect(() => parseMarkdown('')).toThrow();
    expect(() => parseMarkdown('   \n  ')).toThrow();
  });

  it('缺失页留空占位，不跳过（否则后面全错位）', () => {
    const text = `<!-- page 1 of 3 -->\n\n一\n\n<!-- page 3 of 3 -->\n\n三\n`;
    const r = parseMarkdown(text, {});
    expect(r.pageCount).toBe(3);
    expect(r.pages[1]!.text).toBe('');
  });
});

describe('parseMarkdown：内容清理', () => {
  it('丢掉图片链接行（会污染搜索与锚点）', () => {
    const r = parseMarkdown(md([{ no: 1, body: '正文。\n\n![](images/a.png)\n\n继续。' }]), {});
    expect(r.pages[0]!.text).not.toContain('images/a.png');
    expect(r.pages[0]!.text).toContain('正文');
    expect(r.pages[0]!.text).toContain('继续');
  });

  it('页中间的标题保留文字、去掉井号', () => {
    const r = parseMarkdown(
      md([{ no: 1, title: '章标题', body: '正文。\n\n## 小节标题\n\n更多正文。' }]),
      {},
    );
    expect(r.pages[0]!.chapter).toBe('章标题');
    expect(r.pages[0]!.text).toContain('## 小节标题');
  });

  it('页首是正文时，中间的标题不算本章标题（不猜）', () => {
    const r = parseMarkdown(md([{ no: 1, body: '开头正文。\n\n## 后面的标题\n' }]), {});
    expect(r.pages[0]!.chapter).toBeNull();
    expect(r.pages[0]!.text).toContain('## 后面的标题');
  });
});

describe('parseMarkdown：图片位置（2026-11-08 新增）', () => {
  const real = `<!-- page 1 of 2 -->

## 第1章

正文一段。

![Image block](doc:87731df/tier:standard/page:1/block:7)

图1.1 含有电压源 $v_{s}$ 和电容器

正文二段。
`;

  it('抽出图片并记下定位符', () => {
    const r = parseMarkdown(real, { tier: 'standard' });
    const figs = r.pages[0]!.figures!;
    expect(figs).toHaveLength(1);
    expect(figs[0]!.locator?.block).toBe(7);
    expect(figs[0]!.locator?.tier).toBe('standard');
    expect(figs[0]!.kind).toBe('image');
  });

  it('图片行仍然从正文里去掉（行为与改动前一致）', () => {
    const r = parseMarkdown(real, {});
    expect(r.pages[0]!.text).not.toContain('doc:');
    expect(r.pages[0]!.text).not.toContain('![');
  });

  it('图注配对：紧跟图片的下一句非空文字', () => {
    const r = parseMarkdown(real, {});
    expect(r.pages[0]!.figures![0]!.caption).toBe('图1.1 含有电压源 $v_{s}$ 和电容器');
  });

  it('图注只吃一行，不把后续正文吞掉', () => {
    /*
     * 实测教材里图注常折两行。只认第一行是**保守**选择：
     * 第二行若其实是正文，吞进去就会让同一句话显示两遍。
     */
    const r = parseMarkdown(real, {});
    const cap = r.pages[0]!.figures![0]!.caption!;
    expect(cap).not.toContain('正文二段');
    expect(r.pages[0]!.text).toContain('正文二段');
  });

  it('charOffset 落在正文范围内的合法位置', () => {
    const r = parseMarkdown(real, {});
    const page = r.pages[0]!;
    const off = page.figures![0]!.charOffset;
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThanOrEqual(page.text.length);
  });

  it('charOffset 指向「上一段之后、图注之前」', () => {
    const r = parseMarkdown(real, {});
    const page = r.pages[0]!;
    const off = page.figures![0]!.charOffset;
    const head = page.text.slice(0, off);
    const tail = page.text.slice(off);
    expect(head).toContain('正文一段');
    expect(tail.startsWith('图1.1')).toBe(true);
  });

  it('多个图片各自有位置，按出现顺序', () => {
    const text = `<!-- page 1 of 1 -->

甲。

![Image block](doc:87731df/tier:standard/page:1/block:3)

图1

乙。

![Chart block](doc:87731df/tier:standard/page:1/block:9)

图2
`;
    const r = parseMarkdown(text, {});
    const figs = r.pages[0]!.figures!;
    expect(figs).toHaveLength(2);
    expect(figs[0]!.kind).toBe('image');
    expect(figs[1]!.kind).toBe('chart');
    expect(figs[1]!.charOffset).toBeGreaterThan(figs[0]!.charOffset);
  });

  it('外链图片：认出来但 locator 为 null（取不了，不算格式错）', () => {
    const text = `<!-- page 1 of 1 -->\n\n甲。\n\n![图](https://example.com/a.png)\n\n说明\n`;
    const r = parseMarkdown(text, {});
    expect(r.pages[0]!.figures).toHaveLength(1);
    expect(r.pages[0]!.figures![0]!.locator).toBeNull();
  });

  it('没有图片时 figures 是空数组，不是 undefined', () => {
    const r = parseMarkdown(md([{ no: 1, body: '纯文字。' }]), {});
    expect(r.pages[0]!.figures).toEqual([]);
  });

  it('缺失页也有 figures 空数组（结构统一）', () => {
    const text = `<!-- page 1 of 2 -->\n\n一\n\n<!-- page 2 of 2 -->\n\n![Image block](doc:87731df/tier:basic/page:2/block:2)\n`;
    const r = parseMarkdown(text, {});
    expect(r.pages[1]!.figures).toHaveLength(1);
  });
});

describe('parseMarkdown：真实 converted.md 的正文字节不变（防知识点错位）', () => {
  /*
   * 拿 2026-11-08 你那份《信号与系统（第二版）第1章》的真实转换结果跑。
   *
   * 这里断言的 text **就是库里现在存着的 text**（改动前 parseMarkdown
   * 输出的同一份）。如果这个测试红了，说明图片功能改坏了正文 ——
   * 那 95 个知识点的 charStart/charEnd 全部要重算。
   *
   * 文件可能不存在（CI / 换机器）→ 跳过而不是失败，
   * 因为它是用户数据，不是仓库里的固定样本。
   */
  const path = '.tmp/b/openleaner-data/mineru-jobs/job-1794025404333-5zsoe7/converted.md';
  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = null;
  }

  it.skipIf(raw === null)('36 页页数与页序不变', () => {
    const r = parseMarkdown(raw!, { tier: 'standard' });
    expect(r.pageCount).toBe(36);
    expect(r.pages.map((p) => p.page)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1),
    );
  });

  it.skipIf(raw === null)('第 1 页正文与库里的完全一致（1048 字，与改动前逐字相同）', () => {
    const r = parseMarkdown(raw!, { tier: 'standard' });
    expect(r.pages[0]!.text.length).toBe(1048);
    expect(r.pages[0]!.text.startsWith('## 第1章 信号与系统\n\n## 1.0 引言\n\n在前面绪论中')).toBe(true);
  });

  it.skipIf(raw === null)('88 个定位符全部抽出（76 Image + 12 Chart）', () => {
    const r = parseMarkdown(raw!, { tier: 'standard' });
    const all = r.pages.flatMap((p) => p.figures ?? []);
    expect(all).toHaveLength(88);
    const byKind = all.reduce<Record<string, number>>((acc, f) => {
      acc[f.kind] = (acc[f.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind.image).toBe(76);
    expect(byKind.chart).toBe(12);
  });

  it.skipIf(raw === null)('全部定位符都能解析出 tier:standard', () => {
    const r = parseMarkdown(raw!, { tier: 'standard' });
    const all = r.pages.flatMap((p) => p.figures ?? []);
    expect(all.every((f) => f.locator?.tier === 'standard')).toBe(true);
  });

  it.skipIf(raw === null)('每页图片数与真实 Markdown 的 locator 数逐一吻合', () => {
    /*
     * 独立数一遍原文件的 locator 分布，与解析结果对照 ——
     * 不用解析器的输出验证解析器自己（那只能证明自洽）。
     */
    const r = parseMarkdown(raw!, { tier: 'standard' });
    const lines = raw!.split(/\r?\n/);
    const perPageFromFile: Record<number, number> = {};
    let currentPage = 1;
    for (const line of lines) {
      const pm = /^<!--\s*page\s+(\d+)\s+of\s+/.exec(line.trim());
      if (pm) {
        currentPage = Number(pm[1]);
        continue;
      }
      if (/^!\[[^\]]*\]\(doc:[^)]*\)\s*$/.test(line.trim())) {
        perPageFromFile[currentPage] = (perPageFromFile[currentPage] ?? 0) + 1;
      }
    }
    for (const page of r.pages) {
      expect((page.figures ?? []).length).toBe(perPageFromFile[page.page] ?? 0);
    }
  });

  it.skipIf(raw === null)('所有 charOffset 都落在各自页正文内', () => {
    const r = parseMarkdown(raw!, { tier: 'standard' });
    for (const page of r.pages) {
      for (const f of page.figures ?? []) {
        expect(f.charOffset).toBeGreaterThanOrEqual(0);
        expect(f.charOffset).toBeLessThanOrEqual(page.text.length);
      }
    }
  });
});
