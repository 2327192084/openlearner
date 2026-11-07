/**
 * 错题与待巩固。
 *
 * ## 这一页和「开始做题 → 错题巩固」的区别
 *
 * | | 这一页（错题与待巩固） | 开始做题 → 错题巩固 |
 * | --- | --- | --- |
 * | 做什么 | **看**：错题全貌、错几次、错在哪天、按题组筛 | 直接开做 |
 * | 数据 | 只读 | 会写新的复习记录 |
 * | 用途 | 知道自己的薄弱点在哪、决定练什么 | 立刻练 |
 *
 * 两者共用同一个数据源（最近一次评级是 `again` 的题），
 * 所以「这里看到的」和「那儿能练的」永远一致 ——
 * 不会出现「列表里有 8 道，点开始只做 3 道」那种对不上的情况。
 *
 * ## 「错题」的定义（必须让用户看见）
 *
 * **最近一次作答是错的。** 不是「曾经错过」——
 * 改对之后就会从列表里消失。这个规则如果不说，
 * 用户重做答对后发现题目不见了，会以为记录丢了。
 *
 * ## 为什么单独做一页，而不只是「开始做题」里的一个标签
 *
 * 用户在这里的诉求是**回顾与判断**（我哪块弱、要不要重练），
 * 而在「开始做题」里的诉求是**立刻开始**。
 * 把回顾塞进做题入口会让那一页变成两件事的混合体。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '@/v2/core/cards.ts';
import type { Deck, Question } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';

export interface WrongBookPageProps {
  reviewService: ReviewService;
  decks: DeckService;
  loadCards: CardLoader;
  /** 去阅读器看原文 */
  onOpenSource: (sourceId: string) => void;
  /** 去「开始做题」 */
  onOpenPractice: () => void;
}

interface WrongRow {
  card: Card;
  wrongCount: number;
  reviewCount: number;
  lastWrongDay: string;
  /** 错题比例（0–1） */
  wrongRate: number;
  /** 这道题所属题组的标题（拿不到时为 null） */
  deckTitle: string | null;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: WrongRow[]; decks: Deck[] };

/** 排序方式 */
type SortKey = 'wrongCount' | 'lastWrong' | 'wrongRate';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'wrongCount', label: '错得最多' },
  { key: 'wrongRate', label: '错的比例最高' },
  { key: 'lastWrong', label: '最近错的' },
];

