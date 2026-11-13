/**
 * 闪卡管理：把两种闪卡汇到一处（2026-11-13 深夜，用户要求）。
 *
 * ## 用户原话
 *
 * > 「错题闪卡改名为闪卡管理。然后在课程准备与管理的栏目下
 * >  新开一个闪卡管理栏目」
 *
 * 并且明确回答「两种都要」：知识点闪卡 + 错题闪卡。
 *
 * ## 两种闪卡根本不是同一种东西（这是本模块存在的理由）
 *
 * | | 知识点闪卡 | 错题闪卡 |
 * |---|---|---|
 * | 数据来自 | `flashcards` 分区（用户/AI 挑出来的） | **推导**：复习记录里最近一次 `again` 的题 |
 * | 存不存 | 存（有 id、创建时间、笔记） | **不存**——它只是「哪些题现在还是错的」这个查询的结果 |
 * | 能删吗 | 能（删的是那条记录） | 不能「删卡」，只能重做答对让它自然消失 |
 * | 会过期吗 | 会（知识点被改/删 → stale） | 不会（题目本身不会变） |
 *
 * 最后一行最要紧：**错题闪卡没有「删除」这个概念**。
 * 如果界面给它一个删除按钮，用户会以为删了就学会了 ——
 * 而实际数据还在，下次刷新又出现（假按钮）。
 * 所以 `wrong` 那组只给「去做这题」，不给删除。
 *
 * ## 为什么错题闪卡不新开分区
 *
 * `reviewService.wrongCardsDetailed()` 已经能算出「最近一次答错」的题。
 * 为它新增一张表要动迁移四件套（DB_VERSION + schema + 迁移规则 + 备份分区），
 * 而收益只是「记住用户给这道错题写的笔记」。项目对这件事有明确先例：
 * `recent-decks.ts` 头注释里写着同样的取舍（用现有数据推导，不动数据库版本）。
 *
 * 所以错题闪卡的「正面/背面」完全由题目本身提供：
 * 正面 = 题干，背面 = 答案 + 解析。用户这次也确认了「先不做『坑』这一行」。
 */

import type { FlashcardView } from '@/core/flashcards.ts';
import type { Card } from '@/v2/core/cards.ts';

/** 闪卡的两类来源 */
export type FlashcardGroup = 'point' | 'wrong';

/** 统一后的一张卡（两种来源在这里长得一样，界面才好渲染） */
export interface UnifiedCard {
  /** 稳定 key：知识点卡用 `point:<id>`，错题卡用 `wrong:<cardId>` */
  key: string;
  group: FlashcardGroup;
  /** 正面 */
  front: string;
  /** 背面（答案/解析）；null = 没有 */
  back: string | null;
  /**
   * 这张卡背后引用的对象还在不在。
   *
   * 知识点卡：知识点被删 → false（背面那行引文也就取不到了）
   * 错题卡：题目被删 → false
   */
  alive: boolean;
  /**
   * 内容是否已与来源不一致（知识点被改过）。
   *
   * 只对知识点卡有意义；错题卡恒为 false（题目不会自己改）。
   * 不一致要标出来：用户背的是旧表述，而知识点已经改了 ——
   * 不说的话他会拿着过时的说法去考试。
   */
  stale: boolean;
  /** 是否还能「删除」（只有知识点卡能删，理由见头注释） */
  deletable: boolean;
  /** 错题卡：还能点回原文/题目详情用得上 */
  cardId?: string;
}

/**
 * 把知识点闪卡转成统一形状。
 *
 * @param views `FlashcardService.listWithPoints()` 的结果
 */
