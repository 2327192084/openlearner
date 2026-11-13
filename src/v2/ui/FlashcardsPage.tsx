/**
 * 闪卡管理（2026-11-13 深夜，用户要求）。
 *
 * ## 用户原话
 *
 * > 「错题闪卡改名为闪卡管理。然后在课程准备与管理的栏目下
 * >  新开一个闪卡管理栏目」
 *
 * 并且确认「两种都要」：
 *  - 知识点闪卡（`flashcards` 分区里那些）
 *  - 错题闪卡（复习记录里「最近一次答错」的题，推导出来的）
 *
 * ## 这一页做什么、不做什么
 *
 * **做**：看有哪些卡、从哪来、搜、按来源筛、删掉不要的知识点卡、
 * 点开看背面。
 *
 * **不做**：不做"开始背"这件事。背闪卡在「复习巩固」页里
 * （那里已有 FlashcardsPanel）。这一页是**管理**，不是学习会话。
 * 混进来会让这一页既不像管理页也不像学习页。
 *
 * ## 两种卡的差异在界面上必须是可见的
 *
 * 最要紧的一条：**错题闪卡没有删除按钮**。
 * 它不是一条独立记录，是「这道题现在还是错的」这个查询的结果 ——
 * 给它一个删除按钮，用户会以为删了就学会了，而下次刷新它又回来
 * （典型假按钮）。想让它消失只有一个办法：重做答对。
 * 所以那一组只给「去做这题」。
 *
 * 详见 `flashcard-manage.ts` 头注释里的对照表。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlashcardService, FlashcardView } from '@/core/flashcards.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import type { Card } from '@/v2/core/cards.ts';
import { MathText } from './MathText.tsx';
import {
  DEFAULT_FILTER,
  countByGroup,
  filterCards,
  fromPointFlashcards,
  fromWrongCards,
  type CardFilter,
  type FlashcardGroup,
  type UnifiedCard,
} from './flashcard-manage.ts';

export interface FlashcardsPageProps {
  flashcards: FlashcardService;
  reviewService: ReviewService;
  loadCards: CardLoader;
  /** 去做这题（错题卡唯一能让它消失的办法） */
  onPracticeCard?: (cardId: string) => void;
  /** 去复习巩固页真正开始背 */
  onGoReview?: () => void;
}

