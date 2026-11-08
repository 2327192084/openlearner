import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Source, SourceImageRecord, SourceSegment } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { IconSources } from './icons.tsx';
import { MathText } from './MathText.tsx';
import { ReaderFigure } from './ReaderFigure.tsx';
import { splitByFigures } from '@/core/mineru/images.ts';
import './reader-figure.css';

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
  | {
      kind: 'ready';
      source: Source;
      segments: SourceSegment[];
      /**
       * 正文里的插图（2026-11-08）。
       *
       * 与 segments 一起载入，但**不参与** charStart/charEnd 的计算 ——
       * 图片在正文里不占字符，只是「插在这里」。见 core/mineru/images.ts 的说明。
       */
      figures: SourceImageRecord[];
    }
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

  /**
   * 原图查看。
   *
   * ## 为什么必须有
   *
   * 用户报的原话是「PDF 文件依旧查看不了」。在此之前阅读器只显示
   * **提取出来的文字** —— 对扫描件是空的，对图文混排的教材则丢掉了所有
   * 图、公式、表格。而这正是用户要「对照检查 OCR 有没有错」时最需要看的。
   *
   * ## 实现取舍
   *
   * 用现成的 `renderSourcePage`（pdfjs → canvas → PNG dataURL），
   * 而不是嵌一个 `<embed src=blob:>` 让浏览器自己渲染：
   *  - 后者在 Electron 的 file:// 下有 CSP 与插件限制，实测不可靠；
   *  - 而且拿不到「渲染到第几页」的控制权。
   *
   * 只渲染**当前这一页**：整本 628 页一次性渲染会吃掉几百 MB 内存。
   */
  const [showOriginal, setShowOriginal] = useState(false);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const [originalLoading, setOriginalLoading] = useState(false);
  /** 有没有原文件可供渲染（没有就藏掉这个开关，不摆假按钮） */
  const [canShowOriginal, setCanShowOriginal] = useState(false);

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
        /*
         * 插图与正文一起取。
         *
         * 为什么不是「翻到哪页取哪页」：图在 IndexedDB 里，一次全取
         * 一份 36 页教材才 88 条、几十毫秒；而按页取要加索引动库版本，
         * 收益等 628 页的书真的卡了再说。
         *
         * 取不到（旧库、或转换时 MinerU 没切出图）就是空数组，
         * 阅读器照常显示正文，不提示「图片加载失败」—— 没有图不是错误。
         */
        const figures = await sourceService.getFigures(initialSourceId);
        if (cancelled) return;
        setPhase({ kind: 'ready', source, segments, figures });
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

  // ---------- 原图渲染 ----------
  // 只在「打开原图」且是 PDF 时按需渲染当前页。整本预渲染会吃几百 MB 内存。
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (!showOriginal) return;
    if (phase.source.kind !== 'pdf') return;

    let cancelled = false;
    setOriginalLoading(true);
    setOriginalError(null);

    async function render() {
      if (phase.kind !== 'ready') return;
      try {
        const bytes = await sourceService.getOriginalFile(phase.source.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setCanShowOriginal(false);
          setOriginalError('这份资料没有保存原始文件，看不了原图。');
          return;
        }
        const { renderSourcePage } = await import('@/core/slides/source-page.ts');
        // 目标宽度 1100px：够看清正文与图表，又不至于把 628 页的教材撑爆内存
        const rendered = await renderSourcePage(bytes, pageNo, { targetWidth: 1100 });
        if (cancelled) return;
        setOriginalImage(rendered.imageData);
      } catch (err) {
        if (cancelled) return;
        setOriginalError(
          err instanceof Error ? err.message : '这一页渲染不出来（文件可能损坏或缺字体）。',
        );
      } finally {
        if (!cancelled) setOriginalLoading(false);
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [phase, showOriginal, pageNo, sourceService]);

  // 载入后判断有没有原文件可看（PDF 才有意义）
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (phase.source.kind !== 'pdf') {
      setCanShowOriginal(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const has = await sourceService.hasOriginalFile(phase.source.id);
        if (!cancelled) setCanShowOriginal(has);
      } catch {
        if (!cancelled) setCanShowOriginal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, sourceService]);

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

        {/*
         * 看原图 / 看文字 的切换。
         * 只在真的有原文件时出现 —— 没有就藏掉，不摆一个点了没反应的按钮。
         */}
        {canShowOriginal ? (
          <button
            type="button"
            className={`btn-ghost${showOriginal ? ' reader-toggle--on' : ''}`}
            onClick={() => setShowOriginal((v) => !v)}
            title="对照原书检查文字识别有没有错"
          >
            {showOriginal ? '看文字' : '看原图'}
          </button>
        ) : null}
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
        {showOriginal ? (
          /*
           * 原图模式：只渲染当前这一页。
           *
           * 为什么不做成「连续滚动整本」：628 页的教材一次性渲染
           * 会吃掉几百 MB 内存并卡死界面。按页渲染 + 用上面的翻页控制
           * 已经足够「对照检查 OCR 有没有错」这个真实用途。
           */
          <div className="reader-original">
            {originalLoading ? <p className="reader-hint">正在把这一页画出来…</p> : null}
            {originalError ? (
              <p className="reader-error reader-error--inline">{originalError}</p>
            ) : null}
            {originalImage && !originalLoading ? (
              <img
                className="reader-original__img"
                src={originalImage}
                alt={`第 ${seg?.page ?? pageNo} 页的原图`}
              />
            ) : null}
          </div>
        ) : seg ? (
          renderBody(
            seg,
            highlight,
            markRef,
            /*
             * 只给当前页的图。
             *
             * 按 page 过滤而不是按 index：`seg.page` 与原书页码一致，
             * 而 index 是按段序号（章节切分的资料里两者可能不等）。
             *
             * 传进去之前已经按 charOffset 排好（getFigures 里排的），
             * renderBody 直接按顺序插。
             */
            phase.kind === 'ready'
              ? phase.figures.filter((f) => f.page === seg.page)
              : [],
          )
        ) : null}
      </div>
    </div>
  );
}

