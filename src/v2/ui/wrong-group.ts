/**
 * 错题页的分组 key（2026-11-13 深夜抽出来）。
 *
 * ## 为什么抽成纯函数
 *
 * 原先是内联在 `WrongBookPage` 的 `useMemo` 里算的。现在首页「错题」那一块
 * 要能点了直接定位到某一题，而定位必须知道「这一题在哪个分组里」——
 * 分组收起着的话，题目根本不在 DOM 里，scrollIntoView 找不到任何东西。
 *
 * 于是同一套 key 规则会被用在两处：渲染分组、以及「定位时该展开哪一组」。
 * 两处各写一遍必然漂移（这个项目的常见病），所以抽到这里一份，
 * 两边都用，并有单测钉住 —— 尤其那条**带资料 id** 的规则。
 *
 * ## 踩过的坑（保留原注释的结论）
 *
 * key 只用章节名时，两本书的「第 9 页」会被合并成一组，
 * 标题写着「第 9 页 · 信号与系统」，里面却混着另一本书的题。
 * 章节名只在**同一份资料内**唯一，所以 chapter 维度必须带 sourceId。
 */

import type { Card } from '@/v2/core/cards.ts';

export type GroupBy = 'deck' | 'chapter' | 'kind';

const SORTS = ['wrongCount', 'wrongRate', 'lastWrong'] as const;
export type SortKey = (typeof SORTS)[number];

/** 分组所需的最小字段（避免把整个 WrongRow 拖进这个模块） */
export interface GroupKeyInput {
  card: Pick<Card, 'deckId' | 'sourceId'>;
  /** 归属章节（已经算好的显示名） */
  chapter: string;
  /** 题型显示名 —— kind 维度用它当 key */
  kindLabel: string;
}

/**
 * 一道错题属于哪个分组。
 *
 * 与渲染时的口径**必须一致**，否则「定位时展开的那一组」不是
 * 用户要看的那个，展开之后屏幕上仍然没有那一题。
 */
export function wrongGroupKey(row: GroupKeyInput, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'deck':
      return row.card.deckId;
    case 'chapter':
      /* 带 sourceId：见头注释「踩过的坑」 */
      return `${row.card.sourceId}::${row.chapter}`;
    case 'kind':
      return row.kindLabel;
  }
}
