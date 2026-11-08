import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { AppShell } from './AppShell.tsx';
import { TodayPage } from './TodayPage.tsx';
import { ReviewPage } from './ReviewPage.tsx';
import { PracticePage } from './PracticePage.tsx';
import { WrongBookPage } from './WrongBookPage.tsx';
import { TasksPage } from './TasksPage.tsx';
import { SkeletonPage } from './SkeletonPage.tsx';
import { GuidePage } from './GuidePage.tsx';
import { BookPage } from './BookPage.tsx';
import { NotesPage } from './NotesPage.tsx';
import { ExamPage } from './ExamPage.tsx';
import { MapPage } from './MapPage.tsx';
import { BoardPage } from './BoardPage.tsx';
import { FocusPage } from './FocusPage.tsx';
import { badgeCounts, resolvePool } from './data-sync.ts';
import type { PracticeStart } from './PracticePage.tsx';
import { SourcesPage } from './SourcesPage.tsx';
import { DecksPage } from './DecksPage.tsx';
import { StudyPage } from './StudyPage.tsx';
import { KnowledgePage } from './KnowledgePage.tsx';
import { StatsPage } from './StatsPage.tsx';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { BackendService } from '@/core/backends.ts';
import type { SourceService } from '@/core/sources.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { PageId } from './pages.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { OrganizePage } from './OrganizePage.tsx';
import { ReaderPage } from './ReaderPage.tsx';
import type { ReaderTarget } from './ReaderPage.tsx';
import { useServices } from '@/app/services-context.ts';
import type { GradingRules } from '@/v2/core/grading.ts';
import { DEFAULT_GRADING_RULES } from '@/v2/core/grading.ts';
import './tokens.css';
import './shell.css';
import './paper.css';
import './today-page.css';
import './today-dashboard.css';
import './review-page.css';
import './sources-page.css';
import './generate-page.css';
import './stats-page.css';
import './settings.css';
import './organize-page.css';
import './reader-page.css';
import './decks-page.css';
import './study-page.css';
import './knowledge-page.css';
import './practice-page.css';
import './wrongbook-page.css';
import './tasks-page.css';
import './skeleton-page.css';
import './guide-page.css';
import './book-page.css';
import './notes-page.css';
import './exam-page.css';
import './map-page.css';
import './focus-page.css';
import './board-page.css';

/**
 * v2 应用入口。
 *
 * 现在只有「今日」页真正可用，其余页面是占位。
 *
 * ## 为什么先只做通一条路
 *
 * 上一轮的教训：六个页面同时存在，但每个都不好用。
 * 这次先把「打开 → 知道该做什么 → 点开始复习」这一条路打通，
 * 确认可用后再接下一个页面。
 *
 * 占位页不假装能用 —— 它明确写「还没做好」，
 * 而不是给一个点了没反应的按钮。
 */

export interface AppProps {
  reviewService: ReviewService;
  /** 从资料库加载卡片（题目 + 知识点统一成 Card） */
  loadCards: CardLoader;
  /** 资料服务（导入与列表） */
  sourceService: SourceService;
  knowledge: KnowledgeService;
  decks: DeckService;
  backends: BackendService;
  /**
   * 当前资料库里的全部卡片 id —— **只作初值**。
   *
   * 2026-11-08 修：以前这是唯一的来源，启动时算一次就再也不变。
   * 用户删掉题目后界面仍显示「15 张待复习」，必须重启才对 ——
   * 因为 `todayOverview(旧池子)` 照旧数出 15。
   *
   * 现在 App 自己持有 `cardPool` 状态，并由 `refreshData()` 从
   * `loadCards()` 重新派生。这个 prop 只在首屏渲染前兜底
   * （避免刷新完成前显示「0 张」闪一下）。
   */
  cardPool: readonly string[];
  hasSources: boolean;
  /** 是否已接入模型 */
  connected: boolean;
  /** 已接入的模型显示名 */
  modelName?: string | null;
}

/*
 * 「一批最多多少张」的上限挪到 PracticePage 了 ——
 * 现在三种模式（今日 / 自由 / 错题）各自决定分批，
 * 阈值放在选模式的地方比放在 App 里更合理。
 */

