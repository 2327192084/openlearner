/**
 * 模拟考试。
 *
 * ## 三个阶段
 *
 *  1. `setup`   选范围（哪份资料/题组）、题目数、时限 → 出卷
 *  2. `taking`  倒计时答题，可随时交卷
 *  3. `result`  分数、逐题对错、可回看历史成绩
 *
 * ## 为什么交卷后才批改
 *
 * 做题（复习）时每题即时揭晓，是为了「马上知道自己会不会」。
 * 模拟考相反：**中途知道对错会影响后面的心态与答题**，
 * 那就不叫模拟考了。所以答案在交卷前一律不显示。
 *
 * ## 为什么不改复习进度
 *
 * 考试时紧张、状态差，用它的结果去改间隔复习的计划会把复习带偏。
 * 成绩单独记录（examAttempts），与 reviewRecords 完全隔离。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExamAnswer, ExamAttempt, Question, Source } from '@/core/model.ts';
import type { ExamService } from '@/core/exam.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { isCorrect } from '@/v2/core/cards.ts';
import { MathText } from './MathText.tsx';
import { isAutoGraded } from '@/core/questions/kinds.ts';
import { ExamGradePanel } from './ExamGradePanel.tsx';
import { usePageTask } from './page-task-context.ts';

export interface ExamPageProps {
  exam: ExamService;
  decks: DeckService;
  sourceService: SourceService;
  onOpenDecks: () => void;
  /**
   * AI 评分（2026-11-17 方案 3）。
   *
   * 用户要求「主要是 AI 评分，要是用户觉得评分不对可以自己再评」。
   * 由 App 注入 —— 本页不碰后端配置与 Key。
   *
   * 不传 = 不显示评分面板（成绩页保持老样子）。
   */
  onAiGrade?: (input: {
    prompt: string;
    answer: string;
    explanation: string;
    response: string;
  }) => Promise<import('@/core/ai/grade-short.ts').ShortGradeResult | null>;
}

/**
 * 页面阶段。
 *
 * `taking` 直接**带着试卷**，而不是靠一个模块级变量传：
 * 模块级可变状态在 React 里是事故源 —— 组件重渲染时读到的可能是
 * 上一次的残留，热更新时更是完全不可预期。
 */
type Phase =
  | { kind: 'setup' }
  | { kind: 'taking'; paper: Question[]; title: string; limitSec: number }
  | { kind: 'result'; attempt: ExamAttempt; questions: Question[] };

/** 可选的题目数量 */
const COUNT_OPTIONS = [5, 10, 20, 30, 50];
/** 可选的时限（分钟），0 = 不限时 */
const LIMIT_OPTIONS = [
  { min: 0, label: '不限时' },
  { min: 5, label: '5 分钟' },
  { min: 10, label: '10 分钟' },
  { min: 20, label: '20 分钟' },
  { min: 30, label: '30 分钟' },
  { min: 60, label: '60 分钟' },
];