/** 正文渲染：按需显示章节标题 + 高亮切分 + 插图 */
function renderBody(
  seg: SourceSegment,
  highlight: Highlight | null,
  markRef: RefObject<HTMLElement | null>,
  figures: readonly SourceImageRecord[],
) {
  const chapter = seg.chapter?.trim() ?? '';
  /*
   * 正文已经以章节标题开头 → 不再单独显示一遍。
   *
   * ⚠️ 比较前要把 Markdown 标记剥掉。正文现在是 Markdown 形式
   * （docx 与 MinerU 都写成 `# 第一章`），直接拿 `# 第一章` 去和
   * `第一章` 比 `startsWith` 永远为假，于是标题会被显示两遍 ——
   * 实测截图里就是这个症状（页面标题 + 章标题重复）。
   */
  const plainHead = seg.text
    .trimStart()
    .replace(/^#{1,6}\s+/, '');
  const showChapter = chapter.length > 0 && !plainHead.startsWith(chapter);

  return (
    <>
      {showChapter ? <h2 className="reader-chapter">{chapter}</h2> : null}
      {figures.length > 0
        ? renderWithFigures(seg.text, highlight, markRef, figures)
        : renderText(seg.text, highlight, markRef)}
      <p className="reader-meta">
        第 {seg.page} 页 · {seg.charCount} 字
        {figures.length > 0 ? ` · ${figures.length} 张插图` : ''}
      </p>
    </>
  );
}

/**
 * 有插图时渲染正文：把图按 charOffset 插回去（2026-11-08）。
 *
 * ## 为什么不能简单「切成几段各自渲染」
 *
 * 高亮是按**整段文本**的字符偏移算的（`highlight.start/end`）。
 * 如果先按图切段、再拿整段偏移去切每一小段，偏移就错了 ——
 * 第二段的 start 是相对整段的，不是相对那一小段。
 *
 * 这里的做法：走一遍切片，**同时维护绝对偏移游标**，
 * 每段文字用它在整段里的绝对区间，把 highlight 裁剪成局部区间。
 * 文字切片拼起来与原文逐字相同（images.ts 有单测守这条），
 * 所以偏移全程准确。
 *
 * ## 为什么复用 splitByFigures
 *
 * 切片逻辑已经有单测（images.ts 的 32 个用例），不重写一遍。
 * 但**偏移换算放在这里** —— 那是展示问题，不该塞进数据层。
 */
function renderWithFigures(
  text: string,
  highlight: Highlight | null,
  markRef: RefObject<HTMLElement | null>,
  figures: readonly SourceImageRecord[],
) {
  const pieces = splitByFigures(text, figures);
  const out: React.ReactNode[] = [];
  /** 当前文字切片在**整段**里的起始绝对偏移 */
  let cursor = 0;
  let key = 0;

  const hasHighlight =
    highlight !== null && highlight.via !== 'none' && highlight.end > highlight.start;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;

    if (piece.kind === 'figure') {
      /*
       * 图注去重（2026-11-08 实测发现）。
       *
       * MinerU 把图注**当正文文字**留在图后面（图片行本身被去掉，
       * 但「图1.1 含有电压源…」那句还在 text 里）。所以正文里
       * 本来就会显示一遍图注；如果这里再渲染一个 <figcaption>，
       * 同一句会出现两次 —— 我在补图后逐字对照切片时看到的就是这个。
       *
       * 修法上有个岔路，选了保守的那条：
       *  ❌ 把图注从 text 里删掉 → 文字一变，95 个知识点的字符偏移全错位
       *  ✅ 渲染时看后面那段文字是不是以图注开头，是就不重复渲染
       *
       * 代价是图注排版跟着正文走（不是居中小字）。这个代价可以接受 ——
       * 排版可以以后调，偏移错位是不可接受的。
       */
      const next = pieces[i + 1];
      const captionInBody =
        next !== undefined &&
        next.kind === 'text' &&
        piece.figure.caption !== null &&
        next.text.trimStart().startsWith(piece.figure.caption.trim());

      out.push(
        <ReaderFigure key={`fig-${key++}`} figure={piece.figure} hideCaption={captionInBody} />,
      );
      continue;
    }

    const slice = piece.text;
    const sliceStart = cursor;
    cursor += slice.length;

    if (!slice) continue;

    if (!hasHighlight) {
      out.push(<MarkdownBody key={`t-${key++}`} text={slice} />);
      continue;
    }

    /*
     * 把整段的 highlight 区间换算成这一小段里的局部区间。
     * 三种情况：完全在外面（不高亮）/ 部分重叠（只高亮重叠部分）/ 整段被包住。
     */
    const hitStart = Math.max(highlight!.start, sliceStart);
    const hitEnd = Math.min(highlight!.end, sliceStart + slice.length);

    if (hitEnd <= hitStart) {
      out.push(<MarkdownBody key={`t-${key++}`} text={slice} />);
      continue;
    }

    const localStart = hitStart - sliceStart;
    const localEnd = hitEnd - sliceStart;

    out.push(
      <p className="reader-para reader-para--marked" key={`t-${key++}`}>
        <MathText text={slice.slice(0, localStart)} />
        <mark
          className="reader-mark"
          ref={(el) => {
            // 高亮跨多个切片时，markRef 指向第一处（滚动定位用）
            if (el && !markRef.current) markRef.current = el;
          }}
        >
          <MathText text={slice.slice(localStart, localEnd)} />
        </mark>
        <MathText text={slice.slice(localEnd)} />
      </p>,
    );
  }

  return <>{out}</>;
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
  /*
   * 有高亮时走「切三段」的老路 —— 这条路径必须精确到字符偏移，
   * 不能掺 Markdown 解析，否则偏移会错位。
   *
   * 没有高亮时才做 Markdown 渲染：标题、列表、表格各自成元素，
   * 阅读器里才能看出原文档的层次（用户反馈过「格式乱」）。
   */
  if (!highlight || highlight.via === 'none' || highlight.end <= highlight.start) {
    return <MarkdownBody text={text} />;
  }

  const start = Math.max(0, Math.min(text.length, highlight.start));
  const end = Math.max(start, Math.min(text.length, highlight.end));

  const before = text.slice(0, start);
  const hit = text.slice(start, end);
  const after = text.slice(end);

  /*
   * 三段都要过 MathText。
   *
   * 为什么不能只渲染高亮那一段：一句「电压 $v_{s}$ 和电容器」里，
   * 公式可能在高亮范围之前或之后 —— 只渲染中间那段，两边还是源码。
   * 而高亮本身是按**字符偏移**算的，MathText 不改变字符数
   * （它只换展示方式），所以偏移仍然准确。
   */
  return (
    <p className="reader-para reader-para--marked">
      <MathText text={before} />
      <mark
        className="reader-mark"
        ref={(el) => {
          markRef.current = el;
        }}
      >
        <MathText text={hit} />
      </mark>
      <MathText text={after} />
    </p>
  );
}

