import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { AppShell } from './AppShell.tsx';
import { TodayPage } from './TodayPage.tsx';
import { ReviewPage } from './ReviewPage.tsx';
import { PracticePage } from './PracticePage.tsx';
import { WrongBookPage } from './WrongBookPage.tsx';
import type { WrongBookView } from './WrongBookPage.tsx';
import { TasksPage } from './TasksPage.tsx';
import { SkeletonPage } from './SkeletonPage.tsx';
import { GuidePage } from './GuidePage.tsx';
import { BookPage } from './BookPage.tsx';
import { buildReviewQueue, type ReviewQueue } from './review-session.ts';
import { todayLocal, type ReviewGrade } from '@/v2/core/srs.ts';
import { NotesPage } from './NotesPage.tsx';
import { ExamPage } from './ExamPage.tsx';
import { MapPage } from './MapPage.tsx';
import { BoardPage } from './BoardPage.tsx';
import { FocusPage } from './FocusPage.tsx';
import { badgeCounts, resolvePool } from './data-sync.ts';
import { downloadBlob } from '@/pages/slides/download.ts';
import type { PracticeStart } from './PracticePage.tsx';
import { SourcesPage } from './SourcesPage.tsx';
import { DecksPage } from './DecksPage.tsx';
import { StudyPage } from './StudyPage.tsx';
import { KnowledgePage } from './KnowledgePage.tsx';
import { TrashPage } from './TrashPage.tsx';
import { DEFAULT_WIDGETS, widgetsFromSettings, type HomeWidget } from './home-widgets.ts';
import { fetchDailyQuote } from './daily-quote.ts';
import type { Todo } from '@/core/model.ts';
import { StatsPage } from './StatsPage.tsx';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
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
   * 批注服务（2026-11-09）。
   *
   * 阅读器右侧边栏的「批注」模式要读写它。
   * 可选：不给就只是没有批注能力，其它功能不受影响。
   */
  annotations?: AnnotationService;
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
  annotations,
  cardPool,
  hasSources,
  connected,
  modelName,
}: AppProps) {
  const [page, setPage] = useState<PageId>('today');
  /**
   * 进阅读器之前在哪一页（2026-11-09）。
   *
   * 用户需求原话：「需要一个返回按钮放在软件左上角，从错题库或是
   * 知识点跳转到资料内时，不能返回回去。频繁的跳转很麻烦，
   * 同时也不好定位原先的位置。」
   *
   * 记下来源页，阅读器的返回按钮就能回到那里 ——
   * 而不是一律回「资料」列表（那正是「回不去」的感受来源）。
   *
   * 只记页面 id，不记 DOM 状态：页面组件在返回时重新挂载，
   * 内部 state（分组展开、滚动位置）由各页自己恢复。
   * 这不如「保持挂载」完美，但不需要给 45 个页面各写一套序列化。
   */
  const [readerFrom, setReaderFrom] = useState<PageId | null>(null);

  /**
   * 进「复习巩固」时是否直接开始**今日复习**（2026-11-09 改）。
   *
   * 用户把「开始复习」绑到了复习巩固页：点它就该开始复习。
   * 原来的实现进的是「自测」，用户实测后指出那跟做题没区别 ——
   * 现在进的是真正的复习会话（只做到期、先回想再看答案、写间隔）。
   *
   * 用完即清 —— 否则下次从侧栏正常进这一页也会被直接拽进复习。
   */
  const [autoReview, setAutoReview] = useState(false);
  /**
   * 今日复习队列（2026-11-09）。
   *
   * 由 computeReviewQueue() 算好放在这里，BookPage 直接拿来开始 ——
   * 不让它自己去查库：队列的构造口径（哪些算到期、批次多长）
   * 必须与首页「今日到期」一致，放在 App 一处才不会两处漂。
   */
  const [reviewQueue, setReviewQueue] = useState<ReviewQueue | null>(null);
  /**
   * 全局返回栈（2026-11-09）。
   *
   * 需求原话：「需要一个返回按钮放在软件左上角，从错题库或是知识点
   * 跳转到资料内时，不能返回回去。频繁的跳转很麻烦，同时也不好定位
   * 原先的位置。」
   *
   * ## 与 readerFrom 的分工
   *
   * `readerFrom` 只管阅读器这一个入口（它还要额外清 target）。
   * 这个栈是**通用**的：任何页面跳转都记一层，左上角返回按钮
   * 就能一路退回去，而不是只能退回某一页。
   *
   * 为什么用 ref 存栈：栈不参与渲染；用 state 会让每次跳转都多一次
   * 无意义重渲染。「能不能返回」由单独一个布尔状态驱动。
   */
  const navStackRef = useRef<PageId[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);

  /**
   * 统一跳转。
   *
   * @param keepHistory 默认 true（记住来路）。侧栏点击传 false ——
   *   用户点侧栏是「我要去那儿」，不是「从这儿钻进去」，
   *   压栈会让返回跳到一个他没想去的页面。
   */
  const goPage = useCallback((next: PageId, keepHistory = true) => {
    setPage((prev) => {
      if (prev === next) return next;
      if (keepHistory) {
        navStackRef.current.push(prev);
        if (navStackRef.current.length > 20) navStackRef.current.shift();
      } else {
        navStackRef.current = [];
      }
      setCanGoBack(navStackRef.current.length > 0);
      return next;
    });
  }, []);

  /** 左上角返回：退一步 */
  const goBack = useCallback(() => {
    const prev = navStackRef.current.pop();
    setCanGoBack(navStackRef.current.length > 0);
    if (prev === undefined) return;
    setPage(prev);
  }, []);

  /**
   * 打开阅读器，并记住从哪来。
   *
   * 统一入口，避免 8 处 `setPage('reader')` 各写一遍而漏记来源 ——
   * 漏一处的表现就是「从某个页面进去后返回跳到了别处」。
   */
  const openReader = useCallback(
    (sourceId: string, target: ReaderTarget | null) => {
      setReaderSourceId(sourceId);
      setReaderTarget(target);
      setPage((prev) => {
        if (prev !== 'reader') {
          /* 已经在阅读器里（阅读器内部再跳一段）就不覆盖来源 */
          setReaderFrom(prev);
          navStackRef.current.push(prev);
          if (navStackRef.current.length > 20) navStackRef.current.shift();
          setCanGoBack(true);
        }
        return 'reader';
      });
    },
    [],
  );

  /** 从阅读器返回：回到来时的那一页 */
  const closeReader = useCallback(() => {
    const back = readerFrom ?? 'sources';
    setPage(back);
    setReaderFrom(null);
    setReaderTarget(null);
    /* 阅读器这一跳也要从返回栈里退掉，否则左上角会多出一个重复的来路 */
    const top = navStackRef.current[navStackRef.current.length - 1];
    if (top === back) {
      navStackRef.current.pop();
      setCanGoBack(navStackRef.current.length > 0);
    }
  }, [readerFrom]);

  /**
   * 错题页的视图状态（2026-11-09）。
   *
   * 由 App 持有而不是错题页自己管：用户从错题跳原文再返回时，
   * 页面会重新挂载，组件内部 state 全丢 —— 分组又折叠、要重新找到
   * 刚才那一题。那正是用户说的「返回后不好定位原先的位置」。
   *
   * 提到 App 层后，返回时这三样原样还在。
   */
  const [wrongbookView, setWrongbookView] = useState<WrongBookView>({
    groupBy: 'deck',
    sort: 'wrongCount',
    open: new Set<string>(),
  });

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
    trash: trashService,
    knowledge: knowledgeService,
  } = useServices();

  /**
   * 回收站角标数字（2026-11-08）：有多少项「距彻底删除不到 24 小时」。
   *
   * 为什么需要它：用户不一定会主动点开回收站。
   * 角标是唯一能让他注意到「有东西明天就要没了」的地方。
   */
  const [trashBadge, setTrashBadge] = useState(0);
  const refreshTrashBadge = useCallback(async () => {
    try {
      const soon = await trashService.pendingReminders();
      setTrashBadge(soon.length);
    } catch {
      // 读不到就不显示角标，不要把数字清零假装没有 —— 保持原样更诚实
    }
  }, [trashService]);

  /**
   * 启动时扫一遍回收站（2026-11-08，用户要求）。
   *
   * 做两件事：
   *  1. 把已过期（>30 天）的彻底删掉
   *  2. 把「距过期 <24 小时」的数量报出来，让人看到提醒
   *
   * 为什么用 useEffect 而不是定时器：这个应用不常驻后台，
   * 关着的时候定时器不会跑。启动时扫一遍保证每次打开都清理，
   * 语义也更简单 —— 30 天的窗口，用户一个月内总会开一次。
   */
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await trashService.sweep();
        if (cancelled) return;
        await refreshTrashBadge();
        if (cancelled) return;
        if (r.reminded > 0) {
          setTrashNotice(
            `回收站里有 ${r.reminded} 项还剩不到 24 小时就会被彻底删除。` +
              `想留的话现在还能还原。`,
          );
        }
      } catch {
        // 清扫失败不该拦住用户用应用
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trashService, refreshTrashBadge]);

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

  /**
   * 首页小组件配置（2026-11-08）。
   *
   * 为什么在这里读而不是让 TodayPage 自己读：
   *  - 设置页改完要能让首页立刻反映（同一个状态源）
   *  - 待办数据也要一并给（todo 小组件用）
   *  - TodayPage 是个纯展示组件，不该再连库
   */
  const [homeWidgets, setHomeWidgets] = useState<HomeWidget[]>(() => [...DEFAULT_WIDGETS]);
  const [homeTodos, setHomeTodos] = useState<Todo[]>([]);
  /**
   * 每日一句的内容（2026-11-08，用户要求联网）。
   *
   * 取法见 daily-quote.ts：远程优先、**失败静默回落内置语料**。
   * 所以这个 state 永远有值（最差也是本地那句），首页不会空。
   */
  const [dailyQuote, setDailyQuote] = useState<{
    text: string;
    author: string | null;
  } | null>(null);
  const refreshHomeWidgets = useCallback(async () => {
    try {
      const [settings, list] = await Promise.all([library.getSettings(), todoService.list()]);
      setHomeWidgets(widgetsFromSettings(settings));
      setHomeTodos(list);

      /*
       * 拉每日一句。`void` 不 await：它是装饰性内容，
       * 不该挡住首页其它区块的渲染（网络慢时首页会白屏几秒）。
       */
      const endpoint = (settings as unknown as { dailyQuoteEndpoint?: string })
        .dailyQuoteEndpoint;
      void fetchDailyQuote({ endpoint }).then((r) => setDailyQuote({ text: r.text, author: r.author }));
    } catch {
      // 读不到就保持默认的每日一句，不让首页空着
    }
  }, [library, todoService]);

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
    void refreshHomeWidgets();
  }, [refreshShellState, refreshHomeWidgets]);

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


  /**
   * 重算「今日到期」卡片（2026-11-09 抽出）。
   *
   * 原来这段只在 `navigate('review')` 里跑。但「开始复习」现在要
   * **跳过选题页直接开做**，不能先跳页再算 —— 那样 dueCards 还是空的，
   * 结果就是「点了没反应」（实测确认）。
   *
   * 返回算出来的到期卡，调用方直接拿去 startPractice。
   */
  const computeDueCards = useCallback(async (): Promise<Card[]> => {
    setQueueError(null);
    try {
      const all = await loadCards();
      /*
       * 与首页 `todayOverview().dueCount` 同一口径（2026-11-08 的教训）：
       * 只数**有记录且 dueAt 已到**的卡，不把没学过的新卡算进来。
       * 否则首页写「8 张待复习」、这里算 14 张，同一屏两个数字对不上。
       */
      const today = new Date().toISOString().slice(0, 10);
      const records = await reviewService.listRecords();
      const byId = new Map(records.map((r) => [r.cardId, r]));

      const due = all.filter((c) => {
        const r = byId.get(c.id);
        return r ? r.state.dueAt <= today : false;
      });
      const fresh = all.filter((c) => !byId.has(c.id));

      setDueCards(due);
      setFreshCards(fresh);
      setQueueTotal(due.length);
      return due;
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : '读不出卡片');
      setDueCards([]);
      setFreshCards([]);
      return [];
    }
  }, [loadCards, reviewService]);

  /**
   * 算出「今日复习」队列并开始（2026-11-09）。
   *
   * ## 为什么与 computeDueCards 分开
   *
   * `computeDueCards` 给**做题页**用：它只算到期卡，让用户自己挑模式。
   * 而「今日复习」的语义更强 —— 到期卡 + 新卡、按批次截断、逾期最久在前。
   * 两者口径不同（一个纯到期、一个含新卡），混用会产生
   * 「首页说 9 张、复习页说 12 张」那种对不上的数字。
   *
   * ## 为什么新卡也算进来
   *
   * 用户库里常常没有到期卡（刚建库、或旧记录已处理完）。
   * 那时若只做到期，点「开始复习」会面对一个空页面。
   * Anki 的做法也是新卡与到期卡一起排进今日队列 —— 照做。
   */
  const startTodayReview = useCallback(async (): Promise<boolean> => {
    try {
      const all = await loadCards();
      const records = await reviewService.listRecords();
      const dueAtByCard = new Map(records.map((r) => [r.cardId, r.state.dueAt]));
      const today = todayLocal();

      const queue = buildReviewQueue({
        cards: all.map((c) => ({ id: c.id, question: c })),
        dueAtByCard,
        today,
        promptOf: (q) => (q as { prompt?: string }).prompt ?? '',
      });

      setReviewQueue(queue);
      setAutoReview(true);
      goPage('book', true);
      return queue.total > 0;
    } catch {
      /* 算不出来也要进页面 —— 那里会显示「今天没有到期的卡」并给下一步 */
      setReviewQueue({ due: [], fresh: [], total: 0, availableBeforeLimit: 0 });
      setAutoReview(true);
      goPage('book', true);
      return false;
    }
  }, [loadCards, reviewService, goPage]);

  /**
   * 自评一档 → 写复习记录（2026-11-09）。
   *
   * 这是「复习」与「自测」的本质区别：自测不写，复习写。
   * 写入后立刻刷新首页概览，否则回到首页看到的还是旧数字。
   */
  const handleReviewGrade = useCallback(
    async (cardId: string, g: ReviewGrade) => {
      await reviewService.review(cardId, 'question', g);
      void refreshData();
    },
    [reviewService, refreshData],
  );

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
         * 先算好今日到期供选题页显示数量；用户选完模式才由
         * startPractice() 构造队列并跳到 practice 页。
         */
        await computeDueCards();
      }
    },
    [computeDueCards, library],
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
      /*
       * 侧栏点击传 keepHistory=false（2026-11-09）。
       * 用户点侧栏是「我要去那儿」，不是「从这儿钻进去」——
       * 压栈会让左上角的返回跳到一个他没想去的页面。
       */
      onNavigate={(id) => {
        goPage(id, false);
        void navigate(id);
      }}
      counts={overviewCounts}
      connected={conn.connected}
      libraryName={libName}
      reviewProgress={null}
      trashBadge={trashBadge}
      onBack={
        page === 'reader'
          ? () => {
              /* 阅读器有自己的返回语义（回到来路），与通用栈一致 */
              closeReader();
            }
          : goBack
      }
      canGoBack={page === 'reader' ? readerFrom !== null : canGoBack}
      backToLabel={
        page === 'reader'
          ? (readerFrom ? PAGE_LABEL_FOR_BACK[readerFrom] : null)
          : null
      }
    >
      {/*
        回收站提醒条（2026-11-08）。
        用户要求「距过期 24 小时时弹出提醒」。做成顶部横幅而不是模态框：
        模态框会打断正在做的事，而这件事没那么紧急 —— 还有一天。
        横幅随时可关，点「去回收站」直接跳过去。
      */}
      {trashNotice ? (
        <div className="trash-notice" role="status">
          <span className="trash-notice__text">{trashNotice}</span>
          <button
            type="button"
            className="trash-notice__go"
            onClick={() => {
              setTrashNotice(null);
              void navigate('trash');
            }}
          >
            去回收站
          </button>
          <button
            type="button"
            className="trash-notice__close"
            aria-label="关掉这条提醒"
            onClick={() => setTrashNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
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
          onOpenSource={(sourceId) => openReader(sourceId, null)}
          onOpenKnowledge={() => setPage('knowledge')}
        />
      ) : page === 'book' ? (
        <BookPage
          decks={decks}
          sourceService={sourceService}
          onOpenSource={(sourceId) => openReader(sourceId, null)}
          /*
           * 自测答错后跳回原文那一页（2026-11-09）。
           * 只传 sourceId 会让阅读器打开第一页 —— 那等于没定位。
           */
          onOpenSourceAt={(sourceId, page, quote) =>
            openReader(sourceId, { sourceId, page, quote })
          }
          onOpenDecks={() => setPage('decks')}
          autoStartReview={autoReview}
          onAutoStartConsumed={() => setAutoReview(false)}
          reviewQueue={reviewQueue}
          onReviewGrade={handleReviewGrade}
        />
      ) : page === 'guide' ? (
        <GuidePage onNavigate={(id) => setPage(id)} />
      ) : page === 'tasks' ? (
        <TasksPage
          sourceService={sourceService}
          decks={decks}
          usage={usageService}
          knowledge={knowledgeService}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          onOpenDecks={() => setPage('decks')}
          /*
            任务记录删除（2026-11-08）。
            只删记录，不动知识点/题目 —— 服务层注释里写了理由。
          */
          onRemoveRun={async (id) => {
            await knowledgeService.removeRun(id);
            void refreshTrashBadge();
          }}
          onClearRuns={async () => {
            await knowledgeService.clearRuns();
            void refreshTrashBadge();
          }}
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
          onOpenSource={(sourceId, anchor) => {
            /*
             * 把锚点一起送过去（2026-11-09）。
             *
             * 原来这里写死 `setReaderTarget(null)`：错题页的「看原文」
             * 点了永远打开资料第一页，用户看到的是封面 —— 定位等于没做。
             * 现在带上锚点，阅读器用它已有的定位逻辑（偏移优先、引文兜底）
             * 翻到那一页并高亮。
             */
            openReader(
              sourceId,
              anchor
                ? {
                    sourceId,
                    page: anchor.page,
                    charStart: anchor.charStart,
                    charEnd: anchor.charEnd,
                    quote: anchor.quote,
                  }
                : null,
            );
          }}
          onOpenPractice={() => void navigate('review')}
          view={wrongbookView}
          onViewChange={setWrongbookView}
          onExportObsidian={async (deckId) => {
            /*
             * 导出为 Obsidian 闪卡。
             *
             * deckId 为空时无法导出 —— 调用方（WrongBookPage）保证会传一个，
             * 这里再挡一层是为了不让 null 变成「悄悄什么都不做」。
             */
            if (!deckId) throw new Error('没有可导出的题组');
            const r = await decks.exportObsidian(deckId, {
              // 带出处：错题最需要能翻回原文确认
              includeSource: true,
            });
            /*
             * 下载用的 MIME：text/markdown。
             * 不用 application/octet-stream —— Obsidian 用户可能会
             * 直接把文件拖进浏览器预览，纯文本更容易被正确处理。
             */
            downloadBlob(new Blob([r.content], { type: 'text/markdown;charset=utf-8' }), r.fileName);
            return { fileName: r.fileName, count: r.count };
          }}
        />
      ) : page === 'knowledge' ? (
        <KnowledgePage
          knowledge={knowledge}
          sourceService={sourceService}
          onOpenAnchor={(t) => openReader(t.sourceId, t)}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          /*
            知识点删除（2026-11-08）。
            走 knowledgeService.remove —— 那条路径已经接了回收站，
            所以误删能还原。删完要刷新壳层计数（知识库数字会变）。
          */
          onRemovePoint={async (id) => {
            await knowledgeService.remove(id);
            void refreshShellState();
            void refreshTrashBadge();
          }}
          onRemoveSourcePoints={async (sourceId) => {
            /*
              「删掉一份资料的全部知识点」有两种来源：
              - 有归属资料 → clearBySource
              - 没有归属（sourceId 为 null）→ 只有「已删除的资料」那一组会这样，
                这时按列表里的孤儿知识点逐条删
            */
            if (sourceId) {
              await knowledgeService.clearBySource(sourceId);
            } else {
              const orphans = (await knowledgeService.listAll()).filter((p) => !p.sourceId);
              for (const p of orphans) await knowledgeService.remove(p.id);
            }
            void refreshShellState();
            void refreshTrashBadge();
          }}
          /*
            改知识点标签（2026-11-10）。

            只改 tags —— 它不参与定位，所以锚点与「可点回原文」都不受影响，
            已出的题也不受牵连。这条路径存在的意义是：AI 的分类可能不对，
            得让用户能自己纠正，而不是只能删了重整理。
          */
          onUpdateTags={async (id, tags) => {
            await knowledgeService.update(id, { tags });
            void refreshShellState();
          }}
        />
      ) : page === 'study' ? (
        <StudyPage
          service={reviewService}
          cardPool={pool}
          dueCount={queueTotal || null}
          onStartQuiz={() => void navigate('review')}
          /*
           * 「开始复习」直接进今日到期队列（2026-11-09 修）。
           *
           * 原来它和「开始做题」都只调 `navigate('review')` ——
           * 两个按钮跳到同一个选题页，**字面上做的是同一件事**
           * （用户实测指出「复习功能从未真正实现」，判断准确）。
           *
           * 现在：真的按遗忘曲线把「今天该复习的」直接排好开始做，
           * 跳过选题页。到期为空时不硬跳 —— 交给 StudyPage 说明情况，
           * 免得进去看到空队列（那正是「点了没反应」的另一种形式）。
           */
          onStartReview={() => {
            /*
             * 「开始复习」= 进入**今日复习会话**（2026-11-09 再改）。
             *
             * 上一版把它指向「自测」，用户实测后指出那跟做题没区别——
             * 因为自测仍是「自由挑卷、随时翻页、不写记录」。
             *
             * 现在走 startTodayReview：只做到期 + 新卡、先回想再看答案、
             * 自评四档**写进间隔**、做完出今日回顾。这才是复习。
             */
            void startTodayReview();
            return true;
          }}
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
            openReader(source.id, null); // 从资料页进来是纯阅读，不定位
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
          annotations={annotations}
          initialSourceId={readerSourceId}
          target={readerTarget}
          /* 回到**来时那一页**（原来一律回「资料」，从错题进来时等于回不去） */
          onBack={closeReader}
          backLabel={readerFrom ? PAGE_LABEL_FOR_BACK[readerFrom] : undefined}
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
            openReader(t.sourceId, t);
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
          onOpenSource={(sourceId) => openReader(sourceId, null)}
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
      ) : page === 'trash' ? (
        <TrashPage
          trash={trashService}
          onChanged={() => {
            // 还原会让题数、知识点数变化，和别的删除一样要刷新
            void refreshData();
            void refreshShellState();
            void refreshTrashBadge();
          }}
        />
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
          /*
           * 首页的「开始复习」（2026-11-09 改）。
           *
           * 这里长期写的是 `navigate('review')` —— 也就是进**做题页**。
           * 用户反复反馈「开始复习跟开始做题没区别」，根因就在这一行：
           * 上一轮只改了「开始学习」页里那个入口，首页这个漏了，
           * 而首页才是用户最常用的入口。
           *
           * 现在与「开始学习」一致，走真正的今日复习会话。
           */
          onStartReview={() => void startTodayReview()}
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
          widgets={homeWidgets}
          quote={dailyQuote}
          todos={homeTodos}
          onOpenBoard={() => setPage('board')}
          /* 今日学习卡的「开始学新题」→ 开始学习页（那里有三种模式的入口） */
          onOpenStudy={() => setPage('study')}
          onStartFocus={() => setPage('focus')}
          onOpenSettings={() => setPage('settings')}
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
          onOpenSource={(sourceId) => openReader(sourceId, null)}
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
 * 阅读器返回按钮上该写哪一页的名字（2026-11-09）。
 *
 * 只列**会跳到阅读器的**那些页。其它页永远不会成为来源，
 * 列进来只是噪音，还会让人以为从别处也能进阅读器。
 *
 * 为什么按钮上要写具体页名而不是笼统的「返回」：
 * 用户从错题页跳进原文，最怕的是「返回后不知道自己在哪」。
 * 写着「返回错题与待巩固」比一个箭头清楚得多。
 */
const PAGE_LABEL_FOR_BACK: Partial<Record<PageId, string>> = {
  wrongbook: '错题与待巩固',
  knowledge: '知识库',
  organize: '整理知识点',
  decks: '我的题组',
  sources: '资料',
  book: '复习巩固',
};

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
    book: '复习巩固',
    stats: '统计',
    skeleton: '知识骨架',
    audio: '音频转写',
    record: '课堂实录',
    organize: '整理知识点',
    reader: '阅读原文',
    practice: '做题中',
    guide: '功能导览',
    trash: '回收站',
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
