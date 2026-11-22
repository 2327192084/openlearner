/**
 * 学习地图 —— 把题库按「资料 → 章节」摊开，回答「我哪块不行」。
 *
 * ## 为什么替换掉原来的「学习流」（2026-11-07 用户拍板）
 *
 * 原学习流按**一份资料**排五步进度（导入→正文→知识点→出题→练过），
 * 回答的是「这份资料走到哪一步」。用户的原话是「感觉不是很有用」——
 * 因为那五步走完一次就永远全绿，之后打开这一页没有任何新信息。
 *
 * 换成 StudyHub 的 study-map 思路：**跨所有资料**摊开掌握度，
 * 按章节给出「练过几道 / 掌握到什么程度 / 有几道到期 / 错了几道」，
 * 最弱的排最前面。这样每次打开都有东西可看。
 *
 * 来源：https://github.com/EricWang1358/dsh-web-studyhub
 *   - `ui/study-map/map-model.js`：`mergeProgress()` 按题数加权合并掌握度；
 *     `readExpanded` / `writeExpanded` 用 localStorage 记住折叠状态
 *   - `ui/study-map/DeckTree.jsx`：可折叠的 资料 → 主题 两级树
 *   - `ui/study-map/MasteryBar.jsx`：每行一条掌握度条
 *
 * ## 和 StudyHub 的差异（照搬前必须想清楚的部分）
 *
 * StudyHub 的树是「课程 → 题组 → 主题」，我们的是「资料 → 章节」。
 * 为什么不用它的三层：它的顶层是**课程文件夹**，而我们的 `courses` 分区
 * 目前是空的（实测 0 门课），拿一个空的概念做顶层只会让整棵树只剩一层。
 * 「资料」是我们真有、且用户认得的维度。
 *
 * ## 折叠状态存哪
 *
 * StudyHub 存 localStorage。这里也存 localStorage —— 它只影响界面展开，
 * 不是学习数据，进备份没有意义，也不该占 IndexedDB 一张表。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { mapLabel, weakestChapter, type MapGroup, type MapSource } from '@/v2/core/study-map.ts';
import { RoutePlanner } from './RoutePlanner.tsx';
import { RouteTree } from './RouteTree.tsx';
import type { CardLoader } from './cards-loader.ts';
import { buildSnapshot, type StudySnapshot } from './study-snapshot.ts';

export interface MapPageProps {
  reviewService: ReviewService;
  loadCards: CardLoader;
  decks: DeckService;
  knowledge: KnowledgeService;
  sourceService: SourceService;
  /** 去「开始做题」 */
  onOpenPractice: () => void;
  /** 去错题页 */
  onOpenWrongBook: () => void;
  /** 去资料页 */
  onOpenSources: () => void;
  /** 去「我的题组」 */
  onOpenDecks: () => void;
  /**
   * 进来时展开并滚动到这一份资料（2026-11-13 深夜）。
   *
   * 首页「题组进度」那一块的每一行都要能点进来，
   * 且应该**落到那一份资料上**，而不是又停在页面顶部让用户自己找。
   *
   * 值变化时生效（同一份资料再点一次也应当重新滚过去），
   * 所以传的是一个带计数 or 每次新建的对象不合适 —— 用 sourceId + token。
   */
  focusSourceId?: string | null;
  /** 每次点首页那一行都递增，让「同一份资料再点一次」也能重新定位 */
  focusToken?: number;
  /**
   * 学习路线（2026-11-21 整合进来）。
   *
   * ## 为什么并进学习地图，不单独一页
   *
   * 用户原话：「不用单独做个学习顺序的栏，可以把它整合进学习地图里。
   * 可以以杀戮尖塔那种爬塔式的方式做 ui，只不过是横板的，
   * 这样更符合『地图』的概念。」
   *
   * 所以这一页现在回答两个问题，上下两块：
   *  - 上半（原有）：按「资料 → 章节」摊开掌握度 —— 我哪块弱
   *  - 下半（新增）：横板爬塔路线 —— 我按什么顺序学、推到第几步
   *
   * 两块共用同一份 `buildSnapshot` 数据，不重复读库。
   *
   * 为 null 且没有 `aiPlan` 时不显示那一块（不摆空占位）。
   */
  route?: {
    /** 已确认的**资料级**路线（2026-11-21 深夜换成资料本体口径） */
    sourceRoute: import('@/core/ai/source-route.ts').SourceRoute | null;
    /** AI 接线（读凭据、发请求都在 App） */
    ai: import('./RoutePlanner.tsx').RouteAi;
    sourceService: import('@/core/sources.ts').SourceService;
    /** 读搜索 API Key；null = 没配 */
    readSearchKey: () => Promise<string | null>;
    onSaved: (route: import('@/core/ai/source-route.ts').SourceRoute) => Promise<void>;
    onClearSaved: () => Promise<void>;
    /** 去「文档解析」补解析 */
    onOpenParse: () => void;
    /**
     * 每章覆盖度（横板地图的进度依据，2026-11-21 深夜补）。
     *
     * 章号 → { 段数, 已出题的段数 }。没有就不显示进度 ——
     * 「这一章学完了吗」在数据里没有答案，不猜。
     */
    coverageByChapter?: ReadonlyMap<number, { segments: number; withQuestions: number }>;
    /** 题目的锚点还有效吗 */
    anchorHealth?: { total: number; resolved: number };
    /** 点横板上某一步 */
    onStep?: (step: import('@/core/ai/source-route.ts').RouteStep) => void;
    /**
     * 树状地图的数据（2026-11-22，学习地图第三次重做）。
     *
     * ## 为什么是"要么有树、要么有原因"，不摆空壳
     *
     * 上一轮的错误是"换实现只做了一半"：数据有了、图没了，断言还绿。
     * 所以这里把「树」与「为什么没有树」分开传 ——
     * 有树就画树，没树但有原因就如实说，两样都没有才退回横板。
     */
    tree?: {
      tree: import('@/v2/core/source-tree.ts').SourceTree;
      stats: ReadonlyMap<string, import('./section-stats.ts').SectionStats>;
    } | null;
    /** 为什么没有树（资料被删 / 读失败） */
    treeError?: string | null;
    /** 改小节任务状态 */
    onTasksChange?: (
      sectionId: string,
      next: import('@/v2/core/source-tree.ts').SectionNode['tasks'],
    ) => void;
    /** 去闪卡页 */
    onGoFlashcards?: (section: import('@/v2/core/source-tree.ts').SectionNode) => void;
    /** 去做题页 */
    onGoPractice?: (section: import('@/v2/core/source-tree.ts').SectionNode) => void;
    /** 请求重新规划（树上的「重新规划」按钮）；不给就只是不响应 */
    onReplanRequest?: () => void;
  } | null;
}

