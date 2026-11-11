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
 * ## 2026-11-11 第二轮：每个片段都带 `data-raw`（修标注偏移）
 *
 * 上一轮只修了「知识点定位高亮」（走 `marks`，在原始字符串上 slice，
 * 所以位置一直是对的）。用户自己的标注走另一条路 ——
 * `paintTextMarks` 用 CSS Custom Highlight，拿**原文偏移**去
 * **渲染后 DOM 的文本节点**上累计，两边字符数不同，必然画偏
 * （实测第 1 页原文 1048 字，DOM 文本 606 字，差 442 字）。
 *
 * 现在渲染的每个片段都写 `data-raw`（该片段在原文里的起点）与
 * `data-raw-len`（原文长度）。于是任何一方（绘制、取选区偏移）
 * 都能精确换算，不再依赖「DOM 文本长度 ≈ 原文长度」这个错误假设。
 * 详见 `dom-text-map.ts` 头部。
 *
 * ## 为什么公式要单独成片段
 *
 * `$v_{s}$` 在原文里 7 个字符，经 KaTeX 渲染后可见文本只有 `vs`（2 个）。
 * 若把一个段落整块标一个 `data-raw`，公式后面的文字偏移就全错了。
 * 所以**先按公式切开，每个纯文本片段 / 每个公式各占一个 `data-raw`**：
 * 纯文本片段的 DOM 偏移与原文偏移逐字对应，公式整体作为一个不可分单位。
 *
 * 这也决定了标注在公式处**吸附到整个公式**：KaTeX 的可见字符与
 * LaTeX 源码不是一一对应，精确到公式内部没有意义。
 *
 * ## 为什么 table 只能整块标黄
 *
 * 表格在 Markdown 里用 `|` 分隔，单元格的文字在原文里并不是连续区间
 * （有 `|` 和换行夹在中间）。要做到单元格级高亮就得给每个单元格
 * 单独记偏移，而用户几乎不会给表格里的半句话做标注 ——
 * 收益低、出错面大。整块命中就整块标，至少位置不会错到别的段落。
 *
 * 单元格也因此**不带 `data-raw`**：在表格里划选时取不到精确偏移，
 * 调用方会退回「按引文搜索」（见 ReaderPage.handleAddMark）。
 */

import type { RefObject } from 'react';
import { MathText } from './MathText.tsx';
import { intersect, splitBlocks } from './markdown-marks.ts';
import { escapeHtml, renderMath, splitMath } from './render-math.ts';

/** 高亮区间（**原文偏移**，相对整段正文） */
export interface MarkRange {
  start: number;
  end: number;
}

export interface MarkdownBodyMarkedProps {
  /** 该切片（或整段）的原始文本，含 Markdown 标记 */
  text: string;
  /**
   * 这段 `text` 在**整体正文**里的起始偏移（原文坐标）。
   *
   * ReaderPage 会把一段按插图切成若干切片，此时每个切片的起点不同。
   * `marks` / `notes` 都是**原文绝对偏移**，本组件用 `absFrom` 换算，
   * 不需要调用方先做减法。
   */
  absFrom?: number;
  /** 要高亮的区间（原文绝对偏移） */
  marks?: readonly MarkRange[];
  /** 第一个 <mark> 元素，供滚动定位 */
  markRef?: RefObject<HTMLElement | null>;
  /**
   * 备注区间（2026-11-11，原文绝对偏移）。
   *
   * 与 `marks`（定位高亮）分开传，因为**渲染方式完全不同**：
   *  - marks → 黄色底色（`.reader-mark`）
   *  - notes → 红色下划线（`.reader-note`）
   *
   * 用户 2026-11-11 反馈「下划线和角标也没渲染出来」「定位不明显」，
   * 已改为**红色实线**下划线（颜色与琥珀色的批注下划线区分，
   * 在密排中文里比虚线醒目得多）。
   */
  notes?: readonly MarkRange[];
  /** 第一个备注元素，供滚动定位 */
  noteRef?: RefObject<HTMLElement | null>;
}

/** 一个渲染片段：纯文本或公式，自带它在原文里的范围 */
interface Piece {
  math: boolean;
  /** 纯文本片段的内容；公式片段为 null */
  text: string | null;
  /** 公式的 LaTeX 源码；纯文本片段为 null */
  latex: string | null;
  block: boolean;
  /** 原文起点 */
  from: number;
  /** 原文长度 */
  to: number;
}

/**
 * 把一段文本切成「纯文本 / 公式」片段，每个片段记下**原文**范围。
 *
 * 纯函数。**所有片段的 [from,to) 必须首尾相接且总长等于 `text.length`**
 * —— 这条一旦破了，标注就会漂，单测钉死它。
 */
