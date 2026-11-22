/**
 * 「把库里已有的闪卡/题组绑到小节上」—— 自动为主，手工为辅（2026-11-22）。
 *
 * ## 用户的原话
 *
 * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
 * > 但要留个给用户手工绑定的入口
 *
 * ## 为什么需要 AI 来绑（自动反查为什么不够）
 *
 * 原来的自动反查有两条链，都可能断：
 *
 *   **闪卡**：小节的段 → 锚在这些段上的知识点 → 挂在这些知识点上的卡
 *   - 用户库实测**闪卡 0 张** —— 这条链永远是空的
 *   - 就算有卡，也只认"锚在同样几段上"的；用户自己建的卡不锚原文，反查不到
 *
 *   **题目**：小节的段 → 题目 anchors[].segmentId
 *   - 用户库 **41 道题锚点全部失效** —— 这条链也是空的
 *
 * 所以让 AI 直接读「这一节讲什么」+「库里有哪些卡/题组」，判断哪些属于这一节。
 * 这绕开了锚点这一层，而那正是坏掉的那层。
 *
 * ## 为什么 AI 只回编号不回 id
 *
 * 与 `pick-flashcards.ts` 同一个理由（那里实测过）：让模型回 uuid 会
 * 编造、会串号、会截断。回编号（1、2、3）再由本地映射回 id 是可靠的。
 *
 * ## 为什么保留手工入口
 *
 * AI 会判断错（尤其题组名很笼统时，如"第一章练习"）。用户看到绑定不对，
 * 得能自己改。所以 `SectionTasks.boundFlashcardIds` / `boundDeckIds`
 * 这两个字段同时被 AI 与用户写 —— 存的都是"用户认可的结果"。
 *
 * ## 纯逻辑
 *
 * 提示词构造 + 解析校验都在这里，不碰网络。
 */

/** 一条可绑定的闪卡（给 AI 看的精简形状） */
export interface BindableCard {
  id: string;
  /** 正面文字（提示词里截断） */
  front: string;
}

/** 一个可绑定的题组 */
export interface BindableDeck {
  id: string;
  title: string;
  /** 题目数（AI 据此判断这一组有多"重"） */
  questionCount: number;
  /** 题组的来源资料标题（可空） */
  sourceTitle: string | null;
}

/** 一个小节的描述（给 AI 判断用） */
export interface BindableSection {
  /** 小节 id（解析时映射回来） */
  id: string;
  /** 小节标题 */
  title: string;
  /** 所属章标题 */
  chapterTitle: string;
  /** 该小节正文的开头（截断，让 AI 知道这节讲什么） */
  excerpt: string;
}

/** 模型返回的一条绑定建议 */
export interface BindSuggestion {
  sectionId: string;
  cardIds: string[];
  deckIds: string[];
}

/** 解析结果 */
export type ParseBindResult =
  | { ok: true; suggestions: BindSuggestion[]; dropped: number }
  | { ok: false; reason: string };

/** 提示词里单个正文摘录最多多少字 */
const EXCERPT_MAX = 160;
/** 提示词里单张卡正面最多多少字 */
const CARD_FRONT_MAX = 60;
/** 最多给 AI 看多少张卡 —— 太多会撑爆提示词，且判断质量下降 */
const MAX_CARDS = 80;
/** 最多给多少个题组 */
const MAX_DECKS = 40;

/**
 * 构造「审查已有资源并绑定」的提示词。
 *
 * ## 为什么要给正文摘录
 *
 * 光有小节标题（`1.1 连续时间信号`）不够：卡/题组的文字往往不出现
 * 这个标题。给一段正文摘录，模型才能判断"这张卡讲的内容在这一节里"。
 *
 * ## 为什么要明确"宁可不绑，不要乱绑"
 *
 * 乱绑比不绑糟：用户看到这一节挂着不相关的卡，会以为 AI 不行；
 * 而且他会以为"这一节已经有卡了"，不再自己补。
 * 与路线规划里「不要把前面所有章都列成前置」是同一条原则。
 */
