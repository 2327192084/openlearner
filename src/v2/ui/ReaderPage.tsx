import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Source, SourceSegment } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { IconSources } from './icons.tsx';

/**
 * 阅读器 —— 把「可点回原文」从一句徽章变成真的能点。
 *
 * ## 为什么这一页非有不可
 *
 * 在此之前，知识点上写着「可点回原文 · 第 N 页」，但**点不动**：
 * `anchors` 里明明存着 `{sourceId, page, charStart, charEnd}`，
 * 全库却没有任何一处拿它去定位正文。等于对用户撒了个谎 ——
 * 比不写这个徽章更糟，因为它冒充可信。
 *
 * 这一页只做一件事：**给定一个 anchor，把那一页的那一段话滚到眼前并高亮**。
 *
 * ## 几条不能省的规矩
 *
 * 1. **只认页内偏移，不算全文偏移**。`charStart/charEnd` 是相对
 *    `SourceSegment.text` 的偏移（见 `src/core/model.ts` 的注释）。
 *    拿它去切全文，页码一多就整体错位。
 * 2. **切不出来就如实说**，不要硬套一个位置。偏移越界、或切出来的
 *    文字跟引文对不上时，退回到「按引文搜索」；再找不到就明说
 *    「原文位置找不到了」，并仍然把那一页显示出来 —— 让用户自己看。
 * 3. **高亮是 `mark` 元素**，不是靠 CSS 猜位置。所以文本本身不变形，
 *    复制粘贴出来的还是原文。
 * 4. 没有 anchors（粘贴文本/章节切分的资料）时，退化成**纯阅读器**，
 *    可以翻页、可以搜，但不高亮。不给假的高亮。
 */

/** 一个要定位的目标：从知识点/题目带过来的位置 */
export interface ReaderTarget {
  sourceId: string;
  /** 页码，从 1 开始 */
  page?: number;
  charStart?: number;
  charEnd?: number;
  /** 原文引用。偏移失效时用它兜底搜索 */
  quote?: string;
}

export interface ReaderPageProps {
  sourceService: SourceService;
  /** 要打开的资料；null 表示还没选 */
  initialSourceId: string | null;
  /** 要定位到的位置；null 表示只是打开来读 */
  target: ReaderTarget | null;
  onBack: () => void;
}

type LoadPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; source: Source; segments: SourceSegment[] }
  | { kind: 'error'; message: string };

/** 高亮落点。null 表示这一页没有可高亮的区间（纯阅读）。 */
interface Highlight {
  start: number;
  end: number;
  /**
   * 定位可信度，如实显示给用户：
   *  - 'anchor'   偏移直接命中（最可靠）
   *  - 'quote'    偏移对不上，靠引文搜回来
   *  - 'none'     没找到，只有页码
   */
  via: 'anchor' | 'quote' | 'none';
}

