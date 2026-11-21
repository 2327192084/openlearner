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

/**
 * 知识点没有题型，映射成 point 卡片。
 *
 * 导出给「学习路线」用（2026-11-21）：横板上点某一关要直接开练，
 * 而一关是**知识点**不是题目。走 `decks.getQuestion(pointId)` 必然查不到
 * （那张表里只有题目），界面会报「这道题已经不在了」—— 一个假错误。
 */
export function pointToCard(p: KnowledgePoint): Card {
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

/**
 * QuestionKind → CardKind 的**显式映射**。
 *
 * 原来写的是 `(q.kind as CardKind)` 强转。两个类型并不相同：
 * QuestionKind 有 `'essay'`（问答），而 CardKind 没有 ——
 * 于是库里一旦出现 essay 题，ReviewPage 会拿到一个它不认识的 kind：
 *   选项区不渲染（不是 single/multiple）、
 *   输入区不渲染（不是 blank/short）、
 *   但「提交答案」按钮照旧显示（canSubmit 对未知类型返回 true）
 * 结果是一个**看得见、点得动、但没有输入框**的提交按钮 —— 用户直接卡住。
 *
 * 映射规则：essay（长文本自评）→ short（简答，同为长文本自评）。
 * 两者在交互与判分上完全一致，是语义最近的一档。
 */
function toCardKind(k: Question['kind']): CardKind {
  switch (k) {
    case 'essay':
      return 'short';
    /*
     * 计算题（2026-11-12 定稿）：映射成 `short`，与问答题同一条路径。
     *
     * ## 为什么不是独立类型 + 数值判分
     *
     * 我最初加过独立的 `calc` 卡片类型与数值判分（0.5 与 1/2 等价）。
     * 但用户提出更合理的做法：
     *
     *   「让用户自主判断，我们显示详细解答过程和答案，用户自主判断对错。」
     *
     * 理由成立：计算过程复杂，只看最终数值会放过「数值对、过程错」，
     * 也会误伤「思路对、末步算错」。让人看着完整解答自评，比机器猜准。
     *
     * ## 但这一条不能省
     *
     * 即使映射成 short，也必须**显式**写在这里 —— 落到 default 会退回
     * 'single'，做题界面就渲染出一个没有输入框的死按钮。
     * 项目在 essay 上踩过一模一样的坑（见上方注释）。
     */
    case 'calc':
      return 'short';
    case 'single':
    case 'multiple':
    case 'truefalse':
    case 'blank':
      return k;
    default:
      /*
       * 未知类型（旧数据/手改备份）：退回 single 而不是崩。
       * 但要能看出来不对 —— 这类题在界面上至少还能作答。
       */
      return 'single';
  }
}

/**
 * 题目 → 卡片。
 *
 * 2026-11-19 导出：从笔记页「回到那道题」需要把一张题单独变成卡片。
 * 不导出的话，那边只能自己拼一个 Card —— 而 `kind` 的映射
 * （essay→short 那套）一旦复制就会漂移，出现「从笔记打开做不了题」。
 */
export function questionToCard(q: Question, sourceId: string | null): Card {
  return {
    id: q.id,
    sourceId: sourceId ?? '',
    kind: toCardKind(q.kind),
    prompt: q.prompt,
    options: q.options.map((o) => ({
      key: o.key,
      text: o.text,
      /* 选项级解析（2026-11-08）。老题没有 why，透传 undefined —— 界面按「没有就不显示」处理 */
      ...(o.why ? { why: o.why } : {}),
    })),
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
