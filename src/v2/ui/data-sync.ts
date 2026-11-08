/**
 * 数据同步的决策规则。
 *
 * ## 这个模块解决什么（用户 2026-11-08 报的 bug）
 *
 * 原话：「我把题库里的题都删掉了，但学习库的待复习便签还是显示有 15 道题，
 * 我再次重启后才显示正常。」
 *
 * 根因：`cardPool` 是启动时算一次的 props 快照。删题后它不更新，
 * 于是 `todayOverview(旧池子)` 照样数出 15 —— 数据没错，是**界面没跟着变**。
 *
 * ## 为什么把决策抽成纯函数
 *
 * 这里的逻辑有两个容易写错的地方，而 App 组件没有 DOM 测试环境测不了：
 *
 * 1. **读失败时要保持旧池子**，不能清成空数组。
 *    清掉的话界面会突然显示「0 道题」，用户以为题全丢了 —— 比显示旧数字糟得多。
 * 2. **算数字要用「刚读到的」池子**，不能用 state 里的旧值。
 *    React 的 setState 是异步的，紧接着读 `pool` 还是旧值，
 *    那就会用旧池子再算一遍 —— 等于没修。
 *
 * 抽出来后两条都能单测。
 */

/**
 * 决定这一轮刷新后应该用哪个卡片池。
 *
 * @param fresh 刚从存储读到的池子；读失败时为 null
 * @param current 当前界面上的池子
 * @returns 接下来应该用于**计算数字**的池子，以及是否要更新 state
 */
export function resolvePool(
  fresh: readonly string[] | null,
  current: readonly string[],
): { effective: readonly string[]; shouldUpdate: boolean } {
  if (fresh === null) {
    // 读失败：继续用旧的。不更新 state（否则会触发无意义的重渲染）
    return { effective: current, shouldUpdate: false };
  }
  /*
   * 读到新值：无论内容是否变化都更新 state。
   *
   * 不比较内容：「内容一样就不更新」看似省一次渲染，但会引入
   * 「池子没变、但里面有题的复习状态变了」时漏刷新的风险。
   * 这个界面很小，重渲染的代价远小于漏刷新的代价。
   */
  return { effective: fresh, shouldUpdate: true };
}

/**
 * 侧栏徽标要显示的数字。
 *
 * 与 `refreshCounts` 里的写法保持一致 —— 抽出来是为了让
 * 「0 时不显示复习徽标」这条规则可测。
 *
 * 为什么 due 为 0 时不放这个键：徽标是「有事要做」的提示。
 * 显示一个 0 的徽标等于在喊「有 0 件事要做」，纯噪音。
 * 而「资料」份数即使是 0 也要显示：库是空的这件事本身有意义。
 */
export function badgeCounts(
  dueCount: number,
  sourceCount: number,
): { sources: number; review?: number } {
  const out: { sources: number; review?: number } = { sources: sourceCount };
  if (dueCount > 0) out.review = dueCount;
  return out;
}
