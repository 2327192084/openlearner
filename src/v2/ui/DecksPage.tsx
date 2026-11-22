import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Deck, Question, Source } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { BackendService } from '@/core/backends.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import { GeneratePage } from './GeneratePage.tsx';
import { ConfirmDialog } from './dialog.tsx';
import { IconGenerate } from './icons.tsx';
import { QuestionEditor } from './QuestionEditor.tsx';
import { RenameField } from './RenameField.tsx';
import { PickBanner, PickButton } from './PickBanner.tsx';

/**
 * 「我的题组」—— 列出现有题组，看题、检查待审核、发布。
 *
 * ## 为什么这一页必须有
 *
 * 用户出完题后看到「已生成 XXX，共 8 道题，可以去复习里做了」，
 * 然后**找不到那 8 道题**。查下来是：
 *  - `decks.list()` 这个方法一直存在，但**界面从来没调用过**
 *  - 侧栏只有「创建题组」，没有「我的题组」
 *  - 生成出来的题组是 `draft`（待审核），而计划书要求
 *    「生成 → 人工检查 → 发布」，这一步在界面里完全没做
 *
 * 结果就是：题在库里，但用户看不到、检查不了、也不知道它在哪。
 * 这一页把这条链路补齐。
 *
 * ## 三条不能省的规矩
 *
 * 1. **待审核与已发布必须分清**。待审核是给用户检查的，不该直接混进复习。
 * 2. **每道题都要能看到出处**（第几页 / 哪个知识点），否则「检查」无从谈起。
 * 3. **删除要二次确认**，并说清会连带删掉什么。
 */

type Tab = 'all' | 'draft' | 'published';

export interface DecksPageProps {
  decks: DeckService;
  sourceService: SourceService;
  /** 出题要用：知识点服务 */
  knowledge: KnowledgeService;
  /** 出题要用：后端 */
  backends: BackendService;
  /** 出完题刷新侧栏计数 */
  onGenerated: () => void;
  /** 去资料页（没有资料时引导用） */
  onOpenSources: () => void;
  /** 去整理知识点页 */
  onOpenOrganize: (sourceId: string | null) => void;
  /** 生成完题后跳到这一页时，要自动展开那个题组 */
  initialDeckId?: string | null;
  /**
   * 进来就展开「新建题组」表单。
   *
   * 「创建题组」作为独立页面已经并入本页，但旧状态/书签/「下一步」卡片
   * 仍可能把 page 指向 generate —— App 会把它们送到这里并设上这个标记，
   * 让用户直接看到出题表单，而不是一个题组列表。
   */
  initialCreate?: boolean;
  /** 去这一份资料的阅读器（看原文对照） */
  onOpenSource?: (sourceId: string) => void;
  /**
   * 复习服务（2026-11-12）。
   *
   * 变式出题要拿「用户真实做错过的题」，那些记录在 `reviewLogs` 里，
   * 只有 reviewService 能读到（见 VariantPanel 的 review prop 说明）。
   * 为可选：没传时「从错题变式」显示引导语而不是报错。
   */
  reviewService?: ReviewService;
  /**
   * 从错题页跳来时要预选的变式目标（2026-11-12）。
   * 传下去后出题页会直接切到变式模式并勾上那一题。
   */
  initialVariant?: { questionIds: string[] } | null;
  onChanged: () => void;
  /**
   * 选取会话（2026-11-23，用户待办第 1 项：绑定面板改跳转选取）。
   * 从地图小节详情点「+ 去题组页挑」进来时非空；为 null 时这页和原来一样。
   */
  pickContext?: import('./pick-context.ts').PickSession | null;
  /** 这一节已绑的题组 id（「选这个」据此显示「已绑上」） */
  pickBoundDeckIds?: readonly string[];
  /** 点「选这个」：宿主写回树并持久化（本页不碰地图数据） */
  onPickDeck?: (deckId: string) => void;
  /** 「返回地图」 */
  onBackFromPick?: () => void;
}

