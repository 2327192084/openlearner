/**
 * AI 协助做闪卡的单测（2026-11-14）。
 *
 * 用户要求：「闪卡的制作可以用到后端 ai 协助制作」。
 *
 * 这里不碰网络，只钉两件事：
 *  - 提示词里那三条硬约束真的在（不许编造、正面能独立看懂、长度上限）
 *  - 解析要能扛住模型真实会返回的几种脏格式
 */

import { describe, expect, it } from 'vitest';
import { buildCardPrompt, cardsToDrafts, parseCards } from './make-flashcards.ts';

describe('提示词：三条硬约束必须写进去', () => {
  const { system } = buildCardPrompt({ kind: 'point', text: '导数的定义' });

  it('★ 不许编造素材里没有的事实', () => {
    expect(system).toContain('只用素材里出现过的事实');
    expect(system).toContain('不许补充背景知识');
  });

  it('★ 正面必须能独立看懂（不许出现指代）', () => {
    expect(system).toContain('能独立看懂');
    expect(system).toContain('如上所述');
  });

  it('★ 有长度上限（太长的卡背不下来）', () => {
    expect(system).toContain('80 字');
    expect(system).toContain('200 字');
  });

  it('要求公式用 LaTeX', () => {
    expect(system).toContain('LaTeX');
  });

  it('输出格式是严格 JSON（解析才稳）', () => {
    expect(system).toContain('{"cards"');
  });

  it('素材不足以出卡时要求返回空数组而不是硬编', () => {
    expect(system).toContain('返回空数组');
  });
});

describe('提示词：按素材类型给不同做法', () => {
  it('知识点 → 改写成「问什么」', () => {
    const { user } = buildCardPrompt({ kind: 'point', text: '导数的定义' });
    expect(user).toContain('把「陈述」改写成「问什么」');
  });

  it('错题 → 背面要含「为什么错」', () => {
    const { user } = buildCardPrompt({ kind: 'wrong', text: '题干…答案…' });
    expect(user).toContain('为什么错');
  });

  it('自由文本 → 从中提炼能考的点', () => {
    const { user } = buildCardPrompt({ kind: 'text', text: '随便一段话' });
    expect(user).toContain('提炼');
  });

  it('素材原文被放进提示词（不是只给个 id）', () => {
    const { user } = buildCardPrompt({ kind: 'point', text: '导数的定义是差商的极限' });
    expect(user).toContain('导数的定义是差商的极限');
  });

  it('多张时要求角度不同（否则会给三张一样的）', () => {
    const { user } = buildCardPrompt({ kind: 'point', text: 'x' }, 3);
    expect(user).toContain('3 张');
    expect(user).toContain('角度要不同');
  });
});

describe('解析：扛住模型会返回的脏格式', () => {
  it('标准 JSON', () => {
    const r = parseCards('{"cards":[{"front":"问","back":"答"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards[0]).toEqual({ front: '问', back: '答' });
  });

  it('★ 被 ```json 代码块包起来（很常见）', () => {
    const r = parseCards('```json\n{"cards":[{"front":"问","back":"答"}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards).toHaveLength(1);
  });

  it('★ 前后带客套话', () => {
    const r = parseCards('好的，这是卡片：\n{"cards":[{"front":"问","back":"答"}]}\n希望有帮助！');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards).toHaveLength(1);
  });

  it('正面空白的卡被丢掉（翻开来是白的）', () => {
    const r = parseCards('{"cards":[{"front":"","back":"答"},{"front":"问2","back":"答2"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards).toHaveLength(1);
  });

  it('背面可以为空', () => {
    const r = parseCards('{"cards":[{"front":"问","back":""}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards[0]?.back).toBe('');
  });

  it('★ 空数组是合法结果，但文案要说清是「素材不够」而不是「故障」', () => {
    const r = parseCards('{"cards":[]}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不足以');
  });

  it('不是 JSON → 明确报错，不抛', () => {
    const r = parseCards('我无法完成这个任务。');
    expect(r.ok).toBe(false);
  });

  it('空返回 → 明确报错', () => {
    expect(parseCards('').ok).toBe(false);
    expect(parseCards('   ').ok).toBe(false);
  });

  it('没有 cards 键 → 明确报错', () => {
    const r = parseCards('{"items":[]}');
    expect(r.ok).toBe(false);
  });

  it('cards 不是数组 → 明确报错', () => {
    const r = parseCards('{"cards":"nope"}');
    expect(r.ok).toBe(false);
  });

  it('数组里混着垃圾项也不崩', () => {
    const r = parseCards('{"cards":[null, 42, {"front":"问","back":"答"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards).toHaveLength(1);
  });
});

describe('转成草稿', () => {
  it('★ 生成的卡标记 origin=ai（用户能看出哪几张是 AI 写的）', () => {
    const drafts = cardsToDrafts([{ front: '问', back: '答' }], { kind: 'point', sourceId2: 'kp1' });
    expect(drafts[0]?.origin).toBe('ai');
  });

  it('带上来源（仅追溯用）', () => {
    const drafts = cardsToDrafts([{ front: '问', back: '答' }], {
      kind: 'wrong',
      sourceId2: 'q1',
      sourceId: 's1',
    });
    expect(drafts[0]?.sourceKind).toBe('wrong');
    expect(drafts[0]?.sourceId2).toBe('q1');
    expect(drafts[0]?.sourceId).toBe('s1');
  });

  it('多张一起转，顺序不变', () => {
    const drafts = cardsToDrafts(
      [
        { front: 'A', back: 'a' },
        { front: 'B', back: 'b' },
      ],
      { kind: 'point' },
    );
    expect(drafts.map((d) => d.frontText)).toEqual(['A', 'B']);
  });

  it('空背面转成 null（不是空字符串）', () => {
    const drafts = cardsToDrafts([{ front: '问', back: '' }], { kind: 'manual' });
    expect(drafts[0]?.backText).toBeNull();
  });
});
