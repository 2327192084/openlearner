/**
 * 回看历史试卷（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「最后下面的历史成绩可以点击查看试卷所有的习题」
 *
 * ## 与 `ResultView` 的区别（为什么要两个组件）
 *
 * | | ResultView | HistoryView |
 * |---|---|---|
 * | 时机 | 刚交完卷 | 事后回看 |
 * | 能评分吗 | **能**（AI 评 / 自评） | **不能** |
 * | 能重考吗 | 能 | 能 |
 * | 数据 | 内存里的试卷 | 从库里按 questionIds 取 |
 *
 * 事后不允许改分是有意的：那次考试已经结束，改分会让「历史成绩」
 * 这条流水变得不可信。要改就再考一次。
 *
 * ## 题目被删了怎么办
 *
 * 考试记录存的是 `questionIds`，题目本体在 `questions` 分区。
 * 用户可能已经把那个题组删了 —— 这时如实显示「题目已删除」，
 * 不影响其他题的回看（不能让整页打不开）。
 */

import type { ExamAttempt, Question } from '@/core/model.ts';
import { MathText } from './MathText.tsx';

export interface HistoryViewProps {
  attempt: ExamAttempt;
  /** 已取到的题目（可能比 questionIds 少 —— 删掉的取不到） */
  questions: Question[];
  onBack: () => void;
  onDelete: () => void;
}

export function HistoryView({ attempt, questions, onBack, onDelete }: HistoryViewProps) {
  const pending = attempt.answers.filter((a) => a.correct === null).length;
  const gradedTotal = attempt.total - pending;
  const rate = gradedTotal > 0 ? attempt.correct / gradedTotal : 0;
  const qById = new Map(questions.map((q) => [q.id, q]));
  const missing = attempt.questionIds.length - questions.length;

  return (
    <>
      <header className="ex-head">
        <h1 className="ex-title">试卷回看</h1>
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

      {pending > 0 ? (
        <p className="ex-pending">
          这份卷子交卷时还有 <strong>{pending}</strong> 道题没评。
          历史记录不支持事后改分（要改就再考一次），所以那几题按「待评」记着。
        </p>
      ) : null}

      {missing > 0 ? (
        <p className="ex-note">
          有 <strong>{missing}</strong> 道题已经不在题库里了（题组或题目被删）。
          它们的作答记录仍然保留在下面，只是看不到题干。
        </p>
      ) : null}

      <div className="ex-actions">
        <button type="button" className="btn-fill" onClick={onBack}>
          返回
        </button>
        <button type="button" className="btn-ghost" onClick={onDelete}>
          删除这条记录
        </button>
      </div>

      <h2 className="ex-h2">逐题回看（{attempt.answers.length} 题）</h2>
      <ul className="ex-review">
        {attempt.answers.map((a, i) => {
          const q = qById.get(a.questionId);
          const mark = a.correct === null ? '?' : a.correct ? '✓' : '✕';
          const cls =
            a.correct === null
              ? ' ex-review__item--pending'
              : a.correct
                ? ' ex-review__item--ok'
                : '';

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
                <span className="ex-review__kind">{q ? kindLabel(q.kind) : '题目已删除'}</span>
                {a.gradedBy === 'ai' ? (
                  <span className="ex-review__src">AI 评</span>
                ) : a.gradedBy === 'self' ? (
                  <span className="ex-review__src">自评</span>
                ) : null}
              </div>

              {q ? (
                <>
                  <p className="ex-review__prompt">
                    <MathText text={q.prompt} />
                  </p>
                  <p className="ex-review__your">
                    你的答案：{a.response.trim() || '（未作答）'}
                  </p>
                  {a.correct !== true ? (
                    <p className="ex-review__right">
                      正确答案：<MathText text={q.answer} />
                    </p>
                  ) : null}
                  {q.explanation ? (
                    <p className="ex-review__explain">
                      <MathText text={q.explanation} />
                    </p>
                  ) : null}
                </>
              ) : (
                /* 题干取不到：至少把当时的作答显示出来，别让人以为数据丢了 */
                <p className="ex-review__your">
                  你的答案：{a.response.trim() || '（未作答）'} · 这道题的题干已不在题库里
                </p>
              )}

              {/* AI 当时给的点评（如果有）—— 事后回看仍然有价值 */}
              {a.aiComment ? (
                <p className="ex-review__explain">AI 当时的点评：{a.aiComment}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ---------- 小工具（与 ExamPage 里的同名函数保持一致的显示口径） ---------- */

function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'truefalse':
      return '判断';
    case 'blank':
      return '填空';
    case 'essay':
      return '问答';
    case 'calc':
      return '计算';
    default:
      return k;
  }
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m} 分 ${r} 秒` : `${r} 秒`;
}
