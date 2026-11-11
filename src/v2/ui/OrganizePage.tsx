import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationRun, KnowledgePoint, Source, SourceSegment } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { KnowledgeService, GenerateProgress } from '@/core/knowledge/service.ts';
import type { BackendService } from '@/core/backends.ts';
import { useOrganizeBackend } from './organize-backend.ts';
import { ConvertPanel } from './ConvertPanel.tsx';
import { needsConversion } from '@/core/mineru/convert.ts';
import { IconSources } from './icons.tsx';
import { MathText } from './MathText.tsx';

/**
 * 整理知识点页。
 *
 * ## 为什么这一页非有不可
 *
 * 出题依赖「已定位的知识点」：`GeneratePage` 只把
 * `points.filter(p => p.anchors.length > 0)` 送去出题。
 * 而在这一页出现之前，v2 界面**没有任何地方能产出知识点** ——
 * 用户在设置页配好后端、回到出题页，永远看到「这份资料还没有整理过知识点」。
 * 那条链路是断的，这一页就是补上它。
 *
 * ## 几条不能省的规矩（都来自 v1 的踩坑记录）
 *
 *  - 生成前显示**预计用量**（估不出来就说「无法估算」，不给假数字）；
 *  - 进度百分比的分母用 `estimatedTotal`（估算），不是段落总数 ——
 *    用后者会出现 333% 这种一看就错的数字；
 *  - 中途停止用本地 AbortController，停止后明说「已产出的已保存」；
 *  - 重新整理会清掉**同一个后端**上次的结果，这件事必须写在按钮旁边，
 *    而不是等用户发现条目变少了才知道。
 */

type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; run: GenerationRun };

const LEVEL_LABEL: Record<KnowledgePoint['cognitiveLevel'], string> = {
  remember: '记忆',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
};

export interface OrganizePageProps {
  sourceService: SourceService;
  knowledge: KnowledgeService;
  backends: BackendService;
  /** 从资料页点进来时带上的资料 id；null 表示还没选 */
  initialSourceId: string | null;
  onBack: () => void;
  /** 产出条目后通知上层刷新卡片池与侧栏计数 */
  onChanged: () => void;
  /**
   * 去「文档解析」页（2026-11-11）。
   *
   * 用户反馈解析过两页之后没有入口继续解析 —— 见页面里那段提醒的注释。
   * 不传就不显示那个链接（不摆点了没反应的东西）。
   */
  onOpenParse?: (sourceId: string) => void;
  /** 点「可点回原文」—— 打开阅读器并定位到这条知识点的位置 */
  onOpenAnchor?: (target: {
    sourceId: string;
    page?: number;
    charStart?: number;
    charEnd?: number;
    quote?: string;
  }) => void;
}

