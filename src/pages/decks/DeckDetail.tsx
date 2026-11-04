import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Deck, Question, QuestionIssue, Source } from '@/core/model.ts';
import { QuestionEditCard } from './QuestionEditCard.tsx';
import {
  accuracyText,
  describeError,
  formatTime,
  hintFrom,
} from './types.ts';
import type { DeckStats, Flash, Load } from './types.ts';

/**
 * 草稿审阅（`/decks` 内的详情视图）。
 *
 * ## 为什么不做成 `/decks/:id` 路由
 *
 * 注册表只有 `decks` 一条路由（`core/registry.ts` 是别人的域，不能加子路由），
 * 而 P2 的 KnowledgePage、P1 的 SourcesPage 已经把「页内切换视图」这条路走通了：
 * 详情用 `deckId` 状态表示，返回列表不丢筛选与滚动。
 *
 * ## 读写分离的落点
 *
 * 这个页面才 `getQuestions(deckId)` —— 列表页只拿元信息。
 * 题目一多（200 道）时，这个区别就是「点进去要等一下」和「点进去就开」。
 *
 * ## 发布的两道闸
 *
 *  1. 有 blocking → 按钮禁用，并把**每一条**原因列出来（不是只给个数）；
 *  2. 有 warning → 允许发布，但点下去要二次确认，说明有几条提醒。
 * 这两个行为都是计划书 P3 第 2 条的原话。
 */

