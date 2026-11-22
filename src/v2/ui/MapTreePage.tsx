/**
 * 学习地图·二级页面：**显示一份资料的树状地图**（2026-11-22 下午）。
 *
 * ## 这一页只回答一个问题
 *
 * 「这张地图长什么样、这一节做完没」。
 * 选资料、创建地图在一级页（`MapHomePage.tsx`）—— 那里不画树。
 *
 * ## 为什么带返回按钮而不是靠侧栏
 *
 * 侧栏高亮的是「学习地图」这一项，一二级都是它。如果只有侧栏，
 * 用户在树里点了几下之后想换一张地图，**不知道该点哪里回去**
 * （点侧栏「学习地图」听起来像"再看一下这张图"）。
 * 所以顶部明写「← 回到资料列表」，并带上当前是哪个科目。
 *
 * ## 重规划为什么在这一页
 *
 * 因为"该不该重排"要看着现有地图才能判断：
 * 树里某几章空着、或章节明显不对，用户才会想重排。
 * 在一级页给「重建」按钮等于让他盲点。
 */

import { useState } from 'react';
import type { SectionNode, SourceTree } from '@/v2/core/source-tree.ts';
import type { SectionStats } from './section-stats.ts';
import { RouteTree } from './RouteTree.tsx';
import { ConfirmDialog } from './dialog.tsx';
import type { SourceResource } from '@/v2/core/resource-store.ts';

export interface MapTreePageProps {
  /** 资料标题（从资料表来；树里只有科目名） */
  sourceTitle: string;
  tree: SourceTree;
  stats: ReadonlyMap<string, SectionStats>;
  /** 回到一级页 */
  onBack: () => void;
  /** 改小节任务状态 */
  onTasksChange: (sectionId: string, next: SectionNode['tasks']) => void;
  /** 去闪卡页 */
  onGoFlashcards: (section: SectionNode) => void;
  /** 去做题页 */
  onGoPractice: (section: SectionNode) => void;
  /** 重规划这份资料（会取代现有地图） */
  onReplan: () => Promise<void>;
  /** 删掉这张地图（回到一级页） */
  onDelete: () => Promise<void>;
  /*
   * 外部资源（2026-11-22，方案第 7 步）。
   *
   * 这一页只做**透传**：数据从 App 来，交由 RouteTree → SectionDetail 用。
   * 不在这里过滤/排序 —— 那是数据层的事。
   */
  resources?: readonly SourceResource[];
  sourceId?: string;
  onAddResource?: (r: SourceResource) => void;
  onRemoveResource?: (id: string) => void;
  /** 绑定闪卡/题组的数据与回调（2026-11-22），整块透传 */
  bindingData?: import('./RouteTree.tsx').RouteTreeProps['bindingData'];
  /**
   * 上一次「重新生成」的结果说明（保住了几节、丢了哪几节）。
   *
   * 由 App 算好传进来：它才知道搬了几条。这里只负责如实显示 ——
   * 悄悄把丢失吞掉等于骗用户。
   */
  replanNote?: string | null;
}

export function MapTreePage(props: MapTreePageProps) {
  const {
    sourceTitle,
    tree,
    stats,
    onBack,
    onTasksChange,
    onGoFlashcards,
    onGoPractice,
    onReplan,
    onDelete,
    replanNote,
    resources,
    sourceId,
    onAddResource,
    onRemoveResource,
    bindingData,
  } = props;

  const [busy, setBusy] = useState(false);
  /** 哪个破坏性动作在等确认：null = 没在等 */
  const [confirming, setConfirming] = useState<'replan' | 'delete' | null>(null);

  return (
    <div className="map-tree-page">
      {/* ---------- 返回栏 ---------- */}
      <div className="map-tree-page__bar">
        <button type="button" className="map-tree-page__back" onClick={onBack}>
          ← 回到资料列表
        </button>
        <span className="map-tree-page__crumb" title={sourceTitle}>
          {sourceTitle}
        </span>
      </div>

      {/*
        * 重新生成后的结果如实显示。
        * 有丢失时说清丢的是哪几节 —— 只说个数字等于让用户自己比对。
        */}
      {replanNote ? (
        <p className="map-tree-page__note">{replanNote}</p>
      ) : null}

      <RouteTree
        tree={tree}
        sectionStats={stats}
        onTasksChange={onTasksChange}
        onGoFlashcards={onGoFlashcards}
        onGoPractice={onGoPractice}
        {...(resources ? { resources } : {})}
        {...(sourceId ? { sourceId } : {})}
        {...(onAddResource ? { onAddResource } : {})}
        {...(onRemoveResource ? { onRemoveResource } : {})}
        {...(bindingData ? { bindingData } : {})}
        onReplan={() => setConfirming('replan')}
        onClear={() => setConfirming('delete')}
        busy={busy}
      />

      {/*
        * 两个都是**不可撤销**的动作，必须二次确认。
        *
        * 用项目现有的 `ConfirmDialog`（它已经处理了三个关键点：
        * 初始焦点在取消上、执行中不可重复点、失败时错误留在框里）。
        */}
      {confirming === 'replan' ? (
        <ConfirmDialog
          title="重新生成这张地图？"
          description={
            <>
              AI 会按资料重新排一遍章节。<b>勾过的任务会尽量按小节标题保留</b>
              （同名小节的状态会搬过去；新结构里找不到同名小节的会丢，之后会告诉你丢了哪几节）。
              资料本身不动。
            </>
          }
          confirmLabel="重新生成"
          onConfirm={async () => {
            setBusy(true);
            try {
              await onReplan();
            } finally {
              setBusy(false);
              setConfirming(null);
            }
          }}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title="删除这张地图？"
          description={
            <>
              这张地图上的所有勾选与自定义任务都会没掉，<b>不可撤销</b>。
              资料本身、知识点、题目都不动，之后还能重新生成一张。
            </>
          }
          confirmLabel="删除"
          onConfirm={async () => {
            setBusy(true);
            try {
              /*
               * 删掉整张地图后**回一级页** —— 留在二级页会看到"没有地图"
               * 的空壳，而那正是这个项目反复要避免的东西。
               */
              await onDelete();
              onBack();
            } finally {
              setBusy(false);
              setConfirming(null);
            }
          }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}