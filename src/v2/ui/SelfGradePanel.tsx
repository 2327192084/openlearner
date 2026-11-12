/**
 * 自评面板（2026-11-12）。
 *
 * ## 为什么单独一个文件
 *
 * ReviewPage.tsx 已经 970 多行，项目对「往大文件里插代码」有过教训
 * （见 BookSelfTest.tsx 的文件头注释、GeneratePage 的 CRLF 混用）。
 * 这块又是完整的一小段交互，抽出来更好读。
 *
 * ## 为什么问答与计算题要自评
 *
 * 2026-11-12 定稿：这两类题没法靠程序判分。
 *  - 问答题的答案可以有很多种说法，字符串相似度判不准；
 *  - 计算题只看最终数值会放过「数值对、过程错」，也会误伤「思路对、末步错」。
 *
 * 所以对错由用户自己点。这不是偷懒 —— 用户在看完参考答案之后做这个判断，
 * 比任何自动判分都准。
 *
 * ## AI 按钮为什么只是「辅助」
 *
 * 用户原话：「做成一个按钮，主要判分还是用户自评」。
 * 所以 AI 给出的要点覆盖情况**不自动改对错、不自动翻页** ——
 * 它只是把参考答案拆成几条，让用户核对「我这个说法算不算答到了」。
 * 界面上的两个自评按钮始终可用，AI 有没有结果都一样。
 */

import type { ShortGradeResult } from '@/core/ai/grade-short.ts';
import { shortGradeSummary } from '@/core/ai/grade-short.ts';
import { MathText } from './MathText.tsx';

export interface SelfGradePanelProps {
  /** 点「我答对了」/「我答错了」 */
  onPick: (correct: boolean) => void;
  /**
   * 点「让 AI 逐要点比对」。
   *
   * 可选：不传就**不渲染这个按钮**（没接后端时不给一个点了没反应的假按钮）。
   */
  onAskAi?: () => void;
  /** AI 请求进行中 */
  busy: boolean;
  /** AI 的结果（可能为 null） */
  result: ShortGradeResult | null;
  /** AI 失败时的提示（不阻断自评） */
  error: string | null;
}

export function SelfGradePanel({ onPick, onAskAi, busy, result, error }: SelfGradePanelProps) {
  return (
    <div className="self-grade">
      <p className="self-grade__ask">
        对照下面的参考答案，这题你自己说了算：
      </p>

      <div className="self-grade__btns">
        <button type="button" className="btn-fill btn-fill--sm" onClick={() => onPick(true)}>
          我答对了
        </button>
        <button type="button" className="btn-ghost" onClick={() => onPick(false)}>
          我答错了
        </button>
      </div>

      {/*
        AI 按钮只在接了后端时出现。
        没接后端却留一个按钮，用户点了没反应 —— 那就是假按钮
        （项目里对「不做假开关」有明确要求）。
      */}
      {onAskAi ? (
        <button
          type="button"
          className="btn-text self-grade__ai"
          onClick={onAskAi}
          disabled={busy}
        >
          {busy ? 'AI 正在逐条比对…' : '不确定？让 AI 逐要点比对一下'}
        </button>
      ) : null}

      {/*
        失败也要说出来 —— 静默失败会让用户以为按钮坏了。
        但文案要明确「不影响自评」，否则他会以为非得等 AI。
      */}
      {error ? <p className="self-grade__error">{error}（不影响自评，直接点上面的按钮就行）</p> : null}

      {result ? (
        <div className={`self-grade__result self-grade__result--${result.level}`}>
          <p className="self-grade__summary">{shortGradeSummary(result)}</p>
          <ul className="self-grade__points">
            {result.points.map((p, i) => (
              <li
                key={i}
                className={`self-grade__point ${p.covered ? 'self-grade__point--ok' : 'self-grade__point--gap'}`}
              >
                <span className="self-grade__mark" aria-hidden="true">
                  {p.covered ? '✓' : '·'}
                </span>
                <span className="self-grade__text">
                  <MathText text={p.text} />
                </span>
              </li>
            ))}
          </ul>
          {result.comment ? (
            <p className="self-grade__comment"><MathText text={result.comment} /></p>
          ) : null}
          {/*
            这句必须留着（用户要求「主要判分还是用户自评」）。
            AI 会给出很像结论的「3/4 个要点」，不声明的话
            用户会以为系统已经判了，只是没告诉他。
          */}
          <p className="self-grade__note">
            这只是参考：意思到了就算答到，最终对错由你决定。
          </p>
        </div>
      ) : null}
    </div>
  );
}
