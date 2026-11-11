/**
 * 「分片解析会清掉没解析的页的插图」（2026-11-11 晚，用户实测报告）。
 *
 * ## 用户报告
 *
 * 解析那份 PDF（2）的 1-2 页时丢失了图片，而原件里是有的。
 *
 * ## 根因
 *
 * `importFigures()` 的清理是**无条件全清**：
 *
 * ```ts
 * const old = await storage.getAll('sourceImages');
 * for (const rec of old) {
 *   if (rec.sourceId === sourceId) await storage.remove('sourceImages', rec.id);
 * }
 * ```
 *
 * 它只按 `sourceId` 过滤，**完全不看这次解析了哪几页**。
 * 于是分片解析 1-2 页时，第 3-36 页的插图被一起删掉，
 * 只写回 1-2 页的那几张。
 *
 * 这与正文那条 bug 是**同一个形状**：
 * 正文那边 `writeSegments(mode:'merge')` 已经按页合并、
 * 跳过补位空页（见 merge-placeholder.test.ts），
 * 但插图这条路还停在「整份重写」的旧语义上。
 * 正文修了，图没修 —— 所以用户看到「文字还在，图没了」。
 *
 * ## 修法
 *
 * 和正文对齐：传入这次解析覆盖的页集合，只清这几页的旧图，
 * 其余页的图原样保留。完整解析 = 覆盖全部页 = 等价于原来的全清。
 *
 * 注意**补位空页不能算进覆盖范围**：分片解析会补出整本页数，
 * 那些空页没有 figures，若把它们当成「本次解析的页」，
 * 保留行为虽然不会误删（因为只删有图的页），但语义会变模糊。
 * 这里取 `page.placeholder !== true` 的页作为真实覆盖范围。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { parseMarkdown } from './markdown.ts';
import { importFigures, type FetchedFigure } from './images.ts';

const allOk = async (): Promise<{ ok: true; figure: FetchedFigure }> => ({
  ok: true,
  figure: { dataUri: 'data:image/png;base64,AAAA', width: 10, height: 10, byteSize: 400 },
});

/** 造一份 n 页、每页 1 张图的 MinerU 输出 */
function docWithFigures(n: number): string {
  const parts: string[] = [];
  for (let p = 1; p <= n; p++) {
    parts.push(`<!-- page ${p} of ${n} -->`);
    parts.push('');
    parts.push(`第 ${p} 页正文。`);
    parts.push('');
    parts.push(`![Image block](doc:87731df/tier:standard/page:${p}/block:${p * 10})`);
    parts.push('');
    parts.push(`图 ${p}`);
    parts.push('');
  }
  return parts.join('\n');
}

