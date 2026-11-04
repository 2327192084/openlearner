import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { KnowledgePoint, QuestionKind, Source } from '@/core/model.ts';
import type { GenerateProgress, GenerateQuestionsOutput } from '@/core/questions/service.ts';
import { useQuestionBackend } from './use-question-backend.ts';
import {
  COGNITIVE_LEVELS,
  QUESTION_KINDS,
  describeError,
  formatCount,
  hintFrom,
  levelLabel,
} from './types.ts';
import type { Flash } from './types.ts';

/**
 * 出题面板。
 *
 * 每一条都对应 P3 的验收项：
 *  - 选资料 → 显示该资料**已定位**的知识点数，不足时明确说「去校对页」；
 *  - 出题参数：题型多选、题数、难度层级；
 *  - 后端选择：示例出题 / 真实模型，缺 Key 的选项禁用并写明原因；
 *  - 生成前显示预计用量，生成中显示进度、可停止；
 *  - 结束如实汇报（产出几题、几条被判为阻塞、实际用量）；
 *  - **结果一定是草稿**，并在按钮边上说清楚。
 *
 * ## 关于「已定位」的过滤
 *
 * 只有 `anchorStatus === 'located' && anchors.length > 0` 的知识点能出题。
 * core 的 `generate()` 内部也会过滤一遍（防御性），但界面**必须先说**：
 * 如果用户手上 20 条知识点里只有 3 条已定位，他点下出题后只得到 3 道题，
 * 却不知道另外 17 条被悄悄跳过了 —— 那是界面在骗人。
 * 所以这里把「已定位 / 待处理 / 无出处」三个数都摆出来。
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: GenerateQuestionsOutput };

export function DeckGenerate({
  onGenerated,
  onCancel,
}: {
  /**
   * 生成结束后把新草稿交给父组件（父组件切到审阅页）。
   *
   * 第二个参数是给用户看的一句汇报（产出几道、用量多少）。
   * 因为它要跟着跳转走，所以由父组件放进页面级提示条，
   * 而不是留在被卸载掉的面板里。
   */
  onGenerated: (deckId: string, summary: Flash) => void;
  onCancel: () => void;
}) {
  const { sources: sourceService, knowledge, decks: deckService, backends: backendService } =
    useServices();

  const backendChoice = useQuestionBackend(backendService);
  const backend = backendChoice.backend;

  // ---- 资料 ----
  const [sourcesList, setSourcesList] = useState<Source[] | null>(null);
  const [sourcesError, setSourcesError] = useState<{ message: string; hint: string } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);

  // ---- 选中资料的知识点 ----
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [pointsError, setPointsError] = useState<{ message: string; hint: string } | null>(null);

  // ---- 参数 ----
  const [title, setTitle] = useState('');
  const [kinds, setKinds] = useState<QuestionKind[]>(['single', 'multiple']);
  const [count, setCount] = useState(10);
  const [levels, setLevels] = useState<KnowledgePoint['cognitiveLevel'][]>([]);
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');

  // ---- 生成 ----
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const running = phase.kind === 'running';

  /**
   * 当前选中资料的镜像，用于竞态守卫：
   * 异步返回时用户可能已经切到别的资料，结果必须丢弃。
   */
  const sourceIdRef = useRef<string | null>(null);
  useEffect(() => {
    sourceIdRef.current = sourceId;
  }, [sourceId]);

  // ---- 加载资料列表 ----
  const loadSources = useCallback(async () => {
    setSourcesError(null);
    try {
      const list = await sourceService.list();
      setSourcesList(list);
      setSourceId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      setSourcesList([]);
      setSourcesError({
        message: describeError(err),
        hint: '资料列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘是否已满。',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // ---- 切换资料时拉它的知识点 ----
  useEffect(() => {
    if (!sourceId) {
      setPoints(null);
      return;
    }
    let alive = true;
    setPoints(null);
    setPointsError(null);
    knowledge
      .listBySource(sourceId)
      .then((list) => {
        if (!alive || sourceIdRef.current !== sourceId) return;
        setPoints(list);
      })
      .catch((err: unknown) => {
        if (!alive || sourceIdRef.current !== sourceId) return;
        setPoints([]);
        setPointsError({
          message: describeError(err),
          hint: '知识点没有改动。换一份资料再切回来通常就能读到；若仍失败，可能是本地存储异常。',
        });
      });
    return () => {
      alive = false;
    };
  }, [knowledge, sourceId]);

  // ---- 知识点统计（已定位 / 待处理 / 无出处） ----
  const pointStats = useMemo(() => {
    const all = points ?? [];
    let located = 0;
    let unlocated = 0;
    let waived = 0;
    for (const p of all) {
      if (p.anchorStatus === 'located' && p.anchors.length > 0) located += 1;
      else if (p.anchorStatus === 'unlocated') unlocated += 1;
      else waived += 1;
    }
    return { located, unlocated, waived, total: all.length };
  }, [points]);

  /** 真正会用于出题的知识点（与服务端过滤规则一致，界面自己也算一遍用于提示） */
  const usable = useMemo(
    () => (points ?? []).filter((p) => p.anchorStatus === 'located' && p.anchors.length > 0),
    [points],
  );

  /** 按层级筛选后实际参与的知识点，用于估算与「筛太严」的提示 */
  const scoped = useMemo(() => {
    if (levels.length === 0) return usable;
    const filtered = usable.filter((p) => levels.includes(p.cognitiveLevel));
    return filtered.length > 0 ? filtered : usable;
  }, [usable, levels]);

  const options = useMemo(
    () => ({ kinds, count, levels: levels.length > 0 ? levels : null, language }),
    [kinds, count, levels, language],
  );

  /**
   * 预计用量。
   *
   * 估不出来（后端实现抛错）时返回 null 并如实说「无法估算」，
   * 不显示一个假数字 —— 假数字会让用户按错误的额度预期点下去。
   */
  const estimate: number | null = useMemo(() => {
    if (scoped.length === 0) return null;
    try {
      return backend.estimateTokens(
        scoped.map((p) => ({
          id: p.id,
          statement: p.statement,
          quotes: p.quotes,
          cognitiveLevel: p.cognitiveLevel,
          chapter: p.chapter,
          page: p.anchors[0]?.page ?? null,
        })),
        options,
      );
    } catch {
      return null;
    }
  }, [scoped, backend, options]);

  const blockedReason = useMemo(() => {
    if (!sourcesList || sourcesList.length === 0) return '还没有任何资料，先去「资料库」导入一份。';
    if (!sourceId) return '先选一份资料。';
    /*
     * 知识点还在读时**不能**当成「没问题」放行：
     * 那样用户能在列表返回前就点下出题，而 usable 此时还是空数组，
     * `generate()` 会抛「没有可出题的知识点」——一条与他看到的状态无关的错误。
     */
    if (points === null) return '正在读取这份资料的知识点…';
    if (points.length === 0) {
      return '这份资料还没有知识点。先去「知识点」页整理出知识点，再回来出题。';
    }
    if (usable.length === 0) {
      return '这份资料的知识点都还没定位到原文位置。出题只用已定位的条目——请先在校对页把它们定位好。';
    }
    if (kinds.length === 0) return '至少要选一种题型。';
    if (count < 1) return '题数至少填 1。';
    return null;
  }, [sourcesList, sourceId, points, usable, kinds, count]);

  const canStart = !running && blockedReason === null;

  // ---- 开始 ----
  const start = useCallback(async () => {
    if (running || !sourceId) return;
    if (usable.length === 0) {
      setError({
        message: '没有可出题的知识点。',
        hint: '出题只用「已定位」的知识点。请先到知识点页把至少几条定位好，再回来重试。',
      });
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    setError(null);
    setStopping(false);
    setProgress(null);
    setPhase({ kind: 'running' });

    const sourceTitle = sourcesList?.find((s) => s.id === sourceId)?.title ?? '习题集';
    const finalTitle = title.trim() || `${sourceTitle} · 练习`;

    try {
      const result = await deckService.generate({
        points: usable,
        title: finalTitle,
        courseId: sourcesList?.find((s) => s.id === sourceId)?.courseId ?? null,
        sourceId,
        backend,
        options,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });
      setPhase({ kind: 'done', result });
      /*
       * 出完立刻进审阅页。
       *
       * 不这么做的话，用户看到的是一块「结果汇报」，然后要自己
       * 回列表 → 找到刚建的那个草稿 → 点进去。中间那一步看起来像
       * 「出题结束了，然后呢？」——而草稿的本质就是等人检查。
       *
       * 汇报文字不丢：把它作为页面级提示带过去（见 onGenerated 的第二个参数），
       * 所以用户落到审阅页时仍然看到「产出几道、用多少 token」。
       * 一道都没出就留在原地，因为那时候没有可检查的东西。
       */
      if (result.questions.length > 0) {
        onGenerated(result.deck.id, summarize(result));
      }
    } catch (err) {
      /*
       * 失败时也要说明「已产出的部分还在」。
       * core 是逐题落库的，异常前产出的题已经在库里 ——
       * 不刷新的话用户会以为一道都没留下，然后重复点一次，
       * 白白多出一个草稿（而 core 每次 generate 都会新建一个 Deck）。
       */
      if (controller.signal.aborted) {
        setError({
          message: '出题已停止。',
          hint:
            '停止前已出的题目留在一个新的草稿习题集里（回列表就能看到）。' +
            '不需要从头再跑一遍——但如果停止得太早，那个草稿可能一道题都没有，直接删掉即可。',
        });
      } else {
        setError({
          message: describeError(err),
          hint: hintFrom(
            err,
            '这次出题没有产出结果。可以换一份资料、减少题数再试；已导入的资料和知识点不受影响。',
          ),
        });
      }
    } finally {
      controllerRef.current = null;
      setStopping(false);
      setProgress(null);
      setPhase((prev) => (prev.kind === 'running' ? { kind: 'idle' } : prev));
    }
  }, [running, sourceId, usable, title, sourcesList, deckService, backend, options]);

  const stop = () => {
    if (!controllerRef.current) return;
    setStopping(true);
    controllerRef.current.abort();
  };

  // 卸载时中断：否则页面切走还在后台跑完，用户回来时状态对不上
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const toggleKind = (kind: QuestionKind) => {
    setKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  };

  const toggleLevel = (level: KnowledgePoint['cognitiveLevel']) => {
    setLevels((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level],
    );
  };

  /**
   * 进度百分比。
   *
   * 分母用 core 上报的 `estimatedTotal`（期望题数），不是知识点总数。
   * 早先 P2 那边用过「产出条数 / 段落总数」，那个算法在段少条多时会超过 100%，
   * 只是被 Math.min 夹住才没露馅。这里分母就是用户要的题数，语义直接。
   */
  const percent =
    progress && progress.estimatedTotal > 0
      ? Math.min(100, Math.round((progress.produced / progress.estimatedTotal) * 100))
      : 0;

  return (
    <section className="card" aria-labelledby="dk-gen-title">
      <div className="card__head">
        <div>
          <div className="card__title" id="dk-gen-title">
            出题
          </div>
          <div className="card__subtitle">
            从已定位的知识点出题。题目的出处<strong>继承</strong>知识点的位置，
            不让模型再说一次引用——这样每道题的「看原文」必然指得准。
          </div>
        </div>
        <Badge tone="planned">结果先进草稿</Badge>
      </div>

      <div className="card__body page__stack">
        {/* ---------- 选资料 ---------- */}
        <div className="dk-gen__grid">
          <div className="field">
            <label className="field__label" htmlFor="dk-gen-source">
              资料
            </label>
            {sourcesError ? (
              <div className="field__error">{sourcesError.message}</div>
            ) : sourcesList === null ? (
              <div className="page__muted">正在读取资料库…</div>
            ) : sourcesList.length === 0 ? (
              <div className="field__error">
                还没有任何资料。
                <Link to="/sources"> 去导入</Link>
              </div>
            ) : (
              <select
                id="dk-gen-source"
                className="select"
                value={sourceId ?? ''}
                onChange={(e) => setSourceId(e.target.value || null)}
                disabled={running}
              >
                {sourcesList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
            {sourcesError ? (
              <div className="field__hint">
                <strong>下一步：</strong>
                {sourcesError.hint}
              </div>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="dk-gen-title-input">
              习题集名称
            </label>
            <input
              id="dk-gen-title-input"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="留空则用「资料名 · 练习」"
              disabled={running}
            />
            <div className="field__hint">之后在审阅页还能改题目内容，但标题就固定了。</div>
          </div>
        </div>

        {/* ---------- 知识点可用情况 ---------- */}
        {sourceId ? (
          pointsError ? (
            <Notice tone="danger" title="读不出这份资料的知识点">
              {pointsError.message}
              <br />
              <strong>下一步：</strong>
              {pointsError.hint}
            </Notice>
          ) : points === null ? (
            <div className="page__muted">正在读取这份资料的知识点…</div>
          ) : points.length === 0 ? (
            <Notice tone="warning" title="这份资料还没有知识点">
              出题需要知识点。先去知识点页把这份资料整理成知识点，再回来。
              <div className="dk-hint__actions">
                <Link className="btn btn--sm btn--primary" to="/knowledge">
                  去整理知识点
                </Link>
              </div>
            </Notice>
          ) : (
            <div className="dk-gen__points">
              <div className="dk-gen__points-head">
                <strong>可出题的知识点</strong>
                <Badge tone={pointStats.located > 0 ? 'ready' : 'danger'}>
                  {pointStats.located} 条已定位
                </Badge>
                {pointStats.unlocated > 0 ? (
                  <Badge tone="planned">{pointStats.unlocated} 条待处理</Badge>
                ) : null}
                {pointStats.waived > 0 ? (
                  <Badge tone="neutral">{pointStats.waived} 条无出处</Badge>
                ) : null}
                <span className="page__muted">共 {pointStats.total} 条</span>
              </div>
              <div className="dk-gen__points-hint">
                {pointStats.located === 0 ? (
                  <>
                    一条都没有定位到原文。出题只用已定位的条目——否则题目无法「看原文」，
                    产品承诺就不成立了。
                    <Link to="/knowledge"> 去校对页定位</Link>
                  </>
                ) : pointStats.located < pointStats.total ? (
                  <>
                    只会用这 <strong>{pointStats.located}</strong> 条已定位的出题，
                    其余 {pointStats.total - pointStats.located} 条会被跳过
                    （{pointStats.unlocated > 0 ? '待处理的需要先定位' : ''}
                    {pointStats.unlocated > 0 && pointStats.waived > 0 ? '，' : ''}
                    {pointStats.waived > 0 ? '无出处的是人工标过的' : ''}）。
                    <Link to="/knowledge"> 去校对</Link>
                  </>
                ) : (
                  '全部知识点都已定位，可以放心出题。'
                )}
              </div>
            </div>
          )
        ) : null}

        {/* ---------- 参数 ---------- */}
        <div className="field">
          <span className="field__label">题型（可多选）</span>
          <div className="dk-gen__kinds">
            {QUESTION_KINDS.map((k) => (
              <label key={k.value} className="dk-gen__chip">
                <input
                  type="checkbox"
                  checked={kinds.includes(k.value)}
                  onChange={() => toggleKind(k.value)}
                  disabled={running}
                />
                <span className="dk-gen__chip-body">
                  <span className="dk-gen__chip-label">{k.label}</span>
                  <span className="dk-gen__chip-hint">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {kinds.length === 0 ? (
            <div className="field__error">至少选一种题型，否则出不了题。</div>
          ) : null}
        </div>

        <div className="dk-gen__grid">
          <div className="field">
            <label className="field__label" htmlFor="dk-gen-count">
              题数
            </label>
            <input
              id="dk-gen-count"
              className="input"
              type="number"
              min={1}
              max={100}
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              disabled={running}
            />
            <div className="field__hint">
              题数多于可用知识点时会重复使用知识点（同一个概念出不同题型）。
            </div>
          </div>

          <div className="field">
            <span className="field__label">难度层级（不选表示不限）</span>
            <div className="dk-gen__levels">
              {COGNITIVE_LEVELS.map((l) => (
                <label key={l.value} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={levels.includes(l.value)}
                    onChange={() => toggleLevel(l.value)}
                    disabled={running}
                  />
                  <span title={l.hint}>{l.label}</span>
                </label>
              ))}
            </div>
            {levels.length > 0 && usable.length > 0 && scoped.length === usable.length ? (
              <div className="field__hint">
                没有知识点落在选中的层级里，已自动放宽为不限——否则会一道题都出不来。
              </div>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="dk-gen-lang">
              出题语言
            </label>
            <select
              id="dk-gen-lang"
              className="select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
              disabled={running}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>

        {/* ---------- 后端 ---------- */}
        <div className="field">
          <label className="field__label" htmlFor="dk-gen-backend">
            出题后端
          </label>
          <select
            id="dk-gen-backend"
            className="select"
            value={backendChoice.selected}
            onChange={(e) => backendChoice.select(e.target.value)}
            disabled={running}
          >
            {backendChoice.options.map((opt) => (
              <option key={opt.key} value={opt.key} disabled={!opt.available}>
                {opt.label}
                {opt.available ? '' : `（${opt.reason ?? '不可用'}）`}
              </option>
            ))}
          </select>
          <div className="field__hint">
            {backendChoice.loading ? (
              '正在读取后端配置…'
            ) : (
              <>
                {backendChoice.activeNote}
                <br />
                {backendChoice.isRealModel ? (
                  <>
                    <strong>这是真实调用，会产生费用。</strong>
                    出完请逐题检查答案与解析——模型给错的题比没有题更糟。
                  </>
                ) : (
                  <>
                    示例后端只做机械挖空，题目质量有限，别拿它判断产品能力。
                    想要真正出题？先到「设置」添加 AI 后端并填 API Key。
                  </>
                )}
              </>
            )}
          </div>
          {backendChoice.loadError ? (
            <div className="field__error">读取后端配置失败：{backendChoice.loadError}</div>
          ) : null}
        </div>

        {/* ---------- 预计用量 + 动作 ---------- */}
        <div className="dk-gen__footer">
          <div>
            <div className="dk-gen__estimate-label">预计用量</div>
            <div className="dk-gen__estimate-value">
              {scoped.length === 0 ? (
                '—'
              ) : estimate === null ? (
                '无法估算'
              ) : (
                <>
                  约 <strong>{formatCount(estimate)}</strong> tokens
                  <span className="page__muted">
                    （{scoped.length} 条知识点 · {count} 题
                    {levels.length > 0 ? ` · ${levels.map(levelLabel).join('/')}` : ''}）
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="page__row" style={{ flex: 'none' }}>
            <button type="button" className="btn" onClick={onCancel} disabled={running}>
              取消
            </button>
            {running ? (
              <button type="button" className="btn" onClick={stop} disabled={stopping}>
                {stopping ? '正在停止…' : '停止'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void start()}
              disabled={!canStart}
              title={blockedReason ?? '开始出题'}
            >
              {running ? '出题中…' : '开始出题'}
            </button>
          </div>
        </div>

        {/*
          「正在读取知识点」不是错误，用中性一行说明；
          真正的阻塞原因才用红色。混在一起显示会让用户以为出了故障。
        */}
        {!running && points === null && sourceId ? (
          <div className="page__muted">正在读取这份资料的知识点…</div>
        ) : !running && blockedReason ? (
          <div className="field__error">{blockedReason}</div>
        ) : null}

        {/* ---------- 进度 ---------- */}
        {running ? (
          <div className="dk-progress" role="status" aria-live="polite">
            <div className="dk-progress__line">
              <strong>
                已出 {progress?.produced ?? 0} 题 / 目标 {progress?.estimatedTotal ?? count} 题
              </strong>
              <span className="page__muted">
                （可用知识点 {progress?.pointTotal ?? usable.length} 条）
              </span>
            </div>
            <div
              className="dk-progress__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="出题进度"
            >
              <div className="dk-progress__fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="dk-progress__hint">
              每出一道题就保存一道，可以随时停止——已出的题会留在草稿里，不会白跑。
            </div>
          </div>
        ) : null}

        {/* ---------- 结果 ---------- */}
        {phase.kind === 'done' ? (
          <GenerateResult
            result={phase.result}
            onOpen={(deckId) => onGenerated(deckId, summarize(phase.result))}
          />
        ) : null}

        {error ? (
          <Notice tone="danger" title="这次出题没有完成">
            {error.message}
            <br />
            <strong>下一步：</strong>
            {error.hint}
          </Notice>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 生成结束的如实汇报。
 *
 * 三件事必须分得开：出了几道、其中几条有阻塞问题、实际用了多少 token。
 * 停止时单独一种语气 —— 「已停止，已出的 N 题已保留」不能和「完成」混在一起说。
 */
function GenerateResult({
  result,
  onOpen,
}: {
  result: GenerateQuestionsOutput;
  onOpen: (deckId: string) => void;
}) {
  const { stopped, deck, questions, actualTokens } = result;
  const empty = questions.length === 0;
  // 直接读 deck 上缓存的阻塞数：core 在 generate() 结束时已经算好并落库了，
  // 这里不再把整个 questions 数组重新校验一遍。
  const blocking = deck.blockingIssues;

  return (
    <div className="dk-result">
      <Notice
        tone={stopped ? 'warning' : empty ? 'warning' : 'info'}
        title={
          stopped
            ? `已停止，已出的 ${questions.length} 题已保留为草稿`
            : empty
              ? '这次没有出任何题'
              : `出题完成：${questions.length} 道题，已存为草稿`
        }
      >
        {empty ? (
          stopped
            ? '停止得太早，还没有产出任何题目。重新点「开始出题」再试一次即可。'
            : '后端没有从这些知识点里得到可用的题目。可以换一份资料、换题型组合再试。'
        ) : (
          <>
            {blocking > 0 ? (
              <>
                其中 <strong>{blocking} 个问题必须先修好才能发布</strong>
                （缺答案、答案键不在选项里、单选给了多个答案等）。
              </>
            ) : (
              <>没有阻塞问题。有提醒的话看一眼，确认无误就能发布。</>
            )}
            <br />
            <strong>它还是草稿。</strong>
            要检查过题目、答案、解析和出处之后，在审阅页手动发布，学生才能刷到。
          </>
        )}
      </Notice>

      <dl className="dl dk-result__dl">
        <dt>产出</dt>
        <dd>{questions.length} 道</dd>
        <dt>阻塞问题</dt>
        <dd>{blocking} 个</dd>
        <dt>预计用量</dt>
        <dd>
          {questions.length === 0
            ? '未产生消耗'
            : actualTokens === null
              ? '后端没有返回用量'
              : `${formatCount(actualTokens)} tokens`}
        </dd>
        <dt>状态</dt>
        <dd>草稿（未发布）</dd>
      </dl>

      {!empty ? (
        <div className="page__row">
          <button type="button" className="btn btn--primary" onClick={() => onOpen(deck.id)}>
            去检查这批题
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 关于「停止」的一个坑，记在这里免得后人踩：
 *
 * core 的 `generate()` 会**在开始时就建好 Deck**，然后逐题往里填。
 * abort 之后 Promise 是 reject 的，我们拿不到返回值，也就拿不到 deckId。
 * 但那个 Deck 已经在库里了。
 *
 * 所以停止后的提示必须写明「草稿已保留」，且**不能**替用户猜哪个是刚建的
 * （列表里可能有多个草稿，猜错会把用户带到别人的草稿上）。
 */
/**
 * 出完那一句话的汇报文案。
 *
 * 单独一个函数，因为它在两个地方用：跳转前带进审阅页的提示条，
 * 以及「一道都没出」时留在面板上的结果块。两处措辞必须一致。
 */
function summarize(result: GenerateQuestionsOutput): Flash {
  const n = result.questions.length;
  const blocking = result.deck.blockingIssues;
  const tokens =
    result.actualTokens === null ? '' : `，用了约 ${formatCount(result.actualTokens)} tokens`;
  const tail =
    blocking > 0
      ? `其中 ${blocking} 个问题必须先修好才能发布。`
      : '没有阻塞问题，检查一下就能发布。';
  return {
    tone: blocking > 0 ? 'warning' : 'info',
    text: `出题完成：${n} 道题，已存为草稿${tokens}。${tail}`,
  };
}