const STORAGE_KEY = 'openleaner.study-map.open';

/** 折叠状态：默认全展开（资料不多时展开信息量更大，StudyHub 也是这个策略） */
function readOpen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : null;
  } catch {
    return null; // 存不进去/读不出来都不该影响这一页能用
  }
}

function writeOpen(open: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...open]));
  } catch {
    /* 隐私模式等场景写不进去，忽略：只是下次不记得展开状态 */
  }
}

export function MapPage({
  reviewService,
  loadCards,
  decks,
  knowledge,
  sourceService,
  onOpenPractice,
  onOpenWrongBook,
  onOpenSources,
  onOpenDecks,
  focusSourceId,
  focusToken,
  route,
}: MapPageProps) {
  const [snap, setSnap] = useState<StudySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 只显示有到期的 */
  const [onlyDue, setOnlyDue] = useState(false);


  /*
   * 折叠状态。
   *
   * `null` 表示「用户从没手动折叠过」—— 这时应该**全展开**：
   * 首次进来就把章节摊开，用户一眼看到分到了哪几章；
   * 全收起的空树看起来像「这一页没内容」。
   * StudyHub 的 defaultExpanded 也是这个策略（资料不多时默认展开）。
   *
   * 用 null 而不是空 Set 当初始值，是因为空 Set 同时代表
   * 「用户手动全收起了」和「从没设过」，两者不该同一种表现。
   */
  const [open, setOpen] = useState<Set<string> | null>(() => readOpen());

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const sources = await sourceService.list();
      const titleById = new Map(sources.map((s) => [s.id, s.title]));

      const s = await buildSnapshot({
        loadCards,
        decks,
        knowledge,
        reviewService,
        sourceTitleOf: (id) => titleById.get(id) ?? null,
        today,
      });
      setSnap(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出学习地图');
    }
  }, [reviewService, loadCards, decks, knowledge, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 从首页「题组进度」点进来时，落到那一份资料上（2026-11-13 深夜）。
   *
   * 用户要求「点了直接跳到对应的地方，不用再从功能栏打开」。
   * 只把页面切过来还不够 —— 资料一多，用户还得自己在树上找那一行，
   * 那和从侧栏进来没有区别。所以这里两步：
   *
   * 1. 把它**展开**（若当前是收起的，展开后才有章节可看）
   * 2. `scrollIntoView`，让它出现在视口里
   *
   * 依赖里带 focusToken：同一份资料再点一次也要重新滚过去
   * （否则第二次点没反应，用户会以为没生效）。
   */
  useEffect(() => {
    if (!focusSourceId) return;
    const key = `source:${focusSourceId}`;
    setOpen((prev) => {
      const base = prev ?? new Set(snap ? snap.map.sources.map((s) => s.key) : []);
      if (base.has(key)) return base;
      const next = new Set(base);
      next.add(key);
      return next;
    });
    /*
     * 等两帧再滚：展开是异步渲染的，立刻 scrollIntoView 会滚到一个
     * 还没撑开的高度上（表现为滚到一半就停）。
     *
     * 两帧而不是一帧：一帧时刚 setOpen 的重渲染可能还没提交，
     * 高亮节点尚未进 DOM。与错题页用的是同一套做法。
     */
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.querySelector('.map-src--focus');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    /*
     * `snap` 必须在依赖里：学习地图是**异步读出来的**，首次渲染时 snap 还是
     * null，上面 `snap ? … : []` 会退化成空集合。数据到了若 effect 不再跑，
     * 定位就落空（错题页第一版正是漏了这个，验证脚本抓到了）。
     */
  }, [focusSourceId, focusToken, snap]);

  /**
   * 当前是否展开。
   *
   * `open === null`（从没设过）时，按「全展开」对待 ——
   * 这样第一次进来就能直接看到章节分布，而不是一个全收起的空壳。
   */
  const isOpen = useCallback(
    (key: string) => (open === null ? true : open.has(key)),
    [open],
  );

  function toggle(key: string) {
    setOpen((prev) => {
      /*
       * 首次点击时 `prev` 是 null（= 当前全展开），
       * 所以要先按「全展开」建出实际的集合，再把这一个收起来。
       * 直接 new Set(null) 会得到空集合 —— 一次点击就把全部折叠掉。
       */
      const base =
        prev ?? new Set(snap ? snap.map.sources.map((s) => s.key) : []);
      const next = new Set(base);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeOpen(next);
      return next;
    });
  }

  const visible = useMemo(() => {
    if (!snap) return [];
    if (!onlyDue) return snap.map.sources;
    return snap.map.sources
      .map((s) => ({ ...s, chapters: s.chapters.filter((c) => c.due > 0) }))
      .filter((s) => s.chapters.length > 0);
  }, [snap, onlyDue]);


  if (error) {
    return (
      <div className="map-page">
        <h1 className="map-title">学习地图</h1>
        <p className="map-error">{error}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="map-page">
        <h1 className="map-title">学习地图</h1>
        <p className="map-hint">正在读题库…</p>
      </div>
    );
  }

  const { all } = snap.map;
  const weakest = weakestChapter(snap.map);

  if (all.total === 0) {
    return (
      <div className="map-page">
        <header className="map-head">
          <h1 className="map-title">学习地图</h1>
          <p className="map-lead">
            这里把题库按「资料 → 章节」摊开，看清哪一块练得少、哪一块最容易错。
          </p>
        </header>
        <div className="map-empty">
          <p>题库里还没有已发布的题。</p>
          <p className="map-hint">先在「我的题组」里出一组并发布，之后这里会按章节铺开。</p>
          <button type="button" className="btn-ghost" onClick={onOpenDecks}>
            我的题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="map-page">
      <header className="map-head">
        <h1 className="map-title">学习地图</h1>
        <p className="map-lead">
          把题库按「资料 → 章节」摊开。掌握度低的排前面 —— 上面几行就是最该补的地方。
        </p>
      </header>

      {/* ---------- 全库概览 ---------- */}
      <div className="map-stats">
        <span className="map-stat">
          <span className="map-stat__n">{all.total}</span>
          <span className="map-stat__label">道题</span>
        </span>
        <span className="map-stat">
          <span className="map-stat__n">{all.learned}</span>
          <span className="map-stat__label">练过</span>
        </span>
        <span className={`map-stat${all.due > 0 ? ' map-stat--warn' : ''}`}>
          <span className="map-stat__n">{all.due}</span>
          <span className="map-stat__label">今天到期</span>
        </span>
        <span className={`map-stat${all.wrong > 0 ? ' map-stat--bad' : ''}`}>
          <span className="map-stat__n">{all.wrong}</span>
          <span className="map-stat__label">错着</span>
        </span>
        <span className="map-stat">
          <span className="map-stat__n">{mapLabel(all.mastery, all.learned > 0, all.wrong > 0)}</span>
          <span className="map-stat__label">整体掌握</span>
        </span>
      </div>

      {weakest ? (
        <p className="map-weak">
          最该补的是 <strong>{weakest.chapter.title}</strong>
          （{mapLabel(weakest.chapter.mastery, weakest.chapter.learned > 0, weakest.chapter.wrong > 0)}，
          {weakest.chapter.learned > 0
            ? `${weakest.chapter.learned}/${weakest.chapter.total} 道练过`
            : `还没开始，共 ${weakest.chapter.total} 道题`}
          ）
        </p>
      ) : null}

      {/* ==================== 学习路线（依据资料本体，2026-11-21 深夜） ==================== */}
      {/*
        * 用户改了口径：路线要「依据资料本体」而不是「依据知识点」。
        * 所以这里挂的是 `RoutePlanner`（选资料 → 确认科目 → 可选联网 → 生成），
        * 生成后的路线由它自己渲染（`SourceRouteView`）。
        *
        * 知识点级那套（`RouteMap` / `RoutePreviewDialog`）保留在代码里
        * 但不再上地图 —— 用户明确要的是资料级。
        */}
      {route ? (
        <>
          {/*
            * ==================== 树状地图（2026-11-22） ====================
            *
            * 用户第三次改方向：要「资料 → 章 → 小节」的树，点章聚焦，
            * 通过完成小节任务来完成章节。
            *
            * ⚠️ 树在上、规划表单在下：树是"我现在的地图"，
            * 表单是"我要重新排"。用户每次进页面先看到地图。
            */}
          {route.tree ? (
            <RouteTree
              tree={route.tree.tree}
              sectionStats={route.tree.stats}
              {...(route.onTasksChange ? { onTasksChange: route.onTasksChange } : {})}
              {...(route.onGoFlashcards ? { onGoFlashcards: route.onGoFlashcards } : {})}
              {...(route.onGoPractice ? { onGoPractice: route.onGoPractice } : {})}
              onReplan={() => {
                /* 重新规划 = 回到表单（不清掉已确认的，用户可能只是看看） */
                route.onReplanRequest?.();
              }}
              onClear={() => void route.onClearSaved()}
            />
          ) : route.treeError ? (
            /*
             * 有路线但长不出树 → 如实说明，不摆空壳。
             * 这时**仍然显示横板**（旧视图），因为路线本身还在。
             */
            <p className="map-error">{route.treeError}</p>
          ) : null}

          <RoutePlanner
            sourceService={route.sourceService}
            ai={route.ai}
            readSearchKey={route.readSearchKey}
            onSaved={route.onSaved}
            onOpenParse={route.onOpenParse}
            saved={route.sourceRoute}
            onClearSaved={route.onClearSaved}
            {...(route.coverageByChapter ? { coverageByChapter: route.coverageByChapter } : {})}
            {...(route.anchorHealth ? { anchorHealth: route.anchorHealth } : {})}
            {...(route.onStep ? { onStep: route.onStep } : {})}
          />
        </>
      ) : null}

      {/* ---------- 工具条 ---------- */}
      <div className="map-toolbar">
        <label className="map-check">
          <input
            type="checkbox"
            checked={onlyDue}
            onChange={(e) => setOnlyDue(e.target.checked)}
          />
          只看今天到期的
        </label>
        <div className="map-toolbar__actions">
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={onOpenWrongBook}>
            错题与待巩固
          </button>
          <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenPractice}>
            开始做题
          </button>
        </div>
      </div>

      {/* ---------- 树 ---------- */}
      {visible.length === 0 ? (
        <p className="map-hint">
          {onlyDue ? '今天没有到期的题。' : '没有可显示的内容。'}
          {onlyDue ? (
            <button type="button" className="btn-text" onClick={() => setOnlyDue(false)}>
              看全部
            </button>
          ) : null}
        </p>
      ) : (
        <ul className="map-tree">
          {visible.map((s) => (
            <SourceNode
              key={s.key}
              source={s}
              open={isOpen(s.key)}
              onToggle={() => toggle(s.key)}
              /* 首页点进来的那一份：加高亮，让用户一眼看到「就是这条」 */
              highlighted={!!focusSourceId && s.sourceId === focusSourceId}
            />
          ))}
        </ul>
      )}

      <p className="map-foot">
        掌握度按「复习间隔 + 正确率 + 连续答对」算，不是单纯数做对几次。
        <button type="button" className="btn-text" onClick={onOpenSources}>
          看资料
        </button>
      </p>
    </div>
  );
}

