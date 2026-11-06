import { useCallback, useEffect, useState } from 'react';
import type { Card } from '@/v2/core/cards.ts';
import { isCorrect, inferGrade, CARD_KIND_LABEL } from '@/v2/core/cards.ts';
import type { ReviewGrade } from '@/v2/core/srs.ts';
import { mastery, schedule, initialState, todayUtc } from '@/v2/core/srs.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import type { ReviewService, ReviewRecord } from '@/v2/core/review-service.ts';

/**
 * 复习页：题卡 + 选项行 + 0-5 评分档。
 *
 * ## 按 StudyHub 的 ui/review/question.css 还原
 *
 * 关键规格（源码实测值）：
 *  - 卡片宽 min(700px, 100% - 48px)，上下 32/56px 留白
 *  - 进度条 2px 高，朱砂色
 *  - 选项**不是按钮盒**：每项是 border-top 1px 分隔行，
 *    padding 16px 10px，字号 17px，左侧 28px 圆形字母标
 *  - 答题后每项的判定与解释从 0 高度展开（0.46s）
 *
 * ## 为什么选项不用按钮盒
 *
 * 按钮盒会让四个选项看起来像四个「动作」；
 * 而选择题的选项是**卡上的一道道横线**，
 * 状态只体现在左侧的字母圆标上（选中/正确/错误）。
 * 这个差别决定了它读起来像「试卷」还是像「设置面板」。
 */

/** 0-5 评分档（标签与 StudyHub 一致） */
const GRADES: { score: number; label: string; grade: ReviewGrade }[] = [
  { score: 0, label: '完全忘记', grade: 'again' },
  { score: 1, label: '记得一点', grade: 'again' },
  { score: 2, label: '有印象', grade: 'again' },
  { score: 3, label: '勉强答对', grade: 'hard' },
  { score: 4, label: '熟练', grade: 'good' },
  { score: 5, label: '轻松掌握', grade: 'easy' },
];

/**
 * 按当前卡片状态算出每个评分档**实际**会给出的间隔。
 *
 * ⚠️ 这里踩过一个坑：原先把间隔写死在表里（熟练=20天），
 * 但 SM-2 首次复习 good 只给 1 天 —— 用户点了「熟练」，
 * 界面承诺 20 天，实际第二天又来，会觉得软件在骗他。
 *
 * 现在用 schedule() 真实算一遍，显示的是**这一次点了会发生什么**。
 * 数字与算法永远一致，改算法不用改界面。
 */
function previewIntervals(state: ReviewState | null, today: string): number[] {
  return GRADES.map((g) => {
    const base = state ?? initialState(today);
    return schedule(base, g.grade, today).intervalDays;
  });
}

/** 间隔的友好写法 */
function fmtInterval(days: number): string {
  if (days <= 0) return '今天';
  if (days === 1) return '1 天';
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return '1 年';
}

export interface ReviewPageProps {
  service: ReviewService;
  /** 本轮要复习的卡片 */
  queue: Card[];
  /** 练习开始时该组的掌握度（用于显示 +N% 胶囊） */
  groupMasteryBefore?: number;
  onFinish: () => void;
  onExit: () => void;
}