export function ExamPage({ exam, decks, sourceService, onOpenDecks, onAiGrade }: ExamPageProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });

  /* ---- 可选题池 ---- */
  const [pools, setPools] = useState<{ id: string; label: string; questions: Question[] }[]>([]);
  const [poolId, setPoolId] = useState('');
  const [count, setCount] = useState(10);
  const [limitMin, setLimitMin] = useState(20);
  const [history, setHistory] = useState<ExamAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [deckList, srcs, attempts] = await Promise.all([
        decks.list(),
        sourceService.list(),
        exam.list(),
      ]);
      const published = deckList.filter((d) => d.status === 'published');
      const srcTitle = new Map<string, string>(srcs.map((s: Source) => [s.id, s.title]));

      /* 每个「可考范围」= 一份资料下所有已发布题组的题 */
      const bySource = new Map<string, { label: string; questions: Question[] }>();
      for (const d of published) {
        const qs = await decks.getQuestions(d.id);
        const key = d.sourceId ?? `__deck_${d.id}`;
        const label = d.sourceId
          ? (srcTitle.get(d.sourceId) ?? '（资料已删除）')
          : `题组：${d.title}`;
        const cur = bySource.get(key) ?? { label, questions: [] };
        /*
         * 全部题型都能进考场（2026-11-17 方案 3，用户要求）。
         *
         * 用户原话：「我选方案3（计算题和问答题都放进考场），但是除了自评
         * 还可以加入 ai 评分，主要是 ai 评分，要是用户觉得评分不对可以
         * 自己再评。」
         *
         * ## 为什么现在敢放开
         *
         * 2026-11-12 那次是「把计算题放进来，但判分仍走字符串相似度」——
         * 那才会错。现在自评题交卷时标 `correct: null` + `gradedBy:'pending'`，
         * 不算错、也不算对，评完才落定（见 ExamService.grade / submit）。
         *
         * ## 但仍要知道哪些题需要评
         *
         * 下面的 `needsGrading` 传给界面，用于：
         *  - 出卷时提示「其中 N 道交卷后需评分」
         *  - 成绩页把未评完的卷子标出来
         */
        cur.questions.push(...qs);
        bySource.set(key, cur);
      }

      const list = [...bySource.entries()]
        .filter(([, v]) => v.questions.length > 0)
        .map(([id, v]) => ({ id, label: v.label, questions: v.questions }));

      /* 全库合并池 */
      const all = list.flatMap((p) => p.questions);
      if (all.length > 0) {
        /*
         * label 里不放数量 —— 下拉选项渲染时本来就会补「（N 道）」，
         * 两处都写会变成「全部已发布题目（16 道）(16 道)」（截图核对时发现的）。
         */
        list.unshift({ id: '__all__', label: '全部已发布题目', questions: all });
      }

      setPools(list);
      setPoolId(list[0]?.id ?? '');
      setHistory(attempts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读不出题库');
    } finally {
      setLoading(false);
    }
  }, [decks, sourceService, exam]);

  useEffect(() => {
    void load();
  }, [load]);

  const pool = pools.find((p) => p.id === poolId);
  const available = pool?.questions.length ?? 0;
  /**
   * 这个范围里有多少道是「交卷后要评分」的（方案 3，2026-11-17）。
   *
   * 为什么要提前告诉用户：自评题进考场之后，一场 10 题的卷子
   * 可能有 3 题要等评分。用户在**开考前**就该知道，
   * 而不是交完卷发现「怎么不给我分数」。
   */
  const needsGradingCount = (pool?.questions ?? []).filter((q) => !isAutoGraded(q.kind)).length;

  if (loading) {
    return (
      <div className="exam-page">
        <p className="ex-hint">正在准备…</p>
      </div>
    );
  }

  if (pools.length === 0) {
    return (
      <div className="exam-page">
        <header className="ex-head">
          <h1 className="ex-title">模拟考试</h1>
        </header>
        <div className="ex-empty">
          <p>还没有可以考的题。</p>
          <p className="ex-hint">
            模拟考试只从<strong>已发布</strong>题组里抽题，而且不含问答、计算这类
            需要你自己判断对错的题（算不出客观分数）。
          </p>
          <button type="button" className="btn-ghost" onClick={onOpenDecks}>
            去我的题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="exam-page">
      {phase.kind === 'setup' ? (
        <SetupView
          pools={pools}
          poolId={poolId}
          onPool={setPoolId}
          count={count}
          onCount={setCount}
          limitMin={limitMin}
          onLimit={setLimitMin}
          available={available}
          needsGrading={needsGradingCount}
          history={history}
          err={err}
          onStart={() => {
            if (!pool) return;
            const paper = exam.buildPaper({ pool: pool.questions, count, title: pool.label });
            if (paper.length === 0) {
              setErr('这个范围里没有可考的题。');
              return;
            }
            setPhase({
              kind: 'taking',
              paper,
              title: pool.label,
              limitSec: limitMin * 60,
            });
          }}
          onOpenDecks={onOpenDecks}
        />
      ) : null}

      {phase.kind === 'taking' ? (
        <TakingView
          paper={phase.paper}
          title={phase.title}
          limitSec={phase.limitSec}
          onCancel={() => setPhase({ kind: 'setup' })}
          onSubmit={async (answers, startedAt, usedSec, timedOut) => {
            const attempt = await exam.submit({
              title: `模拟考试 · ${phase.title}`,
              questions: phase.paper,
              answers,
              startedAt,
              limitSec: phase.limitSec,
              usedSec,
              timedOut,
            });
            setPhase({ kind: 'result', attempt, questions: phase.paper });
            setHistory(await exam.list());
          }}
        />
      ) : null}

      {phase.kind === 'result' ? (
        <ResultView
          attempt={phase.attempt}
          questions={phase.questions}
          onAgain={() => {
            setPhase({ kind: 'setup' });
            void load();
          }}
          {...(onAiGrade ? { onAiGrade } : {})}
          /*
            评分落库（2026-11-17 方案 3）。
            用 exam.regradeAnswer —— 它会把整份卷子的 correct / pendingCount
            重算并写回，所以用户评到一半关软件，下次打开还在。
          */
          onRegrade={async (questionId, patch) => {
            const next = await exam.regradeAnswer(phase.attempt.id, questionId, patch);
            if (next) setPhase({ kind: 'result', attempt: next, questions: phase.questions });
          }}
        />
      ) : null}
    </div>
  );
}

