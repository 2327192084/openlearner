/**
 * 做题计时器。
 *
 * ## 为什么不能简单地「换卡时 Date.now()」
 *
 * 原来 ReviewPage 是这么写的：
 * ```
 * useEffect(() => { setStartedAt(Date.now()) }, [index]);
 * ```
 * 问题在于 **effect 跑完不等于用户看到题了**。换卡那一刻：
 *  - 新题卡刚插入 DOM，还在布局
 *  - 若开着「看原图」，图片还在解码
 *  - 长题目的换行、字体度量都可能晚一帧
 *
 * 于是计时起点偏早，实际被测到的时间比「用户真正面对这道题的时间」长。
 * 对一道基准 9 秒的选择题，早计 600 毫秒就足以把「正常」推到「想久了」的边上。
 *
 * 所以这里等**两帧**再起表：第一帧提交布局，第二帧说明已经画出来了。
 *
 * ## 为什么要处理「切走」
 *
 * 用户做一半切去聊天，回来接着做 —— 中间那几分钟不是「在这道题上花了很久」。
 * 把切走的时间算进去，会把「会做」判成「想不出来」，直接拖垮复习间隔。
 * 所以 `document.hidden` 时暂停，回来继续。
 *
 * 暂停与 `MAX_RATIO` 夹取是两道独立保险：
 *  - 暂停挡住「整段离开」
 *  - 夹取挡住「小幅走神」（比如 90 秒发呆，页面没切走）
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CardTimer {
  /**
   * 从「用户看到这道题」到此刻的有效耗时（毫秒）。
   *
   * 已扣除切走的时间。暂停期间调用返回暂停那一刻的值。
   */
  elapsedMs: () => number;
  /** 界面显示用的实时毫秒数（约 10 次/秒刷新） */
  tick: number;
  /** 是否已开始计时（两帧之后才为 true） */
  started: boolean;
  /** 当前是否处于暂停（含切窗口自动暂停与手动暂停） */
  paused: boolean;
  /** 是否由用户主动暂停（区别于切窗口）；界面据此显示「继续」而不是「暂停」 */
  userPaused: boolean;
  /** 手动暂停 / 继续（同一个按钮切换） */
  togglePause: () => void;
  /** 手动重新开始（用户中途被打断时能救一下） */
  restart: () => void;
}

/**
 * @param resetKey 变化时重新起表。传入当前卡片的 id 即可。
 */
export function useCardTimer(resetKey: string | undefined): CardTimer {
  /** 已累计的有效毫秒（不含当前这一段） */
  const accumulatedRef = useRef<number>(0);
  const runningSinceRef = useRef<number | null>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  /** 触发重新起表的计数器 */
  const [generation, setGeneration] = useState(0);

  /**
   * `started` 的 ref 副本。
   *
   * visibilitychange 的监听只注册一次（依赖空数组），闭包里读不到最新的
   * `started` state。用 ref 让回调拿到当前值，而不必重新绑定监听。
   *
   * 必须在监听注册**之前**声明：虽然 effect 回调要到渲染之后才执行、
   * 那时 const 早已初始化，但把声明放在使用之后会让这段代码的
   * 正确性依赖「effect 的执行时机」这个隐含前提 —— 后来的人改动时很容易踩空。
   */
  const startedRef = useRef(false);
  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  const elapsedMs = useCallback(() => {
    const running = runningSinceRef.current;
    const current = running === null ? 0 : Date.now() - running;
    return Math.max(0, accumulatedRef.current + current);
  }, []);

  const restart = useCallback(() => {
    accumulatedRef.current = 0;
    runningSinceRef.current = null;
    setStarted(false);
    setGeneration((g) => g + 1);
  }, []);

  /**
   * 手动暂停 / 继续。
   *
   * ## 为什么必须有这个按钮
   *
   * 原来只有「切到别的窗口自动暂停」。用户反馈：「要加个中途暂停计时的功能」。
   * 原因是自动暂停**完全不可见**：
   *  - 他停下来想一道题（没切窗口）→ 计时照走，几秒后被判「想久了」
   *  - 他切出去又回来 → 暂停了，但他不知道，以为一直在计
   *
   * 两种情况都会让「用时」这个数字不可信。显式按钮把控制权交回用户，
   * 并且状态栏会明确显示「已暂停」。
   *
   * ## 暂停时为什么要区分「自动」和「手动」
   *
   * 自动暂停（切窗口）回来会自动继续；
   * 手动暂停必须由用户点「继续」才恢复 —— 否则他特意暂停去查资料，
   * 切回来一看又在计时了，等于没暂停。
   */
  const pausedByUserRef = useRef(false);

  const pause = useCallback(() => {
    pausedByUserRef.current = true;
    if (runningSinceRef.current !== null) {
      accumulatedRef.current += Date.now() - runningSinceRef.current;
      runningSinceRef.current = null;
    }
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    pausedByUserRef.current = false;
    if (startedRef.current) {
      runningSinceRef.current = Date.now();
    }
    setPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    if (pausedByUserRef.current) resume();
    else pause();
  }, [pause, resume]);

  /** 是否处于「用户主动暂停」（区别于切窗口导致的自动暂停） */
  const [userPaused, setUserPaused] = useState(false);
  useEffect(() => {
    setUserPaused(pausedByUserRef.current);
  }, [paused]);

  // ---- 起表：等两帧，确保用户真的看到题了 ----
  useEffect(() => {
    accumulatedRef.current = 0;
    runningSinceRef.current = null;
    setStarted(false);

    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        runningSinceRef.current = Date.now();
        setStarted(true);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [resetKey, generation]);

  // ---- 切走暂停 / 回来继续 ----
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        // 暂停：把当前这一段结算进累计值
        if (runningSinceRef.current !== null) {
          accumulatedRef.current += Date.now() - runningSinceRef.current;
          runningSinceRef.current = null;
        }
        setPaused(true);
      } else {
        /*
         * 回到前台。
         *
         * 如果用户是**手动**暂停的，这里绝不能自动继续 ——
         * 他特意停下来去查资料/接电话，切回来发现又在计时，等于没暂停。
         * 只有「因为切走才暂停」的情况才自动恢复。
         */
        if (pausedByUserRef.current) return;
        if (startedRef.current) {
          runningSinceRef.current = Date.now();
        }
        setPaused(false);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /**
   * `started` 的 ref 副本已在上面声明。
   */

  // ---- 刷新显示：约 10 次/秒，够用又不浪费 ----
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // tick 只是触发器，实际数值由 elapsedMs() 现算，保证与提交时一致
  void tick;

  return { elapsedMs, tick, started, paused, userPaused, togglePause, restart };
}

/** 把毫秒格式化成「12.3 秒」/「1:05」 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)} 秒`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
