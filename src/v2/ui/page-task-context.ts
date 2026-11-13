/**
 * 「这一层现在有没有正在进行、且值得接着做的事」—— 由页面自己上报（2026-11-13 傍晚）。
 *
 * ## 为什么需要它（用户报的问题）
 *
 * 上一轮做页面保活时，侧栏「继续：xxx」的判据是
 * **「这一页还在保活栈里」**。那是错的：
 *
 * > 「做这个跳页功能是为了知道某些任务的进度，例如文档解析，出题功能。
 * >  但没有正在进行文档解析的任务时，这个提示也一直存在。」
 *
 * 保活只说明**页面留在内存里**，不说明用户在做任何事。
 * 打开过「文档解析」页就永久留一层，于是提示永远在 —— 那是一个假提示，
 * 比没有提示更糟（用户会以为有活儿没干完）。
 *
 * ## 为什么必须由页面自己上报
 *
 * 「有没有进行中的事」只有页面知道，而且**同一个页面的不同子视图也可能不同**：
 *
 * - 文档解析：真正的解析跑在 `ConvertPanel` 里（`phase.kind === 'running'`），
 *   外层 `ParsePage` 根本不知道 —— 光看 ParsePage 的 state 只能看到「读到资料列表了」
 * - 整理知识点：`phase.kind === 'running'`
 * - 模拟考试：`phase.kind === 'taking'`（`setup` / `result` 都不算）
 * - 复习巩固：`reviewSession !== null`
 *
 * App 在外面猜不出来，所以改成：**页面把进度报上来，App 只负责显示。**
 *
 * ## 用法
 *
 * 在页面（或它的子组件，比如 ConvertPanel）里：
 *
 * ```tsx
 * // 没有进行中的事 → 报 null，侧栏入口立刻消失、这一层也不再保活
 * usePageTask(null);
 *
 * // 有 → 报一个标签（+ 可选的进度细节）
 * usePageTask({ label: '文档解析', detail: '3/12 页' });
 * ```
 *
 * 组件卸载时自动清空，所以「离开且没在跑」的页面不会留下残余提示。
 *
 * 默认上下文是 `null`（= 不上报、不保活）：不在这棵树里的页面
 * （单测、单独渲染）行为与「没有保活机制」时一致。
 */

import { createContext, useContext, useEffect } from 'react';

/** 一条「正在进行」的进度描述 */
export interface TaskProgress {
  /** 干什么（显示成「继续：<label>」），如「文档解析」 */
  label: string;
  /** 进度细节，显示在右侧小徽标里，如「3/12 页」「已出 8 条」。没有就不显示 */
  detail?: string | null;
}

export interface PageTaskReporter {
  /** 上报当前这一层的进度；null = 没有进行中的事 */
  report: (task: TaskProgress | null) => void;
}

export const PageTaskContext = createContext<PageTaskReporter | null>(null);

/**
 * 上报当前这一层有没有进行中的任务。
 *
 * @param task 进度描述；`null` 表示没有 —— 侧栏入口会消失，这一层也不再保活
 */
export function usePageTask(task: TaskProgress | null): void {
  const reporter = useContext(PageTaskContext);

  /*
   * 依赖只取 label / detail 两个原始值，不取 task 对象本身。
   *
   * 页面通常每次渲染都新建一个对象字面量（`{ label, detail }`），
   * 若依赖对象引用，每次渲染都会重新上报 → App 每次都 setState →
   * 再渲染 → 再上报，一个不停的重渲染循环。取原始值就不会。
   */
  const label = task?.label ?? null;
  const detail = task?.detail ?? null;

  useEffect(() => {
    if (!reporter) return;
    reporter.report(label === null ? null : { label, detail });
    /* 卸载时清空：这一层不再算「有进行中的事」 */
    return () => reporter.report(null);
  }, [reporter, label, detail]);
}
