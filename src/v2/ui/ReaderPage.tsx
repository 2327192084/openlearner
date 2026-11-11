import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type {
  Source,
  SourceImageRecord,
  SourceSegment,
  TextMark,
  TextMarkKind,
} from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
import type { PassageSelection } from '@/core/selection-passage.ts';
import { locateSelection, passageToMaterial } from '@/core/selection-passage.ts';
import type { OralMaterial } from '@/core/oral-review.ts';
import { newId } from '@/core/id.ts';
import { isWholePageNote } from '@/core/text-anchor.ts';
import { IconSources } from './icons.tsx';
import { ReaderFigure } from './ReaderFigure.tsx';
import { ReaderSidePanel } from './ReaderSidePanel.tsx';
import { MarkdownBodyMarked } from './MarkdownBodyMarked.tsx';
import { paintTextMarks, clearTextMarks } from './paint-marks.ts';
import { SelectionActionBar, measureSelectionRect } from './SelectionActionBar.tsx';
import type { RectLike } from './selection-bar-place.ts';
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
  /**
   * 批注服务（2026-11-09）。
   *
   * 可选：不传就只是没有批注功能（侧栏「批注」页仍会显示，
   * 但加标记按钮点了不会存）。传了才有真正的读写。
   * 做成可选是为了让测试与「只看正文」的场景不必构造它。
   */
  annotations?: AnnotationService;
  /** 要打开的资料；null 表示还没选 */
  initialSourceId: string | null;
  /** 要定位到的位置；null 表示只是打开来读 */
  target: ReaderTarget | null;
  /**
   * 返回按钮上写哪一页（2026-11-09）。
   *
   * 不传就写「返回资料」。传了写「返回错题与待巩固」这种具体页名 ——
   * 用户从错题跳进来最怕「返回后不知道自己在哪」。
   */
  backLabel?: string;
  /**
   * 「用这段提问」（2026-11-10）。
   *
   * 用户在正文里选中一段后，浮层上的按钮调它，参数是**已经拼好的素材**
   * （在 ReaderPage 里拼，因为要这一段的完整正文来给短选区扩上下文 ——
   * 见 handleAskAboutSelection 的注释）。阅读器不知道提问怎么问、
   * 谁来问，它只知道「用户选了这段，想拿它提问」。
   *
   * 可选：不传就不显示浮层。这保证「没接 AI」的场景下
   * 不会冒出一个点了没反应的按钮（硬约束第 7 条：不做假开关）。
   */
  onAskAboutSelection?: (material: OralMaterial) => void;
  /** 不能提问的原因；有值就把按钮禁用并显示原因 */
  askDisabledReason?: string | null;
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

/**
 * 「锚点覆盖整段」的判定阈值（2026-11-09）。
 *
 * `segmentsToMaterials` 给「从原文出题」的锚点是 `charStart=0 /
 * charEnd=整段长度`。这种范围不该在高亮里当普通区间画出来 ——
 * 那会把整页刷亮，看着像界面坏了。
 *
 * 0.8 而不是 1.0：`charEnd` 用的是 `text.trim().length`，而 seg.text
 * 可能带首尾空白，两者不完全相等。留余量避免漏判。
 */
const WHOLE_SEGMENT_RATIO = 0.8;

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

