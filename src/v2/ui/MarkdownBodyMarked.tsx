/**
 * 按 Markdown 结构渲染正文，并把指定字符区间标成 <mark>（2026-11-11）。
 *
 * ## 它替换掉什么
 *
 * `ReaderPage` 原来有两条互斥路径：
 *  - `MarkdownBody`：结构正确，但**不知道**高亮区间
 *  - 「切三段」：知道高亮，但**不做** Markdown 渲染
 *
 * 所以一有定位/高亮，整页就退化成带 `#` 的纯文本（用户截图里的
 * `# 第1章 信号与系统`），而且高亮偏移是按原始文本算的、
 * 屏幕上显示的字却已被去掉 `#`，于是标注位置错开。
 *
 * 本组件把两件事合成一件：先按结构切块（`splitBlocks`，偏移对准原文），
 * 渲染每块时若与高亮区间相交，就在块内切三段套 <mark>。
 *
 * ## 为什么 table 只能整块标黄
 *
 * 表格在 Markdown 里用 `|` 分隔，单元格的文字在原文里并不是连续区间
 * （有 `|` 和换行夹在中间）。要做到单元格级高亮就得给每个单元格
 * 单独记偏移，而用户几乎不会给表格里的半句话做标注 ——
 * 收益低、出错面大。整块命中就整块标，至少位置不会错到别的段落。
 */

import type { RefObject } from 'react';
import { MathText } from './MathText.tsx';
import { intersect, sliceForMark, splitBlocks } from './markdown-marks.ts';

/** 高亮区间（相对整段 text 的字符偏移） */
export interface MarkRange {
  start: number;
  end: number;
}

export interface MarkdownBodyMarkedProps {
  /** 该切片（或整段）的原始文本，含 Markdown 标记 */
  text: string;
  /** 要高亮的区间；同时可能有多处（将来支持多标记时用） */
  marks?: readonly MarkRange[];
  /** 第一个 <mark> 元素，供滚动定位 */
  markRef?: RefObject<HTMLElement | null>;
  /**
   * 基础偏移：这个 `text` 在**整体正文**里的起始位置。
   *
   * ReaderPage 会把一段按插图切成若干切片，高亮区间是相对整段的，
   * 所以传进来时要减去这个偏移。
   */
  baseOffset?: number;
  /**
   * 备注区间（2026-11-11）。
   *
   * 与 `marks`（定位高亮）分开传，因为**渲染方式完全不同**：
   *  - marks → 黄色底色（`.reader-mark`）
   *  - notes → 虚线下划线 + 行末小圆点（`.reader-note`）
   *
   * 用户要求「除了小点，再加一个下划线好分辨具体位置」：
   * 小点告诉「这段有备注」，下划线告诉「具体是哪几个字」。
   * 用**虚线**而不是实线，是为了与批注的「下划线」区分 ——
   * 那一种才是真下划线，实线。
   */
  notes?: readonly MarkRange[];
  /** 第一个备注元素，供滚动定位 */
  noteRef?: RefObject<HTMLElement | null>;
}

/** 把「相对整段」的高亮换算成「相对本切片」 */
function toLocal(marks: readonly MarkRange[], baseOffset: number): MarkRange[] {
  return marks
    .map((m) => ({ start: m.start - baseOffset, end: m.end - baseOffset }))
    .filter((m) => m.end > 0 && m.start < Number.MAX_SAFE_INTEGER);
}