export function toPieces(text: string, absFrom: number): Piece[] {
  const out: Piece[] = [];
  let from = absFrom;

  for (const p of splitMath(text)) {
    if (!p.math) {
      if (p.value.length === 0) continue;
      out.push({
        math: false,
        text: p.value,
        latex: null,
        block: false,
        from,
        to: from + p.value.length,
      });
      from += p.value.length;
      continue;
    }
    /* 公式在原文里占 `$...$` 或 `$$...$$` 整段长度 */
    const delims = p.block ? 4 : 2;
    const len = p.value.length + delims;
    out.push({
      math: true,
      text: null,
      latex: p.value,
      block: p.block ?? false,
      from,
      to: from + len,
    });
    from += len;
  }
  return out;
}

export function MarkdownBodyMarked({
  text,
  absFrom = 0,
  marks = [],
  markRef,
  notes = [],
  noteRef,
}: MarkdownBodyMarkedProps) {
  const blocks = splitBlocks(text);
  const key = { n: 0 };
  const out: React.ReactNode[] = [];

  /**
   * 渲染一个纯文本片段，可能同时叠加两层修饰：
   *  1. 定位高亮（`marks`）→ 黄色底色，<mark class="reader-mark">
   *  2. 备注（`notes`）→ 红色下划线，<span class="reader-note">
   *
   * 两层正交叠加：先按备注切三段，有备注那段再按高亮切一次。
   * 形状（备注包住高亮）：<span class="reader-note"><mark>…</mark></span>
   * 底色来自 mark、下划线来自外层 span，互不覆盖。
   */
  const renderTextPiece = (piece: Piece): React.ReactNode => {
    const s = piece.text ?? '';
    const a0 = piece.from; /* 片段原文起点 */
    const a1 = piece.to;

    const markHit = marks
      .map((m) => intersect(a0, a1, m.start, m.end))
      .find((x) => x !== null);
    const noteHit = notes
      .map((m) => intersect(a0, a1, m.start, m.end))
      .find((x) => x !== null);

    if (!markHit && !noteHit) return s;

    /** 在片段内 [lo,hi) 上套高亮；lo/hi 是相对片段起点的偏移 */
    const withMark = (lo: number, hi: number, seg: string) => {
      if (!markHit) return seg;
      const ms = Math.max(lo, markHit.start);
      const me = Math.min(hi, markHit.end);
      if (me <= ms) return seg;
      const before = seg.slice(0, ms - lo);
      const hit = seg.slice(ms - lo, me - lo);
      const after = seg.slice(me - lo);
      return (
        <>
          {before}
          <mark
            className="reader-mark"
            ref={(el) => {
              if (el && markRef && !markRef.current) markRef.current = el;
            }}
          >
            {hit}
          </mark>
          {after}
        </>
      );
    };

    if (!noteHit) {
      return withMark(0, s.length, s);
    }

    /* 有备注：切成「备注前 / 备注内 / 备注后」 */
    const ns = Math.max(0, noteHit.start);
    const ne = Math.min(s.length, noteHit.end);
    const before = s.slice(0, ns);
    const hit = s.slice(ns, ne);
    const after = s.slice(ne);

    return (
      <>
        {before ? withMark(0, ns, before) : null}
        {hit ? (
          <span
            className="reader-note"
            ref={(el) => {
              if (el && noteRef && !noteRef.current) noteRef.current = el;
            }}
          >
            {withMark(ns, ne, hit)}
            {/*
              行末角标：2026-11-11 晚用户要求**去掉**。
              「备注的那个红色角标小点不要了，保留下划线就够。」
              红色下划线本身已经能定位到具体哪几个字，小点属于多余装饰。
            */}
          </span>
        ) : null}
        {after ? withMark(ne, s.length, after) : null}
      </>
    );
  };

  /** 公式片段：整体作为一个单位，命中就整块套修饰（理由见文件头） */
  const renderMathPiece = (piece: Piece): React.ReactNode => {
    const hitMark = marks.some((m) => intersect(piece.from, piece.to, m.start, m.end) !== null);
    const hitNote = notes.some((m) => intersect(piece.from, piece.to, m.start, m.end) !== null);

    const rendered = renderMath(piece.latex ?? '', piece.block);
    const html = rendered ?? escapeHtml(piece.block ? `$$${piece.latex}$$` : `$${piece.latex}$`);

    const inner = (
      <span
        className="math-text raw-piece"
        data-raw={piece.from}
        data-raw-len={piece.to - piece.from}
        data-raw-math=""
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );

    if (!hitMark && !hitNote) return inner;

    const marked = hitMark ? (
      <mark
        className="reader-mark"
        ref={(el) => {
          if (el && markRef && !markRef.current) markRef.current = el;
        }}
      >
        {inner}
      </mark>
    ) : (
      inner
    );

    return hitNote ? (
      <span
        className="reader-note"
        ref={(el) => {
          if (el && noteRef && !noteRef.current) noteRef.current = el;
        }}
      >
        {marked}
      </span>
    ) : (
      marked
    );
  };

  /** 渲染一个块的全部片段 */
  const renderPieces = (blockText: string, from: number): React.ReactNode => {
    /*
     * ⚠️ `splitBlocks(text)` 给的块偏移是**相对本切片**的（从 0 开始），
     * 而 marks / notes 是**整段正文的绝对偏移**。所以要加上 absFrom。
     *
     * 这一条漏掉过一次：有插图的页被切成多个切片，
     * 每个切片都从 0 重新计数，于是标注全画到前面去了
     * （实测第 1 页高亮跑到了图注上）。单测 markdown-body-pieces
     * 覆盖的是 toPieces 自身，覆盖不到这个「加不加 absFrom」的调用点，
     * 所以靠 CDP 读真实 DOM 抓出来的。
     */
    const pieces = toPieces(blockText, absFrom + from);
    return pieces.map((p) =>
      p.math ? (
        <span key={key.n++}>{renderMathPiece(p)}</span>
      ) : (
        <span
          key={key.n++}
          className="raw-piece"
          data-raw={p.from}
          data-raw-len={p.to - p.from}
        >
          {renderTextPiece(p)}
        </span>
      ),
    );
  };

  for (const b of blocks) {
    if (b.kind === 'heading') {
      const inner = renderPieces(b.text, b.from);
      const cls = `reader-md-h reader-md-h--${b.level}`;
      /*
       * data-from 用**绝对偏移**（absFrom + 块内起点），
       * 这样 handleAddMark 的兜底路径「base + dataFrom + 块内偏移」
       * 与 data-raw 的口径一致，不会因为切片基准不同而错位。
       */
      const attrs = {
        className: cls,
        'data-from': absFrom + b.from,
        'data-offset-base': 0,
        key: key.n++,
      };
      if (b.level === 1) out.push(<h1 {...attrs}>{inner}</h1>);
      else if (b.level === 2) out.push(<h2 {...attrs}>{inner}</h2>);
      else if (b.level === 3) out.push(<h3 {...attrs}>{inner}</h3>);
      else out.push(<h4 {...attrs}>{inner}</h4>);
      continue;
    }

    if (b.kind === 'para') {
      out.push(
        <p
          className="reader-para"
          data-from={absFrom + b.from}
          data-offset-base={0}
          key={key.n++}
        >
          {renderPieces(b.text, b.from)}
        </p>,
      );
      continue;
    }

    if (b.kind === 'list') {
      const items = b.items.map((it, i) => (
        <li key={i} data-from={absFrom + it.from} data-offset-base={0}>
          {renderPieces(it.text, it.from)}
        </li>
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

    /*
     * 表格：整块命中就整块加一层 marked 类，逐格不再切三段。
     *
     * ⚠️ b.from / b.to 是**相对本切片**的，而 marks / notes 是绝对偏移，
     * 比较前必须加上 absFrom（同 renderPieces 的理由）。
     */
    const tFrom = absFrom + b.from;
    const tTo = absFrom + b.to;
    const tableHit = marks.some((m) => intersect(tFrom, tTo, m.start, m.end) !== null);
    const tableNote = notes.some((m) => intersect(tFrom, tTo, m.start, m.end) !== null);
    out.push(
      <table
        className={`reader-md-table${tableHit ? ' reader-md-table--marked' : ''}${tableNote ? ' reader-md-table--noted' : ''}`}
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
 *
 * @param absFrom 这段 text 在整体正文里的起点。传入后返回**绝对偏移**；
 *   不传则返回相对本 text 的偏移。
 *
 * ⚠️ 目前没有调用方（2026-11-11 查）。保留是因为它表达了「块内命中」
 * 这一判断，将来「滚动到高亮」要用。**注意别把相对偏移当绝对偏移用** ——
 * 这正是本轮修掉的那类 bug。
 */
export function firstHit(
  text: string,
  marks: readonly MarkRange[],
  absFrom = 0,
): MarkRange | null {
  for (const b of splitBlocks(text)) {
    if (b.kind === 'list') {
      for (const it of b.items) {
        for (const m of marks) {
          const h = intersect(absFrom + it.from, absFrom + it.to, m.start, m.end);
          if (h) return { start: absFrom + it.from + h.start, end: absFrom + it.from + h.end };
        }
      }
      continue;
    }
    for (const m of marks) {
      const h = intersect(absFrom + b.from, absFrom + b.to, m.start, m.end);
      if (h) return { start: absFrom + b.from + h.start, end: absFrom + b.from + h.end };
    }
  }
  return null;
}