export function OrganizePage({
  sourceService,
  knowledge,
  backends,
  initialSourceId,
  onBack,
  onChanged,
  onOpenAnchor,
  onOpenParse,
}: OrganizePageProps) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSourceId);
  const [segments, setSegments] = useState<SourceSegment[] | null>(null);
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [run, setRun] = useState<GenerationRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  const backendChoice = useOrganizeBackend(backends);
  const backend = backendChoice.backend;
  const running = phase.kind === 'running';

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const all = await sourceService.list();
      setSources(all);
      setSelected((prev) => {
        if (prev && all.some((s) => s.id === prev)) return prev;
        return all[0]?.id ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '读不出资料列表');
    }
  }, [sourceService]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const reloadSourceData = useCallback(
    async (sourceId: string) => {
      try {
        const [segs, pts, latest] = await Promise.all([
          sourceService.getSegments(sourceId),
          knowledge.listBySource(sourceId),
          knowledge.latestRun(sourceId),
        ]);
        if (!aliveRef.current) return;
        setSegments(segs);
        setPoints(pts);
        setRun(latest);
      } catch (err) {
        if (!aliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : '读不出这份资料的内容');
      }
    },
    [sourceService, knowledge],
  );

  useEffect(() => {
    if (!selected) {
      setSegments(null);
      setPoints(null);
      setRun(null);
      return;
    }
    setSegments(null);
    setPoints(null);
    void reloadSourceData(selected);
  }, [selected, reloadSourceData]);

  /** 页码范围：两头都填或都留空 */
  const parsed = useMemo(() => {
    const from = fromDraft.trim();
    const to = toDraft.trim();
    if (from === '' && to === '') return { range: null as { from: number; to: number } | null, error: null };
    if (from === '' || to === '') {
      return { range: null, error: '页码范围要么两头都填，要么都留空（整份资料）。' };
    }
    const f = Number(from);
    const t = Number(to);
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 1 || t < 1) {
      return { range: null, error: '页码范围要填大于 0 的整数页码。' };
    }
    return { range: { from: Math.min(f, t), to: Math.max(f, t) }, error: null };
  }, [fromDraft, toDraft]);

  const scoped = useMemo(() => {
    if (!segments) return [];
    const range = parsed.range;
    if (!range) return segments;
    return segments.filter((s) => s.page >= range.from && s.page <= range.to);
  }, [segments, parsed.range]);

  /**
   * 预计用量。估不出来时返回 null 并如实写「无法估算」——
   * 假数字会让用户按错误预期点下去。
   */
  const estimate = useMemo(() => {
    if (scoped.length === 0) return 0;
    try {
      return knowledge.estimate(scoped, backend);
    } catch {
      return null;
    }
  }, [knowledge, scoped, backend]);

  /** 这个后端上一次已产出的条数（重新整理会替换掉它们） */
  const existingCount = useMemo(
    () => (points ?? []).filter((p) => p.backendId === backend.id).length,
    [points, backend.id],
  );

  const locatedCount = useMemo(
    () => (points ?? []).filter((p) => p.anchors.length > 0).length,
    [points],
  );

  const currentSource = (sources ?? []).find((s) => s.id === selected) ?? null;

  const blockedReason = useMemo(() => {
    if (parsed.error) return parsed.error;
    if (!selected) return '先选一份资料。';
    if (segments === null) return '正在读这份资料的正文…';
    if (segments.length === 0) {
      /*
       * 指向上面那个转换面板，而不是只丢一句「可能是扫描件」——
       * 用户看到这句话的下一步应该是「那我该怎么办」，
       * 而答案就在上面的面板里（用 MinerU 转成正文）。
       */
      const needsBody = Boolean(
        currentSource && needsConversion(currentSource.textStatus, currentSource.kind),
      );
      return needsBody
        ? '这份资料还没有正文。先用上面的按钮把它转成正文，再来整理。'
        : '这份资料没有可整理的正文。';
    }
    if (scoped.length === 0) return '选定的页码范围里没有内容，换一个范围再试。';
    return null;
  }, [parsed.error, selected, segments, scoped.length, currentSource]);

  const start = useCallback(async () => {
    if (running || !selected) return;
    const controller = new AbortController();
    controllerRef.current = controller;

    setError(null);
    setStopping(false);
    setProgress(null);
    setPhase({ kind: 'running' });

    try {
      const { run: finished } = await knowledge.generate({
        sourceId: selected,
        pageRange: parsed.range,
        backend,
        signal: controller.signal,
        onProgress: (next) => {
          if (!aliveRef.current) return;
          setProgress(next);
        },
      });
      if (!aliveRef.current) return;
      setPhase({ kind: 'done', run: finished });
      await reloadSourceData(selected);
      onChanged();
    } catch (err) {
      if (!aliveRef.current) return;
      /*
       * 失败也要刷新列表：core 是逐条落库的，异常前产出的条目已经在库里。
       * 不刷新会让用户以为一条都没留下，然后又点一次。
       */
      await reloadSourceData(selected);
      onChanged();
      if (controller.signal.aborted) {
        setError({
          message: '整理已停止。',
          hint: '停止前已产出的条目已经保存在下面的列表里，可以直接拿去出题，不用从头再跑一遍。',
        });
      } else {
        const e = err as { message?: string; hint?: string } | null;
        setError({
          message: e?.message ?? '整理失败',
          hint: typeof e?.hint === 'string' ? e.hint : null,
        });
      }
    } finally {
      controllerRef.current = null;
      if (aliveRef.current) {
        setStopping(false);
        setProgress(null);
        setPhase((prev) => (prev.kind === 'running' ? { kind: 'idle' } : prev));
      }
    }
  }, [running, selected, parsed.range, knowledge, backend, reloadSourceData, onChanged]);

  const stop = useCallback(() => {
    if (!controllerRef.current) return;
    setStopping(true);
    controllerRef.current.abort();
  }, []);

  /**
   * 进度百分比的分母是 estimatedTotal（按每段约 3 条粗估），不是段落数。
   * 用段落数会在「3 段产出 10 条」时算出 333%。
   */
  const percent =
    progress && progress.estimatedTotal > 0
      ? Math.min(100, Math.round((progress.produced / progress.estimatedTotal) * 100))
      : 0;

  /**
   * 这份资料需不需要「先补正文」。
   *
   * 用来决定步骤编号：需要转换时插一步，后面两步顺延 ——
   * 否则编号会变成 01 → (无编号面板) → 02 → 03，看着像漏了一步。
   */
  const hasConvertPanel = Boolean(
    currentSource && needsConversion(currentSource.textStatus, currentSource.kind),
  );

  return (
    <div className="org-page">
      <header className="org-head">
        <div>
          <h1 className="org-title">整理知识点</h1>
          <p className="org-lead">
            把资料的正文整理成一条条知识点。模型只给「概念表述 + 原文引用」，
            位置由我们在真实正文里找出来 —— 找不到就留空，绝不给一个猜的位置。
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={onBack}>
          <IconSources size={15} />
          返回资料
        </button>
      </header>

      {loadError ? <div className="org-error">{loadError}</div> : null}

      {sources !== null && sources.length === 0 ? (
        <div className="org-empty">
          <p className="org-empty__title">还没有导入资料</p>
          <p className="org-hint">
            知识点是从资料的正文里整理出来的。先到「资料」里导入一份讲义或笔记，再回来这里。
          </p>
          <button type="button" className="btn-fill btn-fill--sm" onClick={onBack}>
            去导入资料
          </button>
        </div>
      ) : null}

      {sources !== null && sources.length > 0 ? (
        <div className="org-form">
          <fieldset className="org-field">
            <legend className="org-legend">01 / 选资料</legend>
            <select
              className="org-select"
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              disabled={running}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}（{s.segmentCount} 段）
                </option>
              ))}
            </select>
          </fieldset>

          {/* 扫描件 / 图片：检测到就在流程里解决，不让用户去别处找 */}
          {currentSource ? (
            <ConvertPanel
              source={currentSource}
              sourceService={sourceService}
              onConverted={() => {
                void reloadSourceData(currentSource.id);
                onChanged();
              }}
              {...(onOpenAnchor
                ? {
                    onOpenPage: (page: number) =>
                      onOpenAnchor({ sourceId: currentSource.id, page }),
                  }
                : {})}
            />
          ) : null}

          {/*
            「去文档解析」提醒（2026-11-11）。
            
            用户反馈：解析了两页之后想继续解析，发现没有入口。
            根因是 ConvertPanel 只在「还没有正文」时渲染 —— 解析过之后
            它就消失了。现在解析有了独立页（侧栏「文档解析」），
            这里给一句提醒把用户指过去。
            
            为什么两处都留：整理页的流程不该被打断（需要补正文时就地能补），
            但用户也该知道有个专门的地方可以慢慢解析整本。
          */}
          {currentSource ? (
            <p className="org-hint org-hint--parse">
              想解析更多页？到
              <button
                type="button"
                className="org-linkbtn"
                onClick={() => onOpenParse?.(currentSource.id)}
              >
                文档解析
              </button>
              页可以按页范围分几次解析，已解析的页不会丢。
            </p>
          ) : null}

          <fieldset className="org-field">
            <legend className="org-legend">{hasConvertPanel ? '03' : '02'} / 用哪个后端</legend>
            <select
              className="org-select"
              value={backendChoice.selected}
              onChange={(e) => backendChoice.select(e.target.value)}
              disabled={running || backendChoice.loading}
            >
              {backendChoice.options.map((opt) => (
                <option key={opt.key} value={opt.key} disabled={!opt.available}>
                  {opt.label}
                  {opt.available ? '' : `（${opt.reason ?? '不可用'}）`}
                </option>
              ))}
            </select>
            <p className="org-hint">
              {backendChoice.loadError
                ? `读不出已配置的后端：${backendChoice.loadError}`
                : backendChoice.isRealModel
                  ? backendChoice.options.find((o) => o.key === backendChoice.selected)?.note ?? ''
                  : '示例后端从原文里摘句子模拟整理结果，不花钱也不联网。先用它把流程走一遍，确认结果的样子再去设置页接真模型。'}
            </p>
          </fieldset>

          <fieldset className="org-field">
            <legend className="org-legend">{hasConvertPanel ? '04' : '03'} / 页码范围（可选）</legend>
            <div className="org-row">
              <input
                className="org-input"
                inputMode="numeric"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
                placeholder="起始页"
                disabled={running}
              />
              <span className="org-dash">—</span>
              <input
                className="org-input"
                inputMode="numeric"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
                placeholder="结束页"
                disabled={running}
              />
              <span className="org-hint org-hint--inline">
                都在这个资料里（共 {segments?.length ?? '?'} 段、{currentSource?.pageCount ?? '?'} 页）
              </span>
            </div>
            <p className="org-hint">
              两个框都留空就是整理整份资料。只整理其中几页时，起始页和结束页都要填。
            </p>
          </fieldset>

          <div className="org-estimate">
            <span>
              本次将处理 <strong>{scoped.length}</strong> 段
              {parsed.range ? `（第 ${parsed.range.from}–${parsed.range.to} 页）` : '（整份）'}
            </span>
            <span className="org-estimate__cost">
              预计用量：{estimate === null ? '无法估算' : `约 ${estimate.toLocaleString('zh-CN')} tokens`}
            </span>
          </div>

          {existingCount > 0 && !running ? (
            <div className="org-inline org-inline--warn">
              这个后端上次在这份资料里产出了 <strong>{existingCount}</strong> 条。
              再整理一次会<strong>替换掉它们</strong>（换一个后端则两份并存，互不影响）。
            </div>
          ) : null}

          {error ? (
            <div className="org-inline org-inline--error" role="alert">
              <span>{error.message}</span>
              {error.hint ? <span className="org-hint">{error.hint}</span> : null}
            </div>
          ) : null}

          {running ? (
            <div className="org-progress">
              <div className="org-progress__bar">
                <div className="org-progress__fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="org-progress__meta">
                <span>
                  已产出 <strong>{progress?.produced ?? 0}</strong> 条
                  {progress ? `（按每段约 3 条估算，共约 ${progress.estimatedTotal} 条）` : ''}
                </span>
                {progress && progress.unlocated > 0 ? (
                  <span className="org-progress__warn">{progress.unlocated} 条没找到原文位置</span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="org-actions">
            {running ? (
              <button type="button" className="btn-ghost" onClick={stop} disabled={stopping}>
                {stopping ? '正在停止…' : '停止'}
              </button>
            ) : (
              <button
                type="button"
                className="btn-fill"
                onClick={() => void start()}
                disabled={blockedReason !== null}
                title={blockedReason ?? undefined}
              >
                {phase.kind === 'done' || existingCount > 0 ? '重新整理' : '开始整理'}
              </button>
            )}
            {blockedReason && !running ? <span className="org-hint">{blockedReason}</span> : null}
            {running ? (
              <span className="org-hint">可以随时停止，已经产出的条目会立刻保存。</span>
            ) : null}
          </div>

          {phase.kind === 'done' ? (
            <div className="org-inline org-inline--ok">
              ✓ 整理完成：产出 <strong>{phase.run.producedCount}</strong> 条
              {phase.run.unlocatedCount > 0 ? `，其中 ${phase.run.unlocatedCount} 条没找到原文位置` : ''}
              {phase.run.actualTokens ? `，实际用量 ${phase.run.actualTokens.toLocaleString('zh-CN')} tokens` : ''}。
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---- 结果列表 ---- */}
      {points !== null && points.length > 0 ? (
        <section className="org-result">
          <div className="org-result__head">
            <h2 className="org-result__title">
              这份资料的知识点 · {points.length} 条
            </h2>
            <span className="org-result__meta">
              已定位 <strong>{locatedCount}</strong> 条
              {locatedCount < points.length ? `，${points.length - locatedCount} 条待处理` : ''}
            </span>
          </div>
          {locatedCount === 0 ? (
            <p className="org-hint">
              还没有一条定位到原文位置。没有出处的知识点出不了题 ——
              换一段正文更完整的页码范围再整理一次，或换一份电子版资料。
            </p>
          ) : (
            <p className="org-hint">
              下面这些条目已经可以拿去出题了。回到「创建题组」，选这份资料就能看到它们。
            </p>
          )}

          {run ? (
            <p className="org-hint">
              上次整理：{run.producedCount} 条
              {run.unlocatedCount > 0 ? `（${run.unlocatedCount} 条未定位）` : ''} ·
              {run.status === 'completed'
                ? ' 已完成'
                : run.status === 'stopped'
                  ? ' 中途停止'
                  : run.status === 'failed'
                    ? ' 失败'
                    : ' 进行中'}
              {run.actualTokens ? ` · ${run.actualTokens.toLocaleString('zh-CN')} tokens` : ''}
            </p>
          ) : null}

          <ol className="org-list">
            {points.map((p) => (
              <li key={p.id} className="org-item">
                <div className="org-item__top">
                  <span className="org-item__level">{LEVEL_LABEL[p.cognitiveLevel]}</span>
                  {/*
                   * 「可点回原文」是真按钮 —— 从这一页做出来之前它只是个徽章，
                   * 写着「可点」却点不动，比不写更糟。
                   * 没有 anchor 的保留为静态徽章（点了也没有位置可去）。
                   */}
                  {p.anchors.length > 0 && onOpenAnchor ? (
                    <button
                      type="button"
                      className="org-badge org-badge--ok org-badge--link"
                      onClick={() => {
                        const a = p.anchors[0]!;
                        onOpenAnchor({
                          sourceId: a.sourceId,
                          page: a.page,
                          charStart: a.charStart,
                          charEnd: a.charEnd,
                          quote: p.quotes[0],
                        });
                      }}
                    >
                      可点回原文 · 第 {p.anchors[0]?.page ?? '?'} 页
                    </button>
                  ) : (
                    <span
                      className={
                        p.anchors.length > 0
                          ? 'org-badge org-badge--ok'
                          : 'org-badge org-badge--warn'
                      }
                    >
                      {p.anchors.length > 0
                        ? `可点回原文 · 第 ${p.anchors[0]?.page ?? '?'} 页`
                        : '没找到原文位置'}
                    </span>
                  )}
                </div>
                <p className="org-item__statement"><MathText text={p.statement} /></p>
                {p.quotes.length > 0 ? (
                  <p className="org-item__quote">
                    「<MathText text={p.quotes[0] ?? ''} />」
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {points !== null && points.length === 0 && !running ? (
        <p className="org-hint">
          这份资料还没有知识点。选好后端点「开始整理」，产出就会出现在这里。
        </p>
      ) : null}
    </div>
  );
}
