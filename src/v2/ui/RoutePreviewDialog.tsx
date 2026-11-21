/**
 * 学习路线预览确认对话框（2026-11-21）。
 *
 * ## 为什么需要它
 *
 * 用户确认过的第③点：「AI 给、我勾，勾完才存」。
 * 路线是**一整条**（100+ 条知识点），AI 的判断可能不合他直觉
 * （他觉得重要的模型排后面、他觉得简单的模型标成 5 级难）。
 * 全自动落库会让他面对一条不想照做的路线，还得一条条改。
 *
 * ## 为什么单独一个文件
 *
 * `App.tsx` 已经 3500+ 行（硬约束：大文件不要插代码）。
 * 这个对话框有 100+ 个勾选框的渲染逻辑，塞进去会让那个文件更难改。
 *
 * ## 为什么横板图里不做勾选，要弹对话框
 *
 * 横板（`RouteMap.tsx`）是**看图**的：一屏看到路线多长、走到哪。
 * 105 个节点的勾选塞进横板会变成一条滚不到头的长条，
 * 既看不清图也勾不过来。所以分工：
 *  - 横板 = 已确认路线的可视化
 *  - 这个对话框 = 未确认结果的逐条核对
 */

import { useMemo, useState } from 'react';
import type { PlanOrder } from '@/core/ai/plan-order.ts';
import type { KnowledgePoint } from '@/core/model.ts';

export interface RoutePreviewDialogProps {
  draft: {
    blocks: PlanOrder['blocks'];
    unplaced: number[];
    dropped: number;
  };
  /** 知识点 id → 原始记录（显示陈述） */
  pointById: ReadonlyMap<string, KnowledgePoint>;
  /** 确认后回调（只带勾选的条目，已重新连续编号） */
  onConfirm: (picked: { blocks: PlanOrder['blocks']; unplaced: number; dropped: number }) => void;
  onCancel: () => void;
}

/**
 * 逐条核对 AI 排出来的路线。
 *
 * ## 默认全勾
 *
 * 排序是**一个整体** —— 只勾一半会得到一条断掉的路径
 * （「第 3 步是第 1 步的前置」而第 2 步被取消了）。
 * 所以默认全勾，让用户**取消**不想照做的，而不是从零勾起。
 *
 * ## 块可以整块取消
 *
 * 100+ 条逐条点太慢。多数情况是「这一块我不想学」而不是
 * 「这一块里第 37 条我不要」。所以每块标题上给一个全选/全不选。
 */
export function RoutePreviewDialog(props: RoutePreviewDialogProps) {
  const { draft, pointById, onConfirm, onCancel } = props;

  /* 默认全勾（见注释：排序是整体，默认全不勾等于让用户从零开始点） */
  const [picked, setPicked] = useState<Set<string>>(() => {
    const all = new Set<string>();
    for (const b of draft.blocks) for (const it of b.items) all.add(it.pointId);
    return all;
  });

  const total = useMemo(
    () => draft.blocks.reduce((n, b) => n + b.items.length, 0),
    [draft],
  );

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 整块全选/全不选 */
  function toggleBlock(ids: string[]) {
    setPicked((prev) => {
      const allIn = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (allIn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function confirm() {
    /*
     * 只留勾选的，并**重新连续编号**。
     *
     * 取消几条后 order 会留空洞（1,3,5），横板上「第 3 关」前一个
     * 是「第 1 关」，用户会以为中间丢了东西。
     */
    const blocks: PlanOrder['blocks'] = [];
    let seq = 0;
    for (const b of draft.blocks) {
      const items = b.items.filter((i) => picked.has(i.pointId));
      if (items.length === 0) continue;
      const blockIndex = blocks.length;
      for (const item of items) {
        seq += 1;
        item.order = seq;
        item.blockIndex = blockIndex;
      }
      blocks.push({ ...b, items });
    }

    const keptCount = seq;
    onConfirm({
      blocks,
      /*
       * 没进路线的条数要如实累计：AI 没排的 + 用户取消的。
       * 少算了界面会说「整门课都排完了」，而实际上还有一大截没学。
       */
      unplaced: draft.unplaced.length + (total - keptCount),
      dropped: draft.dropped,
    });
  }

  return (
    <div className="rpd" role="dialog" aria-modal="true" aria-label="确认学习路线">
      <div className="rpd__panel">
        <header className="rpd__head">
          <h2 className="rpd__title">确认这条学习路线</h2>
          <p className="rpd__lead">
            AI 排了 {total} 条，归成 {draft.blocks.length} 块。
            它可能排得不合你意 —— <b>取消勾选你不想照做的</b>，剩下这些才会存进路线。
          </p>
          {draft.unplaced.length > 0 ? (
            <p className="rpd__warn">
              另有 {draft.unplaced.length} 条知识点 AI 没排进来（编号{' '}
              {draft.unplaced.slice(0, 12).join('、')}
              {draft.unplaced.length > 12 ? '…' : ''}）。它们仍是知识点，只是不在这次路线里。
            </p>
          ) : null}
          {draft.dropped > 0 ? (
            <p className="rpd__warn">
              有 {draft.dropped} 条结果被丢弃（编号越界或重复 —— 指错了知识点，宁可不要）。
            </p>
          ) : null}
        </header>

        <div className="rpd__body">
          {draft.blocks.map((block, bi) => {
            const ids = block.items.map((i) => i.pointId);
            const allIn = ids.every((id) => picked.has(id));
            const someIn = ids.some((id) => picked.has(id));
            return (
              <section key={`${block.title}-${bi}`} className="rpd__block">
                <header className="rpd__block-head">
                  <h3 className="rpd__block-title">{block.title}</h3>
                  <button
                    type="button"
                    className="rpd__block-toggle"
                    onClick={() => toggleBlock(ids)}
                  >
                    {allIn ? '本块全不选' : someIn ? '本块全选' : '本块全选'}
                  </button>
                </header>
                {block.why ? <p className="rpd__block-why">{block.why}</p> : null}

                <ul className="rpd__items">
                  {block.items.map((item) => {
                    const p = pointById.get(item.pointId);
                    if (!p) return null;
                    return (
                      <li key={item.pointId} className="rpd__item">
                        <label className="rpd__label">
                          <input
                            type="checkbox"
                            className="rpd__box"
                            checked={picked.has(item.pointId)}
                            onChange={() => toggle(item.pointId)}
                          />
                          <span className="rpd__order">{item.order}</span>
                          <span className="rpd__body-text">
                            <span className="rpd__stmt">{p.statement}</span>
                            <span className="rpd__meta">
                              {item.difficulty !== null ? (
                                <span
                                  className="rpd__diff"
                                  title={`AI 判断的难度：${item.difficulty}/5（这是知识点本身的难度，不是你的掌握度）`}
                                >
                                  难度 {item.difficulty}/5
                                </span>
                              ) : (
                                <span className="rpd__diff rpd__diff--unknown" title="AI 没给出难度判断">
                                  难度未知
                                </span>
                              )}
                              {item.reason ? (
                                <span className="rpd__why">{item.reason}</span>
                              ) : null}
                              {item.basis ? (
                                <span className="rpd__basis">依据：{item.basis}</span>
                              ) : null}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

        <footer className="rpd__foot">
          <span className="rpd__count">
            已勾 <b>{picked.size}</b> / {total}
          </span>
          <div className="rpd__actions">
            <button type="button" className="btn-ghost" onClick={onCancel}>
              不要这个结果
            </button>
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={confirm}
              disabled={picked.size === 0}
            >
              确认这条路线（{picked.size} 条）
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}