/**
 * 跨题组选题组卷（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「当前模拟考试是从题库里选择特定的题组或是全部题组进行出题，
 *   建议增加一个可以从浏览题库并从不同题组里组卷出题的功能。」
 *
 * 现在的选法只有两种极端：某个题组、或全部。用户想的是
 * 「这道题不错、那道也不错，凑一套卷」—— 那需要按题浏览与勾选。
 *
 * ## 设计取舍
 *
 * ### 为什么按题组分组、而不是拉一张大平表
 *
 * 23 道题还好，几百道就没法看了。按题组分组 + 可折叠，
 * 用户能先扫标题再展开。而且同一题组的题通常主题相近，
 * 分组的语义是有意义的（不是为分组而分组）。
 *
 * ### 为什么默认全不勾
 *
 * 预勾选会让用户以为「已经选好了」，直接点开始 —— 那是
 * 一整池题全进去，不是他想要的。全不勾 + 显示「已选 0 / 23」，
 * 意图明确。
 *
 * ### 为什么勾选状态用 Set 而不是数组
 *
 * 判断「这题勾了吗」是 O(1)。用数组每次都要 includes，
 * 一屏 20 题 × 每次渲染 = 白算。
 *
 * ### 为什么提供「按题型快选」
 *
 * 组卷的真实需求常是「我要 10 道单选 + 2 道计算」。
 * 手动点 50 次不如按题型扫一遍。这个按钮就是为那个场景。
 */

import { useMemo, useState } from 'react';
import type { Question } from '@/core/model.ts';
import { kindLabel, KIND_SPECS } from '@/core/questions/kinds.ts';

export interface QuestionPickerProps {
  /** 已按题组分好的题（组名 → 题目） */
  groups: { deckId: string; deckTitle: string; questions: Question[] }[];
  /** 已勾选的题目 id（受控） */
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** 确认用这一套题（原样开考） */
  onConfirm: () => void;
  /**
   * 确认按钮的文案（2026-11-17）。
   *
   * 同一个面板有两种用途（原样开考 / 让 AI 改造），
   * 文案不同但**不多摆按钮** —— 用户明确要求界面别臃肿。
   */
  confirmLabel?: string;
  /**
   * 正在跑（改造组卷时要十几秒到半分钟）。
   *
   * 忙碌时：确认按钮变灰+改文案、禁用所有勾选与取消 ——
   * 用户不该在「AI 正在拿这批题改造」的时候继续勾选，
   * 那会让他以为改动生效了（实际上已经发出去的请求不会带上新勾选）。
   */
  busy?: boolean;
  onCancel: () => void;
}

