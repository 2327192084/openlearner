import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SlideDeck, Source, SourceSegment } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';
import { Notice } from '@/components/states.tsx';
import { sourceTitleMap } from '@/core/slides/service.ts';
import { DEFAULT_THEME_ID, THEMES, resolveTheme } from '@/core/slides/theme.ts';
import { describeError, hintFrom } from './types.ts';
import { useOutlineBackend } from './use-outline-backend.ts';

/**
 * 生成大纲面板：选资料 → 勾选知识点 → 生成。
 *
 * 为什么不做成「知识点页一键生成」：知识点页属于 P2，由别人负责，
 * 从那边硬塞一个入口会两边耦合。放在 PPT 页里做完整流程，知识点页不用改，
 * 而用户的心智模型也顺：我在 PPT 页想要 PPT，就在这一页选料。
 *
 * 两条硬规则：
 *  1. 只有 `anchorStatus === 'located'` 且真的带锚点的知识点才会进大纲——
 *     没有锚点就做不出角标，硬塞进去等于给用户一堆点不动的 `[n]`。
 *  2. 有多少条没定位、因此不会被选中，必须写在界面上。用户看到「已选 12 条」
 *     就以为全都用上了，这时候少掉的 8 条必须当场说清楚。
 */

export interface SlideGenerateProps {
  onCreated: (deck: SlideDeck) => void;
  onCancel: () => void;
}

/** 一条知识点能不能进大纲：已定位 + 至少一个锚点。 */
/** 一段原文能不能进 PPT：有正文就行（页码由解析器保证） */
export function isUsableSegment(segment: SourceSegment): boolean {
  return segment.text.trim().length > 0;
}

/** 按页码范围过滤，语义与知识点那一栏一致 */
export function applyPageRange(
  segments: SourceSegment[],
  range: { from: number; to: number } | null,
): SourceSegment[] {
  if (!range) return segments;
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  return segments.filter((s) => s.page >= from && s.page <= to);
}

