/**
 * 提问式复习的问答窗口（2026-11-10）。
 *
 * ## 一轮的流程
 *
 * ```
 * 选范围 → AI 出题 → 用户作答 → AI 判定
 *   → 显示判定（记忆错误 / 理解偏差 / 答对）
 *   → 用户选「保存」：完整原文 / 精简 / 不保存
 *   → 本轮结束
 * ```
 *
 * ## 为什么每步都要用户点
 *
 * 不让它全自动跑完：用户要能「这题我不想答，换一题」，
 * 也要能「答完不想保存」。全自动会把一次探索变成一条流水线。
 *
 * ## 判定结果的呈现原则
 *
 * 1. **先给结论**（答对 / 记错 / 理解偏了），因为它决定了要不要往下看
 * 2. **再给依据**（AI 引用的原文），并且**标出这段引文有没有在材料里找到**
 *    —— 模型编引文时用户必须知道
 * 3. 最后给纠正
 *
 * 第 2 条是这个界面存在的原因：判定可能不准，但依据摆在那里，
 * 用户自己能判断。
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  OralJudgement,
  OralMaterial,
  OralVerdict,
} from '@/core/oral-review.ts';
import { MathText } from './MathText.tsx';
import './oral-review.css';

/** 会话阶段 */
type Phase =
  /** 正在让 AI 出题 */
  | { kind: 'asking' }
  /** 出题了，等用户作答 */
  | { kind: 'answer'; question: string }
  /** 正在判定 */
  | { kind: 'judging'; question: string; answer: string }
  /** 已判定 */
  | { kind: 'judged'; question: string; answer: string; judgement: OralJudgement }
  /** 出题失败 */
  | { kind: 'error'; message: string };

export interface OralReviewPanelProps {
  /** 这一轮从哪来（显示在顶部） */
  scopeLabel: string;
  /** 当前素材 */
  material: OralMaterial | null;
  /** 让 AI 出题 */
  onAsk: (material: OralMaterial) => Promise<string>;
  /** 让 AI 判定 */
  onJudge: (material: OralMaterial, question: string, answer: string) => Promise<OralJudgement>;
  /** 保存 */
  onSave: (input: {
    material: OralMaterial;
    question: string;
    answer: string;
    judgement: OralJudgement;
    savedAs: 'full' | 'brief';
  }) => Promise<void>;
  /** 换一条素材，再来一轮 */
  onNext: () => void;
  /** 结束 */
  onExit: () => void;
  /** 跳回原文 */
  onOpenAnchor?: (sourceId: string, page: number | null, quote: string | null) => void;
  /**
   * 顶部要插的范围选择器（2026-11-10）。
   *
   * 只有「从资料中提问」这条路会出现 —— 划选提问已经明确了范围
   * （就是那一段），再给一个下拉反而不合理。
   * 做成 slot 而不是让本组件自己去读库：面板只管问与答，
   * 范围怎么取、能取哪些是宿主的事（见 OralScopePicker）。
   */
  scopePicker?: ReactNode;
}

