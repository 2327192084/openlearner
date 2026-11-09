/**
 * 复习巩固页的「自测」面板（2026-11-09）。
 *
 * ## 为什么抽成独立文件
 *
 * `BookPage.tsx` 已经 350 行，而项目对「往大文件里插代码」有过教训
 * （GeneratePage 的 CRLF 混用）。宿主里只插一行引用。
 *
 * ## 它做什么
 *
 * 把这一「卷」（一份资料下的一组题）当成一次小测：
 * 一次只出一道、遮住答案、作答后当场判对错并展开解析。
 *
 * ## 为什么不写复习记录
 *
 * 这是**就地翻看**，不是正式复习。写记录会改变用户的间隔安排 ——
 * 他在书里随手过一遍不该影响真实的复习计划。
 * 想真正练就去做题页；这里负责「考前快速过一遍、把没把握的挑出来」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Question } from '@/core/model.ts';
import { MathText } from './MathText.tsx';
import {
  answerQuestion,
  currentQuestionId,
  judgeAnswer,
  nextQuestion,
  prevQuestion,
  selfTestScore,
  startSelfTest,
  overrideAnswer,
  type SelfTestState,
} from './self-test.ts';
import './book-selftest.css';

export interface BookSelfTestProps {
  /** 这一卷的题（顺序即作答顺序） */
  questions: readonly Question[];
  /** 这一卷的名字，显示在各处 */
  title: string;
  /** 退出自测，回到阅读模式 */
  onExit: () => void;
  /** 跳回原文那一页（有锚点才有） */
  onOpenAnchor?: (page: number, quote?: string) => void;
}

