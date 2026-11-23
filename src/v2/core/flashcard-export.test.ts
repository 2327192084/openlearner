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
  flashcardToCalloutMarkdown,
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

  it('★ 卡片之间有空行（否则插件会连成一张卡）—— review 版式', () => {
    /*
     * 这条本意是"卡之间必须真空行"（实测第 6 条：少了会连成一张、
     * 后一张答案漏进前一张）。用 review 版式跑，因为它的正文
     * 就是裸的 `A 正面 / ? / A 背面`，字面断言最直接。
     * callout 版式另有一条结构断言（下面）。
     */
    const { content } = flashcardsToObsidianMarkdown('我的闪卡', cards, {
      wrapFormulas: false,
      format: 'review',
    });
    expect(content).toContain('A 背面\n\nB 正面');
  });

  it('★ callout 版式：相邻两张卡之间也是真空行（不能单换行粘连）', () => {
    /*
     * 上一版这里写成 `section.join('\n')`，实测「导出 5 张、
     * 插件只认 1 个 question」—— 整节的卡全粘成一张。
     * 这条照插件的断卡规则写：每张卡以 `> ` 开头，
     * 两张卡之间必须正好隔一个空行。
     */
    const { content } = flashcardsToObsidianMarkdown('我的闪卡', cards, {
      wrapFormulas: false,
    });
    const lines = content.split('\n');
    /* 找每个 callout 起始行（`> [!...] 闪卡 N`） */
    const starts = lines
      .map((l, i) => (/^> \[!(?:tip|note|quote)\]/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    expect(starts).toHaveLength(2);
    /* 第一张卡的最后一行与第二张卡的起始行之间必须有一个空行 */
    const firstEnd = starts[1]! - 1;
    expect(lines[firstEnd]).toBe('');
    /* 且第一张卡不是只有一行（说明两张真的分开了） */
    expect(starts[1]! - starts[0]!).toBeGreaterThan(2);
  });

  it('★ 导出的卡数 = 每张都成为独立 question（不粘连、不裂开）', () => {
    /*
     * 结构上数"有几段 callout"，必须等于传进来的卡数。
     * 反向验证：把 bodies 的 join('\n\n') 改回 join('\n')，
     * 这里 starts 会只剩 1 个 → 变红。
     */
    const three = [
      card({ id: 'a', frontText: 'A', backText: '✅答案：a' }),
      card({ id: 'b', frontText: 'B', backText: '✅答案：b' }),
      card({ id: 'c', frontText: 'C', backText: '✅答案：c' }),
    ];
    const { content, count } = flashcardsToObsidianMarkdown('x', three, {
      wrapFormulas: false,
    });
    expect(count).toBe(3);
    const heads = content.split('\n').filter((l) => /^> \[!/.test(l));
    expect(heads).toHaveLength(3);
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

/*
 * 2026-11-23 新增：版式 / 填空 / 标签分节 / 正文安全化。
 *
 * 每条都对应一次**真实解析器实测**（.tmp/sr-verify/run_export.cjs
 * 把导出产物喂进插件自己的 parse()），不是照文档推测。
 */

describe('callout 版式（默认，与用户库里现有闪卡文件同款）', () => {
  it('头部是 `> [!类型] 闪卡 N｜标题`，正文每行带 `> `', () => {
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '题1.8 复指数取实部\n**题目**\n$$x_4(t)=je^{(-2+j100)t}$$',
        backText: '✅答案：$e^{-2t}$',
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'wrong',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false },
      null,
      0,
    );
    const lines = md.md.split('\n');
    expect(lines[0]).toBe('> [!tip] 闪卡 1｜题1.8 复指数取实部');
    expect(lines[1]).toBe('> **题目**');
    expect(lines[2]).toBe('> $$x_4(t)=je^{(-2+j100)t}$$');
    expect(md.cloze).toBe('answer');
  });

  it('⚠️ 单行正面**不写标题**（与界面 splitFrontTitle 同一条规则）', () => {
    /*
     * 11-23 出过"头部重述正文"的回归：单行长句被当标题，
     * 于是同一句话出现两遍。导出这边必须同规则，
     * 否则导出的文件在 Obsidian 里犯同样的错。
     * 反向验证：把 titleOfFront 改成"永远取第一行"，这条红。
     */
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '两个周期信号之和的周期性取决于周期之比：若为有理数则仍为周期信号。',
        backText: '✅答案：有理数',
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'point',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false },
      null,
      2,
    );
    const lines = md.md.split('\n');
    /* 没有「｜」，因为根本没有标题 */
    expect(lines[0]).toBe('> [!note] 闪卡 3');
    expect(lines[1]).toContain('两个周期信号之和的周期性取决于周期之比');
    /* ⚠️ 关系断言：那句话只出现一次 */
    const hits = lines.filter((l) => l.includes('两个周期信号之和'));
    expect(hits).toHaveLength(1);
  });

  it('答案行只包冒号后面的内容，保留 ✅答案： 前缀', () => {
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '问',
        backText: '✅答案：差商的极限',
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'point',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false },
      null,
      0,
    );
    expect(md.md).toContain('> ✅答案：==差商的极限==');
    /* 不能把标记也包进挖空（那样复习时不知道在答什么） */
    expect(md.md).not.toContain('> ==✅答案：差商的极限==');
  });

  it('⚠️ 正面已含挖空时不再包答案（否则一张裂成两张）', () => {
    /*
     * 实测第 3 条：一个 callout 内 N 个 ==…== 会展开成 N 张独立卡。
     * 用户手写的挖空卡再包一层答案 = 导出 1 张、复习 2 张，
     * 数量对不上。反向验证：去掉 frontHasCloze 判断，这条红。
     */
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '导数是 ==差商的极限==',
        backText: '✅答案：就是这个',
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'manual',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false },
      null,
      0,
    );
    /* 只有一处挖空（正面那个），答案行原样 */
    const blanks = md.md.split('\n').filter((l) => /==[^=\n]{1,200}==/.test(l));
    expect(blanks).toHaveLength(1);
    expect(md.cloze).toBe('front');
  });

  it('关了 clozeAnswer → cloze 为 null（这种卡进不了复习队列，要报告）', () => {
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '问',
        backText: '✅答案：答',
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'point',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false, clozeAnswer: false },
      null,
      0,
    );
    expect(md.cloze).toBeNull();
    expect(md.md).not.toContain('==');
  });

  it('没有背面时写一句说明，而不是留空', () => {
    const md = flashcardToCalloutMarkdown(
      {
        id: 'a',
        frontText: '只有正面',
        backText: null,
        backNote: null,
        origin: 'user',
        sourceId: null,
        sourceKind: 'point',
        createdAt: '',
        updatedAt: '',
      } as never,
      { wrapFormulas: false },
      null,
      0,
    );
    expect(md.md).toContain('（这张卡还没有写背面）');
    expect(md.cloze).toBeNull();
  });
});