export function ReaderPage({ sourceService, initialSourceId, target, onBack }: ReaderPageProps) {
  const [phase, setPhase] = useState<LoadPhase>({ kind: 'loading' });
  /** 当前显示第几段（= 第几页）。1-based。 */
  const [pageNo, setPageNo] = useState(1);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [jumpNote, setJumpNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  // ---------- 载入资料与正文 ----------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!initialSourceId) {
        setPhase({ kind: 'error', message: '没有指定要打开的资料。' });
        return;
      }
      setPhase({ kind: 'loading' });
      try {
        const source = await sourceService.get(initialSourceId);
        if (cancelled) return;
        if (!source) {
          setPhase({ kind: 'error', message: '这份资料已经不在了。可能刚被删除。' });
          return;
        }
        const segments = await sourceService.getSegments(initialSourceId);
        if (cancelled) return;
        setPhase({ kind: 'ready', source, segments });
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : '读不出这份资料的正文。',
        });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [initialSourceId, sourceService]);

  // ---------- 定位到目标 ----------
  useEffect(() => {
    if (phase.kind !== 'ready') return;

    const segments = phase.segments;
    if (segments.length === 0) {
      setHighlight(null);
      setJumpNote(null);
      return;
    }

    // 没有目标 → 纯阅读，从第一页开始
    if (!target) {
      setPageNo(1);
      setHighlight(null);
      setJumpNote(null);
      return;
    }

    // 目标页码：找不到就退回第 1 页，并如实说明
    const wantPage = target.page ?? 1;
    const seg = segments.find((s) => s.page === wantPage) ?? segments[0];
    if (!seg) {
      setHighlight(null);
      setJumpNote('这份资料没有可显示的正文。');
      return;
    }
    setPageNo(seg.index);
    setJumpNote(seg.page === wantPage ? null : `原文第 ${wantPage} 页不存在，已回到第 ${seg.page} 页。`);

    const text = seg.text;

    // 1) 先试偏移。这是最可靠的：偏移是从这份正文里实测出来的。
    const cs = target.charStart;
    const ce = target.charEnd;
    if (
      typeof cs === 'number' &&
      typeof ce === 'number' &&
      cs >= 0 &&
      ce > cs &&
      ce <= text.length
    ) {
      // 有引文时校验一下，防止偏移是别处的
      const sliced = text.slice(cs, ce);
      const quoteOk =
        !target.quote || normalizeForCompare(sliced) === normalizeForCompare(target.quote);
      if (quoteOk) {
        setHighlight({ start: cs, end: ce, via: 'anchor' });
        return;
      }
      // 偏移越界对不上 → 落到下面的引文搜索
    }

    // 2) 偏移不可用，靠引文在这份资料里搜
    const quote = target.quote?.trim();
    if (quote) {
      for (const s of segments) {
        const idx = s.text.indexOf(quote);
        if (idx !== -1) {
          if (s.index !== seg.index) {
            setPageNo(s.index);
            setJumpNote(`引文实际在第 ${s.page} 页，已跳过去。`);
          }
          setHighlight({ start: idx, end: idx + quote.length, via: 'quote' });
          return;
        }
      }
    }

    // 3) 都没找到 —— 只显示页码，明说没定位到
    setHighlight({ start: 0, end: 0, via: 'none' });
  }, [phase, target]);

  // 高亮出现后把它滚到视野里
  useEffect(() => {
    if (!markRef.current) return;
    const el = markRef.current;
    // block:'center' 让上下文同时在视野里，而不是把高亮顶到最上边
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, pageNo]);

  const seg: SourceSegment | null = useMemo(() => {
    if (phase.kind !== 'ready') return null;
    return phase.segments.find((s) => s.index === pageNo) ?? phase.segments[0] ?? null;
  }, [phase, pageNo]);

  const totalSegments = phase.kind === 'ready' ? phase.segments.length : 0;

  const goPage = useCallback(
    (next: number) => {
      if (phase.kind !== 'ready') return;
      const clamped = Math.max(1, Math.min(phase.segments.length, next));
      setPageNo(clamped);
      // 手翻页就不再保留上一个定位的高亮，否则用户以为那页有锚点
      setHighlight(null);
      setJumpNote(null);
      setSearchNote(null);
      bodyRef.current?.scrollTo({ top: 0 });
    },
    [phase],
  );

  /** 在当前资料里搜一句，命中就跳过去高亮 */
  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || phase.kind !== 'ready') return;
    setSearchNote(null);
    try {
      const hits = await sourceService.search(initialSourceId ?? '', q);
      if (hits.length === 0) {
        setSearchNote(`这份资料里没有找到「${q}」。`);
        return;
      }
      const hit = hits[0]!;
      const segIdx =
        phase.segments.find((s) => s.id === hit.segmentId)?.index ??
        phase.segments.find((s) => s.page === hit.page)?.index ??
        1;
      setPageNo(segIdx);
      setHighlight({ start: hit.charStart, end: hit.charEnd, via: 'quote' });
      setJumpNote(null);
      setSearchNote(
        hits.length > 1
          ? `找到 ${hits.length} 处，已跳到第 1 处（第 ${hit.page} 页）。`
          : `在第 ${hit.page} 页找到。`,
      );
    } catch (err) {
      setSearchNote(err instanceof Error ? err.message : '搜索失败。');
    }
  }, [query, phase, sourceService, initialSourceId]);

  // ---------- 渲染 ----------
  if (phase.kind === 'loading') {
    return (
      <div className="reader-page">
        <p className="reader-lead">正在打开资料…</p>
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="reader-page">
        <header className="reader-head">
          <div>
            <h1 className="reader-title">阅读原文</h1>
            <p className="reader-lead">这里能看到资料的正文，并把知识点定位到具体位置。</p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            <IconSources size={15} />
            返回资料
          </button>
        </header>
        <div className="reader-error">{phase.message}</div>
      </div>
    );
  }

  const { source, segments } = phase;

  if (segments.length === 0) {
    return (
      <div className="reader-page">
        <header className="reader-head">
          <div>
            <h1 className="reader-title">{source.title}</h1>
            <p className="reader-lead">这份资料没有可显示的正文。</p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            <IconSources size={15} />
            返回资料
          </button>
        </header>
        <div className="reader-empty">
          {source.textStatus === 'no-text-layer' ? (
            <>
              <p className="reader-empty__title">这份 PDF 是扫描件，没有文字层</p>
              <p className="reader-hint">
                它的内容是一张张图片，取不出可检索的文字。所以没有正文可以显示，
                也没法把知识点定位到具体句子 —— 这不是文件坏了。
                扫描件识别（OCR）还没接进来，接好之后这里会有正文。
              </p>
            </>
          ) : source.textStatus === 'decode-failed' ? (
            <>
              <p className="reader-empty__title">这份文件的文字取不出来</p>
              <p className="reader-hint">
                文件里是有文字的（有字体、有绘制指令），但我们的解析没取出来。
                这是我们这边的问题，不是你该换一份文件。
              </p>
            </>
          ) : (
            <>
              <p className="reader-empty__title">没有可显示的正文</p>
              <p className="reader-hint">这份资料没有存下任何文本段。</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="reader-page">
      <header className="reader-head">
        <div>
          <h1 className="reader-title">{source.title}</h1>
          <p className="reader-lead">
            {source.kind.toUpperCase()}
            {source.pageCount ? ` · 共 ${source.pageCount} 页` : ''}
            {` · 第 ${seg?.page ?? 1} / ${totalSegments} 段`}
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={onBack}>
          <IconSources size={15} />
          返回资料
        </button>
      </header>

      {/* 定位状态：如实说清这次是「偏移命中」还是「靠引文找回」还是「没找到」 */}
      {highlight ? (
        <p className={`reader-jump reader-jump--${highlight.via}`}>
          {highlight.via === 'anchor'
            ? `已定位到第 ${seg?.page ?? 1} 页的原文位置。`
            : highlight.via === 'quote'
              ? `原文偏移对不上了，靠引文在第 ${seg?.page ?? 1} 页找回来的。`
              : `只找到页码（第 ${seg?.page ?? 1} 页），没能定位到具体句子 —— 这份资料的正文可能重新解析过。`}
        </p>
      ) : null}
      {jumpNote ? <p className="reader-jump reader-jump--none">{jumpNote}</p> : null}

      {/* 翻页 + 搜索 */}
      <div className="reader-bar">
        <div className="reader-nav">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => goPage(pageNo - 1)}
            disabled={pageNo <= 1}
          >
            上一段
          </button>
          <span className="reader-nav__pos">
            {pageNo} / {totalSegments}
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => goPage(pageNo + 1)}
            disabled={pageNo >= totalSegments}
          >
            下一段
          </button>
        </div>
        <div className="reader-search">
          <input
            className="reader-search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch();
            }}
            placeholder="在这份资料里搜一句…"
          />
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void doSearch()}
            disabled={query.trim().length === 0}
          >
            搜索
          </button>
        </div>
      </div>
      {searchNote ? <p className="reader-hint">{searchNote}</p> : null}

      {/* 正文 */}
      {/*
       * chapter 是解析器从「这一页的第一行」猜出来的（见 parsers/pdf.ts
       * 的 detectChapter）。而这一行往往同时是正文的第一行 ——
       * 直接渲染 chapter 再渲染整段 text，就会出现同一个标题连着出现两次。
       * 所以：只有当正文不以这行开头时才单独显示章节标题。
       */}
      <div className="reader-body" ref={bodyRef}>
        {seg ? (
          renderBody(seg, highlight, markRef)
        ) : null}
      </div>
    </div>
  );
}

