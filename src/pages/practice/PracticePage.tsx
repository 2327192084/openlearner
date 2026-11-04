import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Deck, Question, Source } from '@/core/model.ts';
import { PracticeSession } from './PracticeSession.tsx';
import type { SessionResult } from './PracticeSession.tsx';
import { WrongBook, toDeckTitleMap } from './WrongBook.tsx';
import { accuracyText, describeError } from '../decks/types.ts';
import type { DeckStats, Flash, Load } from '../decks/types.ts';
import './practice.css';

/**
 * 练习页（P3 第二半）：选习题集 / 只刷错题 / 作答 / 错题本。
 *
 * ## 四个视图
 *
 *   1. `pick`    —— 选一套已发布的题，或「只刷错题」（也是错题本的入口）
 *   2. `session` —— 逐题作答
 *   3. `result`  —— 本轮成绩
 *   4. `wrong`   —— 错题本
 *
 * ## 为什么只列**已发布**的题
 *
 * 草稿是给学生检查用的，里面可能有空答案、答案键失效的题。
 * 让学生刷到半成品比让他少刷几道更糟——他会以为「这软件出的题是错的」。
 * 所以 `list().filter(d => d.status === 'published')`，并且空态里说清为什么。
 *
 * ## 从习题集页跳过来
 *
 * `DecksPage` 的「刷题」会带 `?deck=<id>`。这里读它并自动选中，
 * 省掉「再选一次」这一步。参数无效（题被删了/改回草稿了）时明确提示，
 * 不静默退化成「随便选一套」。
 */

type View =
  | { kind: 'pick' }
  | { kind: 'session'; deckId: string; questions: Question[]; title: string }
  | { kind: 'result'; result: SessionResult; title: string; deckId: string }
  | { kind: 'wrong' };

