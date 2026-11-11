/**
 * 翻页滑块（2026-11-11）。
 *
 * ## 用户要的是什么
 *
 * 「『滑轮/输入页码』是用在翻页功能，说是滑轮，但不是用鼠标滚轮实现的。
 *   而是类似于进度条，用户可以通过拖动一个圆形滑轮翻到大致想要的页面。」
 *
 * 所以不是「滚轮翻页」，也不是单纯的页码输入框，而是：
 * **一条进度条 + 一个可拖动的圆形滑块**，拖动时显示目标页，松手才跳。
 *
 * ## 为什么拖动中不跳、松手才跳
 *
 * 正文每页都要渲染 Markdown + KaTeX（第 1 页有 7 个公式），
 * 拖一下经过 36 段会触发几十次完整渲染，界面直接卡住。
 * 所以拖动中只更新「将跳到第 N 页」的提示，松手（pointerup）才真正 goPage。
 * 这与主流阅读器（Acrobat / Preview 的缩略图滑条）的做法一致。
 *
 * ## 为什么用 input[type=range] 而不是自己画
 *
 * 自绘滑块要处理：键盘无障碍（左右键翻页）、触摸事件、指针捕获、
 * 焦点环、各平台拖动手感。`<input type="range">` 这些全都自带，
 * 而且原生就能被读屏软件读出「第 N 页 / 共 M 页」。
 *
 * 圆形滑块外观靠 CSS 的 `::-webkit-slider-thumb` 实现
 * （Electron = Chromium，只需管这一个前缀）。
 *
 * ⚠️ 按项目硬约束 2：`input` 是原生控件，配色**必须写在 @layer 外面**。
 * 本组件的样式在 reader-page.css 末尾，那个文件不套 @layer。
 *
 * ## 为什么单独一个文件
 *
 * `ReaderPage.tsx` 已 1800+ 行。硬约束 5：新增 UI 一律独立文件。
 */

import { useCallback, useRef, useState } from 'react';

export interface PageSliderProps {
  /** 当前页码（1 基） */
  page: number;
  /** 总页数 */
  total: number;
  /** 松手后真正跳转 */
  onJump: (page: number) => void;
  /** 无障碍标签用的名字（「段」/「页」） */
  unitLabel?: string;
}

export function PageSlider({ page, total, onJump, unitLabel = '段' }: PageSliderProps) {
  /**
   * 拖动中的临时值（null = 没在拖，显示 props.page）。
   *
   * 单独一个 state 而不是直接改 page：拖动过程中不能触发真正的翻页
   * （理由见文件头），所以必须是「意图」与「实际页」分离。
   */
  const [dragging, setDragging] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const shown = dragging ?? page;

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.max(1, Math.min(total, next));
      setDragging(null);
      if (clamped !== page) onJump(clamped);
    },
    [onJump, page, total],
  );

  /* 只有一页时没有可拖的，别摆一个拖了没反应的控件 */
  if (total <= 1) return null;

  return (
    <div className="reader-slider">
      <input
        className="reader-slider__input"
        type="range"
        min={1}
        max={total}
        step={1}
        value={shown}
        aria-label={`翻到指定${unitLabel}`}
        aria-valuetext={`第 ${shown} ${unitLabel}，共 ${total} ${unitLabel}`}
        /* 拖动中：只更新提示，不跳页 */
        onChange={(e) => {
          const v = Number(e.target.value);
          draggingRef.current = true;
          setDragging(v);
        }}
        /* 松手：真正跳过去 */
        onPointerUp={() => {
          if (draggingRef.current && dragging !== null) commit(dragging);
          draggingRef.current = false;
        }}
        /*
         * 键盘操作（左右键）也要能跳。
         * 用 onKeyUp 而不是 onChange：按住方向键会连发 change，
         * 每一下都跳页会渲染几十次，卡顿明显。
         */
        onKeyUp={() => {
          if (dragging !== null) commit(dragging);
        }}
        /* 失焦兜底：某些情况下 pointerup 收不到（指针移出窗口） */
        onBlur={() => {
          if (dragging !== null) commit(dragging);
          draggingRef.current = false;
        }}
      />

      {/* 拖动中显示目标页；静止时显示当前位置 */}
      <span className={`reader-slider__label${dragging !== null ? ' reader-slider__label--on' : ''}`}>
        {dragging !== null ? `跳到第 ${dragging} ${unitLabel}` : `${page} / ${total}`}
      </span>
    </div>
  );
}
