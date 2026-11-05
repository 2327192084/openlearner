import { useState } from 'react';
import type { SlideDeck } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, Notice } from '@/components/states.tsx';
import { downloadPptx } from './download.ts';
import {
  describeError,
  editedAfterLastExport,
  formatSize,
  formatTime,
  hintFrom,
  lastExport,
  sizeDetail,
} from './types.ts';

/**
 * 导出区。
 *
 * 只做三件事：调 `slides.export(id)`、把 buffer 交给浏览器下载、如实汇报结果。
 *
 * 两个容易写成「假成功」的地方，这里都按真实情况处理：
 *  1. **导出不等于保存成功**：`export()` 返回 buffer 后我们触发一次下载，
 *     但浏览器可能拦截下载、用户可能点了取消。所以文案是「已生成并触发下载」，
 *     并给出文件名与页数让用户自己核对，而不是断言「已保存到下载目录」。
 *  2. **导出后又改过**：改完大纲没重新导出，磁盘上的文件就是旧的。
 *     这种情况下必须在导出区顶部说清楚，否则用户拿去讲课时讲的是一份旧内容。
 */

export interface SlideExportProps {
  deck: SlideDeck;
  /** 导出会写回 exports 记录与 updatedAt，需要把新 deck 交给上层 */
  onDeck: (deck: SlideDeck) => void;
}

export function SlideExport({ deck, onDeck }: SlideExportProps) {
  const { slides } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [justExported, setJustExported] = useState<{
    fileName: string;
    slideCount: number;
    byteSize: number;
  } | null>(null);

  const onlyCover = deck.pages.length <= 1;
  const stale = editedAfterLastExport(deck);
  const latest = lastExport(deck);

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await slides.export(deck.id);
      downloadPptx(outcome.buffer, outcome.fileName);
      setJustExported({
        fileName: outcome.fileName,
        slideCount: outcome.slideCount,
        byteSize: outcome.byteSize,
      });
      // 导出写了 exports 记录和 updatedAt，重新读一次让界面对上存储里的真实状态
      const fresh = await slides.get(deck.id);
      if (fresh) onDeck(fresh);
    } catch (err) {
      setJustExported(null);
      setError({
        message: describeError(err),
        hint: hintFrom(
          err,
          '文件没有生成。先确认大纲里至少有一页正文（只有封面页导不出来），然后重试；如果仍然失败，可能是本地存储空间不足。',
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="sl-export-title">
      <div className="card__head">
        <div>
          <h3 className="card__title" id="sl-export-title">
            导出
          </h3>
          <p className="card__subtitle">
            导出为 .pptx，可以用 PowerPoint、WPS、Keynote 打开后继续改。
          </p>
        </div>
        <div className="page__row">
          <Badge tone={deck.status === 'ready' ? 'ready' : 'planned'}>
            {deck.status === 'ready' ? '已定稿' : '大纲'}
          </Badge>
        </div>
      </div>

      <div className="card__body page__stack">
        {stale && latest ? (
          <Notice tone="warning" title="导出后又改过，当前文件不是最新的">
            最近一次导出是 {formatTime(latest.exportedAt)}（{latest.fileName}），之后大纲又改过。
            如果要用最新内容讲课，请重新导出一份。
          </Notice>
        ) : null}

        {onlyCover ? (
          <Notice tone="warning" title="只有封面页，导不出来">
            现在这份大纲只有一页封面。先用上面的「末尾加页」加一页正文，或者回上一页从知识点重新生成。
          </Notice>
        ) : null}

        <div className="sl-export__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void doExport()}
            disabled={busy || onlyCover}
            title={onlyCover ? '只有封面页时无法导出' : '生成 .pptx 并触发下载'}
          >
            {busy ? '正在导出…' : '导出 .pptx'}
          </button>
          <div className="sl-export__summary">
            {latest
              ? `共导出过 ${deck.exports.length} 次，最近一次 ${formatTime(latest.exportedAt)}`
              : '还没有导出过'}
          </div>
        </div>

        {justExported ? (
          <div className="sl-export__result">
            <div className="sl-export__result-head">
              <Badge tone="ready">已生成</Badge>
              <strong>{justExported.fileName}</strong>
            </div>
            <div className="sl-export__result-meta">
              {justExported.slideCount} 页 · {formatSize(justExported.byteSize)}（{sizeDetail(justExported.byteSize)}）
            </div>
            <div className="field__hint">
              已经交给浏览器下载。如果没看到文件，检查浏览器的下载拦截提示，或者换一个下载目录再试。
            </div>
          </div>
        ) : null}

        {error ? (
          <Notice tone="danger" title="导出没有完成">
            {error.message}
            <br />
            <strong>下一步：</strong>
            {error.hint}
          </Notice>
        ) : null}

        <div className="field">
          <span className="field__label">历史导出记录（{deck.exports.length}）</span>
          {deck.exports.length === 0 ? (
            <div className="field__hint">还没有导出记录。导出的每一版都会记在这里，方便对时间。</div>
          ) : (
            <ul className="sl-export__list">
              {[...deck.exports].reverse().map((record) => (
                <li key={record.id} className="sl-export__record">
                  <span className="sl-export__record-name">{record.fileName}</span>
                  <span className="sl-export__record-meta">
                    {record.slideCount} 页 · {formatSize(record.byteSize)} · {formatTime(record.exportedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