export function PracticePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { decks: deckService, sources: sourceService } = useServices();

  const [view, setView] = useState<View>({ kind: 'pick' });
  const [decksState, setDecksState] = useState<Load<Deck[]>>({ kind: 'loading' });
  const [stats, setStats] = useState<Record<string, DeckStats>>({});
  const [sources, setSources] = useState<Source[]>([]);
  const [flash, setFlash] = useState<Flash>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<{ message: string; hint: string } | null>(null);

  /** 只在 pick 视图才需要「已发布」列表 */
  const loadDecks = useCallback(async () => {
    try {
      const list = await deckService.list();
      setDecksState({ kind: 'ready', data: list });
      // 正确率：只对有题目的已发布题集查，省掉无意义的调用
      const published = list.filter((d) => d.status === 'published');
      const entries = await Promise.all(
        published.map(async (d) => {
          try {
            return [d.id, await deckService.getStats(d.id)] as const;
          } catch {
            return null;
          }
        }),
      );
      const next: Record<string, DeckStats> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setStats(next);
    } catch (err) {
      setDecksState({
        kind: 'error',
        message: describeError(err),
        hint: '习题集列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘是否已满。',
      });
    }
  }, [deckService]);

  useEffect(() => {
    void loadDecks();
  }, [loadDecks]);

  // 资料列表只用于把出处写成「页/节」，读不到不该挡住练习
  useEffect(() => {
    let alive = true;
    sourceService
      .list()
      .then((list) => {
        if (alive) setSources(list);
      })
      .catch(() => {
        if (alive) setSources([]);
      });
    return () => {
      alive = false;
    };
  }, [sourceService]);

  const allDecks = decksState.kind === 'ready' ? decksState.data : [];
  const publishedDecks = useMemo(
    () => allDecks.filter((d) => d.status === 'published'),
    [allDecks],
  );
  const deckTitles = useMemo(() => toDeckTitleMap(allDecks), [allDecks]);

  /** deckId → 那份资料的 kind，用于「页/节」的写法 */
  const sourceKindById = useMemo(() => {
    const sourceKind = new Map(sources.map((s) => [s.id, s.kind]));
    const map = new Map<string, Source['kind']>();
    for (const deck of allDecks) {
      const kind = deck.sourceId ? sourceKind.get(deck.sourceId) : undefined;
      if (kind) map.set(deck.id, kind);
    }
    return map;
  }, [allDecks, sources]);

  /** 开一场练习：把题目读进来（这一步才读正文） */
  const startSession = useCallback(
    async (deckId: string, title: string) => {
      setPreparing(true);
      setPrepareError(null);
      setFlash(null);
      try {
        const questions = await deckService.getQuestions(deckId);
        if (questions.length === 0) {
          setPrepareError({
            message: '这套题里没有题目。',
            hint: '出题过程中途停了，或者题目被删光了。回习题集页检查一下，或者换一套。',
          });
          return;
        }
        setView({ kind: 'session', deckId, questions, title });
      } catch (err) {
        setPrepareError({
          message: describeError(err),
          hint: '题目没有丢。可以再点一次；若反复失败，可能是本地存储异常。',
        });
      } finally {
        setPreparing(false);
      }
    },
    [deckService],
  );

  /** 只刷错题：题目由错题本直接给进来 */
  const startRedo = useCallback((questions: Question[]) => {
    if (questions.length === 0) return;
    setPrepareError(null);
    setFlash(null);
    setView({ kind: 'session', deckId: '__wrong__', questions, title: '只刷错题' });
  }, []);

  /**
   * 从成绩页「再刷一轮」时重查错题。
   *
   * 必须重查而不是复用上一轮的题目：上一轮答对的那些已经不在错题本里了，
   * 直接重放会让用户做一批「其实已经改对了」的题。
   */
  const startRedoFromWrong = useCallback(async () => {
    setPreparing(true);
    try {
      const items = await deckService.getWrongQuestions();
      if (items.length === 0) {
        setView({ kind: 'wrong' });
        setFlash({
          tone: 'info',
          text: '现在没有错题了——刚才那轮你把它们都答对了。',
        });
        return;
      }
      startRedo(items.map((i) => i.question));
    } catch (err) {
      setPrepareError({
        message: describeError(err),
        hint: '错题记录没有丢。可以回错题本再试一次。',
      });
      setView({ kind: 'wrong' });
    } finally {
      setPreparing(false);
    }
  }, [deckService, startRedo]);

  /**
   * 处理 `?deck=<id>`。
   *
   * 只在 pick 视图、且带了这个参数时动作。参数无效时**明确提示**而不是静默忽略：
   * 用户点了「刷题」却没进练习，会以为是 bug。
   */
  const deckParam = searchParams.get('deck');
  useEffect(() => {
    if (!deckParam || view.kind !== 'pick') return;
    if (decksState.kind !== 'ready') return;

    const deck = allDecks.find((d) => d.id === deckParam);
    // 读完之后把参数清掉，避免用户退出练习时又被弹回去
    setSearchParams({}, { replace: true });

    if (!deck) {
      setFlash({
        tone: 'warning',
        text: '刚才那套题已经不在库里了（可能被删除）。下面列出了现在能刷的。',
      });
      return;
    }
    if (deck.status !== 'published') {
      setFlash({
        tone: 'warning',
        text: `「${deck.title}」现在是草稿，还不能刷。先去习题集页把它发布出来。`,
      });
      return;
    }
    void startSession(deck.id, deck.title);
  }, [deckParam, view.kind, decksState.kind, allDecks, setSearchParams, startSession]);

  const handleFinish = (result: SessionResult, title: string, deckId: string) => {
    setView({ kind: 'result', result, title, deckId });
    // 成绩可能改变正确率，回列表时重新查一次
    void loadDecks();
  };

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  if (decksState.kind === 'loading') return <LoadingState label="正在读取习题集…" />;

  if (decksState.kind === 'error') {
    return (
      <ErrorState
        title="读不到习题集"
        message={decksState.message}
        hint={decksState.hint}
        onRetry={() => void loadDecks()}
      />
    );
  }

  return (
    <div className="page page__stack pr-page">
      {view.kind === 'session' ? (
        <PracticeSession
          questions={view.questions}
          deckTitle={view.title}
          sourceKindById={sourceKindById}
          onFinish={(result) => handleFinish(result, view.title, view.deckId)}
          onExit={() => {
            setView({ kind: 'pick' });
            void loadDecks();
          }}
        />
      ) : view.kind === 'result' ? (
        <ResultView
          result={view.result}
          title={view.title}
          onAgain={() => {
            if (view.deckId === '__wrong__') {
              void startRedoFromWrong();
            } else {
              void startSession(view.deckId, view.title);
            }
          }}
          onBack={() => {
            setView({ kind: 'pick' });
            void loadDecks();
          }}
          onWrongBook={() => setView({ kind: 'wrong' })}
          preparing={preparing}
          error={prepareError}
        />
      ) : view.kind === 'wrong' ? (
        <>
          <header className="page__head">
            <div className="page__head-main">
              <h2 className="page__title">错题本</h2>
              <p className="page__summary">
                收的是「最近一次作答答错」的题。可以按习题集筛选、按关键词搜，
                也可以直接进入「只刷错题」模式把它们重做一遍。
              </p>
            </div>
            <div className="page__head-side">
              <button type="button" className="btn" onClick={() => setView({ kind: 'pick' })}>
                ← 返回练习
              </button>
            </div>
          </header>

          {prepareError ? (
            <Notice tone="danger" title="没能开始练习">
              {prepareError.message}
              <br />
              <strong>下一步：</strong>
              {prepareError.hint}
            </Notice>
          ) : null}

          <WrongBook
            onStartRedo={startRedo}
            deckTitles={deckTitles}
            sourceKindById={sourceKindById}
          />
        </>
      ) : (
        <>
          <header className="page__head">
            <div className="page__head-main">
              <h2 className="page__title">练习</h2>
              <p className="page__summary">
                选一套已发布的题开始刷，或者只刷错题。作答后才显示答案与解析——
                这是练习，不是预习；答错了可以直接翻到原文依据。
              </p>
            </div>
            <div className="page__head-side">
              <Badge tone="neutral">P3</Badge>
              <Badge tone="ready">可用</Badge>
            </div>
          </header>

          {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

          {prepareError ? (
            <Notice tone="danger" title="没能开始练习">
              {prepareError.message}
              <br />
              <strong>下一步：</strong>
              {prepareError.hint}
            </Notice>
          ) : null}

          {preparing ? <LoadingState label="正在准备题目…" /> : null}

          {/* ---------- 快捷入口 ---------- */}
          <div className="pr-quick">
            <button
              type="button"
              className="card pr-quick__card"
              onClick={() => setView({ kind: 'wrong' })}
            >
              <span className="pr-quick__title">错题本</span>
              <span className="pr-quick__desc">
                归集所有最近一次答错的题，可按习题集筛、按关键词搜，重做后答对会自动移出。
              </span>
            </button>
            <Link className="card pr-quick__card" to="/decks">
              <span className="pr-quick__title">去习题集页</span>
              <span className="pr-quick__desc">
                出题、检查草稿、发布。只有发布出来的题才会出现在下面。
              </span>
            </Link>
          </div>

          {/* ---------- 可选习题集 ---------- */}
          <section className="page__stack">
            <h3 className="page__section-title">
              选择习题集（{publishedDecks.length} 套已发布）
            </h3>

            {publishedDecks.length === 0 ? (
              <div className="card">
                <EmptyState
                  title="还没有已发布的习题集"
                  description={
                    allDecks.length === 0 ? (
                      <>
                        习题集是从知识点出题生成的。先去「习题集」页出题，
                        检查无误后发布——发布之后这里才会出现。
                      </>
                    ) : (
                      <>
                        库里有 {allDecks.length} 个习题集，但都还是草稿。
                        草稿里可能有空答案或失效选项，所以不会出现在练习里。
                        去习题集页检查并发布一套，就能开始刷了。
                      </>
                    )
                  }
                  actions={
                    <Link className="btn btn--primary" to="/decks">
                      去习题集页
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="pr-decks">
                {publishedDecks.map((deck) => {
                  const stat = stats[deck.id];
                  const accuracy = stat?.accuracy ?? null;
                  return (
                    <li key={deck.id} className="card pr-deck">
                      <div className="pr-deck__main">
                        <div className="pr-deck__title">{deck.title}</div>
                        <div className="pr-deck__meta">
                          <span>{deck.questionCount} 题</span>
                          <span className="pr-deck__dot" aria-hidden="true">
                            ·
                          </span>
                          <span>正确率 {accuracyText(accuracy)}</span>
                          {stat ? (
                            <>
                              <span className="pr-deck__dot" aria-hidden="true">
                                ·
                              </span>
                              <span>
                                已练 {stat.answered}/{stat.total}
                              </span>
                            </>
                          ) : null}
                          {deck.sourceId ? (
                            <>
                              <span className="pr-deck__dot" aria-hidden="true">
                                ·
                              </span>
                              <span className="page__muted">
                                {sources.find((s) => s.id === deck.sourceId)?.title ?? '资料已删除'}
                              </span>
                            </>
                          ) : null}
                        </div>
                        {stat && stat.answered === 0 ? (
                          <div className="pr-deck__note">还没练过这套题。</div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void startSession(deck.id, deck.title)}
                        disabled={preparing || deck.questionCount === 0}
                        title={deck.questionCount === 0 ? '这套题里没有题目' : '开始刷题'}
                      >
                        开始刷题
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * 本轮成绩。
 *
 * 三件事分开说：答了几道、对了几道、正确率。
 * 「未自评的问答」单列——把它们算进分母会把正确率算低，
 * 算进分子又会让用户看到一个虚高的数字。
 */
function ResultView({
  result,
  title,
  onAgain,
  onBack,
  onWrongBook,
  preparing,
  error,
}: {
  result: SessionResult;
  title: string;
  onAgain: () => void;
  onBack: () => void;
  onWrongBook: () => void;
  preparing: boolean;
  error: { message: string; hint: string } | null;
}) {
  const graded = result.answered - result.ungraded;
  const accuracy = graded > 0 ? result.correct / graded : null;

  return (
    <div className="page__stack pr-result">
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">本轮成绩</div>
            <div className="card__subtitle">{title}</div>
          </div>
          <Badge tone={accuracy === null ? 'neutral' : accuracy >= 0.6 ? 'ready' : 'planned'}>
            {accuracy === null ? '未判分' : `正确率 ${Math.round(accuracy * 100)}%`}
          </Badge>
        </div>

        <div className="card__body page__stack">
          <div className="pr-result__stats">
            <div className="pr-result__stat">
              <div className="pr-result__stat-value">{result.answered}</div>
              <div className="pr-result__stat-label">已作答</div>
            </div>
            <div className="pr-result__stat pr-result__stat--ok">
              <div className="pr-result__stat-value">{result.correct}</div>
              <div className="pr-result__stat-label">答对</div>
            </div>
            <div className="pr-result__stat pr-result__stat--bad">
              <div className="pr-result__stat-value">{graded - result.correct}</div>
              <div className="pr-result__stat-label">答错</div>
            </div>
            <div className="pr-result__stat">
              <div className="pr-result__stat-value">
                {accuracy === null ? '—' : `${Math.round(accuracy * 100)}%`}
              </div>
              <div className="pr-result__stat-label">正确率</div>
            </div>
          </div>

          <Notice tone="info" title="错题已经自动收进错题本">
            最近一次答错的那几道，已经进了错题本。错题本的定义是「最近一次作答答错」——
            你下次重做答对了，它会自动移出。
            {result.ungraded > 0 ? ` 有 ${result.ungraded} 道问答还没自评，它们不计入正确率。` : ''}
          </Notice>

          {error ? (
            <Notice tone="danger" title="没能开始下一轮">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}

          <div className="page__row">
            <button type="button" className="btn btn--primary" onClick={onAgain} disabled={preparing}>
              {preparing ? '准备中…' : '再刷一轮'}
            </button>
            <button type="button" className="btn" onClick={onWrongBook} disabled={preparing}>
              去错题本
            </button>
            <button type="button" className="btn btn--ghost" onClick={onBack} disabled={preparing}>
              返回选择习题集
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
