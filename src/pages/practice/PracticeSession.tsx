import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { AnswerRecord, Question, Source } from '@/core/model.ts';
import { SourcePeek } from './SourcePeek.tsx';
import { describeError, hintFrom, kindLabel, levelLabel, locationText } from '../decks/types.ts';
import './practice.css';

/**
 * 练习会话：逐题作答 → 判分 → 看解析 → 看原文。
 *
 * ## 几个不能妥协的点
 *
 * 1. **答案和解析在作答前不能出现在 DOM 里。**
 *    不是「用 CSS 藏起来」——那样打开开发者工具就能看到，
 *    而且截图/无障碍朗读也会泄露。这里是条件渲染，作答前这些节点不存在。
 *
 * 2. **问答题不假装能自动判分。**
 *    `gradeAnswer()` 对 essay 返回 null，这是 core 的明确设计。
 *    界面必须让用户自己判，而且要先看到参考答案再判——
 *    先判后看答案等于让他凭印象猜自己写得对不对。
 *
 * 3. **每题记耗时。**
 *    从「这道题出现在屏幕上」到「点提交」的 `Date.now()` 差值。
 *    切换题目时重置计时起点，但**回看已答过的题不重新计时**
 *    （那不是一次新的作答）。
 *
 * 4. **答错时解析里必须能点回原文。**
 *    这是本产品的卖点：不是「你错了」，而是「你错了，依据在这里」。
 */

type Phase =
  /** 还没作答 */
  | { kind: 'answering' }
  /** 问答题：已提交文本，等自评 */
  | { kind: 'self-grading'; response: string }
  /** 已判分 */
  | { kind: 'graded'; correct: boolean | null; record: AnswerRecord; response: string };

export interface SessionResult {
  answered: number;
  correct: number;
  /** 未自评的问答数（correct === null），它们不计入正确率 */
  ungraded: number;
}

