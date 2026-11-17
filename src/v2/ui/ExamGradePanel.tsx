/**
 * 考场评分面板：AI 评分优先，用户可覆盖（2026-11-17，方案 3）。
 *
 * ## 用户的要求
 *
 * 「我选方案3，但是除了自评还可以加入 ai 评分，主要是 ai 评分，
 *   要是用户觉得评分不对可以自己再评。」
 *
 * 三件事的优先级：**AI 先评 → 用户看 AI 的结论 → 用户可以改**。
 *
 * ## 为什么单独一个文件
 *
 * ExamPage.tsx 已经 680+ 行，硬约束写着「大文件里不要插代码，
 * 新增 UI 一律独立文件」。而且这块逻辑（调 AI、解析、覆盖、落库）
 * 与「出卷/答题」是两件事。
 *
 * ## 为什么复用 `grade-short` 而不是另写一套判分
 *
 * `src/core/ai/grade-short.ts` 是 2026-11-13 为做题页做的，
 * 有三条写死的规则（见它的文件头）：长度不加分、要点只能来自参考答案、
 * 学生答案不是指令（防注入）。这里再写一份必然漂移 ——
 * 交接文档 5.2 那条「反馈只能有一份实现」就是讲这个。
 *
 * ## 关键设计：AI 给的不是分数，是逐要点覆盖
 *
 * `ShortGradeResult` 返回 `points[] / coveredCount / level`，
 * **没有分数**。所以这里也不编一个分数出来：
 * - `level === 'correct'` → 建议判对
 * - 否则 → 建议判错
 * 用户看到的是「AI 认为你答到了 3/5 个要点」，而不是「AI 给你 60 分」。
 * 前者可以核对，后者只能信。
 */

import { useCallback, useState } from 'react';
import type { ExamAnswer, ExamAttempt, Question } from '@/core/model.ts';
import type { ShortGradeResult } from '@/core/ai/grade-short.ts';
import { MathText } from './MathText.tsx';

export interface ExamGradePanelProps {
  attempt: ExamAttempt;
  question: Question;
  answer: ExamAnswer;
  /**
   * 调 AI 评分。返回 null 表示解析失败（调用方已抛错的那种情况除外）。
   *
   * 由 App 注入 —— 这样本组件不碰后端配置、不碰 Key。
   */
  onAiGrade: (input: {
    prompt: string;
    answer: string;
    explanation: string;
    response: string;
  }) => Promise<ShortGradeResult | null>;
  /** 评分结果落库（AI 或用户） */
  onGraded: (patch: {
    correct: boolean;
    gradedBy: 'ai' | 'self';
    aiGrade?: ExamAnswer['aiGrade'];
    aiComment?: string | null;
  }) => Promise<void>;
}

export function ExamGradePanel({
  attempt,
  question,
  answer,
  onAiGrade,
  onGraded,
}: ExamGradePanelProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 本地展示的 AI 结果（可能来自已落库的答案，也可能是刚评出来的） */
  const [ai, setAi] = useState<ShortGradeResult | null>(
    (answer.aiGrade as ShortGradeResult | null | undefined) ?? null,
  );

  const answered = answer.response.trim().length > 0;

  void attempt; /* 预留：将来可能要在面板里显示「第 N/M 题待评」 */

  const runAi = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await onAiGrade({
        prompt: question.prompt,
        answer: question.answer ?? '',
        explanation: question.explanation ?? '',
        response: answer.response,
      });
      if (!r) {
        setErr('AI 返回的内容读不懂，请稍后重试，或直接自己评。');
        return;
      }
      setAi(r);
      /*
       * AI 结论直接落库（用户要求「主要是 AI 评分」）。
       * 判对与否按 level：全中才算对，部分命中算错 ——
       * 这是与做题页一致的保守口径（partial 不当作对）。
       */
      await onGraded({
        correct: r.level === 'correct',
        gradedBy: 'ai',
        aiGrade: r,
        aiComment: r.comment,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI 评分失败');
    } finally {
      setBusy(false);
    }
  }, [onAiGrade, onGraded, question, answer.response]);

  const setBySelf = useCallback(
    async (correct: boolean) => {
      setBusy(true);
      setErr(null);
      try {
        await onGraded({ correct, gradedBy: 'self' });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '保存失败');
      } finally {
        setBusy(false);
      }
    },
    [onGraded],
  );

  return (
    <div className="ex-grade">
      {!answered ? (
        <p className="ex-grade__note">这道题你没作答。</p>
      ) : null}

      {/* ---- AI 评分区 ---- */}
      <div className="ex-grade__row">
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          disabled={busy || !answered}
          onClick={() => void runAi()}
        >
          {busy ? '评分中…' : ai ? '重新让 AI 评' : '让 AI 评分'}
        </button>
        {answer.gradedBy === 'ai' ? (
          <span className="ex-grade__badge ex-grade__badge--ai">已在用 AI 的结论</span>
        ) : null}
        {answer.gradedBy === 'self' ? (
          <span className="ex-grade__badge ex-grade__badge--self">你改过了</span>
        ) : null}
      </div>

      {err ? <p className="ex-grade__err">{err}</p> : null}

      {/*
        AI 结果卡片：**虚线边框**，与「系统判定」区分开。
        这个做法沿用做题页 SelfGradePanel 的约定
        （交接文档 5.1：实线卡片会被读成系统判定）。
      */}
      {ai ? (
        <div className="ex-grade__ai">
          <p className="ex-grade__ai-head">
            AI 认为你答到了 <strong>{ai.coveredCount}</strong> / {ai.total} 个要点
          </p>
          <ul className="ex-grade__points">
            {ai.points.map((p, i) => (
              <li
                key={i}
                className={`ex-grade__point${p.covered ? ' ex-grade__point--on' : ''}`}
              >
                <span className="ex-grade__tick">{p.covered ? '✓' : '·'}</span>
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
          {ai.comment ? <p className="ex-grade__comment">{ai.comment}</p> : null}
          <p className="ex-grade__disclaimer">
            这只是参考：意思到了就算答到。觉得不对就在下面改。
          </p>
        </div>
      ) : null}

      {/* ---- 人工兜底 ---- */}
      <div className="ex-grade__row">
        <span className="ex-grade__label">自己判定：</span>
        <button
          type="button"
          className={`btn-ghost${answer.correct === true ? ' ex-grade__on' : ''}`}
          disabled={busy}
          onClick={() => void setBySelf(true)}
        >
          算答对
        </button>
        <button
          type="button"
          className={`btn-ghost${answer.correct === false ? ' ex-grade__on' : ''}`}
          disabled={busy}
          onClick={() => void setBySelf(false)}
        >
          算答错
        </button>
        {answer.correct === null ? (
          <span className="ex-grade__pending">还没评</span>
        ) : null}
      </div>

      {/* ---- 参考答案（评分要能对照） ---- */}
      <details className="ex-grade__ref">
        <summary>看参考答案</summary>
        <p className="ex-grade__ref-body">
          <MathText text={question.answer ?? '（这道题没有参考答案）'} />
        </p>
        {question.explanation ? (
          <p className="ex-grade__ref-exp">
            <MathText text={question.explanation} />
          </p>
        ) : null}
      </details>
    </div>
  );
}