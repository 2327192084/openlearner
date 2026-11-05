import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
} from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import { TEXT_STATUS_LABEL } from '../sources/format.ts';
import type { GenerationRun, KnowledgePoint, Source, SourceSegment } from '@/core/model.ts';
import type { KnowledgeBackendSummary } from '@/core/knowledge/service.ts';
import { BackendCompare } from './BackendCompare.tsx';
import { GeneratePanel } from './GeneratePanel.tsx';
import { KnowledgeCard } from './KnowledgeCard.tsx';
import { SourcePane } from './SourcePane.tsx';
import {
  backendLabel,
  describeError,
  defaultBackendFilter,
  formatCount,
  pageCountLabel,
  sumBackends,
} from './types.ts';
import type { Flash, Load } from './types.ts';
import './knowledge.css';

/**
 * 知识点页（P2）：「AI 整理成知识点」+ 校对。
 *
 * 与资料页同一个结构思路（注册表只有一条 `/knowledge` 路由，加子路由要改
 * `core/registry.ts`，那是别人的域）：一个页面组件内部用状态切换视图。
 * 但这里**不做「列表页 / 详情页」切换** —— 校对要求左边原文、右边知识点同时可见，
 * 分屏是它的本质，不是一种可选布局。
 *
 * 页面分三层，自上而下：
 *   1. 选资料（下拉）—— 一次只处理一份（P2 的范围，core 的 GenerationRun 也是这么定的）
 *   2. 校对区（两栏）—— 左边原文高亮，右边知识点卡片
 *   3. 整理区（可折叠）—— 页码范围、预计用量、进度、停止、结果
 *
 * 为什么整理区放在下面且可折叠：有知识点之后，用户 90% 的时间在校对，
 * 一个常驻的大表单会把正文挤到需要滚动才能看见。但**没有知识点时必须展开**，
 * 否则新用户进来只看到一个空态，不知道下一步在哪。
 */

/** 一次生成的前端记忆，用于在盘点行里说明「这批是怎么来的」 */
type LastRun = GenerationRun;