export function MarkdownBodyMarked({
  text,
  marks = [],
  markRef,
  baseOffset = 0,
  notes = [],
  noteRef,
}: MarkdownBodyMarkedProps) {
  const local = toLocal(marks, baseOffset);
  const localNotes = toLocal(notes, baseOffset);
  const blocks = splitBlocks(text);

  const key = { n: 0 };
  const out: React.ReactNode[] = [];

  /**
   * 渲染一段文字，可能同时叠加三种修饰：
   *  1. 定位高亮（`marks`）→ 黄色底色，包在 <mark> 里
   *  2. 备注（`notes`）→ 虚线下划线，包在 <span class="reader-note"> 里
   *
   * ## 为什么两者能同时生效而不打架
   *
   * 这是用户最担心的一点（「不要与被批注部分冲突」）。做法是
   * **正交叠加**：先把文字按备注区间切三段，有备注那一段再按高亮区间
   * 切一次。因为两层都用相对本段文字的偏移，嵌套不会有歧义。
   *
   * 具体形状（以「备注包住高亮」为例）：
   *   <span class="reader-note"><mark class="reader-mark">…</mark></span>
   * 底色来自 mark、虚线来自外层 span，视觉上互不覆盖。
   */
  const renderInline = (s: string, from: number, to: number) => {
    /* ---- 先算两层各自的局部区间 ---- */
    const markHit = local
      .map((m) => intersect(from, to, m.start, m.end))
      .find((x) => x !== null);

    const noteHit = localNotes
      .map((m) => intersect(from, to, m.start, m.end))
      .find((x) => x !== null);

    /* 两层都没有：原样输出，不制造多余 DOM */
    if (!markHit && !noteHit) return <MathText text={s} />;

    /** 在 [a,b) 内套高亮；无高亮就原样返回这段文字 */
    const withMark = (a: number, b: number, seg: string) => {
      if (!markHit) return <MathText text={seg} />;
      /* 高亮与 [a,b) 的交集 */
      const ms = Math.max(a, markHit.start);
      const me = Math.min(b, markHit.end);
      if (me <= ms) return <MathText text={seg} />;
      const cut = sliceForMark(seg, ms - a, me - a);
      return (
        <>
          <MathText text={cut.before} />
          <mark
            className="reader-mark"
            ref={(el) => {
              if (el && markRef && !markRef.current) markRef.current = el;
            }}
          >
            <MathText text={cut.hit} />
          </mark>
          <MathText text={cut.after} />
        </>
      );
    };

    /* ---- 没有备注，只有高亮：直接套 mark ---- */
    if (!noteHit) return withMark(0, s.length, s);

    /* ---- 有备注：把文字切成「备注前 / 备注内 / 备注后」，中间那段套虚线下划线 ---- */
    const n = sliceForMark(s, noteHit.start, noteHit.end);
    return (
      <>
        {n.before ? withMark(0, noteHit.start, n.before) : null}
        {n.hit ? (
          <span
            className="reader-note"
            ref={(el) => {
              if (el && noteRef && !noteRef.current) noteRef.current = el;
            }}
          >
            {withMark(noteHit.start, noteHit.end, n.hit)}
            {/*
              小圆点：告诉「这段有备注」，即使备注区间在屏幕外也能看到。
              用 aria-hidden —— 它是纯视觉提示，读屏用户从 title 得到信息。
            */}
            <span className="reader-note__dot" aria-hidden="true" />
          </span>
        ) : null}
        {n.after ? withMark(noteHit.end, s.length, n.after) : null}
      </>
    );
  };

  for (const b of blocks) {
    if (b.kind === 'heading') {
      const inner = renderInline(b.text, b.from, b.to);
      const cls = `reader-md-h reader-md-h--${b.level}`;
      if (b.level === 1) out.push(<h1 className={cls} key={key.n++}>{inner}</h1>);
      else if (b.level === 2) out.push(<h2 className={cls} key={key.n++}>{inner}</h2>);
      else if (b.level === 3) out.push(<h3 className={cls} key={key.n++}>{inner}</h3>);
      else out.push(<h4 className={cls} key={key.n++}>{inner}</h4>);
      continue;
    }

    if (b.kind === 'para') {
      out.push(
        <p className="reader-para" key={key.n++}>
          {renderInline(b.text, b.from, b.to)}
        </p>,
      );
      continue;
    }

    if (b.kind === 'list') {
      const items = b.items.map((it, i) => (
        <li key={i}>{renderInline(it.text, it.from, it.to)}</li>
      ));
      out.push(
        b.ordered ? (
          <ol className="reader-md-list" key={key.n++}>{items}</ol>
        ) : (
          <ul className="reader-md-list" key={key.n++}>{items}</ul>
        ),
      );
      continue;
    }

    /* 表格：整块命中就整块加一层 marked 类，逐格不再切三段 */
    const tableHit = local.some((m) => intersect(b.from, b.to, m.start, m.end) !== null);
    out.push(
      <table
        className={`reader-md-table${tableHit ? ' reader-md-table--marked' : ''}`}
        key={key.n++}
      >
        <thead>
          <tr>
            {b.head.map((c, ci) => (
              <th key={ci}><MathText text={c} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.body.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci}><MathText text={c} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>,
    );
  }

  /* 包一层：没有 mark 时与旧 MarkdownBody 的 DOM 结构保持一致，样式不受影响 */
  return <div className="reader-md">{out}</div>;
}

/**
 * 取第一个命中的区间，用于「滚动到高亮处」。
 *
 * 单独导出是因为调用方需要的是「有没有命中」，而这个判断
 * 必须在切块之后才知道 —— 不能只看区间是否与整段相交
 * （可能落在被切掉的语法符号上）。
 */
export function firstHit(
  text: string,
  marks: readonly MarkRange[],
  baseOffset = 0,
): MarkRange | null {
  const local = toLocal(marks, baseOffset);
  for (const b of splitBlocks(text)) {
    if (b.kind === 'list') {
      for (const it of b.items) {
        for (const m of local) {
          const h = intersect(it.from, it.to, m.start, m.end);
          if (h) return { start: it.from + h.start, end: it.from + h.end };
        }
      }
      continue;
    }
    for (const m of local) {
      const h = intersect(b.from, b.to, m.start, m.end);
      if (h) return { start: b.from + h.start, end: b.from + h.end };
    }
  }
  return null;
}
