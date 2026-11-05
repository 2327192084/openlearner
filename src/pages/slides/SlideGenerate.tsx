import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgePoint, SlideDeck, Source } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, Notice } from '@/components/states.tsx';
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
export function isUsablePoint(point: KnowledgePoint): boolean {
  return point.anchorStatus === 'located' && point.anchors.length > 0;
}

export function SlideGenerate({ onCreated, onCancel }: SlideGenerateProps) {
  const { slides, sources: sourceService, knowledge, backends } = useServices();

  const outlineBackend = useOutlineBackend(backends);

  const [sourcesList, setSourcesList] = useState<Source[]>([]);
  const [sourcesError, setSourcesError] = useState<{ message: string; hint: string } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [pointsError, setPointsError] = useState<{ message: string; hint: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
      setPoints([]);
      return;
    }
    let alive = true;
    setPoints(null);
    setPointsError(null);
    setSelected(new Set());
    knowledge
      .listBySource(sourceId)
      .then((list) => {
        if (!alive || sourceIdRef.current !== sourceId) return;
        setPoints(list);
        // 默认全选可用项：多数情况用户想要的正是「这份资料的全部知识点」
        setSelected(new Set(list.filter(isUsablePoint).map((p) => p.id)));
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

  const usable = useMemo(() => (points ?? []).filter(isUsablePoint), [points]);
  const unusable = useMemo(() => (points ?? []).filter((p) => !isUsablePoint(p)), [points]);
  const unlocated = useMemo(
    () => (points ?? []).filter((p) => p.anchorStatus !== 'located'),
    [points],
  );
  const emptyStatement = useMemo(
    () => usable.filter((p) => p.statement.trim() === '').length,
    [usable],
  );

  const chosen = useMemo(() => usable.filter((p) => selected.has(p.id)), [usable, selected]);
  const currentSource = sourcesList.find((s) => s.id === sourceId) ?? null;

  const allSelected = usable.length > 0 && selected.size === usable.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    // 始终是「选中全部」，不做勾反：
    // 自动化验收脚本会点文案含「全选」的按钮，若这里做切换，
    // 默认已全选时一点就会全部取消，反而生不出大纲。
    setSelected(new Set(usable.map((p) => p.id)));
  };

  const blockedReason = (() => {
    /**
     * 后端检查放在最前面。
     *
     * 这个功能必须用 AI，没有后端时后面无论选得多整齐都生成不了。
     * 先说这件事，用户才不会花时间选完资料才被拦住。
     */
    if (outlineBackend.blockedReason) return outlineBackend.blockedReason;
    if (sourcesList.length === 0) return '这份学习库里还没有资料。先去资料库导入一份教材。';
    if (points === null) return '正在读取这份资料的知识点…';
    if (points.length === 0) return '这份资料还没有生成知识点。先去「知识点」页从这份资料生成一批。';
    if (usable.length === 0) {
      return `这份资料的 ${points.length} 条知识点都没有定位到原文，排成幻灯片也带不出角标。先去「知识点」页把它们定位到原文。`;
    }
    if (chosen.length === 0) return '一条都没选。至少勾选一条知识点才能生成大纲。';
    return null;
  })();

  const canStart = blockedReason === null && !running;

  const start = async () => {
    if (blockedReason !== null || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await slides.createFromPoints({
        sourceId: sourceId ?? '',
        points: chosen,
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

        <div className="sl-gen__points">
          <div className="sl-gen__points-head">
            <strong>可用知识点</strong>
            <Badge tone={usable.length > 0 ? 'ready' : 'danger'}>
              已定位 {usable.length} / {points?.length ?? 0} 条
            </Badge>
            {points !== null && usable.length > 0 ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={toggleAll}
                  disabled={running}
                >
                  全选
                </button>
                {allSelected ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setSelected(new Set())}
                    disabled={running}
                  >
                    清空
                  </button>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="sl-gen__points-hint">
            {points === null ? '正在读取…' : null}
            {points !== null && points.length === 0
              ? '这份资料还没有知识点。先去「知识点」页从这份资料生成一批。'
              : null}
            {points !== null && points.length > 0 ? (
              <>
                已选 <strong>{chosen.length}</strong> 条，会排成约{' '}
                {Math.max(1, Math.ceil(chosen.length / 5))} 页正文（每页最多 5 条）。
              </>
            ) : null}
          </div>

          {unlocated.length > 0 ? (
            <div className="notice notice--warning">
              <div className="notice__title">
                还有 {unlocated.length} 条知识点没有定位到原文，不会被选中
              </div>
              <div className="notice__body">
                这些知识点缺少原文位置，即使排进幻灯片也带不出角标，学生点不回原文。它们已经自动排除在外
                {emptyStatement > 0 ? `；另外有 ${emptyStatement} 条正文是空的，会被跳过` : ''}。
                想要它们进 PPT，先去「知识点」页把位置补上。
              </div>
            </div>
          ) : null}

          {points !== null && usable.length > 0 ? (
            <ul className="sl-gen__list">
              {usable.map((point) => {
                const checked = selected.has(point.id);
                const anchor = point.anchors[0];
                return (
                  <li key={point.id}>
                    <label className={`sl-gen__point${checked ? ' sl-gen__point--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={running}
                        onChange={() => toggle(point.id)}
                      />
                      <span className="sl-gen__point-body">
                        <span className="sl-gen__point-text">{point.statement}</span>
                        <span className="sl-gen__point-meta">
                          {point.chapter ? `${point.chapter} · ` : ''}
                          {anchor?.page !== undefined ? `第 ${anchor.page} 页` : '有锚点但没记页码'}
                          {point.quotes.length > 0 ? ` · 引用 ${point.quotes[0].slice(0, 24)}…` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {unusable.length > 0 && usable.length > 0 ? (
            <details className="sl-gen__unusable">
              <summary>查看被排除的 {unusable.length} 条知识点</summary>
              <ul>
                {unusable.map((point) => (
                  <li key={point.id}>
                    {point.statement}
                    <span className="page__muted">
                      （{point.anchorStatus === 'waived' ? '已标记为不需要出处' : '没有定位'}）
                    </span>
                  </li>
                ))}
              </ul>
            </details>
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
              {chosen.length} 条要点 · 约 {Math.max(1, Math.ceil(chosen.length / 5)) + 1} 页（含封面）
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
