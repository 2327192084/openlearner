/**
 * 学习路线的规划面板（2026-11-21 深夜，第二轮重做）。
 *
 * ## 用户改了口径
 *
 * 第一版依据**知识点**规划。用户要求改成**依据资料本体**：
 *
 * > 对有目录的资料，依据目录内容分析出所学科目，自主分析配合网上检索
 * > 规划学习路线。对于没有目录的资料，可以询问用户资料涉及的科目
 * > 再结合自主判断，判断出资料有关科目然后规划方法和上述一样。
 * > （没有目录的资料要注意边界，规划的路线不能超出现有资料内容范围。）
 *
 * ## 用户确认过的四个决定
 *
 * | 问题 | 选择 |
 * |---|---|
 * | 联网检索 | **真联网**（接搜索 API），且由用户在页面上勾选决定这次搜不搜 |
 * | 规划依据 | 「资料本体 + 检索」，**不再以知识点为骨架** |
 * | 资料只解析了一部分 | **挡住，先提示补解析** |
 * | 科目推断 | **先告知推定的科目，用户确认后才规划** |
 *
 * ## 这个面板的四段（按用户的操作顺序）
 *
 * 1. **选资料** —— 每份标出「能不能排」与原因（不能排的不隐藏，要说清楚）
 * 2. **确认科目** —— 展示推定值与依据，可改
 * 3. **勾联网** —— 默认不勾（不静默消耗额度）
 * 4. **生成** —— 出路线
 *
 * ## 为什么把「不能排」的资料也列出来
 *
 * 用户明确要「挡住，先提示补解析」。但**挡住不等于隐藏** ——
 * 如果那份资料从列表里消失，用户会以为它没被导入。
 * 所以列出来、标明原因、给一个去解析的入口。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceService } from '@/core/sources.ts';
import { RouteBoard } from './RouteBoard.tsx';
import type { SourceRoute } from '@/core/ai/source-route.ts';
import { attachSegments, parseSourceRoute } from '@/core/ai/source-route.ts';
import { buildSubjectQuery, searchWeb, type SearchResult } from '@/core/ai/web-search.ts';
import {
  loadSourceSegments,
  prepareSourcePlans,
  toScopeInfo,
  type SourcePlanPrep,
} from '@/v2/core/source-plan-inputs.ts';

/** 由 App 注入的 AI 能力（读凭据、发请求都在 App，与其它 AI 功能同分工） */
export interface RouteAi {
  /** 让 AI 排路线。传入的是已构造好的提示词两段 */
  orderRoute: (input: {
    prep: SourcePlanPrep;
    subjectName: string;
    search: SearchResult | null;
  }) => Promise<SourceRoute>;
}

export interface RoutePlannerProps {
  sourceService: SourceService;
  ai: RouteAi;
  /** 读搜索 API Key（从设置里来；没有就返回 null = 不联网） */
  readSearchKey: () => Promise<string | null>;
  /** 保存确认后的路线 */
  onSaved: (route: SourceRoute) => Promise<void>;
  /** 去「文档解析」补解析 */
  onOpenParse: () => void;
  /** 已保存的路线（有就显示成横板地图） */
  saved: SourceRoute | null;
  onClearSaved: () => Promise<void>;
  /**
   * 每章的覆盖情况：章号 → { 段数, 已出题的段数 }。
   *
   * 横板图的「走过没走过」按它算。没有就不显示进度
   * （不猜 —— 「这一章学完了吗」在数据里没有答案）。
   */
  coverageByChapter?: ReadonlyMap<number, { segments: number; withQuestions: number }>;
  /** 题目的锚点还有效吗（见 RouteBoard 的说明） */
  anchorHealth?: { total: number; resolved: number };
  /** 点横板上某一步：去学这一章 */
  onStep?: (step: import('@/core/ai/source-route.ts').RouteStep) => void;
}

type Stage = 'pick' | 'confirm' | 'generating';