export function App({
  reviewService,
  loadCards,
  sourceService,
  knowledge,
  decks,
  backends,
  cardPool,
  hasSources,
  connected,
  modelName,
}: AppProps) {
  const [page, setPage] = useState<PageId>('today');
  /**
   * 计时评分规则（用户在设置里选的宽容度）。
   *
   * 为什么不放进 AppProps 由外层传：这样一改，main.tsx 的启动流程
   * 就要多读一次设置、还要在设置页保存后同步给 App ——
   * 那条链路跨了三个文件，中间任何一环忘了刷新，用户就会觉得
   * 「我在设置里改了，做题时没生效」。这里自己读、并在进入做题时重读一次，
   * 保证「改完立刻生效」这件事只取决于一处。
   */
  const [gradingRules, setGradingRules] = useState<GradingRules>(DEFAULT_GRADING_RULES);
  /**
   * 本轮复习队列。
   *
   * 进「复习」时才构造 —— 每次进入都重新算今日到期，
   * 而不是缓存一份（用户可能中途答完几张又回来）。
   */
  const [queue, setQueue] = useState<Card[] | null>(null);
  /**
   * 今日到期的卡（供选题页显示与「今日题组」模式使用）。
   *
   * 与 queue 分开：queue 是「正在做的那一轮」，dueCards 是「今天一共有多少」。
   * 原来两者混用，导致做完一轮后 queue 变了、选题页拿不到正确的数字。
   */
  const [dueCards, setDueCards] = useState<Card[]>([]);
  /**
   * 今天可以学、但**从没练过**的卡（首页的「没学过」）。
   *
   * 与 dueCards 分开：到期和没学过是两种不同的状态，
   * 混在一起会让「今天到期 8 张」变成「14 张到期」。
   */
  const [freshCards, setFreshCards] = useState<Card[]>([]);
  /** 这一轮的模式（影响提示语与小结） */
  const [practiceMode, setPracticeMode] = useState<'due' | 'free' | 'wrong'>('due');
  const [practiceLabel, setPracticeLabel] = useState<string>('');
  /**
   * 今天到期的**真实总数**（可能大于 queue.length）。
   * 复习页据此如实说「今天到期 80 张，这一批先做 30 张」，
   * 而不是让用户以为今天只有 30 张。
   */
  const [queueTotal, setQueueTotal] = useState<number>(0);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [overviewCounts, setOverviewCounts] = useState<Partial<Record<PageId, number>>>({});

  /**
   * 当前卡片池 —— **会跟着数据变**（2026-11-08 修）。
   *
   * ## 以前为什么错
   *
   * `cardPool` 是 props，由 `main.tsx` 在启动时算一次。之后用户删掉题目，
   * 这个数组还是旧的 —— 于是 `todayOverview(旧池子)` 照样数出「15 张待复习」，
   * 而题库已经空了。必须重启（重新走 `main.tsx`）才正常。用户如实报了这个现象。
   *
   * ## 现在的做法
   *
   * 初值仍然用 props（首屏不闪），但每次 `refreshData()` 都从 `loadCards()`
   * 重新派生。`loadCards()` 已经是「已发布题组的题」那个口径，
   * 与 `main.tsx` 里的过滤规则一致 —— 不重复实现一份，避免两处漂移。
   */
  const [pool, setPool] = useState<readonly string[]>(cardPool);
  /**
   * 待办页「现在可以做」的数据来源。
   *
   * 为什么在 App 里算：它需要「题组 → 总题数 / 练过几道 / 错几道」，
   * 这与首页和学习地图用的是同一类聚合。放在 page 组件里各算一遍，
   * 迟早会出现三个界面的数字不一致（项目踩过）。
   *
   * 初值全空 —— 待办页在数据就绪前显示「暂无建议」，不编内容。
   */
  const [suggestionInput, setSuggestionInput] = useState<{
    decks: { id: string; title: string; total: number; done: number; wrong: number }[];
    sourcesWithoutQuestions: number;
    wrongTotal: number;
  }>({ decks: [], sourcesWithoutQuestions: 0, wrongTotal: 0 });
  /**
   * 从资料列表点进来时，要带上是哪一份。
   *
   * 单独存而不是塞进 page 状态：page 只是「显示哪一页」，
   * 而「整理哪一份资料」是另一回事 —— 混在一起会导致
   * 从别处进整理页时用上一次残留的选择。
   */
  const [organizeSourceId, setOrganizeSourceId] = useState<string | null>(null);

  /**
   * 阅读器要打开哪一份资料、定位到哪里。
   *
   * 和 organizeSourceId 一样单独存：从知识点列表点「可点回原文」时
   * 要带上 {sourceId, page, charStart, charEnd, quote}，
   * 而「打开哪一份」和「定位到哪」是两件事，混在一起会残留上一次的位置。
   */
  /**
   * 要自动展开的题组 id。
   *
   * 出完题时的展开现在由 DecksPage 内部处理（表单嵌在那一页里）。
   *
   * 2026-11-07 起有了真正的调用方：首页「最近在练的题组」点某一行，
   * 要跳到「我的题组」并展开那一个 —— 否则用户点进去看到一列题组，
   * 还得自己再找一遍「我刚才点的是哪个」。
   */
  const [openedDeckId, setOpenedDeckId] = useState<string | null>(null);
  const [readerSourceId, setReaderSourceId] = useState<string | null>(null);
  const [readerTarget, setReaderTarget] = useState<ReaderTarget | null>(null);

  /*
   * 从服务上下文取用量服务：App 的 props 里没有它（那是 v2Data 之外的层）。
   * 只取需要的那个，不整体解构 —— 免得将来上下文变大时这里跟着受影响。
   */
  const {
    library,
    usage: usageService,
    notes: notesService,
    exam: examService,
    todos: todoService,
    focus: focusService,
  } = useServices();

  /**
   * 后端状态与库名的本地副本。
   *
   * 初值来自启动时的 props —— 但设置页可能在会话中期新增/删除后端、
   * 改库名。若只认 props，顶栏会一直写着「未连接」而实际上已经连上了，
   * 那正是「界面在骗人」。所以这里留一份可刷新的副本。
   */
  const [conn, setConn] = useState<{ connected: boolean; modelName: string | null }>({
    connected,
    modelName: modelName ?? null,
  });
  const [libName, setLibName] = useState('openleaner');

  const refreshShellState = useCallback(async () => {
    try {
      const [list, meta] = await Promise.all([backends.list(), library.getMeta()]);
      const ready = list.filter((b) => b.status === 'ready');
      const first = ready[0] ?? null;
      setConn({
        connected: ready.length > 0,
        modelName: first ? `${first.label} · ${first.model || '未填模型'}` : null,
      });
      setLibName(meta?.name ?? 'openleaner');
    } catch {
      // 读不到就保持原样，不要把状态改成「未连接」骗用户
    }
  }, [backends, library]);

  useEffect(() => {
    void refreshShellState();
  }, [refreshShellState]);

  /**
   * 侧栏计数。
   *
   * 只给「复习」显示待复习数量、给「资料」显示资料份数 ——
   * 其他页面的计数目前没有可靠来源，宁可不显示，也不显示一个猜的数字。
   *
   * 「资料」这个数字以前是写死的 0。库里有三份资料而侧栏写 0，
   * 就是界面在说谎，所以改成真的去数。
   */
  const refreshCounts = useCallback(async () => {
    try {
      const [o, srcs] = await Promise.all([reviewService.todayOverview(pool), sourceService.list()]);
      /**
       * 「复习」显示待复习数量，0 时不显示徽章 —— 没有待办就不该有标记。
       * 「资料」显示份数（0 也有意义：说明库是空的）。
       */
      setOverviewCounts(badgeCounts(o.dueCount, srcs.length));
    } catch {
      setOverviewCounts({});
    }
  }, [reviewService, pool, sourceService]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  /**
   * 进待办页前重算「现在可以做」。
   *
   * 与 refreshCounts 分开放：那个是侧栏徽标的轻量计数，
   * 这个要读题组与复习记录，重一些，只在真的要看那一页时算。
   */
  const refreshSuggestions = useCallback(async () => {
    try {
      const [cards, deckList, records, wrong, srcs] = await Promise.all([
        loadCards(),
        decks.list(),
        reviewService.listRecords(),
        reviewService.wrongCardsDetailed(),
        sourceService.list(),
      ]);
      const learned = new Set(records.filter((r) => r.state.reviewCount > 0).map((r) => r.cardId));
      const wrongByDeck = new Map<string, number>();
      const cardById = new Map(cards.map((c) => [c.id, c]));
      for (const w of wrong) {
        const c = cardById.get(w.cardId);
        if (!c) continue;
        wrongByDeck.set(c.deckId, (wrongByDeck.get(c.deckId) ?? 0) + 1);
      }

      const totalByDeck = new Map<string, number>();
      const doneByDeck = new Map<string, number>();
      for (const c of cards) {
        totalByDeck.set(c.deckId, (totalByDeck.get(c.deckId) ?? 0) + 1);
        if (learned.has(c.id)) doneByDeck.set(c.deckId, (doneByDeck.get(c.deckId) ?? 0) + 1);
      }

      /* 有资料、但没有任何题组的资料数 */
      const deckSourceIds = new Set(deckList.map((d) => d.sourceId).filter(Boolean));
      const sourcesWithoutQuestions = srcs.filter((s) => !deckSourceIds.has(s.id)).length;

      setSuggestionInput({
        decks: deckList
          .filter((d) => d.status === 'published')
          .map((d) => ({
            id: d.id,
            title: d.title,
            total: totalByDeck.get(d.id) ?? 0,
            done: doneByDeck.get(d.id) ?? 0,
            wrong: wrongByDeck.get(d.id) ?? 0,
          })),
        sourcesWithoutQuestions,
        wrongTotal: wrong.length,
      });
    } catch {
      /* 读不出来就保持上一次的值：待办页本身仍然能用 */
    }
  }, [loadCards, decks, reviewService, sourceService]);

  useEffect(() => {
    if (page === 'board') void refreshSuggestions();
  }, [page, refreshSuggestions]);

  /**
   * 切回学习库时自动重算（2026-11-08）。
   *
   * ## 为什么需要它
   *
   * 用户报的那个 bug 修好之后（refreshData 会重算卡片池），还有一个缺口：
   * 数据可能在**别的页面**被改（我的题组删题、资料页删资料），
   * 而首页的数字是它自己进入时才重算的 —— 从别的页面切回来时它不重算。
   *
   * 现在加上这条：每次回到首页都刷一遍。代价是一次轻量查询，
   * 换来「看到的就是现在的」。
   *
   * ## 为什么不做全局定时轮询
   *
   * 数据只可能被**本应用自己**改（没有后台同步、没有多窗口协作）。
   * 每个改动点都已经调了 `refreshData()`，再加上「切回首页时刷新」，
   * 已经覆盖所有情况。定时轮询只会在用户阅读时不停地重排界面，
   * 是负担而不是体验。
   */
  useEffect(() => {
    if (page === 'today') void refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  /**
   * 窗口重新获得焦点时也刷一遍。
   *
   * 覆盖「用户切到别的程序、回来时数据被本应用在后台改过」的情况
   * （比如出题任务在后台跑完）。只在学习库页做 —— 别的页自己有数据源。
   */
  useEffect(() => {
    if (page !== 'today') return;
    const onFocus = () => void refreshData();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  /**
   * 全量刷新：重算卡片池，再连锁刷新所有依赖它的东西。
   *
   * ## 为什么需要一个「总入口」
   *
   * 用户报的现象（2026-11-08）：「我把题库里的题都删掉了，
   * 学习库的待复习便签还是显示 15 道，重启后才正常。」
   *
   * 根因：`cardPool` 是启动时的 props 快照，删题后再也没更新过。
   * 但光修这一处不够 —— 依赖卡片池的还有侧栏徽标、待办建议、
   * 以及当前页面自己缓存的数据。如果只让调用方各自记得刷新，
   * 迟早会漏掉一个（这次就是漏了）。
   *
   * 所以：**任何改变题库结构的操作，都调这一个函数**。
   * 顺序很重要 —— 先重算池子，再刷新依赖池子的数字，
   * 否则刷新用的还是旧池子（这正是原来的问题）。
   *
   * ## 为什么带上 refreshSuggestions
   *
   * 待办页的「现在可以做」是从题组进度和错题数推导的。
   * 删了题组还显示「继续练某某」就是假建议。
   */
  const refreshData = useCallback(async () => {
    /*
     * 第一步：重算卡片池。
     *
     * loadCards() 可能失败（存储被占用等）—— 那时保持现有池子不动，
     * 不能清成空数组：那会让界面突然显示「0 道题」，
     * 用户以为题没了。宁可显示旧数字，也不要显示错的 0。
     */
    let fresh: readonly string[] | null = null;
    try {
      const cards = await loadCards();
      fresh = cards.map((c) => c.id);
    } catch {
      /* 读失败：fresh 保持 null，下一步会沿用旧池子 */
    }

    /*
     * 两条决策都在 `data-sync.ts` 里，有单测：
     *  - 读失败 → 沿用旧池子（不清空，否则界面会突然显示 0 道题）
     *  - 算数字 → 用刚读到的池子（setState 是异步的，读 state 拿到的还是旧值）
     */
    const { effective, shouldUpdate } = resolvePool(fresh, pool);
    if (shouldUpdate) setPool(effective);

    try {
      const [o, srcs] = await Promise.all([
        reviewService.todayOverview(effective),
        sourceService.list(),
      ]);
      setOverviewCounts(badgeCounts(o.dueCount, srcs.length));
    } catch {
      /* 读不到就保持原数字 */
    }

    void refreshSuggestions();
  }, [loadCards, pool, reviewService, sourceService, refreshSuggestions]);


  const navigate = useCallback(
    async (id: PageId) => {
      setPage(id);
      if (id === 'review') {
        /*
         * 进做题前重读一次评分规则。
         *
         * 用户可能刚在设置里把宽容度从「标准」改成「严格」，
         * 然后直接点开始做题 —— 不重读就会用上一次的值，
         * 而他没有任何办法察觉（评分数值看着都正常）。
         */
        try {
          const s = await library.getSettings();
          setGradingRules(s.gradingRules ?? DEFAULT_GRADING_RULES);
        } catch {
          /* 读不到就沿用当前值：不能因为设置读取失败就做不了题 */
        }
        /*
         * 进选题页时**不再直接把队列塞进做题界面**。
         *
         * 现在先进 PracticePage 让用户选三种模式（今日题组 / 自由练习 / 错题巩固），
         * 选完才由 startPractice() 构造队列并跳到 practice 页。
         * 这里只把「今日到期」算出来，供选题页显示数量。
         */
        setQueueError(null);
        try {
          const all = await loadCards();
          const today = new Date().toISOString().slice(0, 10);
          const records = await reviewService.listRecords();
          const byId = new Map(records.map((r) => [r.cardId, r]));

          /*
           * ⚠️ 这里必须与首页 `todayOverview().dueCount` 口径一致（2026-11-08 修）。
           *
           * 原来的写法把「没学过的新卡」也算进到期：
           *   if (!r) return true; // 没学过也算今天可学
           * 于是首页写「8 张待复习」（只数有记录的到期卡），
           * 点进去却是「今天有 14 道题到了该复习的时候」（8 到期 + 6 新卡）——
           * 用户看到的 8 凭空变了 14，而且新卡被说成「到期」，两句话都不对。
           *
           * 现在分开算：
           *  - due   = 有记录且 dueAt <= today      ↔ 首页的 dueCount
           *  - fresh = 从没练过                       ↔ 首页的 freshCount
           * 两块在选题页分别呈现，各自说各自的话。
           */
          const due = all.filter((c) => {
            const r = byId.get(c.id);
            return r ? r.state.dueAt <= today : false;
          });
          const fresh = all.filter((c) => !byId.has(c.id));

          /*
           * 一批最多做 REVIEW_BATCH 张。
           *
           * 为什么不是「把全部到期的一次给完」：几百张一次塞进复习页，
           * 页面要一次渲染完，而且用户看不到「做完这批还剩多少」。
           * 但**截断必须说出来** —— 原来这里直接 slice(0,30) 且界面不提，
           * 到期 80 张时用户以为今天只有 30 张，做完就显示「完成」，
           * 那是在骗人。所以把真实总数一起存下来，由复习页如实显示。
           */
          setDueCards(due);
          setFreshCards(fresh);
          setQueueTotal(due.length);
        } catch (err) {
          setQueueError(err instanceof Error ? err.message : '读不出卡片');
          setDueCards([]);
          setFreshCards([]);
        }
      }
    },
    [loadCards, reviewService, library],
  );

  /**
   * 开始一轮练习。
   *
   * 由 PracticePage 在用户选好模式与范围后调用。
   * 这里只负责「把队列放进做题界面并跳过去」，
   * 具体选哪些题由 PracticePage 决定 —— 它知道三种模式的差别。
   */
  const startPractice = useCallback(
    (start: PracticeStart) => {
      setQueueError(null);
      setQueue(start.cards);
      setQueueTotal(start.dueTotal ?? start.cards.length);
      setPracticeMode(start.mode);
      setPracticeLabel(start.label);
      setPage('practice');
    },
    [],
  );

  // 卡片池是数组，每次渲染都可能是新引用 —— 用内容做 key 避免无谓重算
  const poolKey = useMemo(() => pool.join(','), [pool]);

  return (
    <AppShell
      current={page}
      onNavigate={(id) => void navigate(id)}
      counts={overviewCounts}
      connected={conn.connected}
      libraryName={libName}
      reviewProgress={null}
    >
      {page === 'board' ? (
        <BoardPage
          todos={todoService}
          suggestionInput={suggestionInput}
          onSuggestion={(kind) => {
            /*
             * 三种建议分别去三个地方：
             *  - 出题 → 我的题组（新建题组就地展开）
             *  - 练题组 → 做题（选题页）
             *  - 巩固错题 → 做题（选题页里选错题巩固）
             * 错题没有独立入口页，走做题页是对的 ——
             * 那里本来就有「错题巩固」这一档。
             */
            if (kind === 'make-questions') setPage('decks');
            else void navigate('review');
          }}
        />
      ) : page === 'focus' ? (
        <FocusPage focus={focusService} />
      ) : page === 'flow' ? (
        <MapPage
          reviewService={reviewService}
          loadCards={loadCards}
          decks={decks}
          knowledge={knowledge}
          sourceService={sourceService}
          onOpenPractice={() => void navigate('review')}
          onOpenWrongBook={() => setPage('wrongbook')}
          onOpenSources={() => setPage('sources')}
          onOpenDecks={() => setPage('decks')}
        />
      ) : page === 'exam' ? (
        <ExamPage
          exam={examService}
          decks={decks}
          sourceService={sourceService}
          onOpenDecks={() => setPage('decks')}
        />
      ) : page === 'notes' ? (
        <NotesPage
          notes={notesService}
          decks={decks}
          sourceService={sourceService}
          knowledge={knowledge}
          onOpenSource={(sourceId) => {
            setReaderSourceId(sourceId);
            setReaderTarget(null);
            setPage('reader');
          }}
          onOpenKnowledge={() => setPage('knowledge')}
        />
      ) : page === 'book' ? (
        <BookPage
          decks={decks}
          sourceService={sourceService}
          onOpenSource={(sourceId) => {
            setReaderSourceId(sourceId);
            setReaderTarget(null);
            setPage('reader');
          }}
          onOpenDecks={() => setPage('decks')}
        />
      ) : page === 'guide' ? (
        <GuidePage onNavigate={(id) => setPage(id)} />
      ) : page === 'tasks' ? (
        <TasksPage
          sourceService={sourceService}
          decks={decks}
          usage={usageService}
          knowledge={knowledge}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          onOpenDecks={() => setPage('decks')}
        />
      ) : page === 'skeleton' ? (
        <SkeletonPage
          knowledge={knowledge}
          sourceService={sourceService}
          decks={decks}
          onOpenKnowledge={() => setPage('knowledge')}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
        />
      ) : page === 'wrongbook' ? (
        <WrongBookPage
          reviewService={reviewService}
          decks={decks}
          loadCards={loadCards}
          knowledge={knowledge}
          sourceService={sourceService}
          onOpenSource={(sourceId) => {
            setReaderSourceId(sourceId);
            setReaderTarget(null);
            setPage('reader');
          }}
          onOpenPractice={() => void navigate('review')}
        />
      ) : page === 'knowledge' ? (
        <KnowledgePage
          knowledge={knowledge}
          sourceService={sourceService}
          onOpenAnchor={(t) => {
            setReaderSourceId(t.sourceId);
            setReaderTarget(t);
            setPage('reader');
          }}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
        />
      ) : page === 'study' ? (
        <StudyPage
          service={reviewService}
          cardPool={pool}
          dueCount={queueTotal || null}
          onStartQuiz={() => void navigate('review')}
          onOpenKnowledge={() => setPage('knowledge')}
          onOpenDecks={() => setPage('decks')}
        />
      ) : page === 'review' ? (
        <PracticePage
          decks={decks}
          sourceService={sourceService}
          reviewService={reviewService}
          loadCards={loadCards}
          dueCards={dueCards}
          freshCards={freshCards}
          dueTotal={queueTotal}
          onStart={startPractice}
          onOpenDecks={() => setPage('decks')}
          onOpenOrganize={() => {
            setOrganizeSourceId(null);
            setPage('organize');
          }}
        />
      ) : page === 'practice' ? (
        queue === null ? (
          <p className="today__lead">{queueError ?? '正在准备这一轮的题…'}</p>
        ) : (
          <ReviewPage
            service={reviewService}
            queue={queue}
            dueTotal={queueTotal}
            gradingRules={gradingRules}
            mode={practiceMode}
            modeLabel={practiceLabel}
            notes={notesService}
            onFinish={() => void navigate('review')}
            onExit={() => void navigate('review')}
          />
        )
      ) : page === 'sources' ? (
        <SourcesPage
          service={sourceService}
          onOpenSource={(source) => {
            /*
             * 点资料行 = 打开原文。阅读器做出来之前这里跳的是整理页，
             * 因为那时没有别的事能做；现在能真的打开原文了。
             */
            setReaderSourceId(source.id);
            setReaderTarget(null); // 从资料页进来是纯阅读，不定位
            setPage('reader');
          }}
          onOrganizeSource={(source) => {
            setOrganizeSourceId(source.id);
            setPage('organize');
          }}
          onImported={() => void refreshData()}
        />
      ) : page === 'reader' ? (
        <ReaderPage
          sourceService={sourceService}
          initialSourceId={readerSourceId}
          target={readerTarget}
          onBack={() => setPage('sources')}
        />
      ) : page === 'organize' ? (
        <OrganizePage
          sourceService={sourceService}
          knowledge={knowledge}
          backends={backends}
          initialSourceId={organizeSourceId}
          onBack={() => setPage('sources')}
          onChanged={() => {
            /* 改的是题库/资料结构 → 卡片池必须重算（见 refreshData 注释） */
            void refreshData();
            void refreshShellState();
          }}
          onOpenAnchor={(t) => {
            // 从知识点的「可点回原文」跳到阅读器，并定位到那一句
            setReaderSourceId(t.sourceId);
            setReaderTarget(t);
            setPage('reader');
          }}
        />
      ) : page === 'decks' ? (
        <DecksPage
          decks={decks}
          sourceService={sourceService}
          knowledge={knowledge}
          backends={backends}
          initialDeckId={openedDeckId}
          onGenerated={() => void refreshData()}
          onOpenSources={() => setPage('sources')}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          onOpenSource={(sourceId) => {
            setReaderSourceId(sourceId);
            setReaderTarget(null);
            setPage('reader');
          }}
          onChanged={() => {
            /* 改的是题库/资料结构 → 卡片池必须重算（见 refreshData 注释） */
            void refreshData();
            void refreshShellState();
          }}
        />
      ) : page === 'stats' ? (
        <StatsPage service={reviewService} cardPool={pool} />
      ) : page === 'settings' ? (
        <SettingsPage onChanged={() => void refreshShellState()} />
      ) : page === 'today' ? (
        <TodayPage
          key={poolKey}
          service={reviewService}
          cardPool={pool}
          hasSources={hasSources}
          connected={conn.connected}
          modelName={conn.modelName}
          onOpenSources={() => setPage('sources')}
          /*
           * 必须走 navigate，不能 setPage('review')。
           *
           * 用户 2026-11-08 报：「界面显示 8 张待复习，点进去没有任何关于 8 的内容」。
           * 根因就在这里 —— navigate 里有「进做题前重算今日到期」那一段
           * （读卡片、算 due、setDueCards / setQueueTotal），setPage 全绕过了。
           * 于是选题页拿到 dueCards=[]、dueTotal=0，而首页明明写着 8 张。
           */
          onStartReview={() => void navigate('review')}
          onOpenDecks={() => setPage('decks')}
          onOpenDeck={(deckId) => {
            /*
             * 首页点「最近在练的题组」某一行：跳过去并展开那一个。
             * 必须先设 openedDeckId 再切页 —— DecksPage 的展开是由
             * initialDeckId 驱动的 effect，顺序反了它拿到的还是旧值。
             */
            setOpenedDeckId(deckId);
            setPage('decks');
          }}
          onOpenMap={() => setPage('flow')}
          onOpenWrongBook={() => setPage('wrongbook')}
          loadCards={loadCards}
          decks={decks}
          knowledge={knowledge}
          sourceService={sourceService}
        />
      ) : page === 'generate' ? (
        /*
         * 「创建题组」已整合进「我的题组」（DecksPage 里点「新建题组」就地展开）。
         *
         * 但这里**仍要留一个分支**：旧状态、书签、以及「下一步」卡片都可能
         * 把 page 设成 generate。以前没有这个分支，于是掉进最后的 Placeholder，
         * 用户看到「这一页还在重做中」—— 一个功能明明能用，界面却说没做。
         * 现在直接送去「我的题组」，并在那边默认展开新建表单（见 initialCreate）。
         */
        <DecksPage
          decks={decks}
          sourceService={sourceService}
          knowledge={knowledge}
          backends={backends}
          initialCreate
          onGenerated={() => void refreshData()}
          onOpenSources={() => setPage('sources')}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          onOpenSource={(sourceId) => {
            setReaderSourceId(sourceId);
            setReaderTarget(null);
            setPage('reader');
          }}
          onChanged={() => {
            /* 改的是题库/资料结构 → 卡片池必须重算（见 refreshData 注释） */
            void refreshData();
            void refreshShellState();
          }}
        />
      ) : (
        <Placeholder page={page} onBack={() => setPage('today')} />
      )}
    </AppShell>
  );
}

/**
 * 未完成页面的占位。
 *
 * 明确写「还没做好」并给出返回路径 ——
 * 不给一个点了没反应的按钮，那比没有更糟。
 */
function Placeholder({ page, onBack }: { page: PageId; onBack: () => void }) {
  const names: Record<PageId, string> = {
    today: '学习库',
    review: '做题',
    study: '开始学习',
    knowledge: '知识库',
    sources: '资料',
    generate: '创建题组',
    decks: '我的题组',
    tasks: '任务',
    wrongbook: '错题与待巩固',
    flow: '学习流',
    notes: '学习笔记',
    board: '待办',
    focus: '专注',
    exam: '模拟考试',
    examprep: '备考补习',
    book: '复习全书',
    stats: '统计',
    skeleton: '知识骨架',
    audio: '音频转写',
    record: '课堂实录',
    organize: '整理知识点',
    reader: '阅读原文',
    practice: '做题中',
    guide: '功能导览',
    settings: '设置',
  };

  return (
    <div style={{ maxWidth: '52ch' }}>
      <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: 'var(--space-3)' }}>
        {names[page]}
      </h1>
      <p
        style={{
          color: 'var(--text-dim)',
          lineHeight: 'var(--lh-body)',
          marginBottom: 'var(--space-5)',
        }}
      >
        这一页还在重做中。现在能用的有：学习库、资料、知识库、我的题组、做题、统计、设置。
      </p>
      <button type="button" className="btn-ghost" onClick={onBack}>
        回到学习库
      </button>
    </div>
  );
}