export function buildBindPrompt(input: {
  sections: readonly BindableSection[];
  cards: readonly BindableCard[];
  decks: readonly BindableDeck[];
}): { system: string; user: string } {
  const { sections, cards, decks } = input;

  const system = [
    '你是一位助教，正在把**已经存在的**闪卡与题组对应到教材的各小节上。',
    '',
    '## 你的任务',
    '',
    '读下面「小节清单」（每个小节带一段正文摘录），再读「闪卡清单」与「题组清单」，',
    '判断每一张卡 / 每一个题组讲的内容属于哪一个小节。',
    '',
    '## 四条硬规矩',
    '',
    '### 1. 宁可不绑，不要乱绑',
    '',
    '只在你**能从内容上判断**它属于某一节时才绑。',
    '看不出来就**不列** —— 漏绑的代价是用户自己补一次，',
    '乱绑的代价是他以为这一节已经有资源了，再也不去补。',
    '',
    '### 2. 只回编号，不要回 id',
    '',
    '闪卡回它在「闪卡清单」里的序号（从 1 开始），题组回它在「题组清单」里的序号。',
    '**不要自己编 id 或 uuid** —— 编号会被本地映射回真实 id。',
    '',
    '### 3. 一组卡/题组只能绑到一个小节',
    '',
    '如果一个题组横跨好几节（如"第一章综合练习"），绑到**最接近的那一节**，',
    '或者干脆不绑。不要同一组绑到多个小节 —— 那会让两节的进度互相牵连。',
    '',
    '### 4. 没有合适的小节就别硬塞',
    '',
    '如果所有清单都是空的，就回空数组。这是正常情况，不是失败。',
    '',
    '## 输出格式',
    '',
    '只输出一个完整 JSON 对象，不要解释文字，不要 markdown 围栏。',
    '括号必须完整 —— 残缺的结果会被整份丢弃。',
    '',
    '{',
    '  "binds": [',
    '    {',
    '      "section": 1,',
    '      "cards": [2, 5],',
    '      "decks": [1]',
    '    }',
    '  ]',
    '}',
    '',
    '`section` / `cards` / `decks` 都是**序号**（从 1 开始）。',
    '某一类没有就不给那个键，或给空数组。',
  ].join('\n');

  const user: string[] = [];

  user.push('## 小节清单', '');
  if (sections.length === 0) {
    user.push('（没有小节）');
  } else {
    sections.forEach((s, i) => {
      user.push(`${i + 1}. 【${s.chapterTitle}】${s.title}`);
      if (s.excerpt.trim().length > 0) {
        user.push(`   正文摘录：${s.excerpt.trim().slice(0, EXCERPT_MAX)}`);
      }
    });
  }
  user.push('');

  user.push('## 闪卡清单', '');
  if (cards.length === 0) {
    user.push('（库里还没有闪卡）');
  } else {
    cards.slice(0, MAX_CARDS).forEach((c, i) => {
      user.push(`${i + 1}. ${c.front.trim().slice(0, CARD_FRONT_MAX)}`);
    });
    if (cards.length > MAX_CARDS) {
      user.push(`（还有 ${cards.length - MAX_CARDS} 张没列出）`);
    }
  }
  user.push('');

  user.push('## 题组清单', '');
  if (decks.length === 0) {
    user.push('（库里还没有题组）');
  } else {
    decks.slice(0, MAX_DECKS).forEach((d, i) => {
      user.push(
        `${i + 1}. ${d.title}（${d.questionCount} 道题${d.sourceTitle ? `，来自《${d.sourceTitle}》` : ''}）`,
      );
    });
    if (decks.length > MAX_DECKS) {
      user.push(`（还有 ${decks.length - MAX_DECKS} 个没列出）`);
    }
  }
  user.push('');

  user.push(
    '请判断哪些闪卡/题组属于哪一小节，按上面的格式回 JSON。',
    '记住：看不出来就别绑，乱绑比不绑糟。',
  );

  return { system, user: user.join('\n') };
}

