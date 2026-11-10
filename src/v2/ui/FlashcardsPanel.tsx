/**
 * 记忆闪卡面板（2026-11-10）。
 *
 * ## 它做什么
 *
 * 两种入口，一个面板：
 *  1. **翻卡**：一次一张，正面是那句话，点「翻面」看原文引证与出处
 *  2. **挑卡**：从知识点里手动勾选，或让 AI 挑一批候选给用户勾
 *
 * ## 与「今日复习」的分界
 *
 * 翻闪卡**不写复习记录**、不参与间隔排期。它是「我挑出来的重点，随时过一遍」。
 * 混进 SRS 会让用户翻几张卡就发现到期队列变了，完全无法理解。
 *
 * ## 为什么抽成独立文件
 *
 * `BookPage.tsx` 已经近 500 行，且这轮已经往里插了自测与今日复习两个分支。
 * 再塞闪卡会失控 —— 项目对往大文件里插代码有明确教训。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlashcardView } from '@/core/flashcards.ts';
import type { KnowledgePoint } from '@/core/model.ts';
import type { FlashcardCandidate } from '@/core/ai/pick-flashcards.ts';
import { MathText } from './MathText.tsx';
import './flashcards.css';

export interface FlashcardsPanelProps {
  /** 全部闪卡（带知识点与过期标记） */
  cards: readonly FlashcardView[];
  /** 可挑选的全部知识点 */
  points: readonly KnowledgePoint[];
  /** 建卡（勾选确认后调用） */
  onAdd: (ids: string[]) => Promise<void> | void;
  /** 删卡 */
  onRemove: (id: string) => Promise<void> | void;
  /** 「看原文」跳转 */
  onOpenAnchor?: (sourceId: string, page?: number, quote?: string) => void;
  /** 让 AI 挑一批候选（返回候选；不直接建卡） */
  onPickWithAi?: () => Promise<FlashcardCandidate[]>;
  /** 退出闪卡，回到阅读模式 */
  onExit: () => void;
}

type Mode = 'review' | 'pick';

export function FlashcardsPanel({
  cards,
  points,
  onAdd,
  onRemove,
  onOpenAnchor,
  onPickWithAi,
  onExit,
}: FlashcardsPanelProps) {
  const [mode, setMode] = useState<Mode>(cards.length > 0 ? 'review' : 'pick');

  if (mode === 'pick') {
    return (
      <PickView
        points={points}
        existingIds={new Set(cards.map((c) => c.card.knowledgePointId))}
        onAdd={onAdd}
        onPickWithAi={onPickWithAi}
        onCancel={() => setMode('review')}
        onExit={onExit}
        hasCards={cards.length > 0}
      />
    );
  }

  return (
    <ReviewView
      cards={cards}
      onRemove={onRemove}
      onOpenAnchor={onOpenAnchor}
      onAddMore={() => setMode('pick')}
      onExit={onExit}
    />
  );
}

/* ========================================================================== */
/* 翻卡                                                                        */
/* ========================================================================== */