export function QuestionPicker({
  groups,
  selected,
  onChange,
  onConfirm,
  confirmLabel = '用这些题开考',
  busy = false,
  onCancel,
}: QuestionPickerProps) {
  /** 展开的题组（默认全展开 —— 用户点进来就是要看题） */
  const [open, setOpen] = useState<Set<string>>(new Set(groups.map((g) => g.deckId)));

  const all = useMemo(() => groups.flatMap((g) => g.questions), [groups]);

  /** 按题型统计已选 / 总数 */
  const byKind = useMemo(() => {
    const m = new Map<string, { picked: number; total: number }>();
    for (const q of all) {
      const cur = m.get(q.kind) ?? { picked: 0, total: 0 };
      cur.total += 1;
      if (selected.has(q.id)) cur.picked += 1;
      m.set(q.kind, cur);
    }
    return m;
  }, [all, selected]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const toggleGroup = (deckId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  };

  /** 整组勾选 / 取消（按「当前是否全勾」决定方向） */
  const toggleDeckAll = (qs: Question[]) => {
    const next = new Set(selected);
    const allPicked = qs.every((q) => next.has(q.id));
    for (const q of qs) {
      if (allPicked) next.delete(q.id);
      else next.add(q.id);
    }
    onChange(next);
  };

  /** 按题型勾选前 N 道（组卷常用：我要 10 道单选） */
  const pickByKind = (kind: string) => {
    const next = new Set(selected);
    const pool = all.filter((q) => q.kind === kind && !next.has(q.id));
    /* 一次最多补 10 道，够用且不会一按就全选 */
    for (const q of pool.slice(0, 10)) next.add(q.id);
    onChange(next);
  };

  return (
    <div className="qp">
      <header className="qp-head">
        <div>
          <h2 className="qp-title">从题库选题组卷</h2>
          <p className="qp-lead">
            跨题组挑题，凑成一套你自己的卷子。已选 <strong>{selected.size}</strong> / {all.length} 道。
          </p>
        </div>
        <div className="qp-head__actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onChange(new Set(all.map((q) => q.id)))}
          >
            全选
          </button>
          <button type="button" className="btn-ghost" onClick={() => onChange(new Set())}>
            清空
          </button>
        </div>
      </header>

      {/* ---- 按题型快选 ---- */}
      <div className="qp-kinds">
        {KIND_SPECS.filter((s) => (byKind.get(s.id)?.total ?? 0) > 0).map((s) => {
          const c = byKind.get(s.id)!;
          return (
            <button
              key={s.id}
              type="button"
              className="qp-kind"
              onClick={() => pickByKind(s.id)}
              title={`再选最多 10 道${s.label}`}
            >
              {s.label} {c.picked}/{c.total}
            </button>
          );
        })}
      </div>

      {/* ---- 按题组分组浏览 ---- */}
      <div className="qp-groups">
        {groups.map((g) => {
          const isOpen = open.has(g.deckId);
          const pickedInDeck = g.questions.filter((q) => selected.has(q.id)).length;
          const allPicked = pickedInDeck === g.questions.length && g.questions.length > 0;
          return (
            <section key={g.deckId} className="qp-group">
              <div className="qp-group__head">
                <button
                  type="button"
                  className="qp-group__toggle"
                  onClick={() => toggleGroup(g.deckId)}
                  aria-expanded={isOpen}
                >
                  <span className="qp-group__arrow">{isOpen ? '▾' : '▸'}</span>
                  <span className="qp-group__title">{g.deckTitle}</span>
                  <span className="qp-group__count">
                    {pickedInDeck}/{g.questions.length}
                  </span>
                </button>
                <button
                  type="button"
                  className="qp-group__all"
                  onClick={() => toggleDeckAll(g.questions)}
                >
                  {allPicked ? '取消本组' : '全选本组'}
                </button>
              </div>

              {isOpen ? (
                <ul className="qp-list">
                  {g.questions.map((q, i) => {
                    const on = selected.has(q.id);
                    return (
                      <li key={q.id} className={`qp-item${on ? ' qp-item--on' : ''}`}>
                        <label className="qp-item__label">
                          {/*
                            busy 时禁用勾选（2026-11-17）：
                            请求已经带着「现在的勾选」发出去了，
                            这时再勾/取消会让人以为改动生效了。
                          */}
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={busy}
                            onChange={() => toggle(q.id)}
                          />
                          <span className="qp-item__no">{i + 1}</span>
                          <span className="qp-item__kind">{kindLabel(q.kind)}</span>
                          <span className="qp-item__prompt">
                            {q.prompt.length > 70 ? `${q.prompt.slice(0, 70)}…` : q.prompt}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      <footer className="qp-foot">
        <span className="qp-foot__count">
          {busy ? (
            <>
              <span className="qp-foot__spinner" aria-hidden="true" />
              正在处理，请稍候…
            </>
          ) : (
            <>
              已选 <strong>{selected.size}</strong> 道
              {selected.size === 0 ? '（至少选 1 道）' : ''}
            </>
          )}
        </span>
        <div className="qp-foot__actions">
          {/*
            忙碌时禁用取消与确认（2026-11-17）。
            请求已经发出去了，这时点取消只会让界面和实际状态不一致。
          */}
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn-fill"
            disabled={selected.size === 0 || busy}
            onClick={onConfirm}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </footer>
    </div>
  );
}