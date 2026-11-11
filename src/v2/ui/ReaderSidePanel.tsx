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

import { useCallback, useMemo, useState } from 'react';
import type { SourceSegment, TextMark, TextMarkKind } from '@/core/model.ts';
import { MARK_COLORS, isWholePageNote } from '@/core/text-anchor.ts';
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
   * 新建一条**划选备注**（2026-11-11）。
   *
   * 与 `onAddMark` 分开：那个是「点一下就上色」，这个是
   * 「拿选中的文字 + 用户写的备注，一起存成 kind:'note' 的标记」。
   * 两个回调在正文层做的事不同（一个不需要文字，一个必须有文字）。
   */
  onAddSelectionNote?: (note: string) => void;
  /**
   * 新建一条**整页备注**（2026-11-11）。
   *
   * 整页备注不依赖选区，所以按钮永远可用。
   * 存成 note 标记但 anchor 覆盖整段（见 text-anchor 的 isWholePageNote）。
   */
  onAddPageNote?: (note: string) => void;
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
  onAddSelectionNote,
  onAddPageNote,
  onLocateMark,
}: ReaderSidePanelProps) {
  const [mode, setMode] = useState<ReaderSideMode>(initialMode);
  /** 正在编辑备注的那条标记 id */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 备注页里正在写的新备注（划选与整页共用这个输入框，但各自提交） */
  const [newNote, setNewNote] = useState('');

  const startEdit = useCallback((mark: TextMark) => {
    setEditing(mark.id);
    setDraft(mark.note ?? '');
  }, []);

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
              {hasSelection
                ? '已选中文字 —— 「划选备注」会挂在这句话上。'
                : '要备注某句话，先在正文里选中它；也可以给整页写一条。'}
            </p>

            <textarea
              className="rside__note-input"
              rows={3}
              value={newNote}
              placeholder="写下你当时的想法、疑问或理解…"
              onChange={(e) => setNewNote(e.target.value)}
            />

            <div className="rside__note-actions">
              <button
                type="button"
                className="rside__note-btn rside__note-btn--primary"
                disabled={!hasSelection || !newNote.trim() || !onAddSelectionNote}
                title={hasSelection ? '挂到选中的那句话上' : '先在正文里选中文字'}
                onClick={() => {
                  onAddSelectionNote?.(newNote.trim());
                  setNewNote('');
                }}
              >
                划选备注
              </button>
              <button
                type="button"
                className="rside__note-btn"
                disabled={!newNote.trim() || !onAddPageNote}
                title="记这一整页的想法，不绑定具体句子"
                onClick={() => {
                  onAddPageNote?.(newNote.trim());
                  setNewNote('');
                }}
              >
                整页备注
              </button>
            </div>
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

                    {/* 被备注的原文；整页备注不显示引文（它不属于某一句） */}
                    {!isWholePageNote(m, segment?.text.length ?? 0) && m.anchor.exact ? (
                      <p className="rside__quote">「{m.anchor.exact}」</p>
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