export function ReviewPage({
  service,
  queue,
  groupMasteryBefore,
  onFinish,
  onExit,
}: ReviewPageProps) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [textInput, setTextInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState<{ correct: boolean | null } | null>(null);
  const [done, setDone] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [masteryNow, setMasteryNow] = useState<number | null>(null);
  const [record, setRecord] = useState<ReviewRecord | null>(null);

  const card = queue[index];
  const total = queue.length;

  // 换卡时重置所有作答状态
  useEffect(() => {
    setPicked([]);
    setTextInput('');
    setRevealed(false);
    setGraded(null);
    setStartedAt(Date.now());
  }, [index]);

  // 读当前卡片的进度（用于显示掌握度胶囊）
  useEffect(() => {
    let cancelled = false;
    if (!card) return;
    void (async () => {
      const r = await service.getRecord(card.id);
      if (cancelled) return;
      setRecord(r);
      setMasteryNow(r ? mastery(r.state) : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [service, card]);

  /** 提交答案（客观题） */
  const submitChoice = useCallback(() => {
    if (!card) return;
    let given = '';
    if (card.kind === 'single') given = picked[0] ?? '';
    else if (card.kind === 'multiple') given = picked.join(',');
    else if (card.kind === 'blank') given = textInput;
    else if (card.kind === 'short') given = textInput;

    const ok = isCorrect(card, given);
    setGraded({ correct: ok });
    setRevealed(true);
    if (ok) setCorrectCount((n) => n + 1);
  }, [card, picked, textInput]);

  /** 提交评分（自评档，用于知识点或答完后确认） */
  const submitGrade = useCallback(
    async (g: ReviewGrade) => {
      if (!card) return;
      await service.review(card.id, card.kind === 'point' ? 'point' : 'question', g);
      const r = await service.getRecord(card.id);
      setRecord(r);
      setMasteryNow(r ? mastery(r.state) : 0);
      setDone((n) => n + 1);
      if (index + 1 >= total) {
        onFinish();
      } else {
        setIndex((i) => i + 1);
      }
    },
    [card, service, index, total, onFinish],
  );

  /** 按作答情况自动推断评分并前进 */
  const autoGrade = useCallback(async () => {
    if (!card) return;
    const elapsed = Date.now() - startedAt;
    const g = inferGrade(card, graded?.correct ?? null, elapsed);
    await submitGrade(g);
  }, [card, graded, startedAt, submitGrade]);

  if (!card) {
    return (
      <div className="review-empty">
        <p>这一轮没有需要复习的卡片。</p>
        <button type="button" className="btn-ghost" onClick={onExit}>
          返回
        </button>
      </div>
    );
  }

  const optionState = (key: string): 'idle' | 'picked' | 'correct' | 'wrong' => {
    const isAnswerKey =
      card.kind === 'multiple'
        ? card.answer.split(/[,，\s]+/).map((s) => s.trim().toUpperCase()).includes(key.toUpperCase())
        : card.answer.trim().toUpperCase() === key.toUpperCase();

    if (!revealed) return picked.includes(key) ? 'picked' : 'idle';
    if (isAnswerKey) return 'correct';
    if (picked.includes(key)) return 'wrong';
    return 'idle';
  };

  // 每个评分档实际会给出的间隔（随卡片当前状态变化）
  const intervals = previewIntervals(record?.state ?? null, todayUtc());

  const canSubmit =
    card.kind === 'single'
      ? picked.length === 1
      : card.kind === 'multiple'
        ? picked.length > 0
        : card.kind === 'blank' || card.kind === 'short'
          ? textInput.trim().length > 0
          : true;

  return (
    <div className="review-wrap">
      {/* 顶部：进度 + 掌握度胶囊 */}
      <div className="review-head">
        <button type="button" className="btn-text" onClick={onExit}>
          ← 退出复习
        </button>
        <span className="review-progress-text">
          {index + 1} / {total}
        </span>
        {masteryNow !== null ? (
          <span
            className={`live-mastery${
              groupMasteryBefore !== undefined && masteryNow > groupMasteryBefore
                ? ' live-mastery--up'
                : ''
            }`}
            title="这组题的整体掌握度"
          >
            本组 {Math.round(masteryNow * 100)}%
            {groupMasteryBefore !== undefined && masteryNow > groupMasteryBefore ? (
              <span className="live-mastery__delta">
                +{Math.round((masteryNow - groupMasteryBefore) * 100)}%
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      {/* 题卡 */}
      <article className="question-card paper" key={card.id}>
        <div className="question-meta">
          <span>
            {index + 1}/{total}
            <span className="question-kind">{CARD_KIND_LABEL[card.kind]}</span>
          </span>
          {record ? (
            <span className="question-meta__dim">
              已复习 {record.state.reviewCount} 次
            </span>
          ) : (
            <span className="question-meta__dim">首次学习</span>
          )}
        </div>

        {/* 2px 朱砂进度条 */}
        <div className="card-progress" aria-hidden="true">
          <div
            className="card-progress__fill"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>

        <div className="question-body">
          <h2 className="question-prompt">{card.prompt}</h2>

          {/* ---- 选项行 ---- */}
          {card.kind === 'single' || card.kind === 'multiple' ? (
            <div className="options">
              {card.options.map((o) => {
                const st = optionState(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={`option option--${st}`}
                    onClick={() => {
                      if (revealed) return;
                      if (card.kind === 'single') setPicked([o.key]);
                      else
                        setPicked((p) =>
                          p.includes(o.key) ? p.filter((x) => x !== o.key) : [...p, o.key],
                        );
                    }}
                    disabled={revealed}
                  >
                    <span className="option__mark">{o.key}</span>
                    <span className="option__text">
                      {o.text}
                      {revealed && st === 'correct' ? (
                        <span className="option__tag option__tag--ok">正确答案</span>
                      ) : null}
                      {revealed && st === 'wrong' ? (
                        <span className="option__tag option__tag--bad">你的选择</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* ---- 填空 / 简答 ---- */}
          {card.kind === 'blank' || card.kind === 'short' ? (
            <div className="answer-input">
              {card.kind === 'short' ? (
                <textarea
                  className="answer-area"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="写下你的答案…"
                  disabled={revealed}
                  rows={3}
                />
              ) : (
                <input
                  className="answer-field"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="填入答案…"
                  disabled={revealed}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit && !revealed) submitChoice();
                  }}
                />
              )}
            </div>
          ) : null}

          {/* ---- 知识点：只读 ---- */}
          {card.kind === 'point' ? (
            <div className="point-body">{card.explanation}</div>
          ) : null}

          {/* ---- 揭晓：答案与解析 ---- */}
          {revealed ? (
            <div className="reveal">
              {card.kind !== 'point' ? (
                <div className={`reveal__verdict reveal__verdict--${graded?.correct ? 'ok' : 'bad'}`}>
                  {graded?.correct ? '✓ 答对了' : '✕ 答错了'}
                  {card.kind !== 'single' && card.kind !== 'multiple' ? (
                    <span className="reveal__answer">
                      参考答案：{card.answer}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {card.explanation ? (
                <div className="reveal__explain">{card.explanation}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>

      {/* ---- 底部：作答按钮 或 评分档 ---- */}
      <div className="review-foot">
        {!revealed ? (
          <button
            type="button"
            className="btn-fill"
            onClick={card.kind === 'point' ? () => setRevealed(true) : submitChoice}
            disabled={!canSubmit}
          >
            {card.kind === 'point' ? '看完了' : '提交答案'}
            <span className="btn-fill__arrow" aria-hidden="true">
              →
            </span>
          </button>
        ) : (
          <div className="grades">
            <div className="grades__head">
              <span className="grades__title">掌握程度</span>
              <span className="grades__hint">按 0–5 评分 · 下面是下次复习的间隔</span>
            </div>
            <div className="grades__row">
              {GRADES.map((g, i) => {
                const days = intervals[i] ?? 1;
                return (
                  <button
                    key={g.score}
                    type="button"
                    className={`grade grade--${g.score}`}
                    onClick={() => void submitGrade(g.grade)}
                    title={`${g.label} → ${fmtInterval(days)}后复习`}
                  >
                    <span className="grade__n">{g.score}</span>
                    <span className="grade__label">{g.label}</span>
                    <span className="grade__hint">{fmtInterval(days)}</span>
                  </button>
                );
              })}
            </div>
            <div className="grades__auto">
              <button type="button" className="btn-text" onClick={() => void autoGrade()}>
                按作答情况自动评分
              </button>
            </div>
          </div>
        )}

        {revealed ? (
          <button type="button" className="btn-text" onClick={onFinish}>
            结束这一轮
          </button>
        ) : null}
      </div>

      {/* 本轮小结 */}
      {done > 0 ? (
        <div className="review-stats">
          本轮已评 {done} 张 · 答对 {correctCount} 张
        </div>
      ) : null}
    </div>
  );
}

/** 供外部（测试/调试）复用 */
export { GRADES };
export type { ReviewGrade };
