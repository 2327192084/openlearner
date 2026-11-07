/**
 * 首页「最近在练的题组（未完成）」的推导。
 *
 * ## 为什么单独一个文件
 *
 * 这是纯函数（只吃数组、只吐结构），没有任何 React 依赖 ——
 * 单独放一处才能直接单测。塞在 `TodayPage.tsx` 里的话，
 * 测试要 import 整个页面组件（连带 CSS 和 service 类型），
 * 既慢又容易被无关改动带崩。
 *
 * ## 「未完成」是怎么判定的（重要：这是推导，不是记录）
 *
 * 做题进度**没有落库** —— `ReviewPage` 的 index 只是 React state，
 * 一退出就没了（查过 `STORES`，没有 practice/session 这类分区）。
 * 所以「未完成」只能从复习日志反推：
 *
 *   这个题组里**练过（有过复习日志）的题数 < 这个题组在库里的题数**
 *
 * 它不是「上次做到第几题」，而是「这组里还有几道从没碰过」。
 * 界面上写「练过 N/M」，不写「进度 N%」—— 措辞上不冒充真实进度。
 *
 * 为什么不为此新增一张表：那要改迁移三件套（DB_VERSION + schema + 迁移规则），
 * 而收益只是「精确到第几题」。用户 2026-11-07 要的是「哪组没做完」，
 * 用现有数据就能答，不值得为它动数据库版本。
 */

import type { Card } from '@/v2/core/cards.ts';
import type { Deck } from '@/core/model.ts';
import type { ReviewLog } from '@/v2/core/review-service.ts';

/** 最近在练的题组（未完成） */
export interface RecentDeck {
  deckId: string;
  title: string;
  /** 练过几道 */
  done: number;
  /** 这个题组里已发布在库里的总题数 */
  total: number;
  /** 还有几道答错 */
  wrong: number;
  /** 练过比例 0–1 */
  ratio: number;
  /** 最近一次练这个题组的日期 */
  lastDay: string;
}

/**
 * 排序：最近练过的排前面（回答「我上次在干嘛」）。
 *
 * 全部练完的组**不显示** —— 这一块叫「最近在练的」，
 * 把已完成的组列出来只会挤掉真正需要继续的那些。
 *
 * @param wrongByDeck 每个题组的错题数（由调用方从错题明细统计）
 */
export function recentDecksOf(
  logs: readonly ReviewLog[],
  cardById: ReadonlyMap<string, Card>,
  deckList: readonly Deck[],
  wrongByDeck: ReadonlyMap<string, number> = new Map(),
): RecentDeck[] {
  /** 每个题组最近一次练习的日期 */
  const lastDay = new Map<string, string>();
  /** 每个题组里练过的题（去重） */
  const touched = new Map<string, Set<string>>();

  for (const log of logs) {
    if (log.kind !== 'question') continue;
    const card = cardById.get(log.cardId);
    if (!card) continue; // 题已被删：不计入
    const set = touched.get(card.deckId) ?? new Set<string>();
    set.add(card.id);
    touched.set(card.deckId, set);

    const prev = lastDay.get(card.deckId);
    // 日志按写入顺序追加，日期串 YYYY-MM-DD 字典序即时间序
    if (!prev || log.day > prev) lastDay.set(card.deckId, log.day);
  }

  /*
   * 每个题组的题总数。
   *
   * 用 cardById 统计而不是 deck.questionCount：后者是出题时写的缓存，
   * 题被删过就会偏大，而这里要的是「库里真实还有几道」。
   */
  const total = new Map<string, number>();
  for (const card of cardById.values()) {
    total.set(card.deckId, (total.get(card.deckId) ?? 0) + 1);
  }

  const out: RecentDeck[] = [];
  for (const deck of deckList) {
    const t = total.get(deck.id) ?? 0;
    if (t === 0) continue; // 题组里一道题都没有（或被删光）：不显示
    const done = touched.get(deck.id)?.size ?? 0;
    if (done === 0) continue; // 从没练过：不属于「最近在练的」
    if (done >= t) continue; // 全都碰过了：已完成，不占位置

    out.push({
      deckId: deck.id,
      title: deck.title,
      done,
      total: t,
      wrong: wrongByDeck.get(deck.id) ?? 0,
      ratio: done / t,
      lastDay: lastDay.get(deck.id) ?? '',
    });
  }

  // 最近练过的排前面
  out.sort((a, b) => (a.lastDay < b.lastDay ? 1 : -1));
  return out.slice(0, 4);
}