export function OralReviewPanel({
  scopeLabel,
  material,
  onAsk,
  onJudge,
  onSave,
  onNext,
  onExit,
  onOpenAnchor,
  scopePicker,
}: OralReviewPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** 保存过的形态（存完禁掉按钮，避免重复写） */
  const [saved, setSaved] = useState<'full' | 'brief' | null>(null);

  /* 开一轮：让 AI 出题。素材为空时不发请求 */
  const start = useCallback(async () => {
    if (!material) return;
    setPhase({ kind: 'asking' });
    setDraft('');
    setSaved(null);
    try {
      const q = await onAsk(material);
      setPhase({ kind: 'answer', question: q });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : '出题失败' });
    }
  }, [material, onAsk]);

  /* 首次进入自动开一轮 —— 用户点了「开始提问」就该看到问题 */
  if (phase.kind === 'asking' && material && !busy) {
    /*
     * 这里用「渲染期间触发一次」而不是 useEffect：
     * asking 是本组件唯一的初始态，用 effect 会多一次空渲染。
     * 加 busy 守卫防止重复触发。
     */
    setBusy(true);
    void (async () => {
      try {
        const q = await onAsk(material);
        setPhase({ kind: 'answer', question: q });
      } catch (e) {
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : '出题失败' });
      } finally {
        setBusy(false);
      }
    })();
  }

  const submit = useCallback(async () => {
    if (!material || phase.kind !== 'answer' || busy) return;
    if (!draft.trim()) return;
    setBusy(true);
    const q = phase.question;
    const a = draft;
    setPhase({ kind: 'judging', question: q, answer: a });
    try {
      const j = await onJudge(material, q, a);
      setPhase({ kind: 'judged', question: q, answer: a, judgement: j });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : '判定失败' });
    } finally {
      setBusy(false);
    }
  }, [material, phase, draft, busy, onJudge]);

  const doSave = useCallback(
    async (savedAs: 'full' | 'brief') => {
      if (!material || phase.kind !== 'judged' || busy) return;
      setBusy(true);
      try {
        await onSave({
          material,
          question: phase.question,
          answer: phase.answer,
          judgement: phase.judgement,
          savedAs,
        });
        setSaved(savedAs);
      } finally {
        setBusy(false);
      }
    },
    [material, phase, busy, onSave],
  );

  /* ---------------- 无素材 ---------------- */
  if (!material) {
    return (
      <div className="orp">
        <p className="orp__empty">
          这个范围里没有可以提问的内容。
        </p>
        <p className="orp__hint">
          资料需要先解析出正文（PDF 要能被读出文字）；知识点需要先整理出来。
        </p>
        <div className="orp__actions">
          <button type="button" className="orp__btn" onClick={onExit}>
            回到复习巩固
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="orp">
      {/* 头部：范围 + 退出 */}
      <div className="orp__bar">
        <span className="orp__scope" title={scopeLabel}>
          {scopeLabel}
        </span>
        <button type="button" className="orp__btn orp__btn--ghost" onClick={onExit}>
          结束
        </button>
      </div>

      {/*
        范围选择器（2026-11-10）。只在宿主传了才出现 ——
        划选提问那条路已经明确了「就这段」，不该再有下拉。
      */}
      {scopePicker ? <div className="orp__picker">{scopePicker}</div> : null}

      {phase.kind === 'asking' ? (
        <div className="orp__card">
          <p className="orp__loading">正在出题…</p>
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="orp__card">
          <p className="orp__error">{phase.message}</p>
          <div className="orp__actions">
            <button type="button" className="orp__btn orp__btn--primary" onClick={() => void start()}>
              重试
            </button>
            <button type="button" className="orp__btn" onClick={onExit}>
              结束
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'answer' ? (
        <>
          <div className="orp__card">
            <p className="orp__q">{phase.question}</p>
            <textarea
              className="orp__input"
              rows={5}
              value={draft}
              placeholder="用自己的话回答。记得多少写多少，写得不准没关系 —— 这正是要检验的。"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                /* Ctrl/Cmd + Enter 提交：多行输入里回车要留给换行 */
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="orp__actions">
              <button
                type="button"
                className="orp__btn orp__btn--primary"
                onClick={() => void submit()}
                disabled={busy || !draft.trim()}
              >
                提交回答
              </button>
              <button type="button" className="orp__btn orp__btn--ghost" onClick={onNext} disabled={busy}>
                换一题
              </button>
            </div>
            <p className="orp__kbd">Ctrl / Cmd + Enter 提交</p>
          </div>
        </>
      ) : null}

      {phase.kind === 'judging' ? (
        <div className="orp__card">
          <p className="orp__loading">正在判断你的回答…</p>
        </div>
      ) : null}

      {phase.kind === 'judged' ? (
        <Judged
          material={material}
          question={phase.question}
          answer={phase.answer}
          judgement={phase.judgement}
          saved={saved}
          busy={busy}
          onSave={doSave}
          onNext={onNext}
          onExit={onExit}
          onOpenAnchor={onOpenAnchor}
        />
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* 判定结果                                                                    */
/* ========================================================================== */

const VERDICT_META: Record<OralVerdict, { label: string; tone: string; lead: string }> = {
  correct: {
    label: '答对了',
    tone: 'ok',
    lead: '这次记得住，也理解对了。',
  },
  memory: {
    label: '记忆错误',
    tone: 'bad',
    lead: '你想起来了，但记岔了 —— 这是「记住没记住」的问题。',
  },
  understanding: {
    label: '理解偏差',
    tone: 'warn',
    lead: '字面你可能记得，但对含义 / 因果 / 适用范围想错了。',
  },
};

function Judged({
  material,
  question,
  answer,
  judgement,
  saved,
  busy,
  onSave,
  onNext,
  onExit,
  onOpenAnchor,
}: {
  material: OralMaterial;
  question: string;
  answer: string;
  judgement: OralJudgement;
  saved: 'full' | 'brief' | null;
  busy: boolean;
  onSave: (savedAs: 'full' | 'brief') => Promise<void>;
  onNext: () => void;
  onExit: () => void;
  onOpenAnchor?: (sourceId: string, page: number | null, quote: string | null) => void;
}) {
  const meta = VERDICT_META[judgement.verdict];

  return (
    <>
      <div className={`orp__card orp__card--${meta.tone}`}>
        <div className="orp__verdict">
          <span className={`orp__verdict-tag orp__verdict-tag--${meta.tone}`}>{meta.label}</span>
          <span className="orp__verdict-lead">{meta.lead}</span>
        </div>

        <p className="orp__q orp__q--repeat">{question}</p>
        <p className="orp__answer-line">
          <span className="orp__label">你的回答</span>
          {answer}
        </p>

        {judgement.explanation ? (
          <p className="orp__explain">{judgement.explanation}</p>
        ) : null}

        {judgement.correction ? (
          <div className="orp__correction">
            <span className="orp__label">正确说法</span>
            <p className="orp__correction-text">
              <MathText text={judgement.correction} />
            </p>
          </div>
        ) : null}

        {/*
          判定依据 —— 这个界面最重要的一块。
          没有它，用户只能看到一个黑箱结论；有了它，即使判定错了
          也能自己发现。所以「引文没通过校验」必须显眼地标出来。
        */}
        {judgement.verdict !== 'correct' ? (
          <div className="orp__basis">
            <span className="orp__label">判定依据</span>
            {judgement.quotedFromSource ? (
              <>
                <p className="orp__quote">「{judgement.quotedFromSource}」</p>
                {judgement.quoteVerified ? (
                  <span className="orp__verified orp__verified--ok">
                    ✓ 这段原文在材料里找到了
                  </span>
                ) : (
                  <span className="orp__verified orp__verified--bad">
                    ⚠ 这段引文在材料里<b>没找到</b> —— 模型可能改写了原文，判定未必可靠
                  </span>
                )}
              </>
            ) : (
              <span className="orp__verified orp__verified--bad">
                ⚠ 模型没有给出原文依据，这个判定无法核对
              </span>
            )}

            {material.sourceId && onOpenAnchor ? (
              <button
                type="button"
                className="orp__link"
                onClick={() => onOpenAnchor(material.sourceId, material.page, judgement.quotedFromSource || null)}
              >
                去原文对照{material.page ? `（第 ${material.page} 页）` : ''}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 保存区 */}
      <div className="orp__save">
        {saved ? (
          <p className="orp__saved">
            已保存（{saved === 'full' ? '完整原文' : '精简'}）。
          </p>
        ) : (
          <>
            {/*
              ⚠️ 2026-11-11 晚：删掉了「自动保存」这个开关。
              它原来只控制下面这句提示文字（`autoSave ? '已开启自动保存…'`），
              而 `App.tsx` 里那个值是 `useState(false)` 且**没有 setter**、
              不读设置、不持久化 —— 永远 false，是违反硬约束 8 的假开关。
              用户决定不要这个功能，所以整条链路一起删掉。
            */}
            <p className="orp__save-lead">
              要留下这条记录吗？保存后可以在复习巩固页回看。
            </p>
            <div className="orp__actions">
              <button
                type="button"
                className="orp__btn orp__btn--primary"
                onClick={() => void onSave('brief')}
                disabled={busy}
                title="只留「我错在哪」与正确说法，不存原文"
              >
                精简保存
              </button>
              <button
                type="button"
                className="orp__btn"
                onClick={() => void onSave('full')}
                disabled={busy}
                title="连同这段材料的完整原文一起留"
              >
                完整原文保存
              </button>
            </div>
          </>
        )}

        <div className="orp__actions orp__actions--end">
          <button type="button" className="orp__btn" onClick={onNext}>
            再来一题
          </button>
          <button type="button" className="orp__btn orp__btn--ghost" onClick={onExit}>
            结束本轮
          </button>
        </div>
      </div>
    </>
  );
}
