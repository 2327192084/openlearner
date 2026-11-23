/**
 * AI 协助做闪卡的单测（2026-11-14；2026-11-23 加格式规范与挖空）。
 *
 * 用户要求：「闪卡的制作可以用到后端 ai 协助制作」。
 *
 * 这里不碰网络，钉三件事：
 *  - 提示词里那三条硬约束真的在（不许编造、正面能独立看懂、长度上限）
 *  - 解析要能扛住模型真实会返回的几种脏格式
 *  - ⚠️ **背面格式标记必须写进提示词**（2026-11-23）：用户 Obsidian 库里的
 *    卡都用 ✅答案 / 💡要点 / ⚠️限制条件 / ❌坑 四种标记行，
 *    渲染器（card-rich.ts）与导出（flashcard-export.ts）也按这四种实现。
 *    提示词若少要求任何一种，就是"AI 写的"与"界面渲染的"两件事 ——
 *    那正是本项目反复记的关系型盲区。
 */

import { describe, expect, it } from 'vitest';
import { buildCardPrompt, buildClozePrompt, cardsToDrafts, parseCards } from './make-flashcards.ts';

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

describe('⚠️ 背面格式标记必须写进提示词（2026-11-23，与渲染器/导出同源）', () => {
  const { system } = buildCardPrompt({ kind: 'wrong', text: '题干…答案…解析…' });

  it('四种标记行都在提示词里（少一种，AI 写的与界面渲染的就不是两回事）', () => {
    expect(system).toContain('✅答案');
    expect(system).toContain('💡要点');
    expect(system).toContain('⚠️限制条件');
    expect(system).toContain('❌坑');
  });

  it('要求「不适用的标记直接省略，不要硬凑」（否则模型会为凑格式编内容）', () => {
    expect(system).toContain('不要硬凑');
  });

  it('要点多条时改成有序列表（与用户库里那种写法一致）', () => {
    expect(system).toContain('有序列表');
  });

  it('错题素材必须给 ❌坑 行（用户要的就是"错在哪一步"）', () => {
    const wrong = buildCardPrompt({ kind: 'wrong', text: 'x' });
    expect(wrong.system + wrong.user).toContain('❌坑');
  });

  it('⚠️ 标题规则：单句正面不许硬加标题（钉住 11-23 那个"头部重述正文"的回归）', () => {
    /*
     * 这条与 card-rich.ts 的 splitFrontTitle 是同一件事的两端：
     * 渲染端「只有多行才有标题」+ 生成端「单句别加标题」，
     * 两边一起才不会出现头部和正文重复。
     */
    expect(system).toContain('不要硬加标题');
  });
});

describe('挖空（cloze）提示词：2026-11-23 用户拍板"两者都要"', () => {
  const { system } = buildClozePrompt({ kind: 'point', text: '欧拉公式' });

  it('要求用 ==高亮== 挖空（不是自己发明语法）', () => {
    /*
     * 依据：Obsidian Spaced Repetition 官方文档「填空卡片」一节
     * 认 ==高亮== / **加粗** / {{花括号}} 三种，==高亮== 导出后不用转换。
     * Anki 风格 {{c1:…}} 那个插件明确不支持，所以不用。
     *
     * ⚠️ 断言不能只写 toContain('==') —— 提示词里 `=` 到处都是，
     * 那种写法对坏实现也成立（"断言写得够宽 = 没在验"）。
     * 这里钉的是**示例里真的出现了一对 `==…==` 包裹的挖空**。
     */
    expect(system).toMatch(/==[^=\n]{1,12}==/);
  });

  it('限制每张最多挖 2 处（挖多了没法答）', () => {
    expect(system).toContain('最多挖 2 处');
  });

  it('⚠️ 禁止把整个公式挖掉（关系断言：挖的是该记的量，不是默写公式）', () => {
    expect(system).toContain('不许把整个公式挖掉');
  });

  it('背面按 ✅答案 组织（与问答卡同一套标记，导出/渲染不用分叉）', () => {
    expect(system).toContain('✅答案');
  });

  it('素材进 user，多张时要求挖不同的点', () => {
    const two = buildClozePrompt({ kind: 'point', text: '欧拉公式的内容' }, 2);
    expect(two.user).toContain('欧拉公式的内容');
    expect(two.user).toContain('不是同一个点');
  });

  it('输出格式仍是严格 JSON（复用 parseCards，不另写一套解析）', () => {
    expect(system).toContain('{"cards"');
    const r = parseCards('{"cards":[{"front":"幅值是 ==1==","back":"✅答案：1"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cards[0]!.front).toContain('==1==');
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
