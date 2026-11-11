/**
 * 阅读器右侧边栏：**查看 / 批注** 双模式（2026-11-09）。
 *
 * ## 为什么要有这个切换
 *
 * 用户对照 StudyHub 4.5 提的需求：阅读时右手边那一列在
 * 「看信息」与「写批注」之间切换，而不是两套界面来回跳。
 *
 * 两种模式看的是同一页、同一份正文，只是右栏做的事不同：
 *  - **查看**：这一页有什么（页码、章节、知识点数、插图数）
 *  - **批注**：这一页的标记（高亮/下划线/删除线）与备注
 *
 * ## 为什么抽成独立文件
 *
 * `ReaderPage.tsx` 已经 900+ 行，而项目对「往大文件里按行号插代码」
 * 有过明确教训（GeneratePage 的 CRLF 混用）。宿主里只插一行引用。
 *
 * ## 为什么默认是「查看」
 *
 * 批注是低频动作，查看是高频动作。默认落在低频模式上，
 * 每次进来都要先切一下，反而碍事。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceSegment, TextMark, TextMarkKind, NotemarkImage } from '@/core/model.ts';
import { MARK_COLORS, isWholePageNote } from '@/core/text-anchor.ts';
import { NoteImageField, fileToNoteImage, imageFromPaste } from './NoteImageField.tsx';
import './reader-side.css';

/** 右栏的两种模式 */
/**
 * 右栏的三种模式（2026-11-11 加 `note`）。
 *
 * 为什么备注要单独一页而不是并进「批注」：
 *  - 批注 = 点一下就给文字上色（三个按钮、零输入）
 *  - 备注 = 先选文字/整页，再写一句话（有输入框）
 * 两种交互混在一页会让「加标记」那三个按钮和备注按钮抢注意力，
 * 而且用户点「高亮」时可能以为会弹出写字的框。
 */
export type ReaderSideMode = 'view' | 'annotate' | 'note';

export interface ReaderSidePanelProps {
  /** 当前这一段（页） */
  segment: SourceSegment | null;
  /** 当前段序号 / 总数，用于「第几段」 */
  pageNo: number;
  totalSegments: number;
  /** 这一页的批注标记 */
  marks: readonly TextMark[];
  /** 用户要新建一条标记（文字已选中，由正文层回调提供） */
  onAddMark?: (kind: TextMarkKind) => void;
  /** 删除一条标记 */
  onRemoveMark?: (markId: string) => void;
  /** 给一条标记写备注 */
  onSetNote?: (markId: string, note: string) => void;
  /** 当前是否已经有选中的文字（决定「加标记」按钮是否可用） */
  hasSelection: boolean;
  /** 这一页有几条知识点（只看数量，不在这里做跳转） */
  knowledgeCount?: number;
  /** 这一页有几张插图 */
  figureCount?: number;
  /** 默认模式 */
  initialMode?: ReaderSideMode;
  /**
   * 外部要求切到某个页签（2026-11-11 晚，「先选再写」流程用）。
   *
   * 用户在正文选中 → 点浮层「写备注」→ 宿主把它设成 'note'，
   * 右栏跟过去。不设就一直是 undefined，页签仍由用户自己点。
   */
  forceMode?: ReaderSideMode;
  /**
   * 递增这个数字就聚焦备注输入框（2026-11-11 晚）。
   *
   * 为什么用「递增的 token」而不是布尔开关：布尔值第二次设成 true
   * 时 React 认为没变化、不重跑 effect，于是第二次点「写备注」
   * 光标不会进输入框 —— 这种「第二次失效」的 bug 很难被发现。
   */
  focusNoteToken?: number;
  /**
   * 新建一条**划选备注**（2026-11-11）。
   *
   * 与 `onAddMark` 分开：那个是「点一下就上色」，这个是
   * 「拿选中的文字 + 用户写的备注，一起存成 kind:'note' 的标记」。
   * 两个回调在正文层做的事不同（一个不需要文字，一个必须有文字）。
   */
  onAddSelectionNote?: (note: string, image: NotemarkImage | null) => void;
  /**
   * 新建一条**整页备注**（2026-11-11）。
   *
   * 整页备注不依赖选区，所以按钮永远可用。
   * 存成 note 标记但 anchor 覆盖整段（见 text-anchor 的 isWholePageNote）。
   */
  onAddPageNote?: (note: string, image: NotemarkImage | null) => void;
  /** 点「定位」时跳到正文里的那条标记 */
  onLocateMark?: (markId: string) => void;
}