describe('标签分卡组（用户：通过标签决定存放位置）', () => {
  const mk = (id: string, tags: string[], front = '问'): Flashcard =>
    ({
      id,
      frontText: front,
      backText: '✅答案：答',
      backNote: null,
      origin: 'user',
      sourceId: null,
      tags,
      createdAt: '',
      updatedAt: '',
    }) as Flashcard;

  it('每个标签一节 `#flashcards/<标签>`', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk('a', ['高数']), mk('b', ['信号'])], {
      wrapFormulas: false,
    });
    expect(r.content).toContain('#flashcards/高数');
    expect(r.content).toContain('#flashcards/信号');
    expect(r.decks).toHaveLength(2);
  });

  it('⚠️ 标签行与第一张卡之间必须是真空行（否则标签被吸进卡面正面）', () => {
    /* 实测第 5 条：少了空行，front 会变成 "#flashcards" */
    const r = flashcardsToObsidianMarkdown('x', [mk('a', ['高数'])], { wrapFormulas: false });
    const lines = r.content.split('\n');
    const at = lines.findIndex((l) => l === '#flashcards/高数');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('');
    expect(/^> \[!/.test(lines[at + 2]!)).toBe(true);
  });

  it('没打标签的卡落默认卡组并如实报告', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk('a', []), mk('b', ['高数'])], {
      wrapFormulas: false,
    });
    expect(r.decks.map((d) => d.tag)).toContain('flashcards');
    expect(r.warnings.join(' ')).toContain('1 张卡没打标签');
  });

  it('⚠️ 一张卡多个标签只进第一个卡组（不重复排期）', () => {
    /*
     * 同一张卡写进两节 → 插件里两张同名卡，复习被排两次。
     * 反向验证：把 key 改成对每个 tag 都建一节，这条红。
     */
    const r = flashcardsToObsidianMarkdown('x', [mk('a', ['高数', '错题本'])], {
      wrapFormulas: false,
    });
    expect(r.decks).toHaveLength(1);
    expect(r.decks[0]!.tag).toBe('flashcards/高数');
    expect(r.content).not.toContain('#flashcards/错题本');
  });

  it('deckByTag=false 时全部进一个卡组', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk('a', ['高数']), mk('b', ['信号'])], {
      wrapFormulas: false,
      deckByTag: false,
    });
    expect(r.decks).toHaveLength(1);
    expect(r.decks[0]!.count).toBe(2);
  });

  it('⚠️ decks 的卡数之和 = 传进来的卡数（关系断言）', () => {
    const cards = [mk('a', ['高数']), mk('b', ['信号']), mk('c', []), mk('d', ['高数'])];
    const r = flashcardsToObsidianMarkdown('x', cards, { wrapFormulas: false });
    const sum = r.decks.reduce((n, d) => n + d.count, 0);
    expect(sum).toBe(cards.length);
    expect(r.count).toBe(cards.length);
  });
});

