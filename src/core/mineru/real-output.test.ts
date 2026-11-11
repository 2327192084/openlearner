import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown } from './markdown.ts';
import { toSegments } from './write-back.ts';

/**
 * 用**真实 MinerU 输出**验证分片解析的页码正确性（2026-11-11）。
 *
 * ## 为什么需要这一层
 *
 * 上一轮我只能验证「`--pages` 参数拼得对」，不能验证
 * 「MinerU 真的只返回 3-15 页，且页码仍是真实的 3-15」。
 *
 * 现在把两份真实输出存成了 fixture：
 *   - `mineru-part-3-5.md`   —— `--pages 3-5` 的结果（page 3/4/5 of 50）
 *   - `mineru-all-50.md`     —— `--pages all` 的结果（50 页）
 *
 * 它们暴露了一个**只在分片时出现**的 bug：MinerU 的分页标记写的是
 * **真实页号**（`<!-- page 3 of 50 -->`），而 `toSegments` 原来用 `i+1`，
 * 会把第 3 页写成第 1 页。完整解析下两者恰好相等，所以这个 bug
 * 一直藏着，直到分片解析才暴露 —— 而知识点锚点全按页号存，
 * 错了就是整批错位。
 */

const FIX = path.join(process.cwd(), 'src', 'test', 'fixtures');

function readMd(name: string): string {
  const p = path.join(FIX, name);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

const partMd = readMd('mineru-part-3-5.md');
const allMd = readMd('mineru-all-50.md');

describe('真实 MinerU 输出：分片解析（--pages 3-5）', () => {
  it.runIf(partMd !== '')('★ 页码从 3 开始，不是 1', () => {
    /*
     * 这是本轮修掉的那个 bug 的回归锁。
     * 若有人把 toSegments 改回 `i + 1`，这条会立刻红。
     */
    const result = parseMarkdown(partMd, { tier: 'standard' });
    const segs = toSegments(result).filter((s) => s.text.trim() !== '');
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0]!.page).toBe(3);
  });

  it.runIf(partMd !== '')('只包含 3-5 页', () => {
    const result = parseMarkdown(partMd, { tier: 'standard' });
    const pages = toSegments(result)
      .filter((s) => s.text.trim() !== '')
      .map((s) => s.page);
    expect(pages).toEqual([3, 4, 5]);
  });

  it.runIf(partMd !== '')('声明的总页数仍是整本的 50（不是 3）', () => {
    /*
     * MinerU 在标记里写 `page 3 of 50`，`of 50` 是整本页数。
     * 我们要保留这个真实总数，否则界面上的「共 N 页」会显示成 3。
     */
    const result = parseMarkdown(partMd, { tier: 'standard' });
    expect(result.pageCount).toBe(50);
  });
});

describe('真实 MinerU 输出：完整解析（--pages all）', () => {
  it.runIf(allMd !== '')('得到 50 段，页码 1..50 连续', () => {
    const result = parseMarkdown(allMd, { tier: 'standard' });
    const segs = toSegments(result);
    expect(segs.length).toBe(50);
    expect(segs[0]!.page).toBe(1);
    expect(segs[49]!.page).toBe(50);
  });
});

describe('真实数据模拟：分片合并进完整结果', () => {
  it.runIf(partMd !== '' && allMd !== '')(
    '★ 先完整再分片 3-5：仍有 50 页，3-5 是新内容，其余不变',
    () => {
      const all = toSegments(parseMarkdown(allMd, { tier: 'standard' }));
      const part = toSegments(parseMarkdown(partMd, { tier: 'standard' })).filter(
        (s) => s.text.trim() !== '',
      );

      /* 复刻 writeSegments 的 merge 逻辑 */
      const byPage = new Map(
        all.map((s) => [s.page, { page: s.page, chapter: s.chapter, text: `旧_${s.text}` }]),
      );
      for (const s of part) {
        byPage.set(s.page, { page: s.page, chapter: s.chapter, text: `新_${s.text}` });
      }
      const merged = [...byPage.values()].sort((a, b) => a.page - b.page);

      expect(merged).toHaveLength(50);
      /* 3-5 被覆盖 */
      expect(merged.find((m) => m.page === 3)!.text.startsWith('新_')).toBe(true);
      expect(merged.find((m) => m.page === 5)!.text.startsWith('新_')).toBe(true);
      /* 没碰的页保留 */
      expect(merged.find((m) => m.page === 1)!.text.startsWith('旧_')).toBe(true);
      expect(merged.find((m) => m.page === 10)!.text.startsWith('旧_')).toBe(true);
      /* 顺序 */
      expect(merged.map((m) => m.page)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    },
  );
});
