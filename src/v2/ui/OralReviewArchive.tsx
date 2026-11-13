import { useCallback, useEffect, useState } from 'react';
import type { OralReviewRecord } from '@/core/model.ts';
import {
  anchorText,
  filterRows,
  needsQuoteWarning,
  summaryText,
  toRows,
  VERDICT_ADVICE,
  VERDICT_LABEL,
  type OralFilter,
  type OralReviewRow,
} from '@/v2/core/oral-review-view.ts';
import './oral-archive.css';

/**
 * 提问式复习的**记录回看**（2026-11-13）。
 *
 * ## 为什么单独一个页面 / 单独一个文件
 *
 * 这套记录一直能存不能看：`OralReviewService.list()` 与 `recentStats()`
 * 都在、都有单测，但全仓库没有一处 UI 调用它们。用户做完一轮，
 * 回头想复习「我上次在哪儿记错了」没有任何入口。
 *
 * `ReaderPage.tsx` 已 1900+ 行、`App.tsx` 2000+ 行，按项目硬约束
 * 新增 UI 一律独立文件。
 *
 * ## 这是**只读**页面
 *
 * 与「开始复习」「错题巩固」都不同：
 *  - 不做题、不判分
 *  - 不写 `reviewLogs` / `reviewRecords`
 *  - 不改任何复习进度
 *
 * 它只是把已经存下来的记录列出来，让人**回顾**。
 * 想真的再练一遍，从这里的「去原文」跳回去，或用错题页。
 *
 * ## 为什么按「判定」而不是按资料分组
 *
 * 用户来这里的目的只有一个：「我上次错在哪」。
 * 按资料分组时，一个资料下几十条记录混在一起，看不出错法分布。
 * 按判定分组（记错了 / 理解偏了）直接对上他的问题。
 */

export interface OralReviewServiceLike {
  list: () => Promise<OralReviewRecord[]>;
  recentStats: (days?: number) => Promise<{
    memory: number;
    understanding: number;
    correct: number;
    total: number;
  }>;
}

export interface OralReviewArchiveProps {
  service: OralReviewServiceLike;
  /** 去原文那一页（有出处时才有这个按钮） */
  onOpenSource?: (sourceId: string, page: number | null) => void;
  /** 删一条（可选：不传就不显示删除按钮） */
  onRemove?: (id: string) => Promise<void>;
}

/** 统计窗口：与 recentStats 的默认值一致 */
const DAYS = 7;

