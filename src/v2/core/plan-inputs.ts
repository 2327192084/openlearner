/**
 * 学习顺序的**数据装配层**（2026-11-21）。
 *
 * ## 为什么单独一层
 *
 * 与 `study-snapshot.ts` 同一个理由：纯函数不该碰存储，页面组件也不该
 * 各自查三张表。这一层负责 I/O（读知识点、读复习记录、算弱项），
 * 纯函数（`ai/plan-order.ts`）负责提示词与解析，两边都能单独测。
 *
 * ## ⚠️ 掌握度是**本地算的**，不是模型给的
 *
 * 这是与 LogiNote 对齐的一条硬设计（交接文档 9.3）：
 * 它明确防过「把已有笔记等同于已经掌握」。我们做得更彻底 ——
 *  - **难度**（这个知识点本身难不难）→ 模型判断
 *  - **掌握度**（这个学生把它练得多熟）→ 本地按复习状态算
 *
 * 两者在提示词里分开表述，在数据结构里也分开字段。
 * 谁把这两个混成一个数字，这个功能就废了：
 * 模型会开始「因为学生没练过所以认为它难」，排序依据立刻失真。
 *
 * ## 掌握度的口径
 *
 * 直接复用 `srs.ts` 的 `mastery()`，不另写一份 ——
 * 两处口径不同的话，学习地图说「熟练」而学习顺序说「刚起步」，
 * 用户会不知道该信哪个（项目踩过一次「概览说已学 10 张、列表只有 3 张」）。
 *
 * 一个知识点可能对应多道题（`question.knowledgePointId → point.id`）。
 * 这时取**这些题里最好的那个状态**，理由见 `pointMastery` 的注释。
 */

import type { KnowledgePoint, Question } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import { mastery, todayLocal } from '@/v2/core/srs.ts';
import type { PlanPointInput } from '@/core/ai/plan-order.ts';
import type { ChapterCandidate } from '@/core/ai/chapter-backfill.ts';

/** 一天多少毫秒。只用来算两个日期串之间的天数差 */
const DAY_MS = 86400000;

/**
 * 两个 `YYYY-MM-DD` 之间差多少天（正数 = to 在 from 之后）。
 *
 * 用 UTC 解析再相减：`YYYY-MM-DD` 本身没有时区信息，
 * 按 UTC 解析就不会被本地时区/夏令时那一小时影响。
 * `srs.ts` 的 `addDays` 也是这个思路（那里额外加了 0.5 天）。
 */
