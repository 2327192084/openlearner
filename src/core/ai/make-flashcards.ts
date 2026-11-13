/**
 * 用后端 AI 帮忙做闪卡（2026-11-14，用户要求）。
 *
 * ## 用户原话
 *
 * > 「闪卡的制作可以用到后端 ai 协助制作」
 *
 * ## 与现有 `pick-flashcards.ts` 的区别
 *
 * 那个（2026-11-08）做的是**挑**：从一堆知识点里选出「适合做卡的」，
 * 只返回知识点 id + 一句理由。用户勾完，卡片内容 = 知识点的 statement。
 *
 * 这里做的是**写**：给出素材（一段知识点、一道错题、或用户自己贴的一段话），
 * 让模型直接产出卡片的正面/背面文本。区别很关键 ——
 * 挑出来的是「知识点原句」，写出来的是「为记忆而组织过的一问一答」。
 *
 * 两者都保留：挑适合快速把一堆知识点变成卡；写适合单张精修。
 *
 * ## 三条写死的约束（都是踩过的坑）
 *
 * 1. **不许编造素材里没有的事实**。模型很爱"补充"背景知识，
 *    而在复习场景里，一句编造的公式比没有卡更糟 —— 用户会背错。
 * 2. **正面必须能独立看懂**，不能出现「如上所述」「这个」这种指代。
 * 3. **长度上限**：正面约 80 字、背面约 200 字。太长的卡背不下来，
 *    这与 pick-flashcards 里「不超过约 60 字」是同一条经验。
 *
 * ## 为什么输出用严格 JSON 而不是自由文本
 *
 * 自由文本要在本地猜「哪句是正面」。模型换个格式（加一句
 * 「好的，这是卡片：」）就解析崩了。JSON 能一次拿到结构化的两面，
 * 且解析失败时明确报错，不会把半截内容当成卡。
 */

import type { FlashcardDraft } from '@/core/flashcards.ts';

/** 送给模型的一段素材 */
export interface CardMaterial {
  /** 素材来源类型（只影响提示词的措辞） */
  kind: 'point' | 'wrong' | 'text';
  /** 素材正文（知识点表述 / 题干+答案 / 用户贴的一段话） */
  text: string;
  /** 可选：来源标题，帮助模型理解上下文 */
  hint?: string | null;
}

/**
 * 构造「写闪卡」的提示词。
 *
 * @param count 要几张（1-5）。多张时要求彼此角度不同，
 *   否则模型会给出三张几乎一样的卡。
 */
export function buildCardPrompt(
  material: CardMaterial,
  count = 1,
): { system: string; user: string } {
  const system = [
    '你是学习助手，任务是把给定素材做成**记忆闪卡**。',
    '',
    '## 硬规则（违反其中任何一条，输出就不可用）',
    '',
    '1. **只用素材里出现过的事实**。不许补充背景知识、不许推导素材里没有的结论。',
    '   如果素材不足以出一张卡，返回空数组，不要硬编。',
    '2. 正面是一个**能独立看懂**的问题或提示：不出现「如上所述」「这个」「它」这类指代。',
    '3. 正面不超过 80 字，背面不超过 200 字。太长的卡背不下来。',
    '4. 数学公式用 LaTeX：行内 `$...$`，独立成行用 `$$...$$`。',
    '5. 背面是**答案或解释**，不是把正面重说一遍。',
    '',
    '## 输出格式（严格 JSON，不要加任何解释文字、不要用 Markdown 代码块包起来）',
    '',
    '{"cards":[{"front":"…","back":"…"}]}',
  ].join('\n');

  const kindHint =
    material.kind === 'point'
      ? '素材是一条知识点。做法：把「陈述」改写成「问什么」，背面给答案或关键区别。'
      : material.kind === 'wrong'
        ? '素材是一道做错过的题（含题干、答案、解析）。做法：正面出题干要点，背面给答案与**为什么错**的关键。'
        : '素材是用户自己贴的一段内容。做法：从中提炼能考的点。';

  const user = [
    kindHint,
    material.hint ? `\n来源：${material.hint}` : '',
    '',
    '## 素材',
    '',
    material.text,
    '',
    count > 1
      ? `请出 ${count} 张卡，彼此角度要不同（例如一张考定义、一张考条件、一张考易错点）。`
      : '请出 1 张卡。',
  ].join('\n');

  return { system, user };
}

/** 解析模型返回的 JSON */
export type ParseCardsResult =
  | { ok: true; cards: { front: string; back: string }[] }
  | { ok: false; reason: string };

/**
 * 解析「写闪卡」的返回。
 *
 * 不抛错（与 `parsePicks` 同一原则）：调用方要能把失败原因显示给用户，
 * 而不是让整个界面崩掉。
 *
 * 容错三件：模型有时会用 ```json 包起来、有时前后带一句客套话、
 * 有时把 cards 写成单个对象。这三种都在真实使用里遇到过。
 */
export function parseCards(raw: string): ParseCardsResult {
  if (!raw || !raw.trim()) return { ok: false, reason: '模型没有返回内容' };

  let text = raw.trim();

  /* 去掉 ```json ... ``` 包裹 */
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();

  /* 前后可能有客套话：取第一个 { 到最后一个 } */
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) {
    return { ok: false, reason: '返回里没有找到 JSON 对象' };
  }
  text = text.slice(first, last + 1);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: '返回的不是合法 JSON' };
  }

  const rawCards = (body as { cards?: unknown }).cards;
  if (!Array.isArray(rawCards)) {
    return { ok: false, reason: '返回里没有 cards 数组' };
  }

  const out: { front: string; back: string }[] = [];
  for (const c of rawCards) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const front = typeof o.front === 'string' ? o.front.trim() : '';
    const back = typeof o.back === 'string' ? o.back.trim() : '';
    /*
     * 正面空白的卡直接丢：翻开来是白的，用户会以为坏了。
     * 背面可以为空（有的卡只想记一个提示）。
     */
    if (!front) continue;
    out.push({ front, back });
  }

  if (out.length === 0) {
    /*
     * 空数组也是**合法结果**（素材不足以出卡时模型应当这么回）。
     * 但要用不同的文案 —— 告诉用户「模型认为这段素材不适合做卡」，
     * 而不是「解析失败」。两者对他的下一步完全不同。
     */
    return { ok: false, reason: '模型认为这段素材不足以出一张卡（这是允许的结果，不是故障）' };
  }

  return { ok: true, cards: out };
}

/** 把解析出来的卡转成可直接入库的草稿 */
export function cardsToDrafts(
  cards: readonly { front: string; back: string }[],
  source: { kind: 'point' | 'wrong' | 'manual'; sourceId2?: string | null; sourceId?: string | null },
): FlashcardDraft[] {
  return cards.map((c) => ({
    frontText: c.front,
    backText: c.back || null,
    sourceKind: source.kind,
    sourceId2: source.sourceId2 ?? null,
    sourceId: source.sourceId ?? null,
    origin: 'ai' as const,
  }));
}
