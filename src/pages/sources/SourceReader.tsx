import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { AnnotationLayer } from './AnnotationLayer.tsx';
import { AnnotatedBox } from './AnnotatedBox.tsx';
import { TextMarkLayer } from './TextMarkLayer.tsx';
import { SelectionToolbar } from './SelectionToolbar.tsx';
import { NotesPanel } from './NotesPanel.tsx';
import type { TextMark } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';

/** 缩放的步进与上下限。上限 3 倍够看清小字，再大会因位图放大而糊 */
const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const clampZoom = (z: number): number => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
import type { Source, SourceSegment } from '@/core/model.ts';
import type { SearchHit } from '@/core/sources.ts';
import type { SourceService } from '@/core/sources.ts';
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
  onBack,
  onOpenDetail,
}: {
  source: Source;
  service: SourceService;
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

  /** 页码输入框的值（独立受控：边输边跳会来回闪） */
  const [pageInput, setPageInput] = useState('1');

  /** 页面缩放。1 = 适应宽度；只对渲染出的页面图有效 */
  const [zoom, setZoom] = useState(1);


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

  /**
   * 原始 PDF 字节的缓存（按资料 id）。
   *
   * 为什么必须有：这份教材 45MB，而扫描件翻页要逐页渲染。
   * 每次翻页都去 IndexedDB 读 45MB 会让翻页卡死 ——
   * 实测 628 页的资料翻到第 3 页就再也出不来图。
   *
   * 用 ref 而不是 state：它是纯缓存，变化不该触发重渲染。
   */
  const pdfBytesCache = useRef<{ sourceId: string; bytes: Uint8Array } | null>(null);

  /** 注释服务与「哪些页有笔记」的标记 */
  const { annotations } = useServices();
  const [annotatedPages, setAnnotatedPages] = useState<Set<number>>(new Set());

  /**
   * 量页面图的实际显示尺寸。
   *
   * 直接用 getBoundingClientRect 而不是 clientWidth/Height：
   * clientWidth 取的是布局值，在有缩放/边界框时可能取整偏差；
   * getBoundingClientRect 给的是真实渲染尺寸，更准。
   */
  const measurePageBox = useCallback((img: HTMLImageElement) => {
    const r = img.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      setPageBoxSize({ width: Math.round(r.width), height: Math.round(r.height) });
    }
  }, []);

  /** 页面图渲染后的实际显示尺寸，注释坐标按它换算 */
  const pageBoxRef = useRef<HTMLDivElement | null>(null);
  const [pageBoxSize, setPageBoxSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  /** 重新统计有笔记的页（保存/清空后调用） */
  const refreshAnnotationPages = useCallback(async () => {
    try {
      const all = await annotations.listForSource(source.id);
      const { pagesWithAnnotations } = await import('@/core/annotations.ts');
      setAnnotatedPages(pagesWithAnnotations(all));
    } catch {
      setAnnotatedPages(new Set());
    }
  }, [annotations, source.id]);

  useEffect(() => {
    void refreshAnnotationPages();
  }, [refreshAnnotationPages]);

  /**
   * 缩放或窗口尺寸变化后重测页面图尺寸。
   *
   * 不重测的话：放大到 150% 后图片变大了，但注释层还按旧尺寸换算，
   * 笔迹会整体缩小并偏到左上角 —— 看起来像"注释漂移了"。
   */
  useEffect(() => {
    const img = pageBoxRef.current?.querySelector('img');
    if (!img) return;
    measurePageBox(img);

    const onResize = () => measurePageBox(img);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [zoom, pageImage, measurePageBox]);


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
   * 跳转到输入的页码。
   *
   * 做范围夹取而不是报错：用户输 999 时最可能是想「翻到最后」，
   * 弹一句「页码超出范围」再让他自己改，比直接跳到底更烦。
   * 非数字或空则回到当前页。
   */
  const jumpToTyped = useCallback(() => {
    const n = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(n)) {
      setPageInput(String(current + 1));
      return;
    }
    const idx = Math.min(Math.max(n, 1), segments.length) - 1;
    setCurrent(idx);
    setPageInput(String(idx + 1));
  }, [pageInput, current, segments.length]);

  /**
   * 这一页要不要渲染成图片 —— 判据是**这一页有没有正文**，不是资料的整体状态。
   *
   * ⚠️ 这里曾经写成 `textStatus === 'no-text-layer'`，是个错误判断：
   * 扫描件一旦被 OCR 过，整体状态就变成 'ready'，于是整份资料再也不渲染图。
   * 但 OCR 往往只识别了前几页 —— 结果是第 1、2 页有文字，第 3 页起一片空白。
   * 用户看到的就是「只能看前两页」，而资料明明有 628 页。
   *
   * 「有没有文字层」和「这一页该显示什么」是两件事：
   *   - 该页有正文 → 显示文字（更清晰、更省内存）
   *   - 该页没正文 → 显示页面图（否则翻到那里就是白板）
   */
  /**
   * PDF 一律显示**原页**，不看有没有文字层。
   *
   * ## 为什么改成这样（2026-11-06 方向调整）
   *
   * 用户要的是「像 Obsidian 打开 PDF 一样，看到文件原本的样子」。
   * 之前的逻辑是「有文字就显示文字、没文字才渲染图」，那是把 PDF
   * 当成文本资料在处理 —— 排版、图表、公式位置全丢了。
   *
   * 现在的规则简单且一致：
   *   - PDF    → 永远渲染当前页的原图（所见即文件本身）
   *   - 图片   → 直接显示原图
   *   - 文档类 → 显示提取出的文字（docx/pptx/md/txt 没有可渲染的页面）
   *
   * 文字层仍然有用：有文字层时搜索可用，且正文可作为无障碍阅读的文本。
   * 但那不影响「显示什么」这个决定。
   */
  const needsPageImage = source.kind === 'pdf' && segments.length > 0;

  /**
   * 文字类资料 —— 用文字渲染正文，并在其上挂批注。
   *
   * 判据是「这一页有没有正文可读」：
   *  - docx / markdown / text 一律是文字
   *  - 有文字层的 PDF 也是文字（这时不渲染页面图）
   *  - 扫描件（无文字层）不在此列，它显示的是页面图，批注挂在图上
   */
  const isTextDocument =
    source.kind !== 'image' && !needsPageImage && (segment?.text ?? '').trim().length > 0;

  /**
   * 当前页号（扫描件渲染用）。按 segment.page 取，不用数组下标 ——
   * 按章节切分的资料里两者不相等。
   */
  const currentPageNo =
    segments.length > 0
      ? (segments[Math.min(current, segments.length - 1)]?.page ?? 1)
      : 1;

  // ---- 文本标记（高亮 / 下划线 / 删除线） ----
  /** 文字容器引用：标记层与选中工具条都靠它定位 */
  const textBoxRef = useRef<HTMLDivElement | null>(null);
  /** 当前页的文本标记 */
  const [textMarks, setTextMarks] = useState<TextMark[]>([]);
  /** 备注合集面板 */
  const [notesOpen, setNotesOpen] = useState(false);
  /** 保存后自增，让备注面板重新统计 */
  const [notesRevision, setNotesRevision] = useState(0);

  /**
   * 载入当前页的文本标记。
   *
   * 翻页、保存后都要重读：否则用户加了高亮、翻走再回来就看不到了。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ann = await annotations.get(source.id, currentPageNo);
      if (cancelled) return;
      setTextMarks(ann?.textMarks ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [annotations, source.id, currentPageNo, notesRevision]);

  /** 新建一条文本标记 */
  const createMark = useCallback(
    async (mark: TextMark) => {
      await annotations.addTextMark(source.id, currentPageNo, mark);
      const ann = await annotations.get(source.id, currentPageNo);
      setTextMarks(ann?.textMarks ?? []);
      setNotesRevision((n) => n + 1);
      void refreshAnnotationPages();
    },
    [annotations, source.id, currentPageNo, refreshAnnotationPages],
  );

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
        // 先看缓存：45MB 的 PDF 每次翻页都重读会让翻页卡死
        let bytes = pdfBytesCache.current?.sourceId === source.id
          ? pdfBytesCache.current.bytes
          : null;
        if (!bytes) {
          const loaded = await service.getOriginalFile(source.id);
          if (cancelled) return;
          if (!loaded || loaded.byteLength === 0) {
            setPageImageState('error');
            setPageImageError(
              '这份 PDF 的原始文件不在本机，没法渲染出页面图。换过机器或从备份恢复过的资料需要重新导入一次。',
            );
            return;
          }
          bytes = loaded;
          pdfBytesCache.current = { sourceId: source.id, bytes };
        }
        if (cancelled) return;

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

  /**
   * 翻页后同步输入框。
   *
   * 不同步的话，点「下一页」翻到第 5 页，输入框还写着 1，
   * 用户再按回车会莫名跳回第 1 页。
   */
  useEffect(() => {
    setPageInput(String(current + 1));
  }, [current]);

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
        <ReaderHeader
          source={source}
          onBack={onBack}
          onOpenDetail={onOpenDetail}
          onToggleNotes={() => setNotesOpen((v) => !v)}
          notesOpen={notesOpen}
          noteCount={0}
        />
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
      <ReaderHeader
        source={source}
        onBack={onBack}
        onOpenDetail={onOpenDetail}
        onToggleNotes={() => setNotesOpen((v) => !v)}
        notesOpen={notesOpen}
        noteCount={annotatedPages.size}
      />

      {/*
        备注合集：按页汇总这份资料的全部标记与手写笔记，点击跳转。
        复习时「我当初标了什么」是核心诉求，散在 628 页里找不到。
      */}
      <NotesPanel
        sourceId={source.id}
        service={annotations}
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        onJump={(p) => {
          const idx = segments.findIndex((seg) => seg.page === p);
          if (idx >= 0) setCurrent(idx);
          setNotesOpen(false);
        }}
        revision={notesRevision}
      />

      {/*
        没有文字层时只说明「能看、不能搜」，**不再提供 OCR 入口**。
        资料库的定位是「看到文件本来的样子」，把扫描件转成文字是另一件事，
        不该混在阅读界面里（2026-11-06 按用户要求摘除）。

        两种「读不出字」仍要说不同的话：
          - 扫描件：文件里本来就没字，这是正常状态，翻页看图即可
          - 解码失败：文件里有字但我们没解开，该我们修
        早先统一写成「这是扫描件」，对后者是错误结论。
      */}
      {searchDisabled ? (
        <Notice
          tone={source.textStatus === 'decode-failed' ? 'danger' : 'info'}
          title={
            source.textStatus === 'decode-failed'
              ? '这份资料有文字，但没能解析出来'
              : '这份资料的内容是图片，可以直接查看'
          }
        >
          {TEXT_STATUS_LABEL[source.textStatus].hint}
          <br />
          搜索栏已停用；翻页可以正常查看每一页的原样内容。
        </Notice>
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
                  {/* 有手写笔记的页在目录里打点，否则用户不知道哪几页做过标注 */}
                  {annotatedPages.has(seg.page) ? (
                    <span className="reader__toc-note" title="此页有笔记" aria-label="此页有笔记" />
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
            <div className="page__row" style={{ flex: 'none', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(0)}
                disabled={current === 0}
                title="第一页（Ctrl+Home）"
                aria-label="第一页"
              >
                ⇤
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(current - 1)}
                disabled={current === 0}
                title="上一页（←）"
              >
                ← 上一页
              </button>

              {/*
                页码跳转。628 页的教材只靠「上一页/下一页」翻不现实，
                输入页码直接跳是最省事的定位方式。
                输入框独立受控，回车或失焦才跳 —— 边输边跳会在输「30」
                的中途先跳到第 3 页，来回闪。
              */}
              <form
                className="reader__jump"
                onSubmit={(e) => {
                  e.preventDefault();
                  jumpToTyped();
                }}
              >
                <input
                  className="input input--tiny"
                  type="number"
                  min={1}
                  max={segments.length}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={jumpToTyped}
                  aria-label="输入页码跳转"
                  title="输入页码后回车跳转"
                />
                <span className="page__muted">/ {segments.length}</span>
              </form>

              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(current + 1)}
                disabled={current >= segments.length - 1}
                title="下一页（→）"
              >
                下一页 →
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => go(segments.length - 1)}
                disabled={current >= segments.length - 1}
                title="最后一页（Ctrl+End）"
                aria-label="最后一页"
              >
                ⇥
              </button>

              {/*
                缩放：只对渲染出来的页面图有效（文字资料不需要）。
                用按钮而不是滚轮缩放，避免和页面滚动冲突。
              */}
              <span style={{ width: 8 }} />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
                disabled={zoom <= MIN_ZOOM}
                title="缩小"
                aria-label="缩小"
              >
                −
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setZoom(1)}
                title="恢复原始大小"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                disabled={zoom >= MAX_ZOOM}
                title="放大"
                aria-label="放大"
              >
                +
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
                    这是图片资料的原图，按实际尺寸显示。
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
                  {/*
                    页面图与注释层叠在一起：注释层绝对定位覆盖在图上，
                    共用同一套比例坐标系，所以缩放后注释仍落在原位。
                    measured 是渲染后的实际尺寸，注释坐标按它换算。
                  */}
                  <div className="reader__page-box" ref={pageBoxRef}>
                    <img
                      src={pageImage}
                      alt={`${source.title} 第 ${currentPageNo} 页`}
                      className="reader__image"
                      /*
                        缩放用宽度而不是 transform: scale()。
                        transform 只是视觉放大，布局高度不变 —— 放大了却滚不到
                        下半页，且超出部分被容器裁掉。改宽度才真的占位。
                      */
                      style={{ width: `${zoom * 100}%` }}
                      /*
                        量图的实际显示尺寸给注释层换算用。
                        onLoad 只触发一次，而缩放/窗口变化会改尺寸，
                        所以另有一个 effect 负责重测（见下方的 measure）。
                      */
                      onLoad={(e) => measurePageBox(e.currentTarget)}
                    />
                    {pageBoxSize.width > 0 ? (
                      <AnnotationLayer
                        sourceId={source.id}
                        page={currentPageNo}
                        width={pageBoxSize.width}
                        height={pageBoxSize.height}
                        service={annotations}
                        onChange={() => {
                          // 目录上的「有笔记」标记要跟着更新
                          void refreshAnnotationPages();
                        }}
                      />
                    ) : null}
                  </div>
                  <figcaption className="page__muted">
                    第 {currentPageNo} 页原图。可以用上方的画笔和文本框在这一页上做标注，
                    标注会保存在本机，下次打开还在。
                  </figcaption>
                </figure>
              ) : (
                <div className="page__muted">正在渲染第 {currentPageNo} 页…</div>
              )
            ) : null}

            {/*
              文字资料（docx / markdown / 纯文本 / 有文字层的 PDF 页）
              也支持批注：把正文本身当成"一块页面"，批注画布覆盖在文字上方。

              为什么不在 PDF 页面图上也走这条路径：那边已经有明确的页面边界
              与尺寸（渲染出来的图），用 AnnotatedBox 反而多一层测量。
            */}
            {isTextDocument ? (
              /*
                ⚠️ 结构很关键：TreeWalker 只能扫到「文字本身」。
                早先工具条与标记层都放在同一个容器里，它们的按钮文字
                （「高亮」「下划线」「删除线」）被算进文本节点，
                算出来的字符偏移整整偏移了 12 个字 ——
                describeTextAnchor 拿到错位区间，锚点建不起来，
                表现就是「点了高亮什么都没发生」。

                现在分两层：
                  mark-host   只承载浮层（标记层、工具条），不含正文
                  mark-text  只装正文，TreeWalker 扫这一层
              */
              <div className="mark-host">
                <div ref={textBoxRef} className="mark-text">
                  <AnnotatedBox
                    sourceId={source.id}
                    page={currentPageNo}
                    service={annotations}
                    onChange={() => void refreshAnnotationPages()}
                  >
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
                  </AnnotatedBox>
                </div>
                <TextMarkLayer
                  fullText={segment.text}
                  marks={textMarks}
                  containerRef={textBoxRef}
                />
                <SelectionToolbar
                  containerRef={textBoxRef}
                  fullText={segment.text}
                  page={currentPageNo}
                  onCreate={(m) => void createMark(m)}
                />
              </div>
            ) : (
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
            )}

            {/*
              图片且还没识别：正文区没有字可读，明说下一步该点哪里，
              而不是留一片空白让用户以为坏了。
            */}
            {source.kind === 'image' && source.textStatus !== 'ready' ? (
              <p className="page__muted">
                图片资料按原样显示。图里的文字无法直接搜索，需要的话可以另存一份带文字的版本。
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
  onToggleNotes,
  notesOpen,
  noteCount,
}: {
  source: Source;
  onBack: () => void;
  onOpenDetail: () => void;
  onToggleNotes: () => void;
  notesOpen: boolean;
  noteCount: number;
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
      {/*
        备注合集入口。放在资料详情旁边而不是藏进菜单：
        复习时「看我标过什么」是高频动作，多一步就明显变累。
        按钮上带数量，让用户知道里面有没有东西。
      */}
      <button
        type="button"
        className={`btn btn--sm${notesOpen ? ' btn--primary' : ''}`}
        onClick={onToggleNotes}
        title="查看这份资料的全部标记与笔记"
      >
        备注{noteCount > 0 ? ` · ${noteCount}` : ''}
      </button>
      <button type="button" className="btn btn--sm" onClick={onOpenDetail}>
        资料详情
      </button>
    </header>
  );
}