export function OralReviewArchive({ service, onOpenSource, onRemove }: OralReviewArchiveProps) {
  const [rows, setRows] = useState<OralReviewRow[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<OralFilter>('all');
  /** 展开的那一条（就地展开，和统计页今日明细同一个交互） */
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [records, stats] = await Promise.all([service.list(), service.recentStats(DAYS)]);
      setRows(toRows(records));
      setSummary(summaryText(stats, DAYS));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出记录');
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      if (!onRemove) return;
      setRemoving(id);
      try {
        await onRemove(id);
        setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
        if (openId === id) setOpenId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '删除失败');
      } finally {
        setRemoving(null);
      }
    },
    [onRemove, openId],
  );

  if (error) {
    return (
      <div className="oral-archive">
        <p className="oral-archive__error">
          {error}
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            重试
          </button>
        </p>
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="oral-archive">
        <p className="oral-archive__loading">正在读记录…</p>
      </div>
    );
  }

  const shown = filterRows(rows, filter);
  const wrongCount = rows.filter((r) => r.verdict !== 'correct').length;

  return (
    <div className="oral-archive">
      <header className="oral-archive__head">
        <div>
          <h1 className="oral-archive__title">提问式复习 · 记录回看</h1>
          <p className="oral-archive__sub">
            {summary}
            {rows.length > 0 ? ' 这里只是回顾，不会改任何复习进度。' : ''}
          </p>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="oral-archive__empty">
          <p>还没有提问式复习的记录。</p>
          <p className="oral-archive__hint">
            去「复习巩固」里选一条材料让 AI 提问，答完可以保存记录，之后会出现在这里。
          </p>
        </div>
      ) : (
        <>
          <div className="oral-archive__filters">
            <button
              type="button"
              className={`oral-archive__filter${filter === 'all' ? ' oral-archive__filter--on' : ''}`}
              onClick={() => {
                setFilter('all');
                setOpenId(null);
              }}
            >
              全部 <span className="oral-archive__n">{rows.length}</span>
            </button>
            <button
              type="button"
              className={`oral-archive__filter${filter === 'wrong' ? ' oral-archive__filter--on' : ''}`}
              onClick={() => {
                setFilter('wrong');
                setOpenId(null);
              }}
            >
              只看答错的 <span className="oral-archive__n">{wrongCount}</span>
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="oral-archive__hint">这段时间全部答对了，没有答错的记录。</p>
          ) : (
            <ul className="oral-archive__list">
              {shown.map((row) => {
                const open = openId === row.id;
                const anchor = anchorText(row);
                return (
                  <li key={row.id} className="oral-archive__item">
                    <button
                      type="button"
                      className="oral-archive__row"
                      onClick={() => setOpenId(open ? null : row.id)}
                      aria-expanded={open}
                    >
                      <span className={`oral-archive__verdict oral-archive__verdict--${row.verdict}`}>
                        {VERDICT_LABEL[row.verdict]}
                      </span>
                      <span className="oral-archive__question">{row.question}</span>
                      <span className="oral-archive__meta">
                        {row.whenText}
                        {row.scopeLabel ? ` · ${row.scopeLabel}` : ''}
                      </span>
                    </button>

                    {open ? (
                      <div className="oral-archive__detail">
                        <section className="oral-archive__block">
                          <h3 className="oral-archive__block-title">你当时的回答</h3>
                          <p className="oral-archive__answer">
                            {row.answer.trim() || '（没有作答）'}
                          </p>
                        </section>

                        <section className="oral-archive__block">
                          <h3 className="oral-archive__block-title">判定</h3>
                          <p className="oral-archive__advice">{VERDICT_ADVICE[row.verdict]}</p>
                          {row.explanation ? (
                            <p className="oral-archive__explain">{row.explanation}</p>
                          ) : null}
                          {row.correction ? (
                            <p className="oral-archive__correction">
                              <span className="oral-archive__correction-label">正确说法：</span>
                              {row.correction}
                            </p>
                          ) : null}
                        </section>

                        {/*
                          原文依据：这是防止「把 AI 编的话当教材原话」的唯一关口。
                          引文为空、或校验没过，都必须明确标出来 ——
                          否则用户会把一个可能编造的结论当成权威。
                        */}
                        <section className="oral-archive__block">
                          <h3 className="oral-archive__block-title">原文依据</h3>
                          {row.quotedFromSource ? (
                            <p className="oral-archive__quote">{row.quotedFromSource}</p>
                          ) : (
                            <p className="oral-archive__hint">（它没有给出原文依据）</p>
                          )}
                          {needsQuoteWarning(row) ? (
                            <p className="oral-archive__warn">
                              这段依据没能在原文里核对到 —— 可能是模型自己写的，别当成教材原话。
                            </p>
                          ) : row.quoteVerified ? (
                            <p className="oral-archive__verified">✓ 已在原文中核对到</p>
                          ) : null}
                        </section>

                        {row.fullText ? (
                          <section className="oral-archive__block">
                            <h3 className="oral-archive__block-title">完整原文（保存时留的）</h3>
                            <p className="oral-archive__fulltext">{row.fullText}</p>
                          </section>
                        ) : null}

                        <div className="oral-archive__actions">
                          {anchor && onOpenSource && row.sourceId ? (
                            <button
                              type="button"
                              className="btn-text"
                              onClick={() => onOpenSource(row.sourceId!, row.page)}
                            >
                              {anchor} →
                            </button>
                          ) : null}
                          {onRemove ? (
                            <button
                              type="button"
                              className="btn-text oral-archive__del"
                              disabled={removing === row.id}
                              onClick={() => void remove(row.id)}
                            >
                              {removing === row.id ? '删除中…' : '删掉这条记录'}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