export function WrongBookPage({
  reviewService,
  decks,
  loadCards,
  onOpenSource,
  onOpenPractice,
}: WrongBookPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [sort, setSort] = useState<SortKey>('wrongCount');
  /** 空字符串 = 全部题组 */
  const [deckFilter, setDeckFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const [detailed, allCards, deckList] = await Promise.all([
        reviewService.wrongCardsDetailed(),
        loadCards(),
        decks.list(),
      ]);

      const cardById = new Map(allCards.map((c) => [c.id, c]));
      const deckById = new Map(deckList.map((d) => [d.id, d]));

      const rows: WrongRow[] = [];
      for (const d of detailed) {
        const card = cardById.get(d.cardId);
        /*
         * 卡片可能已经不在了（题组被删、题被删）。
         * 这类条目直接跳过 —— 显示一行点不开的空壳比不显示更糟。
         */
        if (!card) continue;
        const deck = deckById.get(card.deckId);
        rows.push({
          card,
          wrongCount: d.wrongCount,
          reviewCount: d.reviewCount,
          lastWrongDay: d.lastWrongDay,
          wrongRate: d.reviewCount > 0 ? d.wrongCount / d.reviewCount : 1,
          deckTitle: deck?.title ?? null,
        });
      }

      setState({ kind: 'ready', rows, decks: deckList });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出错题',
      });
    }
  }, [reviewService, decks, loadCards]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state.kind === 'ready' ? state.rows : [];
  const allDecks = state.kind === 'ready' ? state.decks : [];

  /** 出现在错题里的题组（只列有错题的，避免下拉里一堆空项） */
  const decksWithWrong = useMemo(() => {
    const ids = new Set(rows.map((r) => r.card.deckId));
    return allDecks.filter((d) => ids.has(d.id));
  }, [rows, allDecks]);

  const visible = useMemo(() => {
    const filtered = deckFilter ? rows.filter((r) => r.card.deckId === deckFilter) : rows;
    const sorted = [...filtered];
    if (sort === 'wrongCount') sorted.sort((a, b) => b.wrongCount - a.wrongCount);
    else if (sort === 'wrongRate') sorted.sort((a, b) => b.wrongRate - a.wrongRate);
    else {
      // 日期串是 YYYY-MM-DD，字典序即时间序；越近越靠前
      sorted.sort((a, b) => (a.lastWrongDay < b.lastWrongDay ? 1 : -1));
    }
    return sorted;
  }, [rows, deckFilter, sort]);

  const totalWrong = rows.length;
  const repeatWrong = rows.filter((r) => r.wrongCount > 1).length;

  if (state.kind === 'loading') {
    return (
      <div className="wrongbook-page">
        <p className="wbk-hint">正在读错题…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="wrongbook-page">
        <p className="wbk-error">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="wrongbook-page">
      <header className="wbk-head">
        <h1 className="wbk-title">错题与待巩固</h1>
        <p className="wbk-lead">
          这里的「错题」指<strong>最近一次作答是错的</strong>题。重做答对之后，
          它就会从这里消失 —— 所以这个列表只会越来越短。
        </p>
      </header>

      {totalWrong === 0 ? (
        <div className="wbk-empty">
          <p>现在没有错题。</p>
          <p className="wbk-hint">
            做错的题会自动进来；如果你还没做过题，先去练一轮。
          </p>
          <button type="button" className="btn-ghost" onClick={onOpenPractice}>
            去开始做题
          </button>
        </div>
      ) : (
        <>
          {/* ---- 概览 ---- */}
          <div className="wbk-stats">
            <span className="wbk-stat">
              <span className="wbk-stat__n">{totalWrong}</span>
              <span className="wbk-stat__label">道错题</span>
            </span>
            {repeatWrong > 0 ? (
              <span className="wbk-stat wbk-stat--warn">
                <span className="wbk-stat__n">{repeatWrong}</span>
                <span className="wbk-stat__label">道错过不止一次</span>
              </span>
            ) : null}
          </div>

          {/* ---- 筛选与排序 ---- */}
          <div className="wbk-toolbar">
            <label className="wbk-field">
              <span className="wbk-field__label">题组</span>
              <select
                className="wbk-select"
                value={deckFilter}
                onChange={(e) => setDeckFilter(e.target.value)}
              >
                <option value="">全部（{totalWrong} 道）</option>
                {decksWithWrong.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}（{rows.filter((r) => r.card.deckId === d.id).length} 道）
                  </option>
                ))}
              </select>
            </label>

            <div className="wbk-sort" role="group" aria-label="排序方式">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`wbk-sort__btn${sort === s.key ? ' wbk-sort__btn--on' : ''}`}
                  aria-pressed={sort === s.key}
                  onClick={() => setSort(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenPractice}>
              去练错题
            </button>
          </div>

          {/* ---- 列表 ---- */}
          <ul className="wbk-list">
            {visible.map((r) => (
              <li key={r.card.id} className="wbk-item">
                <div className="wbk-item__head">
                  <span className="wbk-item__count">错 {r.wrongCount} 次</span>
                  <span className="wbk-item__rate">
                    共做 {r.reviewCount} 次 · 错 {Math.round(r.wrongRate * 100)}%
                  </span>
                  <span className="wbk-item__date">最近错于 {r.lastWrongDay}</span>
                </div>
                <p className="wbk-item__prompt">{r.card.prompt}</p>

                {/* 选项：只做只读展示，让用户能回忆起来这道题长什么样 */}
                {r.card.options.length > 0 ? (
                  <ul className="wbk-item__options">
                    {r.card.options.map((o) => (
                      <li
                        key={o.key}
                        className={`wbk-item__option${
                          isAnswerKey(r.card, o.key) ? ' wbk-item__option--right' : ''
                        }`}
                      >
                        <span className="wbk-item__key">{o.key}</span>
                        <span>{o.text}</span>
                        {isAnswerKey(r.card, o.key) ? (
                          <span className="wbk-item__tag">正确答案</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="wbk-item__answer">参考答案：{r.card.answer}</p>
                )}

                {r.card.explanation ? (
                  <p className="wbk-item__explain">{r.card.explanation}</p>
                ) : null}

                <div className="wbk-item__foot">
                  {r.deckTitle ? <span className="wbk-item__deck">{r.deckTitle}</span> : null}
                  {r.card.sourceId ? (
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => onOpenSource(r.card.sourceId)}
                    >
                      看原文
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {visible.length === 0 ? (
            <p className="wbk-hint">这个题组下没有错题。</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 某个选项是不是正确答案（多选用逗号分隔） */
function isAnswerKey(card: Card, key: string): boolean {
  const answer = card.answer.trim().toUpperCase();
  if (card.kind === 'multiple') {
    return answer
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .includes(key.toUpperCase());
  }
  return answer === key.toUpperCase();
}

/** 题型中文名（备用：将来要在行首显示题型时用） */
export const QUESTION_KIND_LABEL: Record<Question['kind'], string> = {
  single: '单选',
  multiple: '多选',
  truefalse: '判断',
  blank: '填空',
  essay: '问答',
};
