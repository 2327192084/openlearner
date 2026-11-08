/**
 * 回收站页面（2026-11-08）。
 *
 * ## 这一页回答什么
 *
 * 「我刚才删的东西还能拿回来吗？」——删除动作在这之前是**不可逆**的，
 * 用户误删一份整理好的资料就再也找不回来了。
 *
 * ## 几个不能省的信息
 *
 * 1. **还剩几天**：只写「30 天后删除」没用，用户想知道「我还有多久」。
 *    所以每条都算剩余天数，快过期的标出来。
 * 2. **还原后缺什么**：资料删除时原始 PDF 与插图刻意不进回收站
 *    （太占空间，且能重新生成）。这一点必须在列表里明说，
 *    否则用户还原后看到「有标题没内容」会以为还原坏了。
 * 3. **彻底删除要二次确认**：那是真的不可逆，和「移进回收站」不是一个量级。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TrashRecord } from '@/core/model.ts';
import type { TrashService } from '@/core/trash.ts';
import { hoursUntilExpiry } from '@/core/trash.ts';
import { ConfirmDialog } from './dialog.tsx';
import { IconSettings } from './icons.tsx';
import './trash-page.css';

export interface TrashPageProps {
  trash: TrashService;
  /** 还原 / 彻底删除后通知上层刷新（题数、知识点数都会变） */
  onChanged?: () => void;
}

/** 分区名 → 用户能看懂的名字 */
const KIND_LABEL: Record<string, string> = {
  sources: '资料',
  sourceSegments: '正文段',
  sourceAnnotations: '手写注释',
  knowledgePoints: '知识点',
  decks: '题组',
  questions: '题目',
  notes: '笔记',
  todos: '待办',
  generationRuns: '任务记录',
};

/** 剩余时间的可读说法 */
function remainText(rec: TrashRecord, now: number): { text: string; urgent: boolean } {
  const h = hoursUntilExpiry(rec, now);
  if (h <= 0) return { text: '即将清除', urgent: true };
  if (h < 24) return { text: `还剩 ${Math.max(1, Math.round(h))} 小时`, urgent: true };
  const days = Math.floor(h / 24);
  return { text: `还剩 ${days} 天`, urgent: days <= 3 };
}

