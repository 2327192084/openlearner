/**
 * 「记一笔」：挂在某张卡片/某份资料上的笔记输入区。
 *
 * ## 为什么做成独立组件
 *
 * 两个地方要用它：做题页（挂在当前题目上）、阅读器（挂在资料上）。
 * 复制两份会导致「一边能改一边不能改」这种半好半坏的状态 ——
 * 项目里已经因为复制粘贴出过「备份能下载、PPT 下载不了」的问题。
 *
 * ## 交互设计取舍
 *
 * 默认收起成一行「记一笔」，点了才展开输入框。
 *
 * 为什么不常驻展开：做题页的主角是题目，一个常驻的大文本框会抢走注意力，
 * 而且用户大多数时候并不会写笔记 —— 每次都要看一块空框很烦。
 * 但已有笔记时**默认展开显示**，因为那说明他写过、回来看时应该看得见。
 */

import { useCallback, useEffect, useState } from 'react';
import type { Note } from '@/core/model.ts';
import type { NoteService } from '@/core/notes.ts';

export interface NoteBoxProps {
  notes: NoteService;
  /** 挂在卡片上（题目/知识点 id） */
  cardId?: string | null;
  /** 挂在资料上 */
  sourceId?: string | null;
  /** 标题文案，默认「记一笔」 */
  label?: string;
}

export function NoteBox({ notes, cardId, sourceId, label = '记一笔' }: NoteBoxProps) {
  const [list, setList] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const ownerKey = `${cardId ?? ''}|${sourceId ?? ''}`;

  const reload = useCallback(async () => {
    try {
      const all = cardId ? await notes.listByCard(cardId) : sourceId ? await notes.listBySource(sourceId) : [];
      setList(all);
      /*
       * 已有笔记时默认展开 —— 用户写过东西，回来看时应该直接看得见，
       * 而不是每次都要再点一下「记一笔」才发现里面有内容。
       */
      if (all.length > 0) setOpen(true);
    } catch {
      /* 读不到就当没有，不打断做题 */
    }
  }, [notes, cardId, sourceId]);

  /* ownerKey 变化（换题/换资料）时重读 */
  useEffect(() => {
    setDraft('');
    setEditingId(null);
    setOpen(false);
    setList([]);
    void reload();
  }, [ownerKey, reload]);

  async function save() {
    const body = draft.trim();
    if (body.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      if (editingId) {
        await notes.update(editingId, body);
      } else {
        await notes.create({ cardId: cardId ?? null, sourceId: sourceId ?? null, body });
      }
      setDraft('');
      setEditingId(null);
      await reload();
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await notes.remove(id);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notebox">
      <button
        type="button"
        className="notebox__toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="notebox__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {label}
        {list.length > 0 ? <span className="notebox__count">{list.length}</span> : null}
      </button>

      {open ? (
        <div className="notebox__body">
          {list.map((n) => (
            <div key={n.id} className="notebox__item">
              {editingId === n.id ? (
                <>
                  <textarea
                    className="notebox__input"
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="notebox__actions">
                    <button
                      type="button"
                      className="btn-fill btn-fill--sm"
                      onClick={() => void save()}
                      disabled={busy || draft.trim().length === 0}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => {
                        setEditingId(null);
                        setDraft('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="notebox__text">{n.body}</p>
                  <div className="notebox__actions">
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => {
                        setEditingId(n.id);
                        setDraft(n.body);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="notebox__delete"
                      onClick={() => void remove(n.id)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}

          {/* 新建（不在编辑某条时） */}
          {editingId === null ? (
            <>
              <textarea
                className="notebox__input"
                rows={2}
                placeholder="写点什么…（只记给自己看，不上传）"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
              />
              <div className="notebox__actions">
                <button
                  type="button"
                  className="btn-fill btn-fill--sm"
                  onClick={() => void save()}
                  disabled={busy || draft.trim().length === 0}
                >
                  {busy ? '保存中…' : '保存笔记'}
                </button>
              </div>
            </>
          ) : null}

          {err ? <p className="notebox__err">{err}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
