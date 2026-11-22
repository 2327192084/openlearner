/**
 * 学习地图·一级页面：**选资料，创建 / 查看地图**（2026-11-22 下午）。
 *
 * ## 为什么拆成两级（用户的明确要求）
 *
 * > 写一个二级页面，用户在一级页面选择资料创建学习地图，
 * > 二级页面显示树状地图。
 * > 每份资料都能创建地图，创建完成后在不同资料底下留个查看地图按钮就行。
 *
 * 拆之前是一页：题库概览 + 树 + 规划表单 + 章节列表 + 工具条全堆在
 * 一起，截图里那个页面纵向能滚三屏，而且**规划表单和已经画好的树
 * 讲的是两件事**（一个是"我要排"，一个是"我已经有"），并排放让人
 * 不知道看哪个。分开之后每页只回答一个问题：
 *
 * - 一级：**哪份资料有地图、我要做哪张**（这一页）
 * - 二级：**这张地图长什么样、这一节做完没**（`MapTreePage.tsx`）
 *
 * ## 为什么每份资料是一行、行内两个动作
 *
 * 用户的话是「在不同资料底下留个查看地图按钮」。所以：
 * - 还没有地图 → 「创建地图」
 * - 已经有地图 → 「查看地图」+ 完成进度（让他知道这张图推到哪了）
 *
 * 两个动作**互斥**，不给「重建」按钮 —— 重规划在二级页面里，
 * 因为那要看着现有地图才能判断该不该重排。
 *
 * ## 未解析完的资料怎么办
 *
 * 方案第八节要求「硬拦改提示」：**不再置灰、按钮始终可点**，
 * 只显示黄色提示。用户明确要求过「规划路线的按钮还是要保留给用户，
 * 让用户自己决定」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceService } from '@/core/sources.ts';
import { prepareSourcePlans, type SourcePlanPrep } from '@/v2/core/source-plan-inputs.ts';
import {
  describePresearchCostEstimate,
  type PresearchGranularity,
} from '@/core/ai/presearch-resources.ts';
import {
  summarizeAll,
  type SourceTreeMap,
  type TreeSummary,
} from '@/v2/core/source-tree-store.ts';

export interface MapHomePageProps {
  sourceService: SourceService;
  /** 已有的全部地图（sourceId → 树） */
  trees: SourceTreeMap;
  /** 读搜索 Key 状态（只为在提示里说清"没配就搜不了"） */
  readSearchKey: () => Promise<string | null>;
  /**
   * 为某份资料创建地图 → 跳到二级页面。
   *
   * 这个回调由 App 实现（它拿得到 AI 能力与存储）。
   * 返回 Promise 是为了让本页能显示「正在规划…」并接住错误。
   * `presearchGranularity` 是用户在下面选的找资料粒度（2026-11-23）。
   */
  onCreate: (
    prep: SourcePlanPrep,
    subjectName: string,
    wantSearch: boolean,
    presearchGranularity: PresearchGranularity,
  ) => Promise<void>;
  /** 查看已有地图 → 跳到二级页面 */
  onOpen: (sourceId: string) => void;
}