export function BookSelfTest({ questions, title, onExit, onOpenAnchor }: BookSelfTestProps) {
  const [state, setState] = useState<SelfTestState>(() =>
    startSelfTest(questions.map((q) => q.id)),
  );
  /** 当前题是否已揭晓（作答后为 true） */
  const [revealed, setRevealed] = useState(false);
  /** 选择题的临时选择 / 填空题的临时输入 */
  const [draft, setDraft] = useState('');

  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const currentId = currentQuestionId(state);
  const current = currentId ? (byId.get(currentId) ?? null) : null;
  const score = selfTestScore(state);

  /* 换题时清掉草稿与揭晓状态 —— 否则上一题的输入会串到下一题 */
  useEffect(() => {
    setRevealed(false);
    setDraft('');
  }, [currentId]);

  const submit = useCallback(() => {
    if (!current) return;
    setState((prev) => answerQuestion(prev, current, draft));
    setRevealed(true);
  }, [current, draft]);

  const selfGrade = useCallback(
    (correct: boolean) => {
      if (!current) return;
      setState((prev) => {
        /* 问答未作答时先补一条记录，再改判 */
        const next = prev.answers[current.id]
          ? prev
          : answerQuestion(prev, current, draft || '(未作答)');
        return overrideAnswer(next, current.id, correct);
      });
    },
    [current, draft],
  );

  const goNext = useCallback(() => {
    setState((prev) => nextQuestion(prev) ?? prev);
  }, []);

  const goPrev = useCallback(() => {
    setState((prev) => prevQuestion(prev) ?? prev);
  }, []);

  /* 键盘：← → 翻题，Enter 提交（做题页已有这套习惯，保持一致） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev]);

  const answered = currentId ? state.answers[currentId] : undefined;
  const atEnd = state.index >= state.queue.length - 1;

  if (!current) {
    return (
      <div className="bst">
        <p className="bst__empty">这一卷没有题可以自测。</p>
        <button type="button" className="bst__btn" onClick={onExit}>
          回到阅读
        </button>
      </div>
    );
  }

  return (
    <div className="bst">
      {/* 顶部：进度与成绩 */}
      <div className="bst__bar">
        <span className="bst__vol" title={title}>
          {title}
        </span>
        <span className="bst__pos">
          {state.index + 1} / {state.queue.length}
        </span>
        <span className="bst__score">
          已答 {score.answered}
          {score.accuracy !== null ? ` · 正确率 ${Math.round(score.accuracy * 100)}%` : ''}
        </span>
        <button type="button" className="bst__btn" onClick={onExit}>
          回到阅读
        </button>
      </div>

      {/* 题干 */}
      <div className="bst__card">
        <div className="bst__head">
          <span className="bst__kind">{kindLabel(current.kind)}</span>
          {current.topic ? <span className="bst__topic">{current.topic}</span> : null}
        </div>
        <p className="bst__prompt">
          <MathText text={current.prompt} />
        </p>

        {/* 选择/填空：作答区 */}
        {current.options.length > 0 ? (
          <ul className="bst__options">
            {current.options.map((o) => {
              const picked = draft
                .split(/[,，\s]+/)
                .map((s) => s.trim().toUpperCase())
                .includes(o.key.toUpperCase());
              const isRight = revealed && isAnswerKey(current, o.key);
              const isWrongPick = revealed && picked && !isRight;
              return (
                <li key={o.key}>
                  <button
                    type="button"
                    className={
                      'bst__opt' +
                      (picked ? ' bst__opt--picked' : '') +
                      (isRight ? ' bst__opt--right' : '') +
                      (isWrongPick ? ' bst__opt--wrong' : '')
                    }
                    disabled={revealed}
                    onClick={() => {
                      if (current.kind === 'multiple') {
                        /* 多选：点点选，再点取消 */
                        const set = new Set(
                          draft
                            .split(/[,，\s]+/)
                            .map((s) => s.trim().toUpperCase())
                            .filter(Boolean),
                        );
                        const k = o.key.toUpperCase();
                        if (set.has(k)) set.delete(k);
                        else set.add(k);
                        setDraft([...set].sort().join(','));
                      } else {
                        setDraft(o.key);
                      }
                    }}
                  >
                    <span className="bst__opt-key">{o.key}</span>
                    <span className="bst__opt-text">
                      <MathText text={o.text} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : current.kind === 'blank' ? (
          <input
            className="bst__input"
            value={draft}
            disabled={revealed}
            placeholder="在这里填写答案"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !revealed) submit();
            }}
          />
        ) : (
          <textarea
            className="bst__input bst__input--area"
            value={draft}
            rows={3}
            disabled={revealed}
            placeholder="先自己写一遍答案，再看解析"
            onChange={(e) => setDraft(e.target.value)}
          />
        )}

        {/* 提交 / 判定 */}
        {!revealed ? (
          <div className="bst__actions">
            <button type="button" className="bst__btn bst__btn--primary" onClick={submit}>
              对答案
            </button>
          </div>
        ) : (
          <div className="bst__result">
            {answered?.correct === true ? (
              <p className="bst__verdict bst__verdict--ok">答对了</p>
            ) : answered?.correct === false ? (
              <p className="bst__verdict bst__verdict--bad">答错了</p>
            ) : (
              <p className="bst__verdict">问答没有标准判分，你自己说了算：</p>
            )}

            {/* 问答：用户自评 */}
            {answered?.correct === null ? (
              <div className="bst__self">
                <button type="button" className="bst__btn" onClick={() => selfGrade(true)}>
                  我答对了
                </button>
                <button type="button" className="bst__btn" onClick={() => selfGrade(false)}>
                  我答错了
                </button>
              </div>
            ) : null}

            <p className="bst__answer">
              参考答案：<MathText text={current.answer} />
            </p>
            {current.explanation ? (
              <p className="bst__explain">
                <MathText text={current.explanation} />
              </p>
            ) : null}

            {current.anchors[0] && onOpenAnchor ? (
              <button
                type="button"
                className="bst__link"
                onClick={() =>
                  onOpenAnchor(current.anchors[0]!.page ?? 1, current.anchors[0]!.quote)
                }
              >
                看原文第 {current.anchors[0].page ?? '?'} 页
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* 底部导航 */}
      <div className="bst__nav">
        <button
          type="button"
          className="bst__btn"
          onClick={goPrev}
          disabled={state.index === 0}
        >
          ← 上一题
        </button>
        <button
          type="button"
          className="bst__btn"
          onClick={goNext}
          disabled={atEnd}
        >
          下一题 →
        </button>
      </div>
    </div>
  );
}

function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'blank':
      return '填空';
    case 'essay':
    case 'short':
      return '问答';
    default:
      return k;
  }
}

function isAnswerKey(q: Question, key: string): boolean {
  const a = q.answer.trim().toUpperCase();
  if (q.kind === 'multiple') {
    return a
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .includes(key.toUpperCase());
  }
  return a === key.toUpperCase();
}

/** 供外部判断一道题能否自测（问答也行，只是要自评） */
export function canSelfTest(q: Question): boolean {
  return typeof q.prompt === 'string' && q.prompt.trim().length > 0;
}

/** 导出给测试用（避免重复实现） */
export { judgeAnswer };
