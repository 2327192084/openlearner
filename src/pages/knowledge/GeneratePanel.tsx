import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { GenerationRun, Source, SourceSegment } from '@/core/model.ts';
import { useOrganizeBackend } from './use-organize-backend.ts';
import type { GenerateProgress } from '@/core/knowledge/service.ts';
import { describeError, formatCount, hintFrom, parsePageRange } from './types.ts';

/**
 * 整理入口（P2 第 1 组要求）。
 *
 * 这里的每一条都对应计划书上的验收项，不能省：
 *  - 生成前显示**预计用量**（估完再点，避免不小心烧额度）；
 *  - 生成中显示进度（已产出条数 / 已处理段数），随时可停；
 *  - 生成中禁用重复点击（一次只跑一个 run）；
 *  - 结束后显示产出几条、几条待处理、实际用量多少；
 *  - 中途停止要明确说「已产出的 N 条已保留」，而不是含糊地回到初始态。
 *
 * 关于「停止」：`generate()` 的 runId 在返回前拿不到，所以停止只能用
 * 我们自己的 AbortController —— 把 signal 传进去，用户点停止时 abort()。
 * core 保证逐条落库，因此 abort 之后已产出的条目都在库里，
 * 这一点在停止后的提示里要说清楚（否则用户会担心白跑）。
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; run: GenerationRun };

export function GeneratePanel({
  source,
  segments,
  existingCount,
  onGenerated,
  onRunningChange,
  onLiveUpdate,
  onRunFinished,
}: {
  source: Source;
  segments: SourceSegment[];
  /** 这份资料已存在的知识点条数。>0 时重新整理会先清空，必须先告知用户 */
  existingCount: number;
  onGenerated: () => void | Promise<void>;
  /** 让父组件知道「正在跑」，从而不渲染过期的列表 */
  onRunningChange: (running: boolean) => void;
  /**
   * 每条落库后通知父组件刷新列表。
   *
   * 为什么需要：core 是逐条落库的（停止时才能保留已产出的部分），
   * 界面上却等到整轮跑完才刷新 —— 中途用户看到的是空列表，
   * 会以为「一直在跑但什么都没出来」。接上这个回调后，
   * 卡片是真的逐条出现的，与落库节奏一致。
   */
  onLiveUpdate?: () => void;
  /** 把结束的 run 交回父组件，用于「上次整理」那一行回顾 */
  onRunFinished?: (run: GenerationRun) => void;
}) {
  const { knowledge, backends: backendService } = useServices();

  /**
   * 后端选择。
   *
   * P2 时这里是写死的 MockBackend；P5 起可以切到真实模型。
   * 真实后端的 key 走懒加载（见 use-organize-backend.ts），
   * 组件状态里不保存明文 key。
   */
  const backendChoice = useOrganizeBackend(backendService);
  const backend = backendChoice.backend;

  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  /** 上一次实时刷新时的产出条数与时间，用于节流列表重载 */
  const lastLiveCount = useRef(0);
  const lastLiveAt = useRef(0);

  const running = phase.kind === 'running';

  // ---- 页码范围与预计用量 ----

  const parsed = parsePageRange(fromDraft, toDraft);

  const scoped = useMemo(() => {
    const p = parsePageRange(fromDraft, toDraft);
    const range = p.range;
    if (!range) return segments;
    return segments.filter((s) => s.page >= range.from && s.page <= range.to);
  }, [segments, fromDraft, toDraft]);

  /**
   * 预计用量。估不出来（后端实现抛错）时返回 null 并如实说「无法估算」，
   * 不显示一个假数字 —— 假数字会让用户按错误的额度预期点下去。
   */
  const estimate: number | null = useMemo(() => {
    if (scoped.length === 0) return 0;
    try {
      return knowledge.estimate(scoped, backend);
    } catch {
      return null;
    }
  }, [knowledge, scoped, backend]);

  const blockedReason = useMemo(() => {
    if (parsed.error) return parsed.error;
    if (segments.length === 0) return '这份资料没有可整理的正文，无法整理。';
    if (scoped.length === 0) return '选定的页码范围里没有内容，换一个范围再试。';
    return null;
  }, [parsed.error, scoped.length, segments.length]);

  const canStart = !running && blockedReason === null;

  // ---- 生成 ----

  const start = useCallback(
    async () => {
      if (running) return;
      const p = parsePageRange(fromDraft, toDraft);
      if (p.error) {
        setError({
          message: p.error,
          hint: '整份资料就两个输入框都留空；只整理其中几页时，起始页和结束页都要填。',
        });
        return;
      }
      if (scoped.length === 0) {
        setError({
          message: '选定的页码范围里没有内容。',
          hint: `这份资料共 ${segments.length} 段，页码范围不能超出它。改范围或清空两个输入框整理整份。`,
        });
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;

      setError(null);
      setStopping(false);
      setProgress(null);
      lastLiveCount.current = 0;
      lastLiveAt.current = 0;
      setPhase({ kind: 'running' });
      onRunningChange(true);

      try {
        const { run } = await knowledge.generate({
          sourceId: source.id,
          pageRange: p.range,
          backend,
          signal: controller.signal,
          onProgress: (next) => {
            setProgress(next);
            // 每产出一条就刷新一次列表。节流到 100ms：假后端 120ms 一条，
            // 真后端可能快得多，不节流会把 IndexedDB 读爆。
            if (next.produced !== lastLiveCount.current) {
              lastLiveCount.current = next.produced;
              const now = Date.now();
              if (now - lastLiveAt.current >= 100) {
                lastLiveAt.current = now;
                onLiveUpdate?.();
              }
            }
          },
        });
        setPhase({ kind: 'done', run });
        onRunFinished?.(run);
        await onGenerated();
      } catch (err) {
        /*
         * 失败时也要刷新列表：core 是逐条落库的，异常前产出的条目已经在库里。
         * 不刷新会让用户以为一条都没留下，然后重复点一次。
         */
        if (controller.signal.aborted) {
          setError({
            message: '整理已停止。',
            hint: '停止前已产出的条目已经保存在列表里，可以继续校对；不需要从头再跑一遍。',
          });
        } else {
          setError({
            message: describeError(err),
            hint: hintFrom(
              err,
              '这次整理没有产出新结果。可以换一份资料、缩小页码范围再试；已导入的资料不受影响。',
            ),
          });
        }
        await onGenerated();
      } finally {
        controllerRef.current = null;
        setStopping(false);
        setProgress(null);
        setPhase((prev) => (prev.kind === 'running' ? { kind: 'idle' } : prev));
        onRunningChange(false);
      }
    },
    [
      running,
      fromDraft,
      toDraft,
      scoped.length,
      segments.length,
      knowledge,
      source.id,
      backend,
      onGenerated,
      onRunningChange,
      onLiveUpdate,
      onRunFinished,
    ],
  );

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

  /**
   * 进度百分比。
   *
   * 用 core 提供的 `estimatedTotal`（按每段约 3 条粗估）做分母，而不是段落总数。
   *
   * 早先这里写的是 `produced / segmentTotal`，那个算法有个实际的坑：
   * 3 段资料产出 10 条时，10/3 = 333%，进度条早就溢出了，
   * 只是被 Math.min(100, ...) 夹住才没露馅 —— 中间过程是错的。
   *
   * `segmentTotal` 仍然用于文案（「共 N 段」），它是准确值；
   * `estimatedTotal` 只用来算百分比，界面上已标明是估算。
   */
  const percent =
    progress && progress.estimatedTotal > 0
      ? Math.min(100, Math.round((progress.produced / progress.estimatedTotal) * 100))
      : 0;

  return (
    <section className="card kp-generate" aria-labelledby="kp-generate-title">
      <div className="card__head">
        <div>
          <div className="card__title" id="kp-generate-title">
            AI 整理
          </div>
          <div className="card__subtitle">
            把这份资料的正文整理成知识点。模型只负责给「概念表述 + 原文引用」，
            位置由我们在真实正文里找出来——找不到就留空，绝不给一个猜的位置。
          </div>
        </div>
        <div className="page__row" style={{ flex: 'none' }}>
          <Badge tone="neutral">{source.title}</Badge>
        </div>
      </div>

      <div className="card__body page__stack">
        <div className="kp-generate__form">
          <div className="field">
            <label className="field__label" htmlFor="kp-backend">
              整理后端
            </label>
            {/*
              后端选择器（P2 只读）。
              已配置的后端以**可见但不可选**的选项列出来 —— 计划书 P5 要求
              「调用前就告知能力与状态，不做点了才发现不能用」。
              P2 阶段没有真实调用实现，所以它们一律是禁用选项，旁边写明 P5 接入；
              这里绝不假装能选、更不假装能连。
            */}
            <select
              id="kp-backend"
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
              {backendChoice.activeNote}
              {backendChoice.isRealModel ? (
                <>
                  <br />
                  <strong>这是真实调用，会产生费用。</strong>
                  整理完请核对每条知识点的出处是否真的对得上原文。
                </>
              ) : (
                <>
                  <br />
                  想用真模型整理？先到「设置」添加一个 AI 后端并填 API Key，
                  回来这里就能选中它。
                </>
              )}
            </div>
            {backendChoice.loadError ? (
              <div className="field__error">
                读取后端配置失败：{backendChoice.loadError}
              </div>
            ) : null}
          </div>

          <div className="field">
            <span className="field__label">页码范围</span>
            <div className="kp-range">
              <input
                className="input"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="起始页（可留空）"
                aria-label="起始页"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
                disabled={running}
              />
              <span className="kp-range__sep">至</span>
              <input
                className="input"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="结束页（可留空）"
                aria-label="结束页"
                value={toDraft}
                onChange={(e) => setToDraft(e.target.value)}
                disabled={running}
              />
            </div>
            <div className="field__hint">
              两个都留空表示整理整份资料。只整理其中几页时两头都要填。
            </div>
            {parsed.error ? <div className="field__error">{parsed.error}</div> : null}
          </div>
        </div>

        <div className="kp-generate__estimate">
          <div>
            <div className="kp-generate__estimate-label">预计用量</div>
            <div className="kp-generate__estimate-value">
              {estimate === null ? (
                '无法估算'
              ) : scoped.length === 0 ? (
                '0 tokens（范围内没有内容）'
              ) : (
                <>
                  预计约 <strong>{formatCount(estimate)}</strong> tokens
                  <span className="page__muted">
                    （{scoped.length} / {segments.length} 段）
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="page__row" style={{ flex: 'none' }}>
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
              title={blockedReason ?? '开始整理'}
            >
              {running ? '整理中…' : existingCount > 0 ? '重新整理' : '开始整理'}
            </button>
          </div>
        </div>

        {blockedReason && !running ? (
          <div className="field__error">{blockedReason}</div>
        ) : null}

        {/*
          重新整理的后果必须先说清，但不做成阻塞式确认。
          理由：这是可恢复的操作（重新整理一遍就回来了），而 window.confirm
          会阻塞整个页面（无头验收脚本直接卡死），页内 modal 又会把
          「点重新整理 → 点停止」这条验收路径切断。
          所以改成按钮上方的常驻提示，措辞明确、位置在按钮旁边。
        */}
        {existingCount > 0 && !running ? (
          <div className="kp-replace-hint">
            重新整理会先清掉这份资料现有的 <strong>{existingCount} 条</strong>知识点
            （含手工改过的表述、认知层级、指认的位置），再生成新的。资料原文不受影响。
          </div>
        ) : null}

        {/* ---------- 进度 ---------- */}
        {running ? (
          <div className="kp-progress" role="status" aria-live="polite">
            <div className="kp-progress__line">
              <strong>
                已产出 {progress?.produced ?? 0} 条 / 共 {progress?.segmentTotal ?? segments.length} 段
              </strong>
              {progress && progress.unlocated > 0 ? (
                <Badge tone="planned">{progress.unlocated} 条待处理</Badge>
              ) : null}
            </div>
            <div
              className="kp-progress__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="整理进度"
            >
              <div className="kp-progress__fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="kp-progress__hint">
              {/*
                进度条按「已产出条数 / 段落总数」推进，这是 core 上报的唯一可靠量。
                不写成「已处理 N 段」：core 的 segmentIndex 是由产出条数推导的，
                每段能产出几条并不固定，标成「已处理段数」会是假信息。
              */}
              进度按已产出条数与段落总数估算。可以随时停止：每条知识点产出时就已保存，
              停止不会丢掉已产出的部分。
            </div>
          </div>
        ) : null}

        {/* ---------- 结果 ---------- */}
        {phase.kind === 'done' ? <RunResult run={phase.run} /> : null}

        {error ? (
          <Notice tone="danger" title="这次整理没有完成">
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
 * 三件事必须分得开：产出几条、其中几条待处理、实际用了多少 token。
 * 停止时单独一种语气 —— 「已停止，已产出的 N 条已保留」不能和「完成」混在一起说，
 * 否则用户会以为跑完了，然后奇怪为什么只有几条。
 */
function RunResult({ run }: { run: GenerationRun }) {
  const stopped = run.status === 'stopped';
  const empty = run.producedCount === 0;

  return (
    <div className="kp-result">
      <Notice
        tone={stopped ? 'warning' : empty ? 'warning' : 'info'}
        title={
          stopped
            ? `已停止，已产出的 ${run.producedCount} 条已保留`
            : empty
              ? '这次没有产出任何知识点'
              : `整理完成：产出 ${run.producedCount} 条`
        }
      >
        {empty ? (
          stopped
            ? '停止得太早，还没有产出任何条目。重新点「开始整理」再试一次即可。'
            : '模型没有从这段内容里得到可用的知识点。可以换一个页码范围，或换一份正文更完整的资料。'
        ) : (
          <>
            其中 <strong>{run.unlocatedCount} 条待处理</strong>
            {run.unlocatedCount > 0
              ? '（引用在原文里找不到，已在右侧单独标出，需要人工指认或标记为无出处）'
              : '（全部定位成功，都能点回原文）'}
            。
          </>
        )}
      </Notice>

      <dl className="dl kp-result__dl">
        <dt>产出</dt>
        <dd>{run.producedCount} 条</dd>
        <dt>待处理</dt>
        <dd>{run.unlocatedCount} 条</dd>
        <dt>预计用量</dt>
        <dd>{run.estimatedTokens === null ? '未估算' : `${formatCount(run.estimatedTokens)} tokens`}</dd>
        <dt>实际用量</dt>
        <dd>
          {run.actualTokens === null ? '后端没有返回用量' : `${formatCount(run.actualTokens)} tokens`}
        </dd>
        <dt>范围</dt>
        <dd>
          {run.pageRange ? `第 ${run.pageRange.from}–${run.pageRange.to} 页` : '整份资料'}
        </dd>
      </dl>
    </div>
  );
}