/**
 * 各标记的中文名与说明。
 *
 * `note` 也在这里，但它**不出现在「加标记」那排按钮里** ——
 * 备注在同一个面板的「备注」页（见下方 mode），因为它的交互
 * 与「点一下就上色」不同：要先写文字。
 * 放在这个表里只是为了让 Record<TextMarkKind,…> 完整，
 * 以及在标记列表里显示「备注」这个标签。
 */
const MARK_KIND_META: Record<TextMarkKind, { label: string; hint: string }> = {
  highlight: { label: '高亮', hint: '标出重点句' },
  underline: { label: '下划线', hint: '标出要记的术语' },
  strikethrough: { label: '删除线', hint: '标出已推翻的说法' },
  note: { label: '备注', hint: '写下你当时的想法' },
};

/** 引文超过这个长度就折成「开头…结尾」 */
const QUOTE_CLIP = 40;

/**
 * 侧栏里显示引文时截断（2026-11-11 用户要求）。
 *
 * ## 用户原话
 *
 * 「对于划选超出备注显示范围的，可以仅显示开头和结尾的几个字，
 * 中间可以用省略号替代。」
 *
 * ## 为什么只改显示、不改存储
 *
 * `anchor.exact` 是锚点还原的**唯一依据**（`resolveTextAnchor` 靠它
 * 在正文里重新定位）。截断它会让定位失效 —— 表现出「备注点定位跳错地方」。
 * 所以库里存完整原文，只在侧栏渲染时折成两头。
 *
 * 完整的引文放在 `title` 属性里，鼠标悬停仍能看到全文。
 */
function clipQuote(exact: string): string {
  const s = exact.trim();
  if (s.length <= QUOTE_CLIP) return s;
  const head = Math.ceil(QUOTE_CLIP / 2);
  const tail = Math.floor(QUOTE_CLIP / 2);
  return `${s.slice(0, head)}……${s.slice(-tail)}`;
}

/**
 * 区分「用户真的点了整页备注」与「旧版定位失败兜底成整页」。
 *
 * ## 为什么要区分
 *
 * 2026-11-11 之前的 `handleAddNote` 在定位失败时把锚点写成
 * `start=0 / end=全文长度`，于是这条**划选备注**会被 `isWholePageNote`
 * 判成整页备注 —— 用户看到「整页备注」但自己明明只选了一句。
 *
 * ## 判据
 *
 * 真·整页备注：用户点「整页备注」按钮，exact 存的是**段首 40 字**
 * （见 handleAddNote 里 `exact = seg.text.slice(0, 40)`），
 * 所以 exact 很短且等于段首。
 *
 * 兜底失败的：exact 是用户选区的原文，通常**长于 40 字**，
 * 或者不等于段首那 40 字。
 *
 * 这是保守判据：宁可把极少数的真整页备注也标上「未定位」，
 * 也不要把一堆错锚点藏起来 —— 后者会让用户以为标注功能还是坏的。
 */
function looksLikeDeliberateWholePage(m: {
  anchor: { exact: string; start: number; end: number };
}): boolean {
  return m.anchor.exact.length <= 40 && m.anchor.start === 0;
}