export function KnowledgePage() {
  const { sources: sourceService, knowledge, backends: backendService } = useServices();

  // ---- 资料列表 ----
  const [sourcesState, setSourcesState] = useState<Load<Source[]>>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---- 选中资料的正文与知识点 ----
  const [segmentsState, setSegmentsState] = useState<Load<SourceSegment[]>>({ kind: 'loading' });
  const [pointsState, setPointsState] = useState<Load<KnowledgePoint[]>>({ kind: 'loading' });

  /**
   * 按后端分组的统计（P5 第 4 条）。
   *
   * 与 pointsState 分开存：pointsState 是「当前筛选后的列表」，
   * 而 chips 上要显示的是**全部后端**的数字。混在一个 state 里，
   * 一旦筛选到某一组，其他组的 chip 就会跟着消失。
   */
  const [backendsState, setBackendsState] = useState<Load<KnowledgeBackendSummary[]>>({
    kind: 'loading',
  });

  /** 当前筛选到的后端；null = 全部。默认取条数最多的那组 */
  const [backendFilter, setBackendFilter] = useState<string | null>(null);

  /**
   * backendId → 可读名字。
   *
   * 为什么要有这份映射：库里存的是 `backend_xxxx` 这种 id，直接显示是乱码级的体验。
   * 数据来源是设置页的后端配置列表（BackendService），与整理面板同源。
   * **映射不到时不能返回空串** —— 后端配置可能已经被删掉了，
   * 而它产出的知识点还在库里，空白 chip 会让人以为界面坏了。
   */
  const [backendLabels, setBackendLabels] = useState<Record<string, string>>({});

  /**
   * 页内提示条。
   *
   * 卡片里的写动作（删一条、标记无出处、重新指认）结果都汇总到这里：
   * 列表本身会变，但「刚才那一下到底成功了没有」需要一句明确的话，
   * 否则用户只能靠数卡片数量来确认，而重复条目看起来是一样的。
   */
  const [flash, setFlash] = useState<Flash>(null);

  // ---- 校对区状态 ----
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const [segmentIndex, setSegmentIndex] = useState(0);

  // ---- 整理区折叠 ----
  const [generateOpen, setGenerateOpen] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  /**
   * 整理面板当前选中的后端 id。
   *
   * 父组件需要它做两件事：
   *   - 在对比条上标「当前」，说明点重新整理会写哪一组；
   *   - 算出「当前后端已有 N 条」——core 只清这一个后端的结果，
   *     拿总条数去说会夸大影响范围（20 条里其实只清 12 条）。
   */
  const [currentBackendId, setCurrentBackendId] = useState('mock');

  const articleRef = useRef<HTMLDivElement | null>(null);

  /**
   * 当前选中资料的镜像。
   *
   * 用途只有一个：在异步回调里判断「这次结果还属于当前资料吗」。
   * 直接读 state 会拿到闭包里的过期值，而把它放进 useCallback 依赖
   * 又会让整个加载函数重建、触发多余的重新请求。
   */
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadSources = useCallback(async () => {
    setSourcesState({ kind: 'loading' });
    try {
      const list = await sourceService.list();
      setSourcesState({ kind: 'ready', data: list });
      // 只在还没有选择时自动选第一份，避免刷新列表把用户的选择挤掉
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      setSourcesState({
        kind: 'error',
        message: describeError(err),
        hint: '资料列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘是否已满。',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const sources = sourcesState.kind === 'ready' ? sourcesState.data : [];
  const selectedSource = useMemo(
    () => sources.find((s) => s.id === selectedId) ?? null,
    [sources, selectedId],
  );

  /**
   * 当前生效的筛选，同步镜像。
   *
   * 用 ref 而不是把 backendFilter 放进依赖：放进去的话，用户点一下 chip
   * 就会重建 reloadPoints → 重建 loadForSource → 触发整个资料重载，
   * 左栏被重置回第 1 页、当前选中的知识点被清空。
   * 切后端只是在看另一批条目，不该让阅读位置丢掉。
   */
  const filterRef = useRef<string | null>(null);
  /** 已经为哪份资料挑过「默认组」。换资料时重置，同资料内不要反复抢用户的筛选 */
  const filterInitFor = useRef<string | null>(null);

  /**
   * 读分组统计 + 按当前筛选取条目。
   *
   * 顺序不能反：默认筛选是「条数最多的那组」，那个决定依赖统计结果，
   * 所以必须先把统计拿到手，再决定取哪一份。
   */
  const loadPoints = useCallback(
    async (sourceId: string) => {
      const summaries = await knowledge.listBackends(sourceId);
      if (selectedIdRef.current !== sourceId) return;
      setBackendsState({ kind: 'ready', data: summaries });

      /*
       * 决定筛选：
       *  - 首次进入这份资料：≥2 个后端时默认选条数最多的那组（lead 的要求），
       *    只有 1 个后端时不筛 —— 一个选项的筛选器只是噪音。
       *  - 之后：用户选什么就是什么。
       *  - 但如果选的那组已经不存在了（重新整理把它清空了），退回「全部」，
       *    绝不让界面停在一个空列表上。
       */
      let filter = filterRef.current;
      if (filterInitFor.current !== sourceId) {
        filterInitFor.current = sourceId;
        filter = defaultBackendFilter(summaries);
        filterRef.current = filter;
        setBackendFilter(filter);
      } else if (filter !== null && !summaries.some((s) => s.backendId === filter)) {
        filter = null;
        filterRef.current = null;
        setBackendFilter(null);
      }

      const list = await knowledge.listBySourceAndBackend(sourceId, filter);
      if (selectedIdRef.current !== sourceId) return;
      setPointsState({ kind: 'ready', data: list });
      setActivePointId((prev) => (prev && list.some((p) => p.id === prev) ? prev : null));
    },
    [knowledge],
  );

  /** 刷新当前资料的知识点（卡片写动作、生成结束后用） */
  const reloadPoints = useCallback(async () => {
    if (!selectedId) {
      setPointsState({ kind: 'ready', data: [] });
      setBackendsState({ kind: 'ready', data: [] });
      return;
    }
    try {
      await loadPoints(selectedId);
    } catch (err) {
      setPointsState({
        kind: 'error',
        message: describeError(err),
        hint: '知识点没有改动。刷新页面重试；如果反复失败，可能是本地存储异常。',
      });
    }
  }, [selectedId, loadPoints]);

  /**
   * 切换后端筛选：只换列表，不动正文与阅读位置。
   *
   * 直接调 listBySourceAndBackend 而不是走 reloadPoints，
   * 是为了跳过「重新读统计 + 重挑默认组」那一段 —— 用户正在手动选，
   * 不该被自动逻辑再改回去。
   */
  const handleFilterSelect = useCallback(
    async (backendId: string | null) => {
      filterRef.current = backendId;
      setBackendFilter(backendId);
      setActivePointId(null);
      if (!selectedId) return;

      setPointsState({ kind: 'loading' });
      try {
        const list = await knowledge.listBySourceAndBackend(selectedId, backendId);
        if (selectedIdRef.current !== selectedId) return;
        setPointsState({ kind: 'ready', data: list });
      } catch (err) {
        setPointsState({
          kind: 'error',
          message: describeError(err),
          hint: '切换后端没有成功，原来的列表已失效。点「全部」重试；若仍失败，刷新页面。',
        });
      }
    },
    [knowledge, selectedId],
  );

  /** 切换资料时正文与知识点一起重载 */
  const loadForSource = useCallback(async () => {
    if (!selectedId) {
      setSegmentsState({ kind: 'ready', data: [] });
      setPointsState({ kind: 'ready', data: [] });
      setBackendsState({ kind: 'ready', data: [] });
      return;
    }
    setSegmentsState({ kind: 'loading' });
    setPointsState({ kind: 'loading' });
    setBackendsState({ kind: 'loading' });
    setActivePointId(null);
    setSegmentIndex(0);
    setLastRun(null);
    // 换资料 = 换一份完全不同的结果，旧资料的筛选与「已挑过默认组」的标记都作废
    filterRef.current = null;
    filterInitFor.current = null;
    setBackendFilter(null);

    /**
     * 从库里读「上次整理」的记录，而不是只靠内存。
     *
     * 早先 lastRun 只在本页 state 里，刷新后那行「上次整理：产出 N 条」就消失了，
     * 用户会以为记录丢了 —— 而它其实一直在 generationRuns 里。
     */
    void (async () => {
      try {
        const run = await knowledge.latestRun(selectedId);
        // 竞态守卫：异步返回时用户可能已切到别的资料。
        // 比对「发起请求时的资料」与 ref 里的当前资料，不一致就丢弃这次结果。
        if (selectedIdRef.current === selectedId) setLastRun(run);
      } catch {
        /* 读不到历史记录不该挡住主要流程，静默即可 */
      }
    })();

    /**
     * 后端 id → 名字的映射表。
     *
     * 读失败不挡住主流程：chips 会退化成「未知后端（id）」，
     * 比让整页报错好 —— 分组统计本身仍然可用。
     */
    void (async () => {
      try {
        const rows = await backendService.list();
        if (selectedIdRef.current !== selectedId) return;
        const map: Record<string, string> = {};
        for (const row of rows) map[row.id] = row.label || row.provider || row.id;
        setBackendLabels(map);
      } catch {
        /* 保持上一次的映射；没有映射时界面会显示「未知后端（id）」 */
      }
    })();

    try {
      const segments = await sourceService.getSegments(selectedId);
      setSegmentsState({ kind: 'ready', data: segments });
    } catch (err) {
      setSegmentsState({
        kind: 'error',
        message: describeError(err),
        hint: '资料本身没有删。换一份资料再切回来通常就能读到；若仍失败，可能是本地存储异常。',
      });
    }

    await reloadPoints();
  }, [selectedId, sourceService, backendService, reloadPoints]);

  useEffect(() => {
    void loadForSource();
  }, [loadForSource]);

  const segments = segmentsState.kind === 'ready' ? segmentsState.data : [];
  const points = pointsState.kind === 'ready' ? pointsState.data : [];

  const activePoint = useMemo(
    () => points.find((p) => p.id === activePointId) ?? null,
    [points, activePointId],
  );

  /**
   * 规范化后的筛选值。
   *
   * `backendFilter` 只会被自动修成「全部」，但用户也可能手点「全部」。
   * 这里再兜一层：如果筛选指向的组在统计里不存在（比如刚被重新整理清掉），
   * 一律按「全部」处理 —— 绝不让界面停在「筛一个空组」的状态。
   */
  const activeBackendFilter = useMemo(() => {
    if (backendFilter === null) return null;
    if (backendsState.kind !== 'ready') return backendFilter;
    return backendsState.data.some((s) => s.backendId === backendFilter) ? backendFilter : null;
  }, [backendFilter, backendsState]);

  const backendSummaries = backendsState.kind === 'ready' ? backendsState.data : [];

  /**
   * 当前整理后端已产出的条数。
   *
   * 从分组统计里取，不用 points.length：points 是「当前筛选后的列表」，
   * 用户筛到别的后端时，它跟「整理面板要写的那个后端」完全无关。
   * 取不到（该后端还没产出过）就是 0 —— 0 条时不会显示「会清空」的提示。
   */
  const currentBackendCount = useMemo(
    () => backendSummaries.find((s) => s.backendId === currentBackendId)?.count ?? 0,
    [backendSummaries, currentBackendId],
  );

  /**
   * backendId → 可读名字。
   *
   * 三种情况分别处理（缺一个都会让 chip 显示成空白或乱码）：
   *   - 手工录入：core 用 MANUAL_BACKEND_ID 归组，显示「手工录入」
   *   - 配置还在：用设置页里那份 label
   *   - 配置已删：**明确说「未知后端（id）」**，不能留空
   *     —— 后端删了但它产出的知识点还在库里，这是正常状态，不是错误
   */
  const backendLabelOf = useCallback(
    (backendId: string): string => backendLabel(backendId, backendLabels),
    [backendLabels],
  );
  /**
   * 当前**列表里**的统计（受后端筛选影响）。
   *
   * 只用于列表标题与「待处理」提醒 —— 那些都是针对「你现在看到的这批」说的。
   */
  const stats = useMemo(() => {
    let located = 0;
    let unlocated = 0;
    let waived = 0;
    for (const p of points) {
      if (p.anchorStatus === 'located') located += 1;
      else if (p.anchorStatus === 'unlocated') unlocated += 1;
      else waived += 1;
    }
    return { located, unlocated, waived, total: points.length };
  }, [points]);

  /**
   * 这份资料**全部后端合计**的统计。
   *
   * 资料选择卡片上说的是「这份资料有多少知识点」，与当前筛到哪个后端无关。
   * 用筛选后的 stats 去说会让数字随 chip 变化，用户会以为数据在丢。
   * 数据源与对比条同一份（summaries），两处数字永远一致。
   */
  const sourceTotals = useMemo(() => sumBackends(backendSummaries), [backendSummaries]);

  /**
   * 选中一条知识点：把它命中的那一段切到左栏。
   *
   * 按 `anchor.page` 找段的**下标**，而不是假设「第 N 页 = 第 N-1 个段」：
   * 按章节切分的资料里 page 是章节起始序号，段序与页码不一定同步。
   * 找不到就保持当前段 —— 不动比跳错好。
   */
  const selectPoint = useCallback(
    (point: KnowledgePoint) => {
      setActivePointId(point.id);
      const page = point.anchors[0]?.page;
      if (page === undefined) return;
      const idx = segments.findIndex((s) => s.page === page);
      if (idx >= 0) setSegmentIndex(idx);
    },
    [segments],
  );

  /** 取左栏当前选中的文字，供「用选中的文字重新指认」 */
  const getSelectedText = useCallback((): string => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const node = sel.anchorNode;
    if (!node || !articleRef.current) return '';
    if (!articleRef.current.contains(node)) return '';
    return sel.toString().trim();
  }, []);

  /**
   * 整理结束后：切到刚跑的那个后端，再刷新列表。
   *
   * 不切会有个很难解释的场面：面板说「整理完成：产出 12 条」，
   * 右边列表却还是另一个后端的 10 条 —— 用户会以为生成失败了。
   * 刚跑完就看刚产出的那一份，是这里唯一合理的默认。
   *
   * 失败时也切：core 是逐条落库的，异常前产出的条目已经在这个后端名下，
   * 让用户看见它们比让它们藏在筛选后面有用。
   */
  const handleGenerated = useCallback(async () => {
    if (filterRef.current !== currentBackendId) {
      filterRef.current = currentBackendId;
      setBackendFilter(currentBackendId);
      setActivePointId(null);
    }
    await reloadPoints();
  }, [reloadPoints, currentBackendId]);

  /**
   * 卡片里每个写动作的结果都汇报到这里。
   *
   * 为什么要单独一条提示：失败在卡片里已经内联显示，但**成功**也需要一句话 ——
   * 比如「重新指认」之后如果仍然是「待处理」，只有明确说「还是没找到这段文字」
   * 用户才知道该换一段引用，而不是以为已经修好。
   */
  const handleNotify = useCallback((message: Flash) => {
    setFlash(message);
  }, []);

  const handleRunningChange = useCallback((running: boolean) => {
    setGenerating(running);
  }, []);

  /**
   * 生成过程中逐条刷新列表。
   *
   * 之所以要单独一个回调（而不是复用 onGenerated）：它会在跑的过程中被调用多次，
   * 不能带任何副作用以外的语义，也不能抛错影响生成流程 ——
   * 列表刷新失败时保持上一次的内容即可，生成本身继续。
   */
  const handleLiveUpdate = useCallback(() => {
    void reloadPoints().catch(() => {
      /* 实时刷新失败不打断生成；结束时 onGenerated 会再刷一次 */
    });
  }, [reloadPoints]);

  const handleRunFinished = useCallback((run: GenerationRun) => {
    setLastRun(run);
  }, []);

  // -------------------------------------------------------------------------
  // 渲染：整页级三态
  // -------------------------------------------------------------------------

  if (sourcesState.kind === 'loading') {
    return <LoadingState label="正在读取资料库…" />;
  }

  if (sourcesState.kind === 'error') {
    return (
      <ErrorState
        title="读不到资料库"
        message={sourcesState.message}
        hint={sourcesState.hint}
        onRetry={() => void loadSources()}
      />
    );
  }

  return (
    <div className="page page__stack kp-page">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">知识点</h2>
          <p className="page__summary">
            把资料整理成知识点，然后在这里逐条校对：左边是原文（命中处高亮），右边是整理结果。
            每条都带着它在原文里的真实位置——定位不到的那些会单独标出来，等你指认或标记为无出处。
          </p>
        </div>
        <div className="page__head-side">
          <Badge tone="neutral">P2</Badge>
          {/*
            多后端并存对比是 P5 第 4 条加进来的能力。
            标出来是为了不让人以为「换后端整理一次就把前一份覆盖了」——
            它只覆盖同一个后端的那一份。
          */}
          <Badge tone="info">P5 多后端对比</Badge>
          <Badge tone="ready">可用</Badge>
        </div>
      </header>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      {/* ---------- 选资料 ---------- */}
      {sources.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有任何资料"
            description={
              <>
                知识点是从资料正文里整理出来的，所以要先有资料。
                去「资料库」导入 PDF、Word、PPT、Markdown 或直接粘贴一段文字。
              </>
            }
            actions={
              <Link className="btn btn--primary" to="/sources">
                去导入资料
              </Link>
            }
          />
        </div>
      ) : (
        <section className="card kp-picker">
          <div className="card__body kp-picker__body">
            <div className="field kp-picker__field">
              <label className="field__label" htmlFor="kp-source">
                选择资料
              </label>
              <select
                id="kp-source"
                className="select"
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(e.target.value || null)}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title}（{pageCountLabel(source)}）
                  </option>
                ))}
              </select>
            </div>

            {selectedSource ? (
              <div className="kp-picker__meta">
                <div className="kp-picker__title">{selectedSource.title}</div>
                <div className="page__row">
                  <span className="page__muted">{pageCountLabel(selectedSource)}</span>
                  {/*
                    只在「有文字层」之外才提醒。用 !== 'ready' 而不是
                    只判断 no-text-layer：这样以后再加状态（比如部分页缺字）
                    也不会漏掉提醒，界面不会对它保持沉默。
                  */}
                  {selectedSource.textStatus !== 'ready' ? (
                    <Badge tone={selectedSource.textStatus === 'decode-failed' ? 'danger' : 'planned'}>
                      {TEXT_STATUS_LABEL[selectedSource.textStatus].text}
                    </Badge>
                  ) : null}
                  {pointsState.kind === 'ready' ? (
                    <>
                      <Badge tone="ready">{sourceTotals.located} 条已定位</Badge>
                      {sourceTotals.unlocated > 0 ? (
                        <Badge tone="planned">{sourceTotals.unlocated} 条待处理</Badge>
                      ) : null}
                      {sourceTotals.waived > 0 ? (
                        <Badge tone="neutral">{sourceTotals.waived} 条无出处</Badge>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {/* 「N 条已定位 / M 条待处理」再给一行完整文字，避免只看徽标数错 */}
                {pointsState.kind === 'ready' && sourceTotals.count > 0 ? (
                  <div className="kp-picker__count">
                    共 {sourceTotals.count} 条：{sourceTotals.located} 条已定位 /{' '}
                    {sourceTotals.unlocated} 条待处理
                    {sourceTotals.waived > 0 ? ` / ${sourceTotals.waived} 条无出处` : ''}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/*
        ---------- 后端对比条（P5 第 4 条） ----------
        只在「这份资料有 ≥2 个后端的结果」时才出现。
        一个选项的筛选器只是噪音：它占一整行，却永远只有一个状态。
        统计加载失败时也不显示 —— 没有可靠数字的对比条会误导人。
      */}
      {selectedSource && backendSummaries.length >= 2 ? (
        <BackendCompare
          summaries={backendSummaries}
          selected={activeBackendFilter}
          onSelect={(id) => void handleFilterSelect(id)}
          labelOf={backendLabelOf}
          currentBackendId={currentBackendId}
        />
      ) : null}

      {selectedSource ? (
        <>
          {/* ---------- 校对区 ---------- */}
          {segmentsState.kind === 'loading' || pointsState.kind === 'loading' ? (
            <LoadingState label="正在打开这份资料的知识点…" />
          ) : segmentsState.kind === 'error' ? (
            <ErrorState
              title="读不出这份资料的正文"
              message={segmentsState.message}
              hint={segmentsState.hint}
              onRetry={() => void loadForSource()}
            />
          ) : pointsState.kind === 'error' ? (
            <ErrorState
              title="读不出这份资料的知识点"
              message={pointsState.message}
              hint={pointsState.hint}
              onRetry={() => void reloadPoints()}
            />
          ) : points.length === 0 ? (
            /*
              空列表分两种，文案必须不同 —— 否则用户会去重新整理一份其实已经有的结果：
                - 筛选到某个后端但它一条都没有（本次唯一能到这里的筛选场景是组被清空）
                - 这份资料真的还没有任何知识点
            */
            <div className="card">
              <EmptyState
                title={
                  generating
                    ? '正在整理，知识点会逐条出现在这里'
                    : activeBackendFilter !== null
                      ? `「${backendLabelOf(activeBackendFilter)}」这一组还没有知识点`
                      : '这份资料还没有知识点'
                }
                description={
                  generating ? (
                    <>整理过程中产出的条目会立刻落库，进度在下方「AI 整理」里可以看到。</>
                  ) : activeBackendFilter !== null ? (
                    <>
                      这份资料的其他后端有结果，但这一组是空的——可能是它刚被重新整理清空了。
                      点「全部」看看所有结果，或选另一个后端。
                    </>
                  ) : (
                    <>
                      在下方「AI 整理」里确认页码范围与预计用量，然后点「开始整理」。
                      整理出的每一条都会尽量指回原文；指不回去的会单独标成「待处理」。
                    </>
                  )
                }
                actions={
                  activeBackendFilter !== null && !generating ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void handleFilterSelect(null)}
                    >
                      看全部结果
                    </button>
                  ) : !generating && !generateOpen ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => setGenerateOpen(true)}
                    >
                      开始整理
                    </button>
                  ) : null
                }
              />
            </div>
          ) : (
            <section className="kp-work" aria-label="校对区">
              <div className="kp-work__head">
                <div className="kp-work__head-main">
                  <h3 className="page__section-title" style={{ marginBottom: 0 }}>
                    校对
                  </h3>
                  <p className="page__muted">
                    点右侧任意一条，左栏会自动跳到它命中的那一页并高亮；也可以在左栏选中文字，
                    给「待处理」的条目重新指认位置。
                  </p>
                </div>
                <div className="page__row" style={{ flex: 'none' }}>
                  {stats.unlocated > 0 ? (
                    <Badge tone="planned">{stats.unlocated} 条待处理</Badge>
                  ) : (
                    <Badge tone="ready">全部已定位</Badge>
                  )}
                </div>
              </div>

              {stats.unlocated > 0 ? (
                <Notice tone="warning" title={`有 ${stats.unlocated} 条指认不到原文位置`}>
                  它们没有页码，也不会在左栏高亮——这是刻意的：
                  <strong>绝不给一个猜出来的位置</strong>。在对应卡片里点「重新指认位置」
                  贴一段真实原文，或确认它本来没有出处后点「标记为无出处」。
                </Notice>
              ) : null}

              <div className="kp-work__grid">
                <div className="kp-work__left">
                  <SourcePane
                    source={selectedSource}
                    segments={segments}
                    currentIndex={Math.min(segmentIndex, Math.max(0, segments.length - 1))}
                    onNavigate={(i) =>
                      setSegmentIndex(Math.max(0, Math.min(segments.length - 1, i)))
                    }
                    points={points}
                    activePoint={activePoint}
                    articleRef={articleRef}
                  />
                </div>

                <div className="kp-work__right">
                  <div className="kp-list__head">
                    <span className="page__muted">
                      {/* 筛选时把范围说清楚：否则用户会以为知识点变少了 */}
                      {activeBackendFilter === null
                        ? `共 ${stats.total} 条 · ${stats.located} 条可点回原文`
                        : `${backendLabelOf(activeBackendFilter)}：${stats.total} 条 · ${stats.located} 条可点回原文`}
                      {activeBackendFilter !== null && sourceTotals.count > stats.total ? (
                        <span className="kp-list__scope">
                          {' '}
                          （这份资料另有 {sourceTotals.count - stats.total} 条在其他后端，点「全部」可一起看）
                        </span>
                      ) : null}
                    </span>
                    {lastRun ? <RunSummary run={lastRun} /> : null}
                  </div>                  <ul className="kp-list">
                    {points.map((point) => (
                      <KnowledgeCard
                        key={point.id}
                        point={point}
                        active={point.id === activePointId}
                        onSelect={() => selectPoint(point)}
                        onChanged={reloadPoints}
                        onNotify={handleNotify}
                        getSelectedText={getSelectedText}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}

          {/* ---------- 整理区 ---------- */}
          <section className="kp-generate-wrap">
            <div className="kp-generate-wrap__head">
              <div>
                <div className="kp-generate-wrap__title">
                  AI 整理
                  {currentBackendCount > 0 ? (
                    <span className="page__muted">
                      （当前后端已有 {currentBackendCount} 条，重新整理会先清空这一份）
                    </span>
                  ) : null}
                </div>
                <div className="page__muted">
                  页码范围、预计用量、进度与停止都在这里。
                </div>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setGenerateOpen((v) => !v)}
                aria-expanded={generateOpen}
              >
                {generateOpen ? '收起' : '展开'}
              </button>
            </div>

            {/*
              面板**始终挂载**，收起只是用 CSS 隐藏。

              为什么不用条件渲染：GeneratePanel 内部持有 AbortController 与
              本次 run 的结果。收起时卸载会把它们一起丢掉 ——
              用户中途收起面板就再也停不掉这次生成，跑完之后
              「已停止，已产出的 N 条已保留」这类结果提示也会消失。
              隐藏式折叠没有任何状态代价。
            */}
            <div
              className={`kp-generate-wrap__body${
                !generateOpen && !generating ? ' kp-generate-wrap__body--hidden' : ''
              }`}
            >
              <GeneratePanel
                key={selectedSource.id}
                source={selectedSource}
                segments={segments}
                existingCount={currentBackendCount}
                onGenerated={handleGenerated}
                onRunningChange={handleRunningChange}
                onLiveUpdate={handleLiveUpdate}
                onRunFinished={handleRunFinished}
                onBackendChange={setCurrentBackendId}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * 上一批结果的简短回顾。
 *
 * 只放一行，因为它不是主要信息：主要信息是列表内容本身。
 * 但「这批产出了几条、几条没定位、花了多少 token」要在回来时还能看到，
 * 否则用户离开页面再回来，就再也找不到这次整理的用量了。
 */
function RunSummary({ run }: { run: GenerationRun }) {
  const stopped = run.status === 'stopped';
  return (
    <span className="kp-list__run">
      {stopped ? '上次整理中途停止' : '上次整理'}：产出 {run.producedCount} 条
      {run.unlocatedCount > 0 ? `，${run.unlocatedCount} 条待处理` : ''}
      {run.actualTokens !== null ? `，实际 ${formatCount(run.actualTokens)} tokens` : ''}
    </span>
  );
}
