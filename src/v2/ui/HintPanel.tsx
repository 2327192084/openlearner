/**
 * 提示阶梯面板（2026-11-19）。
 *
 * ## 它解决什么
 *
 * 做题只有两态：会 / 不会。盯着题目不会做时唯一的出路是「直接看答案」——
 * 那等于放弃思考。这里给中间几档：方向 → 拆小问题 → 关键条件 → 相似例。
 *
 * 来源：LogiNote v1.1.3 `REVIEW_TUTOR_PROMPT` 的「提示阶梯」一节。
 *
 * ## 放在哪、什么时候出现
 *
 * 做题页的**作答前**（`!revealed`）。用户的「卡住」发生在交卷之前，
 * 答完之后再给提示就没意义了（那时已经能看到答案）。
 *
 * ## 设计取舍
 *
 * - **按需逐级展开**，不强制走完四级。用户想直接看答案也行 ——
 *   拦着他只会让他烦。
 * - **3–4 级明确标出后果**：「看过之后答对，这题不算真会」。
 *   这不是吓唬，是让间隔调度不被骗（见 hint-ladder.ts 的 judgeMasteryWithHints）。
 * - **一次只多给一级**：点一下出一级，不把四级全铺开。
 *   全铺开等于把答案直接摊在面前。
 *
 * ## 为什么单独一个文件
 *
 * ReviewPage.tsx 已 1200+ 行，硬约束 10：新增 UI 一律独立文件。
 */

import { useCallback, useState } from 'react';
import {
  HINT_STEPS,
  STRONG_HINT_FROM,
  type HintLevel,
  type HintResult,
} from '@/core/ai/hint-ladder.ts';
import { explainError } from '@/v2/core/explain-error.ts';
import { MathText } from './MathText.tsx';

export interface HintPanelProps {
  /*
   * 不接收 card / given —— 拼提示词需要它们，但那件事在宿主做
   * （见 App 的 handleAskHint）。这个面板只负责把结果画出来，
   * 少两个依赖也让它在别处（复习巩固、错题页）能直接复用。
   */

  /** 生成一级提示；抛错则界面显示错误 */
  onAsk: (level: Exclude<HintLevel, 0>, previous: readonly HintResult[]) => Promise<HintResult>;
  /** 每次新增一级提示时通知宿主（宿主据此记录「最高用到第几级」） */
  onLevelUsed: (level: Exclude<HintLevel, 0>) => void;
}

export function HintPanel({ onAsk, onLevelUsed }: HintPanelProps) {
  const [hints, setHints] = useState<HintResult[]>([]);
  const [busy, setBusy] = useState<Exclude<HintLevel, 0> | null>(null);
  const [err, setErr] = useState<{ title: string; hint: string | null } | null>(null);

  const maxUsed = hints.reduce<HintLevel>((m, h) => (h.level > m ? h.level : m), 0);
  const next = (maxUsed + 1) as Exclude<HintLevel, 0>;
  const canAskMore = maxUsed < HINT_STEPS.length;

  const ask = useCallback(
    async (level: Exclude<HintLevel, 0>) => {
      if (busy) return;
      setBusy(level);
      setErr(null);
      try {
        const result = await onAsk(level, hints);
        setHints((prev) => [...prev, result]);
        onLevelUsed(level);
      } catch (e) {
        setErr(explainError(e, '提示生成失败'));
      } finally {
        setBusy(null);
      }
    },
    [busy, hints, onAsk, onLevelUsed],
  );

  const step = HINT_STEPS.find((s) => s.level === next);

  return (
    <section className="hint-panel" aria-live="polite">
      {hints.length === 0 ? (
        <div className="hint-panel__intro">
          <span className="hint-panel__lead">卡住了？可以要个提示 —— 从最轻的开始给。</span>
          <button
            type="button"
            className="hint-panel__ask"
            disabled={busy !== null}
            onClick={() => void ask(1)}
          >
            {busy === 1 ? '正在想…' : '给个方向'}
          </button>
        </div>
      ) : (
        <ul className="hint-panel__list">
          {hints.map((h) => {
            const s = HINT_STEPS.find((x) => x.level === h.level);
            const strong = h.level >= STRONG_HINT_FROM;
            return (
              <li key={h.level} className={`hint-item${strong ? ' hint-item--strong' : ''}`}>
                <div className="hint-item__head">
                  <span className="hint-item__lv">第 {h.level} 级</span>
                  <span className="hint-item__label">{s?.label ?? '提示'}</span>
                </div>
                <p className="hint-item__text">
                  <MathText text={h.text} />
                </p>
                {/*
                  强提示的后果要写在提示**后面**，不是前面 ——
                  写在前面会让用户还没读提示就先被警告吓住。
                */}
                {strong && s?.warning ? (
                  <p className="hint-item__warn">{s.warning}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {err ? (
        <div className="hint-panel__err">
          <span className="hint-panel__err-title">{err.title}</span>
          {err.hint ? <span className="hint-panel__err-hint">{err.hint}</span> : null}
          <button type="button" className="btn-text" onClick={() => setErr(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {hints.length > 0 && canAskMore && step ? (
        <div className="hint-panel__more">
          <button
            type="button"
            className="hint-panel__ask"
            disabled={busy !== null}
            onClick={() => void ask(next)}
          >
            {busy === next ? '正在想…' : `还不够？${step.label}`}
          </button>
          {/* 下一级若跨过强提示线，提前说清代价 —— 别让用户点完才后悔 */}
          {next >= STRONG_HINT_FROM && maxUsed < STRONG_HINT_FROM ? (
            <span className="hint-panel__cost">下一级是强提示，看过之后答对不算真会。</span>
          ) : null}
        </div>
      ) : null}

      {!canAskMore && hints.length > 0 ? (
        <p className="hint-panel__end">
          提示已经给到最细了。如果还是不会，直接看答案也没关系 —— 先把它看懂。
        </p>
      ) : null}
    </section>
  );
}