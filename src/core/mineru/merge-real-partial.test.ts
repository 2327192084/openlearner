/**
 * 用**真实 MinerU 两次分片输出**验证合并（2026-11-11）。
 *
 * ## 背景：用户报的 bug
 *
 * 「我对已解析两页的资料解析了后面的三四页，解析完成后跳转到原文可以查看
 * 解析结果，但是看不到之前解析的前两页。我又从资料库进行查看，发现
 * 资料库只显示了之前已解析的前两页，后面解析的三四页没有合并进去。」
 *
 * ## 这份测试与 merge-placeholder.test.ts 的分工
 *
 * 那个用**手写**的 Markdown 片段，验的是逻辑分支。
 * 这个用**真实 MinerU 产出**，验的是「真实输出长什么样」这件事 ——
 * 比如它的 `page N of 50` 里 50 是整本页数、N 是真实页号。
 *
 * fixture 由 `scripts/verify-partial-merge-real.cjs` 生成（真跑 MinerU）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SourceService } from '../sources.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { parseMarkdown } from './markdown.ts';
import { toSegments } from './write-back.ts';

const FIX = path.join(process.cwd(), 'src', 'test', 'fixtures');

function readMd(name: string): string {
  const p = path.join(FIX, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const part12 = readMd('mineru-part-1-2.md');
const part34 = readMd('mineru-part-3-4.md');

let storage: MemoryStorage;
let sources: SourceService;

beforeEach(() => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
});

describe('真实输出：两次分片（1-2 然后 3-4）合并', () => {
  it.runIf(part12 !== '' && part34 !== '')(
    '★★ 用户场景复现：第二次解析后，第一次的页必须还在',
    async () => {
      const s = await sources.importText('资料', '占位');

      /* 第一次：真实 MinerU 解析 1-2 页 */
      const segsA = toSegments(parseMarkdown(part12, { tier: 'standard' }));
      await sources.writeSegments(s.id, segsA, 'ready', 'merge');

      const afterFirst = await sources.getSegments(s.id);
      const p1Before = afterFirst.find((x) => x.page === 1)?.text ?? '';
      const p2Before = afterFirst.find((x) => x.page === 2)?.text ?? '';
      expect(p1Before.trim().length).toBeGreaterThan(0);

      /* 第二次：真实 MinerU 解析 3-4 页 */
      const segsB = toSegments(parseMarkdown(part34, { tier: 'standard' }));
      await sources.writeSegments(s.id, segsB, 'ready', 'merge');

      const afterSecond = await sources.getSegments(s.id);

      /* 核心断言：第一次的正文一个字都没变 */
      expect(afterSecond.find((x) => x.page === 1)?.text).toBe(p1Before);
      expect(afterSecond.find((x) => x.page === 2)?.text).toBe(p2Before);

      /* 第二次的页确实进来了 */
      expect((afterSecond.find((x) => x.page === 3)?.text ?? '').trim().length).toBeGreaterThan(0);
      expect((afterSecond.find((x) => x.page === 4)?.text ?? '').trim().length).toBeGreaterThan(0);

      /* 库里只有这 4 页（外加 importText 造的第 1 段被 1 覆盖），
         没有凭空多出 46 个补位空段 */
      expect(afterSecond.length).toBeLessThan(10);
      expect(afterSecond.map((x) => x.page)).toEqual([1, 2, 3, 4]);
    },
  );

  it.runIf(part12 !== '' && part34 !== '')(
    '真实输出的总页数仍是整本 50（不是 2）',
    () => {
      expect(parseMarkdown(part12, { tier: 'standard' }).pageCount).toBe(50);
      expect(parseMarkdown(part34, { tier: 'standard' }).pageCount).toBe(50);
    },
  );

  it.runIf(part34 !== '')('真实输出里补位页占绝大多数（这是 bug 的源头）', () => {
    const r = parseMarkdown(part34, { tier: 'standard' });
    const ph = r.pages.filter((p) => p.placeholder);
    /* 解析 2 页却补出 48 个空页 —— 不跳过它们就会清空已有正文 */
    expect(ph.length).toBe(48);
    expect(r.pages.filter((p) => !p.placeholder)).toHaveLength(2);
  });
});
