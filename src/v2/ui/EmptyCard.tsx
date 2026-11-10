/**
 * 空态卡片（2026-11-10）。
 *
 * ## 为什么需要它
 *
 * 用户要求「美化 UI」。截图复核后发现：**空态页是全应用最没有设计感的地方** ——
 * 学习笔记、待办、专注、设置都是「一行说明 + 一个按钮」躺在空白里，
 * 没有任何视觉重心。而设计系统第一句就写着
 * 「the card is the only physical object; everything else is type on a desk」，
 * 空态恰恰最需要那张「纸」来锚住视线。
 *
 * 更麻烦的是各页各写一套：`.nt-empty` 是左对齐的 `padding` 块、
 * `.kb-empty` 是带边框的居中方块、`.today__empty` 又不一样。
 * 同一种「这里还没有东西」的状态，视觉上有三种说法。
 *
 * ## 为什么复用 `.paper` 而不是新造一套
 *
 * `.paper` 有三件必须做对的细节（顶部 2px 朱砂线、索引卡横格、16px 圆角），
 * 少一个就变成「一个米色的 div」。空态卡片直接穿上这套 —— 
 * 全应用的「纸」长得一样，用户一眼认得出这是同一类东西。
 *
 * ## 为什么图标要放进一个圆形里
 *
 * 纯图标在米色纸上对比不够（纸是 #ece4d6，图标若用 --paper-dim 只有灰）。
 * 加一层极淡的圆底把图标「托起来」，视线先落在圆上、再读标题，
 * 比一堆居中的字更容易看出「这里现在是空的，但你可以做点什么」。
 *
 * ## 用法
 *
 * ```tsx
 * <EmptyCard
 *   icon={<IconNotes size={22} />}
 *   title="还没有任何笔记"
 *   hint="做题时在题目卡下方，或者在阅读器里给某份资料留一句。"
 *   action={{ label: '去知识库看看', onClick: () => ... }}
 * />
 * ```
 *
 * 不传 `action` 就不渲染按钮 —— 不摆点了没反应的按钮。
 */

import type { ReactNode } from 'react';
import './empty-card.css';

export interface EmptyCardProps {
  /** 图标（用现有 icons.tsx 里的组件，传已实例化的元素） */
  icon?: ReactNode;
  /** 主标题：一句话说清「这里为什么是空的」 */
  title: string;
  /** 补充说明：告诉用户怎么让它不空 */
  hint?: ReactNode;
  /** 可选的主操作 */
  action?: { label: string; onClick: () => void };
  /** 可选的次要操作（比如「看个例子」） */
  secondary?: { label: string; onClick: () => void };
  /**
   * 尺寸。
   * - `page`：占满一页的空态（默认）
   * - `inline`：嵌在某个区块里的小空态（比如列表区域）
   */
  size?: 'page' | 'inline';
}

export function EmptyCard({
  icon,
  title,
  hint,
  action,
  secondary,
  size = 'page',
}: EmptyCardProps) {
  return (
    <div className={`empty-card empty-card--${size}`}>
      {icon ? (
        <span className="empty-card__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="empty-card__title">{title}</p>
      {hint ? <p className="empty-card__hint">{hint}</p> : null}
      {action || secondary ? (
        <div className="empty-card__actions">
          {action ? (
            <button type="button" className="empty-card__btn" onClick={action.onClick}>
              {action.label}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              className="empty-card__btn empty-card__btn--ghost"
              onClick={secondary.onClick}
            >
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