/**
 * 解析 AI 的绑定结果。
 *
 * ## 校验（每一条都有对应的坏实现）
 *
 * 1. **序号越界丢弃** —— 模型可能给出第 99 个闪卡（清单只有 10 个）
 * 2. **同一张卡绑到多个小节 → 只保留第一个** —— 那会让两节进度互相牵连
 * 3. **同一小节重复出现 → 合并**
 * 4. **空小节（既没卡也没题组）丢弃** —— 留着是无意义的空条目
 *
 * 返回 `dropped` 让调用方如实告知"有几条没采用"（不静默吞掉）。
 */
export function parseBindSuggestions(
  content: string,
  sectionIds: readonly string[],
  cardIds: readonly string[],
  deckIds: readonly string[],
): ParseBindResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }

  const json = extractJsonObject(content);
  if (!json.ok) return { ok: false, reason: json.reason };

  const rawBinds = (json.value as { binds?: unknown }).binds;
  if (!Array.isArray(rawBinds)) {
    return { ok: false, reason: '返回的 JSON 里没有 binds 数组。' };
  }

  /** 已经绑过的卡/题组 → 防重复绑到多个小节 */
  const usedCards = new Set<string>();
  const usedDecks = new Set<string>();

  /** sectionId → 建议（合并同一小节的多次出现） */
  const bySection = new Map<string, { cardIds: Set<string>; deckIds: Set<string> }>();

  let dropped = 0;

  for (const item of rawBinds) {
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const o = item as Record<string, unknown>;

    /* 序号从 1 开始，转成数组下标 */
    const sectionIdx = toIndex(o.section);
    if (sectionIdx === null || sectionIdx >= sectionIds.length) {
      dropped += 1;
      continue;
    }
    const sectionId = sectionIds[sectionIdx]!;

    const slot = bySection.get(sectionId) ?? { cardIds: new Set(), deckIds: new Set() };

    for (const raw of Array.isArray(o.cards) ? o.cards : []) {
      const idx = toIndex(raw);
      if (idx === null || idx >= cardIds.length) {
        dropped += 1;
        continue;
      }
      const id = cardIds[idx]!;
      /* 同一张卡已经绑到别的小节 → 不再绑第二次 */
      if (usedCards.has(id)) {
        dropped += 1;
        continue;
      }
      usedCards.add(id);
      slot.cardIds.add(id);
    }

    for (const raw of Array.isArray(o.decks) ? o.decks : []) {
      const idx = toIndex(raw);
      if (idx === null || idx >= deckIds.length) {
        dropped += 1;
        continue;
      }
      const id = deckIds[idx]!;
      if (usedDecks.has(id)) {
        dropped += 1;
        continue;
      }
      usedDecks.add(id);
      slot.deckIds.add(id);
    }

    bySection.set(sectionId, slot);
  }

  const suggestions: BindSuggestion[] = [];
  for (const [sectionId, slot] of bySection) {
    /* 空条目丢弃：既没卡也没题组，绑了也没意义 */
    if (slot.cardIds.size === 0 && slot.deckIds.size === 0) continue;
    suggestions.push({
      sectionId,
      cardIds: [...slot.cardIds],
      deckIds: [...slot.deckIds],
    });
  }

  return { ok: true, suggestions, dropped };
}

/** 把「从 1 开始的序号」转成「从 0 开始的下标」；非法返回 null */
function toIndex(raw: unknown): number | null {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return n - 1;
}

/**
 * 从可能带 markdown 围栏的回复里抠出 JSON 对象。
 *
 * 与 `source-route.ts` 的处理同一个思路：模型有时会加 ```json 围栏，
 * 有时前后带解释文字。**不修补残缺括号**（残缺就是残缺，硬补会得到
 * 一个看起来正常的错结果）。
 */
function extractJsonObject(
  content: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = content.trim();

  /* 去掉 ``` 围栏（有就剥，没有就用原文） */
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const body = fence ? (fence[1] ?? '') : text;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, reason: '返回里找不到 JSON 对象（可能被截断了，请重试）。' };
  }

  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: '返回的 JSON 不完整或格式不对（可能被截断了，请重试）。' };
  }
}