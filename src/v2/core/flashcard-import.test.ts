import { describe, expect, it } from 'vitest';
import { parseFlashcardMarkdown, sourceKindOfGroup } from './flashcard-import.ts';
import { flashcardsToObsidianMarkdown } from './flashcard-export.ts';
import type { Flashcard } from '@/core/model.ts';

/** 造一张卡（只给用到的字段，其余按旧数据形状补齐） */
function card(over: Partial<Flashcard> & { frontText: string }): Flashcard {
  return {
    id: 'fc_' + over.frontText.slice(0, 6),
    backText: null,
    backNote: null,
    tags: [],
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...over,
  } as Flashcard;
}

describe('解析 Obsidian Callout 闪卡：平铺版式（用户库主力）', () => {
  const sample = [
    '> [!tip] 闪卡 1｜题1.8 $1^\\infty$无穷远处极限',
    '> **题目**',
    '> $$\\lim\\limits_{x \\to \\infty}$$',
    '> ✅答案：$e^3$',
    '> 💡要点：',
    '> 1. 万能公式',
    '> 2. 简化公式',
    '> ⚠️限制条件：只适用于底数为 $1+\\dfrac{a}{x}$',
  ].join('\n');

  it('切成一张卡：标题进正面，答案标记之后进背面', () => {
    const r = parseFlashcardMarkdown(sample);
    expect(r.cards).toHaveLength(1);
    const c = r.cards[0]!;
    expect(c.front).toContain('题1.8');
    expect(c.front).toContain('**题目**');
    expect(c.front).toContain('$$\\lim\\limits_{x \\to \\infty}$$');
    /* 答案不许漏进正面 —— 这种卡翻之前就看到答案就白做了 */
    expect(c.front).not.toContain('e^3');
    expect(c.back).toContain('✅答案：$e^3$');
    expect(c.back).toContain('💡要点：');
    expect(c.back).toContain('⚠️限制条件');
  });

  it('剥掉导出器写的「闪卡 N｜」编号（否则往返一次标题叠一层）', () => {
    const r = parseFlashcardMarkdown('> [!tip] 闪卡 7｜导数定义\n> ✅答案：差商的极限');
    expect(r.cards[0]!.front).toBe('导数定义');
    /* 再导出、再导入，标题不变长 */
    const again = parseFlashcardMarkdown('> [!tip] 闪卡 1｜导数定义\n> ✅答案：差商的极限');
    expect(again.cards[0]!.front).toBe('导数定义');
  });

  it('「核心规则卡」没有答案行：标题当正面、正文当背面', () => {
    const r = parseFlashcardMarkdown(
      ['> [!warning] 核心规则卡｜等价无穷小替换红线',
       '> - ✅乘除因子可以替换',
       '> - ❌相减禁止直接替换'].join('\n'),
    );
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.front).toBe('等价无穷小替换红线');
    expect(r.cards[0]!.back).toContain('乘除因子可以替换');
  });

  it('多个 callout 各成一张，不粘连', () => {
    const r = parseFlashcardMarkdown(
      ['> [!tip] 闪卡 1｜甲', '> ✅答案：A', '',
       '> [!tip] 闪卡 2｜乙', '> ✅答案：B'].join('\n'),
    );
    expect(r.cards.map((c) => c.front)).toEqual(['甲', '乙']);
    expect(r.cards.map((c) => c.back)).toEqual(['✅答案：A', '✅答案：B']);
  });
});

describe('解析 Obsidian Callout 闪卡：嵌套版式（数列极限错题闪卡）', () => {
  const sample = [
    '> [!question] 2.2',
    '> **题目**：设数列 $x_n>0$，则（）',
    '> (A) 0  (B) 存在但不为 0',
    '>',
    '> > [!answer] ✅答案：A',
    '> > 知识点：正项数列比值判别法',
    '> > 易错：只能用于 $x_n>0$',
  ].join('\n');

  it('内层 answer 之前是正面、之后是背面', () => {
    const r = parseFlashcardMarkdown(sample);
    expect(r.cards).toHaveLength(1);
    const c = r.cards[0]!;
    expect(c.front).toContain('2.2');
    expect(c.front).toContain('设数列');
    expect(c.front).not.toContain('比值判别法');
    expect(c.back).toContain('✅答案：A');
    expect(c.back).toContain('知识点：正项数列比值判别法');
    expect(c.back).toContain('易错');
  });

  it('内层头上的内容也算背面（`[!answer] ✅答案：A` 的 A 不许丢）', () => {
    const r = parseFlashcardMarkdown(sample);
    expect(r.cards[0]!.back).toContain('A');
  });
});

describe('解析 Obsidian Callout 闪卡：分节标签', () => {
  it('`#flashcards/高数` 之后的所有卡都带这个标签', () => {
    const r = parseFlashcardMarkdown(
      ['#flashcards/高数', '', '> [!tip] 闪卡 1｜甲', '> ✅答案：A',
       '', '#flashcards/信号与系统', '', '> [!tip] 闪卡 1｜乙', '> ✅答案：B'].join('\n'),
    );
    expect(r.cards.map((c) => c.tags)).toEqual([['高数'], ['信号与系统']]);
    expect(r.tags).toEqual(['高数', '信号与系统']);
  });

  it('裸 `#flashcards`（无子标签）→ 卡不带标签', () => {
    const r = parseFlashcardMarkdown('#flashcards\n\n> [!tip] 闪卡 1｜甲\n> ✅答案：A');
    expect(r.cards[0]!.tags).toEqual([]);
  });

  it('一张卡不含标签行本身（标签不许被吸进正文）', () => {
    const r = parseFlashcardMarkdown('#flashcards/高数\n\n> [!tip] 闪卡 1｜甲\n> ✅答案：A');
    expect(r.cards[0]!.front).not.toContain('#flashcards');
    expect(r.cards[0]!.back).not.toContain('#flashcards');
  });
});

