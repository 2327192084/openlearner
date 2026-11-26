/**
 * 错题页的分组 key（2026-11-13 深夜抽出，2026-11-26 改为按资料分组）。
 *
 * ## 2026-11-26：一级分组只剩「资料」
 *
 * 用户原话：「一级分组默认按资料分组，去掉来源/知识点分组，
 * 「按题型展开」改成二级筛选，以横排小标签形式展示在分组栏下方」。
 *
 * 所以这里不再有 deck / chapter / kind 三个维度，只按**资料**分。
 * 题型不再是分组 —— 它是同一个列表上的筛选条件（见 WrongBookPage 的 chips），
 * 因为「按题型分组」会把同一份资料拆成好几块，用户反而看不出
 * 自己哪本书还没掌握。
 *
 * ## 为什么抽成纯函数
 *
 * 首页「错题」那一块要能点了直接定位到某一题，而定位必须知道
 * 「这一题在哪个分组里」—— 分组收起着的话，题目根本不在 DOM 里，
 * scrollIntoView 找不到任何东西。
 *
 * 于是同一套 key 规则被用在两处：渲染分组、以及「定位时该展开哪一组」。
 * 两处各写一遍必然漂移（这个项目的常见病），所以抽到这里一份，两边都用。
 */

/** 组内排序（2026-11-09） */
export type SortKey = 'wrongCount' | 'wrongRate' | 'lastWrong';

/** 没有归属资料的题落在这一组（显示名；key 是空串） */
export const NO_SOURCE = '未归属资料';

/**
 * 一道错题属于哪个资料分组。
 *
 * key 用资料 id，空串表示「没有归属资料」。
 *
 * 标题不在这里算：显示名是 `WrongRow.sourceTitle` 的三层回退结果
 * （card.sourceId → 知识点.sourceId → 锚点.sourceId），
 * 由页面统一取，避免两处口径不一致。
 */
export function wrongSourceKey(sourceId: string | null | undefined): string {
  return sourceId ?? '';
}