export function DecksPage({
  decks,
  sourceService,
  knowledge,
  backends,
  onGenerated,
  onOpenSources,
  onOpenOrganize,
  initialDeckId,
  initialCreate,
  onOpenSource,
  reviewService,
  initialVariant,
  onChanged,
  pickContext = null,
  pickBoundDeckIds,
  onPickDeck,
  onBackFromPick,
}: DecksPageProps) {
  const [list, setList] = useState<Deck[] | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');

  /** 当前展开的题组 id */
  const [openId, setOpenId] = useState<string | null>(initialDeckId ?? null);
  const [questions, setQuestions] = useState<Record<string, Question[]>>({});
  const [loadingQuestions, setLoadingQuestions] = useState<string | null>(null);

  /**
   * 是不是在「新建题组」模式。
   *
   * 用户要求把「创建题组」和「我的题组」整合成一页：默认看到题组列表，
   * 点「新建题组」就地展开出题表单，出完回到列表并展开新题组。
   * 这样侧栏少一个入口，出题与查看也不用来回跳。
   */
  const [creating, setCreating] = useState(Boolean(initialCreate));

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deck | null>(null);
  /**
   * 正在改名的题组（2026-11-13 傍晚，用户要求）。
   *
   * 存 id 不存 Deck 对象：改名后 load() 会换出新数组，旧引用会过期。
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([decks.list(), sourceService.list()]);
      setList(d);
      setSources(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出题组');
    }
  }, [decks, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  // 从出题页跳过来时自动展开并加载那个题组
  useEffect(() => {
    if (!initialDeckId) return;
    setOpenId(initialDeckId);
    void openDeck(initialDeckId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeckId]);

  const titleOf = useCallback(
    (sourceId: string | null) => sources.find((s) => s.id === sourceId)?.title ?? null,
    [sources],
  );

  const filtered = useMemo(() => {
    const all = list ?? [];
    if (tab === 'draft') return all.filter((d) => d.status === 'draft');
    if (tab === 'published') return all.filter((d) => d.status === 'published');
    return all;
  }, [list, tab]);

  const counts = useMemo(() => {
    const all = list ?? [];
    return {
      all: all.length,
      draft: all.filter((d) => d.status === 'draft').length,
      published: all.filter((d) => d.status === 'published').length,
    };
  }, [list]);

  /**
   * 展开一个题组并读它的题目。
   *
   * @param force 为 true 时忽略缓存重新读（2026-11-11 晚加）。
   *
   * 为什么需要它：改题/删题之后必须重新读，否则界面还显示旧题目。
   * 原来的实现里 `if (questions[deckId]) return` 会把调用直接挡回去 ——
   * 编辑器保存成功、列表却纹丝不动，看起来像没生效。
   */
  async function openDeck(deckId: string, opts: { force?: boolean } = {}) {
    setOpenId(deckId);
    if (!opts.force && questions[deckId]) return; // 已经加载过
    setLoadingQuestions(deckId);
    try {
      const qs = await decks.getQuestions(deckId);
      setQuestions((prev) => ({ ...prev, [deckId]: qs }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出题目');
    } finally {
      setLoadingQuestions(null);
    }
  }

  async function publish(deck: Deck) {
    setBusy(true);
    setNotice(null);
    try {
      /*
       * 发布前会逐题再校验一遍（计划书 P3 第 2 条）。
       *
       * 阻塞问题（blocking）必须修 —— 抛错就原样显示。
       * 但「提醒」（warning，如某题没写解析）不该挡住发布：
       * publish() 默认遇到 warning 也会抛错，这里用 allowWarnings 放行，
       * 并把提醒列出来让用户自己去检查。
       */
      let warningNote = '';
      try {
        await decks.publish(deck.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('条提醒')) {
          // 只是提醒 → 放行，但如实说出来
          await decks.publish(deck.id, { allowWarnings: true });
          warningNote = `（有提醒：${msg}）`;
        } else {
          throw err;
        }
      }
      setNotice(`已发布「${deck.title}」，现在复习里能做到了。${warningNote}`);
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 题组改名（2026-11-13 傍晚，用户要求）。
   *
   * 走现成的 `QuestionService.updateDeck(deckId, { title })` ——
   * 它在 2026-11-12 就补上了，注释里写着「没有这个方法时，
   * 界面上那个『改名』按钮只能撤掉 —— 一个点了必然报错的按钮比没有更糟」。
   * 但补完之后**界面一直没接**，全仓只有单测在调它。
   *
   * 服务层会顺带刷 `updatedAt`，那是对的（改名就是用户改属性）。
   * 改名不影响题目、发布状态、来源关联，所以不需要额外提示。
   */
  async function renameDeck(id: string, title: string) {
    const next = await decks.updateDeck(id, { title });
    if (!next) throw new Error('这个题组已经不在了（可能刚被删掉）');
    setRenamingId(null);
    await load();
    onChanged();
  }

  async function unpublish(deck: Deck) {
    setBusy(true);
    setNotice(null);
    try {
      await decks.unpublish(deck.id);
      setNotice(`已把「${deck.title}」撤回待审核。它不会再出现在复习里。`);
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '撤回失败');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await decks.removeDeck(deleting.id);
      setQuestions((prev) => {
        const next = { ...prev };
        delete next[deleting.id];
        return next;
      });
      setNotice(`已删除「${deleting.title}」。`);
      setDeleting(null);
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  // ---------- 渲染 ----------

  if (list === null && !error) {
    return (
      <div className="decks-page">
        <p className="decks-lead">正在读题组…</p>
      </div>
    );
  }

  /*
   * 「新建题组」模式：就地展开出题表单。
   *
   * 用户要求「创建题组和我的题组整合成一个界面，就叫我的题组」。
   * 所以不再有独立页面 —— 点这里的「新建题组」按钮就地切换，
   * 出完题回到列表并自动展开那一组。
   */
  if (creating) {
    return (
      <div className="decks-page">
        <GeneratePage
          sourceService={sourceService}
          knowledge={knowledge}
          decks={decks}
          backends={backends}
          {...(reviewService ? { reviewService } : {})}
          {...(initialVariant ? { initialVariant } : {})}
          onGenerated={onGenerated}
          onOpenSources={onOpenSources}
          onOpenOrganize={onOpenOrganize}
          onOpenDecks={(deckId) => {
            // 出完题：回到列表并展开这一组，让用户立刻检查
            setCreating(false);
            void load().then(() => {
              if (deckId) void openDeck(deckId);
            });
          }}
          onBack={() => setCreating(false)}
        />
      </div>
    );
  }

  return (
    <div className="decks-page">
      {/*
       * 选取模式横幅（2026-11-23）。boundCount 是会话那一节当前已绑的真实
       * 数量（App 从树里算好传来），与写回同源 —— 本页不自己数。
       */}
      {pickContext && onBackFromPick ? (
        <PickBanner
          session={pickContext}
          boundCount={(pickBoundDeckIds ?? []).length}
          onBack={onBackFromPick}
        />
      ) : null}

      <header className="decks-head">
        <div>
          <h1 className="decks-title">我的题组</h1>
          <p className="decks-lead">
            这里能看到所有生成过的题组。待审核的题组要先检查、发布，才会进入复习队列。
          </p>
        </div>
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => setCreating(true)}
        >
          新建题组
        </button>
      </header>

      {error ? <div className="decks-error">{error}</div> : null}
      {notice ? (
        <div className="decks-notice" role="status">
          {notice}
        </div>
      ) : null}

      {/* 筛选 */}
      <div className="decks-tabs" role="tablist">
        {(
          [
            ['all', `全部 ${counts.all}`],
            ['draft', `待审核 ${counts.draft}`],
            ['published', `已发布 ${counts.published}`],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`decks-tab${tab === key ? ' decks-tab--on' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="decks-empty">
          <IconGenerate size={30} />
          <p className="decks-empty__title">
            {counts.all === 0 ? '还没有题组' : '这个分类里没有题组'}
          </p>
          <p className="decks-hint">
            {counts.all === 0
              ? '到「创建题组」页选一份已整理过知识点的资料，就能生成第一批题目。'
              : '换个分类看看。'}
          </p>
        </div>
      ) : (
        <ul className="decks-list">
          {filtered.map((deck) => {
            const isOpen = openId === deck.id;
            const qs = questions[deck.id];
            const fromSource = titleOf(deck.sourceId);

            return (
              <li key={deck.id} className={`deck-item${isOpen ? ' deck-item--open' : ''}`}>
                <div className="deck-item__top">
                  {/*
                    改名时就地换成输入框（2026-11-13 傍晚，用户要求）。
                    同资料页：`deck-item__main` 是 button，改名期间改用 div ——
                    button 里嵌输入框和按钮是非法 HTML，浏览器会把内层元素
                    踢出去，回车/点击行为随之失控。
                  */}
                  {renamingId === deck.id ? (
                    <div className="deck-item__main deck-item__main--editing">
                      <span className="deck-item__meta">
                        {deck.questionCount} 道题
                        {fromSource ? ` · 来自「${fromSource}」` : ''}
                      </span>
                      <RenameField
                        current={deck.title}
                        label="题组名"
                        onSave={(title) => renameDeck(deck.id, title)}
                        onCancel={() => setRenamingId(null)}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="deck-item__main"
                      onClick={() => (isOpen ? setOpenId(null) : void openDeck(deck.id))}
                      aria-expanded={isOpen}
                    >
                      <span className="deck-item__title">{deck.title}</span>
                      <span className="deck-item__meta">
                        {deck.questionCount} 道题
                        {fromSource ? ` · 来自「${fromSource}」` : ''}
                      </span>
                    </button>
                  )}
                  <span
                    className={`deck-badge deck-badge--${deck.status === 'published' ? 'ok' : 'warn'}`}
                  >
                    {deck.status === 'published' ? '已发布' : '待审核'}
                  </span>
                </div>

                <div className="deck-item__actions">
                  {/*
                   * 选取模式的「选这个」（2026-11-23）。
                   *
                   * ⚠️ 只给**已发布**的题组 —— 地图的绑定池只收 published
                   * （App 的 bindPool 过滤），给草稿出「选这个」等于绑上一个
                   * 面板里显示"已被删了"的 id：承诺兑现不了的那种关系错误。
                   */}
                  {pickContext && onPickDeck && deck.status === 'published' ? (
                    <PickButton
                      picked={(pickBoundDeckIds ?? []).indexOf(deck.id) >= 0}
                      busy={busy}
                      onPick={() => onPickDeck(deck.id)}
                    />
                  ) : null}
                  {deck.status === 'draft' ? (
                    <button
                      type="button"
                      className="btn-fill btn-fill--sm"
                      onClick={() => void publish(deck)}
                      disabled={busy}
                    >
                      发布（发布后才能复习）
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void unpublish(deck)}
                      disabled={busy}
                    >
                      撤回成待审核
                    </button>
                  )}
                  {deck.sourceId && onOpenSource ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => onOpenSource(deck.sourceId!)}
                    >
                      看原文
                    </button>
                  ) : null}
                  {renamingId === deck.id ? null : (
                    <button
                      type="button"
                      className="deck-item__rename"
                      aria-label={`给题组「${deck.title}」改名`}
                      title="改这个题组的名字"
                      disabled={busy}
                      onClick={() => setRenamingId(deck.id)}
                    >
                      改名
                    </button>
                  )}
                  <button
                    type="button"
                    className="deck-item__delete"
                    onClick={() => setDeleting(deck)}
                    disabled={busy}
                  >
                    删除
                  </button>
                </div>

                {isOpen ? (
                  <div className="deck-questions">
                    {loadingQuestions === deck.id ? (
                      <p className="decks-hint">正在读题目…</p>
                    ) : (qs ?? []).length === 0 ? (
                      <p className="decks-hint">这个题组里没有题目。</p>
                    ) : (
                      <ol className="deck-q-list">
                        {(qs ?? []).map((q, i) => (
                          /*
                            题目改成可编辑组件（2026-11-11 晚）。

                            用户反馈：「加一个题库编辑功能，要不然待审核按钮
                            相当于没用，不能删除出错题目或是重新对出错题目
                            进行纠正生成」。

                            原来这里是写死的一段只读 <li>，既不能改也不能删 ——
                            发现一道错题只能删掉整个题组重来。
                            服务层的 updateQuestion / removeQuestion 早就有了
                            （service.ts:662 / 677），缺的只是这个入口。
                          */
                          <QuestionEditor
                            key={q.id}
                            question={q}
                            index={i + 1}
                            decks={decks}
                            onChanged={() => void openDeck(deck.id, { force: true })}
                          />
                        ))}
                      </ol>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {deleting ? (
        <ConfirmDialog
          title={`删除「${deleting.title}」？`}
          description="这个题组和它里面的题目会一起删掉，不能撤销。"
          confirmLabel="删除"
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        >
          <p className="set-hint" style={{ marginTop: 0 }}>
            已经做过的复习记录会保留（它们不跟题组走），但题目本身没了，
            那些记录也就点不回题目了。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