export function ReaderPage({
  sourceService,
  annotations,
  initialSourceId,
  target,
  backLabel,
  onAskAboutSelection,
  askDisabledReason,
  onBack,
}: ReaderPageProps) {
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
   * 批注状态（2026-11-09）。
   *
   * `pageMarks` 是**当前页**的标记。不把所有页的都载进来：
   * 一本几百页的书全量载入既慢又没必要，标记天然按页归属。
   */
  const [pageMarks, setPageMarks] = useState<TextMark[]>([]);
  /** 正文里当前选中的文字（空串 = 没选中）。决定「加标记」按钮是否可用 */
  const [selectionText, setSelectionText] = useState('');
  /**
   * 选区的视口矩形（2026-11-10）。
   *
   * 与 selectionText 分开放：文字用于判断「有没有选」，
   * 矩形用于定位浮层。两者一起变化，但消费方不同
   * （浮层要矩形，右栏要布尔）。
   */
  const [selectionRect, setSelectionRect] = useState<RectLike | null>(null);

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

    /*
     * 「整段锚点」不该整页刷亮（2026-11-09 修）。
     *
     * 「从原文出题」的锚点是 `charStart=0 / charEnd=整段长度` ——
     * 它表示「这道题出自这一段」，不是「这整段都是重点」。
     * 以前把它当普通偏移处理，用户从错题跳过来看到的是**满屏高亮**，
     * 像界面坏了（用户实测反馈：「整个页面都是高光，这有点抽象」）。
     *
     * 现在：跨度接近整段时**不画高亮**，只靠跳页 + 上方那句
     * 「这道题从原文整段出的，点一下到第 N 页看完整上下文」说明位置。
     * 整段落高亮不传递任何信息，只制造视觉噪音。
     */
    const csRaw = target.charStart;
    const ceRaw = target.charEnd;
    const spanIsWholeSegment =
      typeof csRaw === 'number' &&
      typeof ceRaw === 'number' &&
      text.length > 0 &&
      ceRaw - csRaw >= text.length * WHOLE_SEGMENT_RATIO;

    // 1) 先试偏移。这是最可靠的：偏移是从这份正文里实测出来的。
    const cs = target.charStart;
    const ce = target.charEnd;
    if (
      !spanIsWholeSegment &&
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

    /*
     * 3) 整段锚点：不画高亮，但要**说清为什么**（2026-11-09）。
     *
     * 静默什么都不做会让用户以为定位失败。这里明确告诉他：
     * 题是从这一整段出的，不是某一句。
     */
    if (spanIsWholeSegment) {
      setHighlight({ start: 0, end: 0, via: 'none' });
      setJumpNote(
        `这道题出自第 ${seg.page} 页的整段内容（不是某一句），所以不单独高亮。`,
      );
      return;
    }

    // 4) 都没找到 —— 只显示页码，明说没定位到
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

  /*
   * 当前资料的 id。
   *
   * 不能等 ready 分支里解构出的 `source` —— 那些 effect / 回调
   * 写在解构之前（它们在渲染的全部路径上都要成立）。
   * 这里从 phase 直接取，未 ready 时是 null。
   */
  const sourceId = phase.kind === 'ready' ? phase.source.id : null;

  /**
   * 翻页或换资料时重新载入这一页的标记。
   *
   * 依赖 seg.id 而不是 pageNo：换了资料但页码相同时，
   * pageNo 没变，光看它不会重新载入 —— 那就把上一本书的标记显示了。
   */
  useEffect(() => {
    if (!annotations || !sourceId || !seg) {
      setPageMarks([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rec = await annotations.get(sourceId, seg.page);
        if (!cancelled) setPageMarks(rec?.textMarks ?? []);
      } catch {
        if (!cancelled) setPageMarks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [annotations, sourceId, seg]);

  /**
   * 跟踪「正文里有没有选中文字」。
   *
   * ## 为什么用 document 级的 selectionchange
   *
   * 第一版挂在 bodyRef 的 mouseup/keyup 上，依赖写成 `[]`。
   * 问题：effect 首次执行时还在 loading，`bodyRef.current` 是 null，
   * 直接 return —— 等正文渲染出来，监听器**再也没绑上**。
   * 表现是「选中了字，加标记按钮仍然是灰的」，实测确认。
   *
   * selectionchange 是文档级事件，不依赖容器何时出现，
   * 也不会因为翻页换 DOM 而失效。它唯一的代价是不告诉我们「用什么动作选的」，
   * 而我们本来也不关心动作，只关心「当前选区落在哪」。
   *
   * ## 为什么仍然要判容器归属
   *
   * 用户在右侧边栏里选中备注文字时，选区不在正文容器里。
   * 不判的话按钮会亮起来，点下去标的是那句备注 —— 明显不对。
   */
  useEffect(() => {
    const onSelectionChange = () => {
      const el = bodyRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) {
        setSelectionText('');
        setSelectionRect(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setSelectionText('');
        setSelectionRect(null);
        return;
      }
      const root = sel.getRangeAt(0).commonAncestorContainer;
      const inside = el.contains(root.nodeType === 1 ? root : root.parentNode);
      setSelectionText(inside ? text : '');
      /*
       * 顺手把选区的视口矩形一起量下来（2026-11-10）。
       *
       * 复用这一次监听而不是再挂一份：两处监听会在时序上打架
       * （一处已经 setState 了，另一处还在读旧 Range）。
       * 量的具体做法在 SelectionActionBar 里，这里只管取。
       */
      setSelectionRect(inside ? measureSelectionRect(el) : null);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  /**
   * 把用户批注画到正文上（2026-11-09）。
   *
   * ## 为什么放在渲染之后、还要等一帧
   *
   * 走的是 CSS Custom Highlight API，需要正文 DOM **已经存在**
   * 才能把「段内字符区间」映射成 Range。这个 effect 依赖
   * pageNo / pageMarks / seg，DOM 更新在同一轮 commit 里完成，
   * 但为了躲开 React 的批处理边界，延一帧再画最稳。
   *
   * ## 依赖里为什么有 seg.text.length 而不是整个 seg
   *
   * 换页时段对象会换，但**同一份资料重解析后 text 可能变长变短**
   * 而页码不变。带上长度才能在那种情况下重画。
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !seg) {
      clearTextMarks();
      return;
    }
    const raf = requestAnimationFrame(() => {
      paintTextMarks(el, seg, pageMarks);
    });
    return () => {
      cancelAnimationFrame(raf);
      /* 翻页/卸载时清掉，避免上一页的标记残留在新页上 */
      clearTextMarks();
    };
  }, [seg, pageMarks, pageNo, showOriginal]);

  /** 加一条标记：把当前选区做成锚点存进这一页 */
  const handleAddMark = useCallback(
    (kind: TextMarkKind) => {
      if (!annotations || !sourceId || !seg || !selectionText) return;
      const sel = window.getSelection();
      const exact = selectionText;
      /*
       * 算这条标记在**这一页正文**里的字符偏移。
       *
       * ⚠️ 不能简单用 `seg.text.indexOf(exact)`：同一句话在一页里
       * 出现两次时，indexOf 永远给第一个 —— 用户标的是第二处，
       * 高亮却画在第一处。而界面上看着都像对的，极难发现。
       *
       * 这里用「选区在正文容器里的位置」做提示：
       * 取选区起点之前那部分文字的长度作为近似起点，
       * 再从那儿往后找 exact。找不到（跨节点/被 Markdown 标记打断）
       * 就退回全页 indexOf，仍找不到就记 0 并由 exact 兜底定位。
       */
      let start = -1;
      if (sel && sel.rangeCount > 0) {
        try {
          const range = sel.getRangeAt(0);
          const el = bodyRef.current;
          if (el && el.contains(range.startContainer)) {
            /*
             * 用 Range 从容器开头量到选区起点。cloneContents 会把
             * DOM 转成片段，量它的文本长度即是「选区内起始偏移」的近似。
             * 这是浏览器给的标准做法，比自己遍历节点可靠。
             */
            const head = range.cloneRange();
            head.selectNodeContents(el);
            head.setEnd(range.startContainer, range.startOffset);
            const headText = head.toString();
            const near = seg.text.indexOf(exact, Math.max(0, headText.length - 40));
            if (near >= 0) start = near;
          }
        } catch {
          /* Range 操作失败就退回全页搜 */
        }
      }
      if (start < 0) start = seg.text.indexOf(exact);
      if (start < 0) start = 0;

      const mark: TextMark = {
        id: newId('mark'),
        kind,
        anchor: {
          page: seg.page,
          exact,
          /* prefix/suffix 用于消歧：同一句话在一页里出现多次时靠它挑对 */
          prefix: start > 20 ? seg.text.slice(start - 20, start) : seg.text.slice(0, start),
          suffix: seg.text.slice(start + exact.length, start + exact.length + 20),
          start,
          end: start + exact.length,
        },
        createdAt: new Date().toISOString(),
      };

      void (async () => {
        await annotations.addTextMark(sourceId, seg.page, mark);
        const rec = await annotations.get(sourceId, seg.page);
        setPageMarks(rec?.textMarks ?? []);
        setSelectionText('');
      })();
    },
    [annotations, sourceId, seg, selectionText],
  );

  /**
   * 把当前选区做成一条提问素材并交给宿主（2026-11-10）。
   *
   * ## 为什么要重新量一次偏移，而不是复用 handleAddMark 那段
   *
   * handleAddMark 里那段 Range 测量埋在它的回调里、还混着建标记的
   * 其它逻辑。这里需要的只是「选区起点 ≈ 段内第几个字」这一个数，
   * 抽出来单独量更清楚，也不会因为改标记逻辑而连带坏掉提问。
   *
   * ## 为什么量不到也要继续
   *
   * `start = -1` 时 `evidenceText()` 会只用引文本身（不扩上下文）。
   * 这比「不提问」好：用户看到的是它拿自己选的那句话去问了，
   * 只是短选区时少了点上下文 —— 而且界面会如实说明。
   */
  const handleAskAboutSelection = useCallback(
    (text: string) => {
      if (!onAskAboutSelection || !sourceId || !seg) return;

      /* 量「选区起点之前有多少文字」—— 与 handleAddMark 同一套做法 */
      let hintStart = -1;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        try {
          const range = sel.getRangeAt(0);
          const el = bodyRef.current;
          if (el && el.contains(range.startContainer)) {
            const head = range.cloneRange();
            head.selectNodeContents(el);
            head.setEnd(range.startContainer, range.startOffset);
            /*
             * 用 head.toString().length 而不是取末 40 字再 indexOf：
             * 前者是「字符数」，与 seg.text 的偏移同一量纲；
             * 后者要处理「截断处正好在多字节边界」等噪声。
             */
            hintStart = head.toString().length;
          }
        } catch {
          /* Range 操作失败就退回按引文搜（locateSelection 的兜底） */
        }
      }

      const { start, end } = locateSelection(seg.text, text, hintStart);
      const selection: PassageSelection = {
        sourceId,
        page: seg.page,
        quote: text.trim(),
        start,
        end,
        chapter: seg.chapter,
      };

      /*
       * 在这里就把素材拼好（而不是把 PassageSelection 丢给宿主）。
       *
       * 理由：拼素材需要**这一段的完整正文**（短选区要扩上下文）
       * 与资料标题，这两样此刻就在手边（seg.text / phase.source.title）。
       * 交给宿主的话它得为了一段文字再查一次库 ——
       * 628 页的资料读全部段落，只为取一段，明显不值。
       */
      const material = passageToMaterial(
        selection,
        seg.text,
        phase.kind === 'ready' ? phase.source.title : '',
      );

      /* 清掉选区与浮层，避免同一段被连点两次 */
      window.getSelection()?.removeAllRanges();
      setSelectionText('');
      setSelectionRect(null);

      onAskAboutSelection(material);
    },
    [onAskAboutSelection, sourceId, seg, phase],
  );

  /**
   * 新建一条备注（2026-11-11）。
   *
   * 两种形态共用这个函数：
   *  - `wholePage === false` → 划选备注：拿当前选区，锚点只覆盖那句
   *  - `wholePage === true`  → 整页备注：锚点覆盖整段（start=0 / end=段长）
   *
   * ## 为什么不复用 handleAddMark
   *
   * 那个函数的 kind 是「上色类」，而且它假定用户已经选中了文字。
   * 整页备注**不需要选区**，用它会在一开始就被 `!selectionText` 挡掉。
   *
   * ## 整页备注的 exact 存什么
   *
   * 存整段的开头一小段（不超过 40 字）。理由：
   *  - 锚点的 exact 用于消歧与回查，不能空着
   *  - 但整页备注的 exact 不是「用户指的那句话」，所以界面不显示它
   *    （见 ReaderSidePanel 里 isWholePageNote 的分支）
   */
  const handleAddNote = useCallback(
    async (noteText: string, wholePage: boolean) => {
      if (!annotations || !sourceId || !seg) return;
      const text = noteText.trim();
      if (!text) return;

      let start = 0;
      let end = seg.text.length;
      let exact = seg.text.slice(0, 40);

      if (!wholePage) {
        /* 划选备注必须有真实选区 */
        if (!selectionText) return;
        exact = selectionText;

        /* 用与 handleAddMark 相同的办法量出段内偏移 */
        let hint = -1;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          try {
            const range = sel.getRangeAt(0);
            const el = bodyRef.current;
            if (el && el.contains(range.startContainer)) {
              const head = range.cloneRange();
              head.selectNodeContents(el);
              head.setEnd(range.startContainer, range.startOffset);
              hint = head.toString().length;
            }
          } catch {
            /* 退回按引文搜 */
          }
        }
        const located = locateSelection(seg.text, exact, hint);
        start = located.start >= 0 ? located.start : 0;
        end = located.start >= 0 ? located.end : seg.text.length;
      }

      const mark: TextMark = {
        id: newId('mark'),
        kind: 'note',
        anchor: {
          page: seg.page,
          exact,
          prefix: start > 20 ? seg.text.slice(start - 20, start) : seg.text.slice(0, start),
          suffix: seg.text.slice(end, end + 20),
          start,
          end,
        },
        note: text,
        createdAt: new Date().toISOString(),
      };

      await annotations.addTextMark(sourceId, seg.page, mark);
      const rec = await annotations.get(sourceId, seg.page);
      setPageMarks(rec?.textMarks ?? []);
      /* 存完清选区：同一段不该被连标两次 */
      window.getSelection()?.removeAllRanges();
      setSelectionText('');
      setSelectionRect(null);
    },
    [annotations, sourceId, seg, selectionText],
  );

  /**
   * 定位到某条备注（2026-11-11）。
   *
   * 用 id 查 DOM 里对应的 `.reader-note` 元素并滚过去 —— 但它没有
   * data-id 属性，所以改用**按区间重算**的办法：找到这条 note 的
   * start/end，再从所有 `.reader-note` 里挑文字内容匹配的那个。
   *
   * 为什么不在渲染时打 data-id：那要给 markdown-marks 的渲染
   * 多传一个「每条备注的 id」映射，为了一个定位功能改渲染核心不划算。
   * 按内容匹配已经足够（同一页上两条备注文字相同的情况极少）。
   */
  const handleLocateMark = useCallback(
    (markId: string) => {
      const m = pageMarks.find((x) => x.id === markId);
      if (!m || !seg) return;

      const whole = isWholePageNote(m, seg.text.length);
      const target = m.anchor.exact.slice(0, 20);

      const nodes = Array.from(document.querySelectorAll<HTMLElement>('.reader-note'));
      const hit =
        nodes.find((n) => n.innerText.replace(/\s+/g, '').includes(target.replace(/\s+/g, ''))) ??
        nodes[0];

      if (whole || !hit) {
        /* 整页备注没有行内元素可跳 —— 滚到页面顶部即可 */
        document.querySelector('.reader-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
      /* 短暂闪一下，让用户看清跳到了哪 */
      hit.classList.add('reader-note--flash');
      setTimeout(() => hit.classList.remove('reader-note--flash'), 1200);
    },
    [pageMarks, seg],
  );

  const handleRemoveMark = useCallback(
    async (markId: string) => {
      if (!annotations || !sourceId || !seg) return;
      await annotations.removeTextMark(sourceId, seg.page, markId);
      const rec = await annotations.get(sourceId, seg.page);
      setPageMarks(rec?.textMarks ?? []);    },
    [annotations, sourceId, seg],
  );

  const handleSetNote = useCallback(
    async (markId: string, note: string) => {
      if (!annotations || !sourceId || !seg) return;
      await annotations.updateTextMark(sourceId, seg.page, markId, {
        note: note.length > 0 ? note : undefined,
      });
      const rec = await annotations.get(sourceId, seg.page);
      setPageMarks(rec?.textMarks ?? []);
    },
    [annotations, sourceId, seg],
  );

  /**
   * 这一页有几条知识点。
   *
   * 阅读器不持有知识点服务（那是整理页的依赖），所以这里**不编造**数字：
   * 拿不到就传 undefined，侧栏显示「—」。
   * 显示一个猜的 0 比显示「—」更糟 —— 用户会以为这页真的没有知识点。
   */
  const pageKnowledgeCount: number | undefined = undefined;

  /** 这一页的插图 */
  const pageFigures = useMemo(() => {
    if (phase.kind !== 'ready' || !seg) return [];
    return phase.figures.filter((f) => f.page === seg.page);
  }, [phase, seg]);

  /**
   * 本页的整页备注（2026-11-11）。
   *
   * 与划选备注分开：整页备注不落在任何一句上，显示在正文下方的页脚。
   * 判定用 `isWholePageNote`（start===0 且覆盖整段），
   * 不能只看 kind === 'note' —— 那样划选备注也会跑到页脚去。
   */
  const wholePageNotes = useMemo(() => {
    if (!seg) return [];
    return pageMarks.filter((m) => isWholePageNote(m, seg.text.length));
  }, [pageMarks, seg]);

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
            返回{backLabel ?? '资料'}
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
            返回{backLabel ?? '资料'}
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
          返回{backLabel ?? '资料'}
        </button>
      </header>

      {/*
        定位状态：如实说清这次是「偏移命中」还是「靠引文找回」还是「没找到」。

        2026-11-09 修：`via: 'none'` 时**不再**显示那句「没能定位到具体句子」。
        因为「整段锚点」也走 via='none'，而它并不是定位失败 ——
        是有意不圈句子。两行同时出现会互相矛盾（实测截图里
        第一行说「没能定位到具体句子」、第二行说「出自整段内容」）。
        整段的情况由下面的 jumpNote 独自说明，语义更准确。
      */}
      {highlight && highlight.via !== 'none' ? (
        <p className={`reader-jump reader-jump--${highlight.via}`}>
          {highlight.via === 'anchor'
            ? `已定位到第 ${seg?.page ?? 1} 页的原文位置。`
            : `原文偏移对不上了，靠引文在第 ${seg?.page ?? 1} 页找回来的。`}
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

      <div className="reader-split">
      <div className="reader-main">
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
            /* 划选备注要高亮到正文上（2026-11-11） */
            pageMarks,
          )
        ) : null}

        {/*
          整页备注显示在正文下方（2026-11-11）。

          为什么放在页脚而不是正文里：整页备注不绑定任何一句，
          塞进正文会让用户以为它属于某一段。放页脚时它读作
          「关于这一整页的批注」，语义才正确。
        */}
        {wholePageNotes.length > 0 ? (
          <ul className="reader-pagenote-list">
            {wholePageNotes.map((m) => (
              <li key={m.id} className="reader-pagenote">
                <span className="reader-pagenote__tag">整页备注</span>
                <span className="reader-pagenote__text">{m.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      </div>

      {/*
        选区浮层：选中正文就冒出的「用这段提问」（2026-11-10）。
        抽成独立文件（SelectionActionBar.tsx），宿主只插这一行 ——
        ReaderPage 已经 1200+ 行，项目对往大文件里插代码有过教训。
        只在宿主接了 onAskAboutSelection 时才渲染（没接 AI 就不冒按钮）。
      */}
      {onAskAboutSelection ? (
        <SelectionActionBar
          selection={selectionRect && selectionText ? { rect: selectionRect, text: selectionText } : null}
          onAsk={handleAskAboutSelection}
          disabledReason={askDisabledReason ?? null}
        />
      ) : null}

      {/*
        右侧边栏：查看 / 批注（2026-11-09）。
        抽成独立文件（ReaderSidePanel.tsx），这里只插一行引用 ——
        ReaderPage 已经 900+ 行，项目对往大文件里插代码有过教训。
      */}
      <ReaderSidePanel
        segment={seg}
        pageNo={pageNo}
        totalSegments={totalSegments}
        marks={pageMarks}
        onAddMark={handleAddMark}
        onRemoveMark={(id) => void handleRemoveMark(id)}
        onSetNote={(id, note) => void handleSetNote(id, note)}
        hasSelection={!!selectionText}
        knowledgeCount={pageKnowledgeCount}
        figureCount={pageFigures.length}
        onAddSelectionNote={(note) => void handleAddNote(note, false)}
        onAddPageNote={(note) => void handleAddNote(note, true)}
        onLocateMark={(id) => handleLocateMark(id)}
      />
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
  /** 本页的标记：用来画划选备注（2026-11-11） */
  pageMarks: readonly TextMark[] = [],
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
      {/*
        2026-11-11：两条渲染路径合并成一条 MarkdownBodyMarked。
        原来「有高亮」走切三段（不解析 Markdown → # 原样显示）、
        「没高亮」走 MarkdownBody（解析了但不知道高亮区间）。
        一有定位整页就退化成带 # 的纯文本，而且两边字符数不同，
        高亮偏移与屏幕上看到的字错开 —— 用户报的
        「标注的文字与实际显示效果不匹配」就是它。
      */}
      {figures.length > 0 ? (
        renderWithFigures(seg.text, highlight, markRef, figures)
      ) : (
        <MarkdownBodyMarked
          text={seg.text}
          marks={highlightMarks(highlight)}
          markRef={markRef}
          notes={noteRanges(pageMarks, seg.text.length)}
        />
      )}
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

  /* hasHighlight 已不需要：两条路径合并后，MarkdownBodyMarked 自己判断
     有没有区间与块相交。*/

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

    /*
     * 每个文字切片都走 MarkdownBodyMarked（2026-11-11 统一）。
     *
     * 传 baseOffset = sliceStart：高亮区间是相对**整段**的，
     * 组件内部换算成本切片的局部区间。
     * 切块与偏移都从这一份 slice 原文算，所以按插图切分也不会让标注错位。
     */
    out.push(
      <MarkdownBodyMarked
        key={`t-${key++}`}
        text={slice}
        marks={highlightMarks(highlight)}
        baseOffset={sliceStart}
        markRef={markRef}
      />,
    );
  }

  return <>{out}</>;
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

/**
 * 把内部 Highlight 转成渲染层要的区间数组（2026-11-11）。
 *
 * 为什么还要这一层：`Highlight` 带 `via` 字段（anchor / quote / none），
 * 那是「定位可不可信」的信息，只给界面提示用；渲染只关心区间。
 * 分开后渲染组件不必知道定位细节。
 */
function highlightMarks(highlight: Highlight | null): { start: number; end: number }[] {
  if (!highlight) return [];
  if (highlight.via === 'none') return [];
  if (highlight.end <= highlight.start) return [];
  return [{ start: highlight.start, end: highlight.end }];
}

/**
 * 取出本页所有「划选备注」的区间（2026-11-11）。
 *
 * ## 为什么要排除整页备注
 *
 * 整页备注的 anchor 覆盖整段（start=0 / end=段长）。若把它当普通备注
 * 传进去，整段正文都会被画上虚线 —— 那等于把页面搞花，而且信息量为零
 * （用户看不出「备注的到底是哪一句」）。
 * 整页备注在页面底部单独显示（见 `.reader-pagenote`）。
 *
 * @param marks 本页全部标记
 * @param segLength 本段正文长度
 */
function noteRanges(
  marks: readonly TextMark[],
  segLength: number,
): { start: number; end: number }[] {
  return marks
    .filter((m) => m.kind === 'note')
    .filter((m) => !isWholePageNote(m, segLength))
    .map((m) => ({ start: m.anchor.start, end: m.anchor.end }))
    .filter((r) => r.end > r.start);
}
