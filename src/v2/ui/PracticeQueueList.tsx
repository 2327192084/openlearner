/**
 * 待做题目清单（2026-11-08）。
 *
 * 用户要求：「希望点击开始复习跳转后能在开始做题的界面知道待做的有哪些题，
 * 说不定有些题已经掌握了，但还是列了进去，方便进行筛选。」
 *
 * 所以这个组件做两件事：**列出来**、**能剔掉**。
 *
 * ## 为什么默认收起
 *
 * 一进来先看到「开始复习（12 道）」这个大按钮，比先看到 12 行列表更直接。
 * 想看细节的人点开就行。这符合「默认简单、按需展开」的取舍。
 *
 * ## 为什么「已掌握」的默认不剔掉
 *
 * 算法算它到期，就有到期的道理（可能是很久没碰，怕忘）。默认不动，
 * 只在用户主动点「跳过已掌握的」时才剔 —— 不能替他做主。
 */

import type { Card } from '@/v2/core/cards.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import { MathText } from './MathText.tsx';
import { buildQueueRows, masteredIds } from './practice-queue.ts';
import './practice-queue.css';

export interface PracticeQueueListProps {
  cards: readonly Card[];
  states: ReadonlyMap<string, ReviewState>;
  today: string;
  skipped: ReadonlySet<string>;
  onToggleSkip: (cardId: string) => void;
  onSkipMastered: () => void;
  onResetSkip: () => void;
  /** 展开/收起由调用方控制，便于按钮上显示数字时保持一致 */
  open: boolean;
  onToggleOpen: () => void;
}

export function PracticeQueueList({
  cards,
  states,
  today,
  skipped,
  onToggleSkip,
  onSkipMastered,
  onResetSkip,
  open,
  onToggleOpen,
}: PracticeQueueListProps) {
  const rows = buildQueueRows(cards, states, today);
  const masteredCount = rows.filter((r) => r.mastered).length;
  const autoSkippable = masteredIds(rows, skipped).length;

  return (
    <div className="pq">
      <button type="button" className="pq__toggle" onClick={onToggleOpen}>
        <span className="pq__toggle-arrow" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        看看这批是哪 {cards.length} 道题
        {masteredCount > 0 ? (
          <span className="pq__toggle-note">（其中 {masteredCount} 道已掌握）</span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="pq__actions">
            <button
              type="button"
              className="pq__action"
              disabled={autoSkippable === 0}
              onClick={onSkipMastered}
            >
              跳过已掌握的{autoSkippable > 0 ? `（${autoSkippable} 道）` : ''}
            </button>
            <button
              type="button"
              className="pq__action"
              disabled={skipped.size === 0}
              onClick={onResetSkip}
            >
              全部恢复{skipped.size > 0 ? `（已跳过 ${skipped.size} 道）` : ''}
            </button>
          </div>

          <ul className="pq__list">
            {rows.map((r) => {
              const isSkipped = skipped.has(r.card.id);
              return (
                <li
                  key={r.card.id}
                  className={'pq__item' + (isSkipped ? ' pq__item--skipped' : '')}
                >
                  <label className="pq__check">
                    <input
                      type="checkbox"
                      checked={!isSkipped}
                      onChange={() => onToggleSkip(r.card.id)}
                    />
                    <span className="pq__body">
                      <span className="pq__prompt">
                        <MathText text={r.card.prompt} />
                      </span>
                      <span className="pq__meta">
                        <span className={'pq__badge' + (r.mastered ? ' pq__badge--ok' : '')}>
                          {r.label}
                        </span>
                        {r.overdueDays > 0 ? (
                          <span className="pq__overdue">逾期 {r.overdueDays} 天</span>
                        ) : null}
                        {r.card.deckId ? <span className="pq__deck">题组内</span> : null}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <p className="pq__hint">
            取消勾选的题这次不做，**不会影响**它们的复习进度与到期时间。
          </p>
        </>
      ) : null}
    </div>
  );
}