export function TrashPage({ trash, onChanged }: TrashPageProps) {
  const [records, setRecords] = useState<TrashRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 待确认的彻底删除（单条或清空） */
  const [purging, setPurging] = useState<
    | { kind: 'one'; id: string; title: string }
    | { kind: 'all'; count: number }
    | null
  >(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  /** 用同一时刻算所有剩余时间，避免同一屏里两条差几毫秒而显示不同 */
  const now = useMemo(() => Date.now(), [records]);

  const load = useCallback(async () => {
    try {
      setRecords(await trash.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出回收站');
    }
  }, [trash]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await trash.restore(id);
        await load();
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : '还原失败');
      } finally {
        setBusy(null);
      }
    },
    [trash, load, onChanged],
  );

  const doPurge = useCallback(async () => {
    if (!purging) return;
    setBusy('purge');
    setPurgeError(null);
    try {
      if (purging.kind === 'one') await trash.purge(purging.id);
      else await trash.purgeAll();
      setPurging(null);
      await load();
      onChanged?.();
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : '彻底删除失败');
    } finally {
      setBusy(null);
    }
  }, [purging, trash, load, onChanged]);

  const list = records ?? [];
  const urgentCount = list.filter((r) => remainText(r, now).urgent).length;

  return (
    <div className="trash-page">
      <header className="trash-head">
        <h1 className="trash-title">回收站</h1>
        <p className="trash-lead">
          删掉的东西先放这里，<strong>30 天</strong>后自动彻底删除。
          期间随时可以还原。
        </p>
      </header>

      {error ? <p className="trash-error">{error}</p> : null}

      {records === null ? (
        <p className="trash-hint">正在读取…</p>
      ) : list.length === 0 ? (
        <div className="trash-empty">
          <p>回收站是空的。</p>
          <p className="trash-empty__sub">
            以后删掉的资料、知识点、题组会先放到这里，误删了可以还原。
          </p>
        </div>
      ) : (
        <>
          <div className="trash-bar">
            <span className="trash-bar__count">
              共 {list.length} 项
              {urgentCount > 0 ? (
                <span className="trash-bar__urgent"> · {urgentCount} 项即将清除</span>
              ) : null}
            </span>
            <button
              type="button"
              className="trash-btn trash-btn--danger"
              onClick={() => setPurging({ kind: 'all', count: list.length })}
            >
              清空回收站
            </button>
          </div>

          <ul className="trash-list">
            {list.map((rec) => {
              const remain = remainText(rec, now);
              return (
                <li key={rec.id} className={'trash-item' + (remain.urgent ? ' trash-item--urgent' : '')}>
                  <div className="trash-item__main">
                    <div className="trash-item__top">
                      <span className="trash-item__kind">{KIND_LABEL[rec.kind] ?? rec.kind}</span>
                      <span className="trash-item__title">{rec.title || '（无标题）'}</span>
                    </div>
                    <p className="trash-item__meta">
                      {rec.summary ? `${rec.summary} · ` : ''}
                      删除于 {new Date(rec.deletedAt).toLocaleString('zh-CN')}
                      <span className={'trash-item__remain' + (remain.urgent ? ' is-urgent' : '')}>
                        {remain.text}
                      </span>
                    </p>

                    {/*
                      还原后缺什么 —— 如实说。
                      原始 PDF 与插图刻意不进回收站（几十 MB，且都能重新生成），
                      不说的话用户还原后看到空壳会以为坏了。
                    */}
                    {rec.skipped.length > 0 ? (
                      <ul className="trash-item__skipped">
                        {rec.skipped.map((s, i) => (
                          <li key={i}>
                            <strong>{s.what}</strong> 未保留：{s.reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {rec.attachments.length > 0 ? (
                      <p className="trash-item__attach">
                        还原时一并恢复 {rec.attachments.length} 条关联内容
                        （{summarizeAttachments(rec)}）
                      </p>
                    ) : null}
                  </div>

                  <div className="trash-item__actions">
                    <button
                      type="button"
                      className="trash-btn"
                      disabled={busy !== null}
                      onClick={() => void restore(rec.id)}
                    >
                      {busy === rec.id ? '还原中…' : '还原'}
                    </button>
                    <button
                      type="button"
                      className="trash-btn trash-btn--danger"
                      disabled={busy !== null}
                      onClick={() => setPurging({ kind: 'one', id: rec.id, title: rec.title })}
                    >
                      彻底删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {purging ? (
        <ConfirmDialog
          title={
            purging.kind === 'one'
              ? '彻底删除这一项？'
              : `清空回收站（${purging.count} 项）？`
          }
          description={
            <>
              这一步<strong>不可撤销</strong>，删掉就找不回来了。
              {purging.kind === 'one' ? `「${purging.title || '无标题'}」` : ''}
              如果还想留一份，请先点「还原」。
            </>
          }
          confirmLabel={busy === 'purge' ? '正在删除…' : '彻底删除'}
          tone="danger"
          blocked={busy === 'purge'}
          onConfirm={doPurge}
          onClose={() => {
            if (busy === 'purge') return;
            setPurging(null);
            setPurgeError(null);
          }}
        >
          {purgeError ? <p className="trash-error">{purgeError}</p> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** 「3 条知识点、2 条笔记」这种概括，让用户知道会一起回来什么 */
function summarizeAttachments(rec: TrashRecord): string {
  const acc = new Map<string, number>();
  for (const a of rec.attachments) {
    acc.set(a.kind, (acc.get(a.kind) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([kind, n]) => `${n} 条${KIND_LABEL[kind] ?? kind}`)
    .join('、');
}

/** 供导航用（图标借用设置的那个，稍后如有专门的再换） */
export const TrashIcon = IconSettings;
