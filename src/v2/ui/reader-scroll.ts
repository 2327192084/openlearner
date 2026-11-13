/**
 * 阅读器的「每一段滚到哪儿了」记忆（2026-11-13）。
 *
 * ## 解决什么
 *
 * 长资料一段要滚好几屏。读到第 5 段一半去看了第 6 段，再退回第 5 段 ——
 * 原来的行为是一律 `scrollTo({ top: 0 })`，等于**每次回头都得重新往下滚**。
 * 用户的实际读法不是「一段一段按顺序看」，而是「来回对照」。
 *
 * ## 为什么按段（page index）记，而不是只记一个全局位置
 *
 * 全局一个位置的话，从第 5 段滚到 800px、翻到第 6 段再返回，
 * 会拿 800px 去套第 6 段 —— 而那一段可能只有 300px 高，
 * 于是被夹到 300，看起来「跳到一个随机位置」。
 * 按段记，每段各自回到它自己的位置。
 *
 * ## 为什么需要夹取
 *
 * 内容会变（重新解析、折叠展开、字号调整），记忆里的偏移可能超过
 * 当前实际高度。超出时必须夹到可滚动上限，否则浏览器会直接跳到底部。
 *
 * ## 为什么单独一个模块
 *
 * 「记多少段 / 怎么夹 / 什么时候算无效」这三件在界面里很难测 ——
 * 抽出来就能用纯函数钉住。`ReaderPage.tsx` 也已有 1900+ 行。
 */

/**
 * 最多记多少段的滚动位置。
 *
 * 为什么要上限：一本 600 页的书真全记下来就是 600 个数字，
 * 虽然不大，但没有任何价值 —— 用户不会回到第 3 段去看它当时滚到哪。
 * 只保留最近读过的这些段，是「够用且不会无限增长」的折中。
 */
export const MAX_REMEMBERED = 40;

/** 一段的滚动位置记忆：段索引 → 距顶部的像素 */
export type ScrollMemory = ReadonlyMap<number, number>;

export const EMPTY_SCROLL_MEMORY: ScrollMemory = new Map();

/**
 * 记一段的位置，并淘汰最旧的。
 *
 * ## 为什么淘汰用「插入顺序」而不是「值的大小」
 *
 * `Map` 保证插入顺序。删除最早插入的那个 = 最久没被记过的段，
 * 正好就是「用户最不可能回去的那一段」。
 *
 * 重新记已经存在的段时先删再插，让它回到「最新」的位置 ——
 * 否则一个反复访问的老段会被当成最旧的优先淘汰。
 */
export function rememberScroll(
  memory: ScrollMemory,
  pageIndex: number,
  top: number,
): Map<number, number> {
  const next = new Map(memory);
  /* 先删再插：保持「最近用过」的语义（见函数注释） */
  next.delete(pageIndex);
  next.set(pageIndex, Math.max(0, Math.round(top)));
  while (next.size > MAX_REMEMBERED) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

/**
 * 取某段该滚到的位置，并夹到当前可滚动范围内。
 *
 * @param maxTop 当前容器的可滚动上限（`scrollHeight - clientHeight`）。
 *   传 0 或负数时一律返回 0 —— 容器还没渲染出内容时不该乱跳。
 */
export function scrollFor(memory: ScrollMemory, pageIndex: number, maxTop: number): number {
  const remembered = memory.get(pageIndex) ?? 0;
  if (!Number.isFinite(maxTop) || maxTop <= 0) return 0;
  return Math.min(Math.max(0, remembered), maxTop);
}

/**
 * 这个偏移值不值得记。
 *
 * 小于 24px 时不记：那基本就是「在顶部」，记下来除了让 Map 变大没别的作用，
 * 而且会让「淘汰最旧」把真正有用的段挤掉。
 */
export const MIN_MEANINGFUL_TOP = 24;

export function worthRemembering(top: number): boolean {
  return Number.isFinite(top) && top >= MIN_MEANINGFUL_TOP;
}
