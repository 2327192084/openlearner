/**
 * 页面覆盖层（page layers）—— 「跳走再回来，原来的活儿还在」（2026-11-13 下午起）。
 *
 * ## 解决什么（用户报的原话）
 *
 * 「跳页后回不到原任务」。
 *
 * 正在做题 / 正在模拟考 / 正在整理知识点（出题跑到一半），想看一眼原文 ——
 * 点进去阅读器，看完想回来接着做，发现**整轮进度没了**：题号回到第 1 题、
 * 倒计时重新开始、出题进度条消失。因为 `App.tsx` 原来是一条 33 个
 * `page === '...'` 的三元链：切页 = 卸载 = 组件内 state 全丢。
 *
 * 所以改成：**把有活儿在进行的页面留在 DOM 里**，只把非当前页藏起来。
 * 这是 React 里唯一不需要给每个页面写序列化/反序列化的保活办法
 * （`nav-history.ts` 头注释论证过为什么不做状态快照）。
 *
 * ## ⚠️ 「保活哪些页」绝不能靠白名单（2026-11-13 傍晚修正）
 *
 * 第一版用的是**固定白名单**（practice/review/exam/book/organize/parse），
 * 侧栏「继续：xxx」的判据是「这一页在保活列表里」。用户随即报了问题：
 *
 * > 「做这个跳页功能是为了知道某些任务的进度，例如文档解析，出题功能。
 * >  但没有正在进行文档解析的任务时，这个提示也一直存在。」
 *
 * 他说得对，而且这是设计错误不是实现 bug：
 * **「页面留在内存里」不等于「有任务在进行」。**
 * 只要打开过一次文档解析页，它就永久占一层，提示永远在 —— 一个假提示，
 * 比没有提示更糟（用户会以为有活儿没干完）。
 *
 * 而且白名单还错在另一半：`review`（做题选题页）根本没有进行中的状态，
 * 却被保活，同样会挂着一个假的「继续」。
 *
 * ## 现在的判据：**由页面自己上报「我在干什么」**
 *
 * 见 `page-task-context.ts`。于是本模块不再需要白名单，
 * 保活集合**直接由「谁上报了任务」推导**：
 *
 * ```
 * 渲染  =  上报了任务的页  ∪  {当前页}      当前页永远最后渲染、且可见
 * ```
 *
 * 三个好处：
 * 1. 打开过但什么都没做的页面**不会**上报 → 不会保活 → 不会有假提示。
 * 2. 任务做完了（页面把上报改成 null）→ 它**自动**从保活里消失、连同提示。
 * 3. 不需要维护「白名单 + 保活栈」两份状态互相同步 —— 那正是会不同步的东西。
 *
 * ## 为什么当前页要单独补进来
 *
 * 当前页不一定有任务：首页、资料页、设置页都不上报任务，
 * 但它们当然要显示。所以 `渲染 = 有任务的 ∪ {当前页}`，
 * 当前页永远在最后（= 可见、可交互的那一层）。
 *
 * ## 保活不是免费的：页面仍然活着
 *
 * 留在 DOM 里意味着副作用继续跑，这三条都必须处理（已在代码里）：
 *
 * - `ExamPage` 的倒计时 `setInterval`（`ExamPage.tsx:439`）——
 *   隐藏期间照跑是**对的**（考试时间真的在走）；保活正好让它不会重置。
 * - `useCardTimer`（读题计时）只在 `document.hidden` 时暂停，
 *   而 `display: none` 的隐藏层 `document.hidden === false` ——
 *   「切到别的页」不会被当成「离开」。必须显式暂停：
 *   见 `use-card-timer` 的 `suspended` 参数与 `useLayerActive()`。
 * - `ReviewToday` / `FlashcardsPanel` / `BookSelfTest` 都在 `window` 上抢
 *   `1-4` / 方向键 / 空格，两层同挂会**双响应**。见 `use-layer-keydown.ts`。
 *
 * ## 上限
 *
 * 3 层。保活的是重型页面（每层有自己的队列、卡片、计时器），
 * 叠太多是真实的内存与副作用风险。3 层覆盖实际路径
 * （「做题 → 看原文 → 再点一个知识点」已是用户能走出最长的一条），
 * 超出的从**最久没访问**的开始丢（丢 = 卸载 = 回到项目原来的行为）。
 */

import type { PageId } from './pages.ts';

/** 同时保留几层（含当前页）。理由见头注释「上限」 */
export const MAX_RETAINED = 3;

/** 一条任务：哪一页、在干什么、进度细节 */
export interface LayerTask {
  page: PageId;
  /** 显示成「继续：<label>」，如「文档解析」 */
  label: string;
  /** 进度细节，显示在右侧徽标，如「3/12 页」。没有就不显示 */
  detail?: string | null;
}

/**
 * 上报一条任务（或把某一页的任务清掉）。
 *
 * 语义（全部用单测钉住）：
 * 1. 同一页重复上报 = **更新**，不重复添加（并把该页挪到最新）。
 * 2. `task = null` = 这一页没有进行中的事 → 从集合里移除。
 * 3. 超上限从最久没访问的丢。
 */
export function reportTask(state: readonly LayerTask[], task: LayerTask | null, page?: PageId): readonly LayerTask[] {
  /*
   * 清空：需要知道是哪一页。调用方每次 report 都会带上 page
   * （由覆盖层组件绑定），所以这里用 page 参数而不是从 task 里取。
   */
  if (task === null) {
    if (page === undefined) return state;
    const next = state.filter((t) => t.page !== page);
    return next.length === state.length ? state : next;
  }

  const without = state.filter((t) => t.page !== task.page);
  const next = [...without, task];
  /* 超上限：最旧的在前面，先丢它 */
  while (next.length > MAX_RETAINED) next.shift();
  return next;
}

/**
 * 这一刻要渲染哪些层，从旧到新；**最后一项是当前页**（可见、可交互）。
 *
 * 当前页永远补在最后：它可能没有任务（首页/资料/设置），但在显示。
 * 若它本身有任务，已在任务列表里，这里不会重复。
 */
export function layersToRender(tasks: readonly LayerTask[], current: PageId): readonly PageId[] {
  return [...tasks.map((t) => t.page).filter((p) => p !== current), current];
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
 * 侧栏「继续：xxx」该指向哪里。
 *
 * 只在**当前页不是它自己**时给；`current` 有任务时也返回 null
 * （人就在这一页做着，不需要被提醒「继续」）。
 *
 * 取**最近上报**的那个（数组末尾）—— 用户刚跳走的那件事最可能是他要回去的。
 */
export function resumeTarget(tasks: readonly LayerTask[], current: PageId): LayerTask | null {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (t !== undefined && t.page !== current) return t;
  }
  return null;
}

/** 明确丢掉某一页（这一轮结束了，不该再留着它的结果页） */
export function dropPage(state: readonly LayerTask[], page: PageId): readonly LayerTask[] {
  const next = state.filter((t) => t.page !== page);
  return next.length === state.length ? state : next;
}

export const EMPTY_TASKS: readonly LayerTask[] = [];
