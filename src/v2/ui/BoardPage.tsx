/**
 * 待办看板。
 *
 * ## 为什么叫「看板」但只有一个列表
 *
 * 原页面名是「待办看板」，暗示三列 Kanban（待办/进行中/已完成）。
 * 但学习任务的真实形态是「做完了 / 没做完」—— 加一个「进行中」只会
 * 让用户多拖一次鼠标，而不会多获得信息。
 *
 * 所以这里做成：顶部一个输入框（最快地记一件事）、中间未完成列表、
 * 底部折叠的已完成区。**逾期用赭黄标出来**，靠视觉而不是靠排序表达。
 *
 * ## 为什么截止日是可选的
 *
 * 大多数学习任务没有硬截止日（「有空复习一下第四章」）。
 * 强制填日期会让人干脆不记 —— 而不记的代价比日期不准大得多。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Todo } from '@/core/model.ts';
import type { TodoService } from '@/core/todos.ts';
import { todayUtc } from '@/v2/core/srs.ts';

export interface BoardPageProps {
  todos: TodoService;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: Todo[] };

export function BoardPage({ todos }: BoardPageProps) {
  const today = todayUtc();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  /** 正在改标题的那条 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

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
  const pending = useMemo(() => items.filter((t) => !t.done), [items]);
  const done = useMemo(() => items.filter((t) => t.done), [items]);
  const overdue = useMemo(
    () => pending.filter((t) => t.dueAt !== null && t.dueAt < today),
    [pending, today],
  );

  async function add() {
    const title = draft.trim();
    if (title.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await todos.create({ title, dueAt: draftDue || null });
      setDraft('');
      setDraftDue('');
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

      {/* ---- 快速添加 ---- */}
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
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => void add()}
          disabled={busy || draft.trim().length === 0}
        >
          添加
        </button>
      </div>

      {/* ---- 概览 ---- */}
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
      </div>

      {/* ---- 未完成 ---- */}
      {pending.length === 0 ? (
        <p className="bd-empty">
          {items.length === 0 ? '还没有待办。上面写一件，回车就行。' : '未完成的都清空了。'}
        </p>
      ) : (
        <ul className="bd-list">
          {pending.map((t) => {
            const isOverdue = t.dueAt !== null && t.dueAt < today;
            const isToday = t.dueAt === today;
            return (
              <li
                key={t.id}
                className={`bd-item${isOverdue ? ' bd-item--overdue' : ''}`}
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

      {/* ---- 已完成（折叠） ---- */}
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
