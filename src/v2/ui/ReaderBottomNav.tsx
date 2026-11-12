/**
 * 阅读器底部的翻页栏（2026-11-12）。
 *
 * ## 用户反馈
 *
 * 「在查看资料时，如果资料过长需要下滑滚轮，翻页时还需上滑滚轮点击
 *   下一页按钮，应该在界面下端也做上按钮。」
 *
 * ## 为什么单独一个组件
 *
 * `ReaderPage.tsx` 已 1700+ 行，硬约束：新增 UI 一律独立文件。
 * 宿主只插一行。
 *
 * ## 设计取舍
 *
 * 1. **不做成固定悬浮条**：正文已经满屏，再压一条固定栏会挡住最后几行字。
 *    放在正文流末尾，滚到底自然出现 —— 正好接上「读完这一页要翻页」的时机。
 * 2. **复刻顶部那组按钮的行为**，不引入新的翻页语义
 *    （不要让人在两个地方翻页却行为不同）。
 * 3. **到底 / 到顶时按钮禁用**，而不是隐藏 —— 隐藏会让布局跳动。
 * 4. 顺带给一句「第 N / M 段」，让人确认自己翻到哪了。
 *
 * 参考：长文档阅读器的常见做法是在正文末尾提供「上一页 / 下一页」，
 * 与顶部的导航互为补充（顶部用于随时跳，底部用于读完接着翻）。
 */

import type { ReactNode } from 'react';
import './reader-bottom-nav.css';

export interface ReaderBottomNavProps {
  page: number;
  total: number;
  unitLabel: string;
  onPrev: () => void;
  onNext: () => void;
  /** 已经在最顶 / 最底时禁用对应按钮 */
  atStart: boolean;
  atEnd: boolean;
  /** 额外动作（比如「回到顶部」），可选 */
  extra?: ReactNode;
}

export function ReaderBottomNav({
  page,
  total,
  unitLabel,
  onPrev,
  onNext,
  atStart,
  atEnd,
  extra,
}: ReaderBottomNavProps) {
  return (
    <div className="reader-bottom-nav">
      <button
        type="button"
        className="btn-ghost"
        onClick={onPrev}
        disabled={atStart}
        title={atStart ? '已经是第一段' : '上一段'}
      >
        ← 上一段
      </button>

      <span className="reader-bottom-nav__pos">
        第 {page} / {total} {unitLabel}
      </span>

      <button
        type="button"
        className="btn-ghost"
        onClick={onNext}
        disabled={atEnd}
        title={atEnd ? '已经是最后一段' : '下一段'}
      >
        下一段 →
      </button>

      {extra}
    </div>
  );
}
