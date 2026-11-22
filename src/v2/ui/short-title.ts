/**
 * 节点标题截断（2026-11-22 从 `RouteBoard.tsx` 搬出来）。
 *
 * ## 为什么搬家
 *
 * 这个函数原本住在 `RouteBoard.tsx`（横板路线组件）里。
 * 横板路线现在**不再上界面**（学习地图改成了树状 + 两级页面），
 * 但 `RouteTree.tsx` 一直在借它用：
 *
 *   import { shortTitle } from './RouteBoard.tsx';
 *
 * 也就是说：删掉横板组件会把树也一起弄坏。
 * 所以先把它搬到一个中立的小文件，死代码才能干净删掉。
 *
 * ## 为什么需要截断
 *
 * 树上一屏要放下十几个节点，标题不截断会把卡片撑成一条长带，
 * 层级关系反而看不出来。完整标题在 `title` 属性（悬停可见）。
 *
 * ## 为什么在标点处断而不是硬切
 *
 * 硬切 `s.slice(0, 14) + '…'` 会把「第一章 函数与极限」切成
 * 「第一章 函数与极限的…」这种断在词中间的样子，读起来别扭。
 * 按标点/空格断，"读起来是完整的半个标题"。
 */

/**
 * 把标题压到 `max` 字以内。
 *
 * @param title 原标题
 * @param max   最多保留几个字（不含省略号）
 *
 * 断点选择：优先在标点或空格处断（且断点后至少留 4 个字，
 * 太短的片段没意义）；找不到合适断点才硬切加省略号。
 */
export function shortTitle(title: string, max = 14): string {
  const s = title.trim();
  if (s.length <= max) return s;

  const head = s.slice(0, max);
  /*
   * 中文标点 + 英文标点 + 空白。
   *
   * ⚠️ 这里故意**不**用模板字符串拼正则（项目硬约束 10：
   * 含转义的正则拿脚本拼字符串会被吃掉反斜杠，返工过四次）。
   * 直接写字面量。
   */
  const m = /[，。；：、,.;:（(）)\s]/g;
  let lastCut = -1;
  let match: RegExpExecArray | null;
  while ((match = m.exec(head)) !== null) lastCut = match.index;

  /* 断点太靠前（<4 字）就宁可硬切 —— 「第1章…」这种没信息 */
  if (lastCut >= 4) return head.slice(0, lastCut);
  return head + '…';
}