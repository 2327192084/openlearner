/**
 * 做题页的「针对这个错误，专门讲一遍」面板（2026-11-19）。
 *
 * ## 它补的是哪个缺口
 *
 * 答错后界面上只有两样东西：整题 `explanation`（出题时写死的）、逐选项
 * `why`（讲「这个选项为什么错」）。但用户卡住的地方更具体：
 * 「我选 B 是因为我以为条件对称 —— 到底哪一步想错了？」
 *
 * 来源：LogiNote v1.1.3 作者视频 04:07 / 04:27。
 *
 * ## 2026-11-19 第二轮：按讲法分类 + 可收起
 *
 * 用户反馈（截图）：五条讲解一次性全铺开占满整屏，而且第 2、3 条内容一样。
 *
 * **重复的根因**：原来 `allNotes = [...notes, ...(fresh ? [fresh] : [])]`。
 * `fresh` 是刚生成那条的乐观展示，但它**同时已经落库** —— 下一帧 `notes`
 * 里也有它，于是同一条渲染两遍。
 * 现在改成：只渲染 `notes`（唯一真源），生成中显示一行「正在讲…」，
 * 落库后由宿主刷新 `notes` 自然出现。少一份状态，就不会有第二份真相。
 *
 * ## 为什么按讲法分组而不是按时间铺开
 *
 * 同一个错误用「直接讲」「讲故事」「对比着讲」各要一次是常见操作 ——
 * 用户是在找「哪种讲法我听懂了」。按讲法归类、默认只看一条，
 * 比按时间堆五条更容易比较。
 */
import { useCallback, useMemo, useState } from 'react';
import type { ExplainNote } from '@/core/model.ts';
import { EXPLAIN_STYLES, type ExplainResult } from '@/core/ai/explain-wrong.ts';
import { MathText } from './MathText.tsx';

export interface ExplainPanelProps {
  /** 已有的讲解（按时间顺序，旧→新）；没有就给空数组 */
  notes: readonly ExplainNote[];
  /** 生成一条讲解；抛错则界面显示错误 */
  onGenerate: (styleId: string, customStyle: string) => Promise<ExplainResult>;
}

