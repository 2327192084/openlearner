/**
 * 导航历史栈（2026-11-09）。
 *
 * ## 解决什么
 *
 * 用户原话：「需要一个返回按钮放在软件左上角，从错题库或是知识点
 * 跳转到资料内时，不能返回回去。频繁的跳转很麻烦，同时也不好定位
 * 原先的位置。」
 *
 * 也就是说：从「错题与待巩固」跳到阅读器第 9 页，想回去继续看错题，
 * 只能点侧栏重新进错题页 —— **分组折叠状态、滚动位置、筛选条件全丢了**，
 * 得重新展开、重新找到刚才那一题。
 *
 * ## 设计
 *
 * 一个**只存页面 id** 的栈，不存 DOM 状态。
 *
 * 为什么不做成「完整状态快照」：那需要每个页面自己实现序列化/反序列化，
 * 45 个页面各写一套，成本远超收益；而且任何一页忘了实现，
 * 恢复出来的界面就是半截的（比没有更糟）。
 *
 * 折中：栈负责「回到哪一页」，页面内部用自己的 state 恢复滚动与展开
 * —— 关键是**不要卸载它**。所以真正的做法是阅读器作为「覆盖层」
 * 叠在当前页上，底层页面保持挂载。见 App.tsx 里 reader 的分支处理。
 *
 * ## 上限
 *
 * 20 层够用，且防止用户长时间点来点去后数组无限增长。
 */

import { useCallback, useRef, useState } from 'react';

export interface NavHistory<T> {
  /** 当前页 */
  current: T;
  /** 能不能返回（栈非空） */
  canGoBack: boolean;
  /**
   * 去一个新页面。
   * @param keepPrevious 为 true 时把当前页压栈（默认），false 时直接替换
   */
  go: (next: T, keepPrevious?: boolean) => void;
  /** 返回上一页；栈空时返回 false */
  back: () => boolean;
  /** 清空历史（比如用户主动点侧栏跳转时，视为重新开始一条路径） */
  reset: (next: T) => void;
}

const MAX_DEPTH = 20;

export function useNavHistory<T>(initial: T): NavHistory<T> {
  const [current, setCurrent] = useState<T>(initial);
  /*
   * 栈用 ref 而不是 state：它不参与渲染。
   * 用 state 会让每次入栈都触发一次无意义的重渲染，
   * 而「能不能返回」由 canGoBack 单独驱动。
   */
  const stackRef = useRef<T[]>([]);
  const [depth, setDepth] = useState(0);

  const go = useCallback((next: T, keepPrevious = true) => {
    setCurrent((prev) => {
      if (keepPrevious && prev !== next) {
        stackRef.current.push(prev);
        if (stackRef.current.length > MAX_DEPTH) stackRef.current.shift();
        setDepth(stackRef.current.length);
      }
      return next;
    });
  }, []);

  const back = useCallback(() => {
    const prev = stackRef.current.pop();
    if (prev === undefined) return false;
    setCurrent(prev);
    setDepth(stackRef.current.length);
    return true;
  }, []);

  const reset = useCallback((next: T) => {
    stackRef.current = [];
    setDepth(0);
    setCurrent(next);
  }, []);

  return { current, canGoBack: depth > 0, go, back, reset };
}