export function MapHomePage(props: MapHomePageProps) {
  const { sourceService, trees, readSearchKey, onCreate, onOpen } = props;

  const [preps, setPreps] = useState<SourcePlanPrep[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasSearchKey, setHasSearchKey] = useState<boolean | null>(null);

  /** 正在为哪份资料创建（sourceId）；null = 没在跑 */
  const [creating, setCreating] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** 每份资料的科目输入（用户可改推定值） */
  const [subjectDraft, setSubjectDraft] = useState<Record<string, string>>({});
  /** 每份资料这次要不要联网 */
  const [wantSearch, setWantSearch] = useState<Record<string, boolean>>({});
  /**
   * 每份资料「联网找资料」的粒度（2026-11-23 用户拍板做成可选项）。
   * 缺省章级（`undefined` 也按章级算）—— 上一轮它被单方面定为章级
   * 且界面没有入口；现在小节级可达，但默认仍章级，理由是每次检索
   * 都是一次完整模型调用（`presearch-resources.ts` 文件头记了成本账）。
   */
  const [granularity, setGranularity] = useState<Record<string, PresearchGranularity>>({});

  const load = useCallback(async () => {
    try {
      const r = await prepareSourcePlans({ sourceService });
      setPreps(r.sources);
      /* 把推定科目预填进草稿（用户可改） */
      const draft: Record<string, string> = {};
      for (const p of r.sources) draft[p.source.id] = p.subject.name;
      setSubjectDraft(draft);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '读不出资料');
    }
  }, [sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void readSearchKey()
      .then((k) => setHasSearchKey(!!k && k.trim().length > 0))
      .catch(() => setHasSearchKey(false));
  }, [readSearchKey]);

  const summaries = useMemo(() => {
    const byId = new Map<string, TreeSummary>();
    for (const s of summarizeAll(trees)) byId.set(s.sourceId, s);
    return byId;
  }, [trees]);

  const create = async (prep: SourcePlanPrep) => {
    const id = prep.source.id;
    const name = (subjectDraft[id] ?? '').trim();
    if (name.length === 0) {
      setErr('先填这门课是什么科目 —— 路线要按学科常规排，没有科目就排不准。');
      return;
    }
    setCreating(id);
    setErr(null);
    try {
      await onCreate(prep, name, wantSearch[id] === true, granularity[id] ?? 'chapter');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '规划失败');
    } finally {
      setCreating(null);
    }
  };

  /* ---------- 加载态 ---------- */
  if (loadError) {
    return (
      <div className="map-home">
        <h1 className="map-home__title">学习地图</h1>
        <p className="map-error">{loadError}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (!preps) {
    return (
      <div className="map-home">
        <h1 className="map-home__title">学习地图</h1>
        <p className="map-hint">正在读资料…</p>
      </div>
    );
  }

  return (
    <div className="map-home">
      <header className="map-home__head">
        <h1 className="map-home__title">学习地图</h1>
        <p className="map-home__lead">
          选一份资料做成地图：AI 按资料自己的章节结构排出「资料 → 章 → 小节」，
          每一节有网课、闪卡、习题三项任务。每份资料一张地图，可以各自推进。
        </p>
      </header>

      {err ? <p className="map-error">{err}</p> : null}

      {preps.length === 0 ? (
        <p className="map-home__empty">
          还没有资料。先到「资料」里导入教材或讲义，地图会依据资料自己的章节来排。
        </p>
      ) : (
        <ul className="map-home__list">
          {preps.map((p) => {
            const id = p.source.id;
            const sum = summaries.get(id);
            const hasUsableContent = p.segmentCount > 0;
            const complete = p.completeness.ok;
            const busy = creating === id;

            return (
              <li key={id} className={'maphome-row' + (sum ? ' maphome-row--has' : '')}>
                <div className="maphome-row__main">
                  <div className="maphome-row__head">
                    <span className="maphome-row__title">{p.source.title}</span>
                    {sum ? (
                      <span className="maphome-row__badge">
                        已有地图 · {sum.sectionsDone} / {sum.sections} 小节
                      </span>
                    ) : null}
                  </div>

                  <div className="maphome-row__meta">
                    {p.segmentCount} 段 · {p.charCount} 字
                    {p.coverage
                      ? ` · 覆盖第 ${p.coverage.from}~${p.coverage.to} 章`
                      : ' · 无章节结构'}
                    {p.outline.kind === 'toc-page'
                      ? ' · 有目录'
                      : p.outline.kind === 'chapter-marks'
                        ? ' · 有章节标题'
                        : ' · 无目录'}
                    {p.subject.source !== 'none' ? ` · 科目：${p.subject.name}` : ''}
                  </div>

                  {/*
                   * ⚠️ 未解析完只提示、不拦（方案第八节，用户明确要求）。
                   * 这里**没有** disabled —— 按钮始终可点。
                   */}
                  {!complete ? (
                    <p className="maphome-row__warn">{p.completeness.message}</p>
                  ) : null}
                  {!hasUsableContent ? (
                    <p className="maphome-row__warn">
                      这份资料还没有正文，排不出路线。先到「文档解析」把它解析完。
                    </p>
                  ) : null}
                </div>

                <div className="maphome-row__actions">
                  {sum ? (
                    <button
                      type="button"
                      className="btn-fill btn-fill--sm"
                      onClick={() => onOpen(id)}
                    >
                      查看地图 →
                    </button>
                  ) : (
                    <>
                      {/*
                       * 科目与联网只在"要创建"时才需要填。
                       * 已经有地图的行不显示这两个输入 —— 那会把行撑得很高，
                       * 而且对一个已有地图的资料改科目没有意义（重规划在二级页）。
                       */}
                      <label className="maphome-field">
                        <span className="maphome-field__label">科目</span>
                        <input
                          className="maphome-field__input"
                          type="text"
                          value={subjectDraft[id] ?? ''}
                          onChange={(e) =>
                            setSubjectDraft((cur) => ({ ...cur, [id]: e.target.value }))
                          }
                          placeholder="如：高等数学"
                          disabled={busy}
                        />
                      </label>

                      {/*
                        * ⚠️ 2026-11-22 下午：没配搜索 Key **不再置灰**。
                        *
                        * 以前没 Key 就整条不可用（勾选框 disabled）。现在
                        * 没 Key 会借用后端模型自带的联网（用户明确要求）。
                        * 所以这个勾选框始终可点 —— 勾了就是"这次要联网"，
                        * 具体走哪条路由系统自己选，用户不用管。
                        */}
                      <label
                        className="maphome-check"
                        title={
                          hasSearchKey
                            ? '会用搜索 API 查（结果更原始）'
                            : '没配搜索 API，会用后端模型自带的联网能力查（探不通就不联网，会如实告诉你）'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={wantSearch[id] === true}
                          onChange={(e) =>
                            setWantSearch((cur) => ({ ...cur, [id]: e.target.checked }))
                          }
                          disabled={busy}
                        />
                        联网查章节
                      </label>

                      {/*
                       * 「联网找资料」粒度（2026-11-23 用户拍板做成可选项）。
                       *
                       * 只在勾了联网之后才出现 —— 不联网就没有预搜，
                       * 摆了选择等于假开关（硬约束 11）。
                       * 代价提示用 `describePresearchCostEstimate` 生成：
                       * 一级页没有真树（树是创建时 AI 排的），所以话术是
                       * **估算**并明说估算；建图完成后 App 会用真实任务数
                       * 汇报确数，两边同源可对照。
                       */}
                      {wantSearch[id] === true ? (
                        <div className="maphome-gran">
                          <span className="maphome-field__label">找资料粒度</span>
                          <label className="maphome-gran__opt">
                            <input
                              type="radio"
                              name={`gran-${id}`}
                              checked={(granularity[id] ?? 'chapter') === 'chapter'}
                              onChange={() => setGranularity((cur) => ({ ...cur, [id]: 'chapter' }))}
                              disabled={busy}
                            />
                            按章（推荐）
                          </label>
                          <label className="maphome-gran__opt">
                            <input
                              type="radio"
                              name={`gran-${id}`}
                              checked={granularity[id] === 'section'}
                              onChange={() => setGranularity((cur) => ({ ...cur, [id]: 'section' }))}
                              disabled={busy}
                            />
                            按小节（更全，慢且花钱）
                          </label>
                          <p className="maphome-gran__cost">
                            {describePresearchCostEstimate({
                              chapterCount: p.coverage
                                ? p.coverage.to - p.coverage.from + 1
                                : null,
                              granularity: granularity[id] ?? 'chapter',
                            })}
                          </p>
                        </div>
                      ) : null}

                      <button
                        type="button"
                        className="btn-fill btn-fill--sm"
                        onClick={() => void create(p)}
                        disabled={busy}
                      >
                        {busy ? '正在规划…' : '创建地图'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="map-home__foot">
        {hasSearchKey
          ? '「联网查章节」会走搜索 API（结果是网页摘录，依据更原始）。'
          : '「联网查章节」没配搜索 API 也能用 —— 会借用后端模型自带的联网能力；探不通就不联网，并如实告诉你。到「设置」里填搜索 Key 可以换成更原始的依据。'}
      </p>
    </div>
  );
}