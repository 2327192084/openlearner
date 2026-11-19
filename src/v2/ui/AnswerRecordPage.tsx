/**
 * 「答疑记录」页（2026-11-19）。
 *
 * ## 它把两个功能合成一处
 *
 * | 功能 | 原来的记录页 |
 * |---|---|
 * | 提问式复习 | 「提问复习记录」 |
 * | 答错补充讲解 | **没有**（讲解存在题目里，用户找不到） |
 *
 * 对用户来说这是同一件事：**我不懂 → 问 → 得到解释**。
 * 分开两处，想「我之前问过什么」要翻两个地方；而讲解那份根本没有入口。
 *
 * ## 为什么只在展示层合并
 *
 * 两类记录的字段差别很大（提问有「记错/理解偏」判定，讲解有「讲法」与
 * 「你选了什么」）。强行合并成一张表要么丢字段，要么要迁移用户已有的
 * 真实记录。这里只读取 + 归一，两份数据原样保留 —— 见 `answer-record.ts`。
 *
 * ## 为什么单独一个文件
 *
 * 硬约束 10：新增 UI 一律独立文件。这个页面本身有筛选、列表、跳转三块，
 * 塞进 App.tsx（2700+ 行）会让那个文件继续膨胀。
 */

import { useMemo, useState } from 'react';
import type { AnswerFilter, AnswerRecordRow } from '@/v2/core/answer-record.ts';
import { countBySource, filterAnswerRows } from '@/v2/core/answer-record.ts';
import { MathText } from './MathText.tsx';

export interface AnswerRecordPageProps {
  /** 已合并排序好的记录（时间倒序） */
  rows: readonly AnswerRecordRow[];
  /** 去原文那一页（提问记录用） */
  onOpenSourceAt?: (sourceId: string, page: number, quote?: string) => void;
  /** 回那道题（讲解用） */
  onOpenQuestion?: (questionId: string) => void;
  /** 删一条提问记录（讲解不支持在这里删，它属于题目） */
  onRemoveOral?: (id: string) => Promise<void>;
}

const SOURCE_LABEL: Record<AnswerFilter, string> = {
  all: '全部',
  oral: '提问复习',
  'wrong-explain': '错题讲解',
};

export function AnswerRecordPage({
  rows,
  onOpenSourceAt,
  onOpenQuestion,
  onRemoveOral,
}: AnswerRecordPageProps) {
  const [filter, setFilter] = useState<AnswerFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => countBySource(rows), [rows]);
  const visible = useMemo(() => filterAnswerRows(rows, filter), [rows, filter]);

  return (
    <div className="ansrec-page">
      <header className="ansrec-head">
        <h1 className="ansrec-title">答疑记录</h1>
        <p className="ansrec-lead">
          你问过的、系统答过的都在这里：提问式复习的问答，和做错题之后针对那次错误要的讲解。
        </p>
      </header>

      {/*
        来源分类页签（2026-11-19 晚改）。

        ## 原来哪里不对

        原来条件是 `counts.oral > 0 && counts['wrong-explain'] > 0` ——
        两个来源**都有记录**时才显示。用户真实库 `oralReviews` 是 0 条，
        所以他从未见过这排页签，看到的就是一份没有分类的平铺记录。
        用户原话：「答疑记录应该继续分类，一个是提问式复习的记录，
        一个是错题答疑的记录」。

        ## 现在怎么改

        只要**有任何一条记录**就显示页签，两个来源各一个固定入口。
        计数为 0 的那个仍然可点（点进去说明这一类还没有记录），
        因为「这里应该有第二类，只是我还没用过」本身就是有用信息 ——
        藏起来反而让人以为功能不存在。

        一条记录都没有时不出页签（整页都是空态，页签点了也没内容）。
      */}
      {counts.all > 0 ? (
        <div className="ansrec-tabs" role="tablist" aria-label="来源">
          {(['all', 'oral', 'wrong-explain'] as AnswerFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`ansrec-tab${filter === f ? ' ansrec-tab--on' : ''}${
                counts[f] === 0 ? ' ansrec-tab--empty' : ''
              }`}
              onClick={() => setFilter(f)}
            >
              {SOURCE_LABEL[f]}
              <span className="ansrec-tab__n">{counts[f]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="ansrec-empty">
          {/*
            空态要说清「这一类没有」还是「一条都没有」——
            用户点了「提问复习」看到「还没有答疑记录」会以为整页坏了。
          */}
          <p>
            {counts.all === 0
              ? '还没有答疑记录。'
              : `「${SOURCE_LABEL[filter]}」这一类还没有记录。`}
          </p>
          <p className="ansrec-hint">
            两种方式会产生记录：在做题页答错后点「针对这个错误讲一遍」；
            或在「复习巩固」里用提问式复习问我一段材料。
          </p>
          {counts.all > 0 && filter !== 'all' ? (
            <button type="button" className="btn-text" onClick={() => setFilter('all')}>
              看全部记录（{counts.all}）→
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="ansrec-list">
          {visible.map((r) => (
            <li key={r.key} className={`ansrec-item ansrec-item--${r.source}`}>
              <div className="ansrec-item__head">
                <span className={`ansrec-badge ansrec-badge--${r.source}`}>{r.badge}</span>
                <span className="ansrec-item__title">
                  <MathText text={r.title} />
                </span>
                <span className="ansrec-item__time">{formatWhen(r.at)}</span>
              </div>

              {r.asked ? (
                <p className="ansrec-item__asked">
                  <span className="ansrec-item__k">我问了</span>
                  <MathText text={r.asked} />
                </p>
              ) : null}

              <div className="ansrec-item__answered">
                {r.answered.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>
                    <MathText text={para} />
                  </p>
                ))}
              </div>

              {r.extra ? (
                <p className="ansrec-item__extra">
                  <MathText text={r.extra} />
                </p>
              ) : null}

              <div className="ansrec-item__acts">
                {/* 讲解 → 回那道题；提问 → 回原文那一页。两者都「跳回现场」 */}
                {r.source === 'wrong-explain' && r.questionId && onOpenQuestion ? (
                  <button
                    type="button"
                    className="btn-text"
                    onClick={() => onOpenQuestion(r.questionId!)}
                  >
                    回那道题 →
                  </button>
                ) : null}
                {r.source === 'oral' && r.sourceId && onOpenSourceAt ? (
                  <button
                    type="button"
                    className="btn-text"
                    onClick={() => onOpenSourceAt(r.sourceId!, r.page ?? 1)}
                  >
                    回原文 →
                  </button>
                ) : null}
                {r.source === 'oral' && onRemoveOral ? (
                  <button
                    type="button"
                    className="btn-text ansrec-item__del"
                    disabled={busy === r.key}
                    onClick={() => {
                      /*
                       * 二次确认：删了不可恢复，而这条记录可能是用户
                       * 唯一还记得「我当时怎么想的」的地方。
                       */
                      if (!window.confirm('删掉这条提问记录？删了不能恢复。')) return;
                      setBusy(r.key);
                      void onRemoveOral(r.key.replace(/^oral-/, '')).finally(() => setBusy(null));
                    }}
                  >
                    {busy === r.key ? '删除中…' : '删除'}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 时间显示：今天只给时分，更早给月-日 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}