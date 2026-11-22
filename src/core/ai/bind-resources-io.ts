/**
 * 自动绑定的 IO 层：读库里的闪卡/题组 → 让模型审查 → 写回绑定
 *（2026-11-22）。
 *
 * ## 与 `bind-resources.ts` 的分工
 *
 * 那个文件是**纯逻辑**（提示词 + 解析校验），能单测。
 * 这个文件碰真实的东西：读 storage、调模型、写回路线树。
 *
 * ## 为什么绑到「章节」而不是「具体某个小节」就完事
 *
 * `parseBindSuggestions` 是按小节给的。但实际调用时**一次只处理一章**：
 *  - 提示词长度可控（一次 5~10 节，而不是整本 30 节）
 *  - 模型判断质量更高（上下文小）
 *  - 失败只影响一章，不用整本重来
 *
 * ## 失败的处置：不影响地图本身
 *
 * 绑定是**增强**，不是创建地图的前置条件。绑定失败时地图照常可用，
 * 只是那几节没有绑定资源 —— 界面如实说明，不假装绑过。
 */

import type { Flashcard } from '@/core/model.ts';
import type { Deck } from '@/core/model.ts';
import type { SourceSegment } from '@/core/model.ts';
import type { SourceTree, SectionNode, ChapterNode } from '@/v2/core/source-tree.ts';
import {
  buildBindPrompt,
  parseBindSuggestions,
  type BindableCard,
  type BindableDeck,
  type BindableSection,
  type BindSuggestion,
} from './bind-resources.ts';