function ReviewView({
  cards,
  onRemove,
  onOpenAnchor,
  onAddMore,
  onExit,
}: {
  cards: readonly FlashcardView[];
  onRemove: (id: string) => Promise<void> | void;
  onOpenAnchor?: (sourceId: string, page?: number, quote?: string) => void;
  onAddMore: () => void;
  onExit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const card = cards[index] ?? null;

  /* 删到空时退回第一张；索引越界也夹回来 */
  useEffect(() => {
    if (index >= cards.length && cards.length > 0) setIndex(cards.length - 1);
  }, [cards.length, index]);

  /* 换卡时自动翻回正面 —— 否则下一张一上来就是答案 */
  useEffect(() => {
    setFlipped(false);
  }, [index]);

  const next = useCallback(() => {
    if (cards.length === 0) return;
    setIndex((i) => (i + 1) % cards.length);
  }, [cards.length]);

  const prev = useCallback(() => {
    if (cards.length === 0) return;
    setIndex((i) => (i - 1 + cards.length) % cards.length);
  }, [cards.length]);

  /* 键盘：空格翻面、← → 换卡（与 Anki 一致的习惯） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  if (!card) {
    return (
      <div className="fcp">
        <p className="fcp__empty">还没有闪卡。</p>
        <div className="fcp__actions">
          <button type="button" className="fcp__btn fcp__btn--primary" onClick={onAddMore}>
            去挑几张
          </button>
          <button type="button" className="fcp__btn" onClick={onExit}>
            回到复习巩固
          </button>
        </div>
      </div>
    );
  }

  const { card: c, point, stale } = card;

  return (
    <div className="fcp">
      {/* 头部：进度 + 操作 */}
      <div className="fcp__bar">
        <span className="fcp__pos">
          {index + 1} / {cards.length}
        </span>
        <button type="button" className="fcp__btn fcp__btn--ghost" onClick={onAddMore}>
          再加
        </button>
        <button type="button" className="fcp__btn fcp__btn--ghost" onClick={onExit}>
          结束
        </button>
      </div>

      {/*
        过期提示：知识点被删或表述改了。
        不提示的话，用户背的是旧说法却以为一切正常。
      */}
      {stale ? (
        <p className="fcp__stale">
          {point
            ? '这条知识点的表述已经改过，卡上是建卡时的旧说法。'
            : '原知识点已删除，这张卡只剩这句话。'}
        </p>
      ) : null}

      {/* 卡面 */}
      <div className={`fcp__card${flipped ? ' fcp__card--back' : ''}`}>
        <div className="fcp__face">
          <p className="fcp__front">
            <MathText text={c.frontText} />
          </p>
        </div>

        {flipped ? (
          <div className="fcp__back">
            {c.backNote ? (
              <p className="fcp__note">{c.backNote}</p>
            ) : null}

            {point && point.quotes.length > 0 ? (
              <div className="fcp__quote-block">
                <span className="fcp__quote-label">原文</span>
                <p className="fcp__quote">
                  「<MathText text={point.quotes[0] ?? ''} />」
                </p>
              </div>
            ) : (
              <p className="fcp__hint">
                {point ? '这条知识点没有引用原文。' : '原知识点已删除，取不到原文。'}
              </p>
            )}

            {point?.anchors[0] && onOpenAnchor && c.sourceId ? (
              <button
                type="button"
                className="fcp__link"
                onClick={() =>
                  onOpenAnchor(c.sourceId!, point.anchors[0]!.page, point.quotes[0])
                }
              >
                看原文第 {point.anchors[0].page ?? '?'} 页
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 底部操作 */}
      <div className="fcp__nav">
        <button type="button" className="fcp__btn" onClick={prev}>
          ← 上一张
        </button>
        <button
          type="button"
          className="fcp__btn fcp__btn--primary"
          onClick={() => setFlipped((f) => !f)}
        >
          {flipped ? '收起' : '翻面'}
        </button>
        <button type="button" className="fcp__btn" onClick={next}>
          下一张 →
        </button>
      </div>

      <div className="fcp__foot">
        <button
          type="button"
          className="fcp__btn fcp__btn--ghost"
          onClick={() => void onRemove(c.id)}
        >
          删掉这张
        </button>
        {c.origin === 'ai' ? <span className="fcp__origin">AI 挑的</span> : null}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* 挑卡                                                                        */
/* ========================================================================== */

function PickView({
  points,
  existingIds,
  onAdd,
  onPickWithAi,
  onCancel,
  onExit,
  hasCards,
}: {
  points: readonly KnowledgePoint[];
  existingIds: ReadonlySet<string>;
  onAdd: (ids: string[]) => Promise<void> | void;
  onPickWithAi?: () => Promise<FlashcardCandidate[]>;
  onCancel: () => void;
  onExit: () => void;
  hasCards: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [aiPicks, setAiPicks] = useState<FlashcardCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 只列「还没做过卡」的知识点 —— 已加过的再出现在这里只会让人误点 */
  const available = useMemo(
    () => points.filter((p) => !existingIds.has(p.id)),
    [points, existingIds],
  );

  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const runAi = useCallback(async () => {
    if (!onPickWithAi || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cands = await onPickWithAi();
      setAiPicks(cands);
      /* AI 挑完自动勾上 —— 用户还可以取消；这样最少点击 */
      setPicked(new Set(cands.map((c) => c.knowledgePointId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 挑选失败');
    } finally {
      setBusy(false);
    }
  }, [onPickWithAi, busy]);

  const commit = useCallback(async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      await onAdd([...picked]);
      setPicked(new Set());
      setAiPicks(null);
      /*
       * 加入后**总是**切到翻卡视图（2026-11-10 修）。
       *
       * 原来写的是 `if (hasCards) onCancel()` —— 但 hasCards 是加入**之前**
       * 的快照，首次建卡时它是 0，于是加完仍停在挑卡页，
       * 用户看不到自己刚建的卡（实测截图里就是「加入闪卡 (0)」还停着）。
       *
       * 刚加完最想看的就是翻卡，无论之前有没有卡。
       */
      onCancel();
    } finally {
      setBusy(false);
    }
  }, [busy, picked, onAdd, onCancel]);

  return (
    <div className="fcp">
      <div className="fcp__bar">
        <span className="fcp__pose">挑闪卡</span>
        {onPickWithAi ? (
          <button
            type="button"
            className="fcp__btn fcp__btn--primary"
            onClick={() => void runAi()}
            disabled={busy || available.length === 0}
            title="让 AI 从知识点里挑出适合背的"
          >
            {busy ? 'AI 挑选中…' : '让 AI 挑'}
          </button>
        ) : null}
        {hasCards ? (
          <button type="button" className="fcp__btn fcp__btn--ghost" onClick={onCancel}>
            取消
          </button>
        ) : (
          <button type="button" className="fcp__btn fcp__btn--ghost" onClick={onExit}>
            回到复习巩固
          </button>
        )}
      </div>

      {error ? <p className="fcp__error">{error}</p> : null}

      {aiPicks ? (
        <p className="fcp__aipick">
          AI 挑了 {aiPicks.length} 条，已默认勾上 —— 你可以取消不想要的。
        </p>
      ) : null}

      {available.length === 0 ? (
        <p className="fcp__empty">
          所有知识点都已经做成闪卡了。
        </p>
      ) : (
        <ul className="fcp__list">
          {available.map((p) => {
            const on = picked.has(p.id);
            const reason = aiPicks?.find((c) => c.knowledgePointId === p.id)?.reason;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`fcp__row${on ? ' fcp__row--on' : ''}`}
                  onClick={() => toggle(p.id)}
                  aria-pressed={on}
                >
                  <span className="fcp__check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  <span className="fcp__row-body">
                    <span className="fcp__row-text">
                      <MathText text={p.statement} />
                    </span>
                    <span className="fcp__row-meta">
                      {p.chapter ?? '未归章'}
                      {p.tags && p.tags.length > 0 ? ` · ${p.tags[0]}` : ''}
                      {reason ? ` · ${reason}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="fcp__nav">
        <button
          type="button"
          className="fcp__btn fcp__btn--primary"
          onClick={() => void commit()}
          disabled={busy || picked.size === 0}
        >
          加入闪卡（{picked.size}）
        </button>
      </div>
    </div>
  );
}
