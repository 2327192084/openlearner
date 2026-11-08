/**
 * 选项点击的选择规则。
 *
 * ## 为什么单独抽出来
 *
 * 这段逻辑原本内联在 `ReviewPage.tsx` 的 onClick 里，是纯的
 * 「给定当前选择 + 点了哪个 → 新选择」，但没法单独测
 * （项目没有 DOM 测试环境，只有 node 下的纯函数测试）。
 *
 * 而它出过一个**实际 bug**（2026-11-08 截图才发现的）：
 * 判断题掉进多选分支，可以同时选中「对」和「错」，
 * 选完两个之后 `canSubmit` 要求 `picked.length === 1` 为假，
 * 于是「提交答案」变成禁用 —— 用户卡死在那一题，没有任何提示。
 *
 * 所以把它提出来，让这条规则有测试盯着。
 */

import type { CardKind } from '@/v2/core/cards.ts';

/** 只有这两种题型是「点一个替换掉上一个」 */
export function isSingleChoice(kind: CardKind): boolean {
  return kind === 'single' || kind === 'truefalse';
}

/**
 * 点击一个选项后的新选择。
 *
 * - 单选 / 判断：替换成这一个（点已选中的那个仍然是它，不会取消 ——
 *   因为「取消选择」在单选里没有意义，而且会让提交按钮突然变灰）
 * - 多选：切换这一个（再点一次取消）
 * - 其它题型（填空/简答/知识点）：不经过这条路，原样返回
 */
export function pickOption(
  kind: CardKind,
  picked: readonly string[],
  key: string,
): string[] {
  if (isSingleChoice(kind)) return [key];
  if (kind === 'multiple') {
    return picked.includes(key) ? picked.filter((x) => x !== key) : [...picked, key];
  }
  return [...picked];
}