/** 一份资料（可折叠） */
function SourceNode({
  source,
  open,
  onToggle,
  highlighted = false,
}: {
  source: MapSource;
  open: boolean;
  onToggle: () => void;
  /** 是否是「从首页点进来的那一份」—— 加一个高亮，用户才知道落对地方了 */
  highlighted?: boolean;
}) {
  return (
    <li className={`map-src${highlighted ? ' map-src--focus' : ''}`}>
      <button
        type="button"
        className="map-src__head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={`map-caret${open ? ' map-caret--open' : ''}`} aria-hidden="true" />
        <span className="map-src__title">{source.title}</span>
        <span className="map-src__count">{source.total} 道</span>
        <Bar group={source} />
      </button>

      {open ? (
        <ul className="map-chapters">
          {source.chapters.map((ch) => (
            <li key={ch.key} className="map-ch">
              <span className="map-ch__title">{ch.title}</span>
              <Bar group={ch} />
              <span className="map-ch__meta">
                {ch.learned}/{ch.total} 练过
                {ch.due > 0 ? ` · ${ch.due} 到期` : ''}
                {ch.wrong > 0 ? ` · ${ch.wrong} 错着` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 一条掌握度条 + 档位文字 */
function Bar({ group }: { group: MapGroup }) {
  const decided = group.learned > 0;
  return (
    <span className="map-bar-wrap">
      <span className="map-bar" aria-hidden="true">
        <span
          className={`map-bar__fill${!decided ? ' map-bar__fill--empty' : ''}`}
          style={{ width: `${Math.round(group.mastery * 100)}%` }}
        />
      </span>
      <span
        className={`map-bar__pct${!decided ? ' map-bar__pct--zero' : ''}${
          decided && group.wrong > 0 && group.mastery === 0 ? ' map-bar__pct--bad' : ''
        }`}
      >
        {mapLabel(group.mastery, decided, group.wrong > 0)}
      </span>
    </span>
  );
}
