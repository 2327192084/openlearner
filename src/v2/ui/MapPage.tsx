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
import { RouteMap } from './RouteMap.tsx';
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
    /** 已确认的路线；null = 还没排过 */
    plan: import('../core/study-plan-store.ts').StudyPlan | null;
    /** 排路线用的输入（App 用同一份快照算好，这里不重算） */
    points: import('@/core/ai/plan-order.ts').PlanPointInput[];
    /** 知识点 id → 原始记录（显示陈述、跳转用） */
    pointById: ReadonlyMap<string, import('@/core/model.ts').KnowledgePoint>;
    /** 让 AI 排/重排。抛错表示失败（界面显示真实原因） */
    onGenerate: () => Promise<void>;
    /** 清除路线 */
    onClear: () => Promise<void>;
    /** 点某个关卡：去练它 */
    onStep: (pointId: string) => void;
    /**
     * 让 AI 推断缺失的章节（用户确认的第②点：先补章节再排序）。
     *
     * 返回预览（**不写库**）—— 用户逐条勾选后才写。
     * 没有缺章节时返回 `changes: []`。
     */
    onSuggestChapters: () => Promise<import('@/core/ai/chapter-backfill.ts').ChapterPreview>;
    /** 写入用户勾选的章节 */
    onApplyChapters: (picks: { pointId: string; chapter: string }[]) => Promise<number>;
    /** 缺章节的条数（0 = 不显示补章节入口） */
    missingChapter: number;
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

  /* ---------- 学习路线（2026-11-21 整合进来） ---------- */
  /** 正在调 AI 排 */
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeErr, setRouteErr] = useState<string | null>(null);

  /**
   * 排路线的入口。
   *
   * `route.onGenerate` 负责「调 AI + 落库」（在 App 里，那里有后端凭据）。
   * 这里只管按钮状态与错误显示 —— 与 `onAiCompose` 同一分工。
   */
  const runRouteGenerate = useCallback(async () => {
    if (!route) return;
    setRouteBusy(true);
    setRouteErr(null);
    try {
      await route.onGenerate();
    } catch (e) {
      /* 真实原因抛上来就原样显示，不吞成一句「AI 没给出结果」 */
      setRouteErr(e instanceof Error ? e.message : 'AI 没有返回结果');
    } finally {
      setRouteBusy(false);
    }
  }, [route]);

  const runRouteClear = useCallback(async () => {
    if (!route) return;
    setRouteBusy(true);
    setRouteErr(null);
    try {
      await route.onClear();
    } catch (e) {
      setRouteErr(e instanceof Error ? e.message : '清除路线失败');
    } finally {
      setRouteBusy(false);
    }
  }, [route]);

  /* ---------- 补缺失章节（用户确认的第②点） ---------- */
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterErr, setChapterErr] = useState<string | null>(null);
  const [chapterPreview, setChapterPreview] = useState<
    import('@/core/ai/chapter-backfill.ts').ChapterPreview | null
  >(null);

  const runChapterSuggest = useCallback(async () => {
    if (!route) return;
    setChapterBusy(true);
    setChapterErr(null);
    try {
      const preview = await route.onSuggestChapters();
      setChapterPreview(preview);
    } catch (e) {
      setChapterErr(e instanceof Error ? e.message : 'AI 没有返回结果');
    } finally {
      setChapterBusy(false);
    }
  }, [route]);

  const runChapterApply = useCallback(
    async (picks: { pointId: string; chapter: string }[]) => {
      if (!route) return;
      setChapterBusy(true);
      setChapterErr(null);
      try {
        await route.onApplyChapters(picks);
        setChapterPreview(null);
      } catch (e) {
        setChapterErr(e instanceof Error ? e.message : '写入章节失败');
      } finally {
        setChapterBusy(false);
      }
    },
    [route],
  );

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

  /**
   * 知识点 id → 掌握度（横板路线用）。
   *
   * 为什么从 `route.points` 取而不是从 `snap`：
   * `snap` 是按**题目**算的（一道题一条进度），而路线走的是**知识点**。
   * 一个知识点可能挂着好几道题，`loadPlanInputs` 已经把「这个知识点
   * 自己作为卡片 + 引用它的题」合成了单一掌握度（取最好的那个）。
   * 两处各算一遍会出现「地图说熟练、路线说刚起步」。
   *
   * 没有 route 时返回空 Map —— 横板那一块不渲染，不影响上半部分。
   */
  const masteryByPoint = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of route?.points ?? []) m.set(p.id, p.mastery);
    return m;
  }, [route]);

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

      {/* ==================== 学习路线（横板爬塔，2026-11-21） ==================== */}
      {route ? (
        route.plan ? (
          <RouteMap
            plan={route.plan}
            pointById={route.pointById}
            masteryById={masteryByPoint}
            onStep={(step) => route.onStep(step.pointId)}
            onReplan={() => void runRouteGenerate()}
            onClear={() => void runRouteClear()}
            busy={routeBusy}
          />
        ) : (
          <RouteStarter
            pointCount={route.points.length}
            onGenerate={() => void runRouteGenerate()}
            busy={routeBusy}
            missingChapter={route.missingChapter}
            chapterBusy={chapterBusy}
            chapterPreview={chapterPreview}
            chapterErr={chapterErr}
            onSuggestChapters={() => void runChapterSuggest()}
            onApplyChapters={(picks) => void runChapterApply(picks)}
          />
        )
      ) : null}
      {routeErr ? <p className="map-error">{routeErr}</p> : null}

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

