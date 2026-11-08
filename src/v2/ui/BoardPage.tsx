/**
 * 待办。
 *
 * ## 为什么只有一个列表，不搞三列看板
 *
 * 原页面名是「待办看板」，暗示三列 Kanban（待办/进行中/已完成）。
 * 但学习任务的真实形态是「做完了 / 没做完」—— 加一个「进行中」只会
 * 让用户多拖一次鼠标，而不会多获得信息。
 *
 * ## 为什么截止日是可选的
 *
 * 大多数学习任务没有硬截止日（「有空复习一下第四章」）。
 * 强制填日期会让人干脆不记 —— 而不记的代价比日期不准大得多。
 *
 * ## 2026-11-08 增强（用户要求「参考市面上的软件，丰富一点」）
 *
 * 加了三样，都不需要用户额外劳动：
 *  1. **学习建议**：从已有数据推导「现在该做什么」，点一下直接跳过去做。
 *     参考 StudyHub 的 `ui/study-map/next-step.js`（固定优先级状态机，
 *     纯本地计算、不调模型）。见 `study-suggestions.ts`。
 *  2. **优先级**：高/普通/低三档。为什么不是 1–5 ——
 *     学习任务的优先级本来就粗，五档是强迫用户做无意义区分。
 *  3. **标签 + 筛选**：按标签过滤。标签只是筛选用的字串，
 *     没有颜色/层级/跨对象引用，所以不建独立表。
 *
 * 番茄钟**没有**并进这一页：用户明确说「是不是新开一个功能栏最好」，
 * 我同意 —— 待办是规划，专注是执行，两种状态互斥。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Todo } from '@/core/model.ts';
import type { TodoService } from '@/core/todos.ts';
import { priorityRank } from '@/core/todos.ts';
import { todayLocal } from '@/v2/core/srs.ts';
import { suggestionsOf, type SuggestionKind } from './study-suggestions.ts';

/** 学习建议的数据来源：由外层用同一个快照算好，避免各页各算一遍 */
export interface SuggestionInput {
  decks: { id: string; title: string; total: number; done: number; wrong: number }[];
  sourcesWithoutQuestions: number;
  wrongTotal: number;
}

export interface BoardPageProps {
  todos: TodoService;
  /** 学习建议点「去做」时跳到哪 */
  onSuggestion: (kind: SuggestionKind) => void;
  suggestionInput: SuggestionInput;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: Todo[] };

const PRIORITY_LABEL: Record<'high' | 'normal' | 'low', string> = {
  high: '高',
  normal: '普通',
  low: '低',
};

