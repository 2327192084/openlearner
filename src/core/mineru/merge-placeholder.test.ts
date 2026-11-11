/**
 * 「分片解析 + 合并」不能把已有正文清空（2026-11-11）。
 *
 * ## 用户实测这个 bug
 *
 * 原话：「我对已解析两页的资料解析了后面的三四页，在解析完成后跳转到原文
 * 可以查看解析结果，但是看不到之前解析的前两页。我又从资料库进行查看，
 * 发现资料库只显示了之前已解析的前两页，后面解析的三四页没有合并进去。」
 *
 * ## 根因（两层）
 *
 * 1. `parseMarkdown` 会把结果补成**整本页数**：分片解析 3-4 页时，
 *    MinerU 的标记是 `page 3 of 36` / `page 4 of 36`，于是它产出
 *    36 个页对象 —— 其中 34 个是空占位（为了让页码与原文对齐）。
 * 2. `writeSegments` 的 merge 分支**无条件覆盖**，于是那 34 个空占位
 *    把库里已有的正文全清空了。
 *
 * 表现：解析 3-4 页之后，第 1、2 页变成空的（用户看到的「看不到之前解析的
 * 前两页」）；而资料库里总段数仍是旧值（因为旧段被覆盖成空，不是新增）。
 *
 * ## 修法
 *
 * 补位页标 `placeholder: true`，merge 时跳过。
 * 这组测试钉死这条 —— 任何一边改了（不标 placeholder / 合并时不跳过）都会红。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SourceService } from '../sources.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { parseMarkdown } from './markdown.ts';
import { toSegments } from './write-back.ts';
import { summarize } from './write-back.ts';

let storage: MemoryStorage;
let sources: SourceService;

beforeEach(() => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
});

/** 造一份「解析了第 3-4 页」的 MinerU 输出（整本 36 页） */
const PART_3_4 = [
  '<!-- page 3 of 36 -->',
  '',
  '第三页的正文内容。',
  '',
  '<!-- page 4 of 36 -->',
  '',
  '第四页的正文内容。',
  '',
].join('\n');

describe('parseMarkdown：分片输出会补出整本页数', () => {
  it('★ 解析 2 页但产出 36 个页对象（34 个是补位）', () => {
    const r = parseMarkdown(PART_3_4, { tier: 'standard' });
    expect(r.pageCount).toBe(36);
    expect(r.pages).toHaveLength(36);

    const real = r.pages.filter((p) => !p.placeholder);
    const ph = r.pages.filter((p) => p.placeholder);
    expect(real.map((p) => p.page)).toEqual([3, 4]);
    expect(ph).toHaveLength(34);
  });

  it('补位页的正文是空串', () => {
    const r = parseMarkdown(PART_3_4, { tier: 'standard' });
    for (const p of r.pages.filter((x) => x.placeholder)) {
      expect(p.text).toBe('');
    }
  });

  it('真实页不是 placeholder', () => {
    const r = parseMarkdown(PART_3_4, { tier: 'standard' });
    expect(r.pages.find((p) => p.page === 3)!.placeholder).toBeUndefined();
    expect(r.pages.find((p) => p.page === 4)!.placeholder).toBeUndefined();
  });
});

describe('toSegments：把 placeholder 传下去', () => {
  it('★ 补位页在 segment 上也标了 placeholder', () => {
    const segs = toSegments(parseMarkdown(PART_3_4, { tier: 'standard' }));
    expect(segs).toHaveLength(36);
    expect(segs.find((s) => s.page === 1)!.placeholder).toBe(true);
    expect(segs.find((s) => s.page === 3)!.placeholder).toBeUndefined();
  });
});

describe('writeSegments merge：补位页不覆盖已有正文', () => {
  it('★★ 核心回归：先有 1-2 页正文，再合并 3-4 页，1-2 页必须还在', async () => {
    const s = await sources.importText('资料', '占位');

    /* 第一次：解析了第 1、2 页 */
    await sources.writeSegments(
      s.id,
      [
        { page: 1, text: '第一页的正文' },
        { page: 2, text: '第二页的正文' },
      ],
      'ready',
    );

    /* 第二次：分片解析 3-4 页（输出里带着 34 个补位页） */
    const segs = toSegments(parseMarkdown(PART_3_4, { tier: 'standard' }));
    await sources.writeSegments(s.id, segs, 'ready', 'merge');

    const got = await sources.getSegments(s.id);
    /* 第 1、2 页的正文**必须还在** —— 这正是用户报的那个 bug */
    expect(got.find((x) => x.page === 1)!.text).toBe('第一页的正文');
    expect(got.find((x) => x.page === 2)!.text).toBe('第二页的正文');
    /* 第 3、4 页是新内容 */
    expect(got.find((x) => x.page === 3)!.text).toContain('第三页');
    expect(got.find((x) => x.page === 4)!.text).toContain('第四页');
  });

  it('补位页不会在库里凭空造出 32 个空段', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(
      s.id,
      [
        { page: 1, text: '甲' },
        { page: 2, text: '乙' },
      ],
      'ready',
    );
    const segs = toSegments(parseMarkdown(PART_3_4, { tier: 'standard' }));
    await sources.writeSegments(s.id, segs, 'ready', 'merge');

    const got = await sources.getSegments(s.id);
    /* 只有 1,2（原有）+ 3,4（新）= 4 段，不是 36 段 */
    expect(got.map((x) => x.page)).toEqual([1, 2, 3, 4]);
  });

  it('重复合并同一段不产生重复段', async () => {
    const s = await sources.importText('资料', '占位');
    const segs = toSegments(parseMarkdown(PART_3_4, { tier: 'standard' }));
    await sources.writeSegments(s.id, segs, 'ready', 'merge');
    await sources.writeSegments(s.id, segs, 'ready', 'merge');
    const got = await sources.getSegments(s.id);
    /*
     * 注意第 1 页：`importText('占位')` 自己就造了第 1 段。
     * 分片解析 3-4 页不会碰它，所以它一直在 —— 这是对的。
     */
    expect(got.map((x) => x.page)).toEqual([1, 3, 4]);
    /* 关键是「没有重复」：3 和 4 各只出现一次 */
    expect(got.filter((x) => x.page === 3)).toHaveLength(1);
    expect(got.filter((x) => x.page === 4)).toHaveLength(1);
  });

  it('replace 模式仍然照旧（补位页照写，因为完整解析要 1:1）', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(s.id, [{ page: 1, text: '旧' }], 'ready');
    const segs = toSegments(parseMarkdown(PART_3_4, { tier: 'standard' }));
    await sources.writeSegments(s.id, segs, 'ready', 'replace');

    const got = await sources.getSegments(s.id);
    /* replace 是「以这次为准」，所以是 36 段 */
    expect(got).toHaveLength(36);
    expect(got.find((x) => x.page === 1)!.text).toBe('');
  });
});

describe('summarize：补位页不算「解析出来的空页」', () => {
  it('★ 分片 3-4 页时，报告说「转了 2 页」，不是「36 页里有 32 个空页」', () => {
    const fakeSource = { id: 's1', title: '资料' } as never;
    const r = parseMarkdown(PART_3_4, { tier: 'standard' });
    const segs = toSegments(r);
    const report = summarize(fakeSource, r, segs);

    expect(report.writtenPageCount).toBe(2); /* 这次真实处理了 2 页 */
    expect(report.pagesWithText).toBe(2);
    expect(report.emptyPages).toEqual([]); /* 没有「转出来但是空的」页 */
    expect(report.pageCount).toBe(36); /* 整本仍是 36 */
  });
});
