/**
 * 学习地图的**树状图**（2026-11-22，树状地图第 4 步）。
 *
 * ## 用户要的是什么（原话）
 *
 * > 我设想的地图应该是和图二的树状图一样的，从资料延伸出各个章节，
 * > 然后章节中延伸各个小节。点击一个章节节点后局部放大（只专注于该节点
 * > 和节点后延伸出的小节点），通过完成小节任务来完成这一章节。
 * > 一个资料的不同的章节可以同时进行，不用按照顺序，但是如果是和前几章
 * > 有关联需要前置知识点的章节要给用户一个提醒。
 *
 * 拆成三条硬要求：
 *
 * 1. **树**：资料 → 章 → 小节，两级，看得见分叉
 * 2. **点章聚焦**：只专注该章和它的小节，其余章淡出
 * 3. **前置只提醒不锁**：章始终可点
 *
 * ## 为什么坐标是算出来的（不是量出来的）
 *
 * 见 `tree-layout.ts` 文件头。一句话：连线和卡片必须严丝合缝，
 * 而 `getBoundingClientRect()` 在首帧量不到、缩放要重算、jsdom 里更低。
 * 所以节点用 `left/top/width/height` 内联挂上去，**几何只有一个来源**。
 *
 * ⚠️ 因此本文件**不用 CSS 定卡片宽高**。CSS 只管颜色、边框、
 * 字号、阴影这些不影响外框的东西。改 `TREE_METRICS` 就够，别去 CSS 里改。
 *
 * ## 为什么这一版把「小节详情」一起做了
 *
 * 树只有枝干、点小节没反应，那就是用户反复报过的「假按钮」。
 * 所以小节点开必须真的能做事（三任务 + 自定义 + 完成汇总）——
 * 那是方案第 5 步，施工顺序上紧挨着第 4 步，一起交付才是个完整的东西。
 *
 * ## 折叠时也要能看出"有多少小节"
 *
 * 没展开的章也要显示「3/5 小节完成」。用户要先在折叠态下判断
 * 该点哪一章，如果折叠时什么都不显示，他就得一个个点开试探。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SectionNode, SourceTree } from '@/v2/core/source-tree.ts';
import { chapterProgress, isSectionDone, treeProgress } from '@/v2/core/source-tree.ts';
import { prereqNote } from '@/v2/core/tree-build.ts';
import { layoutTree, TREE_METRICS, type TreeBox } from '@/v2/core/tree-layout.ts';
import { shortTitle } from './RouteBoard.tsx';
import { SectionDetail } from './SectionDetail.tsx';
import type { SectionStats } from './section-stats.ts';
import type { SourceResource } from '@/v2/core/resource-store.ts';

export interface RouteTreeProps {
  tree: SourceTree;
  /**
   * 每小节的统计（闪卡数 / 习题数）。
   *
   * 由上层算好传进来（这一层不碰存储）。
   * 缺省或缺某一项时**如实显示"算不出来"**，不显示 0 ——
   * 0 和「算不出来」在用户眼里是完全不同的两件事。
   */
  sectionStats?: ReadonlyMap<string, SectionStats>;
  /** 改某一小节的任务状态（勾选 / 加资源 / 改自定义任务） */
  onTasksChange?: (sectionId: string, next: SectionNode['tasks']) => void;
  /** 去闪卡页学这一节的卡 */
  onGoFlashcards?: (section: SectionNode) => void;
  /** 去做题页练这一节的题 */
  onGoPractice?: (section: SectionNode) => void;
  /*
   * 外部资源（2026-11-22，方案第 7 步）。
   *
   * 资源是**资料级**存的（`SourceResource.sectionId` 指到小节），
   * 所以这里收全量、按小节过滤后传给详情面板 ——
   * 不让 RouteTree 自己碰存储（组件不碰 I/O 是项目一贯分工）。
   */
  /** 这份资料的全部资源 */
  resources?: readonly SourceResource[];
  /** 资料 id（新资源归属） */
  sourceId?: string;
  onAddResource?: (r: SourceResource) => void;
  onRemoveResource?: (id: string) => void;
  /*
   * 绑定闪卡/题组（2026-11-22）。
   *
   * 由上层算好传进来（组件不碰存储）。
   * 按小节 id 索引 —— 一次只显示打开那一节的绑定。
   */
  bindingData?: {
    availableCards: readonly { id: string; front: string }[];
    availableDecks: readonly { id: string; title: string; questionCount: number }[];
    onChange: (sectionId: string, next: { cardIds: string[]; deckIds: string[] }) => void;
    onAskAi?: (sectionId: string) => void;
    aiBusySectionId?: string | null;
    /** 用这一节正文生成闪卡（2026-11-22），只在没有卡时出现 */
    onGenerateCards?: (sectionId: string) => void;
    generatingSectionId?: string | null;
  };
  /** 重新规划 */
  onReplan?: () => void;
  /** 清除路线 */
  onClear?: () => void;
  busy?: boolean;
}