export function RoutePlanner(props: RoutePlannerProps) {
  const { sourceService, ai, readSearchKey, onSaved, onOpenParse, saved, onClearSaved, coverageByChapter, anchorHealth, onStep } = props;

  const [preps, setPreps] = useState<SourcePlanPrep[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 选中的资料 */
  const [pickedId, setPickedId] = useState<string | null>(null);
  /** 科目确认：用户可改 */
  const [subjectName, setSubjectName] = useState('');
  /** 这次要不要联网 */
  const [wantSearch, setWantSearch] = useState(false);
  /** 有没有配搜索 Key（决定勾选框能不能点） */
  const [hasSearchKey, setHasSearchKey] = useState<boolean | null>(null);

  const [stage, setStage] = useState<Stage>('pick');
  const [err, setErr] = useState<string | null>(null);
  /** 检索过程中的说明（如实告诉用户搜没搜到） */
  const [searchNote, setSearchNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await prepareSourcePlans({ sourceService });
      setPreps(r.sources);
      /*
       * 默认选中第一份「能排」的 —— 让用户在一堆「这份不能排」里
       * 自己找能用的，是没必要的负担。
       */
      const firstReady = r.sources.find((p) => p.completeness.ok && p.segmentCount > 0);
      setPickedId((cur) => cur ?? firstReady?.source.id ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '读不出资料');
    }
  }, [sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 读搜索 Key 状态（只用来决定勾选框是否可用） */
  useEffect(() => {
    void readSearchKey()
      .then((k) => setHasSearchKey(!!k && k.trim().length > 0))
      .catch(() => setHasSearchKey(false));
  }, [readSearchKey]);

  const picked = useMemo(
    () => preps?.find((p) => p.source.id === pickedId) ?? null,
    [preps, pickedId],
  );

  /** 选中资料后，把推定的科目填进输入框（用户可改） */
  useEffect(() => {
    if (!picked) return;
    setSubjectName(picked.subject.name);
  }, [picked]);

  /* ---------- 生成 ---------- */

  const generate = useCallback(async () => {
    if (!picked) return;
    if (!picked.completeness.ok) {
      setErr(picked.completeness.message);
      return;
    }
    if (subjectName.trim().length === 0) {
      setErr('这门课是什么科目？填一下再规划 —— 路线要按学科常规排，没有科目就排不准。');
      return;
    }

    setStage('generating');
    setErr(null);
    setSearchNote(null);

    try {
      /* ---------- 1. 需要时先联网检索 ---------- */
      let search: SearchResult | null = null;
      if (wantSearch) {
        const key = await readSearchKey();
        const query = buildSubjectQuery(subjectName, picked.subject.edition);
        search = await searchWeb(query, key);
        setSearchNote(
          search.searched
            ? `联网搜到了 ${search.hits.length} 条参考资料。`
            : search.note,
        );
      }

      /* ---------- 2. 排路线 ---------- */
      const route = await ai.orderRoute({
        prep: picked,
        subjectName: subjectName.trim(),
        search,
      });

      /* ---------- 3. 回填「这一步对应资料里的哪些段」 ---------- */
      const segs = await loadSourceSegments(sourceService, picked.source.id);
      const withSegs = attachSegments(route, toScopeInfo(picked, segs));

      await onSaved(withSegs);
      setStage('pick');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '规划失败');
      setStage('pick');
    }
  }, [picked, subjectName, wantSearch, readSearchKey, ai, sourceService, onSaved]);

  /* ==================== 渲染 ==================== */

  if (loadError) {
    return (
      <section className="rmap">
        <h2 className="rmap__title">学习路线</h2>
        <p className="map-error">{loadError}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </section>
    );
  }

  if (!preps) {
    return (
      <section className="rmap">
        <h2 className="rmap__title">学习路线</h2>
        <p className="map-hint">正在读资料…</p>
      </section>
    );
  }

  if (preps.length === 0) {
    return (
      <section className="rmap">
        <h2 className="rmap__title">学习路线</h2>
        <p className="rmap__lead">
          还没有资料。先到「资料」里导入教材或讲义，路线会依据资料目录来排。
        </p>
      </section>
    );
  }

  return (
    <section className="rmap rmap--planner">
      <header className="rmap__head">
        <h2 className="rmap__title">学习路线</h2>
        <p className="rmap__lead">
          路线<b>依据资料本体</b>排：有目录的按目录走，没有目录的先确认科目，
          再按内容分块。AI 会先看目录、必要时联网查这门课的常规章节结构，
          最后排出顺序。
        </p>
      </header>

      {/* ==================== 已保存的路线：横板地图 ==================== */}
      {/*
        * ⚠️ 2026-11-21 深夜修：原来这里只有一行文字摘要
        * （「已确认的路线：信号与系统 · 3 块 · 3 步」），**没有任何图**。
        * 用户直接指出「我没找到地图的入口」—— 他要的是看得见路线和进度的图。
        *
        * 根因是我从知识点级换成资料级时，只重写了规划表单，
        * 忘了给新数据结构（SourceRoute）写渲染器。
        * `RouteMap.tsx`（知识点级）视觉语言仍然适用，但数据结构不同，
        * 所以新写 `RouteBoard.tsx`，视觉参数刻意与它保持一致。
        */}
      {saved ? (
        <RouteBoard
          route={saved}
          {...(coverageByChapter ? { coverageByChapter } : {})}
          {...(anchorHealth ? { anchorHealth } : {})}
          {...(onStep ? { onStep } : {})}
          onReplan={() => {
            /* 重新规划 = 回到表单（不清掉已确认的，用户可能只是看看） */
            setStage('pick');
            setErr(null);
          }}
          onClear={() => void onClearSaved()}
          busy={stage === 'generating'}
        />
      ) : null}

      {/* ==================== 第 1 步：选资料 ==================== */}
      <div className="rsp-section">
        <h3 className="rsp-h3">
          <span className="rsp-num">1</span>
          选一份资料
        </h3>
        <p className="rsp-hint">
          只解析了一部分的资料会被挡住 —— 那种资料排出来的路线会跑偏。
          先补解析再回来。
        </p>

        <ul className="rsp-list">
          {preps.map((p) => {
            const usable = p.completeness.ok && p.segmentCount > 0;
            const isPicked = p.source.id === pickedId;
            return (
              <li key={p.source.id} className="rsp-item">
                <label
                  className={
                    'rsp-label' +
                    (isPicked ? ' rsp-label--on' : '') +
                    (usable ? '' : ' rsp-label--blocked')
                  }
                >
                  <input
                    type="radio"
                    name="rsp-source"
                    className="rsp-radio"
                    checked={isPicked}
                    onChange={() => setPickedId(p.source.id)}
                  />
                  <span className="rsp-body">
                    <span className="rsp-title">{p.source.title}</span>
                    <span className="rsp-meta">
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
                    </span>
                    {!usable ? (
                      <span className="rsp-blocked">{p.completeness.message}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {picked && !picked.completeness.ok ? (
          <button type="button" className="btn-ghost" onClick={onOpenParse}>
            去「文档解析」补解析
          </button>
        ) : null}
      </div>

      {/* ==================== 第 2 步：确认科目 ==================== */}
      {picked && picked.completeness.ok ? (
        <div className="rsp-section">
          <h3 className="rsp-h3">
            <span className="rsp-num">2</span>
            确认科目
          </h3>

          <div className="rsp-guess">
            {picked.subject.source === 'none' ? (
              <p className="rsp-guess__none">
                这份资料看不出是什么科目（<b>没有硬猜</b>）。
                填一下这门课是什么，路线才能按学科常规排。
              </p>
            ) : (
              <p className="rsp-guess__found">
                我理解这是 <b>{picked.subject.name}</b>
                {picked.subject.edition ? `（${picked.subject.edition}）` : ''}
                <span className="rsp-guess__why"> —— {picked.subject.evidence}</span>
                {picked.subject.source === 'content' ? (
                  <span className="rsp-guess__weak">（从正文关键词推的，可能不准）</span>
                ) : null}
              </p>
            )}

            <label className="rsp-field">
              <span className="rsp-field__label">科目</span>
              <input
                className="rsp-input"
                type="text"
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                placeholder="如：高等数学 / 信号与系统"
              />
            </label>
          </div>

          {/* 覆盖范围说明（用户点名的边界） */}
          <div className="rsp-scope">
            {picked.coverage ? (
              <>
                <p>
                  这份资料覆盖 <b>第 {picked.coverage.from}~{picked.coverage.to} 章</b>
                  {picked.coverage.declaredTo !== null ? (
                    <span className="rsp-scope__warn">
                      ，但目录列到第 {picked.coverage.declaredTo} 章 —— 后面的章节资料里没有，
                      路线不会排进去
                    </span>
                  ) : null}
                  。
                </p>
                {!picked.coverage.complete ? (
                  <p className="rsp-scope__warn">
                    ⚠️ 章号不连续（这份资料是节选）。路线只会覆盖现有这几章。
                  </p>
                ) : null}
              </>
            ) : (
              <p>
                这份资料没有章节结构，路线会按内容主题分块（不编造章号）。
              </p>
            )}
          </div>
        </div>
      ) : null}

      {/* ==================== 第 3 步：联网选项 ==================== */}
      {picked && picked.completeness.ok ? (
        <div className="rsp-section">
          <h3 className="rsp-h3">
            <span className="rsp-num">3</span>
            联网检索（可选）
          </h3>
          <label className="rsp-check">
            <input
              type="checkbox"
              className="rsp-check__box"
              checked={wantSearch}
              onChange={(e) => setWantSearch(e.target.checked)}
              disabled={hasSearchKey === false}
            />
            <span className="rsp-check__text">
              这次规划时联网查一下这门课的常规章节结构
              {hasSearchKey === false ? (
                <span className="rsp-check__off">
                  （还没配搜索 API Key，到「设置」里可以填）
                </span>
              ) : (
                <span className="rsp-check__on">
                  （会按「{buildSubjectQuery(subjectName, picked.subject.edition)}」检索，
                  消耗搜索额度）
                </span>
              )}
            </span>
          </label>
        </div>
      ) : null}

      {/* ==================== 生成 ==================== */}
      {picked && picked.completeness.ok ? (
        <div className="rsp-actions">
          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => void generate()}
            disabled={stage === 'generating' || subjectName.trim().length === 0}
          >
            {stage === 'generating' ? '正在规划…' : '规划学习路线'}
          </button>
          {err ? <p className="map-error">{err}</p> : null}
          {searchNote ? <p className="rsp-hint">{searchNote}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** 供 App 用：把 AI 返回的原始文本解析成路线 */
export function toRoute(
  raw: string,
  prep: SourcePlanPrep,
  subject: { name: string; edition: string },
  usedSearch: boolean,
  segments: Parameters<typeof toScopeInfo>[1],
): SourceRoute {
  const parsed = parseSourceRoute(raw, toScopeInfo(prep, segments), subject, usedSearch);
  if (!parsed.ok) throw new Error(parsed.reason);
  return attachSegments(parsed.route, toScopeInfo(prep, segments));
}