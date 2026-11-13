/**
 * 「我现在是不是被压在下层」的上下文（2026-11-13 下午）。
 *
 * ## 为什么需要它
 *
 * 页面被保活之后，**它仍然活着** —— 这一点容易被忽略：
 * 用户切去别的页面，被压在下面的做题页并没有卸载，
 * 它的 `setInterval`、`window` 键盘监听、计时器全都还在跑。
 *
 * 于是出现两个真实问题：
 *
 * 1. **做题读题计时会继续走。** `use-card-timer` 只在 `document.hidden`
 *    时暂停，而 `display: none` 的隐藏层 `document.hidden === false` ——
 *    「切到别的页」不会被当成「离开」。用户去看一眼原文再回来，
 *    这道题就被判成「想了好久」，直接拖垮复习间隔。
 * 2. **键盘会双响应。** `ReviewToday` / `FlashcardsPanel` / `BookSelfTest`
 *    都在 `window` 上抢 `1-4` / 方向键 / 空格。两层同时挂载时，
 *    按一次「4」可能给隐藏的那一页也判了档。
 *
 * ## 用法
 *
 * 在 `App.tsx` 渲染每一层时包一个 `<PageLayerContext value={active}>`，
 * 页面里用 `useLayerActive()` 读：
 *
 * ```tsx
 * const active = useLayerActive();
 * // 计时暂停
 * useCardTimer(card?.id, !active);
 * // 键盘只在活动层生效
 * useEffect(() => { if (!active) return; ... }, [active]);
 * ```
 *
 * ## 为什么不传 prop
 *
 * 这些页面各自有 60~100 个 prop 的类型，再加一个 `active` 要改
 * 每一层的调用点与全部 prop 接口；而 `active` 是**渲染环境**的属性，
 * 不是页面自己的业务数据。用 context 更贴合它的语义，
 * 也不会污染那些已经很长的 prop 列表。
 *
 * 默认值 `true`：不在这棵树里渲染的页面（单测、Storybook 式单独使用）
 * 一律当作活动层 —— 与「没有保活机制」的旧行为一致，不会让旧用例失效。
 */

import { createContext, useContext } from 'react';

const PageLayerActiveContext = createContext<boolean>(true);

export const PageLayerContext = PageLayerActiveContext;

/** 当前这一层是不是可见、可交互的那一层 */
export function useLayerActive(): boolean {
  return useContext(PageLayerActiveContext);
}
