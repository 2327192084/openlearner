/**
 * 做题入口：三种模式选一种。
 *
 * ## 为什么要拆成三种（用户 2026-11-07 拍板）
 *
 * 原来的「开始做题」只有一条路：取今天到期的卡。做完一次之后，
 * 这些卡的 `dueAt` 都变成明天或更远，**今天再点就是「没有需要做的题」** ——
 * 用户的原话：「而不是今天完成了一次有关题组，后面点击再次做题时就没有题做了」。
 *
 * 现在的三种模式各解决一件事：
 *
 * | 模式 | 解决什么 | 受到期日约束 |
 * | --- | --- | --- |
 * | 今日题组 | 按遗忘曲线该复习的 | ✅ 只做到期的 |
 * | 自由练习 | 自己想练就练，随时能刷 | ❌ 不受限 |
 * | 错题巩固 | 把最近答错的重新做会 | ❌ 不受限，只做错题 |
 *
 * ## 为什么「错题巩固」和导览页的「错题闪卡」不冲突
 *
 * - **错题巩固**（这里）：真的做题，有作答、有判分、影响复习间隔。
 * - **错题闪卡**（后续做）：不做题，只是把错题做成卡片来「看」。
 *
 * 两者入口都在，但做的是不同的事。用户明确说过这两者不冲突。
 *
 * ## 为什么自由练习要「不影响到期安排」写清楚
 *
 * 自由练习仍然会写复习记录（不然「练了白练」），但它**不在今天该复习时**
 * 也让你做，所以做完之后卡片会按正常算法排到未来。
 * 如果不说明，用户会疑惑「我明明刚练过，怎么今天还要复习」。
 * 实际上：练过之后间隔会往前推，今天就不会再出现了 —— 这正是他要的。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '@/v2/core/cards.ts';
import type { Deck } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { CardLoader } from './cards-loader.ts';
import { kindShort } from '@/core/questions/kinds.ts';

/** 三种模式 */
export type PracticeMode = 'due' | 'free' | 'wrong';

export interface PracticeStart {
  mode: PracticeMode;
  cards: Card[];
  label: string;
  /** 今日到期模式的真实总数（自由/错题模式为 null） */
  dueTotal: number | null;
}

export interface PracticePageProps {
  decks: DeckService;
  sourceService: SourceService;
  reviewService: ReviewService;
  loadCards: CardLoader;
  /** 今日到期的卡（由外层算好，含知识点过滤） */
  dueCards: Card[];
  dueTotal: number;
  /** 开始练习 */
  onStart: (start: PracticeStart) => void;
  /** 去「我的题组」发布题组 */
  onOpenDecks: () => void;
  /** 去整理知识点（不带具体资料，进整理页自己选） */
  onOpenOrganize: () => void;
}

/** 一批最多做多少张（与复习批量一致） */
const BATCH = 30;

type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: T };

