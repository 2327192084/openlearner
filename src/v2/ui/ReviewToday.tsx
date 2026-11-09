/**
 * 今日复习面板（2026-11-09）。
 *
 * ## 它是什么
 *
 * 整合进「复习巩固」页的**真正复习流程**（用户明确要求：不新开侧栏）。
 *
 * 与同页「自测」的区别：
 *  - **自测**：任意卷、随时翻、不写复习记录（用来检验）
 *  - **今日复习**：只做今天到期的 + 新卡、**先回想再看答案**、
 *    自评四档**写进间隔安排**、做完出今日回顾
 *
 * ## 为什么必须先翻面才能评
 *
 * Anki 的核心交互就是这个顺序。没看答案就自评，用户其实是在猜
 * 「我大概会吧」—— 那是熟悉感错觉（recognition），不是回忆（recall）。
 * 项目注释里早写过这个区别，这里落成强制流程。
 *
 * ## 为什么抽成独立文件
 *
 * `BookPage.tsx` 已经 450 行。宿主里只插一行引用。
 */

import { useCallback, useEffect, useState } from 'react';
import type { Question } from '@/core/model.ts';
import type { ReviewGrade } from '@/v2/core/srs.ts';
import { MathText } from './MathText.tsx';
import {
  GRADE_META,
  currentItem,
  grade,
  isFinished,
  progressOf,
  recapOf,
  reveal,
  type ReviewSession,
} from './review-session.ts';
import './review-today.css';

export interface ReviewTodayProps {
  /** 开始时的会话（由宿主用 buildReviewQueue 构造） */
  session: ReviewSession;
  /** 今天一共多少张可复习（可能大于本批） */
  available: number;
  /** 自评一档 → 写复习记录 */
  onGrade: (cardId: string, grade: ReviewGrade) => Promise<void> | void;
  /** 结束，回到阅读模式 */
  onExit: () => void;
  /** 完成整批后，还想再来一批 */
  onNextBatch?: () => void;
}

