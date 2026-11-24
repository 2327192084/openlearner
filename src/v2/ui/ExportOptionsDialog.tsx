/**
 * 导出选项对话框（2026-11-23 晚，用户要求「导出功能需要优化」）。
 *
 * ## 为什么这个框是必需的
 *
 * `flashcard-export.ts` 早就支持 `format` / `clozeAnswer` / `bidirectional` /
 * `deckByTag` 四个开关，**但界面一个都没接**（grep 在 src/v2/ui/ 零命中）——
 * 典型"做了没接上"：导出器花了力气算出"关掉填空开关就一张都进不了复习队列"
 * 这类 warning，用户却连开关都找不到。这个框把它们接上。
 *
 * ## 三条必须如实说明的事（不是装饰文案）
 *
 * 1. callout 版式下**双向卡不可用**，原因要写出来（`??` 会被插件拆成两张卡）。
 * 2. 关掉「把答案包成填空」→ 导出的是纯笔记，**一张都进不了复习队列**，
 *    这句话必须出现在框里，不能只出现在导出后的 notice 里。
 * 3. 「按标签分卡组」只对 callout 版式有效（review 版式没有卡组）。
 *
 * 用现成的 `ConfirmDialog`：它已经处理了初始焦点在取消、
 * 执行中锁定、Escape、失败留框（见 dialog.tsx 头注释），别自己重写一遍。
 */

import { useState } from 'react';
import { ConfirmDialog } from './dialog.tsx';
import {
  BIDIRECTIONAL_WHY,
  DEFAULT_EXPORT_OPTIONS,
  canBidirectional,
  canDeckByTag,
  normalizeExportOptions,
  type ExportOptionState,
} from './flashcard-organize.ts';

export interface ExportOptionsDialogProps {
  /** 打开时的初始值（页面里记住上次选的） */
  initial: ExportOptionState;
  /** 这次会导出多少张（框里要写"将导出 N 张"，与实际一致） */
  count: number;
  onConfirm: (next: ExportOptionState) => void;
  onClose: () => void;
}

export function ExportOptionsDialog(props: ExportOptionsDialogProps) {
  const { initial, count, onConfirm, onClose } = props;
  const [opt, setOpt] = useState<ExportOptionState>(initial);

  const patch = (p: Partial<ExportOptionState>) => {
    setOpt((cur) => normalizeExportOptions({ ...cur, ...p }));
  };

  return (
    <ConfirmDialog
      title="导出到 Obsidian"
      description={`这次会导出 ${count} 张卡。`}
      confirmLabel="导出"
      onConfirm={() => {
        onConfirm(normalizeExportOptions(opt));
      }}
      onClose={onClose}
    >
      <div className="fcx__optbox">
        <fieldset className="fcx__optgroup">
          <legend className="fcx__optlegend">版式</legend>
          <label className="fcx__optrow">
            <input
              type="radio"
              name="fcx-export-format"
              checked={opt.format === 'callout'}
              onChange={() => patch({ format: 'callout' })}
            />
            <span>
              <b>Callout 卡片</b>
              <span className="fcx__hint">
                与你库里已有的闪卡版式一致（`&gt; [!tip] 闪卡 N｜标题`）。想在 Obsidian 里翻卡复习要用这个。
              </span>
            </span>
          </label>
          <label className="fcx__optrow">
            <input
              type="radio"
              name="fcx-export-format"
              checked={opt.format === 'review'}
              onChange={() => patch({ format: 'review' })}
            />
            <span>
              <b>多行问答</b>
              <span className="fcx__hint">用 `?` 分隔正反面。适合只想当纯笔记看。</span>
            </span>
          </label>
        </fieldset>

        <label className="fcx__optrow">
          <input
            type="checkbox"
            checked={opt.clozeAnswer}
            onChange={(e) => patch({ clozeAnswer: e.target.checked })}
          />
          <span>
            <b>把答案包成填空（==…==）</b>
            <span className="fcx__hint">
              关掉就只是普通笔记 —— Obsidian 的复习插件靠填空才认得出这是一张卡，关了之后这些卡进不了复习队列。
            </span>
          </span>
        </label>

        <label className={`fcx__optrow${!canBidirectional(opt.format) ? ' fcx__optrow--off' : ''}`}>
          <input
            type="checkbox"
            checked={opt.bidirectional}
            disabled={!canBidirectional(opt.format)}
            onChange={(e) => patch({ bidirectional: e.target.checked })}
          />
          <span>
            <b>双向卡（正反都能翻）</b>
            <span className="fcx__hint">
              {canBidirectional(opt.format) ? '每张卡导出成两条，卡数翻倍。' : BIDIRECTIONAL_WHY}
            </span>
          </span>
        </label>

        <label className={`fcx__optrow${!canDeckByTag(opt.format) ? ' fcx__optrow--off' : ''}`}>
          <input
            type="checkbox"
            checked={opt.deckByTag}
            disabled={!canDeckByTag(opt.format)}
            onChange={(e) => patch({ deckByTag: e.target.checked })}
          />
          <span>
            <b>按标签分卡组</b>
            <span className="fcx__hint">
              {canDeckByTag(opt.format)
                ? '每个标签写成 `#flashcards/标签名`，在 Obsidian 里就是独立的卡组。'
                : '多行问答版式没有卡组概念，只有一份文件。'}
            </span>
          </span>
        </label>

        <p className="fcx__hint">
          装了 Obsidian 的 Spaced Repetition 插件就能直接翻卡复习；没装的话，导出文件仍是一份结构完整的笔记。
        </p>
      </div>
    </ConfirmDialog>
  );
}

export { DEFAULT_EXPORT_OPTIONS };
