/**
 * 页面覆盖层（page layers）—— 「跳走再回来，原来的活儿还在」（2026-11-13 下午）。
 *
 * ## 解决什么（用户报的原话）
 *
 * 「跳页后回不到原任务」。
 *
 * 具体场景：正在做题 / 正在模拟考 / 正在整理知识点（出题跑到一半），
 * 想看一眼原文 —— 点进去阅读器，看完想回来接着做，
 * 发现**整轮进度没了**：题号回到第 1 题，已选的选项、写了一半的作答、
 * 考试倒计时、出题的进度条，全部消失。
 * 因为 `App.tsx` 是一条 33 个 `page === '...'` 的三元链：切页 = 卸载 = state 全丢。
 *
 * ## 为什么不给每个页面写序列化
 *
 * `nav-history.ts` 的头注释已经论证过这条路：几十个页面各写一套状态快照，
 * 成本远超收益；且任何一页忘了实现，恢复出来就是半截界面（比没有更糟）。
 * 库里也确实没地方存「做到第几题、选了哪个」。
 *
 * 所以走另一条：**让页面别卸载**。当前页照常渲染，
 * 之前那几页留在 DOM 里、只是藏起来（`display: none`）。
 * 这是 React 里唯一不需要任何序列化的「保活」办法。
 *
 * ## 两个概念必须分开：`retained`（留下了谁）与 `current`（现在给谁看）
 *
 * 这是本模块最容易写错的地方，也是第一版设计错的地方：
 *
 * - `retained` 是**留下不卸载**的那几页（白名单里、有进行中状态的）。
 * - `current` 是**现在这一页**，它自己不一定在白名单里
 *   （比如「做题 → 看原文」，current 是 reader，它不保活）。
 *
 * 如果只有一个数组、并且把 current 也塞进去，那么进 reader 时
 * 要么 reader 被塞进保活栈（它很重，不该保活），
 * 要么 reader 根本不渲染（黑屏）。两种情况都是错的。
 * 正确做法：**渲染 = retained ∪ {current}，且 current 永远在最后**。
 *
 * ## 为什么只保活少数几页（白名单）
 *
 * 保活不是免费的，隐藏的页面仍然挂着，副作用仍然跑：
 *
 * - `ExamPage` 有自己的倒计时 `setInterval`（`ExamPage.tsx:439`）。
 *   隐藏期间照跑是**对的**（考试时间真的在走），
 *   但页面若卸载重建，倒计时会从 `limitSec` 重新开始 —— 那才是错的。
 * - `useCardTimer`（读题计时）只在 `document.hidden` 时暂停，
 *   而 `display: none` 的隐藏层 `document.hidden === false`。
 *   也就是说「切到别的页」不会被当成「离开」，读题计时会继续走 ——
 *   必须由页面显式暂停（用 `useLayerActive()`，见 `page-layer-context.ts`）。
 * - `ReviewToday` / `FlashcardsPanel` / `BookSelfTest` 都在 `window` 上抢
 *   `1-4` / 方向键 / 空格。两层同时挂载会**双响应**：
 *   按一次「4」可能给隐藏的那一页也判了档。
 *
 * ## 白名单怎么定
 *
 * 一条标准：**这一页是不是「一轮进行中的过程」**。
 * 刻意不含 today / sources / stats / settings / trash：
 * 它们没有进行中的状态，重建只要几毫秒，保活反而会显示**过期数据**
 * （在别处删了资料，回到还活着的首页看到它还在）。
 *
 * 也刻意不含 `reader`：它读的是磁盘上的正文，位置另有 `Source.readProgress`
 * 落库恢复（见 `read-progress.ts`），本来就不需要靠内存保活。
 *
 * ## 上限
 *
 * 3 层。为什么不是 20（与 nav-history 一致）：保活的是**重型页面**，
 * 每层都有自己的队列、卡片、计时器。3 层足够覆盖实际路径
 * （「做题 → 看原文 → 再点一个知识点」已是用户能走出最长的一条），
 * 超出的从**最久没访问**的开始丢（丢 = 卸载 = 回到项目原来的行为）。
 */

import type { PageId } from './pages.ts';

/** 会被保活的页面。加一项之前先回答：这一页有没有「跳走再回来就没了」的东西？ */
export const KEEP_ALIVE_PAGES: readonly PageId[] = [
  'practice',
  'review',
  'exam',
  'book',
  'organize',
  'parse',
];

/** 同时保留几层（不含临时的非白名单当前页）。理由见头注释「上限」 */
export const MAX_RETAINED = 3;

export function isKeepAlive(id: PageId): boolean {
  return KEEP_ALIVE_PAGES.indexOf(id) !== -1;
}

export interface LayerState {
  /**
   * 留下不卸载的页面，**从旧到新**。
   *
   * 顺序有意义：最久没访问的在前面，超上限时先丢它。
   * 用数组而不是 Set，因为 React 渲染要按稳定顺序输出。
   */
  retained: readonly PageId[];
}

/**
 * 访问了 `next` 之后，应该保留哪些页。
 *
 * 语义（全部用单测钉住）：
 * 1. 白名单外的页不进来，但**也不会挤掉**别人 ——
 *    去首页看一眼不该把做题的进度扔掉。
 * 2. 已经在里面的页挪到末尾（= 最近访问），不重复。
 * 3. 超上限从最久没访问的（数组头）丢。
 */
export function retainLayer(state: LayerState, next: PageId): LayerState {
  if (!isKeepAlive(next)) return state;

  const without = state.retained.filter((id) => id !== next);
  const retained = [...without, next];

  while (retained.length > MAX_RETAINED) retained.shift();

  return { retained };
}

/**
 * 这一刻要渲染哪些层，从旧到新；**最后一项是可见的那一层**。
 *
 * `current` 永远在最后：它可能不在 `retained` 里（reader 就是这样）。
 * 如果 `current` 本身是保活页，它已经在 retained 末尾，不会重复。
 */
export function layersToRender(state: LayerState, current: PageId): readonly PageId[] {
  return [...state.retained.filter((id) => id !== current), current];
}

/**
 * 某一层现在是不是可见、可交互的那一层。
 *
 * `inert`、键盘监听、计时器暂停都以它为准 —— 这是
 * 「隐藏层不许响应输入」的唯一判据，所以单独一个函数，
 * 免得各处自己写 `id === current` 而有一处写错。
 */
export function isLayerActive(current: PageId, id: PageId): boolean {
  return current === id;
}

/**
 * 丢掉某一层（这一轮结束了，不该再留着它的结果页）。
 *
 * 典型场景：做完一轮点「完成」、或用户重新点「开始复习」要开新一轮 ——
 * 留着旧的那层，再进去会看到上一轮的结果页。
 */
export function dropLayer(state: LayerState, id: PageId): LayerState {
  if (state.retained.indexOf(id) === -1) return state;
  return { retained: state.retained.filter((x) => x !== id) };
}

/** 「返回进行中的任务」该回到哪一页：取 retained 里**最近访问**的那个保活页 */
export function resumeTarget(state: LayerState, current: PageId): PageId | null {
  for (let i = state.retained.length - 1; i >= 0; i--) {
    const id = state.retained[i];
    if (id !== undefined && id !== current) return id;
  }
  return null;
}

export const EMPTY_LAYERS: LayerState = { retained: [] };
