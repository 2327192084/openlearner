import type { StorageAdapter } from '@/core/storage/types.ts';
import type { Card, CardKind } from '@/v2/core/cards.ts';
import type { Question, KnowledgePoint } from '@/core/model.ts';

/**
 * 把 v1 的「题目」与「知识点」统一加载成 v2 的 Card。
 *
 * ## 为什么需要这一层
 *
 * v1 有两套独立的数据：Question（题目）和 KnowledgePoint（知识点），
 * 各自有进度、各自有页面。间隔复习对两者一视同仁 ——
 * 都是「一张该在某个时间点复习的卡」。
 *
 * 如果为两者各写一套排程，就会出现 v1 的老问题：
 * 知识点和题目各有一套进度，复习时不知道该按哪个来。
 *
 * 所以这里做一次收敛：读出来，统一成 Card。
 */

export type CardLoader = () => Promise<Card[]>;

/** 知识点没有题型，映射成 point 卡片 */
function pointToCard(p: KnowledgePoint): Card {
  return {
    id: p.id,
    sourceId: p.sourceId ?? '',
    kind: 'point',
    // 知识点的主文本是 statement（概念表述）
    prompt: p.statement,
    options: [],
    answer: '',
    /**
     * 讲解用 quotes（原文引用）—— 那是知识点最有力的支撑。
     * 拼接多条引用，每条之间留空行，读起来像批注。
     */
    explanation: p.quotes.length > 0 ? p.quotes.join('\n\n') : '',
    anchors: p.anchors,
    deckId: `point:${p.sourceId ?? 'unknown'}`,
    createdAt: p.createdAt,
  };
}

/** 题目直接映射 */
function questionToCard(q: Question, sourceId: string | null): Card {
  return {
    id: q.id,
    sourceId: sourceId ?? '',
    kind: (q.kind as CardKind) ?? 'single',
    prompt: q.prompt,
    options: q.options.map((o) => ({ key: o.key, text: o.text })),
    answer: q.answer,
    explanation: q.explanation,
    anchors: q.anchors ?? [],
    deckId: q.deckId,
    createdAt: q.createdAt,
  };
}

/** 建一个从存储读取卡片的加载器 */
export function createCardLoader(storage: StorageAdapter): CardLoader {
  return async () => {
    const [questions, decks, points] = await Promise.all([
      storage.getAll('questions'),
      storage.getAll('decks'),
      storage.getAll('knowledgePoints'),
    ]);

    // 题目的 sourceId 要去 deck 上取（Question 自己没存）
    const deckSource = new Map(decks.map((d) => [d.id, d.sourceId]));

    /**
     * 知识点与题目的关系：
     * 一个知识点通常派生出多道题。
     * 如果两者都进队列，同一段内容会连着出现三四次，很烦。
     *
     * 规则：有题目的资料不再单独出「只读」知识点卡。
     * 没有题目的资料（只整理过知识点、还没出题）才把知识点当卡片读。
     */
    const sourcesWithQuestions = new Set(
      questions.map((q) => deckSource.get(q.deckId)).filter((s): s is string => Boolean(s)),
    );

    const cards: Card[] = [
      ...questions.map((q) => questionToCard(q, deckSource.get(q.deckId) ?? null)),
      ...points
        .filter((p) => !sourcesWithQuestions.has(p.sourceId ?? ''))
        .map(pointToCard),
    ];

    return cards;
  };
}
