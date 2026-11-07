/**
 * 知识骨架：把知识点按「资料 → 章节 → 认知层级」摆成一张结构表。
 *
 * ## 它和「知识库」有什么区别（别做成同一件东西）
 *
 * - **知识库**：按文件归类，重点是「读」—— 一条条看知识点、点回原文。
 * - **知识骨架**：按**结构**看 —— 这门课有几章、每章多少条、
 *   认知层级分布如何、哪些概念反复出现（tags）。
 *
 * 前者回答「这份资料讲了什么」，后者回答「这门课的整体脉络长什么样，
 * 我哪一层还薄」。两者的数据源相同，但用途和呈现完全不同。
 *
 * ## 数据全部来自 knowledgePoints，不新增存储
 *
 * `chapter` / `cognitiveLevel` / `tags` 都是整理时就写好的字段。
 * 这一页只做聚合与展示 —— 只读，不动任何数据。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';

export interface SkeletonPageProps {
  knowledge: KnowledgeService;
  sourceService: SourceService;
  /** 点某条知识点 → 去知识库看它 */
  onOpenKnowledge: () => void;
  /** 去整理（还没有知识点时） */
  onOpenOrganize: (sourceId: string | null) => void;
}

/** 认知层级的显示名（顺序即由浅到深） */
const LEVELS = [
  { key: 'remember', label: '记忆', hint: '能记住定义与事实' },
  { key: 'understand', label: '理解', hint: '能解释、能举例' },
  { key: 'apply', label: '应用', hint: '能用来解题' },
  { key: 'analyze', label: '分析', hint: '能比较、能推论' },
] as const;

type Level = (typeof LEVELS)[number]['key'];

/** 一个章节的聚合 */
interface ChapterGroup {
  chapter: string;
  count: number;
  byLevel: Record<Level, number>;
  /** 未定位的条数（整理时没能对上原文的） */
  unlocated: number;
}

/** 一份资料的结构 */
interface SourceGroup {
  sourceId: string;
  title: string;
  total: number;
  chapters: ChapterGroup[];
  byLevel: Record<Level, number>;
  unlocated: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; groups: SourceGroup[]; topTags: { tag: string; count: number }[] };