export function FlashcardsPage({
  flashcards,
  reviewService,
  loadCards,
  onPracticeCard,
  onGoReview,
}: FlashcardsPageProps) {
  const [pointViews, setPointViews] = useState<FlashcardView[] | null>(null);
  const [wrongRows, setWrongRows] = useState<
    { cardId: string; wrongCount: number; reviewCount: number; lastWrongDay: string }[] | null
  >(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<CardFilter>(DEFAULT_FILTER);
  /** 展开查看背面的那几张（key 集合） */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /** 待确认删除的知识点卡 */
  const [pendingDelete, setPendingDelete] = useState<UnifiedCard | null>(null);

  const load = useCallback(async () => {
    try {
      /*
       * 三个数据源并行读。
       *
       * loadCards 只用于「把 cardId 换成题目内容」——
       * 错题闪卡的正面/背面都从题目本身取，没有题目就什么也显示不了。
       */
      const [views, wrong, allCards] = await Promise.all([
        flashcards.listWithPoints(),
        reviewService.wrongCardsDetailed(),
        loadCards(),
      ]);
      setPointViews(views);
      setWrongRows(wrong);
      setCards(allCards);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不出闪卡');
    }
  }, [flashcards, reviewService, loadCards]);

  useEffect(() => {
    void load();
  }, [load]);

  const cardOf = useCallback(
    (id: string) => (cards ?? []).find((c) => c.id === id),
    [cards],
  );

  const unified = useMemo(() => {
    if (!pointViews || !wrongRows || !cards) return null;
    return [
      ...fromPointFlashcards(pointViews),
      ...fromWrongCards(wrongRows, cardOf),
    ];
  }, [pointViews, wrongRows, cards, cardOf]);

  const counts = useMemo(() => (unified ? countByGroup(unified) : null), [unified]);
  const visible = useMemo(() => (unified ? filterCards(unified, filter) : []), [unified, filter]);

  async function removePointCard(card: UnifiedCard) {
    /* key 形如 `point:<id>`，取出真正的闪卡 id */
    const id = card.key.replace(/^point:/, '');
    setBusy(true);
    try {
      await flashcards.remove(id);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除没成功');
    } finally {
      setBusy(false);
    }
  }

  function toggleOpen(key: string) {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (error && !unified) {
    return (
      <div className="fcx">
        <h1 className="fcx__title">闪卡管理</h1>
        <p className="fcx__err">{error}</p>
      </div>
    );
  }

  if (!unified) {
    return (
      <div className="fcx">
        <h1 className="fcx__title">闪卡管理</h1>
        <p className="fcx__lead">正在读闪卡…</p>
      </div>
    );
  }

  const GROUP_TABS: { id: FlashcardGroup | 'all'; label: string; n: number }[] = [
    { id: 'all', label: '全部', n: counts?.total ?? 0 },
    { id: 'point', label: '知识点闪卡', n: counts?.point ?? 0 },
    { id: 'wrong', label: '错题闪卡', n: counts?.wrong ?? 0 },
  ];

  return (
    <div className="fcx">
      <header className="fcx__head">
        <div>
          <h1 className="fcx__title">闪卡管理</h1>
          <p className="fcx__lead">
            这里管两种闪卡：从知识点挑出来的，和做错过的题。
            要真正开始背，去「复习巩固」。
          </p>
        </div>
        {onGoReview ? (
          <button type="button" className="btn-fill btn-fill--sm" onClick={onGoReview}>
            去背闪卡 →
          </button>
        ) : null}
      </header>

      {error ? <p className="fcx__err">{error}</p> : null}

      {/* ---------- 数字 + 筛选 ---------- */}
      <div className="fcx__bar">
        <div className="fcx__tabs" role="tablist" aria-label="闪卡来源">
          {GROUP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter.group === t.id}
              className={`fcx__tab${filter.group === t.id ? ' fcx__tab--on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, group: t.id }))}
            >
              {t.label}
              <span className="fcx__tab-n">{t.n}</span>
            </button>
          ))}
        </div>

        <input
          className="fcx__search"
          value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          placeholder="搜正面或背面的内容…"
          spellCheck={false}
          aria-label="搜索闪卡"
        />

        {counts && counts.broken > 0 ? (
          <label className="fcx__broken">
            <input
              type="checkbox"
              checked={filter.onlyBroken}
              onChange={(e) => setFilter((f) => ({ ...f, onlyBroken: e.target.checked }))}
            />
            只看失效的（{counts.broken}）
          </label>
        ) : null}
      </div>

      {/* ---------- 列表 ---------- */}
      {unified.length === 0 ? (
        <p className="fcx__empty">
          还没有闪卡。知识点闪卡在「知识库」里挑，错题闪卡来自做错的题 ——
          做错一道题，它就会出现在这里。
        </p>
      ) : visible.length === 0 ? (
        <p className="fcx__empty">没有符合条件的卡。</p>
      ) : (
        <ul className="fcx__list">
          {visible.map((c) => {
            const isOpen = opened.has(c.key);
            return (
              <li key={c.key} className={`fcx__item${c.alive ? '' : ' fcx__item--dead'}`}>
                <div className="fcx__item-top">
                  <span
                    className={`fcx__badge fcx__badge--${c.group}`}
                    title={c.group === 'point' ? '从知识点挑出来的' : '来自做错过的题'}
                  >
                    {c.group === 'point' ? '知识点' : '错题'}
                  </span>
                  {!c.alive ? <span className="fcx__badge fcx__badge--dead">来源已删</span> : null}
                  {c.stale ? (
                    <span className="fcx__badge fcx__badge--stale" title="知识点改过了，你背的可能是旧表述">
                      内容已变
                    </span>
                  ) : null}
                </div>

                <p className="fcx__front">
                  {c.front ? <MathText text={c.front} /> : <em>这张卡没有正面</em>}
                </p>

                {isOpen ? (
                  <div className="fcx__back">
                    {c.back ? (
                      <MathText text={c.back} />
                    ) : (
                      <em className="fcx__no-back">
                        {c.group === 'point'
                          ? '这张卡还没有写背面。在「知识库」里可以补一句自己的话。'
                          : '这道题没有答案或解析可显示。'}
                      </em>
                    )}
                  </div>
                ) : null}

                <div className="fcx__item-actions">
                  <button
                    type="button"
                    className="fcx__act"
                    onClick={() => toggleOpen(c.key)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? '收起背面' : '看背面'}
                  </button>

                  {/*
                    错题卡唯一的「消失」办法：去做这题、答对。
                    **不给删除按钮** —— 它没有独立记录，删了下次刷新又出现，
                    那是个点了会骗人的按钮。见 flashcard-manage.ts 头注释。
                  */}
                  {c.group === 'wrong' && c.alive && onPracticeCard && c.cardId ? (
                    <button
                      type="button"
                      className="fcx__act fcx__act--go"
                      onClick={() => onPracticeCard(c.cardId!)}
                      title="答对它，这张卡就会自动消失"
                    >
                      去做这题
                    </button>
                  ) : null}

                  {c.deletable ? (
                    <button
                      type="button"
                      className="fcx__act fcx__act--del"
                      onClick={() => setPendingDelete(c)}
                      disabled={busy}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- 删除确认（只针对知识点闪卡） ---------- */}
      {pendingDelete ? (
        <div className="fcx__confirm" role="dialog" aria-label="确认删除闪卡">
          <p className="fcx__confirm-text">
            删掉这张闪卡？
            <br />
            <span className="fcx__confirm-quote">{pendingDelete.front.slice(0, 60)}</span>
          </p>
          <p className="fcx__confirm-note">
            只删这张卡，**不会**删掉它引用的知识点。
          </p>
          <div className="fcx__confirm-actions">
            <button
              type="button"
              className="fcx__act fcx__act--del"
              onClick={() => void removePointCard(pendingDelete)}
              disabled={busy}
            >
              {busy ? '删除中…' : '确认删除'}
            </button>
            <button
              type="button"
              className="fcx__act"
              onClick={() => setPendingDelete(null)}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
