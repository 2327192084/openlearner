/**
 * 学习库视角的数据装配：把三个来源（卡片 / 复习记录 / 知识点）拼成
 * 「学习地图」所需的结构。
 *
 * ## 为什么装配单独一层
 *
 * `study-map.ts` 是纯函数，不该碰存储；页面组件也不该各自查三张表
 * （各查一遍，三个界面的数字迟早对不上 —— 项目踩过
 * 「概览说已学 10 张、列表只有 3 张」）。
 * 这一层负责 I/O，纯函数负责计算，两边都能单独测。
 *
 * ## 一个容易搞错的点：卡片 id 就是题目 id
 *
 * `cards-loader.ts` 的 `questionToCard` 用 `q.id` 当卡片 id，
 * 所以「卡片 → 知识点」要经过**题目**这张表：
 *   card.id === question.id → question.knowledgePointId → knowledgePoint.chapter
 * 少了中间那一跳，所有题都会掉进「未归类」。
 *
 * ## 错题状态从哪来
 *
 * `ReviewRecord` 只存最终状态（没有「最近一次评级」字段），
 * 「最近一次答错」只能从 `reviewLogs` 派生 —— 与 `wrongCardsDetailed()`
 * 完全同一套规则。这里复用服务方法，不另写一份。
 */

import type { KnowledgePoint, Question } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { Card } from '@/v2/core/cards.ts';
import { mastery, isDue } from '@/v2/core/srs.ts';
import type { CardLoader } from './cards-loader.ts';
import { buildStudyMap, type MapPoint, type MapProgress, type StudyMap } from '@/v2/core/study-map.ts';

export interface StudySnapshot {
  map: StudyMap;
  /** 卡片 id → 卡片，供「最近在练」等地方回查题干 */
  cardById: Map<string, Card>;
  /** 题目 id → 知识点（已解引用，带上 chapter） */
  pointByQuestion: Map<string, MapPoint>;
  /** 今天到期的卡片 id */
  dueToday: Set<string>;
  /** 最近一次答错的卡片 id */
  wrongIds: Set<string>;
}

export interface SnapshotInput {
  loadCards: CardLoader;
  decks: DeckService;
  knowledge: KnowledgeService;
  reviewService: ReviewService;
  /** 资料标题查询；没有就退回 sourceId */
  sourceTitleOf?: (sourceId: string) => string | null;
  /** 今天（YYYY-MM-DD）。调用方传，便于测试与「今日到期」的规则只留一处 */
  today: string;
}

/**
 * 建一份完整快照。
 *
 * 所有「什么算到期」「什么算错题」的判断都复用服务层已有的实现，
 * 这里不重新实现一遍 —— 两份实现迟早分岔。
 */
export async function buildSnapshot(input: SnapshotInput): Promise<StudySnapshot> {
  const { loadCards, decks, knowledge, reviewService, sourceTitleOf, today } = input;

  const [cards, records, deckList, wrongDetailed] = await Promise.all([
    loadCards(),
    reviewService.listRecords(),
    decks.list(),
    reviewService.wrongCardsDetailed(),
  ]);

  /* ---------- 题目 → 知识点 ---------- */

  const pointIdByQuestion = new Map<string, string | null>();

  /*
   * 只为已发布题组取题目。
   *
   * loadCards() 只返回已发布题组的卡，所以这里的 deck 集合就是那些题组。
   * 逐组取：DeckService 没有「按 id 批量取题」的接口，
   * 而 getAll('questions') 会把草稿题一起捞出来。
   */
  await Promise.all(
    deckList.map(async (deck) => {
      let questions: Question[];
      try {
        questions = await decks.getQuestions(deck.id);
      } catch {
        return; // 题组刚被删：跳过，不影响其它组
      }
      for (const q of questions) pointIdByQuestion.set(q.id, q.knowledgePointId);
    }),
  );

  /*
   * 知识点逐条解引用。
   *
   * 先去重：一个知识点会被多道题共享，每条只查一次，
   * 避免 N 道题查 N 次。
   */
  const uniquePointIds = [...new Set([...pointIdByQuestion.values()].filter((id): id is string => !!id))];
  const points = await Promise.all(
    uniquePointIds.map(async (id) => {
      try {
        return await knowledge.get(id);
      } catch {
        return null;
      }
    }),
  );
  const pointById = new Map<string, KnowledgePoint>();
  for (const p of points) if (p) pointById.set(p.id, p);

  const pointByQuestion = new Map<string, MapPoint>();
  for (const [questionId, pointId] of pointIdByQuestion) {
    if (!pointId) continue;
    const p = pointById.get(pointId);
    if (!p) continue;
    pointByQuestion.set(questionId, { id: p.id, chapter: p.chapter, sourceId: p.sourceId });
  }

  /* ---------- 进度 ---------- */

  /*
   * 错题集合（2026-11-08 修）。
   *
   * ## 原来错在哪
   *
   * 早先直接 `new Set(wrongDetailed.map(w => w.cardId))`。
   * `wrongCardsDetailed()` 是**从 reviewLogs 聚合**出来的，
   * 它不知道题还在不在 —— 用户删掉一整个题组后，那些题的历史日志
   * 仍然留在库里（故意的：删题不该抹掉「你曾经错过什么」的记录）。
   *
   * 结果：首页角标显示「15 道错题待巩固」，点进错题页却是空的。
   * 错题页有 `if (!card) continue`（跳过已删的题），所以过滤掉了；
   * 而这里的角标没过滤。用户在真实数据上看到的就是这个矛盾：
   * reviewLogs 里 15 张错卡，一张都不在当前的 questions 表里
   * （旧题组删了、重新生成了一批新 id）。
   *
   * ## 现在
   *
   * 只保留**当前仍然存在的卡片**。判据是 `cardById`（来自 loadCards，
   * 只含已发布题组的题），与错题页用的是同一份集合 —— 两边口径一致，
   * 角标和列表就不会再对不上。
   *
   * 为什么不把这些历史日志也删掉：删题不该销毁「曾经错过」的记忆。
   * 如果以后要展示「历史错题（原题已删除）」，那是另一块 UI，
   * 不能混进这个角标 —— 角标是「现在有几道题要巩固」，点了必须看得到。
   */
  const cardIds = new Set(cards.map((c) => c.id));
  const wrongIds = new Set(
    wrongDetailed.map((w) => w.cardId).filter((id) => cardIds.has(id)),
  );
  const dueToday = new Set(
    records.filter((r) => isDue(r.state, today)).map((r) => r.cardId),
  );

  const progress = new Map<string, MapProgress>();
  for (const r of records) {
    progress.set(r.cardId, {
      mastery: mastery(r.state),
      due: dueToday.has(r.cardId),
      learned: r.state.reviewCount > 0,
      wrong: wrongIds.has(r.cardId),
    });
  }

  /* ---------- 聚合 ---------- */

  const map = buildStudyMap(cards, progress, pointByQuestion, { sourceTitleOf });

  return {
    map,
    cardById: new Map(cards.map((c) => [c.id, c])),
    pointByQuestion,
    dueToday,
    wrongIds,
  };
}
