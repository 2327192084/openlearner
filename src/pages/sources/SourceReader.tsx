import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScanNotice } from './ScanNotice.tsx';
import { Badge, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import type { Source, SourceSegment } from '@/core/model.ts';
import type { SearchHit } from '@/core/sources.ts';
import type { SourceService } from '@/core/sources.ts';
import type { BackendService } from '@/core/backends.ts';
import { HighlightedText } from './HighlightedText.tsx';
import type { HighlightRange } from './HighlightedText.tsx';
import {
  TEXT_STATUS_LABEL,
  formatPageCount,
  formatTime,
  hitLocationLabel,
  kindLabel,
} from './format.ts';
import { describeError } from './types.ts';

/**
 * 阅读器。
 *
 * 路由只有一个 `/sources`（注册表不支持子路由），所以「列表 ↔ 阅读器」
 * 是**同一个页面组件内部的状态切换**。这样做的额外好处是：从列表进阅读器、
 * 从阅读器退回列表，都不丢列表状态（滚动位置之外的筛选/课程都还在）。
 *
 * 三件事在这里必须做对：
 *  1. 目录与翻页的页码必须真实（来自 segment.page），不能靠数组下标猜；
 *  2. 搜索命中的高亮必须用 charStart/charEnd 精确切分（见 HighlightedText）；
 *  3. 扫描件不是错误，提示条要说清「能看、不能搜」以及后续版本怎么处理。
 */
export function SourceReader({
  source: initialSource,
  service,
  backends,
  onBack,
  onOpenDetail,
}: {
  source: Source;
  service: SourceService;
  backends: BackendService;
  onBack: () => void;
  /** 打开资料详情抽屉（详情里含删除入口） */
  onOpenDetail: () => void;
}) {
  /**
   * 本地的 source 副本。
   *
   * OCR 之后 textStatus 会从 no-text-layer 变成 ready —— 不改这份副本的话，
   * 识别完了提示条还在，用户会以为没成功。
   */
  const [source, setSource] = useState<Source>(initialSource);

  /**
   * 上层换了资料时同步过来。
   *
   * 只用 useState(initialSource) 的话，从一个扫描件切到另一个资料时
   * 提示条还停在上一份的状态 —— 用户会以为新打开的也是扫描件。
   */
  useEffect(() => {
    setSource(initialSource);
  }, [initialSource]);
  const [segmentsState, setSegmentsState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string; hint: string }
    | { kind: 'ready'; segments: SourceSegment[] }
  >({ kind: 'loading' });

  const [current, setCurrent] = useState(0);

  /**
   * 图片资料的预览地址。
   *
   * 图片的正文是空的（字在像素里，还没识别），所以正文区必须显示原图，
   * 否则用户打开一张图看到的是白板 —— 那会以为导入失败。
   *
   * 只在 kind === 'image' 时才去读原始字节：其它格式没有也不会去读，
   * 避免无谓地把几十 MB 的 PDF 拉进内存。
   */
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    if (source.kind !== 'image') {
      setImageUrl(null);
      setImageError(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const bytes = await service.getOriginalFile(source.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setImageError(
            '这张图片的原始数据不在本机。换过机器或从备份恢复过的资料需要重新导入一次。',
          );
          return;
        }
        const { toImageDataUrl } = await import('@/core/parsers/image.ts');
        if (cancelled) return;
        setImageUrl(toImageDataUrl(bytes));
      } catch (err) {
        if (cancelled) return;
        setImageError(err instanceof Error ? err.message : '读不出这张图片');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source.id, source.kind, service]);

  // ---- 搜索 ----
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<{ message: string; hint: string } | null>(null);
  /** 当前点击的命中，用于高亮与滚动 */
  const [activeHit, setActiveHit] = useState<SearchHit | null>(null);
  const activeMarkRef = useRef<HTMLElement | null>(null);

  /**
   * 扫描件（PDF 但没有文字层）的**页面图**。
   *
   * ## 为什么必须有这个
   *
   * 扫描件的正文是空字符串 —— 字在像素里。早先阅读器只渲染 `segment.text`，
   * 于是扫描件打开后是一片空白：用户看不到教材，也不知道为什么，
   * 只会以为「这软件打不开我的资料」。这是「资料库打不开图片资料」的根因。
   *
   * 现在按页把 PDF 渲染成图片显示。渲染走 `renderSourcePage`，
   * 与「插入原文页到 PPT」用的是同一份实现 —— 那条路径已验收过。
   *
   * 只在 `textStatus === 'no-text-layer'` 时渲染：有文字层的 PDF
   * 直接显示文字更清晰、更省内存，没必要渲染成图。
   */
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [pageImageState, setPageImageState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [pageImageError, setPageImageError] = useState<string | null>(null);

  const needsPageImage = source.kind === 'pdf' && source.textStatus === 'no-text-layer';

  /**
   * 当前页号与渲染 effect 都在 segments 声明之后（那里才拿得到 segments）。
   */

  /**
   * 只要不是 ready 就禁用搜索。
   * 早先只判 no-text-layer，导致新加的 decode-failed 状态下搜索框仍然可用，
   * 用户搜了没结果却不知道是编码问题。
   */
  const searchDisabled = source.textStatus !== 'ready';

  const load = useCallback(async () => {
    setSegmentsState({ kind: 'loading' });
    try {
      const segments = await service.getSegments(source.id);
      setSegmentsState({ kind: 'ready', segments });
      setCurrent(0);
    } catch (err) {
      setSegmentsState({
        kind: 'error',
        message: describeError(err),
        hint: '资料本身没有删。请返回列表再点进来一次；若仍然读不到，可能是本地存储异常。',
      });
    }
  }, [service, source.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const segments = segmentsState.kind === 'ready' ? segmentsState.segments : [];
  const segment = segments[current];

  /**
   * 当前页号（扫描件渲染用）。按 segment.page 取，不用数组下标 ——
   * 按章节切分的资料里两者不相等。
   */
  const currentPageNo =
    segments.length > 0
      ? (segments[Math.min(current, segments.length - 1)]?.page ?? 1)
      : 1;

  /**
   * 扫描件：把当前页渲染成图片。
   *
   * 扫描件的正文是空字符串（字在像素里），只渲染 text 的话打开就是白板。
   * 走 renderSourcePage，与「插入原文页到 PPT」同一份实现。
   * 只在 no-text-layer 时渲染：有文字层的 PDF 直接显示文字更清晰、更省内存。
   */
  useEffect(() => {
    if (!needsPageImage) {
      setPageImage(null);
      setPageImageState('idle');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setPageImageState('loading');
    setPageImage(null);
    setPageImageError(null);

    void (async () => {
      try {
        const bytes = await service.getOriginalFile(source.id);
        if (cancelled) return;
        if (!bytes || bytes.byteLength === 0) {
          setPageImageState('error');
          setPageImageError(
            '这份 PDF 的原始文件不在本机，没法渲染出页面图。换过机器或从备份恢复过的资料需要重新导入一次。',
          );
          return;
        }

        const { renderSourcePage } = await import('@/core/slides/source-page.ts');
        if (cancelled) return;
        const out = await renderSourcePage(bytes, currentPageNo, {
          targetWidth: 1200,
          signal: controller.signal,
        });
        if (cancelled) return;
        setPageImage(out.imageData);
        setPageImageState('idle');
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setPageImageState('error');
        setPageImageError(err instanceof Error ? err.message : '这一页渲染不出来');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [needsPageImage, source.id, currentPageNo, service]);

  const go = useCallback(
    (next: number) => {
      setCurrent((prev) => {
        const target = Math.max(0, Math.min(segments.length - 1, next));
        return target === prev ? prev : target;
      });
    },
    [segments.length],
  );

  /**
   * 键盘左右方向键翻页。
   *
   * 三道守卫，缺一个都会误伤：
   *  - 焦点在输入框/文本域里时不抢键（否则搜关键词时按左右键会翻页）；
   *  - 有修饰键时不抢（Ctrl+← 是「按词移动光标」）；
   *  - 有文本被选中时不抢。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      const el = e.target as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      if (window.getSelection()?.toString()) return;

      e.preventDefault();
      go(e.key === 'ArrowLeft' ? current - 1 : current + 1);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, go]);

  // 命中后把当前高亮滚进视野。用 scrollIntoView 而不是算 offsetTop：
  // 正文区滚动容器可能变（以后加侧栏），算偏移容易差一截。
  useEffect(() => {
    if (activeHit && activeMarkRef.current) {
      activeMarkRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeHit, current]);

  const runSearch = useCallback(async () => {
    const needle = query.trim();
    if (!needle || searchDisabled) return;

    setSearching(true);
    setSearchError(null);
    try {
      const found = await service.search(source.id, needle);
      setHits(found);
      setActiveHit(null);
      // 命中后自动翻到第一处，省掉「搜到了还要自己找哪一页」
      if (found.length > 0) {
        const idx = segments.findIndex((s) => s.id === found[0].segmentId);
        if (idx >= 0) setCurrent(idx);
      }
    } catch (err) {
      setHits(null);
      setSearchError({
        message: describeError(err),
        hint: '这次搜索没有改到资料内容。可以退回列表再进来重试；若持续失败，换一个关键词试试。',
      });
    } finally {
      setSearching(false);
    }
  }, [query, searchDisabled, service, source.id, segments]);

  const jumpToHit = (hit: SearchHit) => {
    const idx = segments.findIndex((s) => s.id === hit.segmentId);
    if (idx >= 0) setCurrent(idx);
    setActiveHit(hit);
  };

  const clearSearch = () => {
    setQuery('');
    setHits(null);
    setActiveHit(null);
    setSearchError(null);
  };

  /** 当前页的高亮范围：只取与本段相交的命中 */
  const highlightRanges: HighlightRange[] = useMemo(() => {
    if (!hits || !segment) return [];
    const direct = hits.filter((h) => h.segmentId === segment.id);
    if (direct.length > 0) {
      return direct.map((h) => ({ charStart: h.charStart, charEnd: h.charEnd }));
    }
    return [];
  }, [hits, segment]);

  if (segmentsState.kind === 'loading') {
    return <LoadingState label={`正在打开「${source.title}」…`} />;
  }

  if (segmentsState.kind === 'error') {
    return (
      <ErrorState
        title="读不出这份资料的正文"
        message={segmentsState.message}
        hint={segmentsState.hint}
        onRetry={() => void load()}
      />
    );
  }

  if (segments.length === 0) {
    return (
      <div className="page page__stack">
        <ReaderHeader source={source} onBack={onBack} onOpenDetail={onOpenDetail} />
        <ErrorState
          title="这份资料没有可显示的段落"
          message="库里存在这份资料的记录，但切分出的正文是空的。"
          hint="可以删除后重新导入一次；如果重新导入仍然是 0 段，说明原文件本身没有可提取的文本。"
        />
      </div>
    );
  }

  return (
    <div className="reader">
      <ReaderHeader source={source} onBack={onBack} onOpenDetail={onOpenDetail} />

      {/*
        两种「读不出字」必须说不同的话：
          - 扫描件：文件里本来就没字，用户该换电子版 / 等 OCR
          - 解码失败：文件里有字，是我们没解开，该我们修
        早先统一写成「这是扫描件」，对后者是错误结论。
      */}
      {searchDisabled ? (
        <ScanNotice
          source={source}
          hint={TEXT_STATUS_LABEL[source.textStatus].hint}
          sources={service}
          backends={backends}
          onDone={() => {
            // 重新读一次资料与分段：状态变了，正文也换成了识别结果
            void (async () => {
              const fresh = await service.get(source.id);
              if (fresh) setSource(fresh);
              // load 读的是 source.id，同一个资料，直接重读即可
              await load();
            })();
          }}
        />
      ) : null}

      <div className="reader__layout">
        {/* ---------- 左：目录 ---------- */}
        <aside className="reader__toc" aria-label="目录">
          <div className="reader__toc-head">
            <span>目录</span>
            <span className="page__muted">
              {segments.length} {source.pageCount !== null ? '页' : '段'}
            </span>
          </div>
          <ol className="reader__toc-list">
            {segments.map((seg, i) => (
              <li key={seg.id}>
                <button
                  type="button"
                  className={`reader__toc-item${i === current ? ' reader__toc-item--active' : ''}`}
                  onClick={() => go(i)}
                  aria-current={i === current ? 'true' : undefined}
                >
                  <span className="reader__toc-index">{i + 1}</span>
                  <span className="reader__toc-label">{seg.chapter ?? `第 ${seg.page} 页`}</span>
                  {hits?.some((h) => h.segmentId === seg.id) ? (
                    <span className="reader__toc-hit" aria-label="此页有搜索命中" />
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </aside>

        {/* ---------- 右：正文 ---------- */}
        <div className="reader__main">
          <div className="reader__pager">
            <div className="reader__pager-info">
              <strong>
                第 {segment.page} / {segments.length} 页
              </strong>
              <span className="page__muted">段 {current + 1} / {segments.length}</span>
              {segment.chapter ? <Badge tone="neutral">{segment.chapter}</Badge> : null}
              <span className="page__muted">{segment.charCount} 字</span>
            </div>
            <div className="page__row" style={{ flex: 'none' }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(current - 1)}
                disabled={current === 0}
                title="上一页（←）"
              >
                ← 上一页
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(current + 1)}
                disabled={current >= segments.length - 1}
                title="下一页（→）"
              >
                下一页 →
              </button>
            </div>
          </div>

          {/* ---------- 搜索 ---------- */}
          <div className="reader__search">
            <form
              className="reader__search-form"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
            >
              <input
                className="input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchDisabled ? '扫描件没有文字层，无法搜索' : '搜索本文关键词，回车开始'}
                disabled={searchDisabled || searching}
                aria-label="全文搜索"
              />
              <button
                type="submit"
                className="btn btn--primary"
                disabled={searchDisabled || searching || query.trim() === ''}
              >
                {searching ? '搜索中…' : '搜索'}
              </button>
              {hits !== null ? (
                <button type="button" className="btn" onClick={clearSearch}>
                  清除
                </button>
              ) : null}
            </form>

            {searchError ? (
              <Notice tone="danger" title="搜索没有完成">
                {searchError.message}
                <br />
                <strong>下一步：</strong>
                {searchError.hint}
              </Notice>
            ) : null}

            {hits !== null ? (
              hits.length === 0 ? (
                <div className="reader__hits-empty">
                  没找到「{query.trim()}」。可以试试更短的关键词——整句搜不到时，
                  换成其中三五个字通常能命中。
                </div>
              ) : (
                <div className="reader__hits">
                  <div className="reader__hits-head">
                    找到 {hits.length} 处，点击跳到那一页
                    {hits.length > 200 ? '（只列出前 200 处）' : ''}
                  </div>
                  <ul className="reader__hits-list">
                    {hits.slice(0, 200).map((hit, i) => (
                      <li key={`${hit.segmentId}-${hit.charStart}-${i}`}>
                        <button
                          type="button"
                          className={`reader__hit${
                            activeHit === hit ? ' reader__hit--active' : ''
                          }`}
                          onClick={() => jumpToHit(hit)}
                        >
                          <span className="reader__hit-page">
                            {hitLocationLabel(hit.page, hit.chapter)}
                          </span>
                          <span className="reader__hit-snippet">{hit.snippet}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : null}
          </div>

          {/* ---------- 正文 ---------- */}
          <article className="reader__body" tabIndex={0} aria-label="正文">
            {/*
              图片资料：正文是空的（字在像素里），所以显示原图本身。
              识别成功后正文会被写回，那时图片和文字一起显示 ——
              用户能对照着看识别得对不对。
            */}
            {source.kind === 'image' ? (
              imageError ? (
                <Notice tone="warning" title="看不到这张图片">
                  {imageError}
                </Notice>
              ) : imageUrl ? (
                <figure className="reader__figure">
                  <img src={imageUrl} alt={source.title} className="reader__image" />
                  <figcaption className="page__muted">
                    {source.textStatus === 'ready'
                      ? '这张图已经识别出文字，下方正文可与原图对照。'
                      : '这是一张图片资料。识别成文字后才能搜索、出题和做 PPT。'}
                  </figcaption>
                </figure>
              ) : (
                <div className="page__muted">正在打开图片…</div>
              )
            ) : null}

            {/*
              扫描件（PDF 无文字层）：正文是空的，必须把原页渲染成图显示。
              不显示的话，用户打开教材只看到一片空白 —— 那正是
              「资料库打不开我的资料」这个反馈的根因。
            */}
            {needsPageImage ? (
              pageImageState === 'error' ? (
                <Notice tone="warning" title="这一页显示不出来">
                  {pageImageError}
                </Notice>
              ) : pageImage ? (
                <figure className="reader__figure">
                  <img
                    src={pageImage}
                    alt={`${source.title} 第 ${currentPageNo} 页`}
                    className="reader__image"
                  />
                  <figcaption className="page__muted">
                    第 {currentPageNo} 页原图。这是扫描件，文字在图片里 ——
                    可以用上方的「识别」把它转成可搜索的正文。
                  </figcaption>
                </figure>
              ) : (
                <div className="page__muted">正在渲染第 {currentPageNo} 页…</div>
              )
            ) : null}

            <HighlightedText
              text={segment.text}
              ranges={highlightRanges}
              active={
                activeHit && activeHit.segmentId === segment.id
                  ? { charStart: activeHit.charStart, charEnd: activeHit.charEnd }
                  : null
              }
              activeRef={(el) => {
                activeMarkRef.current = el;
              }}
            />

            {/*
              图片且还没识别：正文区没有字可读，明说下一步该点哪里，
              而不是留一片空白让用户以为坏了。
            */}
            {source.kind === 'image' && source.textStatus !== 'ready' ? (
              <p className="page__muted">
                这张图还没有文字。用上方的「识别」把图里的字读出来，
                之后就能搜索、出题、做 PPT。
              </p>
            ) : null}
          </article>

          <div className="reader__foot">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => go(current - 1)}
              disabled={current === 0}
            >
              ← 上一页
            </button>
            <span className="page__muted">方向键 ← → 也能翻页</span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => go(current + 1)}
              disabled={current >= segments.length - 1}
            >
              下一页 →
            </button>
          </div>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        当前第 {segment.page} 页，共 {segments.length} 页
      </p>
    </div>
  );
}

function ReaderHeader({
  source,
  onBack,
  onOpenDetail,
}: {
  source: Source;
  onBack: () => void;
  onOpenDetail: () => void;
}) {
  const status = TEXT_STATUS_LABEL[source.textStatus];
  return (
    <header className="reader__head">
      <button type="button" className="btn btn--sm" onClick={onBack}>
        ← 返回资料库
      </button>
      <div className="reader__head-main">
        <h2 className="page__title">{source.title}</h2>
        <div className="reader__head-meta">
          <Badge tone="neutral">{kindLabel(source.kind)}</Badge>
          <Badge tone={status.tone}>{status.text}</Badge>
          <span className="page__muted">
            {formatPageCount(source.pageCount)} · {source.segmentCount} 段 · 导入于{' '}
            {formatTime(source.createdAt)}
          </span>
        </div>
      </div>
      <button type="button" className="btn btn--sm" onClick={onOpenDetail}>
        资料详情
      </button>
    </header>
  );
}