/** 正文渲染：按需显示章节标题 + 高亮切分 */
function renderBody(
  seg: SourceSegment,
  highlight: Highlight | null,
  markRef: RefObject<HTMLElement | null>,
) {
  const chapter = seg.chapter?.trim() ?? '';
  // 正文已经以章节标题开头 → 不再单独显示一遍
  const showChapter = chapter.length > 0 && !seg.text.trimStart().startsWith(chapter);

  return (
    <>
      {showChapter ? <h2 className="reader-chapter">{chapter}</h2> : null}
      {renderText(seg.text, highlight, markRef)}
      <p className="reader-meta">
        第 {seg.page} 页 · {seg.charCount} 字
      </p>
    </>
  );
}

/**
 * 把一段正文按高亮区间切成三段渲染。
 *
 * 用 `<mark>` 而不是给字符套 span —— mark 是语义化的，屏幕阅读器会念出来，
 * 而且不改变文本内容本身（复制出来还是原文）。
 */
function renderText(
  text: string,
  highlight: Highlight | null,
  markRef: RefObject<HTMLElement | null>,
) {
  // 没有高亮，或高亮是「没找到」的空区间 → 原样显示
  if (!highlight || highlight.via === 'none' || highlight.end <= highlight.start) {
    return <p className="reader-para">{text}</p>;
  }

  const start = Math.max(0, Math.min(text.length, highlight.start));
  const end = Math.max(start, Math.min(text.length, highlight.end));

  const before = text.slice(0, start);
  const hit = text.slice(start, end);
  const after = text.slice(end);

  return (
    <p className="reader-para">
      {before}
      <mark
        className="reader-mark"
        ref={(el) => {
          markRef.current = el;
        }}
      >
        {hit}
      </mark>
      {after}
    </p>
  );
}

/**
 * 比较引文与切出来的文本时，忽略空白差异。
 *
 * 为什么需要：PDF 取出的正文里换行、多余空格的位置，和模型引用时
 * 抄回来的可能不一样。逐字节比较会把本来对得上的位置判成对不上，
 * 于是白白退回到「靠引文搜索」。
 */
function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, '').trim();
}