/** 调用模型的最小接口（由上层注入，测试里换假实现） */
export interface BindChat {
  (input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

/** 一次绑定的结果 */
export interface BindOutcome {
  /** 绑好的树（未绑定时收到的是原树） */
  tree: SourceTree;
  /** 这次绑了多少张卡 / 多少个题组 */
  cardsBound: number;
  decksBound: number;
  /** 有几条建议被校验丢掉（如实告知，不静默） */
  dropped: number;
  /** 失败原因（成功时为空） */
  error: string | null;
}

/** 取正文摘录（给 AI 判断"这节讲什么"） */
function excerptOf(segments: readonly SourceSegment[], segmentIds: readonly string[]): string {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const parts: string[] = [];
  for (const id of segmentIds.slice(0, 3)) {
    const seg = byId.get(id);
    if (seg) parts.push(seg.text.replace(/\s+/g, ' ').trim());
  }
  /* 合并后截断 —— 提示词里每节只留一段摘录 */
  return parts.join(' ').slice(0, 200);
}

/**
 * 给一棵树做自动绑定。
 *
 * ## 逐章处理
 *
 * 每章单独发一次请求。失败一章不影响其他章（用 `for` 而不是 `Promise.all`：
 * 串行更省额度、也更容易在界面显示"正在处理第 N 章"）。
 *
 * ## 只绑「还没绑过的」小节
 *
 * 如果某节已经有绑定（用户手工绑的），**不覆盖** ——
 * 用户的明确选择优先于 AI 的推断。
 */
export async function autoBindTree(options: {
  tree: SourceTree;
  segments: readonly SourceSegment[];
  cards: readonly Flashcard[];
  decks: readonly Deck[];
  chat: BindChat;
  /** 每章最多给多少张卡（防止单章提示词过长） */
  maxCardsPerChapter?: number;
}): Promise<BindOutcome> {
  const { tree, segments, cards, decks, chat } = options;
  const maxCards = options.maxCardsPerChapter ?? 80;

  /*
   * 没有可绑的东西时**不发请求**。
   *
   * 用户库实测：闪卡 0 张。这时发请求只会白花额度，
   * 而且模型会一本正经地回一个空数组 —— 看起来像"AI 判断了但没有"，
   * 真相是"根本没有东西可判断"。
   */
  if (cards.length === 0 && decks.length === 0) {
    return {
      tree,
      cardsBound: 0,
      decksBound: 0,
      dropped: 0,
      error: null,
    };
  }

  /* 可绑的题组：只给已发布的（草稿用户还没认过，绑了也没法练） */
  const deckPool: BindableDeck[] = decks
    .filter((d) => d.status === 'published')
    .map((d) => ({
      id: d.id,
      title: d.title,
      questionCount: 0,
      sourceTitle: null,
    }));

  const cardPool: BindableCard[] = cards.map((c) => ({
    id: c.id,
    front: c.frontText,
  }));

  let cardsBound = 0;
  let decksBound = 0;
  let dropped = 0;
  let error: string | null = null;

  const chapters: ChapterNode[] = [];

  for (const ch of tree.chapters) {
    /* 已经有绑定的小节不再动（用户手工绑的优先） */
    const pending = ch.sections.filter(
      (s) =>
        (s.tasks.boundFlashcardIds?.length ?? 0) === 0 &&
        (s.tasks.boundDeckIds?.length ?? 0) === 0,
    );

    if (pending.length === 0) {
      chapters.push(ch);
      continue;
    }

    const sectionDescs: BindableSection[] = pending.map((s) => ({
      id: s.id,
      title: s.title,
      chapterTitle: ch.title,
      excerpt: excerptOf(segments, s.segmentIds),
    }));

    const { system, user } = buildBindPrompt({
      sections: sectionDescs,
      cards: cardPool,
      decks: deckPool,
    });

    let raw = '';
    try {
      raw = await chat({ systemPrompt: system, userPrompt: user });
    } catch (e) {
      /*
       * 一章失败就跳过这一章，继续下一章 ——
       * 不因为一次网络抖动让整份地图都没有绑定。
       * 但要把原因记下来（界面如实显示）。
       */
      error = e instanceof Error ? e.message : String(e);
      chapters.push(ch);
      continue;
    }

    const parsed = parseBindSuggestions(
      raw,
      sectionDescs.map((s) => s.id),
      cardPool.slice(0, maxCards).map((c) => c.id),
      deckPool.map((d) => d.id),
    );

    if (!parsed.ok) {
      error = parsed.reason;
      chapters.push(ch);
      continue;
    }

    dropped += parsed.dropped;

    /* 建议 → 写进对应小节 */
    const bySection = new Map<string, BindSuggestion>(
      parsed.suggestions.map((s) => [s.sectionId, s]),
    );

    chapters.push({
      ...ch,
      sections: ch.sections.map((s) => {
        const sug = bySection.get(s.id);
        if (!sug) return s;
        cardsBound += sug.cardIds.length;
        decksBound += sug.deckIds.length;
        return {
          ...s,
          tasks: {
            ...s.tasks,
            boundFlashcardIds: [...sug.cardIds],
            boundDeckIds: [...sug.deckIds],
          },
        };
      }),
    });
  }

  return {
    tree: { ...tree, chapters },
    cardsBound,
    decksBound,
    dropped,
    error,
  };
}

/**
 * 给单小节建议绑定（手工入口的「让 AI 帮我挑」按钮用）。
 *
 * 与 `autoBindTree` 的区别：只处理一节，返回**建议**而不是直接写 ——
 * 手工入口要让用户看一眼再决定。
 */
export async function suggestForSection(options: {
  section: SectionNode;
  chapterTitle: string;
  segments: readonly SourceSegment[];
  cards: readonly Flashcard[];
  decks: readonly Deck[];
  chat: BindChat;
}): Promise<{ cardIds: string[]; deckIds: string[]; error: string | null }> {
  const { section, chapterTitle, segments, cards, decks, chat } = options;

  if (cards.length === 0 && decks.length === 0) {
    return { cardIds: [], deckIds: [], error: null };
  }

  const cardPool: BindableCard[] = cards.map((c) => ({ id: c.id, front: c.frontText }));
  const deckPool: BindableDeck[] = decks
    .filter((d) => d.status === 'published')
    .map((d) => ({ id: d.id, title: d.title, questionCount: 0, sourceTitle: null }));

  const { system, user } = buildBindPrompt({
    sections: [
      {
        id: section.id,
        title: section.title,
        chapterTitle,
        excerpt: excerptOf(segments, section.segmentIds),
      },
    ],
    cards: cardPool,
    decks: deckPool,
  });

  let raw = '';
  try {
    raw = await chat({ systemPrompt: system, userPrompt: user });
  } catch (e) {
    return { cardIds: [], deckIds: [], error: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseBindSuggestions(
    raw,
    [section.id],
    cardPool.map((c) => c.id),
    deckPool.map((d) => d.id),
  );

  if (!parsed.ok) return { cardIds: [], deckIds: [], error: parsed.reason };

  const first = parsed.suggestions[0];
  return {
    cardIds: first?.cardIds ?? [],
    deckIds: first?.deckIds ?? [],
    error: null,
  };
}