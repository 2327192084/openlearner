/**
 * 闪卡管理：把两种来源的闪卡汇到一处（2026-11-14 按用户反馈重做）。
 *
 * ## ⚠️ 上一版错在哪
 *
 * 上一版把「错题闪卡」做成了**从复习记录推导**的东西：
 * 复习记录里最近一次答错的题 → 直接在界面上显示成卡片。
 * 后果是题目一被删，那张卡就消失；而且用户根本没有「选择」这一步。
 *
 * 用户反馈原话：
 * > 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 * >  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。」
 *
 * ## 现在的模型（与用户要求一致）
 *
 * 两种来源**都只是建卡时的素材**，一旦建成，卡就是独立内容：
 *
 * | | 知识点闪卡 | 错题闪卡 |
 * |---|---|---|
 * | 用户动作 | 从知识库挑 → 「加入闪卡」 | 从错题挑 → 「做成闪卡」 |
 * | 建卡时 | 把 knowledgePoint.statement 抄进正面 | 把题干抄进正面、答案+解析抄进背面 |
 * | 建成之后 | **独立**，知识点删了不影响 | **独立**，题目删了不影响 |
 * | 能改内容 | 能（正反面都能改） | 能 |
 * | 能删 | 能 | 能 |
 *
 * 也就是说：**这一页看到的每一张卡都是 flashcards 分区里的真记录**，
 * 不再有任何「推导出来的假卡」。所以也不再有 alive / stale 这种
 * 「来源还在不在」的状态 —— 来源与卡片无关了。
 *
 * `sourceKind` 只用于分组显示（「这张当初是从哪来的」）和追溯。
 */

import type { FlashcardView } from '@/core/flashcards.ts';

/** 闪卡的两类来源（展示用分组） */
export type FlashcardGroup = 'point' | 'wrong' | 'manual';

/** 统一后的一张卡 */
export interface UnifiedCard {
  /** 闪卡自身 id（现在就是真记录 id，不再有前缀拼装） */
  id: string;
  /** 稳定 key（React 用） */
  key: string;
  group: FlashcardGroup;
  /** 正面 */
  front: string;
  /** 背面；null = 没有 */
  back: string | null;
  /** 来源追溯标签（「来自：信号与系统 · 第2章」）；null = 没有可显示的 */
  sourceLabel: string | null;
}

/**
 * 把服务层的视图转成统一形状。
 *
 * 注意它**不再读 `v.point` / `v.stale`** —— 那两个字段在
 * 2026-11-14 的模型里已经不存在了（闪卡独立，无来源依赖）。
 */
export function toUnifiedCards(views: readonly FlashcardView[]): UnifiedCard[] {
  return views.map((v) => {
    /*
     * 分组：按 sourceKind。旧卡没有这个字段时，服务层会用
     * knowledgePointId 推断成 'point' 或 'manual'（见 sourceKindOf）。
     */
    const kind = v.card.sourceKind ?? (v.card.knowledgePointId ? 'point' : 'manual');
    const group: FlashcardGroup =
      kind === 'point' ? 'point' : kind === 'wrong' ? 'wrong' : 'manual';

    return {
      id: v.card.id,
      key: v.card.id,
      group,
      front: v.front,
      back: v.back,
      sourceLabel: v.sourceLabel,
    };
  });
}

export interface CardFilter {
  group: FlashcardGroup | 'all';
  /** 搜索词（正面/背面都搜），空 = 不过滤 */
  query: string;
}

export const DEFAULT_FILTER: CardFilter = { group: 'all', query: '' };

/**
 * 按当前筛选条件过滤。
 *
 * 搜索**同时搜正反面**：用户多半只记得那句话，不记得在哪一面。
 */
export function filterCards(cards: readonly UnifiedCard[], f: CardFilter): UnifiedCard[] {
  const q = f.query.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.group !== 'all' && c.group !== f.group) return false;
    if (!q) return true;
    const hay = `${c.front}\n${c.back ?? ''}`.toLowerCase();
    return hay.indexOf(q) !== -1;
  });
}

/** 计数（界面上的数字都来自同一份数据，不各算一遍） */
export function countByGroup(cards: readonly UnifiedCard[]): {
  point: number;
  wrong: number;
  manual: number;
  total: number;
} {
  let point = 0;
  let wrong = 0;
  let manual = 0;
  for (const c of cards) {
    if (c.group === 'point') point++;
    else if (c.group === 'wrong') wrong++;
    else manual++;
  }
  return { point, wrong, manual, total: cards.length };
}
