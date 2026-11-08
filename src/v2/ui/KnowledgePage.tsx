import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KnowledgePoint, Source } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { IconBook } from './icons.tsx';
import { ConfirmDialog } from './dialog.tsx';
import { MathText } from './MathText.tsx';

/**
 * 知识库 —— 按资料文件归类所有知识点。
 *
 * ## 为什么要这一页（2026-11-07 用户要求）
 *
 * 原话：「应该做个知识库界面，将不同文件产生的知识点放进去，
 * 然后将文件对应的知识点归属到那个文件名下」。
 *
 * 在此之前，知识点只能从「整理知识点」页看**单份资料**的结果 ——
 * 出完题之后再也没有任何地方能看到全库的知识点，
 * 用户不知道哪些知识点已经整理过、分布在哪些文件里。
 *
 * ## 组织方式
 *
 * 两层：**文件 → 章节 → 知识点**。
 *  - 第一层按 sourceId 分组，标题用资料名（文件的原始标题）
 *  - 第二层按 chapter 分组（整理时按标题切过章）
 *  - 没有 chapter 的归到「未分章」
 *
 * 这样用户能一眼看出「这份教材整理出了哪些知识点、分别在哪一章」。
 *
 * ## 为什么不做编辑
 *
 * 这一版只做**看**。编辑知识点涉及重新定位（锚点会失效）、
 * 与已出题目的一致性等问题，属于另一条岔路，需要单独设计。
 * 先让用户能看见全貌，比先给一个半成品的编辑器有用。
 */

export interface KnowledgePageProps {
  knowledge: KnowledgeService;
  sourceService: SourceService;
  /** 点知识点的「可点回原文」跳阅读器 */
  onOpenAnchor?: (target: {
    sourceId: string;
    page?: number;
    charStart?: number;
    charEnd?: number;
    quote?: string;
  }) => void;
  /** 去「整理知识点」补一份资料的正文 */
  onOpenOrganize?: (sourceId: string) => void;
  /**
   * 删除一条知识点（2026-11-08）。
   *
   * 由上层传入而不是页面自己调：删除要经过回收站，
   * 页面不该知道回收站在哪 —— 交给 App 层的服务组合决定。
   * 不传则**不显示删除按钮**（不摆假按钮）。
   */
  onRemovePoint?: (id: string) => Promise<void>;
  /**
   * 删掉一份资料的全部知识点（2026-11-08）。
   *
   * 参数是资料 id；`null` 对应「没有归属资料」那一组。
   */
  onRemoveSourcePoints?: (sourceId: string | null) => Promise<void>;
}

interface SourceGroup {
  sourceId: string | null;
  title: string;
  source: Source | null;
  points: KnowledgePoint[];
  /** 按章节分好的组，保持首次出现顺序 */
  chapters: Array<{ name: string; points: KnowledgePoint[] }>;
  /** 定位成功 / 失败的条数 */
  located: number;
  unlocated: number;
}

const UNCHAPTERED = '未分章';

