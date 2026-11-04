import { useEffect, useState } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import {
  TEXT_STATUS_LABEL,
  formatBytes,
  formatPageCount,
  formatTime,
  kindLabel,
} from './format.ts';
import { describeError, hintFrom } from './types.ts';

/**
 * 资料详情（抽屉）。
 *
 * 做成阅读器里的抽屉而不是单独路由，理由和阅读器本身一样：
 * 注册表不支持子路由。抽屉还省掉一次页面跳转 ——
 * 用户想「看看这份文件多大、什么时候导的」时，不该丢掉正在读的那一页。
 *
 * 删除入口只放这里（不放列表行），减少误触；但确认框必须把连带影响说全。
 */
export function SourceDetailDrawer({
  source,
  service,
  open,
  onClose,
  onDeleted,
}: {
  source: Source;
  service: SourceService;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  /*
   * Esc 关闭。
   *
   * 抽屉是 aria-modal 的模态层，键盘用户按 Esc 应该能退出 ——
   * 只给鼠标点遮罩，等于把键盘用户困在里面。
   * 删除进行中不许 Esc：避免「以为取消了，其实已经删了」。
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (busy) return;
      e.preventDefault();
      if (confirming) {
        // 有确认块时先退掉确认，再按一次才关抽屉
        setConfirming(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, confirming, onClose]);

  if (!open) return null;

  const status = TEXT_STATUS_LABEL[source.textStatus];

  const handleRemove = async () => {
    // 不用 window.confirm 也行，但 P1 明确要求「删除时提示关联影响」。
    // 这里用页内确认块而不是原生弹窗：原生弹窗在 Electron 里样式不可控，
    // 也无法多行排版把「知识点和题目也会受影响」说清楚。
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await service.remove(source.id);
      onDeleted();
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(err, '资料没有被删掉。可以返回列表确认一下；重试仍失败时刷新页面再试。'),
      });
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="source-detail-title">
      <div className="drawer__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="drawer__panel">
        <div className="drawer__head">
          <h3 className="drawer__title" id="source-detail-title">
            资料详情
          </h3>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="drawer__body page__stack">
          <div>
            <div className="drawer__source-title">{source.title}</div>
            <div className="page__row" style={{ marginTop: 'var(--sp-2)' }}>
              <Badge tone="neutral">{kindLabel(source.kind)}</Badge>
              <Badge tone={status.tone}>{status.text}</Badge>
            </div>
          </div>

          <dl className="dl">
            <dt>文件名</dt>
            <dd>{source.fileName ?? '（粘贴的文字，没有文件）'}</dd>
            <dt>类型</dt>
            <dd>
              {kindLabel(source.kind)}（{source.kind}）
            </dd>
            <dt>页数</dt>
            <dd>{formatPageCount(source.pageCount)}</dd>
            <dt>大小</dt>
            <dd>
              {formatBytes(source.byteSize)}
              {source.fileName === null ? (
                <span className="page__muted">（粘贴文本为编码后的字节数）</span>
              ) : null}
            </dd>
            <dt>切分段数</dt>
            <dd>{source.segmentCount} 段</dd>
            <dt>文本状态</dt>
            <dd>
              {status.text}
              <div className="field__hint" style={{ marginTop: 'var(--sp-1)' }}>
                {status.hint}
              </div>
            </dd>
            <dt>导入时间</dt>
            <dd>{formatTime(source.createdAt)}</dd>
            <dt>最后更新</dt>
            <dd>{formatTime(source.updatedAt)}</dd>
            <dt>资料 ID</dt>
            <dd className="page__mono">{source.id}</dd>
          </dl>

          {error ? (
            <Notice tone="danger" title="删除没有完成">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}

          <div className="drawer__danger">
            <div className="drawer__danger-title">删除这份资料</div>
            <p className="drawer__danger-text">
              会连它切分出的 <strong>{source.segmentCount} 段正文</strong>一起删掉，
              <strong>已经用它生成的知识点和题目也会受影响</strong>
              （内容会失去原文出处，无法再点回原文）。删除不能撤销。
            </p>

            {confirming ? (
              <Notice tone="danger" title="再确认一次">
                真的要删除「{source.title}」吗？这份资料的 {source.segmentCount} 段正文会一起消失，
                之后无法点回原文。<strong>这一步不能撤销。</strong>
              </Notice>
            ) : null}

            <div className="page__row">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void handleRemove()}
                disabled={busy}
              >
                {busy ? '删除中…' : confirming ? '确认删除，不能撤销' : '删除这份资料'}
              </button>
              {confirming ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  取消
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