/**
 * 把一段正文按 Markdown 的**最小子集**渲染成元素。
 *
 * ## 为什么只做这个子集
 *
 * 我们不需要一个完整的 Markdown 渲染器（表格、嵌套列表、引用、代码块…
 * 全上会让包体积涨一大截，而正文里出现的东西就那么几种）。真正需要
 * 让人一眼看出来的只有三样：
 *  - 标题（否则章节名和正文一样大，层次全丢）
 *  - 列表（否则几条并列的项目糊成一段）
 *  - 表格（否则单元格内容横向连成一片）
 *
 * ## 为什么不引 react-markdown
 *
 * 它连同 remark/unified 一整条链会把主包撑大 200KB+，而我们只需要
 * 上面三样。手写这 60 行换来的体积与可控性更划算 —— 尤其是我们必须
 * 保证渲染出来的文字与原文**完全一致**（锚点按字符偏移算）。
 */
function MarkdownBody({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let buffer: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join('\n').trim();
    if (joined) out.push(<p className="reader-para" key={key++}><MathText text={joined} /></p>);
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // 空行 → 结束当前段落
    if (trimmed === '') {
      flushPara();
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      const title = heading[2];
      const cls = `reader-md-h reader-md-h--${level}`;
      const titleNode = <MathText text={title} />;
      if (level === 1) out.push(<h1 className={cls} key={key++}>{titleNode}</h1>);
      else if (level === 2) out.push(<h2 className={cls} key={key++}>{titleNode}</h2>);
      else if (level === 3) out.push(<h3 className={cls} key={key++}>{titleNode}</h3>);
      else out.push(<h4 className={cls} key={key++}>{titleNode}</h4>);
      continue;
    }

    // Markdown 表格：连续的 | 开头行
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushPara();
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j]!.trim();
        if (!l.startsWith('|') || !l.endsWith('|')) break;
        // 分隔行 |---|---| 跳过
        if (!/^\|[\s:-]+\|/.test(l)) {
          rows.push(
            l
              .slice(1, -1)
              .split('|')
              .map((c) => c.trim().replace(/\\\|/g, '|')),
          );
        }
        j++;
      }
      i = j - 1;
      if (rows.length > 0) {
        const [head, ...body] = rows;
        out.push(
          <table className="reader-md-table" key={key++}>
            <thead>
              <tr>{head!.map((c, ci) => <th key={ci}><MathText text={c} /></th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}><MathText text={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>,
        );
      }
      continue;
    }

    // 列表
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j]!.trim();
        const b = /^([-*+])\s+(.*)$/.exec(l);
        const n = /^(\d+)[.)]\s+(.*)$/.exec(l);
        if (b) items.push(b[2]!);
        else if (n) items.push(n[2]!);
        else break;
        j++;
      }
      i = j - 1;
      if (numbered) {
        out.push(
          <ol className="reader-md-list" key={key++}>
            {items.map((it, ii) => <li key={ii}><MathText text={it} /></li>)}
          </ol>,
        );
      } else {
        out.push(
          <ul className="reader-md-list" key={key++}>
            {items.map((it, ii) => <li key={ii}><MathText text={it} /></li>)}
          </ul>,
        );
      }
      continue;
    }

    buffer.push(line);
  }

  flushPara();
  return <div className="reader-md">{out}</div>;
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