export function DeckDetail({
  deckId,
  onBack,
  onChanged,
  onPractice,
}: {
  deckId: string;
  onBack: () => void;
  /** 卡片的每次写动作后刷新列表页的元信息（题数/阻塞数会变） */
  onChanged: () => void | Promise<void>;
  onPractice: (deckId: string) => void;
}) {
  const { decks: deckService, sources: sourceService } = useServices();

  const [deckState, setDeckState] = useState<Load<Deck>>({ kind: 'loading' });
  const [questionsState, setQuestionsState] = useState<Load<Question[]>>({ kind: 'loading' });
  const [issuesState, setIssuesState] = useState<Load<QuestionIssue[]>>({ kind: 'loading' });
  const [source, setSource] = useState<Source | null>(null);
  const [stats, setStats] = useState<DeckStats | null>(null);

  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  /** 发布二次确认（有 warning 时） */
  const [confirmPublish, setConfirmPublish] = useState<QuestionIssue[] | null>(null);

  // ---- 读 ----

  const loadQuestions = useCallback(async () => {
    try {
      const list = await deckService.getQuestions(deckId);
      setQuestionsState({ kind: 'ready', data: list });
    } catch (err) {
      setQuestionsState({
        kind: 'error',
        message: describeError(err),
        hint: '题目正文没有丢。刷新页面重试；若反复失败，可能是本地存储异常。',
      });
    }
  }, [deckService, deckId]);

  /**
   * 校验。
   *
   * 用 `revalidate()` 而不是纯函数 `validateQuestions()`：
   * 它会把 blocking 数顺手写回 Deck，列表页的「N 个待修」徽标才能同步。
   */
  const loadIssues = useCallback(async () => {
    try {
      const result = await deckService.revalidate(deckId);
      setIssuesState({ kind: 'ready', data: result.issues });
    } catch (err) {
      setIssuesState({
        kind: 'error',
        message: describeError(err),
        hint: '校验没有跑完，所以暂时不能根据它判断能不能发布。刷新页面重试。',
      });
    }
  }, [deckService, deckId]);

  const loadDeck = useCallback(async () => {
    setDeckState({ kind: 'loading' });
    setQuestionsState({ kind: 'loading' });
    setIssuesState({ kind: 'loading' });
    setError(null);
    try {
      const deck = await deckService.get(deckId);
      if (!deck) {
        setError({
          message: '这个习题集已经不在了。',
          hint: '它可能刚被删除（删除会连题目和作答记录一起清掉）。返回列表看看有哪些现存的。',
        });
        setDeckState({
          kind: 'error',
          message: '习题集不存在',
          hint: '返回列表重新选择一个习题集。',
        });
        return;
      }
      setDeckState({ kind: 'ready', data: deck });

      // 出处显示要用资料类型：docx/md 的 page 是章节序号，界面要写「节」不是「页」
      if (deck.sourceId) {
        void sourceService
          .get(deck.sourceId)
          .then((s) => setSource(s))
          .catch(() => setSource(null));
      } else {
        setSource(null);
      }

      void deckService
        .getStats(deckId)
        .then((s) => setStats(s))
        .catch(() => setStats(null));

      await Promise.all([loadQuestions(), loadIssues()]);
    } catch (err) {
      setDeckState({
        kind: 'error',
        message: describeError(err),
        hint: '习题集没有丢。刷新页面重试；若反复失败，可能是本地存储异常。',
      });
    }
  }, [deckService, deckId, sourceService, loadQuestions, loadIssues]);

  useEffect(() => {
    void loadDeck();
  }, [loadDeck]);

  const deck = deckState.kind === 'ready' ? deckState.data : null;
  const questions = questionsState.kind === 'ready' ? questionsState.data : [];
  const issues = issuesState.kind === 'ready' ? issuesState.data : [];

  const blocking = useMemo(() => issues.filter((i) => i.severity === 'blocking'), [issues]);
  const warnings = useMemo(() => issues.filter((i) => i.severity === 'warning'), [issues]);

  /** questionId → 该题的问题，卡片上内联显示 */
  const issuesByQuestion = useMemo(() => {
    const map = new Map<string, QuestionIssue[]>();
    for (const issue of issues) {
      const list = map.get(issue.questionId) ?? [];
      list.push(issue);
      map.set(issue.questionId, list);
    }
    return map;
  }, [issues]);

  // ---- 写 ----

  const run = useCallback(
    async (
      action: () => Promise<void>,
      fallbackHint: string,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (err) {
        setError({ message: describeError(err), hint: hintFrom(err, fallbackHint) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /**
   * 卡片里任何写动作之后统一刷新。
   *
   * 一次刷新三样：题目正文、校验结果、Deck 元信息。
   * 不能只刷其中一个 —— 改了题干之后，「题干重复」这类跨题的问题
   * 可能**在另一道题上**出现或消失，只刷被改的那张卡会漏掉。
   */
  const handleQuestionChanged = useCallback(async () => {
    await Promise.all([loadQuestions(), loadIssues()]);
    await onChanged();
    const fresh = await deckService.get(deckId).catch(() => null);
    if (fresh) setDeckState({ kind: 'ready', data: fresh });
  }, [loadQuestions, loadIssues, onChanged, deckService, deckId]);

  const doPublish = useCallback(
    async (allowWarnings: boolean) => {
      const ok = await run(
        async () => {
          await deckService.publish(deckId, { allowWarnings });
          await handleQuestionChanged();
        },
        '发布没有完成，习题集仍是草稿。可以刷新后重试；如果提示还有阻塞问题，先按上面的清单修好。',
      );
      setConfirmPublish(null);
      if (ok) {
        setFlash({
          tone: 'info',
          text: allowWarnings
            ? '已发布（有提醒，你确认过了）。现在去「练习」页就能刷到这套题。'
            : '已发布。现在去「练习」页就能刷到这套题。',
        });
      }
    },
    [run, deckService, deckId, handleQuestionChanged],
  );

  const handlePublishClick = () => {
    if (blocking.length > 0) return;
    if (warnings.length > 0) {
      setConfirmPublish(warnings);
      return;
    }
    void doPublish(false);
  };

  const handleUnpublish = async () => {
    const ok = window.confirm(
      '把这套题改回草稿？\n\n' +
        '改回草稿后，它不会再出现在「练习」页的可选列表里 —— 已经做过的作答记录仍然保留，' +
        '不会因为改回草稿就消失。\n\n' +
        '改了题目之后应当这么做，避免学生刷到半成品。',
    );
    if (!ok) return;
    const done = await run(
      async () => {
        await deckService.unpublish(deckId);
        await handleQuestionChanged();
      },
      '状态没有改成功，它仍是已发布。可以再点一次；已发布状态不会因为你点了按钮而变化。',
    );
    if (done) {
      setFlash({ tone: 'warning', text: '已改回草稿。练习页不再列出它，修好后可以重新发布。' });
    }
  };

  /**
   * 重命名：**core 目前没有 updateDeck 方法**，所以这里不做。
   *
   * 不放一个「点了必然报错」的按钮——那比没有按钮更糟，用户会反复点。
   * 需要这个能力的话，core 补一个 `updateDeck(deckId, patch)` 即可（见交付报告）。
   */

  // ---- 三态 ----

  if (deckState.kind === 'loading') return <LoadingState label="正在打开习题集…" />;

  if (deckState.kind === 'error') {
    return (
      <ErrorState
        title="读不出这个习题集"
        message={deckState.message}
        hint={deckState.hint}
        onRetry={() => void loadDeck()}
      />
    );
  }

  if (!deck) return null;

  const published = deck.status === 'published';
  const canPublish = blocking.length === 0 && questions.length > 0 && !busy;
  const publishBlockedReason =
    questions.length === 0
      ? '这套题里一道题都没有，无法发布。'
      : blocking.length > 0
        ? `还有 ${blocking.length} 个问题必须先修好才能发布（见下面的红色清单）。`
        : null;

  return (
    <div className="page__stack dk-detail">
      <div className="dk-detail__topbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← 返回习题集列表
        </button>
        <div className="page__row">
          {published ? <Badge tone="ready">已发布</Badge> : <Badge tone="planned">草稿</Badge>}
          <Badge tone="neutral">{questions.length} 题</Badge>
          {/*
            标明是谁出的。没有这个标识时，用户用示例后端出了一批机械挖空的题，
            会以为 AI 出题能力不行 —— 实际上压根没用 AI。
          */}
          {deck.backendId === 'mock-questions' || deck.backendId === 'mock' ? (
            <Badge tone="neutral">
              <span title="示例后端只按机械规则挖空、拼干扰项，不是 AI 出的题">
                示例后端·非 AI
              </span>
            </Badge>
          ) : (
            <Badge tone="info">AI 生成</Badge>
          )}
          {source ? <Badge tone="neutral">来自：{source.title}</Badge> : null}
        </div>
      </div>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      {/* ---------- 元信息 ---------- */}
      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">{deck.title}</div>
            <div className="card__subtitle">
              创建于 {formatTime(deck.createdAt)}
              {deck.publishedAt ? ` · 发布于 ${formatTime(deck.publishedAt)}` : ''}
              {stats
                ? ` · 已练 ${stats.answered}/${stats.total} 题，正确率 ${accuracyText(stats.accuracy)}`
                : ''}
            </div>
          </div>
        </div>

        <div className="card__body page__stack">
          {published ? (
            <Notice tone="info" title="这套题已经发布，学生能刷到">
              改了题目之后请点「改回草稿」再改——否则学生可能刷到半成品。
              改完重新发布即可，作答记录不会因此丢失。
            </Notice>
          ) : (
            <Notice tone="warning" title="这是草稿，还不能刷">
              草稿只有你能看到。逐题检查题干、选项、答案、解析和出处，
              确认没问题再发布。发布时会再校验一遍。
            </Notice>
          )}

          {/* ---------- 校验结果 ---------- */}
          {issuesState.kind === 'loading' ? (
            <div className="page__muted">正在逐题校验…</div>
          ) : issuesState.kind === 'error' ? (
            <Notice tone="danger" title="校验没跑完">
              {issuesState.message}
              <br />
              <strong>下一步：</strong>
              {issuesState.hint}
            </Notice>
          ) : issues.length === 0 ? (
            <div className="dk-check dk-check--ok">
              <strong>校验通过</strong>
              <span>
                每道题都有答案、解析和出处，没有重复题干。可以发布。
              </span>
            </div>
          ) : (
            <div className="dk-check">
              {/*
                blocking 与 warning 必须**分组、且视觉上一眼可辨**：
                blocking 是「不修就不能发」，warning 是「能发，但看一眼」。
                混在一起列会让用户以为全部都拦着发布。
              */}
              <div className="dk-check__group dk-check__group--blocking">
                <div className="dk-check__title">
                  <Badge tone="danger">阻塞 {blocking.length}</Badge>
                  <span>修好才能发布</span>
                </div>
                {blocking.length === 0 ? (
                  <div className="dk-check__empty">没有阻塞问题。</div>
                ) : (
                  <ul className="dk-check__list">
                    {blocking.map((issue, idx) => (
                      <li key={`b-${issue.questionId}-${issue.code}-${idx}`}>
                        <button
                          type="button"
                          className="dk-check__jump"
                          onClick={() => {
                            document
                              .getElementById(`q-${issue.questionId}`)
                              ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                          }}
                        >
                          {issue.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="dk-check__group dk-check__group--warning">
                <div className="dk-check__title">
                  <Badge tone="planned">提醒 {warnings.length}</Badge>
                  <span>可以发布，但建议看一眼</span>
                </div>
                {warnings.length === 0 ? (
                  <div className="dk-check__empty">没有提醒。</div>
                ) : (
                  <ul className="dk-check__list">
                    {warnings.map((issue, idx) => (
                      <li key={`w-${issue.questionId}-${issue.code}-${idx}`}>
                        <button
                          type="button"
                          className="dk-check__jump"
                          onClick={() => {
                            document
                              .getElementById(`q-${issue.questionId}`)
                              ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                          }}
                        >
                          {issue.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* ---------- 发布 / 改回草稿 ---------- */}
          <div className="dk-publish">
            <div className="dk-publish__info">
              {publishBlockedReason ? (
                <span className="dk-publish__blocked">{publishBlockedReason}</span>
              ) : published ? (
                <span className="page__muted">
                  已发布。要改题目请先改回草稿，改完再发布。
                </span>
              ) : warnings.length > 0 ? (
                <span className="dk-publish__warn">
                  有 {warnings.length} 条提醒。发布时会再让你确认一次。
                </span>
              ) : (
                <span className="page__muted">校验通过，可以发布。</span>
              )}
            </div>
            <div className="page__row" style={{ flex: 'none' }}>
              {published ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onPractice(deck.id)}
                    disabled={busy}
                  >
                    去刷这套题
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => void handleUnpublish()}
                    disabled={busy}
                  >
                    改回草稿
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handlePublishClick}
                  disabled={!canPublish}
                  title={publishBlockedReason ?? '发布这套题'}
                >
                  {busy ? '处理中…' : '发布'}
                </button>
              )}
            </div>
          </div>

          {/* ---------- 发布二次确认（有 warning 时） ---------- */}
          {confirmPublish ? (
            <div className="dk-confirm" role="dialog" aria-label="发布前确认">
              <div className="dk-confirm__title">还有 {confirmPublish.length} 条提醒，仍要发布吗？</div>
              <div className="dk-confirm__body">
                这些提醒不影响刷题，但每一条都对应一个「学生可能会困惑」的点：
                <ul className="dk-confirm__list">
                  {confirmPublish.slice(0, 8).map((issue, idx) => (
                    <li key={`c-${issue.questionId}-${idx}`}>{issue.message}</li>
                  ))}
                  {confirmPublish.length > 8 ? (
                    <li>……还有 {confirmPublish.length - 8} 条</li>
                  ) : null}
                </ul>
              </div>
              <div className="page__row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirmPublish(null)}
                  disabled={busy}
                >
                  回去改
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void doPublish(true)}
                  disabled={busy}
                >
                  {busy ? '发布中…' : '仍然发布'}
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <Notice tone="danger" title="操作没有完成">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}
        </div>
      </section>

      {/* ---------- 题目列表 ---------- */}
      {questionsState.kind === 'loading' ? (
        <LoadingState label="正在读取题目…" />
      ) : questionsState.kind === 'error' ? (
        <ErrorState
          title="读不出题目"
          message={questionsState.message}
          hint={questionsState.hint}
          onRetry={() => void loadQuestions()}
        />
      ) : questions.length === 0 ? (
        <div className="card">
          <div className="card__body">
            <Notice tone="warning" title="这套题里没有任何题目">
              可能出题过程中途停了，或者题目被逐条删光了。空习题集无法发布。
              可以回列表删掉它，重新出一次题。
            </Notice>
          </div>
        </div>
      ) : (
        <section className="page__stack">
          <div className="dk-detail__listhead">
            <h3 className="page__section-title">逐题检查（{questions.length} 题）</h3>
            <span className="page__muted">
              出处继承自知识点，不可在这里改——它已经在原文里定位验证过了。
            </span>
          </div>
          <ul className="dk-questions">
            {questions.map((q) => (
              <QuestionEditCard
                key={q.id}
                question={q}
                issues={issuesByQuestion.get(q.id) ?? []}
                sourceKind={source?.kind}
                busy={busy}
                onChange={handleQuestionChanged}
                onNotify={setFlash}
              />
            ))}
          </ul>
        </section>
      )}

      {/* ---------- 统计尾部（只在有作答时显示） ---------- */}
      {stats && stats.answered > 0 ? (
        <section className="card">
          <div className="card__head">
            <div className="card__title">这套题的练习情况</div>
          </div>
          <div className="card__body">
            <dl className="dl">
              <dt>题数</dt>
              <dd>{stats.total} 道</dd>
              <dt>练过</dt>
              <dd>{stats.answered} 道</dd>
              <dt>答对</dt>
              <dd>{stats.correct} 道</dd>
              <dt>正确率</dt>
              <dd>
                {accuracyText(stats.accuracy)}
                <span className="page__muted">（按每题最近一次作答算）</span>
              </dd>
            </dl>
          </div>
        </section>
      ) : null}
    </div>
  );
}