export function PracticePage({
  decks,
  sourceService,
  reviewService,
  loadCards,
  dueCards,
  dueTotal,
  onStart,
  onOpenDecks,
  onOpenOrganize,
}: PracticePageProps) {
  const [tab, setTab] = useState<PracticeMode>('due');
  const [published, setPublished] = useState<Load<Deck[]>>({ kind: 'loading' });
  const [sourceTitles, setSourceTitles] = useState<Map<string, string>>(new Map());
  const [wrong, setWrong] = useState<Load<{ card: Card; wrongCount: number }[]>>({
    kind: 'loading',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [deckList, srcs, wrongDetailed, allCards] = await Promise.all([
        decks.list(),
        sourceService.list(),
        reviewService.wrongCardsDetailed(),
        loadCards(),
      ]);
      setPublished({ kind: 'ready', data: deckList.filter((d) => d.status === 'published') });
      setSourceTitles(new Map(srcs.map((s) => [s.id, s.title])));

      /*
       * 错题从 reviewLogs 派生（最近一次评级是 again），
       * 再用 loadCards 拿到题干等展示信息。
       *
       * 不用 DeckService.getWrongQuestions()：它只读 answerRecords，
       * 而 v2 做题流程从不写那张表 —— 用它的话错题集永远是空的。
       */
      const cardById = new Map(allCards.map((c) => [c.id, c]));
      const resolved = wrongDetailed
        .map((w) => {
          const card = cardById.get(w.cardId);
          return card ? { card, wrongCount: w.wrongCount } : null;
        })
        /* 卡片可能已被删除（题组删掉了）—— 那些跳过，不要显示空行 */
        .filter((x): x is { card: Card; wrongCount: number } => x !== null);

      setWrong({ kind: 'ready', data: resolved });
    } catch (err) {
      const message = err instanceof Error ? err.message : '读不出题目';
      setPublished({ kind: 'error', message });
      setWrong({ kind: 'error', message });
    }
  }, [decks, sourceService, reviewService, loadCards]);

  useEffect(() => {
    void load();
  }, [load]);

  const publishedDecks = published.kind === 'ready' ? published.data : [];
  const wrongItems = wrong.kind === 'ready' ? wrong.data : [];

  /**
   * 把一个题组的题转成 Card。
   *
   * 复用 cards-loader 的统一转换，避免「从这里做」和「从复习做」
   * 出现两套字段映射（那种分裂最后一定会有一边漏字段）。
   */
  const loadDeckCards = useCallback(
    async (deckId: string): Promise<Card[]> => {
      const all = await loadCards();
      /*
       * loadCards 只返回**已发布**题组的题（cards-loader 的行为），
       * 所以这里按 deckId 过滤即可，不会把草稿题带进来。
       */
      return all.filter((c) => c.deckId === deckId);
    },
    [loadCards],
  );

  /** 自由练习：做某个题组 */
  async function startDeck(deck: Deck) {
    setBusy(true);
    setError(null);
    try {
      const cards = await loadDeckCards(deck.id);
      if (cards.length === 0) {
        setError(
          `「${deck.title}」里没有可做的题。可能是题组还没发布，或者题目都被删掉了。`,
        );
        return;
      }
      onStart({
        mode: 'free',
        cards: cards.slice(0, BATCH),
        label: `自由练习 · ${deck.title}`,
        dueTotal: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出这个题组');
    } finally {
      setBusy(false);
    }
  }

  /** 自由练习：全库随机抽一批 */
  async function startRandom() {
    setBusy(true);
    setError(null);
    try {
      const all = await loadCards();
      if (all.length === 0) {
        setError('题库里还没有已发布的题。先到「我的题组」发布一个题组。');
        return;
      }
      /*
       * Fisher–Yates 洗牌，不用 sort(() => Math.random() - 0.5)。
       * 后者分布不均匀（某些元素更容易留在原位），
       * 而「随机抽题」正是最不该有偏的地方 —— 项目里已经因为这个问题
       * 在 materials.ts 里特意写过一次 Fisher–Yates。
       */
      const pool = [...all];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      onStart({
        mode: 'free',
        cards: pool.slice(0, BATCH),
        label: '自由练习 · 全库随机',
        dueTotal: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出题库');
    } finally {
      setBusy(false);
    }
  }

  /** 错题巩固 */
  async function startWrong() {
    setBusy(true);
    setError(null);
    try {
      /*
       * 直接用已经解析好的错题卡，不再重新 loadCards + 求交集 ——
       * 那两步在题被删掉时会得到空集，而界面明明列出了错题。
       */
      const cards = wrongItems.map((w) => w.card);
      if (cards.length === 0) {
        setError('错题集是空的 —— 最近没有答错的题。');
        return;
      }
      onStart({
        mode: 'wrong',
        cards: cards.slice(0, BATCH),
        label: `错题巩固 · ${Math.min(cards.length, BATCH)} 道`,
        dueTotal: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出错题');
    } finally {
      setBusy(false);
    }
  }

  const tabs = useMemo(
    () =>
      [
        { id: 'due' as const, label: '今日题组', count: dueTotal },
        { id: 'free' as const, label: '自由练习', count: null },
        { id: 'wrong' as const, label: '错题巩固', count: wrongItems.length },
      ] satisfies { id: PracticeMode; label: string; count: number | null }[],
    [dueTotal, wrongItems.length],
  );

  return (
    <div className="practice-page">
      <header className="practice-head">
        <h1 className="practice-title">开始做题</h1>
        <p className="practice-lead">
          三种做法：按遗忘曲线复习今天的、自己想练就练、或者专门把错过的题重做一遍。
        </p>
      </header>

      <div className="practice-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`practice-tab${tab === t.id ? ' practice-tab--on' : ''}`}
            onClick={() => {
              setTab(t.id);
              setError(null);
            }}
          >
            {t.label}
            {t.count !== null && t.count > 0 ? (
              <span className="practice-tab__count">{t.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      {error ? <div className="practice-error">{error}</div> : null}

      {/* ---------- 今日题组 ---------- */}
      {tab === 'due' ? (
        <section className="practice-panel">
          {dueCards.length > 0 ? (
            <>
              <p className="practice-hint">
                今天有 {dueTotal} 道题到了该复习的时候。
                {dueCards.length < dueTotal
                  ? ` 这一批先做 ${dueCards.length} 道，做完可以再来取。`
                  : ''}
              </p>
              <button
                type="button"
                className="btn-fill"
                onClick={() =>
                  onStart({
                    mode: 'due',
                    cards: dueCards,
                    label: '今日题组',
                    dueTotal,
                  })
                }
              >
                开始复习（{dueCards.length} 道）
              </button>
            </>
          ) : (
            <>
              <p className="practice-empty">
                今天到期的都做完了。想继续练的话用「自由练习」——
                那里不受到期限制，随时可以刷。
              </p>
              <div className="practice-actions">
                <button type="button" className="btn-ghost" onClick={() => setTab('free')}>
                  去自由练习
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {/* ---------- 自由练习 ---------- */}
      {tab === 'free' ? (
        <section className="practice-panel">
          <p className="practice-hint">
            自由练习<strong>不受「今天该复习什么」的限制</strong>，想练哪个就练哪个。
            做完照样记录进度，间隔会照常往后推。
          </p>

          <div className="practice-actions">
            <button type="button" className="btn-fill" onClick={() => void startRandom()} disabled={busy}>
              全库随机来一批（最多 {BATCH} 道）
            </button>
          </div>

          <h2 className="practice-subtitle">或者挑一个题组</h2>
          {published.kind === 'loading' ? (
            <p className="practice-hint">正在读题组…</p>
          ) : published.kind === 'error' ? (
            <p className="practice-error">{published.message}</p>
          ) : publishedDecks.length === 0 ? (
            <div className="practice-empty">
              还没有已发布的题组。
              <button type="button" className="btn-text" onClick={onOpenDecks}>
                去「我的题组」创建并发布
              </button>
            </div>
          ) : (
            <ul className="practice-decks">
              {publishedDecks.map((d) => (
                <li key={d.id} className="practice-deck">
                  <div className="practice-deck__main">
                    <span className="practice-deck__title">{d.title}</span>
                    <span className="practice-deck__meta">
                      {d.questionCount} 道
                      {d.kinds && d.kinds.length > 0 ? (
                        <span className="deck-kind-tag">
                          {d.kinds.map(kindText).join(' / ')}
                        </span>
                      ) : null}
                      {d.randomSource ? (
                        <span className="deck-random-tag">随机题组</span>
                      ) : null}
                      {d.sourceId ? ` · 来自「${sourceTitles.get(d.sourceId) ?? '未知资料'}」` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void startDeck(d)}
                    disabled={busy}
                  >
                    做这组
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* ---------- 错题巩固 ---------- */}
      {tab === 'wrong' ? (
        <section className="practice-panel">
          <p className="practice-hint">
            「错题」的定义是<strong>最近一次作答是错的</strong>。
            答对之后就会从列表里消失 —— 所以它只会越来越短，不会越攒越多。
          </p>

          {wrong.kind === 'loading' ? (
            <p className="practice-hint">正在读错题…</p>
          ) : wrongItems.length === 0 ? (
            <p className="practice-empty">
              错题集是空的。做错的题会自动进来；如果你还没做过题，
              先去「今日题组」或「自由练习」做一轮。
            </p>
          ) : (
            <>
              <div className="practice-actions">
                <button
                  type="button"
                  className="btn-fill"
                  onClick={() => void startWrong()}
                  disabled={busy}
                >
                  开始巩固（{Math.min(wrongItems.length, BATCH)} 道）
                </button>
              </div>
              <ul className="practice-wrong">
                {wrongItems.slice(0, BATCH).map((w) => (
                  <li key={w.card.id} className="practice-wrong__item">
                    <span className="practice-wrong__count">错 {w.wrongCount} 次</span>
                    <span className="practice-wrong__prompt">{w.card.prompt}</span>
                  </li>
                ))}
              </ul>
              {wrongItems.length > BATCH ? (
                <p className="practice-hint">
                  共 {wrongItems.length} 道错题，这一批先做 {BATCH} 道。
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <p className="practice-foot">
        还没整理过知识点？
        <button type="button" className="btn-text" onClick={onOpenOrganize}>
          去整理
        </button>
      </p>
    </div>
  );
}

/*
 * 题型中文名：统一从注册表取，不在这里维护第二份。
 *
 * 之前这里手写了一小份映射，新增 truefalse 时忘了同步，
 * 界面上就直接显示成英文 id「truefalse」（截图核对时发现的）。
 * 一份映射放在 `core/questions/kinds.ts`，别处都从那儿取 ——
 * 这样加新题型只改注册表一处。
 */
function kindText(id: string): string {
  return kindShort(id);
}
