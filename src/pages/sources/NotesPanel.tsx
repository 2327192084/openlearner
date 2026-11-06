import { useCallback, useEffect, useState } from 'react';
import type { AnnotationService } from '@/core/annotation-service.ts';
import { MARK_LABELS } from '@/core/text-anchor.ts';
import type { TextMark } from '@/core/model.ts';

/**
 * 备注合集：按资料汇总所有页的标记与笔记，点击跳转。
 *
 * ## 为什么需要它
 *
 * 高亮散在 628 页里，复习时「我当初标了什么」找不到 ——
 * 这是用户对笔记工具最核心的诉求。NoteIn 把这个叫「备注合集」。
 *
 * ## 为什么放进侧栏而不是单独页面
 *
 * 复习时要「看着清单跳原文」，离不开资料本身。
 * 单独页面要来回切换，跳转体验断掉。
 */
export function NotesPanel({
  sourceId,
  service,
  open,
  onClose,
  onJump,
  /** 备注面板显示的刷新触发（保存后递增） */
  revision = 0,
}: {
  sourceId: string;
  service: AnnotationService;
  open: boolean;
  onClose: () => void;
  /** 点某条跳回对应页 */
  onJump: (page: number) => void;
  revision?: number;
}) {
  const [items, setItems] = useState<
    { page: number; marks: TextMark[]; inkCount: number; noteCount: number }[] | null
  >(null);

  const load = useCallback(async () => {
    const all = await service.listForSource(sourceId);
    const byPage = new Map<number, { marks: TextMark[]; inkCount: number; noteCount: number }>();

    for (const a of all) {
      const marks = a.textMarks ?? [];
      const inkCount = a.strokes.length;
      const noteCount = a.texts.length;
      if (marks.length === 0 && inkCount === 0 && noteCount === 0) continue;

      const cur = byPage.get(a.page) ?? { marks: [], inkCount: 0, noteCount: 0 };
      cur.marks.push(...marks);
      cur.inkCount += inkCount;
      cur.noteCount += noteCount;
      byPage.set(a.page, cur);
    }

    setItems(
      [...byPage.entries()]
        .map(([page, v]) => ({ page, ...v }))
        .sort((a, b) => a.page - b.page),
    );
  }, [service, sourceId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, revision]);

  if (!open) return null;

  const totalMarks = items?.reduce((n, i) => n + i.marks.length, 0) ?? 0;

  return (
    <aside className="notes-panel" aria-label="备注合集">
      <div className="notes-panel__head">
        <strong>备注合集</strong>
        <span className="page__muted">
          {items === null ? '读取中…' : `${totalMarks} 条标记 · ${items.length} 页`}
        </span>
        <button type="button" className="btn btn--sm" onClick={onClose} aria-label="关闭备注合集">
          ×
        </button>
      </div>

      {items === null ? (
        <div className="page__muted" style={{ padding: 'var(--sp-3)' }}>
          正在读取…
        </div>
      ) : items.length === 0 ? (
        <div className="notes-panel__empty">
          这份资料还没有标记。
          <br />
          <span className="page__muted">
            选中正文里的文字就能加高亮；也可以用画笔直接在页面上写。
          </span>
        </div>
      ) : (
        <ul className="notes-panel__list">
          {items.map((item) => (
            <li key={item.page} className="notes-panel__page">
              <button
                type="button"
                className="notes-panel__page-head"
                onClick={() => onJump(item.page)}
                title={`跳到第 ${item.page} 页`}
              >
                第 {item.page} 页
                <span className="page__muted">
                  {item.marks.length > 0 ? `${item.marks.length} 标记` : ''}
                  {item.inkCount > 0 ? ` · ${item.inkCount} 笔` : ''}
                  {item.noteCount > 0 ? ` · ${item.noteCount} 文本` : ''}
                </span>
              </button>

              {item.marks.length > 0 ? (
                <ul className="notes-panel__marks">
                  {item.marks.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={`notes-panel__mark notes-panel__mark--${m.kind}`}
                        onClick={() => onJump(m.anchor.page)}
                        title={`${MARK_LABELS[m.kind]}：${m.anchor.exact}`}
                      >
                        <span className="notes-panel__mark-kind">{MARK_LABELS[m.kind]}</span>
                        <span className="notes-panel__mark-text">{m.anchor.exact}</span>
                        {m.note ? (
                          <span className="notes-panel__mark-note">{m.note}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
