import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextMarkKind, TextMark } from '@/core/model.ts';
import { describeTextAnchor, MARK_LABELS, MARK_COLORS } from '@/core/text-anchor.ts';
import { newId } from '@/core/id.ts';

/**
 * 选中文字后弹出的标记工具条。
 *
 * ## 为什么浮在选区上方
 *
 * 那正是用户视线的位置。放到页面底部或侧栏都要「找一下」，
 * 而高亮是高频操作（读书时一直在做），多一步就明显变累。
 *
 * ## 为什么不做成浏览器右键菜单
 *
 * 右键菜单会盖住选区、样式不可控，且在 Electron 里与系统菜单打架。
 * 自己画一浮层最直接。
 */

export interface SelectionToolbarProps {
  /** 承载文字的容器（用于判断选区是否在范围内、以及算位置） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 这一页的纯文本 */
  fullText: string;
  page: number;
  /** 创建标记 */
  onCreate: (mark: TextMark) => void;
  /** 已有标记的创建时间来源 */
  now?: () => string;
}

export function SelectionToolbar({
  containerRef,
  fullText,
  page,
  onCreate,
  now = () => new Date().toISOString(),
}: SelectionToolbarProps) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [pending, setPending] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  /**
   * 从当前选区算出「页内纯文本偏移」。
   *
   * 不能直接用 selection 的字符数：容器里可能有表格、
   * 多个段落，各段之间还有浏览器插入的空白。
   * 所以遍历容器内的文本节点，累计字符数，
   * 直到找到锚点所在节点 —— 这样偏移与 fullText 才是同一套坐标。
   */
  const computeSelection = useCallback(() => {
    const container = containerRef.current;
    const sel = window.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPos(null);
      setPending(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setPos(null);
      setPending(null);
      return;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; start: number }[] = [];
    let offset = 0;
    let n: Node | null = walker.nextNode();
    while (n) {
      const t = n as Text;
      nodes.push({ node: t, start: offset });
      offset += t.data.length;
      n = walker.nextNode();
    }

    const findOffset = (node: Node, localOffset: number): number | null => {
      for (const rec of nodes) {
        if (rec.node === node) return rec.start + localOffset;
      }
      return null;
    };

    const start = findOffset(range.startContainer, range.startOffset);
    const end = findOffset(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) {
      setPos(null);
      setPending(null);
      return;
    }

    const text = fullText.slice(start, end);
    if (text.trim().length === 0) {
      setPos(null);
      setPending(null);
      return;
    }

    // 工具条浮在选区上方居中
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPos(null);
      setPending(null);
      return;
    }
    setPos({ left: rect.left + rect.width / 2, top: rect.top - 10 });
    setPending({ start, end, text });
  }, [containerRef, fullText]);

  useEffect(() => {
    const onUp = () => {
      // 等浏览器把选区定下来再读，否则读到的是旧的
      window.setTimeout(computeSelection, 10);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    // 键盘选择（Shift+方向键）也要能触发
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, [computeSelection]);

  /** 点击工具条外部时收起 */
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;
      // 点在自己身上不收起
      setPos(null);
      setPending(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pos]);

  const apply = (kind: TextMarkKind) => {
    if (!pending) return;
    const anchor = describeTextAnchor(fullText, pending.start, pending.end, page);
    if (!anchor) return;
    onCreate({
      id: newId('mark'),
      kind,
      anchor,
      color: MARK_COLORS[kind],
      createdAt: now(),
    });
    // 收起并清掉选区，避免用户以为还能再点一次
    window.getSelection()?.removeAllRanges();
    setPos(null);
    setPending(null);
  };

  if (!pos || !pending) return null;

  return (
    <div
      ref={barRef}
      className="sel-bar"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      // 工具条自身不参与选区，否则点按钮会清掉选区
      onMouseDown={(e) => e.preventDefault()}
    >
      {(['highlight', 'underline', 'strikethrough'] as TextMarkKind[]).map((k) => (
        <button
          key={k}
          type="button"
          className="sel-bar__btn"
          onClick={() => apply(k)}
          title={`给选中的 ${pending.text.length} 个字加${MARK_LABELS[k]}`}
        >
          {MARK_LABELS[k]}
        </button>
      ))}
    </div>
  );
}