/* ============================ 设置试卷 ============================ */

function SetupView({
  pools,
  poolId,
  onPool,
  count,
  onCount,
  limitMin,
  onLimit,
  available,
  needsGrading = 0,
  history,
  err,
  onStart,
  onOpenDecks,
}: {
  pools: { id: string; label: string; questions: Question[] }[];
  poolId: string;
  onPool: (v: string) => void;
  count: number;
  onCount: (v: number) => void;
  limitMin: number;
  onLimit: (v: number) => void;
  available: number;
  /** 其中有多少道交卷后需要评分（方案 3）。不传 = 0（不显示提示） */
  needsGrading?: number;
  history: ExamAttempt[];
  err: string | null;
  onStart: () => void;
  onOpenDecks: () => void;
}) {
  const usableCount = Math.min(count, available);

  return (
    <>
      <header className="ex-head">
        <h1 className="ex-title">模拟考试</h1>
        <p className="ex-lead">
          限时整卷、交卷后统一批改。考试结果<strong>不影响复习安排</strong> ——
          考砸了不会把你的复习计划带偏。
        </p>
      </header>

      {err ? <p className="ex-error">{err}</p> : null}

      <section className="ex-setup">
        <label className="ex-field">
          <span className="ex-field__label">考哪部分</span>
          <select className="ex-select" value={poolId} onChange={(e) => onPool(e.target.value)}>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}（{p.questions.length} 道）
              </option>
            ))}
          </select>
        </label>

        <div className="ex-field">
          <span className="ex-field__label">题目数</span>
          <div className="ex-options">
            {COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`ex-chip${count === n ? ' ex-chip--on' : ''}`}
                onClick={() => onCount(n)}
                disabled={n > available && available > 0}
                title={n > available ? `这个范围只有 ${available} 道` : ''}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="ex-field">
          <span className="ex-field__label">时限</span>
          <div className="ex-options">
            {LIMIT_OPTIONS.map((o) => (
              <button
                key={o.min}
                type="button"
                className={`ex-chip${limitMin === o.min ? ' ex-chip--on' : ''}`}
                onClick={() => onLimit(o.min)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ex-summary">
          这份卷子：<strong>{usableCount}</strong> 道题
          {limitMin > 0 ? ` · ${limitMin} 分钟` : ' · 不限时'}
          {available > 0 && count > available ? `（这个范围只有 ${available} 道，全用）` : ''}
        </div>

        {/*
          提前告知「有些题要评分」（2026-11-17 方案 3）。
          不说的话，用户交完卷看到「待评」会莫名其妙 ——
          他以为考试应该自动出分。
        */}
        {needsGrading > 0 ? (
          <p className="ex-note">
            这个范围里有 <strong>{needsGrading}</strong> 道计算/问答题，
            交卷后需要评分：可以让 AI 评，也可以自己判。没评完之前分数会标「待评」。
          </p>
        ) : null}

        <div className="ex-actions">
          <button
            type="button"
            className="btn-fill"
            onClick={onStart}
            disabled={available === 0}
          >
            开始考试
          </button>
          {available === 0 ? (
            <button type="button" className="btn-text" onClick={onOpenDecks}>
              这个范围没有可考的题，去发布题组
            </button>
          ) : null}
        </div>
      </section>

      {/* ---- 历史成绩 ---- */}
      {history.length > 0 ? (
        <section className="ex-history">
          <h2 className="ex-h2">历史成绩</h2>
          <ul className="ex-history__list">
            {history.slice(0, 10).map((a) => {
              /*
               * 待评的题不进分母（2026-11-17 方案 3）。
               * 拿 correct/total 算，一份还有 4 题没评的卷子会显示成
               * 「19/23 = 83%」，看起来像考砸了 —— 而那 4 题是没评，不是答错。
               */
              const pending = a.pendingCount ?? 0;
              const gradedTotal = a.total - pending;
              const rate = gradedTotal > 0 ? a.correct / gradedTotal : 0;
              return (
                <li key={a.id} className="ex-history__item">
                  <span className="ex-history__score">
                    {a.correct}/{gradedTotal}
                    {pending > 0 ? <em className="ex-history__pending">+{pending} 待评</em> : null}
                  </span>
                  <span className="ex-history__rate">
                    {gradedTotal > 0 ? `${Math.round(rate * 100)}%` : '待评'}
                  </span>
                  <span className="ex-history__title">{a.title}</span>
                  <span className="ex-history__time">{formatWhen(a.finishedAt)}</span>
                  {a.timedOut ? <span className="ex-history__flag">超时交卷</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* ============================ 考试中 ============================ */

function TakingView({
  paper,
  title,
  limitSec,
  onSubmit,
  onCancel,
}: {
  paper: Question[];
  title: string;
  limitSec: number;
  onSubmit: (
    answers: ExamAnswer[],
    startedAt: string,
    usedSec: number,
    timedOut: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  /** questionId → 作答内容 */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [remain, setRemain] = useState(limitSec);
  const [busy, setBusy] = useState(false);

  /**
   * 上报「正在考试」（2026-11-13 傍晚）。
   *
   * 由 `TakingView` 上报是刻意的：这个组件**只在考试进行中挂载** ——
   * setup（选卷子）和 result（成绩页）都不会渲染它。
   * 所以「上报存在」天然就等于「正在考试」，比在 ExamPage 里
   * 判 `phase.kind === 'taking'` 少一处可能不同步的判断。
   *
   * 进度用已答题数：考试中途跳去看原文时，用户最想知道的就是答了多少。
   */
  usePageTask({ label: '模拟考试', detail: `${index + 1}/${paper.length} 题` });
  const startedAtRef = useRef(new Date().toISOString());
  const startedMsRef = useRef(Date.now());
  /** 防止超时自动交卷触发两次（setInterval 与用户点击可能撞上） */
  const submittedRef = useRef(false);

  const q = paper[index];
  const total = paper.length;

  const doSubmit = useCallback(
    async (timedOut: boolean) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setBusy(true);
      const usedSec = (Date.now() - startedMsRef.current) / 1000;
      const list: ExamAnswer[] = paper.map((qq) => {
        const response = answers[qq.id] ?? '';
        return {
          questionId: qq.id,
          response,
          correct: isCorrect(
            /* 复用 v2 卡片层的判分：与做题时同一套规则，不会两处不一致 */
            {
              id: qq.id,
              sourceId: '',
              kind: qq.kind === 'essay' ? 'short' : (qq.kind as never),
              prompt: qq.prompt,
              options: qq.options,
              answer: qq.answer,
              explanation: qq.explanation,
              anchors: qq.anchors,
              deckId: qq.deckId,
              createdAt: qq.createdAt,
            },
            response,
          ),
        };
      });
      await onSubmit(list, startedAtRef.current, usedSec, timedOut);
    },
    [paper, answers, onSubmit],
  );

  /* 倒计时 */
  useEffect(() => {
    if (limitSec <= 0) return;
    const id = setInterval(() => {
      const left = limitSec - Math.floor((Date.now() - startedMsRef.current) / 1000);
      setRemain(left);
      if (left <= 0) {
        void doSubmit(true);
      }
    }, 500);
    return () => clearInterval(id);
  }, [limitSec, doSubmit]);

  if (!q) return null;

  const answered = Object.values(answers).filter((v) => v.trim().length > 0).length;

  return (
    <>
      <div className="ex-bar">
        <span className="ex-bar__title">{title}</span>
        <span className="ex-bar__progress">
          已答 {answered} / {total}
        </span>
        {limitSec > 0 ? (
          <span className={`ex-bar__clock${remain <= 60 ? ' ex-bar__clock--urgent' : ''}`}>
            {fmtClock(remain)}
          </span>
        ) : (
          <span className="ex-bar__clock">不限时</span>
        )}
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => void doSubmit(false)}
          disabled={busy}
        >
          {busy ? '交卷中…' : '交卷'}
        </button>
      </div>

      <div className="ex-card">
        <div className="ex-card__head">
          <span className="ex-card__no">
            第 {index + 1} 题 / 共 {total} 题
          </span>
          <span className="ex-card__kind">{kindLabel(q.kind)}</span>
        </div>

        <p className="ex-card__prompt"><MathText text={q.prompt} /></p>

        {q.options.length > 0 ? (
          <div className="ex-choices">
            {q.options.map((o) => {
              const picked =
                q.kind === 'multiple'
                  ? (answers[q.id] ?? '').split(',').filter(Boolean).includes(o.key)
                  : answers[q.id] === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  className={`ex-choice${picked ? ' ex-choice--on' : ''}`}
                  onClick={() => {
                    setAnswers((prev) => {
                      if (q.kind === 'multiple') {
                        const cur = (prev[q.id] ?? '').split(',').filter(Boolean);
                        const next = cur.includes(o.key)
                          ? cur.filter((k) => k !== o.key)
                          : [...cur, o.key];
                        return { ...prev, [q.id]: next.sort().join(',') };
                      }
                      return { ...prev, [q.id]: o.key };
                    });
                  }}
                >
                  <span className="ex-choice__key">{o.key}</span>
                  <span><MathText text={o.text} /></span>
                </button>
              );
            })}
          </div>
        ) : (
          <input
            className="ex-input"
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
            placeholder="填写答案…"
          />
        )}

        <div className="ex-card__nav">
          <button
            type="button"
            className="btn-text"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
          >
            ← 上一题
          </button>
          <button
            type="button"
            className="btn-text"
            onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
            disabled={index >= total - 1}
          >
            下一题 →
          </button>
        </div>
      </div>

      {/* 题号导航：一眼看出哪些还没答 */}
      <div className="ex-nav">
        {paper.map((qq, i) => {
          const has = (answers[qq.id] ?? '').trim().length > 0;
          return (
            <button
              key={qq.id}
              type="button"
              className={`ex-nav__dot${i === index ? ' ex-nav__dot--cur' : ''}${
                has ? ' ex-nav__dot--done' : ''
              }`}
              onClick={() => setIndex(i)}
              title={`第 ${i + 1} 题${has ? '（已答）' : '（未答）'}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <p className="ex-hint ex-hint--center">
        考试中不显示对错 —— 那是交卷之后的事。
        <button type="button" className="btn-text" onClick={onCancel}>
          放弃这次考试
        </button>
      </p>
    </>
  );
}

/* ============================ 成绩 ============================ */

function ResultView({
  attempt,
  questions,
  onAgain,
  onAiGrade,
  onRegrade,
}: {
  attempt: ExamAttempt;
  questions: Question[];
  onAgain: () => void;
  /** 调 AI 评分（2026-11-17 方案 3）。不传 = 不显示评分面板（保持老行为） */
  onAiGrade?: (input: {
    prompt: string;
    answer: string;
    explanation: string;
    response: string;
  }) => Promise<import('@/core/ai/grade-short.ts').ShortGradeResult | null>;
  /** 把评分结论落库 */
  onRegrade?: (
    questionId: string,
    patch: {
      correct: boolean;
      gradedBy: 'ai' | 'self';
      aiGrade?: ExamAnswer['aiGrade'];
      aiComment?: string | null;
    },
  ) => Promise<void>;
}) {
  /*
   * 分数怎么算（2026-11-17 方案 3）。
   *
   * ⚠️ 不能再用 `correct / total` —— 有题「还没评」时那样算会**压低分数**，
   * 用户看到「60 分」以为答错一堆，实际是 4 道题还没评。
   *
   * 所以分母排除掉待评题：
   *   已评完 → 正常百分比
   *   全待评 → 不给分数，只说「还没评」
   *   部分待评 → 给出「已评部分的正确率」并明确标注基数
   */
  const pending = attempt.answers.filter((a) => a.correct === null).length;
  const gradedTotal = attempt.total - pending;
  const rate = gradedTotal > 0 ? attempt.correct / gradedTotal : 0;
  const qById = new Map(questions.map((q) => [q.id, q]));
  /** 有评分面板才显示逐题评分区 */
  const canGrade = Boolean(onAiGrade && onRegrade);

  return (
    <>
      <header className="ex-head">
        <h1 className="ex-title">成绩</h1>
        <p className="ex-lead">{attempt.title}</p>
      </header>

      <div className="ex-score">
        {gradedTotal > 0 ? (
          <>
            <span className="ex-score__num">{Math.round(rate * 100)}</span>
            <span className="ex-score__unit">分</span>
          </>
        ) : (
          <span className="ex-score__num ex-score__num--pending">待评</span>
        )}
        <span className="ex-score__detail">
          答对 {attempt.correct} / {gradedTotal} 题（已评） · 用时 {fmtClock(attempt.usedSec)}
          {attempt.timedOut ? ' · 超时自动交卷' : ''}
        </span>
      </div>

      {/*
        未评完的提示（方案 3 的关键）。
        不写这句，用户会拿「已评部分的分」当最终成绩 —— 那是在骗人。
      */}
      {pending > 0 ? (
        <p className="ex-pending">
          还有 <strong>{pending}</strong> 道题没评（计算题 / 问答题需要评分）。
          下面的逐题回看里可以让 AI 评，也可以自己判。
        </p>
      ) : null}

      <div className="ex-actions">
        <button type="button" className="btn-fill" onClick={onAgain}>
          再考一次
        </button>
      </div>

      <h2 className="ex-h2">逐题回看</h2>
      <ul className="ex-review">
        {attempt.answers.map((a, i) => {
          const q = qById.get(a.questionId);
          if (!q) return null;
          /*
           * 三态展示（2026-11-17）：
           *   true  → ✓
           *   false → ✕
           *   null  → ?（待评，不是 ✕ —— 判也没判过，不能说错）
           */
          const mark = a.correct === null ? '?' : a.correct ? '✓' : '✕';
          const cls =
            a.correct === null
              ? ' ex-review__item--pending'
              : a.correct
                ? ' ex-review__item--ok'
                : '';
          /** 只有自评题型才需要（且能）评分 */
          const needGrade = a.correct === null || a.gradedBy === 'ai' || a.gradedBy === 'self';

          return (
            <li key={a.questionId} className={`ex-review__item${cls}`}>
              <div className="ex-review__head">
                <span className="ex-review__no">{i + 1}</span>
                <span
                  className={`ex-review__mark${a.correct === true ? ' ex-review__mark--ok' : ''}${
                    a.correct === null ? ' ex-review__mark--pending' : ''
                  }`}
                >
                  {mark}
                </span>
                <span className="ex-review__kind">{kindLabel(q.kind)}</span>
                {a.gradedBy === 'ai' ? (
                  <span className="ex-review__src">AI 评</span>
                ) : a.gradedBy === 'self' ? (
                  <span className="ex-review__src">自评</span>
                ) : null}
              </div>
              <p className="ex-review__prompt"><MathText text={q.prompt} /></p>
              <p className="ex-review__your">
                你的答案：{a.response.trim() || '（未作答）'}
              </p>
              {/*
                正确答案：待评时不提前show —— 先看了答案再让 AI 评分，
                用户会怀疑 AI 是照着答案说的（虽然事实不是）。
                评完或自评后展开。
              */}
              {a.correct !== true && (a.correct !== null || !canGrade) ? (
                <p className="ex-review__right">正确答案：<MathText text={q.answer} /></p>
              ) : null}
              {q.explanation ? (
                <p className="ex-review__explain"><MathText text={q.explanation} /></p>
              ) : null}

              {/* ---- 评分面板（方案 3） ---- */}
              {canGrade && needGrade ? (
                <ExamGradePanel
                  attempt={attempt}
                  question={q}
                  answer={a}
                  onAiGrade={onAiGrade!}
                  onGraded={async (patch) => {
                    await onRegrade!(a.questionId, patch);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ============================ 工具 ============================ */

function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'blank':
      return '填空';
    default:
      return k;
  }
}

/** 秒 → mm:ss / h:mm:ss */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
