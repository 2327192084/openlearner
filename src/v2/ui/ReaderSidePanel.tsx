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
import { MARK_COLORS } from '@/core/text-anchor.ts';
import './reader-side.css';

/** 右栏的两种模式 */
export type ReaderSideMode = 'view' | 'annotate';

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
}

/** 三种标记的中文名与说明 */
const MARK_KIND_META: Record<TextMarkKind, { label: string; hint: string }> = {
  highlight: { label: '高亮', hint: '标出重点句' },
  underline: { label: '下划线', hint: '标出要记的术语' },
  strikethrough: { label: '删除线', hint: '标出已推翻的说法' },
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
}: ReaderSidePanelProps) {
  const [mode, setMode] = useState<ReaderSideMode>(initialMode);
  /** 正在编辑备注的那条标记 id */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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
          {marks.length > 0 ? <span className="rside__count">{marks.length}</span> : null}
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
              {(Object.keys(MARK_KIND_META) as TextMarkKind[]).map((k) => (
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
              {sorted.length > 0 ? <span className="rside__count">{sorted.length}</span> : null}
            </h3>

            {sorted.length === 0 ? (
              <p className="rside__empty">这一页还没有标记。</p>
            ) : (
              <ul className="rside__list">
                {sorted.map((m) => (
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
