import { describe, expect, it } from 'vitest';
import {
  buildBindPrompt,
  parseBindSuggestions,
  type BindableCard,
  type BindableDeck,
  type BindableSection,
} from './bind-resources.ts';

/**
 * 「把库里已有的闪卡/题组自动绑到小节上」（2026-11-22）。
 *
 * ## 用户的原话
 *
 * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
 * > 但要留个给用户手工绑定的入口
 *
 * ## 这组测试守的核心
 *
 * **乱绑比不绑糟。** 漏绑的代价是用户自己补一次；乱绑的代价是他以为
 * 这一节已经有资源了，再也不去补 —— 而且会以为 AI 不行。
 *
 * 所以下面一半的用例在验「该丢的都丢了」。
 */

function section(over: Partial<BindableSection> = {}): BindableSection {
  return {
    id: 'sec-1',
    title: '1.1 连续时间信号',
    chapterTitle: '第1章 信号与系统',
    excerpt: '连续时间信号在时间上是连续的，用 f(t) 表示。',
    ...over,
  };
}

function card(id: string, front: string): BindableCard {
  return { id, front };
}

function deck(id: string, title: string): BindableDeck {
  return { id, title, questionCount: 5, sourceTitle: null };
}

describe('buildBindPrompt：提示词要能拦住乱绑', () => {
  it('包含小节、闪卡、题组三段清单', () => {
    const { user } = buildBindPrompt({
      sections: [section()],
      cards: [card('c1', '连续时间信号的定义')],
      decks: [deck('d1', '第1章练习')],
    });
    expect(user).toContain('## 小节清单');
    expect(user).toContain('## 闪卡清单');
    expect(user).toContain('## 题组清单');
  });

  it('⚠️ 明确写了「宁可不绑，不要乱绑」', () => {
    const { system } = buildBindPrompt({ sections: [], cards: [], decks: [] });
    expect(system).toContain('宁可不绑，不要乱绑');
    /* 还要说清代价，否则模型不会当回事 */
    expect(system).toContain('再也不去补');
  });

  it('⚠️ 明确要求只回序号、不要编 id', () => {
    const { system } = buildBindPrompt({ sections: [], cards: [], decks: [] });
    expect(system).toContain('只回编号，不要回 id');
    expect(system).toContain('不要自己编 id');
  });

  it('⚠️ 明确说同一组只能绑一个小节（否则两节进度互相牵连）', () => {
    const { system } = buildBindPrompt({ sections: [], cards: [], decks: [] });
    expect(system).toContain('只能绑到一个小节');
    expect(system).toContain('互相牵连');
  });

  it('给了正文摘录（光有标题模型判断不了）', () => {
    const { user } = buildBindPrompt({
      sections: [section({ excerpt: '这一段讲采样定理' })],
      cards: [],
      decks: [],
    });
    expect(user).toContain('这一段讲采样定理');
  });

  it('摘录会被截断（防止撑爆提示词）', () => {
    const { user } = buildBindPrompt({
      sections: [section({ excerpt: 'x'.repeat(500) })],
      cards: [],
      decks: [],
    });
    /* 截断到 160 字后，整行长度应远小于 500 */
    expect(user.indexOf('x'.repeat(300))).toBe(-1);
  });

  it('清单为空时给明确说明（不是留空白让模型猜）', () => {
    const { user } = buildBindPrompt({ sections: [], cards: [], decks: [] });
    expect(user).toContain('（库里还没有闪卡）');
    expect(user).toContain('（库里还没有题组）');
  });

  it('闪卡太多时只列前 80 条，并说明还有多少', () => {
    const cards = Array.from({ length: 100 }, (_, i) => card(`c${i}`, `卡${i}`));
    const { user } = buildBindPrompt({ sections: [], cards, decks: [] });
    expect(user).toContain('还有 20 张没列出');
  });
});

describe('parseBindSuggestions：合法输入', () => {
  const sectionIds = ['sec-1', 'sec-2'];
  const cardIds = ['c1', 'c2', 'c3'];
  const deckIds = ['d1', 'd2'];

  it('序号正确映射回 id', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 2, cards: [1, 3], decks: [2] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.sectionId).toBe('sec-2');
    expect(r.suggestions[0]!.cardIds.sort()).toEqual(['c1', 'c3'].sort());
    expect(r.suggestions[0]!.deckIds).toEqual(['d2']);
  });

  it('带 ```json 围栏也能解析', () => {
    const r = parseBindSuggestions(
      '```json\n{"binds":[{"section":1,"cards":[1]}]}\n```',
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.sectionId).toBe('sec-1');
  });

  it('前后有解释文字也能解析（抠出 JSON 对象）', () => {
    const r = parseBindSuggestions(
      '好的，结果如下：\n{"binds":[{"section":1,"decks":[1]}]}\n以上就是结果。',
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
  });

  it('空 binds 数组 → 成功但零建议（这是正常情况）', () => {
    const r = parseBindSuggestions('{"binds":[]}', sectionIds, cardIds, deckIds);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([]);
    expect(r.dropped).toBe(0);
  });

  it('某小节只给 cards 不给 decks 也能用', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 1, cards: [1] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.deckIds).toEqual([]);
  });
});