describe('正文安全化（实测第 7、8 条：不处理会静默切错卡）', () => {
  const one = (front: string, back = '✅答案：答'): Flashcard =>
    ({
      id: 'a',
      frontText: front,
      backText: back,
      backNote: null,
      origin: 'user',
      sourceId: null,
      createdAt: '',
      updatedAt: '',
    }) as Flashcard;

  it('正文里的 :: 被零宽空格打断（否则被当单行卡切错）', () => {
    const r = flashcardsToObsidianMarkdown('x', [one('用 std::cout 输出')], {
      wrapFormulas: false,
    });
    /* 不再是连续的 :: */
    expect(r.content).not.toContain('std::cout');
    expect(r.content).toContain('std:');
    expect(r.warnings.join(' ')).toContain('::');
  });

  it('只有一行是裸 ? 时改成行内代码（否则被当分隔符）', () => {
    const r = flashcardsToObsidianMarkdown('x', [one('这题难吗\n?')], {
      wrapFormulas: false,
    });
    const bare = r.content.split('\n').filter((l) => l.trim() === '?');
    expect(bare).toHaveLength(0);
    expect(r.content).toContain('`?`');
  });

  it('⚠️ 正常问句（同行有别的字）不被误伤', () => {
    /* 实测第 8 条的边界：只有 trim 后**全等**才算分隔符 */
    const r = flashcardsToObsidianMarkdown('x', [one('这个结论对吗？为什么')], {
      wrapFormulas: false,
    });
    expect(r.content).toContain('这个结论对吗？为什么');
    expect(r.content).not.toContain('`?`');
  });

  it('安全化不改变卡数（每张仍是一张）', () => {
    const r = flashcardsToObsidianMarkdown(
      'x',
      [one('a::b'), one('c\n?'), one('正常卡')],
      { wrapFormulas: false },
    );
    expect(r.count).toBe(3);
    const heads = r.content.split('\n').filter((l) => /^> \[!/.test(l));
    expect(heads).toHaveLength(3);
  });
});

describe('warnings 如实报告（不许静默导出坏文件）', () => {
  const mk = (over: Partial<Flashcard> = {}): Flashcard =>
    ({
      id: 'a',
      frontText: '问',
      backText: '✅答案：答',
      backNote: null,
      origin: 'user',
      sourceId: null,
      createdAt: '',
      updatedAt: '',
      ...over,
    }) as Flashcard;

  it('关了填空开关 → 明确说"一张都进不了复习队列"', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk()], {
      wrapFormulas: false,
      clozeAnswer: false,
    });
    expect(r.warnings.join(' ')).toContain('进不了复习队列');
  });

  it('没写背面的卡数量被报出来', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk({ backText: null }), mk()], {
      wrapFormulas: false,
    });
    expect(r.warnings.join(' ')).toContain('1 张卡没写背面');
  });

  it('review 版式不受 cloze 开关影响（它有 ? 分隔符）', () => {
    const r = flashcardsToObsidianMarkdown('x', [mk()], {
      wrapFormulas: false,
      format: 'review',
      clozeAnswer: false,
    });
    expect(r.content).toContain('\n?\n');
    expect(r.warnings.join(' ')).not.toContain('进不了复习队列');
  });

  it('bidirectional 只在 review 版式生效（callout 里无处放 ??）', () => {
    const callout = flashcardsToObsidianMarkdown('x', [mk()], {
      wrapFormulas: false,
      bidirectional: true,
    });
    expect(callout.content).not.toContain('\n??\n');
    const review = flashcardsToObsidianMarkdown('x', [mk()], {
      wrapFormulas: false,
      format: 'review',
      bidirectional: true,
    });
    expect(review.content).toContain('\n??\n');
  });
});