describe('解析 Obsidian Callout 闪卡：健壮性', () => {
  it('跳过 YAML frontmatter', () => {
    const r = parseFlashcardMarkdown(
      ['---', 'title: "Open Learner 闪卡"', '---', '', '> [!tip] 闪卡 1｜甲', '> ✅答案：A'].join('\n'),
    );
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.front).toBe('甲');
  });

  it('折叠标记 `[!tip]-` 也认', () => {
    const r = parseFlashcardMarkdown('> [!tip]- 闪卡 1｜甲\n> ✅答案：A');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.front).toBe('甲');
  });

  it('CRLF 与 BOM 不影响', () => {
    const r = parseFlashcardMarkdown('\uFEFF> [!tip] 闪卡 1｜甲\r\n> ✅答案：A\r\n');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.front).toBe('甲');
  });

  it('不是 callout 的普通笔记 → 0 张卡，不报错', () => {
    const r = parseFlashcardMarkdown('# 我的笔记\n\n普通段落。\n\n- 列表项\n');
    expect(r.cards).toEqual([]);
    expect(r.ignoredLines).toBeGreaterThan(0);
  });

  it('空文件 → 0 张卡', () => {
    expect(parseFlashcardMarkdown('').cards).toEqual([]);
  });

  it('没有答案行也没有标题 → 整段当正面并告警（不静默吞掉）', () => {
    const r = parseFlashcardMarkdown('> [!note] \n> 一段没有答案标记的话');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.front).toContain('没有答案标记');
    expect(r.warnings.length).toBe(1);
  });
});

describe('往返：导出 → 导入必须还原出同样的卡（关系断言）', () => {
  const cards: Flashcard[] = [
    card({ frontText: '导数的定义是什么？', backText: '✅答案：差商的极限', sourceKind: 'point', tags: ['高数'] }),
    card({ frontText: '这题为什么错？\n**题目**：求极限', backText: '✅答案：1\n❌坑：直接替换', sourceKind: 'wrong', tags: ['高数'] }),
    card({ frontText: '自己记的一句', backText: null, sourceKind: 'manual' }),
  ];

  it('导出再导入，张数一样、正面一样、背面一样', () => {
    const out = flashcardsToObsidianMarkdown('Open Learner 闪卡', cards, {
      format: 'callout',
      clozeAnswer: false,
      deckByTag: true,
      includeSource: false,
    });
    const r = parseFlashcardMarkdown(out.content);

    expect(r.cards).toHaveLength(cards.length);

    /* 正面逐张比对（导出时多行正面的第一行被提成标题，导入要把它拼回去） */
    const fronts = r.cards.map((c) => c.front.replace(/\s+/g, ' ').trim());
    expect(fronts[0]).toBe('导数的定义是什么？');
    expect(fronts[1]).toContain('**题目**：求极限');
    expect(fronts[2]).toBe('自己记的一句');

    /* 背面里的四条标记行一条不许丢 */
    expect(r.cards[1]!.back).toContain('❌坑：直接替换');
    expect(r.cards[0]!.back).toContain('✅答案：差商的极限');
  });

  it('往返后标签回到卡上（导出按标签分节 → 导入按分节赋标签）', () => {
    const out = flashcardsToObsidianMarkdown('Open Learner 闪卡', cards, {
      format: 'callout',
      clozeAnswer: false,
      deckByTag: true,
      includeSource: false,
    });
    const r = parseFlashcardMarkdown(out.content);
    const tagged = r.cards.filter((c) => c.tags.includes('高数'));
    /* 两张带「高数」标签的卡必须都在这一节里 */
    expect(tagged).toHaveLength(2);
  });

  it('往返一次不会让标题叠成「闪卡 1｜闪卡 1｜…」', () => {
    const once = flashcardsToObsidianMarkdown('Open Learner 闪卡', cards, {
      format: 'callout', clozeAnswer: false, includeSource: false,
    });
    const r1 = parseFlashcardMarkdown(once.content);
    const twice = flashcardsToObsidianMarkdown(
      'Open Learner 闪卡',
      r1.cards.map((c, i) => card({ id: 'fc_t' + i, frontText: c.front, backText: c.back, tags: c.tags })),
      { format: 'callout', clozeAnswer: false, includeSource: false },
    );
    const r2 = parseFlashcardMarkdown(twice.content);
    expect(r2.cards.map((c) => c.front)).toEqual(r1.cards.map((c) => c.front));
    expect(r2.cards.every((c) => !/闪卡\s*\d+\s*｜闪卡/.test(c.front))).toBe(true);
  });
});

describe('sourceKindOfGroup：界面分组 → 数据层来源', () => {
  it('三档映射', () => {
    expect(sourceKindOfGroup('point')).toBe('point');
    expect(sourceKindOfGroup('wrong')).toBe('wrong');
    expect(sourceKindOfGroup('memory')).toBe('manual');
  });
});
