/**
 * 选区浮层：选中正文就冒出来的「用这段提问」（2026-11-10）。
 *
 * ## 它接的是哪条断掉的线
 *
 * 提问式复习三期只做了「知识点随机」。用户最初要的四种范围里，
 * 「某段落」一直缺着 —— 因为那需要用户**在原文里指出是哪一段**。
 * `core/selection-passage.ts` 已经能把选区转成素材，缺的是
 * 「选中 → 点一下」这个动作。本组件就是那个动作。
 *
 * ## 为什么是浮层而不是右栏里的一个按钮
 *
 * 右栏（`ReaderSidePanel`）已经有「加标记」，加一个「提问」在视觉上
 * 只是又一个按钮，但**位置上离选区很远**：用户在正文中段选完字，
 * 眼睛在字上，右边栏的变化容易被忽略（「选中了但不知道能干什么」）。
 * 浮层贴在选区旁边，动作和目标在同一处。
 *
 * 右栏那条路也没丢 —— 本组件只做「最常用那一个动作」，
 * 三条高亮/下划线/删除线仍留在右栏，两边不重复。
 *
 * ## 为什么自己算位置而不装一个库
 *
 * 查过：GitHub 上 `selection popover` / `floating toolbar` 一类库
 * （floating-ui 等）主要解决的是「跟随滚动 + 边界翻转」。
 * 我们只有一个固定尺寸的小浮层、只在选区变化时重算一次，
 * 把这套依赖引进来（还要配套 React 绑定）收益不抵成本。
 * 边界算术已单独抽到 `selection-bar-place.ts` 并单测（16 条），
 * 那才是容易出错的部分。
 *
 * ## 为什么用 rect 而不是 DOM 里塞浮层
 *
 * 浮层挂在 `<body>` 下的 fixed 层：正文容器有 `overflow` 与
 * `transform` 风格的祖先，塞进去会被裁切或跟着滚走。
 * fixed + 视口坐标是唯一稳的做法。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BAR_GAP,
  isUsableAnchor,
  placeBar,
} from './selection-bar-place.ts';
import type { RectLike } from './selection-bar-place.ts';
import './selection-action.css';

export interface SelectionActionBarProps {
  /**
   * 当前选区。null = 没有可用选区，浮层隐藏。
   *
   * 由宿主（ReaderPage）在 selectionchange 时算好传进来 ——
   * 浮层自己不监听事件：监听已经有一份了（那处还要判「选区在不在正文里」），
   * 两处监听会在时序上打架。
   */
  selection: { rect: RectLike; text: string } | null;
  /** 点「用这段提问」 */
  onAsk: (text: string) => void;
  /** 是否禁用（比如没接 AI）—— 禁用时给出原因，不做点了没反应的按钮 */
  disabledReason?: string | null;
}

export function SelectionActionBar({ selection, onAsk, disabledReason }: SelectionActionBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(
    null,
  );

  const usable = Boolean(selection && selection.text.trim() && isUsableAnchor(selection.rect));

  /**
   * 量浮层自身尺寸再定位。
   *
   * 用 useLayoutEffect 而不是 useEffect：后者会在浏览器绘制之后才跑，
   * 用户会看到浮层先在左上角闪一下再跳到位。layout effect 在绘制前
   * 完成，肉眼看不到中间态。
   *
   * 依赖里带 selection.rect 的四个数字而不是对象本身：
   * 宿主每次都构造新对象，按引用比会每次都重算（虽然结果一样，
   * 但会让浮层每帧都 setState 一次，正是「选区拖动时界面发抖」的成因）。
   */
  useLayoutEffect(() => {
    if (!usable || !selection) {
      setPos(null);
      return;
    }
    const el = barRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const next = placeBar({
      anchor: selection.rect,
      /* 量不到尺寸时给个保守估计，总比 0 宽好（0 会让它贴左边） */
      bar: {
        width: rect.width || 160,
        height: rect.height || 36,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
    setPos(next);
  }, [
    usable,
    selection?.rect.left,
    selection?.rect.top,
    selection?.rect.width,
    selection?.rect.height,
  ]);

  /** 点按钮时先把选区记下来：点击会让浏览器清掉选区 */
  const handleAsk = useCallback(() => {
    if (!selection) return;
    const text = selection.text;
    /* 清掉选区，避免浮层点完还挂在原处（用户会以为没生效） */
    window.getSelection()?.removeAllRanges();
    onAsk(text);
  }, [selection, onAsk]);

  if (!usable || !selection) return null;

  /*
   * 首次渲染（pos 还是 null）时先放到视口外。
   *
   * 不能放 left:0/top:0 —— 那会在左上角闪一帧。visibility:hidden
   * 配合下面的定位完成后再显示，用户看不到中间态。
   */
  const style: React.CSSProperties = pos
    ? { left: `${pos.left}px`, top: `${pos.top}px` }
    : { left: '0px', top: '0px', visibility: 'hidden' };

  return createPortal(
    <div
      ref={barRef}
      className={`selbar selbar--${pos?.placement ?? 'above'}`}
      style={style}
      /* 浮层上的按下不该被当成「在正文里点了一下」，否则宿主会清掉选区 */
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="选区操作"
    >
      <button
        type="button"
        className="selbar__btn"
        onClick={handleAsk}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? '就选中的这段向 AI 提问'}
      >
        用这段提问
      </button>
      {disabledReason ? <span className="selbar__why">{disabledReason}</span> : null}
    </div>,
    document.body,
  );
}

/* BAR_GAP 在本文件没有直接用，但它是浮层位置的对外契约（单测按它断言），
   这里 re-export 方便使用方不必知道它来自哪个文件。 */
export { BAR_GAP };

/**
 * 从当前 window 选区量出「相对正文容器的矩形」。
 *
 * ## 为什么单独导出
 *
 * 宿主（ReaderPage）要在 selectionchange 里拿矩形，而那段代码
 * 在 1200+ 行的大文件里。把「怎么量」放这里、宿主只调一次，
 * 是「大文件不插代码」这条硬约束的具体执行方式。
 *
 * ## 为什么用 getBoundingClientRect
 *
 * 它是唯一能拿到「选区在视口里的实际位置」的标准方法
 * （`getClientRects()[0]` 在跨行选区时只给第一行，浮层会偏上）。
 * bounding 给的是整个选区的外包框，跨行时居中看着更自然。
 *
 * @returns null = 选区不可用（跨了隐藏节点、已失效、或在容器外）
 */
export function measureSelectionRect(container: HTMLElement | null): RectLike | null {
  if (!container) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  /* 选区必须整个落在正文容器里 —— 在右栏选备注文字不该冒出提问浮层 */
  if (!container.contains(range.commonAncestorContainer)) return null;

  const rect = range.getBoundingClientRect();
  if (!isUsableAnchor(rect)) return null;

  /*
   * 转成普通对象。
   *
   * DOMRect 是活的（随滚动变化），直接塞进 state 会让 React 拿到
   * 一个「永远相同」的引用，比较失效、浮层不跟着更新。
   */
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** 滚动/窗口变化时浮层要不要跟着动 */
export function useRepositionOnScroll(onChange: () => void): void {
  useEffect(() => {
    /*
     * capture:true 才能收到正文容器内部的滚动
     * （scroll 事件不冒泡，只有捕获阶段能拿到内层滚动）。
     */
    const handler = () => onChange();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [onChange]);
}
