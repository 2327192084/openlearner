/**
 * 闪卡导出的单测（2026-11-14）。
 *
 * 用户要求：「还要有导出功能导出到 obsidian 中（要符合 obsidian 支持的格式，
 * 应该是 markdown 格式）」。
 *
 * 语法规则来自项目里已有的 `obsidian-export.ts`（那是 2026-11-12 逐条对照
 * `st3v3nmw/obsidian-spaced-repetition` 官方文档写的）。这里守那几条硬规则：
 *  - 多行卡的正反面用**单独一行**的 `?` 分隔
 *  - 卡片之间必须**空行**（否则插件会连成一张卡）
 *  - 文件顶部要有 `#flashcards` 标签（否则不进复习队列）
 */

import { describe, expect, it } from 'vitest';
import {
  flashcardFileName,
  flashcardToMarkdown,
  flashcardsToObsidianMarkdown,
} from './flashcard-export.ts';
import type { Flashcard } from '@/core/model.ts';

const card = (over: Partial<Flashcard> = {}): Flashcard =>
  ({
    id: 'fc1',
    frontText: '导数的定义是什么？',
    backText: '差商的极限',
    backNote: null,
    origin: 'user',
    sourceId: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }) as Flashcard;

describe('单张卡', () => {
  it('正面、单独一行的 ?、背面', () => {
    const md = flashcardToMarkdown(card(), { wrapFormulas: false });
    const lines = md.split('\n');
    expect(lines[0]).toBe('导数的定义是什么？');
    /* ★ 「?」必须自占一行 —— 这是插件识别多行卡的唯一依据 */
    expect(lines[1]).toBe('?');
    expect(lines[2]).toBe('差商的极限');
  });

  it('★ 多行正面仍然只有一处单独的 ?（不会被正文里的问号干扰）', () => {
    const md = flashcardToMarkdown(
      card({ frontText: '第一行\n第二行？这里也有问号' }),
      { wrapFormulas: false },
    );
    const lines = md.split('\n');
    /* 只有第 3 行（index 2）是分隔符 */
    const seps = lines.map((l, i) => (l === '?' ? i : -1)).filter((i) => i >= 0);
    expect(seps).toHaveLength(1);
    expect(lines[seps[0]! - 1]).toBe('第二行？这里也有问号');
  });

  it('旧卡没有 backText 时用 backNote 当背面', () => {
    const md = flashcardToMarkdown(
      card({ backText: undefined, backNote: '旧笔记' }),
      { wrapFormulas: false },
    );
    expect(md).toContain('旧笔记');
  });

  it('没有背面时写一句说明，而不是留空', () => {
    /*
     * 留空的话，用户在 Obsidian 里翻卡会看到一片空白，
     * 会以为导出坏了。明确写一句「还没写背面」才是诚实的。
     */
    const md = flashcardToMarkdown(card({ backText: null, backNote: null }), {
      wrapFormulas: false,
    });
    expect(md).toContain('?');
    expect(md).toContain('还没有写背面');
  });

  it('可选地带上来历', () => {
    const md = flashcardToMarkdown(card(), { wrapFormulas: false, includeSource: true }, '信号与系统 · 第2章');
    expect(md).toContain('来自：信号与系统 · 第2章');
  });

  it('不带来源时不会凭空多出一行', () => {
    const md = flashcardToMarkdown(card(), { wrapFormulas: false, includeSource: true }, null);
    expect(md).not.toContain('来自：');
  });
});

describe('一整份文件', () => {
  const cards = [
    card({ id: 'a', frontText: 'A 正面', backText: 'A 背面' }),
    card({ id: 'b', frontText: 'B 正面', backText: 'B 背面' }),
  ];

  it('★ 顶部有 #flashcards 标签（否则不进复习队列）', () => {
    const { content } = flashcardsToObsidianMarkdown('我的闪卡', cards, { wrapFormulas: false });
    expect(content).toContain('#flashcards');
  });

  it('★ 卡片之间有空行（否则插件会连成一张卡）', () => {
    const { content } = flashcardsToObsidianMarkdown('我的闪卡', cards, { wrapFormulas: false });
    /* A 背面之后必须紧接一个空行，再是 B 正面 */
    expect(content).toContain('A 背面\n\nB 正面');
  });

  it('有 frontmatter 标题（Obsidian 快速切换里能按名字找到）', () => {
    const { content } = flashcardsToObsidianMarkdown('我的闪卡', cards, { wrapFormulas: false });
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('title: "我的闪卡"');
  });

  it('count 是卡片数', () => {
    const r = flashcardsToObsidianMarkdown('x', cards, { wrapFormulas: false });
    expect(r.count).toBe(2);
  });

  it('空列表也产出合法文件（只有头部），不崩', () => {
    const { content, count } = flashcardsToObsidianMarkdown('空', [], { wrapFormulas: false });
    expect(count).toBe(0);
    expect(content).toContain('#flashcards');
  });

  it('可以换标签名', () => {
    const { content } = flashcardsToObsidianMarkdown('x', cards, { tag: '考研', wrapFormulas: false });
    expect(content).toContain('#考研');
    expect(content).not.toContain('#flashcards');
  });
});

describe('文件名', () => {
  it('去掉各系统都不允许的字符', () => {
    const n = flashcardFileName('信号/系统:第2章?*"<>|', '2026-11-14');
    expect(n).not.toMatch(/[\\/:*?"<>|]/);
    expect(n.endsWith('.md')).toBe(true);
  });

  it('带日期后缀（同名不覆盖）', () => {
    expect(flashcardFileName('闪卡', '2026-11-14')).toBe('闪卡 · 2026-11-14.md');
  });

  it('超长标题被截断', () => {
    const n = flashcardFileName('长'.repeat(200), '2026-11-14');
    expect(n.length).toBeLessThan(90);
  });

  it('空标题有兜底名', () => {
    expect(flashcardFileName('   ', '2026-11-14')).toContain('闪卡');
  });
});