describe('⚠️ parseBindSuggestions：该丢的都丢了', () => {
  const sectionIds = ['sec-1', 'sec-2'];
  const cardIds = ['c1', 'c2'];
  const deckIds = ['d1'];

  it('小节序号越界 → 丢（模型可能编出第 99 节）', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 99, cards: [1] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([]);
    expect(r.dropped).toBeGreaterThan(0);
  });

  it('闪卡序号越界 → 丢那一张，但同小节的其他卡保留', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 1, cards: [1, 99] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.cardIds).toEqual(['c1']);
    expect(r.dropped).toBe(1);
  });

  it('⚠️ 同一张卡绑到两个小节 → 只保留第一个（否则两节进度互相牵连）', () => {
    const r = parseBindSuggestions(
      JSON.stringify({
        binds: [
          { section: 1, cards: [1] },
          { section: 2, cards: [1] },
        ],
      }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const holders = r.suggestions.filter((s) => s.cardIds.includes('c1'));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.sectionId).toBe('sec-1');
    /* 第二个小节的卡被拒了 → 那节没卡没题组 → 整条丢弃 */
    expect(r.suggestions.find((s) => s.sectionId === 'sec-2')).toBeUndefined();
  });

  it('⚠️ 同一个题组绑到两个小节 → 只保留第一个', () => {
    const r = parseBindSuggestions(
      JSON.stringify({
        binds: [
          { section: 1, decks: [1] },
          { section: 2, decks: [1] },
        ],
      }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions.filter((s) => s.deckIds.includes('d1'))).toHaveLength(1);
  });

  it('同一小节重复出现 → 合并成一条', () => {
    const r = parseBindSuggestions(
      JSON.stringify({
        binds: [
          { section: 1, cards: [1] },
          { section: 1, cards: [2] },
        ],
      }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.cardIds.sort()).toEqual(['c1', 'c2'].sort());
  });

  it('⚠️ 空条目丢弃（既没卡也没题组，绑了没意义）', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 1, cards: [], decks: [] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([]);
  });

  it('序号是 0 或负数 → 丢（模型可能从 0 开始数）', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 0, cards: [0] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([]);
  });

  it('序号是字符串数字也能认', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: '1', cards: ['2'] }] }),
      sectionIds,
      cardIds,
      deckIds,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.cardIds).toEqual(['c2']);
  });
});

describe('parseBindSuggestions：坏输入不崩', () => {
  it('空内容 → 明确报错', () => {
    const r = parseBindSuggestions('', ['s'], ['c'], ['d']);
    expect(r.ok).toBe(false);
  });

  it('没有 binds 字段 → 明确报错', () => {
    const r = parseBindSuggestions('{"foo":1}', ['s'], ['c'], ['d']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('binds');
  });

  it('⚠️ 残缺 JSON → 整份拒绝（不修补括号）', () => {
    /*
     * 修补残缺括号会得到一个"看起来正常的错结果"——
     * 那比直接说"被截断了"糟得多。
     */
    const r = parseBindSuggestions('{"binds":[{"section":1,"cards":[1', ['s'], ['c'], ['d']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('截断');
  });

  it('完全不是 JSON → 明确报错', () => {
    const r = parseBindSuggestions('我建议把它们绑到第一节', ['s'], ['c'], ['d']);
    expect(r.ok).toBe(false);
  });

  it('binds 里混了 null / 字符串 → 跳过并计入 dropped', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [null, 'x', { section: 1, cards: [1] }] }),
      ['sec-1'],
      ['c1'],
      ['d1'],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(1);
    expect(r.dropped).toBe(2);
  });

  it('清单全空时任何建议都会被丢掉（没有可绑的东西）', () => {
    const r = parseBindSuggestions(
      JSON.stringify({ binds: [{ section: 1, cards: [1], decks: [1] }] }),
      [],
      [],
      [],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([]);
  });
});