/**
 * 还没排过路线时的入口（2026-11-21）。
 *
 * ## 为什么需要它
 *
 * 学习地图原来只回答「我哪块弱」。加上「按什么顺序学」之后，
 * 用户第一次进来会看到这一块是空的 —— 得有一个明确的地方让他开始。
 *
 * ## 为什么不让它自动调 AI
 *
 * 打开一页就自动发一次 AI 请求，用户会莫名其妙被扣 token，
 * 而且他可能只是来瞄一眼掌握度。**必点才调**（与挑闪卡、AI 组卷一致）。
 *
 * ## 为什么说明里要写「AI 会看什么」
 *
 * 用户不知道 AI 凭什么排。写清「知识点表述 + 章节 + 你的掌握度」
 * 之后，如果结果不合理，他知道该去补章节而不是怀疑功能坏了。
 */
function RouteStarter(props: {
  pointCount: number;
  onGenerate: () => void;
  busy: boolean;
  missingChapter: number;
  chapterBusy: boolean;
  chapterPreview: import('@/core/ai/chapter-backfill.ts').ChapterPreview | null;
  chapterErr: string | null;
  onSuggestChapters: () => void;
  onApplyChapters: (picks: { pointId: string; chapter: string }[]) => void;
}) {
  const {
    pointCount,
    onGenerate,
    busy,
    missingChapter,
    chapterBusy,
    chapterPreview,
    chapterErr,
    onSuggestChapters,
    onApplyChapters,
  } = props;

  /* 补章节的勾选状态（默认只勾「沿用已有章节名」的，见下方说明） */
  const [picks, setPicks] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!chapterPreview) {
      setPicks(new Set());
      return;
    }
    /*
     * 默认只勾「沿用已有章节名」的（fromExisting）。
     * 新起的名字默认不勾 —— 那要用户自己判断它像不像他教材的章节。
     */
    setPicks(new Set(chapterPreview.changes.filter((c) => c.fromExisting).map((c) => c.pointId)));
  }, [chapterPreview]);

  return (
    <section className="rmap rmap--starter">
      <h2 className="rmap__title">学习路线</h2>
      <p className="rmap__lead">
        地图上半部分说「哪块弱」，这里回答另一个问题：
        <b>按什么顺序学、现在推到第几步</b>。
      </p>

      {/* ---------- 第一步（可选）：补缺失章节 ---------- */}
      {missingChapter > 0 && !chapterPreview ? (
        <div className="rmap__prep">
          <p className="rmap__lead">
            有 <b>{missingChapter}</b> 条知识点没有章节。补上能让排序更准
            （AI 要靠章节判断先修关系），但不补也能排 —— 只是它只能看表述。
          </p>
          <button
            type="button"
            className="btn-ghost"
            onClick={onSuggestChapters}
            disabled={chapterBusy}
          >
            {chapterBusy ? '正在让 AI 推断…' : '先让 AI 补缺失的章节（可选）'}
          </button>
          {chapterErr ? <p className="map-error">{chapterErr}</p> : null}
        </div>
      ) : null}

      {/* ---------- 补章节的预览（勾完才写库） ---------- */}
      {chapterPreview ? (
        <div className="rmap__chapter-review">
          <p className="rmap__lead">
            AI 给出 {chapterPreview.changes.length} 条建议，
            其中 {chapterPreview.changes.filter((c) => c.fromExisting).length} 条沿用了这份资料
            <b>已有的</b>章节名（更可信），其余是它推断的。
            {chapterPreview.dropped > 0 ? (
              <> 另有 {chapterPreview.dropped} 条它给的名字不像章节名，已丢弃。</>
            ) : null}
            {chapterPreview.untouched > 0 ? (
              <> 还有 {chapterPreview.untouched} 条它判不出来（没编，如实留空）。</>
            ) : null}
          </p>
          <ul className="rmap__chapter-list">
            {chapterPreview.changes.map((c) => (
              <li key={c.pointId} className="rmap__chapter-item">
                <label className="rmap__chapter-label">
                  <input
                    type="checkbox"
                    className="rmap__chapter-box"
                    checked={picks.has(c.pointId)}
                    onChange={() => {
                      setPicks((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.pointId)) next.delete(c.pointId);
                        else next.add(c.pointId);
                        return next;
                      });
                    }}
                    disabled={chapterBusy}
                  />
                  <span className="rmap__chapter-body">
                    <span className="rmap__chapter-stmt">{c.statement}</span>
                    <span className="rmap__chapter-change">
                      <span className="rmap__chapter-from">原本没有章节</span>
                      <span className="rmap__chapter-arrow">→</span>
                      <span className="rmap__chapter-to">{c.to}</span>
                      {!c.fromExisting ? (
                        <span
                          className="rmap__chapter-new"
                          title="这个章节名资料里原本没有，是 AI 推断的"
                        >
                          新起的名字
                        </span>
                      ) : null}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="rmap__actions">
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() =>
                onApplyChapters(
                  chapterPreview.changes
                    .filter((c) => picks.has(c.pointId))
                    .map((c) => ({ pointId: c.pointId, chapter: c.to })),
                )
              }
              disabled={chapterBusy || picks.size === 0}
            >
              {chapterBusy ? '正在写入…' : `写入勾选的 ${picks.size} 条章节`}
            </button>
          </div>
          {chapterErr ? <p className="map-error">{chapterErr}</p> : null}
        </div>
      ) : null}

      {/* ---------- 第二步：排学习路线 ---------- */}
      <p className="rmap__lead">
        排序需要知道「哪个概念是谁的前置」—— 那是学科知识，本地数据里没有，
        所以要问 AI。它会看这 {pointCount} 条知识点的表述、章节和你的掌握度，
        归成几块再排出先后，每条都给出难度和理由。排完先给你看，你勾了才存。
      </p>
      <button
        type="button"
        className="btn-fill btn-fill--sm"
        onClick={onGenerate}
        disabled={busy || pointCount === 0}
      >
        {busy ? '正在让 AI 排…' : '让 AI 排一条学习路线'}
      </button>
      {pointCount === 0 ? (
        <p className="map-hint">知识库里还没有知识点，先到「知识骨架」整理一批再来。</p>
      ) : null}
    </section>
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