export function ReaderSidePanel({
  segment,
  pageNo,
  totalSegments,
  marks,
  onAddMark,
  onRemoveMark,
  onSetNote,
  hasSelection,
  knowledgeCount,
  figureCount,
  initialMode = 'view',
  /*
   * 外部要求切到某个页签（2026-11-11 晚）。
   *
   * 「先选再写」的流程需要它：用户在正文里选中 → 点浮层的「写备注」→
   * 右栏必须切到备注页。没有这个 prop 的话右栏停在「查看」，
   * 用户点完按钮看不到任何变化，会以为没生效。
   */
  forceMode,
  /** 递增一次就聚焦备注输入框（配合 forceMode='note' 用） */
  focusNoteToken = 0,
  onAddSelectionNote,
  onAddPageNote,
  onLocateMark,
}: ReaderSidePanelProps) {
  const [mode, setMode] = useState<ReaderSideMode>(initialMode);

  /* 外部要求切页签时跟过去（2026-11-11 晚，「先选再写」用） */
  useEffect(() => {
    if (forceMode) setMode(forceMode);
  }, [forceMode]);
  /** 正在编辑备注的那条标记 id */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 备注页里正在写的新备注（划选与整页共用这个输入框，但各自提交） */
  const [newNote, setNewNote] = useState('');
  /** 这条备注附带的图（2026-11-11）。提交后清空 */
  const [newNoteImage, setNewNoteImage] = useState<NotemarkImage | null>(null);
  /** 粘贴图片失败的原因（要显示出来，不能静默） */
  const [pasteError, setPasteError] = useState<string | null>(null);

  /**
   * 粘贴图片（2026-11-11）。
   *
   * 与「＋添加图片」共用 `fileToNoteImage`，所以大小上限与格式校验
   * 两条路径完全一致 —— 分开写就会出现「选文件能过、粘贴不能过」。
   */
  const acceptPastedImage = useCallback(async (file: File) => {
    setPasteError(null);
    try {
      setNewNoteImage(await fileToNoteImage(file));
    } catch (e) {
      /* 失败必须说出来：用户粘了一张 1.2MB 的截图时，
         右下角什么都没发生会让人以为功能坏了。 */
      setPasteError(e instanceof Error ? e.message : '粘贴图片失败。');
    }
  }, []);

  const startEdit = useCallback((mark: TextMark) => {
    setEditing(mark.id);
    setDraft(mark.note ?? '');
  }, []);

  /**
   * 「先选再写」流程的收尾（2026-11-11 晚）：把光标放进备注输入框。
   *
   * 用户点浮层的「写备注」后，右栏已切到备注页、选区也记住了，
   * 接下来就该直接开始打字 —— 让他再去点一下输入框是多余的一步。
   *
   * 依赖 focusNoteToken 而不是 focus：token 每次递增都会重跑，
   * 用布尔值的话第二次点「写备注」不会重新聚焦（值没变）。
   */
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  /** 已经为哪个 token 聚过焦 —— 防止用户手动切回备注页时又被抢焦点 */
  const focusedToken = useRef(0);
  useEffect(() => {
    if (focusNoteToken <= 0) return;
    if (focusedToken.current === focusNoteToken) return;

    /*
     * 依赖里必须带 mode（2026-11-11 晚实测踩到）。
     *
     * 「点写备注」那一刻 mode 还是 'view'，textarea 根本不在 DOM 里 ——
     * 此时 rAF 里 focus() 拿到的是 null，光标留在 body。
     * mode 变成 'note' 后本 effect 会再跑一次，那时才真正能聚焦。
     */
    if (mode !== 'note') return;

    const id = requestAnimationFrame(() => {
      if (noteRef.current) {
        noteRef.current.focus();
        focusedToken.current = focusNoteToken;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [focusNoteToken, mode]);

  const commitEdit = useCallback(
    (markId: string) => {
      onSetNote?.(markId, draft.trim());
      setEditing(null);
      setDraft('');
    },
    [draft, onSetNote],
  );

  /*
   * 按创建时间倒序：刚标的在最上面。
   *
   * 用 createdAt 而不是数组顺序 —— 数组顺序取决于存盘时怎么合并，
   * 用户无法预测。时间倒序是「最新的在最前」，符合直觉。
   */
  const sorted = useMemo(
    () => [...marks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [marks],
  );

  /*
   * 两类分开计数（2026-11-11）。
   *
   * 批注页只显示「上色类」的标记，备注页只显示 note ——
   * 混在一起会让用户以为备注也是一条高亮。
   */
  const annotationMarks = useMemo(() => sorted.filter((m) => m.kind !== 'note'), [sorted]);
  const noteMarks = useMemo(() => sorted.filter((m) => m.kind === 'note'), [sorted]);
  const annotationCount = annotationMarks.length;
  const noteCount = noteMarks.length;

  return (
    <aside className="rside" aria-label="资料侧栏">
      {/* 模式切换 */}
      <div className="rside__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'view'}
          className={`rside__tab${mode === 'view' ? ' rside__tab--on' : ''}`}
          onClick={() => setMode('view')}
        >
          查看
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'annotate'}
          className={`rside__tab${mode === 'annotate' ? ' rside__tab--on' : ''}`}
          onClick={() => setMode('annotate')}
        >
          批注
          {annotationCount > 0 ? <span className="rside__count">{annotationCount}</span> : null}
        </button>
        {/*
          备注页（2026-11-11）。
          与批注分开而不是塞在批注里：批注是「给文字上色」，
          备注是「写下想法」—— 交互不同（要先写文字），
          混在一页会让「加标记」那三个按钮和备注按钮抢位置。
        */}
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'note'}
          className={`rside__tab${mode === 'note' ? ' rside__tab--on' : ''}`}
          onClick={() => setMode('note')}
        >
          备注
          {noteCount > 0 ? <span className="rside__count">{noteCount}</span> : null}
        </button>
      </div>

      {mode === 'view' ? (
        <div className="rside__body">
          <section className="rside__sec">
            <h3 className="rside__h">当前位置</h3>
            <dl className="rside__kv">
              <dt>段落</dt>
              <dd>
                第 {pageNo} / {totalSegments} 段
              </dd>
              <dt>页码</dt>
              <dd>{segment?.page ?? '—'}</dd>
              <dt>章节</dt>
              <dd>{segment?.chapter ?? '未标注章节'}</dd>
              <dt>字数</dt>
              <dd>{segment ? segment.text.length : 0}</dd>
            </dl>
          </section>

          <section className="rside__sec">
            <h3 className="rside__h">这一页有什么</h3>
            <dl className="rside__kv">
              <dt>知识点</dt>
              <dd>
                {typeof knowledgeCount === 'number'
                  ? `${knowledgeCount} 条`
                  : '—'}
              </dd>
              <dt>插图</dt>
              <dd>
                {typeof figureCount === 'number' ? `${figureCount} 张` : '—'}
              </dd>
              <dt>批注</dt>
              <dd>{marks.length} 条</dd>
            </dl>
          </section>

          <p className="rside__tip">
            要标重点就切到「批注」：在正文里选中文字，再点高亮 / 下划线 / 删除线。
          </p>
        </div>
      ) : mode === 'note' ? (
        /* ---------- 备注页（2026-11-11） ---------- */
        <div className="rside__body">
          <section className="rside__sec">
            <h3 className="rside__h">写备注</h3>
            <p className="rside__lead">
              {/*
                2026-11-11 晚改：引导语跟着交互顺序改。
                用户明确要求「先选取再输入」——
                选中之后浮层里有「写备注」，点了会自动切到这一页，
                所以文案要说这条顺手路径，而不是让人先在这里打字。
              */}
              {hasSelection
                ? '已选中文字 —— 写完点「划选备注」就挂在这句话上。'
                : (
                    <>
                      先在正文里<strong>选中</strong>要备注的那句话，浮层里点「写备注」就会到这里；
                      也可以直接给整页写一条。
                    </>
                  )}
            </p>

            <textarea
              ref={noteRef}
              className="rside__note-input"
              rows={3}
              value={newNote}
              placeholder="写下你当时的想法、疑问或理解…"
              onChange={(e) => setNewNote(e.target.value)}
              /*
                截图后直接 Ctrl+V 就把图挂上（2026-11-11）。
                「把图加进备注」最常见的来源是截图，不是去文件管理器翻文件。
                若粘贴的是纯文本就放行默认行为，不拦。
              */
              onPaste={(e) => {
                const img = imageFromPaste(e);
                if (img) {
                  e.preventDefault();
                  void acceptPastedImage(img);
                }
              }}
            />

            {/* 备注附图（2026-11-11） */}
            <NoteImageField
              value={newNoteImage}
              onChange={(img) => {
                setNewNoteImage(img);
                setPasteError(null);
              }}
            />
            {pasteError ? <p className="rside__img-error">{pasteError}</p> : null}

            <div className="rside__note-actions">
              <button
                type="button"
                className="rside__note-btn rside__note-btn--primary"
                disabled={!hasSelection || !newNote.trim() || !onAddSelectionNote}
                /*
                 * title 要说清**当前缺什么**（2026-11-11 修）。
                 *
                 * 原来只区分「有没有选区」，于是用户写了字、也有选区、
                 * 但按钮仍灰时完全不知道原因（实测他就是这么卡住的）。
                 * 现在三种状态各给一句话。
                 */
                title={
                  !hasSelection
                    ? '先在正文里选中要备注的那句话'
                    : !newNote.trim()
                      ? '先在上面写下备注内容'
                      : '挂到选中的那句话上'
                }
                onClick={() => {
                  onAddSelectionNote?.(newNote.trim(), newNoteImage);
                  setNewNote('');
                  setNewNoteImage(null);
                }}
              >
                划选备注
              </button>
              <button
                type="button"
                className="rside__note-btn"
                disabled={!newNote.trim() || !onAddPageNote}
                title={!newNote.trim() ? '先在上面写下备注内容' : '记这一整页的想法，不绑定具体句子'}
                onClick={() => {
                  onAddPageNote?.(newNote.trim(), newNoteImage);
                  setNewNote('');
                  setNewNoteImage(null);
                }}
              >
                整页备注
              </button>
            </div>

            {/*
              实时说明「还差什么」（2026-11-11，晚改）。
              用户报「划线备注按钮不可用」，实测按钮确实是禁用的 ——
              但原因是输入框为空，而界面上没有任何文字提示这件事。
              加一行状态说明，把「为什么不能点」直接写出来。

              ⚠️ 2026-11-11 晚：步骤顺序改成「先选后写」。
              原文案是「① 先写内容 → ② 再选中」，正是用户说的
              「不符合日常习惯」那个顺序。现在按真实操作顺序说。
            */}
            <p className="rside__note-why">
              {!hasSelection
                ? '① 先在正文里选中要备注的那句话'
                : !newNote.trim()
                  ? '② 再在上面写下备注内容'
                  : '③ 可以点「划选备注」了'}
            </p>
          </section>

          <section className="rside__sec">
            <h3 className="rside__h">
              这一页的备注
              {noteCount > 0 ? <span className="rside__count">{noteCount}</span> : null}
            </h3>

            {noteCount === 0 ? (
              <p className="rside__empty">这一页还没有备注。</p>
            ) : (
              <ul className="rside__list">
                {noteMarks.map((m) => (
                  <li key={m.id} className="rside__item rside__item--note">
                    <div className="rside__item-top">
                      <span className="rside__item-kind">
                        {isWholePageNote(m, segment?.text.length ?? 0) ? '整页备注' : '划选备注'}
                      </span>
                      {/*
                        「未定位」标记（2026-11-11 第二轮）。
                        旧版在定位失败时会把锚点兜底成 start=0/end=全文，
                        这种记录会被判成「整页备注」，看起来像用户自己选了整页。
                        实际上它是**定位失败的旧数据**。
                        这里如实标出来，让用户知道这条并不指向他当时选的那句。
                      */}
                      {isWholePageNote(m, segment?.text.length ?? 0) &&
                      !looksLikeDeliberateWholePage(m) ? (
                        <span
                          className="rside__item-warn"
                          title="这条备注的原文范围覆盖了整页，可能是旧版本定位失败留下的。建议删掉重新划选备注。"
                        >
                          未定位
                        </span>
                      ) : null}
                      {/*
                        定位按钮：跳回正文里那条备注（2026-11-11 用户要求）。
                        「和图中一样，会在底下显示在哪一段进行了备注，点击会定位原文」。
                      */}
                      {onLocateMark ? (
                        <button
                          type="button"
                          className="rside__mini"
                          onClick={() => onLocateMark(m.id)}
                          title="在正文里定位这条备注"
                        >
                          定位
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="rside__mini"
                        onClick={() => onRemoveMark?.(m.id)}
                        title="删除这条备注"
                      >
                        删除
                      </button>
                    </div>

                    {/* 备注正文（用户写的话）—— 这才是重点，放最上面 */}
                    <p className="rside__note-text">{m.note ?? '（没有写内容）'}</p>

                    {/*
                      备注附图（2026-11-11）。
                      点开看大图：备注里的图通常是题目截图或公式，缩略图看不清。
                      用 <a> 而不是自定义弹层 —— data URI 在新窗口里能直接打开，
                      交给浏览器处理缩放最省事。
                    */}
                    {m.image ? (
                      <a
                        className="rside__note-img"
                        href={m.image.dataUri}
                        target="_blank"
                        rel="noreferrer"
                        title={`点击查看大图（${m.image.width}×${m.image.height}）`}
                      >
                        <img src={m.image.dataUri} alt="备注附图" loading="lazy" />
                      </a>
                    ) : null}

                    {/* 被备注的原文；整页备注不显示引文（它不属于某一句） */}
                    {!isWholePageNote(m, segment?.text.length ?? 0) && m.anchor.exact ? (
                      <p className="rside__quote" title={m.anchor.exact}>
                        「{clipQuote(m.anchor.exact)}」
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <div className="rside__body">
          <section className="rside__sec">
            <h3 className="rside__h">加标记</h3>
            <p className="rside__lead">
              {hasSelection
                ? '已选中文字，点一个类型即可标上。'
                : '先在正文里选中要标的文字。'}
            </p>
            <div className="rside__kinds">
              {/*
                只列「上色类」三种（2026-11-11）。
                备注不在这里 —— 它要写字，见「备注」页。
              */}
              {(['highlight', 'underline', 'strikethrough'] as TextMarkKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="rside__kind"
                  /* 没选中文字时禁用 —— 不做点了没反应的按钮 */
                  disabled={!hasSelection}
                  title={hasSelection ? MARK_KIND_META[k].hint : '先在正文里选中文字'}
                  onClick={() => onAddMark?.(k)}
                >
                  <span
                    className="rside__swatch"
                    style={{ background: MARK_COLORS[k] ?? '#eab308' }}
                    aria-hidden
                  />
                  {MARK_KIND_META[k].label}
                </button>
              ))}
            </div>
          </section>

          <section className="rside__sec">
            <h3 className="rside__h">
              这一页的标记
              {annotationCount > 0 ? <span className="rside__count">{annotationCount}</span> : null}
            </h3>

            {annotationCount === 0 ? (
              <p className="rside__empty">这一页还没有标记。</p>
            ) : (
              <ul className="rside__list">
                {annotationMarks.map((m) => (
                  <li key={m.id} className="rside__item">
                    <div className="rside__item-top">
                      <span
                        className="rside__swatch"
                        style={{ background: m.color ?? MARK_COLORS[m.kind] ?? '#eab308' }}
                        aria-hidden
                      />
                      <span className="rside__item-kind">{MARK_KIND_META[m.kind].label}</span>
                      <button
                        type="button"
                        className="rside__mini"
                        onClick={() => onRemoveMark?.(m.id)}
                        title="删除这条标记"
                      >
                        删除
                      </button>
                    </div>
                    <p className="rside__quote">{m.anchor.exact}</p>

                    {editing === m.id ? (
                      <div className="rside__edit">
                        <textarea
                          className="rside__note-input"
                          value={draft}
                          rows={2}
                          placeholder="写一句备注（可选）"
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        <div className="rside__edit-actions">
                          <button type="button" className="rside__mini" onClick={() => commitEdit(m.id)}>
                            保存
                          </button>
                          <button
                            type="button"
                            className="rside__mini"
                            onClick={() => {
                              setEditing(null);
                              setDraft('');
                            }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="rside__note" onClick={() => startEdit(m)}>
                        {m.note ? m.note : '＋ 写备注'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
