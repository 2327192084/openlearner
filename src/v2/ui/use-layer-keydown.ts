/**
 * 「只在当前可见层才响应键盘」（2026-11-13 下午）。
 *
 * ## 为什么需要它
 *
 * 页面保活之后，被压在下面的页面**仍然挂着**，它的 `window.addEventListener`
 * 也还在。这带来一个实际故障：做题页的「今日复习」(`ReviewToday`)、
 * 闪卡面板 (`FlashcardsPanel`)、自测 (`BookSelfTest`) 都在 `window` 上抢
 * `1-4` / `方向键` / `空格`。两层同时挂载时按一次「4」，
 * **两个页面会同时判档** —— 一个是你能看见的，另一个藏在下面，
 * 它也会写一条复习记录（改间隔）。用户看不见，但数据被改了。
 *
 * ## 为什么不靠 inert
 *
 * `inert` 能挡住「焦点进入隐藏层」和「点击」，但**挡不住挂在 window 上的
 * keydown** —— 那条事件不经过隐藏层的元素。所以必须在监听器自己这里判断。
 *
 * ## 用法
 *
 * ```tsx
 * useLayerKeydown((e) => { ... }, [deps]);   // 自动只在活动层生效
 * ```
 *
 * 语义与 `window.addEventListener('keydown', fn)` 完全一致（同样的 `KeyboardEvent`、
 * 同样要自己 `preventDefault`），只是多了一层「当前层才跑」的判断 ——
 * 所以已有的 handler 可以整段搬进来，不用改逻辑。
 *
 * 不在覆盖层里渲染的页面（单测等）默认 `active === true`，行为与改造前一致。
 */

import { useEffect, type DependencyList } from 'react';
import { useLayerActive } from './page-layer-context.ts';

export function useLayerKeydown(
  handler: (e: KeyboardEvent) => void,
  deps: DependencyList,
): void {
  const active = useLayerActive();

  useEffect(() => {
    /*
     * 不是活动层就**不注册**监听，而不是「注册了但在里面 return」。
     *
     * 两种写法行为等价，但不注册更干脆：隐藏层的监听器根本不存在，
     * 也就没有「哪天有人漏写了一个 return 就双响应」的机会。
     */
    if (!active) return;
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handler 的稳定性由调用方用 deps 保证，与原来的用法一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
}
