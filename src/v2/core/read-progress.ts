/**
 * 阅读进度的纯逻辑（2026-11-13）。
 *
 * ## 用户为什么要这个
 *
 * 原话：「资料进度不符合实际情况，应更名为题组进度。资料进度应该根据
 * 资料阅读情况实现，需要做一个记忆系统，记住用户上一次打开资料的状态。」
 *
 * 也就是说首页那块「10 道 · 已学 5 · 2 道到期」是**题**的进度，
 * 挂在资料名下叫「资料进度」名不副实。改名的同时要真的做一份阅读进度。
 *
 * ## 口径（用户 2026-11-13 拍板）
 *
 * **读过 = 翻到过的最远页码。**
 *
 * 明确排除了两种更复杂的方案：
 *  - 按停留时长算「看过哪几页」—— 要定义「几秒算看过」，而且阈值一定被质疑
 *  - 两个指标并列 —— 必须写清区别，反而增加理解成本
 *
 * 代价（用户知道并接受）：直接拉到最后一页也算「读过」。
 * 所以界面上写的是「到过第 N 页」，不写「已读 N 页」——
 * 前者是事实，后者会被理解成「逐页读完」。
 *
 * ## 为什么拆成纯函数
 *
 * 「进度怎么算」「两次记录怎么合并」这两件事一旦写进 JSX，
 * 就再也没法单测。而它们最容易出的错是**静默的**：
 * 往回翻一下进度条就缩了、或者时间戳没更新导致排序错 ——
 * 界面上都看不出是 bug，只觉得数字怪。
 */

import type { SourceReadProgress } from '@/core/model.ts';

/** 空进度（还没读过） */
export const EMPTY_READ_PROGRESS: SourceReadProgress = {
  furthestPage: 0,
  lastPage: 0,
  lastSegmentIndex: 0,
  lastScrollTop: 0,
  lastReadAt: '',
};

/** 一次阅读位置上报 */
export interface ReadPosition {
  /** 当前页码（从 1 开始） */
  page: number;
  /** 当前段索引（0 开始） */
  segmentIndex: number;
  /** 当前段内滚动像素 */
  scrollTop: number;
  /** 发生时间（ISO）。不传就由调用方补 */
  at: string;
}

/**
 * 把一次位置上报合并进已有进度。
 *
 * ## 三条不变量
 *
 * 1. **`furthestPage` 只增不减**。往回翻时 `lastPage` 变小，
 *    但「读过的最远」不该退 —— 否则用户回看一下前面的内容，
 *    进度条就缩水，像是被扣了进度。
 * 2. **`lastPage` 永远取最新**。这是「回到上次位置」用的。
 * 3. **`lastReadAt` 取较晚的那个**。乱序上报（异步写入、旧请求晚到）
 *    不该把时间戳倒退，否则「最近在读」的排序会跳。
 */
export function mergeReadProgress(
  prev: SourceReadProgress | undefined | null,
  next: ReadPosition,
  /** 资料总页数，用于夹取；未知传 null 就不夹上限 */
  totalPages: number | null,
): SourceReadProgress {
  const base = prev ?? EMPTY_READ_PROGRESS;
  const page = clampPage(next.page, totalPages);
  const prevFurthest = clampPage(base.furthestPage, totalPages);

  /* 时间戳只往前走：乱序上报不该让它倒退 */
  const at = laterIso(base.lastReadAt, next.at);

  return {
    furthestPage: Math.max(prevFurthest, page),
    lastPage: page,
    lastSegmentIndex: Math.max(0, Math.round(next.segmentIndex)),
    lastScrollTop: Math.max(0, Math.round(next.scrollTop)),
    lastReadAt: at,
  };
}

/** 夹到 [1, total]。页码非法（NaN/0/负）时给 1 */
export function clampPage(page: number, totalPages: number | null): number {
  const n = Number.isFinite(page) ? Math.round(page) : 1;
  const low = Math.max(1, n);
  if (totalPages === null || !Number.isFinite(totalPages) || totalPages <= 0) return low;
  return Math.min(low, Math.round(totalPages));
}

/** 取两个 ISO 里较晚的那个。空串表示「没有」，直接让位 */
export function laterIso(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  /* ISO 8601 同格式可直接比字符串；解析失败也不崩 */
  return a >= b ? a : b;
}

/**
 * 进度百分比（0~1）。没读过返回 0。
 *
 * 用 `furthestPage / totalPages`：用户定的口径是「到过的最远一页」。
 * `totalPages` 未知（null/0）时返回 0 —— 不编一个看起来煞有介事的数字。
 */
export function readRatio(progress: SourceReadProgress | undefined | null, totalPages: number | null): number {
  if (!progress) return 0;
  if (totalPages === null || !Number.isFinite(totalPages) || totalPages <= 0) return 0;
  return Math.min(1, Math.max(0, progress.furthestPage / totalPages));
}

/**
 * 进度文案。
 *
 * 写「到过第 N 页」而不是「已读 N 页」：前者是事实（用户可能跳着看），
 * 后者会被理解成「逐页读完」。这个区别是用户接受「最远页码」口径的
 * 前提 —— 界面不能把口径说得比实际更强。
 */
export function readLabel(progress: SourceReadProgress | undefined | null, totalPages: number | null): string {
  if (!progress || progress.furthestPage <= 0) return '还没读过';
  if (totalPages === null || totalPages <= 0) return `到过第 ${progress.furthestPage} 页`;
  return `到过第 ${progress.furthestPage}/${totalPages} 页`;
}

/** 有没有值得一提的阅读记录（用来决定要不要显示这一行） */
export function hasReadProgress(progress: SourceReadProgress | undefined | null): boolean {
  return !!progress && progress.furthestPage > 0;
}

/**
 * 打开资料时该从哪一段开始。
 *
 * 用户 2026-11-13 定：**不提示，直接自动回到上次位置**。
 * 所以这里只回答「回到哪」，不参与任何询问流程。
 *
 * @returns 段索引；没有记录或索引越界时返回 null（调用方从第 0 段开始）
 */
export function resumeSegmentIndex(
  progress: SourceReadProgress | undefined | null,
  segmentCount: number,
): number | null {
  if (!hasReadProgress(progress)) return null;
  if (!Number.isFinite(segmentCount) || segmentCount <= 0) return null;
  const idx = Math.round(progress!.lastSegmentIndex);
  if (idx < 0 || idx >= segmentCount) return null;
  return idx;
}

/**
 * 「最近在读」排序用：按 `lastReadAt` 倒序。
 *
 * 为什么要有这个：用户要的是「记忆系统」，那么下次打开应该能看见
 * 「我最近在读哪几份」。没读过的排最后。
 */
export function sortByRecentRead<T extends { readProgress?: SourceReadProgress }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const at = a.readProgress?.lastReadAt ?? '';
    const bt = b.readProgress?.lastReadAt ?? '';
    if (at === bt) return 0;
    if (!at) return 1;
    if (!bt) return -1;
    return at < bt ? 1 : -1;
  });
}