describe('importFigures：分片解析不清掉别的页的图', () => {
  it('★ 整本 5 页各 1 图 → 只重解析第 1-2 页 → 第 3-5 页的图必须还在', async () => {
    const storage = new MemoryStorage();

    /* 第一次：完整解析 5 页，5 张图 */
    const full = parseMarkdown(docWithFigures(5), { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: full.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(5);

    /*
     * 第二次：分片解析第 1-2 页。
     *
     * 真实链路里这里拿到的是**补位过的整本页数**（parseMarkdown 会补出
     * 3-5 页的空占位），所以这里刻意用 `1 of 5` 让补位真的发生 ——
     * 这正是上一次正文 bug 的形状。
     */
    const partial = parseMarkdown(
      `<!-- page 1 of 5 -->\n\n第一页重解析。\n\n![Image block](doc:87731df/tier:standard/page:1/block:10)\n\n图 1\n\n` +
        `<!-- page 2 of 5 -->\n\n第二页重解析。\n\n![Image block](doc:87731df/tier:standard/page:2/block:20)\n\n图 2\n`,
      { tier: 'standard' },
    );
    expect(partial.pages).toHaveLength(5); // 补位到 5 页

    await importFigures({
      storage, sourceId: 'src_1', pages: partial.pages, fetcher: allOk,
      coveredPages: [1, 2],
    });

    const left = await storage.getAll('sourceImages');
    const pages = left.map((r) => r.page).sort((a, b) => a - b);
    expect(pages).toEqual([1, 2, 3, 4, 5]); // ← 修之前这里是 [1, 2]
  });

  it('被重解析的页用新图覆盖（不是叠加）', async () => {
    const storage = new MemoryStorage();

    const full = parseMarkdown(docWithFigures(3), { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: full.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(3);

    /* 第 1 页重解析后有 2 张图（block 10 与 11） */
    const partial = parseMarkdown(
      `<!-- page 1 of 3 -->\n\n重解析。\n\n![Image block](doc:87731df/tier:standard/page:1/block:10)\n\n图 a\n\n` +
        `![Chart block](doc:87731df/tier:standard/page:1/block:11)\n\n图 b\n`,
      { tier: 'standard' },
    );
    await importFigures({
      storage, sourceId: 'src_1', pages: partial.pages, fetcher: allOk,
      coveredPages: [1],
    });

    const left = await storage.getAll('sourceImages');
    expect(left).toHaveLength(4); // 第1页 2 张 + 第2、3页各 1 张
    expect(left.filter((r) => r.page === 1)).toHaveLength(2);
    expect(left.filter((r) => r.page === 2)).toHaveLength(1);
    expect(left.filter((r) => r.page === 3)).toHaveLength(1);
  });

  it('完整解析整本时，仍然清掉整份资料的旧图（等价于原行为）', async () => {
    const storage = new MemoryStorage();

    const full = parseMarkdown(docWithFigures(4), { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: full.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(4);

    /*
     * 重转后只剩 1 张图（图被删掉了）。
     *
     * 完整解析**不传 coveredPages** → 清掉这份资料的全部旧图，
     * 与改动前行为完全一致。这里刻意不传，守的正是这一点：
     * 若改成「靠跳过 placeholder 推断覆盖范围」，那 2-4 页是补位空页，
     * 它们的旧图会留下来，与正文对不上。两种模式只能由调用方显式区分。
     */
    const again = parseMarkdown(
      `<!-- page 1 of 4 -->\n\n只剩一张。\n\n![Image block](doc:87731df/tier:standard/page:1/block:10)\n\n图\n`,
      { tier: 'standard' },
    );
    await importFigures({ storage, sourceId: 'src_1', pages: again.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(1);
  });

  it('补位空页不算「本次覆盖的页」—— 不会因为占位页把别的页的图删掉', async () => {
    const storage = new MemoryStorage();

    const full = parseMarkdown(docWithFigures(4), { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: full.pages, fetcher: allOk });

    /*
     * 只解析第 3 页，parseMarkdown 补出 4 页（1,2,4 是空占位）。
     * 空占位没有 figures，所以既不该被当成覆盖页去删图，
     * 也不该影响已有正文页的图。
     */
    const partial = parseMarkdown(
      `<!-- page 3 of 4 -->\n\n第三页重解析。\n\n![Image block](doc:87731df/tier:standard/page:3/block:30)\n\n图 3\n`,
      { tier: 'standard' },
    );
    const placeholders = partial.pages.filter((p) => p.placeholder);
    expect(placeholders.length).toBeGreaterThan(0); // 确认补位真的发生了

    await importFigures({
      storage, sourceId: 'src_1', pages: partial.pages, fetcher: allOk,
      coveredPages: [3],
    });

    const pages = (await storage.getAll('sourceImages')).map((r) => r.page).sort((a, b) => a - b);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  it('别的资料的图任何时候都不受影响', async () => {
    const storage = new MemoryStorage();
    const full = parseMarkdown(docWithFigures(3), { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: full.pages, fetcher: allOk });
    await importFigures({ storage, sourceId: 'src_2', pages: full.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(6);

    const partial = parseMarkdown(
      `<!-- page 1 of 3 -->\n\n重解析。\n\n![Image block](doc:87731df/tier:standard/page:1/block:10)\n\n图\n`,
      { tier: 'standard' },
    );
    await importFigures({
      storage, sourceId: 'src_1', pages: partial.pages, fetcher: allOk,
      coveredPages: [1],
    });

    const left = await storage.getAll('sourceImages');
    expect(left.filter((r) => r.sourceId === 'src_2')).toHaveLength(3);
    expect(left.filter((r) => r.sourceId === 'src_1').map((r) => r.page).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
