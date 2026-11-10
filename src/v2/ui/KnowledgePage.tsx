import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KnowledgePoint, Source } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { IconBook } from './icons.tsx';
import { ConfirmDialog } from './dialog.tsx';
import { MathText } from './MathText.tsx';
import { KpTagsEditor } from './KpTagsEditor.tsx';
import { COGNITIVE_LEVEL_LABEL, COGNITIVE_LEVEL_META } from '@/core/cognitive-levels.ts';

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
  /**
   * 去「整理知识点」补一份资料的正文。
   *
   * 参数是资料 id；`null` 表示「不指定是哪一份」—— 页头那个常驻按钮
   * 用的就是 null，让整理页自己列出可选资料（2026-11-08）。
   */
  onOpenOrganize?: (sourceId: string | null) => void;
  /**
   * 删除一条知识点（2026-11-08）。
   *
   * 由上层传入而不是页面自己调：删除要经过回收站，
   * 页面不该知道回收站在哪 —— 交给 App 层的服务组合决定。
   * 不传则**不显示删除按钮**（不摆假按钮）。
   */
  onRemovePoint?: (id: string) => Promise<void>;
  /**
   * 改一条知识点的分类标签（2026-11-10）。
   *
   * 只给 tags：它不参与定位（anchors 由 quotes 定位产生），
   * 所以改它不会让「可点回原文」失效，也不牵动已出的题。
   * 页面注释里那条「不做编辑」的顾虑针对的是 statement，
   * 标签不在此列。
   *
   * 不传则不显示「改」按钮（不摆假开关）。
   */
  onUpdateTags?: (id: string, tags: string[]) => Promise<void> | void;
  /**
   * 删掉一份资料的全部知识点（2026-11-08）。
   *
   * 参数是资料 id；`null` 对应「没有归属资料」那一组。
   */
  onRemoveSourcePoints?: (sourceId: string | null) => Promise<void>;
  /**
   * 挑选模式（2026-11-10）。
   *
   * ## 为什么加这个
   *
   * 用户原话：「记忆闪卡制作闪卡直接让用户跳转到知识库选择好一点，
   * 按知识骨架那四个类型分类后用户也好选择需要加入闪卡的知识点」。
   *
   * 原来的挑卡是在闪卡面板里平铺一列（`FlashcardsPanel` 的 available 列表）。
   * 那个列表没有资料分组、没有类型筛选、也不能按章节收窄 ——
   * 一个 59 条知识点的库，找「想背的那三条」要靠滚动翻。
   * 而知识库这一页本来就有「文件 → 章节 → 类型」三层组织，
   * 直接在这里挑，用户能一路收窄到想要的那几条。
   *
   * ## 为什么不把知识库整页复制一份到闪卡里
   *
   * 复制会产生两套会漂的实现（分组逻辑、类型筛选、标签编辑都得各写一遍）。
   * 加一个模式开关，同一份视图两种用途 —— 收窄的方式完全一致。
   *
   * ## 不传这些 prop 时行为完全不变
   *
   * 只有传了 `onPickPoints` 才进入挑选模式、才显示勾选框与确认栏。
   * 知识库作为普通浏览页时，一个多余控件都不会出现。
   */
  onPickPoints?: (ids: string[]) => Promise<void> | void;
  /** 挑选模式的标题（比如「挑要加进闪卡的知识点」） */
  pickTitle?: string;
  /** 取消挑选（回到调用方） */
  onCancelPick?: () => void;
  /** 已经在闪卡里、不该再被挑中的知识点 id */
  alreadyPickedIds?: readonly string[];
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
  onUpdateTags,
  onPickPoints,
  pickTitle,
  onCancelPick,
  alreadyPickedIds,
}: KnowledgePageProps) {
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 收起了哪些文件（默认全展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  /** 是否在挑选模式（只有调用方传了 onPickPoints 才启用） */
  const picking = Boolean(onPickPoints);
  /** 已勾选的知识点 id（挑选模式用；普通浏览时一直是空的） */
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  /** 已在闪卡里的（置灰、不可勾） */
  const alreadyPicked = useMemo(() => new Set(alreadyPickedIds ?? []), [alreadyPickedIds]);

  const toggleChosen = useCallback((id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 正在把勾选的知识点加进闪卡 */
  const [pickSaving, setPickSaving] = useState(false);
  /** 加入失败的原因（不静默吞掉：用户点过的东西没生效必须说） */
  const [pickError, setPickError] = useState<string | null>(null);

  const doPick = useCallback(async () => {
    if (!onPickPoints || pickSaving || chosen.size === 0) return;
    setPickSaving(true);
    setPickError(null);
    try {
      await onPickPoints([...chosen]);
      /*
       * 加入成功后不清空勾选、也不自动退出。
       *
       * 用户可能想「这几条加完了，再加那几条」—— 自动退出会打断他，
       * 清空勾选会让他看不到刚加了什么。由调用方决定什么时候回闪卡
       * （它的 onPickPoints 里会 goPage 过去）。
       */
    } catch (e) {
      setPickError(e instanceof Error ? e.message : '加入闪卡失败');
    } finally {
      setPickSaving(false);
    }
  }, [onPickPoints, pickSaving, chosen]);

  /**
   * 已有章节名，给标签输入当建议（2026-11-10）。
   *
   * 为什么是「建议」不是「白名单」：章节名是解析时从正文标题行猜出来的
   * （见 parsers/pdf.ts 的 detectChapter），不一定覆盖所有小节。
   * 做成硬白名单会把用户想用的正确标签挡在外面。
   */
  const chapterNames = useMemo(() => {
    const set = new Set<string>();
    for (const p of points ?? []) {
      const c = (p.chapter ?? '').trim();
      if (c) set.add(c);
      for (const t of p.tags ?? []) if (t.trim()) set.add(t.trim());
    }
    return [...set].sort();
  }, [points]);

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

  /**
   * 按认知类型筛选（2026-11-10）。
   *
   * ## 为什么需要它
   *
   * 用户原话：「知识库的知识分类应该在同一个资料下按知识骨架那四个类型
   * 进行分类，这样用户好筛选想看的知识点」。
   *
   * 知识骨架页早就按这四个类型筛（`SkeletonPage` 的 LEVELS），
   * 但知识库这一页没有 —— 两页看的是同一批知识点，一个能按类型收窄、
   * 一个不能，用户得来回跳。这里补上，口径与骨架页完全一致
   * （记忆 / 理解 / 应用 / 分析，顺序由浅到深）。
   *
   * ## 为什么是「与」关系而不是切成另一种视图
   *
   * 与搜索、与文件分组都是**与**：用户可能想「在《信号与系统》里
   * 看所有『分析』类」。砍掉分组会让「同一资料下分类」这个诉求落空。
   *
   * 多选（Set）而不是单选：他可能想看「理解 + 应用」两类。
   */
  const [pickedLevels, setPickedLevels] = useState<Set<KnowledgePoint['cognitiveLevel']>>(
    new Set(),
  );

  const toggleLevel = useCallback((lv: KnowledgePoint['cognitiveLevel']) => {
    setPickedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  }, []);

  /** 每种类型在全库里的条数（按钮上的数字按全部知识点算，不随筛选变） */
  const levelTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of points ?? []) out[p.cognitiveLevel] = (out[p.cognitiveLevel] ?? 0) + 1;
    return out;
  }, [points]);

  /** 搜索 + 类型筛选（两者是「与」关系） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const levels = pickedLevels;

    /* 两个条件都没设：原样返回，不做无谓的复制 */
    if (!q && levels.size === 0) return groups;

    return groups
      .map((g) => {
        const chapters = g.chapters
          .map((c) => ({
            ...c,
            points: c.points.filter((p) => {
              /* 类型条件 */
              if (levels.size > 0 && !levels.has(p.cognitiveLevel)) return false;
              /* 搜索条件 */
              if (!q) return true;
              return (
                p.statement.toLowerCase().includes(q) ||
                p.quotes.some((qt) => qt.toLowerCase().includes(q)) ||
                c.name.toLowerCase().includes(q)
              );
            }),
          }))
          .filter((c) => c.points.length > 0);
        const points2 = chapters.flatMap((c) => c.points);
        return { ...g, chapters, points: points2 };
      })
      .filter((g) => g.points.length > 0 || (q !== '' && g.title.toLowerCase().includes(q)));
  }, [groups, query, pickedLevels]);

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
    <div className={`kb-page${picking ? ' kb-page--picking' : ''}`}>
      <header className="kb-head">
        <div>
          <h1 className="kb-title">{picking ? (pickTitle ?? '挑知识点') : '知识库'}</h1>
          <p className="kb-lead">
            {picking ? (
              <>
                用下面的「按类型」和文件分组收窄范围，勾选要加进闪卡的知识点。
                已选中 {chosen.size} 条。
              </>
            ) : (
              <>
                所有整理出来的知识点都收在这里，按来源文件归类。共 {totalPoints} 条
                {totalPoints > 0 ? `，其中 ${totalLocated} 条能点回原文` : ''}。
              </>
            )}
          </p>
        </div>
        {/*
          「整理知识点」常驻按钮（2026-11-08，用户要求）。
          
          为什么放页头而不是只在空状态里：
          用户原话「不管有没有知识点都要加一个整理知识点按钮」。
          非空时同样需要 —— 整理完一份资料又想整理下一份时，
          不该非要先回「资料」页再找入口。
          
          不传 onOpenOrganize 就不渲染（不摆假按钮）。
        */}
        {onOpenOrganize ? (
          <button
            type="button"
            className="kb-head__action"
            onClick={() => onOpenOrganize(null)}
          >
            整理知识点
          </button>
        ) : null}
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

      {/*
        按认知类型筛选（2026-11-10）。
        与知识骨架页的 LEVELS 同一套四个类型、同一个顺序 ——
        两页看的是同一批知识点，筛选口径不能有两份。
        按钮上的数字按全部知识点统计，不随筛选变化（否则数字会越筛越小，
        看着像知识点丢了）。
      */}
      {totalPoints > 0 ? (
        <div className="kb-levels">
          <span className="kb-levels__label">按类型</span>
          {COGNITIVE_LEVEL_META.map((lv) => {
            const on = pickedLevels.has(lv.key);
            return (
              <button
                key={lv.key}
                type="button"
                className={`kb-level${on ? ' kb-level--on' : ''}`}
                aria-pressed={on}
                title={lv.hint}
                onClick={() => toggleLevel(lv.key)}
              >
                {lv.label}
                <span className="kb-level__n">{levelTotals[lv.key] ?? 0}</span>
              </button>
            );
          })}
          {pickedLevels.size > 0 ? (
            <button
              type="button"
              className="btn-ghost kb-levels__clear"
              onClick={() => setPickedLevels(new Set())}
            >
              清空类型
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
          {/*
            空状态里再给一个按钮。
            这里是用户最需要它的地方 —— 他刚看到「空的」，
            下一步动作就该是「去整理」，不该让他自己去找入口。
          */}
          {onOpenOrganize ? (
            <button
              type="button"
              className="kb-empty__action"
              onClick={() => onOpenOrganize(null)}
            >
              去整理知识点
            </button>
          ) : null}
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
                            const inFlashcards = alreadyPicked.has(p.id);
                            const isChosen = chosen.has(p.id);
                            return (
                              <li
                                key={p.id}
                                className={`kb-point${isChosen ? ' kb-point--chosen' : ''}${
                                  picking && inFlashcards ? ' kb-point--done' : ''
                                }`}
                              >
                                {/*
                                  挑选模式的勾选框（2026-11-10）。
                                  已在闪卡里的置灰不可勾 —— 再勾一次只会
                                  让服务层白跑一遍，用户还以为是新建了。
                                */}
                                {picking ? (
                                  <label className="kb-point__pick">
                                    <input
                                      type="checkbox"
                                      checked={isChosen}
                                      disabled={inFlashcards}
                                      onChange={() => toggleChosen(p.id)}
                                    />
                                    {inFlashcards ? (
                                      <span className="kb-point__picked">已在闪卡里</span>
                                    ) : null}
                                  </label>
                                ) : null}
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
                                  {/*
                                    标签编辑器（2026-11-10）。
                                    只放行 tags：它不参与定位，改它不会让
                                    anchors 失效 —— 这是「不做完整编辑」那条
                                    注释留下的安全缺口，正好用来纠正 AI 的分类。
                                  */}
                                  <KpTagsEditor
                                    tags={p.tags ?? []}
                                    suggestions={chapterNames}
                                    onSave={(next) => onUpdateTags?.(p.id, next)}
                                  />
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

      {/*
        挑选模式的底部确认栏（2026-11-10）。
        固定吸底：用户在长列表里勾到一半时，不该为了点「加入」再滚回顶部。
      */}
      {picking ? (
        <div className="kb-pickbar">
          <span className="kb-pickbar__count">
            已选 {chosen.size} 条
            {chosen.size === 0 ? ' —— 勾选上面的知识点' : ''}
          </span>
          {pickError ? <span className="kb-pickbar__err">{pickError}</span> : null}
          <button
            type="button"
            className="kb-pickbar__ok"
            disabled={chosen.size === 0 || pickSaving}
            onClick={() => void doPick()}
          >
            {pickSaving ? '正在加入…' : `加入闪卡（${chosen.size}）`}
          </button>
          {onCancelPick ? (
            <button
              type="button"
              className="kb-pickbar__cancel"
              disabled={pickSaving}
              onClick={onCancelPick}
            >
              取消
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const LEVEL_LABEL = COGNITIVE_LEVEL_LABEL;