export function SlideGenerate({ onCreated, onCancel }: SlideGenerateProps) {
  const { slides, sources: sourceService, backends } = useServices();

  const outlineBackend = useOutlineBackend(backends);

  const [sourcesList, setSourcesList] = useState<Source[]>([]);
  const [sourcesError, setSourcesError] = useState<{ message: string; hint: string } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  /** 这份资料的全部段落（未按页码范围过滤） */
  const [segments, setSegments] = useState<SourceSegment[] | null>(null);
  const [pointsError, setPointsError] = useState<{ message: string; hint: string } | null>(null);
  /** 页码范围输入（两个都空 = 整份资料） */
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [title, setTitle] = useState('');
  /**
   * 用户对这份 PPT 的额外要求。
   *
   * 空着 → 走固定模板（结构可预期：封面 → 章节页 → 要点页 → 总结页）。
   * 有内容 → 走自由模式，由模型按这些要求组织结构。
   * 这个分叉在 SlideService 里判定，界面只管把原文传下去。
   */
  const [instruction, setInstruction] = useState('');
  /** 配色主题 id。换主题不影响内容，只是渲染取色不同 */
  const [theme, setTheme] = useState(DEFAULT_THEME_ID);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);

  // 竞态守卫：切换资料时上一次的请求可能后到，晚到的结果会把列表覆盖成别人的
  const sourceIdRef = useRef<string | null>(null);
  useEffect(() => {
    sourceIdRef.current = sourceId;
  }, [sourceId]);

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
        hint: '资料列表读不出来通常是本地存储的问题。刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘已满。',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (!sourceId) {
      setSegments([]);
      return;
    }
    let alive = true;
    setSegments(null);
    setPointsError(null);

    /**
     * 读资料正文。
     *
     * 与知识点那一栏取的是同一份东西（sourceSegments），
     * 只是这里不过 AI、直接交给 PPT 后端。
     */
    sourceService
      .getSegments(sourceId)
      .then((list) => {
        if (!alive || sourceIdRef.current !== sourceId) return;
        setSegments(list);
      })
      .catch((err: unknown) => {
        if (!alive || sourceIdRef.current !== sourceId) return;
        setSegments([]);
        setPointsError({
          message: describeError(err),
          hint: '读不到这份资料的正文。刷新页面重试；如果这份资料是扫描件，先用「看图识公式」识别一遍。',
        });
      });

    return () => {
      alive = false;
    };
  }, [sourceService, sourceId]);

  /** 页码范围：两个都填才生效，填反了自动纠正 */
  const range = useMemo(() => {
    const from = Number(fromDraft.trim());
    const to = Number(toDraft.trim());
    if (!fromDraft.trim() || !toDraft.trim()) return null;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from < 1 || to < 1) return null;
    return { from, to };
  }, [fromDraft, toDraft]);

  /** 页码范围是否只填了一头（要提示用户，否则会误以为生效了） */
  const rangeHalfFilled =
    (fromDraft.trim() !== '' || toDraft.trim() !== '') && range === null;

  /** 按页码范围筛出来的段落 */
  const scoped = useMemo(
    () => applyPageRange(segments ?? [], range),
    [segments, range],
  );

  const usable = useMemo(() => scoped.filter(isUsableSegment), [scoped]);

  const currentSource = sourcesList.find((s) => s.id === sourceId) ?? null;

  const blockedReason = (() => {
    /**
     * 后端检查放在最前面。
     *
     * 这个功能必须用 AI，没有后端时后面无论选得多整齐都生成不了。
     * 先说这件事，用户才不会花时间选完资料才被拦住。
     */
    if (outlineBackend.blockedReason) return outlineBackend.blockedReason;
    if (sourcesList.length === 0) return '这份学习库里还没有资料。先去资料库导入一份教材。';
    if (segments === null) return '正在读取这份资料的正文…';
    if (segments.length === 0) return '这份资料还没有正文，可能是扫描件。先用「看图识公式」识别，或换一份电子版。';
    if (rangeHalfFilled) return '页码范围要两头都填才生效（起始页和结束页）。两个都留空表示用整份资料。';
    if (scoped.length === 0) {
      return `第 ${range!.from}–${range!.to} 页里没有内容。这份资料共 ${segments.length} 段，换一个范围再试。`;
    }
    if (usable.length === 0) return '选定的范围里没有可用的正文。换一个页码范围再试。';
    return null;
  })();

  const canStart = blockedReason === null && !running;

  const start = async () => {
    if (blockedReason !== null || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await slides.createFromSource({
        sourceId: sourceId ?? '',
        chunks: usable.map((seg) => ({
          segmentId: seg.id,
          page: seg.page,
          chapter: seg.chapter,
          text: seg.text,
        })),
        title: title.trim() === '' ? undefined : title.trim(),
        sourceTitles: sourceTitleMap(sourcesList),
        ...(currentSource?.courseId ? { courseId: currentSource.courseId } : {}),
        // 有可用后端就必须走 AI —— 这是这个功能的定位，不是可选项
        ...(outlineBackend.backend ? { backend: outlineBackend.backend } : {}),
        // 空字符串会让 core 判成自由模式，所以只有真有内容才传
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        theme,
      });

      /**
       * AI 失败但回退成功了。
       *
       * 此时大纲是确定性算法排出来的（要点是知识点原文），
       * 和用户期待的「AI 生成的课件」不是一回事。必须当场说清楚，
       * 否则用户会照着一份没被 AI 处理过的大纲去导出 PPT。
       */
      if (!result.usedAi && result.aiFailure) {
        setError({
          message: `这次没能用上 AI：${result.aiFailure}`,
          hint:
            '已经用原始知识点排出了一份可编辑的大纲，你可以先用着。' +
            '想重试 AI 生成，换个后端或稍后再点一次「生成大纲」。',
        });
      }

      onCreated(result.deck);
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(err, '大纲没有生成。检查一下选中的知识点是否有正文，然后重试。'),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="card" aria-labelledby="sl-gen-title">
      <div className="card__head">
        <div>
          <h3 className="card__title" id="sl-gen-title">
            从知识点生成大纲
          </h3>
          <p className="card__subtitle">
            选一份资料，勾选要放进 PPT 的知识点。只有已定位到原文的知识点才会带上角标。
          </p>
        </div>
      </div>

      <div className="card__body page__stack">
        {sourcesError ? (
          <Notice tone="danger" title="读不到资料列表">
            {sourcesError.message}
            <br />
            <strong>下一步：</strong>
            {sourcesError.hint}
          </Notice>
        ) : null}

        <div className="sl-gen__grid">
          <div className="field">
            <label className="field__label" htmlFor="sl-gen-source">
              资料
            </label>
            <select
              className="select"
              id="sl-gen-source"
              value={sourceId ?? ''}
              disabled={sourcesList.length === 0 || running}
              onChange={(event) => setSourceId(event.target.value || null)}
            >
              {sourcesList.length === 0 ? <option value="">（暂无资料）</option> : null}
              {sourcesList.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </select>
            <div className="field__hint">
              {currentSource
                ? `${currentSource.segmentCount} 个段落，${currentSource.pageCount} 页`
                : '先从资料库导入一份教材'}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="sl-gen-title-input">
              PPT 标题（可留空）
            </label>
            <input
              className="input"
              id="sl-gen-title-input"
              type="text"
              value={title}
              placeholder={currentSource ? `${currentSource.title} · 学习 PPT` : '学习 PPT'}
              disabled={running}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="field__hint">留空会用「资料名 · 学习 PPT」，之后还能改。</div>
          </div>
        </div>

        {/*
          用户要求输入框。

          这是「让用户通过提示词提出修改需求」的落点。留空走固定模板
          （每次都是同一套版式），写了就交给模型自由组织。
        */}
        <div className="field">
          <label className="field__label" htmlFor="sl-gen-instruction">
            对这份 PPT 有什么要求（可留空）
          </label>
          <textarea
            className="input"
            id="sl-gen-instruction"
            rows={3}
            value={instruction}
            disabled={running}
            placeholder="例如：每页不超过 3 条要点 / 用考试重点的口吻 / 多加一页易错点对比"
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="field__hint">
            {instruction.trim()
              ? '会按你的要求让模型自己安排页面结构，版式可能每次都不同。'
              : '留空会用固定版式：封面 → 各章节页 → 要点页 → 总结页，每次结构一致。'}
          </div>
        </div>

        {/*
          配色主题。

          选的是「风格」而不是具体色值：让用户自己调颜色，多数人会调出
          对比度不足的组合（浅灰字配白底），投影到教室墙上根本看不清。
          预设都经过对比度检查，先给稳的选择；自定义留到后续版本。
        */}
        <div className="field">
          <label className="field__label" htmlFor="sl-gen-theme">
            配色风格
          </label>
          <select
            id="sl-gen-theme"
            className="select"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            disabled={running}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="field__hint">
            {resolveTheme(theme).note}
            <br />
            生成后还能在详情页随时换，不会影响已写好的内容。
          </div>
        </div>

        {pointsError ? (
          <Notice tone="danger" title="读不到这份资料的知识点">
            {pointsError.message}
            <br />
            <strong>下一步：</strong>
            {pointsError.hint}
          </Notice>
        ) : null}

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
            两个都留空表示用整份资料。只做其中几页时两头都要填。
          </div>
          {rangeHalfFilled ? (
            <div className="field__error">页码范围要两头都填才生效。</div>
          ) : null}
        </div>

        <div className="sl-gen__points-hint">
          {segments === null ? '正在读取正文…' : null}
          {segments !== null && segments.length > 0 ? (
            <>
              {range ? `第 ${Math.min(range.from, range.to)}–${Math.max(range.from, range.to)} 页` : '整份资料'}
              ：共 <strong>{usable.length}</strong> 段正文，会排成约{' '}
              {Math.max(1, Math.ceil(usable.length / 5))} 页正文（每页最多 5 条）。
            </>
          ) : null}
        </div>

        {/*
          后端选择器。

          放在生成按钮前面且没有「离线」选项：这个功能必须用 AI 生成课件，
          产品定位如此。没有配置后端时这里会显示明确的下一步指引，
          而不是给一个点了也没动静的按钮。
        */}
        {outlineBackend.options.length > 0 ? (
          <div className="field">
            <label className="field__label" htmlFor="sl-gen-backend">
              用哪个 AI 后端生成
            </label>
            <select
              id="sl-gen-backend"
              className="select"
              value={outlineBackend.selected}
              onChange={(e) => outlineBackend.select(e.target.value)}
              disabled={running}
            >
              {outlineBackend.options.map((o) => (
                <option key={o.key} value={o.key} disabled={!o.available}>
                  {o.label}
                  {o.available ? '' : `（${o.reason ?? '不可用'}）`}
                </option>
              ))}
            </select>
            <div className="field__hint">
              {outlineBackend.activeNote}
              {outlineBackend.activeNote ? <br /> : null}
              大纲由模型根据你选中的知识点重新组织，每条要点仍会标回它依据的原文页码。
            </div>
          </div>
        ) : null}

        {error ? (
          <Notice tone="danger" title="这次生成没有完成">
            {error.message}
            <br />
            <strong>下一步：</strong>
            {error.hint}
          </Notice>
        ) : null}

        <div className="sl-gen__footer">
          <div>
            <div className="sl-gen__estimate-label">本次会生成</div>
            <div className="sl-gen__estimate-value">
              {usable.length} 段原文 · 约 {Math.max(1, Math.ceil(usable.length / 5)) + 1} 页（含封面）
            </div>
          </div>
          <div className="page__row">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={running}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void start()}
              disabled={!canStart}
              title={blockedReason ?? '生成一份可编辑的大纲'}
            >
              {running ? '正在生成…' : '生成学习 PPT 大纲'}
            </button>
          </div>
        </div>

        {!running && blockedReason ? <div className="field__error">{blockedReason}</div> : null}
      </div>
    </section>
  );
}