export function daysBetween(from: string, to: string): number {
  const a = utcOf(from);
  const b = utcOf(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

function utcOf(dateStr: string): number | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return Date.UTC(y, mo - 1, d);
}

/** 一个知识点的本地弱项信号 */
export interface PointSignals {
  /** 掌握度 0–1（复用 srs.ts 的 mastery） */
  mastery: number;
  /** 累计答错次数（来自它关联的题） */
  wrongCount: number;
  /** 距上次复习多少天；null = 从没练过 */
  daysSinceReview: number | null;
}

/** 装配好的排序输入 + 用于回查知识点的索引 */
export interface PlanInputBundle {
  points: PlanPointInput[];
  /** 知识点 id → 原始记录（界面要显示陈述、跳转原文时用） */
  pointById: Map<string, KnowledgePoint>;
  /** 参与计算的题目数（诊断用：为什么有些知识点没有弱项信号） */
  questionCount: number;
}

export interface PlanInputOptions {
  knowledge: KnowledgeService;
  decks: DeckService;
  reviewService: ReviewService;
  /** 今天（YYYY-MM-DD）。调用方传，便于测试固定日期 */
  today?: string;
}

/**
 * 读出「参与学习顺序排序」的知识点清单。
 *
 * ## 哪些知识点进来
 *
 * 全部知识点都进来 —— 不做筛选。
 * 用户要的是「该按什么顺序学」，那是**整门课**的问题，
 * 按「练过的 / 没练过的」切片会让路径缺块。
 *
 * （`App.tsx` 里挑闪卡那个路径做过筛选，理由是「全量丢过去既贵又没必要」；
 *  这里不一样：105 条压成紧凑清单只有 5525 字符，整份塞得进一次提示词。）
 *
 * ## 哪些知识点有弱项信号
 *
 * 只有「被题目引用的」知识点才有复习状态 ——
 * v2 的复习记录是**按卡片**（题目 / 知识点各是一张卡）存的。
 * 所以一个知识点可能：
 *  - 自己被当作卡片复习过（`cardId === point.id`，kind='point'）
 *  - 由引用它的题目间接反映（`question.knowledgePointId === point.id`）
 *
 * 两者都看，取**最好的那个**（见 `pointMastery`）。
 * 两者都没有 → 没有信号，如实写「没练过」。
 */
export async function loadPlanInputs(options: PlanInputOptions): Promise<PlanInputBundle> {
  const { knowledge, decks, reviewService } = options;
  const today = options.today ?? todayLocal();

  const [points, records, wrongDetailed, deckList] = await Promise.all([
    knowledge.listAll(),
    reviewService.listRecords(),
    reviewService.wrongCardsDetailed(),
    decks.list(),
  ]);

  /* ---------- 题目 → 知识点 ---------- */

  /*
   * 只取已发布题组的题目：草稿题用户还没认可，不该影响学习路径。
   * 与 `study-snapshot.ts` 的做法一致（那里也是逐组取，
   * 因为 `getAll('questions')` 会把草稿一起捞出来）。
   */
  const pointIdByQuestion = new Map<string, string | null>();
  await Promise.all(
    deckList.map(async (deck) => {
      let questions: Question[];
      try {
        questions = await decks.getQuestions(deck.id);
      } catch {
        return; // 题组刚被删：跳过
      }
      for (const q of questions) pointIdByQuestion.set(q.id, q.knowledgePointId);
    }),
  );

  /* 知识点 id → 引用它的题目 id 列表 */
  const questionIdsByPoint = new Map<string, string[]>();
  for (const [qid, pid] of pointIdByQuestion) {
    if (!pid) continue;
    const arr = questionIdsByPoint.get(pid);
    if (arr) arr.push(qid);
    else questionIdsByPoint.set(pid, [qid]);
  }

  /* ---------- 复习状态索引 ---------- */

  const recordByCard = new Map<string, (typeof records)[number]>();
  for (const r of records) recordByCard.set(r.cardId, r);

  const wrongByCard = new Map<string, { wrongCount: number; lastWrongDay: string }>();
  for (const w of wrongDetailed) {
    wrongByCard.set(w.cardId, { wrongCount: w.wrongCount, lastWrongDay: w.lastWrongDay });
  }

  /* ---------- 逐条算信号 ---------- */

  const out: PlanPointInput[] = [];
  const pointById = new Map<string, KnowledgePoint>();

  for (const p of points) {
    pointById.set(p.id, p);
    const signals = pointSignals(p.id, questionIdsByPoint.get(p.id) ?? [], {
      recordByCard,
      wrongByCard,
      today,
    });

    out.push({
      id: p.id,
      statement: p.statement,
      chapter: p.chapter,
      cognitiveLevel: p.cognitiveLevel,
      mastery: signals.mastery,
      wrongCount: signals.wrongCount,
      daysSinceReview: signals.daysSinceReview,
    });
  }

  /*
   * 排序按创建时间稳定一下：两个知识点信号完全一样时，
   * 让提示词里的编号顺序可复现（否则同一份数据两次调模型，
   * 清单顺序可能不同，结果就不可比了）。
   */
  out.sort((a, b) => {
    const pa = pointById.get(a.id);
    const pb = pointById.get(b.id);
    const ca = pa?.createdAt ?? '';
    const cb = pb?.createdAt ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  return { points: out, pointById, questionCount: pointIdByQuestion.size };
}

/**
 * 一个知识点的弱项信号。
 *
 * ## 为什么取「最好的那个」而不是平均
 *
 * 一个知识点可能挂着 5 道题。如果按平均算，其中 1 道特别熟、4 道没练过，
 * 平均下来是「刚起步」—— 但用户对这 4 道没练过的确实没掌握。
 * 反过来 4 道熟、1 道没练过，平均也偏低。
 *
 * 取**最好的**（最高掌握度）表明「这个概念他已经懂了」——
 * 同一概念的不同问法不该重复拉低它的掌握度。这与
 * `study-map.ts` 里 `addCard` 按题数加权是不同层级的聚合：
 * 那层是「这一章掌握得怎样」，这层是「这个概念懂没懂」。
 *
 * 取不到任何状态时返回全零，界面如实说「没练过」——
 * 不猜一个中间值（猜 0.5 会让它看起来「练过但一般」）。
 */
function pointSignals(
  pointId: string,
  questionIds: readonly string[],
  ctx: {
    recordByCard: ReadonlyMap<string, { state: Parameters<typeof mastery>[0]; updatedAt: string }>;
    wrongByCard: ReadonlyMap<string, { wrongCount: number; lastWrongDay: string }>;
    today: string;
  },
): PointSignals {
  let bestMastery = 0;
  let learned = false;
  let wrongCount = 0;
  /** 最近一次复习/答错的日期（决定「多久没碰」） */
  let lastTouched: string | null = null;

  /* 知识点自己作为卡片被复习过的情况 */
  const selfRecord = ctx.recordByCard.get(pointId);
  if (selfRecord && selfRecord.state.reviewCount > 0) {
    learned = true;
    bestMastery = Math.max(bestMastery, mastery(selfRecord.state));
    lastTouched = laterOf(lastTouched, selfRecord.updatedAt.slice(0, 10));
  }

  for (const qid of questionIds) {
    const r = ctx.recordByCard.get(qid);
    if (r && r.state.reviewCount > 0) {
      const m = mastery(r.state);
      if (m > bestMastery) bestMastery = m;
      learned = true;
      lastTouched = laterOf(lastTouched, r.updatedAt.slice(0, 10));
    }
    const w = ctx.wrongByCard.get(qid);
    if (w) {
      wrongCount += w.wrongCount;
      lastTouched = laterOf(lastTouched, w.lastWrongDay);
    }
  }

  return {
    mastery: learned ? bestMastery : 0,
    wrongCount,
    /*
     * 「多久没碰」：没练过就是 null。
     *
     * 注意这里**不能**把「从没练过」写成很大的天数（如 999）——
     * 提示词里那会变成「很久没复习，该补」，而实际上它是「没学过」，
     * 两者的建议动作完全不同（一个是复习，一个是开始学）。
     */
    daysSinceReview: lastTouched === null ? null : Math.max(0, daysBetween(lastTouched, ctx.today)),
  };
}

/** 取两个日期串里较晚的那个；null 当作最小 */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * 「学过」的判定，供 `planProgress` 用。
 *
 * 为什么不是 `mastery > 0`：掌握度可以是 0 而实际上练过
 * （`srs.ts` 的注释写过：刚做过一次、对了 1/1，`intervalDays = 1` 时
 *  intervalScore = 0，分数可能贴到 0.03 甚至更低）。
 * 用「有没有复习记录」这个事实判断更稳。
 */
export function makeLearnedPredicate(
  records: readonly { cardId: string; state: { reviewCount: number } }[],
  questionIdsByPoint: ReadonlyMap<string, readonly string[]>,
): (pointId: string) => boolean {
  const reviewed = new Set<string>();
  for (const r of records) {
    if (r.state.reviewCount > 0) reviewed.add(r.cardId);
  }
  return (pointId: string): boolean => {
    if (reviewed.has(pointId)) return true;
    for (const qid of questionIdsByPoint.get(pointId) ?? []) {
      if (reviewed.has(qid)) return true;
    }
    return false;
  };
}

/**
 * 从知识点清单里挑出需要补章节的候选。
 *
 * 与 `chapter-backfill.ts` 的 `toChapterCandidates` 等价，
 * 但这层多一步：**只处理同一份资料有「可参考的已有章节」的**？
 * 不 —— 不筛。没有已有章节的资料也要补（用户库 96% 没章节，
 * 筛掉就等于这个功能没用）。已知章节只是「优先沿用」的线索。
 *
 * 这里只是把 `KnowledgeService.listAll()` 的结果转成候选，
 * 保留独立函数是为了让调用点读起来是「要补章节的候选」而不是
 * 「一堆知识点」。
 */
export function planChapterCandidates(points: readonly KnowledgePoint[]): ChapterCandidate[] {
  const out: ChapterCandidate[] = [];
  for (const p of points) {
    if (p.chapter !== null && p.chapter.trim().length > 0) continue;
    out.push({ id: p.id, statement: p.statement, chapter: null, sourceId: p.sourceId });
  }
  return out;
}
