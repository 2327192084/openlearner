/**
 * 做题页的「针对这个错误，专门讲一遍」面板（2026-11-19）。
 *
 * ## 它补的是哪个缺口
 *
 * 答错后，界面上只有两样东西：
 *  - 整题 `explanation`：出题时就写死的，讲「正确答案为什么对」
 *  - 逐选项 `why`：讲「这个选项为什么错」（2026-11-19 刚打通）
 *
 * 但用户卡住的地方更具体：「我选 B 是因为我以为条件对称 —— 到底哪一步想错了？」
 * 那是**针对他这次错误**的解释，出题时不可能预写。
 *
 * 来源：LogiNote v1.1.3 作者视频 04:07「针对你答错的部分补充讲解」、
 * 04:27「通过讲故事的方式讲解一下例题」（可调策略）。
 *
 * ## 为什么单独一个文件
 *
 * `ReviewPage.tsx` 已 1139 行，硬约束 10：新增 UI 一律独立文件，
 * 不在大文件里插代码。宿主里只插入一行引用。
 *
 * ## 为什么讲法做成按钮而不是一个输入框
 *
 * 用户答错时正烦着，让他现想「我要你怎么讲」是额外的认知负担。
 * 点一下就换一种讲法最省事；真想提要求也有一个可展开的自定义输入。
 */

import { useCallback, useState } from 'react';
import type { ExplainNote } from '@/core/model.ts';
import {
  EXPLAIN_STYLES,
  type ExplainResult,
} from '@/core/ai/explain-wrong.ts';
import { MathText } from './MathText.tsx';

export interface ExplainPanelProps {
  /** 已有的讲解（按时间顺序）；没有就给空数组 */
  notes: readonly ExplainNote[];
  /** 生成一条讲解；抛错则界面显示错误 */
  onGenerate: (styleId: string, customStyle: string) => Promise<ExplainResult>;
}

/**
 * 「针对这次错误讲一遍」面板。
 *
 * ## 只接收 `notes` 和 `onGenerate`，不接收题目
 *
 * 一开始我把整张 `Question` 传进来，结果做题页拿到的是 `Card`
 * （它没有 `knowledgePointId` / `order` 这些字段）—— 类型对不上。
 *
 * 想清楚后正确的边界是：**这一块不需要知道题目长什么样**。
 * 它要的「答案/选项/用户选了什么」已经在宿主拼提示词时用掉了
 * （见 `buildExplainPrompt`），这里只负责把结果画出来。
 * 少一个依赖，这个组件也能在别处（错题本、复习巩固）单独复用。
 */
export function ExplainPanel({ notes, onGenerate }: ExplainPanelProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  /** 刚生成的（还没进 notes 的乐观展示，避免等待落库后再渲染） */
  const [fresh, setFresh] = useState<ExplainNote | null>(null);

  const run = useCallback(
    async (styleId: string) => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        const result = await onGenerate(styleId, custom.trim());
        /*
         * 宿主在 onGenerate 内部已经落库；这里直接回显结果。
         * 不做「落库成功后再刷新 notes」——宿主的 notes 是 props，
         * 它会在下一次渲染时自然带上这一条（或从这里回显，两者取其一都不会缺）。
         */
        setFresh({
          id: `pending-${Date.now()}`,
          given: '',
          styleId,
          crux: result.crux,
          body: result.body,
          nextStep: result.nextStep,
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '讲解生成失败');
      } finally {
        setBusy(false);
      }
    },
    [busy, custom, onGenerate],
  );

  const allNotes = [...notes, ...(fresh ? [fresh] : [])];

  return (
    <section className="explain-panel" aria-live="polite">
      <div className="explain-panel__head">
        <span className="explain-panel__title">没懂？针对这个错误讲一遍</span>
        <button
          type="button"
          className="btn-text explain-panel__custom-toggle"
          onClick={() => setShowCustom((v) => !v)}
          aria-expanded={showCustom}
        >
          {showCustom ? '收起要求' : '提要求'}
        </button>
      </div>

      {showCustom ? (
        <textarea
          className="explain-panel__custom"
          rows={2}
          placeholder="例如：用我能听懂的话讲，别用术语／只讲我错的那一步"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={busy}
        />
      ) : null}

      <div className="explain-panel__styles" role="group" aria-label="讲解方式">
        {EXPLAIN_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="explain-panel__style"
            disabled={busy}
            onClick={() => void run(s.id)}
            title={s.instruction}
          >
            {s.label}
          </button>
        ))}
      </div>

      {busy ? (
        <p className="explain-panel__busy" role="status">
          正在针对这个错误讲解…通常十几秒，别关这页。
        </p>
      ) : null}

      {err ? (
        <div className="explain-panel__err">
          <span>{err}</span>
          <button type="button" className="btn-text" onClick={() => setErr(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {allNotes.length > 0 ? (
        <ul className="explain-panel__notes">
          {allNotes.map((n) => (
            <li key={n.id} className="explain-note">
              <div className="explain-note__head">
                <span className="explain-note__style">
                  {EXPLAIN_STYLES.find((s) => s.id === n.styleId)?.label ?? '讲解'}
                </span>
                {/*
                  标出「这条讲的是哪次错误」。
                  不标的话，同一个错误讲两次后用户分不清哪条对应哪次作答。
                */}
                {n.given ? (
                  <span className="explain-note__given">针对你答的「{n.given}」</span>
                ) : null}
              </div>
              {n.crux ? (
                <p className="explain-note__crux">
                  <MathText text={n.crux} />
                </p>
              ) : null}
              {/*
                正文按空行分段渲染。不整块塞进一个 <p>：
                模型经常会分段，塞进一个 p 里换行会被 HTML 折叠掉，
                看起来像一段没排版的长文。
              */}
              <div className="explain-note__body">
                {n.body.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>
                    <MathText text={para} />
                  </p>
                ))}
              </div>
              {n.nextStep ? (
                <p className="explain-note__next">
                  下一步：<MathText text={n.nextStep} />
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}