export function SkeletonPage({
  knowledge,
  sourceService,
  onOpenKnowledge,
  onOpenOrganize,
}: SkeletonPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  /** 展开的资料（默认全展开，用户点过才收） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const sources = await sourceService.list();
      const perSource = await Promise.all(
        sources.map(async (s: Source) => ({
          source: s,
          points: await knowledge.listBySource(s.id),
        })),
      );

      const groups: SourceGroup[] = [];
      const tagCount = new Map<string, number>();

      for (const { source, points } of perSource) {
        if (points.length === 0) continue;

        const byLevel = emptyLevels();
        const chapterMap = new Map<string, ChapterGroup>();
        let unlocated = 0;

        for (const p of points) {
          byLevel[p.cognitiveLevel] += 1;
          /*
           * 只有 `unlocated` 才算「需要处理」。
           *
           * `waived` 是用户人工确认过「这条本来就没有出处」（比如模型的总结性表述），
           * 把它算成未定位会让警告数字永远消不掉 —— 那等于在催用户处理
           * 一件他已经处理过的事。
           */
          if (p.anchorStatus === 'unlocated') unlocated += 1;

          /*
           * 章节为空的知识点归到「未归章」。
           * 不猜它是第几章 —— 那样用户按章节对照原书会错位。
           */
          const key = p.chapter?.trim() || UNCHAPTERED;
          const g = chapterMap.get(key) ?? {
            chapter: key,
            count: 0,
            byLevel: emptyLevels(),
            unlocated: 0,
          };
          g.count += 1;
          g.byLevel[p.cognitiveLevel] += 1;
          if (p.anchorStatus === 'unlocated') g.unlocated += 1;
          chapterMap.set(key, g);

          for (const t of p.tags) {
            tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
          }
        }

        groups.push({
          sourceId: source.id,
          title: source.title,
          total: points.length,
          /* 章节按名字排序：「第1章」「第2章」…「第10章」需要自然序 */
          chapters: [...chapterMap.values()].sort((a, b) => naturalCompare(a.chapter, b.chapter)),
          byLevel,
          unlocated,
        });
      }

      groups.sort((a, b) => b.total - a.total);
      const topTags = [...tagCount.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      setState({ kind: 'ready', groups, topTags });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出知识结构',
      });
    }
  }, [knowledge, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = state.kind === 'ready' ? state.groups : [];
  const topTags = state.kind === 'ready' ? state.topTags : [];

  /** 全库层级汇总 */
  const totals = useMemo(() => {
    const acc = emptyLevels();
    let total = 0;
    let unchaptered = 0;
    for (const g of groups) {
      for (const lv of LEVELS) acc[lv.key] += g.byLevel[lv.key];
      total += g.total;
      const un = g.chapters.find((c) => c.chapter === UNCHAPTERED);
      if (un) unchaptered += un.count;
    }
    return { byLevel: acc, total, unchaptered };
  }, [groups]);

  /**
   * 章节信息缺失的比例很高时提示用户。
   *
   * 实测发现：整理出来的 86 条知识点里 85 条没有 chapter ——
   * 因为整理提示词没有强制模型输出章节，它大多就不给了。
   *
   * 问题是：这会让「骨架」几乎全堆在「未归章」里，看起来像功能坏了。
   * 与其让用户猜，不如如实说明原因，并给出可操作的下一步。
   * 阈值取 60%：过半缺失才值得提示，否则提示会变成噪音。
   */
  const chapterMissing = totals.total > 0 && totals.unchaptered / totals.total >= 0.6;

  if (state.kind === 'loading') {
    return (
      <div className="skeleton-page">
        <p className="sk-hint">正在读知识结构…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="skeleton-page">
        <p className="sk-error">{state.message}</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="skeleton-page">
        <header className="sk-head">
          <h1 className="sk-title">知识骨架</h1>
        </header>
        <div className="sk-empty">
          <p>还没有整理出知识点，所以还看不到骨架。</p>
          <p className="sk-hint">
            骨架是按知识点的「章节」和「认知层级」聚合出来的 —— 数据来自整理这一步。
          </p>
          <button type="button" className="btn-ghost" onClick={() => onOpenOrganize(null)}>
            去整理知识点
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="skeleton-page">
      <header className="sk-head">
        <h1 className="sk-title">知识骨架</h1>
        <p className="sk-lead">
          按「资料 → 章节」摊开全部知识点，并标出每一章在各认知层级上的分布。
          用来判断这门课的整体脉络，以及哪一层还薄。
        </p>
      </header>

      {/* ---- 全库层级分布 ---- */}
      <section className="sk-overview">
        <div className="sk-overview__head">
          <span className="sk-overview__total">{totals.total} 条知识点</span>
          <button type="button" className="btn-text" onClick={onOpenKnowledge}>
            去知识库逐条看
          </button>
        </div>
        <div className="sk-levels">
          {LEVELS.map((lv) => {
            const n = totals.byLevel[lv.key];
            const pct = totals.total > 0 ? (n / totals.total) * 100 : 0;
            return (
              <div key={lv.key} className="sk-level">
                <div className="sk-level__top">
                  <span className="sk-level__label">{lv.label}</span>
                  <span className="sk-level__n">{n}</span>
                </div>
                <div className="sk-level__bar">
                  <div
                    className={`sk-level__fill sk-level__fill--${lv.key}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="sk-level__hint">{lv.hint}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- 章节信息缺失提示 ---- */}
      {chapterMissing ? (
        <div className="sk-notice">
          <p className="sk-notice__title">章节信息大多缺失</p>
          <p className="sk-notice__body">
            现有 {totals.total} 条知识点里，有 {totals.unchaptered} 条没有记下所属章节，
            所以下面几乎都归在「未归章」里。这不是骨架功能的问题 ——
            是整理那一步没有产出章节信息。
            <br />
            想让骨架按章排布，需要重新整理（整理提示词会带上章节要求）。
            重新整理会覆盖这份资料的现有知识点，所以是否重跑由你决定。
          </p>
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => onOpenOrganize(null)}>
            去整理知识点
          </button>
        </div>
      ) : null}

      {/* ---- 高频标签 ---- */}
      {topTags.length > 0 ? (
        <section className="sk-tags">
          <h2 className="sk-subtitle">反复出现的概念</h2>
          <div className="sk-tag-list">
            {topTags.map((t) => (
              <span key={t.tag} className="sk-tag">
                {t.tag}
                <span className="sk-tag__n">{t.count}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---- 按资料 → 章节 ---- */}
      <section className="sk-tree">
        <h2 className="sk-subtitle">按资料与章节</h2>
        {groups.map((g) => {
          const isOpen = !collapsed[g.sourceId];
          return (
            <div key={g.sourceId} className="sk-source">
              <button
                type="button"
                className="sk-source__head"
                aria-expanded={isOpen}
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [g.sourceId]: !c[g.sourceId] }))
                }
              >
                <span className={`sk-caret${isOpen ? ' sk-caret--open' : ''}`} aria-hidden="true">
                  ▸
                </span>
                <span className="sk-source__title">{g.title}</span>
                <span className="sk-source__meta">
                  {g.total} 条 · {g.chapters.length} 章
                  {g.unlocated > 0 ? (
                    <span className="sk-warn"> · {g.unlocated} 条未定位</span>
                  ) : null}
                </span>
              </button>

              {isOpen ? (
                <ul className="sk-chapters">
                  {g.chapters.map((c) => (
                    <li key={c.chapter} className="sk-chapter">
                      <div className="sk-chapter__head">
                        <span className="sk-chapter__name">{c.chapter}</span>
                        <span className="sk-chapter__n">{c.count} 条</span>
                        {c.unlocated > 0 ? (
                          <span className="sk-warn">{c.unlocated} 未定位</span>
                        ) : null}
                      </div>
                      {/* 每章的层级小条：四个格子，有数量就填色 */}
                      <div className="sk-chapter__levels" aria-label="认知层级分布">
                        {LEVELS.map((lv) => {
                          const n = c.byLevel[lv.key];
                          return (
                            <span
                              key={lv.key}
                              className={`sk-chip sk-chip--${lv.key}${n > 0 ? ' sk-chip--on' : ''}`}
                              title={`${lv.label}：${n} 条`}
                            >
                              {lv.label.slice(0, 1)}
                              <span className="sk-chip__n">{n}</span>
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function emptyLevels(): Record<Level, number> {
  return { remember: 0, understand: 0, apply: 0, analyze: 0 };
}

/**
 * 「未归章」这一组的固定名字。
 *
 * 单独拎出来是因为它的排序位置有特殊要求：**永远排最后**。
 * 它不是一个真正的章节，而是一堆「整理时没给出章节」的知识点，
 * 混在正文章节中间会让用户以为原书真有这么一章。
 */
export const UNCHAPTERED = '未归章';

/**
 * 自然序比较：「第2章」要排在「第10章」前面。
 *
 * 直接字典序会得到 第10章 < 第2章 —— 用户按章节对照原书时会完全错位。
 * 这里把字符串里的数字段单独比大小。
 *
 * 另外两条特例（都是截图/测试暴露出来的）：
 *  1. 「未归章」永远排最后，不参与常规比较；
 *  2. 纯文字章节之间用**本地化**比较（localeCompare），
 *     而不是码位比较 —— 中文按码位排出来的顺序对用户没有意义
 *     （例如「附录」与「正文」：码位上「正」在前，但那不是人期望的章序）。
 */
function naturalCompare(a: string, b: string): number {
  /* 「未归章」沉底 */
  const aUn = a === UNCHAPTERED;
  const bUn = b === UNCHAPTERED;
  if (aUn && bUn) return 0;
  if (aUn) return 1;
  if (bUn) return -1;

  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      /*
       * 纯文字段用 localeCompare（中文环境按拼音/笔画），
       * 不用码位比较 —— 后者对中文没有语义，排出来的顺序看着是随机的。
       */
      return x.localeCompare(y, 'zh-CN');
    }
  }
  return pa.length - pb.length;
}

/** 供测试复用 */
export { naturalCompare };