export function PracticeSession({
  questions,
  deckTitle,
  sourceKindById,
  onFinish,
  onExit,
}: {
  questions: Question[];
  /** 顶部标题（习题集名，或「只刷错题」） */
  deckTitle: string;
  /** questionId 的 deck 对应资料类型，用于把 DOCX 的页码写成「节」 */
  sourceKindById: Map<string, Source['kind']>;
  /** 练完（或中途退出）时把本轮成绩交给父组件 */
  onFinish: (result: SessionResult) => void;
  onExit: () => void;
}) {
  const { decks: deckService } = useServices();

  const [index, setIndex] = useState(0);
  /** 每题的选择/输入草稿。key 是 question.id */
  const [responses, setResponses] = useState<Record<string, string>>({});
  /** 每题判分后的状态。key 是 question.id */
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  /** 逐题展开原文的开关 */
  const [peekOpen, setPeekOpen] = useState<Record<string, boolean>>({});

  /** 当前题的计时起点 */
  const startedAtRef = useRef<number>(Date.now());

  const question = questions[index];
  const phase: Phase = question ? (phases[question.id] ?? { kind: 'answering' }) : { kind: 'answering' };
  const response = question ? (responses[question.id] ?? '') : '';

  const total = questions.length;

  const answeredCount = useMemo(
    () => Object.values(phases).filter((p) => p.kind === 'graded').length,
    [phases],
  );

  const result: SessionResult = useMemo(() => {
    let correct = 0;
    let ungraded = 0;
    let answered = 0;
    for (const p of Object.values(phases)) {
      if (p.kind !== 'graded') continue;
      answered += 1;
      if (p.correct === true) correct += 1;
      else if (p.correct === null) ungraded += 1;
    }
    return { answered, correct, ungraded };
  }, [phases]);

  // 换题时重置计时起点（每题耗时从「看到题」算起）
  useEffect(() => {
    startedAtRef.current = Date.now();
    setError(null);
  }, [index]);

  const setResponse = (text: string) => {
    if (!question) return;
    setResponses((prev) => ({ ...prev, [question.id]: text }));
  };

  /** 客观题提交：判分 + 落库 */
  const submitObjective = useCallback(async () => {
    if (!question || submitting) return;
    const text = (responses[question.id] ?? '').trim();

    if (!text) {
      setError({
        message: '还没作答。',
        hint:
          question.kind === 'multiple' || question.kind === 'single'
            ? '先选一个选项再提交。'
            : '先在输入框里写下你的答案再提交。',
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    const elapsedMs = Date.now() - startedAtRef.current;

    try {
      const { record, correct } = await deckService.submitAnswer({
        questionId: question.id,
        response: text,
        elapsedMs,
      });
      setPhases((prev) => ({
        ...prev,
        [question.id]: { kind: 'graded', correct, record, response: text },
      }));
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(
          err,
          '这次作答没有记录成功。题目没有丢，可以再点一次提交；如果反复失败，检查本地存储是否可用。',
        ),
      });
    } finally {
      setSubmitting(false);
    }
  }, [question, submitting, responses, deckService]);

  /**
   * 问答题：第一步只是把作答文本收起来，等用户自评。
   *
   * 为什么不在这一步就落库：`submitAnswer` 需要一个 selfGrade，
   * 此时还不知道。先存进 `phases` 的 `self-grading` 状态，纯前端。
   */
  const submitEssay = () => {
    if (!question || submitting) return;
    const text = (responses[question.id] ?? '').trim();
    if (!text) {
      setError({
        message: '还没作答。',
        hint: '先写下你的答案（哪怕只写要点），提交后再对照参考答案自评。',
      });
      return;
    }
    setError(null);
    setPhases((prev) => ({ ...prev, [question.id]: { kind: 'self-grading', response: text } }));
  };

  /** 问答题：自评后落库 */
  const selfGrade = useCallback(
    async (correct: boolean) => {
      if (!question || submitting) return;
      const current = phases[question.id];
      if (!current || current.kind !== 'self-grading') return;

      setSubmitting(true);
      setError(null);
      const elapsedMs = Date.now() - startedAtRef.current;

      try {
        const { record, correct: graded } = await deckService.submitAnswer({
          questionId: question.id,
          response: current.response,
          selfGrade: correct,
          elapsedMs,
        });
        setPhases((prev) => ({
          ...prev,
          [question.id]: {
            kind: 'graded',
            correct: graded,
            record,
            response: current.response,
          },
        }));
      } catch (err) {
        setError({
          message: describeError(err),
          hint: hintFrom(err, '自评结果没有记录成功。可以再点一次；题目没有丢。'),
        });
      } finally {
        setSubmitting(false);
      }
    },
    [question, submitting, phases, deckService],
  );

  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= total) return;
    setIndex(next);
  };

  if (total === 0) {
    return (
      <div className="card">
        <Notice tone="warning" title="没有可练习的题目">
          这套题里一道题都没有。回到习题集页检查一下，或者换一套。
        </Notice>
      </div>
    );
  }

  if (!question) return null;

  const graded = phase.kind === 'graded';
  const selfGrading = phase.kind === 'self-grading';
  const kind = question.kind;
  const hasOptions = kind === 'single' || kind === 'multiple';
  const sourceKind = sourceKindById.get(question.deckId);

  /** 单选/多选：把答案拆成 key 数组，方便 checkbox 判断 */
  const selectedKeys = response
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);

  const toggleKey = (key: string) => {
    if (kind === 'single') {
      setResponse(key);
      return;
    }
    // 多选：点一下加/减，最后按字母序拼回去（core 判分对顺序不敏感，但存整齐更好读）
    const next = selectedKeys.includes(key)
      ? selectedKeys.filter((k) => k !== key)
      : [...selectedKeys, key];
    setResponse(next.sort().join(','));
  };

  return (
    <div className="page__stack pr-session">
      {/* ---------- 顶部：进度 ---------- */}
      <div className="pr-session__bar">
        <div className="pr-session__bar-main">
          <div className="pr-session__title">{deckTitle}</div>
          <div className="pr-session__progress">
            第 <strong>{index + 1}</strong> / {total} 题
            <span className="page__muted">
              （已作答 {answeredCount} 题，答对 {result.correct} 题
              {result.ungraded > 0 ? `，${result.ungraded} 题待自评` : ''}）
            </span>
          </div>
        </div>
        <div className="page__row" style={{ flex: 'none' }}>
          <button
            type="button"
            className="btn"
            onClick={() => onFinish(result)}
            disabled={submitting}
          >
            结束练习
          </button>
          <button type="button" className="btn btn--ghost" onClick={onExit} disabled={submitting}>
            退出
          </button>
        </div>
      </div>

      <div
        className="pr-session__rail"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={index + 1}
        aria-label="练习进度"
      >
        <div
          className="pr-session__rail-fill"
          style={{ width: `${Math.round(((index + 1) / total) * 100)}%` }}
        />
      </div>

      {/* ---------- 题目卡 ---------- */}
      <section className="card pr-q" key={question.id}>
        <div className="pr-q__head">
          <div className="pr-q__badges">
            <Badge tone="neutral">{kindLabel(kind)}</Badge>
            <Badge tone="neutral">{levelLabel(question.cognitiveLevel)}</Badge>
            {question.topic ? <span className="pr-q__topic">{question.topic}</span> : null}
          </div>
          {graded ? (
            <Badge tone={phase.correct === null ? 'planned' : phase.correct ? 'ready' : 'danger'}>
              {phase.correct === null ? '待你判断' : phase.correct ? '答对了' : '答错了'}
            </Badge>
          ) : null}
        </div>

        <div className="pr-q__body">
          <div className="pr-q__prompt">{question.prompt}</div>

          {/* ----- 作答区 ----- */}
          {hasOptions ? (
            <ul className="pr-q__options">
              {question.options.map((opt) => {
                const checked = selectedKeys.includes(opt.key);
                const showAsCorrect = graded && isCorrectKey(question, opt.key);
                const showAsWrong = graded && checked && !isCorrectKey(question, opt.key);

                return (
                  <li key={opt.key}>
                    <label
                      className={`pr-q__option${checked ? ' pr-q__option--checked' : ''}${
                        showAsCorrect ? ' pr-q__option--correct' : ''
                      }${showAsWrong ? ' pr-q__option--wrong' : ''}`}
                    >
                      <input
                        type={kind === 'multiple' ? 'checkbox' : 'radio'}
                        name={`q-${question.id}`}
                        checked={checked}
                        onChange={() => toggleKey(opt.key)}
                        // 判分后锁定：不允许改答案再交一次，
                        // 否则「最近一次作答」的语义会变成「反复试到对为止」
                        disabled={graded || selfGrading || submitting}
                      />
                      <span className="pr-q__option-key">{opt.key}</span>
                      <span className="pr-q__option-text">{opt.text}</span>
                      {showAsCorrect ? <Badge tone="ready">正确答案</Badge> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : kind === 'blank' ? (
            <div className="field">
              <label className="field__label" htmlFor={`pr-blank-${question.id}`}>
                你的答案
              </label>
              <input
                id={`pr-blank-${question.id}`}
                className="input"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                disabled={graded || selfGrading || submitting}
                placeholder="填写关键词或短语"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !graded && !selfGrading) void submitObjective();
                }}
              />
              <div className="field__hint">
                判分忽略大小写、空格和首尾标点——不用为了迎合判分器刻意改写法。
              </div>
            </div>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor={`pr-essay-${question.id}`}>
                你的回答
              </label>
              <textarea
                id={`pr-essay-${question.id}`}
                className="textarea"
                rows={5}
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                disabled={graded || selfGrading || submitting}
                placeholder="用自己的话写，写完再对照参考答案自评"
              />
              <div className="field__hint">
                问答题没法自动判分。提交后你会看到参考答案，由你自己判断答得对不对——
                我们不会假装能替你打分。
              </div>
            </div>
          )}

          {/* ----- 提交按钮（未判分时） ----- */}
          {!graded && !selfGrading ? (
            <div className="page__row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void (kind === 'essay' ? submitEssay() : submitObjective())}
                disabled={submitting}
              >
                {submitting ? '提交中…' : '提交'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onFinish(result)}
                disabled={submitting}
              >
                跳过，直接结束
              </button>
            </div>
          ) : null}

          {error ? (
            <Notice tone="danger" title="这次提交没有完成">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}

          {/* ----- 自评（问答，尚未落库） ----- */}
          {selfGrading ? (
            <div className="pr-q__selfgrade">
              <Notice tone="info" title="对照下面的参考答案，自己判断">
                先看参考答案和你写的回答，再选一个。你的判断会记进错题本——
                答错了，这道题会留在错题本里等你重做；答对了就会移出。
              </Notice>

              <div className="pr-q__answer">
                <div className="pr-q__answer-label">参考答案</div>
                <div className="pr-q__answer-text">{question.answer}</div>
              </div>

              <div className="page__row">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void selfGrade(true)}
                  disabled={submitting}
                >
                  我答对了
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => void selfGrade(false)}
                  disabled={submitting}
                >
                  我答错了
                </button>
              </div>
            </div>
          ) : null}

          {/* ----- 判分结果（作答后才渲染，答案与解析此前不在 DOM 里） ----- */}
          {graded ? (
            <div className="pr-q__result">
              <div
                className={`pr-q__verdict pr-q__verdict--${
                  phase.correct === null ? 'unknown' : phase.correct ? 'correct' : 'wrong'
                }`}
              >
                {phase.correct === null
                  ? '已记录（自评未给出对错）'
                  : phase.correct
                    ? '答对了'
                    : '答错了'}
                {phase.record.elapsedMs !== null ? (
                  <span className="pr-q__verdict-time">
                    用时 {(phase.record.elapsedMs / 1000).toFixed(1)} 秒
                  </span>
                ) : null}
              </div>

              <div className="pr-q__answer">
                <div className="pr-q__answer-label">
                  {hasOptions ? '正确答案' : '参考答案'}
                </div>
                <div className="pr-q__answer-text">
                  {formatAnswer(question)}
                  {hasOptions && phase.response ? (
                    <span className="page__muted"> · 你选了 {phase.response}</span>
                  ) : null}
                </div>
              </div>

              {question.explanation.trim() ? (
                <div className="pr-q__explain">
                  <div className="pr-q__answer-label">解析</div>
                  <div className="pr-q__explain-text">{question.explanation}</div>
                </div>
              ) : (
                <div className="pr-q__explain pr-q__explain--empty">
                  这道题没有解析。可以点下面的「看原文」自己对照依据。
                </div>
              )}

              {/*
                答错时把「看原文」放在解析正下方、并且加重语气。
                答对了也给（有人想确认依据），但不那么显眼。
              */}
              <div className="pr-q__source">
                {question.anchors.length === 0 ? (
                  <div className="pr-q__source-empty">
                    这道题没有出处（它依据的知识点没定位到原文），所以无法看原文。
                  </div>
                ) : (
                  <>
                    <div className="pr-q__source-row">
                      <span className="pr-q__source-label">出处</span>
                      <span>{locationText(question.anchors[0], sourceKind)}</span>
                      <button
                        type="button"
                        className={`btn btn--sm${phase.correct === false ? ' btn--primary' : ''}`}
                        onClick={() =>
                          setPeekOpen((prev) => ({ ...prev, [question.id]: !prev[question.id] }))
                        }
                      >
                        {peekOpen[question.id] ? '收起原文' : '看原文'}
                      </button>
                    </div>
                    {peekOpen[question.id] ? (
                      <SourcePeek
                        sourceId={question.anchors[0].sourceId}
                        anchor={question.anchors[0]}
                        sourceKind={sourceKind}
                        onClose={() =>
                          setPeekOpen((prev) => ({ ...prev, [question.id]: false }))
                        }
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ---------- 翻页 ---------- */}
      <div className="pr-nav">
        <button
          type="button"
          className="btn"
          onClick={() => go(-1)}
          disabled={index === 0 || submitting}
        >
          ← 上一题
        </button>

        <div className="pr-nav__dots" aria-hidden="true">
          {questions.map((q, i) => {
            const p = phases[q.id];
            const state =
              p?.kind === 'graded'
                ? p.correct === false
                  ? 'wrong'
                  : p.correct === true
                    ? 'correct'
                    : 'unknown'
                : p?.kind === 'self-grading'
                  ? 'unknown'
                  : 'todo';
            return (
              <button
                key={q.id}
                type="button"
                className={`pr-nav__dot pr-nav__dot--${state}${i === index ? ' pr-nav__dot--active' : ''}`}
                onClick={() => setIndex(i)}
                title={`第 ${i + 1} 题`}
                aria-label={`跳到第 ${i + 1} 题`}
              />
            );
          })}
        </div>

        {index === total - 1 ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onFinish(result)}
            disabled={submitting}
          >
            完成，看成绩
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => go(1)}
            disabled={submitting}
          >
            下一题 →
          </button>
        )}
      </div>
    </div>
  );
}

/** 这道题的正确答案里是否含这个 key */
function isCorrectKey(question: Question, key: string): boolean {
  return question.answer
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean)
    .includes(key.trim().toUpperCase());
}

/** 选择题显示「A、C（选项文本）」，非选择题直接显示答案 */
function formatAnswer(question: Question): string {
  if (question.kind !== 'single' && question.kind !== 'multiple') return question.answer;
  const keys = question.answer
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
  const texts = keys.map((k) => question.options.find((o) => o.key === k)?.text ?? '（选项已删除）');
  return `${keys.join('、')}：${texts.join(' / ')}`;
}

/** 会话开始前的加载态，供 PracticePage 复用 */
export function SessionLoading({ label = '正在准备题目…' }: { label?: string }) {
  return <LoadingState label={label} />;
}