export function ReviewToday({
  session: initial,
  available,
  onGrade,
  onExit,
  onNextBatch,
}: ReviewTodayProps) {
  const [session, setSession] = useState<ReviewSession>(initial);
  /** 正在写入（防止连点导致同一张卡评两次） */
  const [busy, setBusy] = useState(false);

  /* 宿主换了新会话（再来一批）时重置 */
  useEffect(() => {
    setSession(initial);
  }, [initial]);

  const item = currentItem(session);
  const progress = progressOf(session);
  const finished = isFinished(session);
  const question = item ? (item.question as Question) : null;

  const handleGrade = useCallback(
    async (g: ReviewGrade) => {
      if (!item || busy) return;
      setBusy(true);
      try {
        await onGrade(item.cardId, g);
        setSession((prev) => grade(prev, g));
      } finally {
        setBusy(false);
      }
    },
    [item, busy, onGrade],
  );

  /* 键盘：空格/回车翻面；1-4 自评（Anki 习惯） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished) return;
      if (session.phase === 'prompt' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setSession((prev) => reveal(prev));
        return;
      }
      if (session.phase === 'reveal') {
        const idx = ['1', '2', '3', '4'].indexOf(e.key);
        if (idx >= 0) {
          e.preventDefault();
          void handleGrade(GRADE_META[idx]!.grade);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.phase, finished, handleGrade]);

  /* ---------------- 结束：今日回顾 ---------------- */
  if (finished) {
    const recap = recapOf(session);
    const pct =
      recap.rememberedRatio !== null ? Math.round(recap.rememberedRatio * 100) : null;

    return (
      <div className="rt">
        <div className="rt__card rt__card--recap">
          <h2 className="rt__recap-title">今日复习完成</h2>
          <p className="rt__recap-lead">
            这一批 {recap.total} 张：到期 {recap.dueCount} 张、新卡 {recap.newCount} 张。
          </p>

          {/* 四档分布：让用户看见自己今天「记住了多少」 */}
          <ul className="rt__grades">
            {GRADE_META.map((m) => (
              <li key={m.grade} className={`rt__grade rt__grade--${m.grade}`}>
                <span className="rt__grade-n">{recap.byGrade[m.grade]}</span>
                <span className="rt__grade-l">{m.label}</span>
              </li>
            ))}
          </ul>

          {pct !== null ? (
            <p className="rt__recap-note">
              其中 {pct}% 是「还行 / 很熟」—— 这批你确实记住了。
            </p>
          ) : null}

          <div className="rt__recap-actions">
            {onNextBatch && available > 0 ? (
              <button type="button" className="rt__btn rt__btn--primary" onClick={onNextBatch}>
                再来一批
              </button>
            ) : null}
            <button type="button" className="rt__btn" onClick={onExit}>
              回到复习巩固
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- 队列空 ---------------- */
  if (!item || !question) {
    return (
      <div className="rt">
        <div className="rt__card">
          <p className="rt__empty" >
            今天没有到期的卡，题库里也没有新题。
          </p>
          <p className="rt__empty-hint">
            去「资料」导入内容、或到「我的题组」出几道新题，之后这里就会有复习内容。
          </p>
          <button type="button" className="rt__btn" onClick={onExit}>
            回到复习巩固
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- 作答中 ---------------- */
  const revealed = session.phase === 'reveal';

  return (
    <div className="rt">
      {/* 进度条：让「还有多少」随时可见，这是会话感的来源 */}
      <div className="rt__head">
        <span className="rt__pos">
          {progress.done + 1} / {progress.total}
        </span>
        <div className="rt__bar" role="progressbar" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}>
          <div
            className="rt__bar-fill"
            style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
          />
        </div>
        {item.isNew ? <span className="rt__tag rt__tag--new">新卡</span> : <span className="rt__tag">到期</span>}
        <button type="button" className="rt__btn rt__btn--ghost" onClick={onExit}>
          结束
        </button>
      </div>

      {/*
        进度截断提示：今天到期 50 张但本批只排 30 张时，
        必须说出来 —— 否则做完显示「完成」是在骗人。
      */}
      {available > progress.total ? (
        <p className="rt__hint">
          今天一共 {available} 张可复习，这一批 {progress.total} 张，做完可以再来一批。
        </p>
      ) : null}

      <div className="rt__card">
        <p className="rt__prompt">
          <MathText text={question.prompt} />
        </p>

        {/*
          选择/填空不显示选项 —— 这是复习，不是做题。
          先让用户在心里回想答案，再翻面对照。
          显示选项会把「回忆」降级成「识别」，效果差很多。
        */}
        {!revealed ? (
          <div className="rt__actions">
            <p className="rt__recall-hint">先在心里想一遍答案，再翻面核对。</p>
            <button
              type="button"
              className="rt__btn rt__btn--primary"
              onClick={() => setSession((prev) => reveal(prev))}
            >
              翻面看答案
            </button>
          </div>
        ) : (
          <>
            {question.options.length > 0 ? (
              <ul className="rt__options">
                {question.options.map((o) => {
                  const right = isRight(question, o.key);
                  return (
                    <li key={o.key} className={`rt__option${right ? ' rt__option--right' : ''}`}>
                      <span className="rt__opt-key">{o.key}</span>
                      <span className="rt__opt-text">
                        <MathText text={o.text} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <p className="rt__answer">
              正确答案：<MathText text={question.answer} />
            </p>
            {question.explanation ? (
              <p className="rt__explain">
                <MathText text={question.explanation} />
              </p>
            ) : null}

            <div className="rt__grade-row">
              {GRADE_META.map((m, i) => (
                <button
                  key={m.grade}
                  type="button"
                  className={`rt__gbtn rt__gbtn--${m.grade}`}
                  disabled={busy}
                  title={`${m.hint}（按 ${i + 1}）`}
                  onClick={() => void handleGrade(m.grade)}
                >
                  <span className="rt__gbtn-label">{m.label}</span>
                  <span className="rt__gbtn-hint">{m.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 某个选项是不是正确答案（多选按集合） */
function isRight(q: Question, key: string): boolean {
  const a = q.answer.trim().toUpperCase();
  if (q.kind === 'multiple') {
    return a.split(/[,，\s]+/).map((s) => s.trim()).includes(key.toUpperCase());
  }
  return a === key.toUpperCase();
}