export function KnowledgePage({
  knowledge,
  sourceService,
  onOpenAnchor,
  onOpenOrganize,
  onRemovePoint,
  onRemoveSourcePoints,
}: KnowledgePageProps) {
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 收起了哪些文件（默认全展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  /**
   * 待确认的删除（2026-11-08）。
   *
   * 两种都走同一个确认框：
   *  - `{ kind: 'point' }` 删一条
   *  - `{ kind: 'source' }` 删一组（一份资料的全部知识点）
   *
   * 为什么不直接删：删一组可能是一次几十上百条的操作，
   * 点错代价太大。虽然能进回收站还原，但让用户多点一次确认
   * 比事后去回收站翻要省事。
   */
  const [pending, setPending] = useState<
    | { kind: 'point'; id: string; label: string }
    | { kind: 'source'; sourceId: string | null; label: string; count: number }
    | null
  >(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const srcs = await sourceService.list();

      /*
       * KnowledgeService 只有 `listBySource(sourceId)`，没有「列出全部」。
       *
       * 这里逐个资料取一次，而不是给 core 加一个 listAll：
       *  - 资料数量是几十级别，一次性并发取完的代价可以接受；
       *  - 加接口要动 core 的分区读取约定，还要补测试，
       *    而这一页只是「看」，不值得为它扩存储层。
       */
      const perSource = await Promise.all(
        srcs.map(async (s) => knowledge.listBySource(s.id)),
      );

      setSources(srcs);
      setPoints(perSource.flat());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出知识库');
    }
  }, [knowledge, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 执行删除（2026-11-08）。
   *
   * 删完统一 `load()` 重新取，而不是就地 `setPoints` 过滤：
   * 删一组时服务端会连带处理，本地过滤容易和实际状态不一致 ——
   * 而那正是「同一屏数字对不上」的来源。
   */
  const doRemove = useCallback(async () => {
    if (!pending) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      if (pending.kind === 'point') {
        await onRemovePoint?.(pending.id);
      } else {
        await onRemoveSourcePoints?.(pending.sourceId);
      }
      setPending(null);
      await load();
    } catch (err) {
      // 错误留在框里，不关框 —— 用户需要知道为什么没删掉
      setRemoveError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setRemoving(false);
    }
  }, [pending, onRemovePoint, onRemoveSourcePoints, load]);

  /** 分组：文件 → 章节 */
  const groups = useMemo<SourceGroup[]>(() => {
    const all = points ?? [];
    const bySource = new Map<string | null, KnowledgePoint[]>();
    for (const p of all) {
      const key = p.sourceId ?? null;
      const list = bySource.get(key) ?? [];
      list.push(p);
      bySource.set(key, list);
    }

    const out: SourceGroup[] = [];
    for (const [sourceId, list] of bySource) {
      const source = sources.find((s) => s.id === sourceId) ?? null;
      // 章节顺序按首次出现，保留资料本身的阅读顺序
      const chapterMap = new Map<string, KnowledgePoint[]>();
      for (const p of list) {
        const name = p.chapter?.trim() || UNCHAPTERED;
        const arr = chapterMap.get(name) ?? [];
        arr.push(p);
        chapterMap.set(name, arr);
      }
      out.push({
        sourceId,
        title: source?.title ?? (sourceId ? '已删除的资料' : '没有归属文件'),
        source,
        points: list,
        chapters: [...chapterMap.entries()].map(([name, pts]) => ({ name, points: pts })),
        located: list.filter((p) => p.anchors.length > 0).length,
        unlocated: list.filter((p) => p.anchors.length === 0).length,
      });
    }

    // 有资料的排前面，按资料列表顺序；孤儿与无归属排最后
    const order = new Map(sources.map((s, i) => [s.id, i]));
    return out.sort((a, b) => {
      const ai = a.sourceId ? (order.get(a.sourceId) ?? 999) : 1000;
      const bi = b.sourceId ? (order.get(b.sourceId) ?? 999) : 1000;
      return ai - bi;
    });
  }, [points, sources]);

  /** 搜索过滤（按 statement / quote / 章节名） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        const chapters = g.chapters
          .map((c) => ({
            ...c,
            points: c.points.filter(
              (p) =>
                p.statement.toLowerCase().includes(q) ||
                p.quotes.some((qt) => qt.toLowerCase().includes(q)) ||
                c.name.toLowerCase().includes(q),
            ),
          }))
          .filter((c) => c.points.length > 0);
        const points2 = chapters.flatMap((c) => c.points);
        return { ...g, chapters, points: points2 };
      })
      .filter((g) => g.points.length > 0 || g.title.toLowerCase().includes(q));
  }, [groups, query]);

  const totalPoints = points?.length ?? 0;
  const totalLocated = (points ?? []).filter((p) => p.anchors.length > 0).length;

  if (points === null && !error) {
    return (
      <div className="kb-page">
        <p className="kb-lead">正在读知识库…</p>
      </div>
    );
  }

  return (
    <div className="kb-page">
      <header className="kb-head">
        <div>
          <h1 className="kb-title">知识库</h1>
          <p className="kb-lead">
            所有整理出来的知识点都收在这里，按来源文件归类。共 {totalPoints} 条
            {totalPoints > 0 ? `，其中 ${totalLocated} 条能点回原文` : ''}。
          </p>
        </div>
      </header>

      {error ? <div className="kb-error">{error}</div> : null}

      {totalPoints > 0 ? (
        <div className="kb-search">
          <input
            className="kb-search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜知识点、原文引用或章节名…"
          />
          {query ? (
            <button type="button" className="btn-ghost" onClick={() => setQuery('')}>
              清空
            </button>
          ) : null}
        </div>
      ) : null}

      {totalPoints === 0 ? (
        <div className="kb-empty">
          <IconBook size={30} />
          <p className="kb-empty__title">知识库还是空的</p>
          <p className="kb-hint">
            知识点是从资料正文里整理出来的。先到「资料」导入一份讲义，
            再去「整理知识点」把它过一遍，结果就会出现在这里。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="kb-hint">没有匹配「{query}」的知识点。</p>
      ) : (
        <div className="kb-files">
          {filtered.map((group) => {
            const key = group.sourceId ?? '__none__';
            const isCollapsed = collapsed.has(key);
            const toggle = () =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });

            return (
              <section key={key} className="kb-file">
                <button
                  type="button"
                  className="kb-file__head"
                  onClick={toggle}
                  aria-expanded={!isCollapsed}
                >
                  <span className="kb-file__name">{group.title}</span>
                  <span className="kb-file__meta">
                    {group.points.length} 条
                    {group.unlocated > 0 ? ` · ${group.unlocated} 条没定位到原文` : ''}
                    {group.source ? ` · 共 ${group.source.pageCount ?? '?'} 页` : ''}
                  </span>
                  <span className="kb-file__chevron" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                </button>

                {!isCollapsed ? (
                  <div className="kb-file__body">
                    {/*
                      按库删除（2026-11-08）。
                      放在组内顶部而不是每一章：用户想清掉整份资料的知识点时
                      不该逐章点十几遍。
                    */}
                    {onRemoveSourcePoints ? (
                      <button
                        type="button"
                        className="kb-file__remove"
                        onClick={() =>
                          setPending({
                            kind: 'source',
                            sourceId: group.sourceId,
                            label: group.title,
                            count: group.points.length,
                          })
                        }
                      >
                        删除这份资料的全部知识点（{group.points.length} 条）
                      </button>
                    ) : null}
                    {group.chapters.map((chapter) => (
                      <div key={chapter.name} className="kb-chapter">
                        <p className="kb-chapter__name">{chapter.name}</p>
                        <ul className="kb-points">
                          {chapter.points.map((p) => {
                            const anchor = p.anchors[0];
                            return (
                              <li key={p.id} className="kb-point">
                                <p className="kb-point__statement"><MathText text={p.statement} /></p>
                                {p.quotes[0] ? (
                                  <p className="kb-point__quote">
                                    「<MathText text={p.quotes[0] ?? ''} />」
                                  </p>
                                ) : null}
                                <div className="kb-point__foot">
                                  <span className="kb-point__level">
                                    {LEVEL_LABEL[p.cognitiveLevel]}
                                  </span>
                                  {anchor && onOpenAnchor ? (
                                    <button
                                      type="button"
                                      className="kb-point__link"
                                      onClick={() =>
                                        onOpenAnchor({
                                          sourceId: anchor.sourceId,
                                          ...(anchor.page !== undefined ? { page: anchor.page } : {}),
                                          ...(anchor.charStart !== undefined
                                            ? { charStart: anchor.charStart }
                                            : {}),
                                          ...(anchor.charEnd !== undefined
                                            ? { charEnd: anchor.charEnd }
                                            : {}),
                                          ...(p.quotes[0] ? { quote: p.quotes[0] } : {}),
                                        })
                                      }
                                    >
                                      第 {anchor.page ?? '?'} 页
                                    </button>
                                  ) : (
                                    <span className="kb-point__nolink">没找到原文位置</span>
                                  )}
                                  {/*
                                    单条删除（2026-11-08）。
                                    放行尾而不是悬浮出现：这个应用是桌面工具，
                                    用户明确要求「能删」，藏起来反而找不到。
                                  */}
                                  {onRemovePoint ? (
                                    <button
                                      type="button"
                                      className="kb-point__remove"
                                      title="删除这条知识点（可在回收站还原）"
                                      onClick={() =>
                                        setPending({
                                          kind: 'point',
                                          id: p.id,
                                          label: p.statement.slice(0, 40),
                                        })
                                      }
                                    >
                                      删除
                                    </button>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}

                    {/* 这份资料一条知识点都没有时，给一条去整理的路 */}
                    {group.points.length === 0 && group.source && onOpenOrganize ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onOpenOrganize(group.source!.id)}
                      >
                        去整理这份资料
                      </button>
                    ) : null}

                    {group.unlocated > 0 && group.source && onOpenOrganize ? (
                      <p className="kb-file__hint">
                        {group.unlocated} 条没找到原文位置。它们不能用来出题（出题要求能点回原文），
                        <button
                          type="button"
                          className="btn-text kb-file__relink"
                          onClick={() => onOpenOrganize(group.source!.id)}
                        >
                          重新整理一遍
                        </button>
                        通常能补上。
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      {/*
        删除确认（2026-11-08）。
        走共享的 ConfirmDialog：它已经把三件要紧事处理好了 ——
        初始焦点在「取消」、执行中不可重复点、失败时错误留在框里。

        文案里明写「可在回收站还原」：删除本身不是不可逆的，
        用户知道这一点才敢放心整理。但也不轻描淡写 ——
        「30 天后彻底删除」同样说出来。
      */}
      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'point' ? '删除这条知识点？' : `删除「${pending.label}」的全部知识点？`}
          description={
            pending.kind === 'point'
              ? `「${pending.label}」会移进回收站，30 天内可以从那里还原。`
              : `共 ${pending.count} 条知识点会移进回收站，30 天内可以从那里还原。`
          }
          confirmLabel={removing ? '正在删除…' : '删除'}
          tone="danger"
          blocked={removing}
          onConfirm={doRemove}
          onClose={() => {
            if (removing) return;
            setPending(null);
            setRemoveError(null);
          }}
        >
          {removeError ? <p className="kb-remove-error">{removeError}</p> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const LEVEL_LABEL: Record<KnowledgePoint['cognitiveLevel'], string> = {
  remember: '记忆',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
};