export function fromPointFlashcards(views: readonly FlashcardView[]): UnifiedCard[] {
  const out: UnifiedCard[] = [];
  for (const v of views) {
    const id = v.card.id;
    const front = (v.card.frontText ?? v.point?.statement ?? '').trim();
    /*
     * 正面为空的卡仍然列出来，但**不编内容** —— 界面会显示
     * 「这张卡没有正面」。悄悄跳过会让用户以为卡丢了
     * （他明明加过），而那更难受。
     */
    out.push({
      key: `point:${id}`,
      group: 'point',
      front,
      back: v.card.backNote?.trim() || null,
      alive: v.point !== null,
      stale: v.stale,
      deletable: true,
    });
  }
  return out;
}

/**
 * 把「最近一次答错的题」转成统一形状。
 *
 * @param rows `ReviewService.wrongCardsDetailed()` 的结果
 * @param cardOf cardId → Card（题目被删就取不到，那张卡 alive=false）
 */
export function fromWrongCards(
  rows: readonly { cardId: string; wrongCount: number; lastWrongDay: string }[],
  cardOf: (cardId: string) => Card | undefined,
): UnifiedCard[] {
  const out: UnifiedCard[] = [];
  for (const r of rows) {
    const card = cardOf(r.cardId);
    if (!card) {
      /*
       * 题目已被删：仍然列出来并标 alive=false。
       * 为什么不像错题页那样直接过滤掉：这一页是「管理」，
       * 用户需要知道「有一条错题记录指向已删除的题」——
       * 那正是交接文档里说的「孤儿数据」，看不见就没法清理。
       */
      out.push({
        key: `wrong:${r.cardId}`,
        group: 'wrong',
        front: '（这道题已不在题库里）',
        back: null,
        alive: false,
        stale: false,
        deletable: false,
        cardId: r.cardId,
      });
      continue;
    }

    out.push({
      key: `wrong:${r.cardId}`,
      group: 'wrong',
      front: card.prompt.trim(),
      /*
       * 背面 = 答案 + 解析。
       * 用户确认「先不做『坑』这一行」，所以这里不加易错点提炼。
       */
      back: buildWrongBack(card),
      alive: true,
      stale: false,
      /*
       * 错题卡**不能删**：它没有独立的存储，删了下次刷新又出现。
       * 想让它消失只有一个办法 —— 重做答对。
       */
      deletable: false,
      cardId: r.cardId,
    });
  }
  return out;
}

/** 错题卡的背面：答案 + 解析（有哪个用哪个，不编） */
function buildWrongBack(card: Card): string | null {
  const answer = (card.answer ?? '').trim();
  const why = (card.explanation ?? '').trim();

  if (answer && why) return `答案：${answer}\n\n${why}`;
  if (answer) return `答案：${answer}`;
  if (why) return why;
  return null;
}

export interface CardFilter {
  group: FlashcardGroup | 'all';
  /** 搜索词（正面/背面都搜），空 = 不过滤 */
  query: string;
  /** 只看「来源已失效」的 */
  onlyBroken: boolean;
}

export const DEFAULT_FILTER: CardFilter = { group: 'all', query: '', onlyBroken: false };

/**
 * 按当前筛选条件过滤。
 *
 * 搜索**同时搜正反面**：用户多半只记得「那句话」而不记得在哪一面，
 * 只搜正面会让他找不到。
 */
export function filterCards(cards: readonly UnifiedCard[], f: CardFilter): UnifiedCard[] {
  const q = f.query.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.group !== 'all' && c.group !== f.group) return false;
    if (f.onlyBroken && c.alive) return false;
    if (!q) return true;
    const hay = `${c.front}\n${c.back ?? ''}`.toLowerCase();
    return hay.indexOf(q) !== -1;
  });
}

/** 计数（界面上四个数字要来自同一份数据，不各算一遍） */
export function countByGroup(cards: readonly UnifiedCard[]): {
  point: number;
  wrong: number;
  broken: number;
  total: number;
} {
  let point = 0;
  let wrong = 0;
  let broken = 0;
  for (const c of cards) {
    if (c.group === 'point') point++;
    else wrong++;
    if (!c.alive) broken++;
  }
  return { point, wrong, broken, total: cards.length };
}