export function BoardPage({ todos, onSuggestion, suggestionInput }: BoardPageProps) {
  const today = todayLocal();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const [draftPriority, setDraftPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [draftTags, setDraftTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  /** 正在改标题的那条 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  /** 标签筛选：空字符串 = 全部 */
  const [tagFilter, setTagFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', items: await todos.list() });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : '读不出待办',
      });
    }
  }, [todos]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = state.kind === 'ready' ? state.items : [];

  /** 所有出现过的标签（供筛选器） */
  const allTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of items) {
      for (const tag of t.tags ?? []) {
        const k = tag.toLowerCase();
        if (!seen.has(k)) seen.set(k, tag);
      }
    }
    return [...seen.values()].sort();
  }, [items]);

  const filtered = useMemo(() => {
    if (!tagFilter) return items;
    const k = tagFilter.toLowerCase();
    return items.filter((t) => (t.tags ?? []).some((tag) => tag.toLowerCase() === k));
  }, [items, tagFilter]);

  const pending = useMemo(() => filtered.filter((t) => !t.done), [filtered]);
  const done = useMemo(() => filtered.filter((t) => t.done), [filtered]);
  const overdue = useMemo(
    () => pending.filter((t) => t.dueAt !== null && t.dueAt < today),
    [pending, today],
  );

  /** 学习建议：从已有数据推导（不落库，做完自然消失） */
  const suggestions = useMemo(
    () =>
      state.kind === 'ready'
        ? suggestionsOf({ ...suggestionInput, todos: state.items })
        : [],
    [state, suggestionInput],
  );

  function parseTags(raw: string): string[] {
    // 逗号、空格、中英文顿号都当分隔符 —— 用户不会记得只能用一种
    return raw.split(/[,，\s、]+/).filter((s) => s.trim().length > 0);
  }

  async function add() {
    const title = draft.trim();
    if (title.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await todos.create({
        title,
        dueAt: draftDue || null,
        priority: draftPriority,
        tags: parseTags(draftTags),
      });
      setDraft('');
      setDraftDue('');
      setDraftTags('');
      setDraftPriority('normal');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string) {
    setBusy(true);
    try {
      await todos.toggle(id, today);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    setBusy(true);
    try {
      await todos.update(id, { title: editDraft });
      setEditingId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function cyclePriority(t: Todo) {
    const order: ('high' | 'normal' | 'low')[] = ['high', 'normal', 'low'];
    const cur = t.priority ?? 'normal';
    const next = order[(order.indexOf(cur) + 1) % order.length]!;
    setBusy(true);
    try {
      await todos.update(t.id, { priority: next });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '改优先级失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await todos.remove(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function clearDone() {
    setBusy(true);
    try {
      await todos.clearDone();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '清理失败');
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="board-page">
        <p className="bd-hint">正在读待办…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="board-page">
        <p className="bd-error">{state.message}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="board-page">
      <header className="bd-head">
        <h1 className="bd-title">待办</h1>
        <p className="bd-lead">
          记下「这周要做什么」。不限期也可以 —— 大多数学习任务本来就没有硬截止日。
          逾期的会单独标出来，不会因为排序靠后就消失。
        </p>
      </header>

      {err ? <p className="bd-error">{err}</p> : null}

      {/* ==================== 学习建议 ==================== */}
      {suggestions.length > 0 ? (
        <section className="bd-suggest">
          <h2 className="bd-h2">现在可以做</h2>
          <p className="bd-suggest__lead">
            这些不是你记的，是根据题库现状算出来的 —— 做完了就不会再出现。
          </p>
          <ul className="bd-suggest__list">
            {suggestions.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  className="bd-suggest__item"
                  onClick={() => onSuggestion(s.kind)}
                >
                  <span className="bd-suggest__main">
                    <span className="bd-suggest__title">{s.title}</span>
                    <span className="bd-suggest__reason">{s.reason}</span>
                  </span>
                  {s.detail ? <span className="bd-suggest__detail">{s.detail}</span> : null}
                  <span className="bd-suggest__go" aria-hidden="true">
                    去做 →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ==================== 快速添加 ==================== */}
      <div className="bd-add">
        <input
          className="bd-input"
          type="text"
          placeholder="要做什么？回车即可添加"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          disabled={busy}
        />
        <div className="bd-add__row">
          <label className="bd-due">
            <span className="bd-due__label">截止日</span>
            <input
              className="bd-date"
              type="date"
              value={draftDue}
              onChange={(e) => setDraftDue(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="bd-due">
            <span className="bd-due__label">优先级</span>
            <select
              className="bd-select"
              value={draftPriority}
              onChange={(e) => setDraftPriority(e.target.value as 'high' | 'normal' | 'low')}
              disabled={busy}
            >
              <option value="high">高</option>
              <option value="normal">普通</option>
              <option value="low">低</option>
            </select>
          </label>

          <label className="bd-due bd-due--grow">
            <span className="bd-due__label">标签</span>
            <input
              className="bd-input bd-input--tag"
              type="text"
              placeholder="用逗号分隔，如：数学, 第3章"
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              disabled={busy}
            />
          </label>

          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => void add()}
            disabled={busy || draft.trim().length === 0}
          >
            添加
          </button>
        </div>
      </div>

      {/* ==================== 标签筛选 ==================== */}
      {allTags.length > 0 ? (
        <div className="bd-filters" role="group" aria-label="按标签筛选">
          <button
            type="button"
            className={`bd-chip${tagFilter === '' ? ' bd-chip--on' : ''}`}
            aria-pressed={tagFilter === ''}
            onClick={() => setTagFilter('')}
          >
            全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`bd-chip${tagFilter.toLowerCase() === tag.toLowerCase() ? ' bd-chip--on' : ''}`}
              aria-pressed={tagFilter.toLowerCase() === tag.toLowerCase()}
              onClick={() => setTagFilter(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {/* ==================== 概览 ==================== */}
      <div className="bd-stats">
        <span className="bd-stat">
          <span className="bd-stat__n">{pending.length}</span>
          <span className="bd-stat__label">件未完成</span>
        </span>
        {overdue.length > 0 ? (
          <span className="bd-stat bd-stat--warn">
            <span className="bd-stat__n">{overdue.length}</span>
            <span className="bd-stat__label">件已逾期</span>
          </span>
        ) : null}
        {pending.filter((t) => t.priority === 'high').length > 0 ? (
          <span className="bd-stat bd-stat--bad">
            <span className="bd-stat__n">{pending.filter((t) => t.priority === 'high').length}</span>
            <span className="bd-stat__label">件高优先级</span>
          </span>
        ) : null}
      </div>

      {/* ==================== 未完成 ==================== */}
      {pending.length === 0 ? (
        <p className="bd-empty">
          {items.length === 0
            ? '还没有待办。上面写一件，回车就行。'
            : tagFilter
              ? `标签「${tagFilter}」下没有未完成的。`
              : '未完成的都清空了。'}
        </p>
      ) : (
        <ul className="bd-list">
          {pending.map((t) => {
            const isOverdue = t.dueAt !== null && t.dueAt < today;
            const isToday = t.dueAt === today;
            const prio = t.priority ?? 'normal';
            return (
              <li
                key={t.id}
                className={`bd-item bd-item--p${priorityRank(t)}${isOverdue ? ' bd-item--overdue' : ''}`}
              >
                <input
                  className="bd-check"
                  type="checkbox"
                  checked={t.done}
                  onChange={() => void toggle(t.id)}
                  disabled={busy}
                  aria-label={`完成「${t.title}」`}
                />

                {editingId === t.id ? (
                  <>
                    <input
                      className="bd-input bd-input--inline"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit(t.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => void saveEdit(t.id)}
                      disabled={busy}
                    >
                      保存
                    </button>
                    <button type="button" className="btn-text" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    {/*
                      优先级做成按钮：点一下就在 高→普通→低 之间循环。
                      为什么不用下拉框：这一栏很窄，下拉框会挤掉标题；
                      而且改优先级是高频小动作，一次点击比「展开→选→收起」顺手。
                    */}
                    <button
                      type="button"
                      className={`bd-prio bd-prio--${prio}`}
                      onClick={() => void cyclePriority(t)}
                      disabled={busy}
                      title="点一下切换优先级（高 → 普通 → 低）"
                      aria-label={`优先级：${PRIORITY_LABEL[prio]}，点击切换`}
                    >
                      {PRIORITY_LABEL[prio]}
                    </button>

                    <span
                      className="bd-item__title"
                      onDoubleClick={() => {
                        setEditingId(t.id);
                        setEditDraft(t.title);
                      }}
                      title="双击改标题"
                    >
                      {t.title}
                    </span>

                    {(t.tags ?? []).length > 0 ? (
                      <span className="bd-item__tags">
                        {(t.tags ?? []).map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="bd-tag"
                            onClick={() => setTagFilter(tag)}
                            title={`筛出标签「${tag}」`}
                          >
                            {tag}
                          </button>
                        ))}
                      </span>
                    ) : null}

                    {t.dueAt ? (
                      <span
                        className={`bd-item__due${isOverdue ? ' bd-item__due--overdue' : ''}${
                          isToday ? ' bd-item__due--today' : ''
                        }`}
                      >
                        {isOverdue ? '已逾期 · ' : isToday ? '今天 · ' : ''}
                        {t.dueAt}
                      </span>
                    ) : (
                      <span className="bd-item__due bd-item__due--none">不限期</span>
                    )}
                    <button
                      type="button"
                      className="bd-item__del"
                      onClick={() => void remove(t.id)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ==================== 已完成（折叠） ==================== */}
      {done.length > 0 ? (
        <section className="bd-done">
          <button
            type="button"
            className="bd-done__toggle"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
          >
            <span className="bd-caret" aria-hidden="true">
              {showDone ? '▾' : '▸'}
            </span>
            已完成 {done.length} 件
          </button>

          {showDone ? (
            <>
              <ul className="bd-list bd-list--done">
                {done.map((t) => (
                  <li key={t.id} className="bd-item bd-item--done">
                    <input
                      className="bd-check"
                      type="checkbox"
                      checked
                      onChange={() => void toggle(t.id)}
                      disabled={busy}
                      aria-label={`取消完成「${t.title}」`}
                    />
                    <span className="bd-item__title">{t.title}</span>
                    {t.doneAt ? <span className="bd-item__due">{t.doneAt} 完成</span> : null}
                    <button
                      type="button"
                      className="bd-item__del"
                      onClick={() => void remove(t.id)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn-text bd-clear"
                onClick={() => void clearDone()}
                disabled={busy}
              >
                清掉全部已完成
              </button>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