export function RouteTree(props: RouteTreeProps) {
  const {
    tree,
    sectionStats,
    bindingData,
    resources,
    sourceId,
    onAddResource,
    onRemoveResource,
    onTasksChange,
    onGoFlashcards,
    onGoPractice,
    onReplan,
    onClear,
    busy,
  } = props;

  /** 展开哪一章（索引）；null = 全折叠 */
  const [expanded, setExpanded] = useState<number | null>(null);
  /** 当前打开详情的小节 id；null = 没打开 */
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);

  /**
   * ⚠️ 点小节后要把详情滚进视野（2026-11-22 截图发现的）。
   *
   * 树可能有 9–26 个小节、比一屏高，详情面板挂在树**下方**。
   * 用户在树上点一个小节，面板出现在屏幕外 —— 看起来就是"点了没反应"。
   * 这正是项目反复记的"假按钮"：功能做了，但用户看不见。
   *
   * `block: 'nearest'` 而不是 `'start'`：如果面板已经在视野里，
   * 就不该把它硬拽到顶部（那会让人失去上下文）。
   */
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openSectionId) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [openSectionId]);

  const progress = useMemo(() => treeProgress(tree), [tree]);

  const layout = useMemo(
    () =>
      layoutTree({
        chapters: tree.chapters.map((c) => ({ sectionCount: c.sections.length })),
        expanded,
      }),
    [tree.chapters, expanded],
  );

  /*
   * 当前打开的小节。用 id 找而不是存索引 ——
   * 重规划后索引会错位，id 对不上就自然关掉详情，不会把 A 的
   * 任务状态显示成 B 的。
   */
  const openSection = useMemo(() => {
    if (!openSectionId) return null;
    for (let i = 0; i < tree.chapters.length; i += 1) {
      const ch = tree.chapters[i]!;
      const found = ch.sections.find((s) => s.id === openSectionId);
      if (found) return { chapter: ch, chapterIndex: i, section: found };
    }
    return null;
  }, [tree.chapters, openSectionId]);

  /** 点章：展开它并聚焦；再点一次收起 */
  const toggleChapter = (index: number) => {
    setExpanded((cur) => {
      const next = cur === index ? null : index;
      /*
       * 收起/切换章时关掉详情：详情属于被收起的那一章，
       * 留着会"悬空"（树上看不见它，但右边还开着）。
       */
      if (next !== cur) setOpenSectionId(null);
      return next;
    });
  };

  /**
   * 章节点的键盘操作。
   *
   * ## 为什么需要它
   *
   * 这些节点是 `<button>`，Tab 能到、Enter/Space 由浏览器原生触发 click
   * （展开/收起已经能用）。但**方向键不行** —— 而树控件的用户
   * 会习惯用上下键在章之间走、左右键展开收起。
   *
   * ## 为什么不是完整的 roving tabindex
   *
   * APG 的 treeview 规范要求整棵树只有一个 tab 停靠点、用方向键移动
   * 焦点。那是完整实现，成本在于要把焦点状态提升成受控的、并且
   * 维护 `tabIndex={-1}` 的整套逻辑。
   *
   * 这里做**增量**：保留原生 Tab（每个章都能 Tab 到，简单可靠、
   * 对新手更友好），额外加方向键。上下键在章之间移动焦点，
   * 左右键等价于收起/展开。
   *
   * 这样两个方向都更安全：用鼠标的人什么都不变，
   * 用键盘的人不用 Tab 三十次才能到最后一章。
   */
  const onChapterKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const btns = e.currentTarget
      .closest('.rtree__canvas')
      ?.querySelectorAll<HTMLButtonElement>('.rtree__node--chapter');

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!btns) return;
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? index + 1 : index - 1;
        /* 到头就绕回去 —— 比"卡住不动"更容易理解 */
        const wrap = next < 0 ? btns.length - 1 : next >= btns.length ? 0 : next;
        btns[wrap]?.focus();
        break;
      }
      case 'ArrowRight': {
        /* 右 = 展开（已展开则不动） */
        if (expanded !== index) {
          e.preventDefault();
          setExpanded(index);
          setOpenSectionId(null);
        }
        break;
      }
      case 'ArrowLeft': {
        /* 左 = 收起（已收起则不动） */
        if (expanded === index) {
          e.preventDefault();
          setExpanded(null);
          setOpenSectionId(null);
        }
        break;
      }
      default:
        break;
    }
  };

  const boxes = useMemo(() => {
    const m = new Map<string, TreeBox>();
    m.set(layout.root.key, layout.root);
    for (const b of layout.chapters) m.set(b.key, b);
    for (const b of layout.sections) m.set(b.key, b);
    return m;
  }, [layout]);

  const focused = expanded;
  /** 有聚焦时，其余章要淡出（方案 5.1） */
  const isDimmed = (i: number) => focused !== null && i !== focused;

  return (
    <section className="rtree">
      <header className="rtree__head">
        <h3 className="rtree__title">
          学习地图
          <span className="rtree__progress">
            {progress.chaptersDone} / {progress.chaptersTotal} 章
            <span className="rtree__progress-sub">
              {progress.sectionsDone} / {progress.sectionsTotal} 小节
            </span>
          </span>
        </h3>
        <p className="rtree__lead">
          <b>{tree.subject}</b>
          {tree.edition ? `（${tree.edition}）` : ''} · 从资料长出章，再从章长出小节。
          点一章聚焦看它的小节；各章可以并行，不按顺序。
          {tree.usedSearch ? <span className="rtree__tag">规划时联网过</span> : null}
        </p>
        {focused !== null ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm rtree__unfocus"
            onClick={() => {
              setExpanded(null);
              setOpenSectionId(null);
            }}
          >
            退出聚焦，看全部章节
          </button>
        ) : null}
      </header>

      {/* ==================== 树 ==================== */}
      <div
        className="rtree__canvas"
        /*
         * 内联宽度/高度必须来自 layout，不能交给 CSS：
         * SVG 的 viewBox 与卡片坐标用的是同一套数字。
         */
        style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
      >
        <svg
          className="rtree__wires"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          {layout.edges.map((e) => {
            /*
             * 线的淡出规则：
             *  - 章→小节：只有展开那一章的亮（其余章根本没画这些线）
             *  - 根→章：连到非聚焦章的线要淡（原来漏了这条 ——
             *    只淡节点会让根→其它章的线仍然全亮）
             */
            const dimmed =
              focused !== null &&
              (e.kind === 'root-chapter'
                ? e.to !== layout.chapters[focused]?.key
                : false);

            return (
              <path
                key={e.key}
                className={
                  'rtree__wire rtree__wire--' +
                  (e.kind === 'root-chapter' ? 'trunk' : 'branch') +
                  (e.kind === 'chapter-section' && focused !== null ? ' rtree__wire--active' : '') +
                  (dimmed ? ' rtree__wire--dim' : '')
                }
                d={e.d}
                fill="none"
              />
            );
          })}
        </svg>

        {/* ---------- 资料根节点 ---------- */}
        <div
          className="rtree__node rtree__node--root"
          style={boxStyle(layout.root)}
          title={tree.subject}
        >
          <span className="rtree__root-label">资料</span>
          <span className="rtree__root-title">{shortTitle(tree.subject, 12)}</span>
        </div>

        {/* ---------- 章 ---------- */}
        {tree.chapters.map((ch, i) => {
          const box = boxes.get(layout.chapters[i]!.key)!;
          const p = chapterProgress(ch);
          const note = prereqNote(ch, tree.chapters);
          const isOpen = expanded === i;
          return (
            <button
              key={`ch-${i}`}
              type="button"
              className={
                'rtree__node rtree__node--chapter' +
                (isOpen ? ' rtree__node--open' : '') +
                /* 全部完成给一个视觉标记，一眼看出哪章收尾了 */
                (p.total > 0 && p.done === p.total ? ' rtree__node--done' : '') +
                (isDimmed(i) ? ' rtree__node--dim' : '')
              }
              style={boxStyle(box)}
              onClick={() => toggleChapter(i)}
              onKeyDown={(e) => onChapterKeyDown(e, i)}
              aria-expanded={isOpen}
              /* ⚠️ 绝不因为"有前置未完成"而 disabled —— 用户要求可并行 */
              title={`第 ${ch.number || '—'} 章 ${ch.title}`}
            >
              <span className="rtree__ch-top">
                <span className="rtree__ch-num">{ch.number || '·'}</span>
                <span className="rtree__ch-title">{shortTitle(ch.title, 13)}</span>
                {ch.difficulty !== null ? (
                  <span className="rtree__diff" title={`难度 ${ch.difficulty}/5`}>
                    {ch.difficulty}
                  </span>
                ) : null}
              </span>

              <span className="rtree__ch-meta">
                {p.total > 0 ? (
                  <>
                    {p.done} / {p.total} 小节完成
                    {p.done === p.total ? ' ✓' : ''}
                  </>
                ) : (
                  /* 没有小节节点是坏数据；如实说，不显示 0/0 */
                  '没有小节'
                )}
              </span>

              {note ? (
                <span className="rtree__prereq" title={note.text}>
                  {shortTitle(note.text, 22)}
                </span>
              ) : null}
            </button>
          );
        })}

        {/* ---------- 小节（只在展开那一章的右侧） ---------- */}
        {expanded !== null
          ? (tree.chapters[expanded]?.sections ?? []).map((sec, j) => {
              const box = boxes.get(layout.sections[j]!.key);
              if (!box) return null;
              const done = isSectionDone(sec);
              const isOpenSec = openSectionId === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  className={
                    'rtree__node rtree__node--section' +
                    (done ? ' rtree__node--done' : '') +
                    (isOpenSec ? ' rtree__node--sel' : '')
                  }
                  style={boxStyle(box)}
                  onClick={() =>
                    setOpenSectionId((cur) => (cur === sec.id ? null : sec.id))
                  }
                  aria-pressed={isOpenSec}
                  title={sec.title}
                >
                  <span className="rtree__sec-mark" aria-hidden="true">
                    {done ? '✓' : '○'}
                  </span>
                  <span className="rtree__sec-title">{shortTitle(sec.title, 16)}</span>
                  {/* 整章退化时如实标出来，别让它看起来像真小节 */}
                  {sec.origin === 'whole-chapter' ? (
                    <span className="rtree__sec-origin">整章</span>
                  ) : null}
                </button>
              );
            })
          : null}
      </div>

      {/* ==================== 折叠时的提示 ==================== */}
      {expanded === null ? (
        <p className="rtree__hint">
          点任意一章展开它的小节。默认折叠，因为一次看 30 个小节会看不清结构。
        </p>
      ) : null}

      {/* ==================== 小节详情 ==================== */}
      {openSection ? (
        <div ref={detailRef}>
          <SectionDetail
            section={openSection.section}
            chapter={openSection.chapter}
            {...(sectionStats?.get(openSection.section.id)
              ? { stats: sectionStats.get(openSection.section.id)! }
              : {})}
            {...(onTasksChange ? { onTasksChange } : {})}
            {...(onGoFlashcards ? { onGoFlashcards } : {})}
            {...(onGoPractice ? { onGoPractice } : {})}
            {...(sourceId ? { sourceId } : {})}
            {...(resources
              ? { resources: resources.filter((r) => r.sectionId === openSection.section.id) }
              : {})}
            {...(onAddResource ? { onAddResource } : {})}
            {...(onRemoveResource ? { onRemoveResource } : {})}
            {...(bindingData
              ? {
                  bindings: {
                    cardIds: openSection.section.tasks.boundFlashcardIds ?? [],
                    deckIds: openSection.section.tasks.boundDeckIds ?? [],
                    availableCards: bindingData.availableCards,
                    availableDecks: bindingData.availableDecks,
                    onChange: (next: { cardIds: string[]; deckIds: string[] }) =>
                      bindingData.onChange(openSection.section.id, next),
                  },
                }
              : {})}
            {...(bindingData?.onAskAi
              ? { onAskAiBind: () => bindingData.onAskAi!(openSection.section.id) }
              : {})}
            {...(bindingData?.aiBusySectionId === openSection.section.id
              ? { aiBindBusy: true }
              : {})}
            {...(bindingData?.onGenerateCards
              ? {
                  onGenerateCards: () =>
                    bindingData.onGenerateCards!(openSection.section.id),
                }
              : {})}
            {...(bindingData?.generatingSectionId === openSection.section.id
              ? { generateCardsBusy: true }
              : {})}
            onClose={() => setOpenSectionId(null)}
          />
        </div>
      ) : null}

      {/* ==================== 资料外的部分（如实告知） ==================== */}
      {tree.beyond.length > 0 ? (
        <div className="rtree__beyond">
          <p className="rtree__beyond-title">
            按学科常规还有这些，但<b>这份资料里没有</b>：
          </p>
          <ul className="rtree__beyond-list">
            {tree.beyond.map((b, i) => (
              <li key={`${b.title}-${i}`} className="rtree__beyond-item">
                <span className="rtree__beyond-name">{b.title}</span>
                {b.note ? <span className="rtree__beyond-note">{b.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 越界被丢掉时如实说明 */}
      {tree.droppedOutOfScope > 0 ? (
        <p className="rtree__dropped">
          规划时 AI 排了 {tree.droppedOutOfScope} 步超出这份资料的范围，已丢弃 ——
          地图只覆盖资料里真有的内容。
        </p>
      ) : null}

      {/*
        * ⚠️ 按钮文案 2026-11-22 下午改过一次。
        *
        * 原来写「重新规划」「清除这条路线」—— 那是"路线"时代的措辞。
        * 现在这一段是**整张地图**：重建会重排章节结构（新旧小节对不上，
        * 旧的勾选状态只能一起丢），所以必须说清代价，不能让人以为
        * 只是"刷新一下"。
        *
        * `onClear` 是**删除整张地图**（含所有勾选与自定义任务），
        * 属于破坏性操作 —— 调用方（MapTreePage）负责确认与文案。
        */}
      <div className="rtree__actions">
        <button type="button" className="btn-ghost" onClick={onReplan} disabled={busy}>
          {busy ? '正在重建…' : '重新生成这张地图'}
        </button>
        <button type="button" className="btn-ghost" onClick={onClear} disabled={busy}>
          删除这张地图
        </button>
      </div>
      <p className="rtree__actions-hint">
        重新生成会按资料重排章节，这一节上勾过的任务会一起清掉；删除会把整张地图去掉（资料本身不动）。
      </p>
    </section>
  );
}

/**
 * 把布局盒子转成内联样式。
 *
 * ⚠️ 这里是"几何只有一个来源"的落点：宽高只从这里来，
 * CSS 里不许再写 `.rtree__node--chapter { width: … }`。
 */
function boxStyle(b: TreeBox): Record<string, string> {
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  };
}

/** 供验证脚本与测试用：卡片尺寸的唯一来源 */
export const TREE_NODE_SIZE = TREE_METRICS;