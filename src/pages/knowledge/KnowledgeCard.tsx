import { useState } from 'react';
import type { MouseEvent } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { KnowledgePoint } from '@/core/model.ts';
import {
  ANCHOR_STATUS_LABEL,
  COGNITIVE_LEVELS,
  cognitiveLabel,
  describeError,
  hintFrom,
  locationLabel,
} from './types.ts';
import type { Flash } from './types.ts';

/**
 * 一条知识点卡片（校对界面右栏）。
 *
 * 三种定位状态在视觉上必须**一眼可辨**，这是 P2 的验收重点：
 *  - located：普通白卡，绿色「已定位」；
 *  - unlocated：橙色左边框 + 「待处理」徽标 + 独立处理区（指认 / 标记无出处），
 *    并且显式显示模型给的那段「原文里找不到的引用」；
 *  - waived：普通卡，「无出处」中性徽标，不再有任何警告样式 ——
 *    人工已经处理过的事，不该继续亮红。
 *
 * 这里不缓存整份列表：每次写动作都让父组件重新拉取。
 * 列表顺序按「页码 + 字符偏移」排，本地改一半容易和 core 的排序规则不一致，
 * 用户会看到卡片在改完之后跳位置。
 */

export function KnowledgeCard({
  point,
  active,
  onSelect,
  onChanged,
  onNotify,
  getSelectedText,
}: {
  point: KnowledgePoint;
  active: boolean;
  onSelect: () => void;
  onChanged: () => void | Promise<void>;
  /** 把这一步的结果汇报到页面级提示条（成功也要说清，尤其是「指认后仍没找到」） */
  onNotify: (message: Flash) => void;
  /** 取校对界面左栏当前选中的文字，用于「用选中的文字重新指认」 */
  getSelectedText: () => string;
}) {
  const { knowledge } = useServices();

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; hint: string } | null>(null);

  // ---- 编辑表述与标签 ----
  const [editing, setEditing] = useState(false);
  const [statementDraft, setStatementDraft] = useState(point.statement);
  const [tagsDraft, setTagsDraft] = useState(point.tags.join('、'));

  // ---- 重新指认 ----
  const [picking, setPicking] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState('');

  const status = ANCHOR_STATUS_LABEL[point.anchorStatus];
  const unlocated = point.anchorStatus === 'unlocated';

  /**
   * 统一的写动作包装：一次只跑一个，失败内联报，成功刷新列表。
   *
   * 返回值是 core 的返回结果 —— 必须拿它来判断「真的成了吗」：
   * `reanchor` 找不到引用时会返回一条**仍然 unlocated** 的知识点，
   * 这一路不算异常，但绝不能在提示里说成「已重新定位」。
   */
  const run = async <T,>(
    action: () => Promise<T>,
    fallbackHint: string,
  ): Promise<{ ok: boolean; result: T | null }> => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await action();
      await onChanged();
      return { ok: true, result };
    } catch (err) {
      setActionError({ message: describeError(err), hint: hintFrom(err, fallbackHint) });
      return { ok: false, result: null };
    } finally {
      setBusy(false);
    }
  };

  const saveEdits = async () => {
    const statement = statementDraft.trim();
    if (!statement) {
      setActionError({
        message: '概念表述不能为空。',
        hint: '这条知识点将来会被题目和 PPT 直接引用，删成空会让下游出现空题。想删掉它请用「删除」。',
      });
      return;
    }
    const tags = tagsDraft
      .split(/[、,，;；\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const { ok } = await run(
      () => knowledge.update(point.id, { statement, tags }),
      '这条知识点没有被改动，原文和其他条目不受影响。可以再点一次保存。',
    );
    if (ok) {
      setEditing(false);
      onNotify({ tone: 'info', text: '这条知识点的表述已保存' });
    }
  };

  const changeLevel = async (level: KnowledgePoint['cognitiveLevel']) => {
    if (level === point.cognitiveLevel) return;
    const { ok, result } = await run(
      () => knowledge.update(point.id, { cognitiveLevel: level }),
      '认知层级没有改成功。它是 P3 出题难度的依据，确认改好再离开这一页。',
    );
    // update 找不到记录时返回 null（资料被删/记录被清），这也不是异常，要说清
    if (ok && result === null) {
      onNotify({
        tone: 'danger',
        text: '这条知识点已经不在库里了（可能刚被删除），认知层级没有保存。',
      });
    } else if (ok) {
      onNotify({ tone: 'info', text: `认知层级已改为「${cognitiveLabel(level)}」` });
    }
  };

  const remove = async () => {
    const ok = window.confirm(
      `删除这条知识点？\n\n「${point.statement.slice(0, 60)}${point.statement.length > 60 ? '…' : ''}」\n\n` +
        '删除只影响这一条，资料原文和这份资料的其他知识点都不受影响。',
    );
    if (!ok) return;
    const done = await run(
      () => knowledge.remove(point.id),
      '这条知识点没有被删除。可以刷新后重试；若仍失败，检查本地存储是否可用。',
    );
    if (done.ok) onNotify({ tone: 'info', text: '已删除这条知识点' });
  };

  const reanchorWithQuote = async () => {
    const quote = quoteDraft.trim();
    if (!quote) {
      setActionError({
        message: '请先粘贴或填入一段原文。',
        hint: '从左边正文里选中一句话，点「用选中的文字」自动填入；也可以手动粘贴教材原文。',
      });
      return;
    }
    const { ok, result } = await run(
      () => knowledge.reanchor(point.id, { quote }),
      '位置没有更新。多半是这段文字在原文里仍然找不到：请确认它和正文逐字相同（标点也算），或者改用更有辨识度的一段。',
    );
    if (!ok) return;

    setPicking(false);
    setQuoteDraft('');

    /*
     * 关键分支：reanchor 不抛错，但可能**仍然返回 unlocated**。
     * 这时绝不能说「已重新定位」，否则用户会以为修好了、实际位置还是空的。
     */
    if (result === null) {
      onNotify({ tone: 'danger', text: '这条知识点已经不在库里了，位置没有更新。' });
    } else if (result.anchorStatus === 'located') {
      onNotify({
        tone: 'info',
        text: `已重新定位：${locationLabel(result)}。左栏会高亮这句话。`,
      });
    } else {
      onNotify({
        tone: 'warning',
        text:
          '还是没找到这段文字，位置仍然留空。' +
          '请确认它和左侧正文逐字相同（标点、空格也要一致），或者换一段更短、更有辨识度的原文。',
      });
    }
  };

  const waive = async () => {
    const ok = window.confirm(
      '把这条标记为「无出处」？\n\n' +
        '标记后它仍然保留在知识点列表里，但不再显示「待处理」提醒。\n' +
        '适用于模型总结性的表述 —— 它本来就不对应任何一句原文。\n\n' +
        '之后仍可以点「重新指认位置」改回有出处。',
    );
    if (!ok) return;
    const done = await run(
      () => knowledge.reanchor(point.id, { waive: true }),
      '状态没有更新。可以再试一次；这条知识点本身不会被删除。',
    );
    if (done.ok) {
      onNotify({
        tone: 'info',
        text: '已标记为无出处，这条不再提示待处理。之后仍可以重新指认位置。',
      });
    }
  };

  const fillFromSelection = () => {
    const text = getSelectedText();
    if (!text) {
      setActionError({
        message: '左栏当前没有选中的文字。',
        hint: '先在左边正文里用鼠标选中一句原文，再点这个按钮；也可以直接把原文粘贴到输入框里。',
      });
      return;
    }
    setQuoteDraft(text);
    setActionError(null);
  };

  /** 点卡片空白处才定位；点到里面的按钮/输入框不该抢走焦点去滚正文 */
  const handleCardClick = (e: MouseEvent<HTMLLIElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, label')) return;
    onSelect();
  };

  return (
    <li
      className={`kp-card${active ? ' kp-card--active' : ''}${unlocated ? ' kp-card--unlocated' : ''}`}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onSelect();
      }}
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={`知识点：${point.statement.slice(0, 40)}`}
    >
      <div className="kp-card__head">
        <div className="kp-card__badges">
          <Badge tone={status.tone}>{status.text}</Badge>
          <Badge tone="neutral">{cognitiveLabel(point.cognitiveLevel)}</Badge>
          {/*
            标明这条是谁生成的。
            没有这个标识时，用户用示例后端生成了一批「只摘句子不总结」的结果，
            会以为是 AI 的总结能力不行 —— 实际上压根没用上 AI。
            这类「看不出自己用的是哪个模式」的界面，比功能缺失更误导人。
          */}
          {point.backendId === 'mock' ? (
            <Badge tone="neutral">
              <span title="示例后端只从原文摘句子，不做总结。要真正的总结请到设置页配置 AI 后端。">
                示例后端·非 AI
              </span>
            </Badge>
          ) : (
            <Badge tone="info">
              <span title="由真实 AI 模型生成">AI 生成</span>
            </Badge>
          )}
          <span className="kp-card__loc">{locationLabel(point)}</span>
        </div>
        {!editing ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setStatementDraft(point.statement);
              setTagsDraft(point.tags.join('、'));
              setEditing(true);
              setActionError(null);
            }}
            disabled={busy}
          >
            编辑
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="kp-card__edit">
          <div className="field">
            <label className="field__label" htmlFor={`kp-statement-${point.id}`}>
              概念表述
            </label>
            <textarea
              id={`kp-statement-${point.id}`}
              className="textarea"
              rows={3}
              value={statementDraft}
              onChange={(e) => setStatementDraft(e.target.value)}
              disabled={busy}
            />
            <div className="field__hint">
              会被习题题干与 PPT 直接引用，写成一句完整、能独立成立的话。
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`kp-tags-${point.id}`}>
              标签
            </label>
            <input
              id={`kp-tags-${point.id}`}
              className="input"
              value={tagsDraft}
              onChange={(e) => setTagsDraft(e.target.value)}
              placeholder="用顿号或空格分隔，可以留空"
              disabled={busy}
            />
          </div>
          <div className="page__row">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void saveEdits()}
              disabled={busy}
            >
              {busy ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setEditing(false);
                setActionError(null);
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="kp-card__statement">{point.statement}</p>
      )}

      {point.tags.length > 0 && !editing ? (
        <div className="kp-card__tags">
          {point.tags.map((tag) => (
            <span className="kp-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {/*
        ------- 待处理：必须显眼、必须可操作 -------
        计划书原话：「指认不到原文位置的条目单独标出来，等人处理，
        不要自动填一个位置上去」。所以这里既不给位置，也不假装有位置。
      */}
      {unlocated ? (
        <div className="kp-card__unlocated">
          <div className="kp-card__unlocated-title">
            模型给的引用在原文里找不到，这条还没有位置
          </div>
          <div className="kp-card__unlocated-hint">
            可能原因：引用被模型改写、跨了分页、或本来就是模型自己的概括。
            下面这段是模型给的引用，可以拿它去原文里比对。
          </div>
          {point.quotes.length === 0 ? (
            <div className="page__muted">模型没有给出引用文本。</div>
          ) : (
            <ul className="kp-card__quotes">
              {point.quotes.map((quote, i) => (
                <li key={`${quote.slice(0, 8)}-${i}`} className="kp-quote">
                  {quote}
                </li>
              ))}
            </ul>
          )}

          {picking ? (
            <div className="kp-card__pick">
              <div className="field">
                <label className="field__label" htmlFor={`kp-quote-${point.id}`}>
                  指认原文：粘贴一句话（要与正文逐字相同）
                </label>
                <textarea
                  id={`kp-quote-${point.id}`}
                  className="textarea"
                  rows={3}
                  value={quoteDraft}
                  onChange={(e) => setQuoteDraft(e.target.value)}
                  placeholder="例如：线性结构包括数组、链表、栈和队列。"
                  disabled={busy}
                />
                <div className="field__hint">
                  建议选一句 10–80 字、能认出是这条知识点的原文。太短（四五个字）的引用
                  在教材里必然出现多次，定位器不会接受。
                </div>
              </div>
              <div className="page__row">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={fillFromSelection}
                  disabled={busy}
                  title="把左栏选中的文字填进上面的输入框"
                >
                  用选中的文字
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void reanchorWithQuote()}
                  disabled={busy || quoteDraft.trim() === ''}
                >
                  {busy ? '定位中…' : '重新定位'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setPicking(false);
                    setQuoteDraft('');
                  }}
                  disabled={busy}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="page__row">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setPicking(true);
                  setActionError(null);
                }}
                disabled={busy}
              >
                重新指认位置
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void waive()}
                disabled={busy}
                title="这条确实没有原文出处时才用"
              >
                标记为无出处
              </button>
            </div>
          )}
        </div>
      ) : null}

      {actionError ? (
        <Notice tone="danger" title="这一步没有完成">
          {actionError.message}
          <br />
          <strong>下一步：</strong>
          {actionError.hint}
        </Notice>
      ) : null}

      <div className="kp-card__foot">
        <label className="kp-card__level">
          <span className="page__muted">认知层级</span>
          <select
            className="select select--sm"
            value={point.cognitiveLevel}
            onChange={(e) =>
              void changeLevel(e.target.value as KnowledgePoint['cognitiveLevel'])
            }
            disabled={busy}
            aria-label="认知层级"
          >
            {COGNITIVE_LEVELS.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </label>

        <div className="page__row" style={{ flex: 'none' }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onSelect}
            disabled={point.anchors.length === 0 && point.anchorStatus !== 'located'}
            title={
              point.anchorStatus === 'located'
                ? '在左栏跳到这条知识点命中的原文'
                : '这条没有可跳转的位置，先在下面指认或标记为无出处'
            }
          >
            看原文
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => void remove()}
            disabled={busy}
          >
            删除
          </button>
        </div>
      </div>
    </li>
  );
}