export function ExplainPanel({ notes, onGenerate }: ExplainPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  /** 整块是否展开（答完题后如果已经懂了，这块占着位置没用） */
  const [open, setOpen] = useState(true);
  /**
   * 当前看的是哪一条（按 id）。
   *
   * 默认 null = 自动取最新一条。用 id 而不是索引：
   * 新生成一条之后索引会变，而用户明确点过的那一条不该跟着跳。
   */
  const [activeId, setActiveId] = useState<string | null>(null);

  /*
   * 按讲法分组。
   *
   * 同一个讲法可能有多次（例如「对比着讲」试了两回），
   * 组内按时间倒序 —— 最新的在前，因为用户通常想看刚生成的那条。
   */
  const groups = useMemo(() => {
    const byStyle = new Map<string, ExplainNote[]>();
    for (const n of notes) {
      const list = byStyle.get(n.styleId) ?? [];
      list.push(n);
      byStyle.set(n.styleId, list);
    }
    /*
     * 组的顺序按 EXPLAIN_STYLES 的定义顺序（直接讲/举例子/讲故事/分步骤/对比着讲），
     * 而不是按出现时间 —— 固定顺序让用户第二次打开时不用重新找。
     * 自定义 styleId（理论上不会有）排在最后。
     */
    const known = EXPLAIN_STYLES.map((s) => s.id);
    return [...byStyle.entries()]
      .sort((a, b) => {
        const ia = known.indexOf(a[0]);
        const ib = known.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([styleId, list]) => ({
        styleId,
        label: EXPLAIN_STYLES.find((s) => s.id === styleId)?.label ?? '讲解',
        notes: [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      }));
  }, [notes]);

  /* 当前显示的那一条：用户点过就用他的，否则用最新一条 */
  const shown: ExplainNote | null = useMemo(() => {
    if (notes.length === 0) return null;
    if (activeId) {
      const hit = notes.find((n) => n.id === activeId);
      if (hit) return hit;
    }
    return notes[notes.length - 1] ?? null;
  }, [notes, activeId]);

  const total = notes.length;

  const run = useCallback(
    async (styleId: string) => {
      if (busy) return;
      setBusy(styleId);
      setErr(null);
      try {
        await onGenerate(styleId, custom.trim());
        /*
         * 不再自己存一份"乐观展示" —— 那是重复渲染的来源。
         * 宿主在 onGenerate 内部落库并刷新 notes，这一条会自然出现。
         *
         * 代价：从点按钮到看见内容，要等一次存储往返（几十毫秒）。
         * 换来的是「只有一份真相」，值得 —— 上一条 bug 就是两份真相打架。
         */
        setActiveId(null);   /* 回到"自动取最新" */
      } catch (e) {
        setErr(e instanceof Error ? e.message : '讲解生成失败');
      } finally {
        setBusy(null);
      }
    },
    [busy, custom, onGenerate],
  );

  /* ---------- 收起态：一行入口 ---------- */
  if (!open) {
    return (
      <button
        type="button"
        className="explain-panel__collapsed"
        onClick={() => setOpen(true)}
        aria-expanded={false}
      >
        没懂？针对这个错误讲一遍
        {total > 0 ? <span className="explain-panel__count">{total}</span> : null}
      </button>
    );
  }

  return (
    <section className="explain-panel" aria-live="polite">
      <div className="explain-panel__head">
        <span className="explain-panel__title">
          没懂？针对这个错误讲一遍
          {total > 0 ? <span className="explain-panel__count">{total}</span> : null}
        </span>
        <span className="explain-panel__head-acts">
          <button
            type="button"
            className="btn-text explain-panel__custom-toggle"
            onClick={() => setShowCustom((v) => !v)}
            aria-expanded={showCustom}
          >
            {showCustom ? '收起要求' : '提要求'}
          </button>
          {/* 收起整块：答完题、已经懂了时不该继续占着屏幕 */}
          <button
            type="button"
            className="btn-text explain-panel__collapse"
            onClick={() => setOpen(false)}
            aria-expanded
            title="收起这块"
          >
            收起
          </button>
        </span>
      </div>

      {showCustom ? (
        <textarea
          className="explain-panel__custom"
          rows={2}
          placeholder="例如：用我能听懂的话讲，别用术语／只讲我错的那一步"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={busy !== null}
        />
      ) : null}

      <div className="explain-panel__styles" role="group" aria-label="讲解方式">
        {EXPLAIN_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`explain-panel__style${busy === s.id ? ' explain-panel__style--busy' : ''}`}
            disabled={busy !== null}
            onClick={() => void run(s.id)}
            title={s.instruction}
          >
            {busy === s.id ? '正在讲…' : s.label}
          </button>
        ))}
      </div>

      {err ? (
        <div className="explain-panel__err">
          <span>{err}</span>
          <button type="button" className="btn-text" onClick={() => setErr(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {/*
        按讲法分类的切换条（2026-11-19）。
        只在「有两条以上、且不止一种讲法」时出现 —— 只有一条时这排按钮是噪音。
      */}
      {groups.length > 1 ? (
        <div className="explain-panel__tabs" role="tablist" aria-label="讲解方式">
          {groups.map((g) => {
            const isShown = shown !== null && shown.styleId === g.styleId;
            return (
              <button
                key={g.styleId}
                type="button"
                role="tab"
                aria-selected={isShown}
                className={`explain-tab${isShown ? ' explain-tab--on' : ''}`}
                onClick={() => {
                  /* 切到这个讲法下最新的一条 */
                  const latest = g.notes[0];
                  if (latest) setActiveId(latest.id);
                }}
              >
                {g.label}
                {g.notes.length > 1 ? (
                  <span className="explain-tab__n">{g.notes.length}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* 只渲染当前这一条 —— 不再把全部铺开 */}
      {shown ? (
        <article className="explain-note">
          <div className="explain-note__head">
            <span className="explain-note__style">
              {EXPLAIN_STYLES.find((s) => s.id === shown.styleId)?.label ?? '讲解'}
            </span>
            {shown.given ? (
              <span className="explain-note__given">针对你答的「{shown.given}」</span>
            ) : null}
            {/*
              同一讲法下有多条时，给「上一条 / 下一条」——
              用户可能想看「上次那种讲法」和「这次有什么不同」。
            */}
            {(() => {
              const g = groups.find((x) => x.styleId === shown.styleId);
              if (!g || g.notes.length < 2) return null;
              const i = g.notes.findIndex((n) => n.id === shown.id);
              if (i < 0) return null;
              return (
                <span className="explain-note__pager">
                  <button
                    type="button"
                    className="btn-text"
                    disabled={i >= g.notes.length - 1}
                    onClick={() => setActiveId(g.notes[i + 1]!.id)}
                    title="更早一条"
                  >
                    更早
                  </button>
                  <span className="explain-note__pager-n">
                    {i + 1}/{g.notes.length}
                  </span>
                  <button
                    type="button"
                    className="btn-text"
                    disabled={i <= 0}
                    onClick={() => setActiveId(g.notes[i - 1]!.id)}
                    title="更新一条"
                  >
                    更新
                  </button>
                </span>
              );
            })()}
          </div>
          {shown.crux ? (
            <p className="explain-note__crux">
              <MathText text={shown.crux} />
            </p>
          ) : null}
          {/*
            正文按空行分段渲染。整块塞进一个 <p> 会把换行折叠掉，
            看起来像一段没排版的长文。
          */}
          <div className="explain-note__body">
            {shown.body.split(/\n{2,}/).map((para, i) => (
              <p key={i}>
                <MathText text={para} />
              </p>
            ))}
          </div>
          {shown.nextStep ? (
            <p className="explain-note__next">
              下一步：<MathText text={shown.nextStep} />
            </p>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}