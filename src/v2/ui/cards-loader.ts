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
/**
 * 卡片池的取法。
 *
 * ## 为什么要分开（2026-11-07 用户实测暴露）
 *
 * 用户点了「开始做题」，界面说「今天有 95 张卡片可以做」——
 * 但那 95 张里**大部分是知识点**，不是题。
 *
 * 根因：卡片池原来把知识点也算进去（为了让「复习」也能推送只读知识点）。
 * 但「开始做题」这个入口按名思义只该出**题**。把知识点混进来有两个问题：
 *  1. 数字骗人：用户以为有 95 道题要做，其实题没那么多；
 *  2. 做题体验被打断：做两道题插一条只读知识点，节奏全乱。
 *
 * 所以分两个池：
 *  - `'questions'`：只含题（做题入口用这个）
 *  - `'all'`：题 + 知识点（学习知识 / 统计用这个）
 */
export type CardPoolMode = 'questions' | 'all';

export function createCardLoader(
  storage: StorageAdapter,
  mode: CardPoolMode = 'questions',
): CardLoader {
  return async () => {
    const [questions, decks, points] = await Promise.all([
      storage.getAll('questions'),
      storage.getAll('decks'),
      storage.getAll('knowledgePoints'),
    ]);

    /*
     * **只取已发布题组里的题。**
     *
     * 为什么必须过滤（2026-11-07 查出的问题）：
     * 计划书 P3 第 2 条要求「生成 → 人工检查 → 发布后学生才开始刷」。
     * 但原来这里不看 deck.status，草稿题直接进了复习队列 ——
     * 用户没检查过的题就被当成正式题做了，等于跳过了那道关。
     *
     * 现在草稿留在「我的题组」里等检查，发布后才进复习。
     */
    const publishedDecks = decks.filter((d) => d.status === 'published');
    const publishedIds = new Set(publishedDecks.map((d) => d.id));
    const usableQuestions = questions.filter((q) => publishedIds.has(q.deckId));

    // 题目的 sourceId 要去 deck 上取（Question 自己没存）
    const deckSource = new Map(publishedDecks.map((d) => [d.id, d.sourceId]));

    /**
     * 知识点与题目的关系：
     * 一个知识点通常派生出多道题。
     * 如果两者都进队列，同一段内容会连着出现三四次，很烦。
     *
     * 规则：有题目的资料不再单独出「只读」知识点卡。
     * 没有题目的资料（只整理过知识点、还没出题）才把知识点当卡片读。
     */
    const sourcesWithQuestions = new Set(
      usableQuestions
        .map((q) => deckSource.get(q.deckId))
        .filter((s): s is string => Boolean(s)),
    );

    const questionCards = usableQuestions.map((q) =>
      questionToCard(q, deckSource.get(q.deckId) ?? null),
    );

    // 只要题的入口（开始做题）到此为止 —— 不要把知识点混进去
    if (mode === 'questions') return questionCards;

    /*
     * 'all' 模式才带上知识点：
     * 有题的资料不再单独出「只读」知识点卡（同一段内容会连着出现好几次），
     * 只整理过知识点、还没出题的资料才把知识点当卡片读。
     */
    return [
      ...questionCards,
      ...points.filter((p) => !sourcesWithQuestions.has(p.sourceId ?? '')).map(pointToCard),
    ];
  };
}
