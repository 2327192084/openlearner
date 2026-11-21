import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { AppShell } from './AppShell.tsx';
import { PageLayerContext } from './page-layer-context.ts';
import { PageTaskContext, type PageTaskReporter } from './page-task-context.ts';
import {
  EMPTY_TASKS,
  dropPage,
  layersToRender,
  reportTask,
  resumeTarget,
  type LayerTask,
} from './page-layers.ts';
import { TodayPage } from './TodayPage.tsx';
import { ReviewPage } from './ReviewPage.tsx';
import { FlashcardsPage } from './FlashcardsPage.tsx';
import './flashcards-page.css';
import { PracticePage } from './PracticePage.tsx';
import { WrongBookPage } from './WrongBookPage.tsx';
import type { WrongBookView } from './WrongBookPage.tsx';
import { TasksPage } from './TasksPage.tsx';
import { SkeletonPage } from './SkeletonPage.tsx';
import { SearchPage } from './SearchPage.tsx';
import { GuidePage } from './GuidePage.tsx';
import { BookPage } from './BookPage.tsx';
import { buildReviewQueue, type ReviewQueue } from './review-session.ts';
import { buildPickPrompt, parsePicks, type FlashcardCandidate } from '@/core/ai/pick-flashcards.ts';
import {
  buildCardPrompt,
  parseCards,
  type CardMaterial,
} from '@/core/ai/make-flashcards.ts';
import { draftFromPoint, type FlashcardView } from '@/core/flashcards.ts';
import {
  buildAskPrompt,
  buildJudgePrompt,
  buildOralSystemPrompt,
  parseJudgement,
  pickMaterial,
  pointsToMaterials,
  type OralJudgement,
  type OralMaterial,
} from '@/core/oral-review.ts';
import {
  listOralScopes,
  materialsForScope,
  type OralScopeOption,
} from '@/core/oral-scope-service.ts';
import {
  buildShortGradePrompt,
  parseShortGrade,
  type ShortGradeInput,
  type ShortGradeResult,
} from '@/core/ai/grade-short.ts';
import { todayLocal, type ReviewGrade } from '@/v2/core/srs.ts';
import { NotesPage } from './NotesPage.tsx';
import { ExamPage } from './ExamPage.tsx';
import { MapPage } from './MapPage.tsx';
import { normalizeStudyPlan, planToSteps, type StudyPlan } from '@/v2/core/study-plan-store.ts';
import { loadPlanInputs } from '@/v2/core/plan-inputs.ts';
import { normalizeSourceRoute } from '@/v2/core/source-route-store.ts';
import type { SourceRoute } from '@/core/ai/source-route.ts';
import type { SearchResult } from '@/core/ai/web-search.ts';
import type { SourcePlanPrep } from '@/v2/core/source-plan-inputs.ts';
import { RoutePreviewDialog } from './RoutePreviewDialog.tsx';
import type { PlanOrder, PlanPointInput } from '@/core/ai/plan-order.ts';
import type { ChapterPreview } from '@/core/ai/chapter-backfill.ts';
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
import type { KnowledgePoint, Todo } from '@/core/model.ts';
import { StatsPage } from './StatsPage.tsx';
import { AnswerRecordPage } from './AnswerRecordPage.tsx';
import './answer-record-page.css';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
import type { BackendService } from '@/core/backends.ts';
import type { SourceService } from '@/core/sources.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { ExplainNote } from '@/core/model.ts';
import type { ExplainResult } from '@/core/ai/explain-wrong.ts';
import type { HintLevel, HintResult } from '@/core/ai/hint-ladder.ts';
import {
  explainToRows,
  mergeAnswerRows,
  oralToRows,
  type AnswerRecordRow,
} from '@/v2/core/answer-record.ts';

/**
 * 空数组常量。
 *
 * 为什么不在渲染处写 `[]`：`explainNotesOf` 每次渲染都会调用，
 * 返回一个新数组会让 `ExplainPanel` 的 props 每次都不相等
 * （浅比较下等同于「变了」），白白重渲染。
 * 同一个常量引用则可以稳定跳过。
 */
const EMPTY_NOTES: readonly ExplainNote[] = [];
import type { PageId } from './pages.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { OrganizePage } from './OrganizePage.tsx';
import { ParsePage } from './ParsePage.tsx';
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
import './rename-field.css';
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
import './route-map.css';
import './route-planner.css';
import './route-board.css';
import './search-key-field.css';
import './route-preview.css';
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
   * 首页各行「点了跳到哪个具体对象」（2026-11-13 深夜，用户要求）。
   *
   * 用户原话：「点击界面上的题组、错题或是资料能直接跳转到对应的题组、
   * 错题或是资料页面，不用再到对于功能栏打开」。
   *
   * 目标页（学习地图 / 错题页）需要知道「落到哪一个」，
   * 所以这里存一份待定位的 id。`token` 每次点都递增 ——
   * 否则同一行再点一次时 id 没变，目标页的 effect 不会重跑，
   * 表现为「第二次点没反应」。
   *
   * 只保留一种：同一时刻只会从首页跳到一处，不需要栈。
   */
  const [mapFocus, setMapFocus] = useState<{ sourceId: string | null; token: number }>({
    sourceId: null,
    token: 0,
  });
  const [wrongFocus, setWrongFocus] = useState<{ cardId: string | null; token: number }>({
    cardId: null,
    token: 0,
  });

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
   * 页面覆盖层状态（2026-11-13 下午；傍晚按用户反馈重做判据）。
   *
   * `tasks` = **页面自己上报的「我在干什么、到哪一步了」**，不是白名单。
   *
   * 为什么不靠白名单：第一版把「页面在保活栈里」当成「有任务在进行」，
   * 用户随即报「没有正在进行文档解析的任务时，这个提示也一直存在」——
   * 打开过一次解析页就永久留一层，提示永远在。详见 page-layers.ts 头注释。
   *
   * 现在：上报了任务才保活、才有「继续」入口；任务结束（上报 null）
   * 立刻消失。页面比 App 更清楚自己有没有在干活。
   */
  const [tasks, setTasks] = useState<readonly LayerTask[]>(EMPTY_TASKS);

  /**
   * 给某一层绑定的上报器。
   *
   * 每一层一个稳定的 report 函数（按页面 id 缓存），页面里用
   * `usePageTask()` 调用它 —— 页面不需要知道自己在哪一层。
   *
   * 用 ref 缓存：每次渲染都新建 report 会让 context value 变化，
   * 进而让所有页面重新上报，形成重渲染循环。
   */
  const taskReporters = useRef(new Map<PageId, PageTaskReporter>());
  const reporterFor = useCallback((pid: PageId): PageTaskReporter => {
    const cached = taskReporters.current.get(pid);
    if (cached) return cached;
    const reporter: PageTaskReporter = {
      report: (task) => {
        setTasks((prev) => reportTask(prev, task === null ? null : { page: pid, ...task }, pid));
      },
    };
    taskReporters.current.set(pid, reporter);
    return reporter;
  }, []);

  /**
   * 强制重挂某一层的 key 后缀。
   *
   * 保活的反面：用户**故意开始新一轮**时，必须把上一轮那份组件丢掉，
   * 否则新队列会喂给一个还停在上一轮末尾的旧组件（题号越界、结果页残留）。
   * 只改 key 就能让 React 卸载旧的、挂一个全新的，比手写重置逻辑可靠。
   */
  const [layerEpoch, setLayerEpoch] = useState<Partial<Record<PageId, number>>>({});

  /**
   * 待确认的 AI 闪卡草稿（2026-11-14）。
   *
   * 两处会往里塞：
   *  - 闪卡管理页自己的「AI 写一张」
   *  - 阅读器里划选正文 → 浮层「做成闪卡」
   *
   * 第二个必须经过这里，因为**它要跨页**：阅读器算完卡，跳去闪卡页，
   * 那一页需要知道「有草稿等着确认」。用一个 token 递增让页面能
   * 重新接收（同一段文字再点一次也要生效）。
   */
  const [pendingAiCards, setPendingAiCards] = useState<{
    cards: { front: string; back: string }[];
    source: { kind: 'point' | 'wrong' | 'text'; sourceId2?: string | null; sourceId?: string | null };
    error?: string;
    token: number;
  } | null>(null);

  const bumpLayer = useCallback((id: PageId) => {
    setLayerEpoch((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
  }, []);


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
   * 「针对错误讲一遍」的本地缓存（2026-11-19）。
   *
   * ## 为什么要一份本地缓存，而不是每次去库里查
   *
   * 做题页每渲染一次就要 `explainNotesOf(card.id)`；直接查库是异步的，
   * 拿不到「这一帧就有」的值。讲解的真相在 `questions.explainNotes`，
   * 这里是它的内存镜像：
   *  - 进入做题时不必预读（大多数题没有讲解）
   *  - 生成成功后立刻放进来，界面当帧就能显示
   *  - 换卡片时按 id 取，互不干扰
   */
  const [explainNotes, setExplainNotes] = useState<Map<string, ExplainNote[]>>(new Map());

  /**
   * 「答疑记录」的统一视图（2026-11-19）。
   *
   * 把「提问式复习」与「答错补充讲解」合成一处：
   * 对用户来说是同一件事 —— 我不懂 → 问 → 得到解释。
   *
   * 只在展示层合并，两份数据保持原样（见 `answer-record.ts` 头注释）。
   */
  const [answerRows, setAnswerRows] = useState<AnswerRecordRow[]>([]);
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
   * 「文档解析」页要选中哪一份资料（2026-11-17）。
   *
   * 与 organizeSourceId 同样单独存：从任务页点「去重新解析 / 看进度」时
   * 要带上 sourceId，而「显示哪一页」和「解析哪一份」是两件事。
   */
  const [parseSourceId, setParseSourceId] = useState<string | null>(null);

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
  /**
   * 从错题页跳来时要预选的变式目标（2026-11-12）。
   *
   * 用户点了某道错题底部的「出变式题」，应当**直接进入变式模式并勾上那一题**，
   * 而不是把他丢到出题页让他自己再找一遍 —— 那正是「做了功能没有入口」的翻版。
   *
   * null 表示没有预选（走批量入口时就是这样）。
   */
  const [variantPreselect, setVariantPreselect] = useState<{
    questionIds: string[];
  } | null>(null);
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
    flashcards: flashcardsService,
    oralReviews: oralReviewService,
    taskRuns,
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
   * 云端 OCR 的 runner 构造器（2026-11-16 抽出来做**稳定引用**）。
   *
   * ## 为什么必须抽出来
   *
   * 原来它是直接写在 JSX 里的 `cloudOcr={{ ..., makeRunner: async () => {...} }}`。
   * 那是个**内联对象字面量**：每次渲染都产生新的 `cloudOcr` 对象、
   * 新的 `makeRunner` 函数。
   *
   * `ParsePage` 里建云 runner 的 effect 依赖 `cloudOcr`（后来改成依赖
   * `makeRunner`），于是**每次渲染都重跑**：先把 `cloudRunner` 置 null，
   * 再异步重建。重建期间界面回落到「本机 MinerU」——
   *
   * 实测现象（这就是用户报的那个 413 之前的真问题）：
   *   radio 明明切到了「DeepSeek 云 OCR」，`.engine-opt--on` 也在云那条上，
   *   但按钮始终写「用本机 MinerU 转成正文」，点下去走的是本地那条路。
   *   也就是说**云 OCR 在界面上从没真正接通过**。
   *
   * 这与 `docs/交接文档-2026-11-13-傍晚.md` 记的「对象字面量进依赖数组」
   * 是同一个坑（`usePageTask` 那次）。修法一样：只依赖原始值/稳定函数。
   *
   * 依赖数组只放 `backends` 与 `sourceService` —— 两个都是长生命周期的
   * service 实例，不会每次渲染变。
   */
  const makeCloudOcrRunner = useCallback(
    async (sourceId: string) => {
      const list = await backends.list();
      const ready = list.filter((b) => b.status === 'ready');
      if (ready.length === 0) {
        return { error: '还没有可用的模型后端。到「设置 → 模型与出题」添加一个。' };
      }
      const b = ready[0]!;
      const apiKey = await backends.readCredential(b.id);
      if (!apiKey) {
        return { error: '读不到这个后端的 API Key，请到设置页重新填一次。' };
      }

      /*
       * 官方 OCR 端点只在 api.deepseek.com 上。
       * 如果用户当前后端是别家（智谱/通义等），如实说明 ——
       * 不要拿别人的地址去调 DeepSeek 的路径（那会 404，
       * 而用户会以为是功能坏了）。
       */
      const base = (b.baseUrl ?? '').trim() || 'https://api.deepseek.com';
      if (base.indexOf('api.deepseek.com') === -1) {
        return {
          error: `云端 OCR 目前只支持 DeepSeek 官方地址（api.deepseek.com）。当前后端是「${b.label}」（${base}），换一个 DeepSeek 后端再试。`,
        };
      }

      const { createDeepSeekOcrRunner } = await import('@/core/ocr/ocr-runner.ts');
      const runner = createDeepSeekOcrRunner({
        apiKey,
        baseUrl: base,
        readFile: async () => {
          const bytes = await sourceService.getOriginalFile(sourceId);
          if (!bytes) throw new Error('这份资料的原始文件没存下来（导入时可能因为太大跳过了保存）');
          return bytes;
        },
      });
      return { runner };
    },
    [backends, sourceService],
  );

  /**
   * 传给 ParsePage 的 cloudOcr（2026-11-16）。
   *
   * 用 `useMemo` 锁住对象引用：`makeRunner` 已经是稳定的（上面 useCallback），
   * 所以这里只在「后端连通状态变了」时才换新对象。
   *
   * 为什么非要做这一步：ParsePage 里建云 runner 的 effect 依赖
   * 这个对象的成员。对象每次渲染都换新，effect 就会每次重跑、
   * 把已建好的 runner 置 null —— 表现是「选了云 OCR 但按钮还是本地那条」。
   * 详见 `makeCloudOcrRunner` 上的注释。
   */
  const cloudOcrProp = useMemo(
    () => ({
      available: conn.connected,
      ...(conn.connected
        ? {}
        : { reason: '还没接入模型。到「设置 → 模型与出题」加一个后端（要有 API Key）' }),
      makeRunner: makeCloudOcrRunner,
    }),
    [conn.connected, makeCloudOcrRunner],
  );

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
    /*
     * 进「答疑记录」页时读一次（2026-11-19）。
     *
     * 不读的话这一页永远是空的 —— 数据在库里，但没人去取。
     * 这类「服务层有方法、界面没调用」是这个项目的老毛病。
     */
    if (page === 'oral') void loadAnswerRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  /**
   * 切回首页时重读待办与小组件配置（2026-11-11 晚修）。
   *
   * ## 用户报的现象
   *
   * 「桌面的待办组件未能显示待办栏里的待办」
   *
   * ## 真因
   *
   * `refreshHomeWidgets()` 只在启动时跑一次。
   * 用户在「待办」页新增 / 勾选 / 删除之后，`homeTodos` 仍是启动那一刻的
   * 快照 —— 切回首页看到的永远是旧数据。
   *
   * 实测确认：库里确实有 1 条未完成待办，而首页组件显示「现在没有未完成的待办」。
   *
   * ## 为什么单独一个 effect
   *
   * 上面那个 effect 为性能只调 refreshData（它要重算卡片池，较重）。
   * 待办是另一个数据源，混在一起会让「只想刷待办」也触发卡片池重算。
   */
  useEffect(() => {
    if (page === 'today') void refreshHomeWidgets();
  }, [page, refreshHomeWidgets]);

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

    /*
     * 把已有的「针对错误的补充讲解」读进内存镜像（2026-11-19）。
     *
     * ## 为什么必须在这里读
     *
     * 第一版只在「生成成功」时往 `explainNotes` 里放数据 —— 于是
     * **重启/重进这道题时讲解就没了**（端到端验证抓到的：落库有、
     * 界面 count=0）。那正是这个项目反复踩的「做了没接上」。
     *
     * 讲解的真相在 `questions.explainNotes`，这里在每次刷新数据时
     * 一并读出来，做题页按 id 取即可（同步、不闪）。
     *
     * 为什么不做成「做题时按需异步查」：做题页那一帧需要值，
     * 异步查询必然先渲染空再补上，面板会闪一下。
     */
    void (async () => {
      try {
        const all = await decks.listQuestionsWithExplainNotes();
        setExplainNotes(new Map(all));
      } catch {
        /* 读不到就保持现有镜像（不清空，避免面板突然消失） */
      }
    })();

    void refreshSuggestions();
  }, [loadCards, pool, reviewService, sourceService, refreshSuggestions, decks]);


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
      /*
       * 重挂复习巩固层（2026-11-13 下午）。
       *
       * 那一页的「自动开始复习」用的是 `autostartedRef.current` 一次性守卫：
       * 组件只要还活着，这个 ref 就一直是 true，第二次「开始复习」会被它挡住，
       * 表现为「点了开始复习，界面没反应（还停在上一轮的回顾页）」。
       * 保活之后组件确实一直活着 —— 所以开始新一轮时必须换一个组件。
       */
      bumpLayer('book');
      goPage('book', true);
      return queue.total > 0;
    } catch {
      /* 算不出来也要进页面 —— 那里会显示「今天没有到期的卡」并给下一步 */
      setReviewQueue({ due: [], fresh: [], total: 0, availableBeforeLimit: 0 });
      setAutoReview(true);
      bumpLayer('book');
      goPage('book', true);
      return false;
    }
  }, [loadCards, reviewService, goPage, bumpLayer]);

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

  // ---------------------------------------------------------------------------
  // 记忆闪卡（2026-11-10）
  // ---------------------------------------------------------------------------

  /** 全部闪卡（带知识点与过期标记） */
  const [flashcards, setFlashcards] = useState<FlashcardView[]>([]);
  /** 可挑选的知识点（闪卡候选） */
  const [flashcardPoints, setFlashcardPoints] = useState<KnowledgePoint[]>([]);

  // ---------------------------------------------------------------------------
  // 从闪卡跳知识库挑知识点（2026-11-10）
  // ---------------------------------------------------------------------------

  /**
   * 是否正从别处来知识库挑知识点，以及挑来干什么。
   *
   * 用户原话：「记忆闪卡制作闪卡直接让用户跳转到知识库选择好一点，
   * 按知识骨架那四个类型分类后用户也好选择需要加入闪卡的知识点」。
   * 后来（2026-11-19 晚）「提问式复习」也要能挑知识点提问，
   * 于是从布尔改成枚举：
   *
   * ## 为什么不用两个布尔
   *
   * `pickingForFlashcards` + `pickingForOral` 两个布尔会出现
   * 「两个都为真」的非法状态，而这时的行为取决于判断顺序 ——
   * 改一行代码就可能从「加进闪卡」变成「去提问」。
   * 枚举只有一个值，非法状态根本表达不出来。
   *
   * `null` = 不在挑选模式（从侧栏进知识库看到的是纯浏览页）。
   */
  const [pickingFor, setPickingFor] = useState<'flashcards' | 'oral' | null>(null);
  /**
   * 挑完回闪卡时自动展开闪卡视图。
   *
   * 与 autoOral 同一套「进来就到位」的模式：用户点的是「加进闪卡」，
   * 加完就该看到那些卡，而不是停在复习巩固的列表页再点一次。
   */
  const [showFlashcardsFromKnowledge, setShowFlashcardsFromKnowledge] = useState(false);

  /**
   * 从闪卡面板点「去知识库挑」。
   *
   * 先读出知识点（知识库要候选列表），再进挑选模式。
   * 不用 effect 自动读：这条路径是显式点击，读一次即可。
   */
  const handleGoPickKnowledge = useCallback(async () => {
    try {
      const points = await knowledgeService.listAll();
      setFlashcardPoints(points);
    } catch {
      /* 读不到也照样进页面：知识库自己还会读一次并显示错误 */
    }
    setPickingFor('flashcards');
    setPage('knowledge');
  }, [knowledgeService]);

  /**
   * 从「提问式复习」两级入口走「挑知识点提问」（2026-11-19 晚）。
   *
   * 与 handleGoPickKnowledge 同一套（进知识库的挑选模式），
   * 区别只在挑完之后干什么：那边是加闪卡，这边是拿这几条去出题。
   */
  const handleGoPickPointsForOral = useCallback(async () => {
    try {
      const points = await knowledgeService.listAll();
      setFlashcardPoints(points);
    } catch {
      /* 读不到也照样进页面：知识库自己还会读一次并显示错误 */
    }
    setPickingFor('oral');
    setPage('knowledge');
  }, [knowledgeService]);

  /** 读闪卡与候选知识点。建卡/删卡后都要重读 */
  const reloadFlashcards = useCallback(async () => {
    const [views, points] = await Promise.all([
      flashcardsService.listWithPoints(),
      knowledgeService.listAll(),
    ]);
    setFlashcards(views);
    setFlashcardPoints(points);
  }, []);

  /**
   * 从阅读器「用这段提问」进来时，直接开始提问（2026-11-10）。
   *
   * 与 autoReview 同一套做法：标记用完即清。
   * 不清的话，下次从侧栏正常进这一页也会被直接拽进提问面板。
   *
   * 声明位置在「进复习巩固页时备素材」那个 effect **之前** ——
   * 那个 effect 要读它来决定「不要覆盖划选素材」。
   */
  const [autoOral, setAutoOral] = useState(false);
  /**
   * 「这一轮素材由划选指定」的守卫（ref，不是 state）。
   *
   * 用 ref 的理由见下面「进复习巩固页备素材」那个 effect 里的长注释 ——
   * 简言之：state 版会被 setAutoOral(false) 连带复位，守卫失效。
   */
  const selectionOralRef = useRef(false);

  /**
   * `selectionOralRef` 的**渲染用镜像**（2026-11-19 晚）。
   *
   * ## 为什么不能直接用 ref
   *
   * 界面要根据「素材是不是显式选定的」决定显不显示范围下拉。
   * ref 变了**不会触发重渲染** —— 只读 ref 的话，下拉会停在旧状态
   * （表现为「点了挑知识点，进去还看到知识点随机的下拉」）。
   *
   * ## 为什么两份都留
   *
   * ref 承担的是「effect 里的守卫」（不能被 setState 的异步时序影响，
   * 见那个长注释）。state 只负责渲染。两者在**同一处**一起设置，
   * 不存在只改一个的情况 —— 下面三处赋值点都成对写。
   */
  const [oralScopeLocked, setOralScopeLocked] = useState(false);

  /* 进复习巩固页时读一次；换页不必重读（闪卡不常变） */
  useEffect(() => {
    if (page !== 'book') return;
    void (async () => {
      await reloadFlashcards();
      /*
       * 同时备好「提问式复习」的素材池（2026-11-10）。
       *
       * 用知识点而不是段落：知识点的 quotes 已经是逐字原文、
       * 而且自带出处（资料 + 页码），跳回原文最准。
       * 段落池留给「用户在原文里划选一段」那条路 —— 那是显式选择，
       * 不该混进随机池里（否则随机可能抽到一整页无关内容）。
       */
      const points = await knowledgeService.listAll();
      const pool = pointsToMaterials(points);

      /*
       * ⚠️ 这一轮是「划选提问」进来的，就**不要**覆盖素材（2026-11-10）。
       *
       * 不加这个判断是个真 bug：handleAskAboutSelection 先设好
       * 「就这段提问」的素材，随后 goPage('book') 触发本 effect，
       * 异步读完知识点后把 oralPool / oralMaterial 全部改回随机知识点 ——
       * 用户点了「用这段提问」，进到面板却看到一条毫不相干的知识点。
       *
       * 因为本 effect 是异步的（要读库），它一定在划选设置之后跑完，
       * 所以这个覆盖是稳定发生的，不是偶发竞态。
       *
       * ## 为什么用 ref 而不是 autoOral 这个 state（第一版错了）
       *
       * 第一版这里写 `if (autoOral) return;` 并把 autoOral 放进依赖。
       * 实测截图抓到的结果：面板顶部写着「知识点随机提问」而不是
       * 「划选片段提问」—— 划选素材还是被覆盖了。
       *
       * 原因是这个守卫**会把自己消耗掉**：
       *   autoOral=true → 本 effect 跑，return（正确）
       *   → BookPage 的 effect 消费标记，调 setAutoOral(false)
       *   → 依赖变化，本 effect **再跑一遍**，这次 autoOral=false
       *   → 覆盖发生。
       *
       * ref 不受依赖数组管辖，setAutoOral(false) 不会让它复位；
       * 它又只在真正离开复习巩固页时才清（见下面那个 effect）。
       */
      if (selectionOralRef.current) return;

      setOralPool(pool);
      /* 默认素材：从池子里抽一条；池子空则为 null（界面会说明原因） */
      setOralMaterial(pickMaterial(pool));
      setOralScopeLabel('知识点随机提问');
    })();
  }, [page, reloadFlashcards]);

  /*
   * 离开复习巩固页时清掉「划选素材」标记。
   *
   * 必须清：用户下次从侧栏正常进这一页时，应该回到知识点随机，
   * 而不是还停在十分钟前划的那一段上。这与 autoOral 那套
   * 「用完即清」的意图相同，只是清得晚一点（等页面真的离开）。
   */
  useEffect(() => {
    if (page === 'book') return;
    selectionOralRef.current = false;
    setOralScopeLocked(false);
  }, [page]);

  /*
   * 进复习巩固页时读一次「可选的提问范围」（2026-11-10）。
   *
   * 只在这一页读：`listOralScopes` 要把每份资料的段落表过一遍，
   * 首页/错题页不该付这个成本。
   *
   * 读失败不弹错：范围选择器是增强功能，
   * 读不到就保持空列表（选择器自己显示「还没有能提问的正文」），
   * 不该因此让整个复习巩固页不可用。
   */
  useEffect(() => {
    if (page !== 'book') return;
    void (async () => {
      try {
        const sources = await sourceService.list();
        const docScopes = await listOralScopes(sourceService, sources);

        /*
         * 知识点范围也列进来（2026-11-10）。
         *
         * 三期只有这一条路。加了资料范围后必须把它也摆进同一个下拉，
         * 否则「下拉写整库、实际还是知识点」会分裂。
         * 放在最前面，且作为默认选中项 —— 保持三期行为不变。
         */
        const points = await knowledgeService.listAll();
        const pointMats = pointsToMaterials(points);
        const pointsOption: OralScopeOption = {
          id: 'points',
          label: '知识点随机',
          scope: { kind: 'points', pointIds: points.map((p) => p.id), title: '知识点随机' },
          count: pointMats.length,
        };

        /* 资料范围里把「整库随机」去掉：知识点已是整库粒度，重复了 */
        const rest = docScopes.filter((o) => o.id !== 'all');
        const next = [pointsOption, ...rest];
        setOralScopes(next);
        setOralScopeId((prev) => (next.some((s) => s.id === prev) ? prev : 'points'));
      } catch {
        /* 读不到就保持空列表，不阻塞页面 */
      }
    })();
  }, [page, sourceService, knowledgeService]);

  const handleAddFlashcards = useCallback(
    async (ids: string[]) => {
      /*
       * 把选中的知识点做成**独立的卡**（2026-11-14 按用户反馈重做）。
       *
       * 用户原话：「应该由用户自己选择知识点或是错题做成闪卡，
       * 而且闪卡是独立的，不会因错题或是知识点的消失而消失」。
       *
       * 所以这里必须**把正面文本抄进草稿**（`draftFromPoint` 做这件事），
       * 之后再改/删知识点，卡片内容一个字都不会变。
       *
       * 找不到的知识点直接跳过 —— 用户可能刚在另一个窗口删了它。
       */
      const drafts = ids
        .map((id) => flashcardPoints.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => draftFromPoint(p, 'user'));

      if (drafts.length === 0) return;
      await flashcardsService.addMany(drafts);
      await reloadFlashcards();
    },
    [flashcardPoints],
  );

  const handleRemoveFlashcard = useCallback(async (id: string) => {
    await flashcardsService.remove(id);
    setFlashcards((prev) => prev.filter((v) => v.card.id !== id));
  }, []);

  /**
   * 「让 AI 挑闪卡」。
   *
   * ## 为什么只返回候选、不直接建卡
   *
   * AI 的判断可能不合用户直觉。直接入库会让他面对一堆不想背的卡，
   * 还得一条条删。所以这里只给候选，界面用勾选框让用户确认。
   *
   * ## 为什么不用出题后端
   *
   * 出题后端是 `generate(points, options)` 这套形状，产出的是题目草稿。
   * 挑闪卡只要「从给定清单里选编号」，用通用的 `chatCompletion` 更直接，
   * 也不必把一个新能力塞进那个接口。
   */
  const handlePickFlashcards = useCallback(async (): Promise<FlashcardCandidate[]> => {
    const list = await backends.list();
    const ready = list.filter((b) => b.status === 'ready');
    if (ready.length === 0) {
      throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
    }
    const b = ready[0]!;
    const apiKey = await backends.readCredential(b.id);
    if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');

    /* 只挑「偏记忆」或短小的知识点 —— 全量丢过去既贵又没必要 */
    const pool = flashcardPoints.filter(
      (p) =>
        p.anchorStatus !== 'unlocated' ||
        p.cognitiveLevel === 'remember' ||
        p.statement.length <= 60,
    );
    if (pool.length === 0) throw new Error('知识库里还没有可以做成闪卡的知识点。');

    /* 最多挑 20 张：一次翻 20 张已经是不少的量 */
    const LIMIT = 20;
    const { system, user } = buildPickPrompt(pool, LIMIT);

    /* 动态引入，避免首屏加载 AI 客户端 */
    const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
    const res = await chatCompletion({
      apiKey,
      model: b.model,
      ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
      provider: b.provider,
      systemPrompt: system,
      userPrompt: user,
      temperature: 0.2,
      /* 挑卡是短回答，不需要长输出；给个上限防止它写小作文 */
      maxTokens: 2000,
    });

    return parsePicks(res.content, pool);
  }, [flashcardPoints]);

  /**
   * 学习顺序页的 AI 接线（2026-11-21）。
   *
   * ## 为什么抽成两个 useCallback 而不是让页面自己调
   *
   * 读后端凭据、选后端、发请求都在这里 —— 与上面 `handlePickFlashcards`、
   * 下面的 AI 组卷、`handleShortGrade` 同一套分工。路线 UI 只管
   * 「点了、拿到结果、显示」。这样页面本身不需要知道 backends 存在。
   *
   * ## 为什么错误要原样抛上去
   *
   * 「没有可用模型 / 读不到 Key / 网络失败 / 模型返回的 JSON 残缺」
   * 是四种完全不同的原因，界面该给的提示完全不同。
   * 全吞成一句「AI 没给出结果」会让人没法判断
   * （交接文档记过：AI 组卷原来就这么吞，五种原因变成一个，
   *  只能另写诊断脚本来查真因）。
   */
  const studyPlanOrder = useCallback(
    async (points: readonly PlanPointInput[]): Promise<PlanOrder> => {
      if (points.length === 0) throw new Error('知识库里还没有可排序的知识点。');

      const list = await backends.list();
      const ready = list.filter((b) => b.status === 'ready');
      if (ready.length === 0) {
        throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
      }
      const b = ready[0]!;
      const apiKey = await backends.readCredential(b.id);
      if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');

      const { buildPlanPrompt, parsePlanOrder } = await import('@/core/ai/plan-order.ts');
      const { system, user } = buildPlanPrompt(points);

      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const res = await chatCompletion({
        apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: system,
        userPrompt: user,
        /*
         * 温度调低：排序要稳定、可复现，不要每次排得不一样。
         * 与挑闪卡同一个考量（那里也是 0.2）。
         */
        temperature: 0.2,
        /*
         * 输出上限给够：105 条 × 每条 reason+basis 约 60 字 ≈ 6000+ token，
         * 加上块标题。给小了会**被截断**，而截断的 JSON 按设计整轮拒绝 ——
         * 用户看到的就是「AI 排失败了」，其实只是预算不够。
         */
        maxTokens: 12000,
      });

      /*
       * finishReason === 'length' 时 content 可能看起来是完整 JSON
       * （刚好在括号后截断）也可能不是。前者会被正常解析但少了后半段，
       * 那种「少了一半但看起来成功」最难发现 —— 所以显式查一遍。
       */
      if (res.finishReason === 'length') {
        throw new Error(
          '这次调用的输出被长度上限截断了（知识点有点多）。请重试，或先在知识库删掉一些不需要的知识点。',
        );
      }

      const parsed = parsePlanOrder(res.content, points);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.plan;
    },
    [backends],
  );

  const studyPlanChapters = useCallback(
    async (all: readonly KnowledgePoint[]): Promise<ChapterPreview> => {
      const { collectKnownChapters, toChapterCandidates, buildChapterPrompt, parseChapterSuggestions, buildChapterPreview } =
        await import('@/core/ai/chapter-backfill.ts');

      const candidates = toChapterCandidates(all);
      if (candidates.length === 0) throw new Error('所有知识点都已经有章节了，不需要补。');

      const known = collectKnownChapters(all);

      const list = await backends.list();
      const ready = list.filter((x) => x.status === 'ready');
      if (ready.length === 0) {
        throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
      }
      const b = ready[0]!;
      const apiKey = await backends.readCredential(b.id);
      if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');

      const { system, user } = buildChapterPrompt(candidates, known);

      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const res = await chatCompletion({
        apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: system,
        userPrompt: user,
        temperature: 0.1,
        maxTokens: 8000,
      });

      if (res.finishReason === 'length') {
        throw new Error('这次调用的输出被长度上限截断了。请重试，或分批补章节。');
      }

      const parsed = parseChapterSuggestions(res.content, candidates, known);
      if (!parsed.ok) throw new Error(parsed.reason);

      /*
       * ⚠️ 这一步**不写库**。返回的是预览，
       * 用户在页面上逐条勾选并点「写入」之后才会真正改知识点。
       */
      return buildChapterPreview(candidates, parsed.suggestions, parsed.dropped);
    },
    [backends],
  );

/**
 * AI 排出来、等用户确认的路线草稿（2026-11-21）。
 *
 * 用户确认过的第③点：「AI 给、我勾，勾完才存」。
 * 所以 AI 的结果先放这里，由 `RoutePreviewDialog` 逐条勾选后才落库。
 *
 * 为什么存 `blocks` 而不是拍平成 steps：
 * 预览要**按块显示**（用户确认的第①点是「先归成 5–8 块」），
 * 拍平就丢掉了块归属。落库时才由 `planToSteps` 摊平。
 */
interface PlanDraft {
  blocks: PlanOrder['blocks'];
  unplaced: number[];
  dropped: number;
}


  /**
   * 学习顺序路线的读写。
   *
   * 挂在 `settings.studyPlan`（可选字段，零迁移）——
   * 为什么不是新分区、也不是给 KnowledgePoint 加字段，
   * 见 `v2/core/study-plan-store.ts` 的文件头。
   *
   * ⚠️ 依赖 2026-11-21 修的那处 `importBackup` 白名单 bug，
   * 否则用户换机器恢复备份后路线会静默消失（已补 4 条回归测试）。
   */
  const studyPlanStore = useMemo(
    () => ({
      read: async () => {
        const s = await library.getSettings();
        return normalizeStudyPlan(s.studyPlan);
      },
      write: async (plan: StudyPlan | null) => {
        await library.saveSettings({ studyPlan: plan });
      },
    }),
    [library],
  );

  /**
   * 让 AI 帮忙**写**闪卡（2026-11-14，用户要求）。
   *
   * 与上面 handlePickFlashcards 的区别：
   *  - pickFlashcards：从知识点里**挑**适合做卡的（返回知识点 id）
   *  - makeFlashcards：给出素材，让模型**写**出正反面文本
   *
   * 用户原话：「闪卡的制作可以用到后端 ai 协助制作」。
   */
  const handleMakeFlashcards = useCallback(
    async (material: CardMaterial, count = 1): Promise<{ front: string; back: string }[]> => {
      const list = await backends.list();
      const ready = list.filter((b) => b.status === 'ready');
      if (ready.length === 0) {
        throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
      }
      const b = ready[0]!;
      const apiKey = await backends.readCredential(b.id);
      if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');

      const { system, user } = buildCardPrompt(material, count);

      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const res = await chatCompletion({
        apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: system,
        userPrompt: user,
        temperature: 0.2,
        /* 几张卡而已；给上限防止它写小作文 */
        maxTokens: 1500,
      });

      const parsed = parseCards(res.content);
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.cards;
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // 提问式复习（2026-11-10）
  // ---------------------------------------------------------------------------

  /** 这一轮从哪来（显示用） */
  const [oralScopeLabel, setOralScopeLabel] = useState('随机提问');
  /** 当前素材 */
  const [oralMaterial, setOralMaterial] = useState<OralMaterial | null>(null);
  /**
   * 可提问的素材池（用于「换一题」）。
   *
   * 与 oralMaterial 分开：material 是「当前这一条」，池子是「还能抽哪些」。
   * 换题时从池子里再抽一条，而不是重新查库 —— 池子不变，不必重读。
   */
  const [oralPool, setOralPool] = useState<OralMaterial[]>([]);

  /**
   * 统一的「拿到一个可用后端」。
   *
   * 抽出来是因为三期要调三次模型（出题 / 判定），加上二期的挑卡 ——
   * 每处都写一遍「取列表、筛 ready、读凭据」既啰嗦又容易漏掉某一步。
   */
  const resolveBackend = useCallback(async () => {
    const list = await backends.list();
    const ready = list.filter((b) => b.status === 'ready');
    if (ready.length === 0) {
      throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
    }
    const b = ready[0]!;
    const apiKey = await backends.readCredential(b.id);
    if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');
    return { ...b, apiKey };
  }, []);

  /** 让 AI 就一条材料提问 */
  const handleOralAsk = useCallback(
    async (m: OralMaterial): Promise<string> => {
      const b = await resolveBackend();
      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const res = await chatCompletion({
        apiKey: b.apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: buildOralSystemPrompt(),
        userPrompt: buildAskPrompt(m),
        /* 出题要稳定，不要发散 */
        temperature: 0.3,
        maxTokens: 400,
      });
      const q = res.content.trim();
      if (!q) throw new Error('模型没有给出问题，换一条材料再试。');
      /* 模型有时会加「问题：」前缀，去掉 */
      return q.replace(/^\s*(问题|问答|题目)[：:]\s*/, '');
    },
    [resolveBackend],
  );

  /**
   * 让 AI 判定用户的回答（2026-11-19 换成三层证据锚点）。
   *
   * ## 为什么换
   *
   * 旧做法让模型直接给 `correct / memory / understanding`。
   * `oral-review.ts` 的头注释自己就承认：「同一段错误回答，模型可能这次判记错、
   * 下次判理解偏。这是模型能力的边界，靠 prompt 调不到 100%。」
   *
   * 新做法：模型只填 **13 项布尔/计数证据**（「有没有举反例」「有没有识别隐含假设」），
   * 分数与标签由程序算（`mastery-evidence.ts`）。同一段回答两次跑，
   * 布尔证据比三分类标签稳定得多；就算漂，漂的是一两个布尔，
   * 不会把「理解偏差」翻成「记忆错误」。
   *
   * ## 为什么仍然产出 verdict
   *
   * 已有的 `oralReviews` 记录、答疑记录页、统计都按三分类走。
   * 换代不能把那些弄坏，所以证据分数会映射回旧的标签
   * （映射规则写在 `mastery-evidence.ts` 的 toVerdict）。
   *
   * ## 失败时退回旧路径
   *
   * 证据判定要模型输出一个更大更严格的 JSON，比旧格式更容易被截断。
   * 解析失败时**不报错、不退化成空结果**，而是再走一次旧的判定 ——
   * 用户不该因为「我们换了实现」而拿不到判定。
   */
  const handleOralJudge = useCallback(
    async (m: OralMaterial, q: string, a: string): Promise<OralJudgement> => {
      const b = await resolveBackend();
      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');

      const legacy = async (): Promise<OralJudgement> => {
        const res = await chatCompletion({
          apiKey: b.apiKey,
          model: b.model,
          ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
          provider: b.provider,
          systemPrompt: buildOralSystemPrompt(),
          userPrompt: buildJudgePrompt(m, q, a),
          temperature: 0.1,
          maxTokens: 1200,
        });
        return parseJudgement(res.content, m);
      };

      try {
        const {
          buildCorrection,
          buildEvidenceSystemPrompt,
          buildEvidenceUserPrompt,
          parseEvidence,
          scoreEvidence,
        } = await import('@/core/ai/mastery-evidence.ts');

        const res = await chatCompletion({
          apiKey: b.apiKey,
          model: b.model,
          ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
          provider: b.provider,
          systemPrompt: buildEvidenceSystemPrompt(),
          userPrompt: buildEvidenceUserPrompt({
            /*
             * ⚠️ 这里原来传的是 `m.label`（2026-11-19 晚修）。
             *
             * `label` 是**位置说明**：知识点素材的 label 是章节名
             * （「第一章 线性表」），段落素材的 label 是「资料 · 章节 · 第 N 页」。
             * 拿它当「## 知识点」传给模型，模型不知道要判的概念是什么。
             *
             * 实测抓到的请求体：
             *   ## 知识点
             *   第一章 线性表          ← 应该是一句知识点原话
             *
             * 段落 / 划选素材没有提炼句，退回 label 至少给出处，不编造。
             */
            statement: (m.statement ?? '').trim() || m.label,
            question: q,
            answer: a,
            material: m.text,
          }),
          /* 证据判定要稳：温度压到 0.1，与旧判定一致 */
          temperature: 0.1,
          /* 要填三层十几个字段，比旧格式长 */
          maxTokens: 1600,
        });

        const ev = parseEvidence(res.content);
        const score = scoreEvidence(ev);

        /*
         * 把证据折回旧的 OralJudgement 形状（界面与存储都不用改）。
         *
         * - verdict：由证据算出的标签
         * - quotedFromSource：证据判定不再要求逐字引文，这里留空 ——
         *   界面会显示「它没给出原文依据」，这是**如实**的：
         *   新链路确实没有引文。硬编一段反而会造假。
         * - explanation：用 score.summary + 三层分数，让用户看到凭什么这么判
         */
        return {
          verdict: score.verdict,
          quotedFromSource: '',
          /*
           * 如实标 false：新链路确实没有逐字引文。
           *
           * 界面会在「没给出原文依据」时提示用户 —— 那是**正确**的显示，
           * 因为证据判定确实不引用原文。硬编一段引文来让这个字段变 true
           * 才是造假（那会让用户以为模型核对过原话）。
           */
          quoteVerified: false,
          explanation:
            `${score.summary}（概念 ${Math.round(score.concept * 100)}` +
            ` · 判断 ${Math.round(score.judgment * 100)}` +
            ` · 推理 ${Math.round(score.reasoning * 100)}）`,
          correction: buildCorrection(ev),
        };
      } catch {
        /* 证据链路失败：退回旧判定，别让用户拿不到结果 */
        return legacy();
      }
    },
    [resolveBackend],
  );

  /**
   * 让 AI 逐要点比对一道问答 / 计算题（2026-11-12）。
   *
   * 这**不是**判分入口。用户明确要求「主要判分还是用户自评」，
   * 做题页那边点「我答对了 / 我答错了」才是唯一的判分动作；
   * 这里返回的只是一份要点覆盖参考，用来帮用户判断自己漏了什么。
   *
   * 所以：
   *  - 解析失败不静默返回空结果（那会显示成「一条要点都没答到」，误导），
   *    而是抛一句人话，让界面在按钮下面显示成「比对没成功」；
   *  - 不写任何复习记录，也不影响间隔。
   */
  const handleShortGrade = useCallback(
    async (input: ShortGradeInput): Promise<ShortGradeResult> => {
      const b = await resolveBackend();
      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const prompt = buildShortGradePrompt(input);
      const res = await chatCompletion({
        apiKey: b.apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        /* 比对要稳，不要发挥 */
        temperature: 0.1,
        maxTokens: 900,
      });
      const parsed = parseShortGrade(res.content);
      if (!parsed) throw new Error('模型这次没有给出可读的比对结果，再试一次。');
      return parsed;
    },
    [resolveBackend],
  );

  /**
   * 针对这次答错，让 AI 专门讲一遍（2026-11-19）。
   *
   * ## 为什么生成完就落库
   *
   * 讲解要能回看 —— 用户下次打开这道题，应该还能看到他上次没懂的那段讲解。
   * 只放在组件 state 里，离开这一页就没了。
   *
   * 落库走 `decks.addExplainNote`（追加语义，见那里的注释）。
   *
   * ## 为什么把 question 从 card id 回查
   *
   * 做题页拿到的是 `Card`（不含 `options[].why` 之外的题目字段），
   * 而提示词需要 `question.knowledgePointId` 之类的原始形状。
   * 按 id 回查一次比把整张题塞进卡片更干净。
   */
  const handleExplainWrong = useCallback(
    async (
      card: Card,
      given: string,
      styleId: string,
      customStyle: string,
    ): Promise<ExplainResult> => {
      const question = await decks.getQuestion(card.id);
      if (!question) throw new Error('这道题已经不在了（可能被删了），刷新一下再试。');

      const b = await resolveBackend();
      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const { buildExplainPrompt, parseExplain } = await import('@/core/ai/explain-wrong.ts');

      const prompt = buildExplainPrompt({
        prompt: question.prompt,
        kind: question.kind,
        options: question.options,
        answer: question.answer,
        explanation: question.explanation,
        given,
        styleId,
        customStyle,
      });

      const res = await chatCompletion({
        apiKey: b.apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        /*
         * 讲解要准，不要发挥 —— 与逐要点比对同一档温度。
         * 讲错了比不讲更糟：用户会把错误的解释当成正确答案记下来。
         */
        temperature: 0.3,
        /* 讲解比比对长，留够输出空间（推理模型还要吃掉一部分） */
        maxTokens: 2000,
      });

      const parsed = parseExplain(res.content);

      /* 落库：追加一条，不覆盖之前的 */
      await decks.addExplainNote(question.id, {
        given,
        styleId,
        crux: parsed.crux,
        body: parsed.body,
        nextStep: parsed.nextStep,
      });

      /*
       * 用库里**真实的这条**刷新缓存（2026-11-19 第二轮改）。
       *
       * 原来这里是自己拼一条 `id: local-...` 塞进缓存 —— 那会造出
       * 两个不同 id 指向同一段内容：本地这条、库里那条。
       * 于是面板上同一条讲解显示两遍（用户截图报的正是这个）。
       *
       * 现在 addExplainNote 已经把内容写进库并返回更新后的题目，
       * 直接用它的 explainNotes 覆盖缓存即可 —— 只有一份真相。
       */
      const saved = await decks.getQuestion(question.id);
      if (saved?.explainNotes) {
        setExplainNotes((prev) => {
          const next = new Map(prev);
          next.set(card.id, saved.explainNotes!);
          return next;
        });
      }

      return parsed;
    },
    [decks, resolveBackend],
  );

  /**
   * 生成一级提示（2026-11-19）。
   *
   * ## 为什么在这层做
   *
   * 拼提示词需要题目原文（选项、答案、解析），而做题页拿到的是 `Card`
   * —— 它没有 `explanation`、`options[].why` 之外的完整形状。
   * 按 id 回查一次题目最干净（与「答错补充讲解」同一个做法）。
   *
   * ## 温度与长度
   *
   * 提示要准、要短。温度压到 0.2（比讲解还低）：提示里的一句错话
   * 会把学生直接带偏。maxTokens 给 900 —— 第 4 级要举例子，比其它级长。
   */
  const handleAskHint = useCallback(
    async (
      card: Card,
      given: string,
      level: Exclude<HintLevel, 0>,
      previous: readonly HintResult[],
    ): Promise<HintResult> => {
      const question = await decks.getQuestion(card.id);
      if (!question) throw new Error('这道题已经不在了（可能被删了），刷新一下再试。');

      const b = await resolveBackend();
      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const { buildHintPrompt, parseHint } = await import('@/core/ai/hint-ladder.ts');

      const prompt = buildHintPrompt({
        prompt: question.prompt,
        kind: question.kind,
        options: question.options,
        answer: question.answer,
        explanation: question.explanation,
        given,
        level,
        previousHints: previous,
      });

      const res = await chatCompletion({
        apiKey: b.apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        temperature: 0.2,
        maxTokens: 900,
      });

      return parseHint(res.content, level);
    },
    [decks, resolveBackend],
  );

  /**
   * 阅读器里划选了一段 → 拿它提问（2026-11-10）。
   *
   * ## 为什么池子里只放这一条
   *
   * 用户明确指了「就这段」。把划选素材混进知识点池会让「换一题」
   * 悄悄跳到别的知识点上 —— 那已经不是他要问的东西了。
   * 池子只装这一条，他的「换一题」就是重新就这段再出一问。
   *
   * App.tsx 里有一句旧注释正好预言了这个设计（在 oralPool 那段）：
   * 「段落池留给『用户在原文里划选一段』那条路 —— 那是显式选择，
   * 不该混进随机池里」。这里就是那条路。
   *
   * ## 为什么要清掉 readerFrom 之外的导航痕迹
   *
   * 不进 reader：用户点的是「提问」，不是「继续读」。
   * 直接走 goPage 到复习巩固页，返回栈里自然记着「从阅读器来的」。
   */
  const handleAskAboutSelection = useCallback(
    (material: OralMaterial) => {
      setOralPool([material]);
      setOralMaterial(material);
      setOralScopeLabel('划选片段提问');
      /* 守卫必须在 setAutoOral 之前挂上，且整个「留在这一页」期间都不清 */
      selectionOralRef.current = true;
      setOralScopeLocked(true);
      setAutoOral(true);
      goPage('book');
    },
    [goPage],
  );

  /**
   * 划选正文 → 让 AI 做成闪卡（2026-11-14，用户要求）。
   *
   * 用户原话：「让 ai 写闪卡这个功能可以再接入资料库，和让 ai 提问一样，
   * 用户可以划选资料内容制作闪卡」。
   *
   * ## 流程
   *
   * 划选 → 浮层「做成闪卡」→ 这里调 AI 写卡 → 跳到闪卡管理页，
   * 把写好的卡**放在待确认区**（与页面里自带的 AI 草稿是同一块 UI）。
   *
   * ## 为什么不直接入库
   *
   * 与页面内的 AI 写卡同一条原则：模型偶尔会写出偏离素材的卡，
   * 用户要先看一眼。所以只把草稿塞过去，收不收由他决定。
   */
  const handleMakeCardFromSelection = useCallback(
    async (material: OralMaterial) => {
      try {
        const cards = await handleMakeFlashcards(
          { kind: 'text', text: material.text, hint: material.label },
          1,
        );
        /*
         * 把素材来源一起带过去：这样收下时卡片能记住「我是从哪段正文来的」。
         * sourceId 用 material 的资料 id（划选一定来自某份资料）。
         */
        setPendingAiCards((prev) => ({
          cards,
          source: { kind: 'text', sourceId: material.sourceId ?? null },
          token: (prev?.token ?? 0) + 1,
        }));
        setPage('flashcards');
      } catch (e) {
        /* 失败也要让用户知道，而不是点了没反应 */
        setPendingAiCards((prev) => ({
          cards: [],
          source: { kind: 'text', sourceId: material.sourceId ?? null },
          error: e instanceof Error ? e.message : 'AI 没能写出卡',
          token: (prev?.token ?? 0) + 1,
        }));
        setPage('flashcards');
      }
    },
    [handleMakeFlashcards],
  );

  // ---------------------------------------------------------------------------
  // 从资料中提问（2026-11-10）
  // ---------------------------------------------------------------------------

  /**
   * 可选的提问范围（整库 / 整本 / 某章）。
   *
   * 进了复习巩固页才读 —— 读它要把每份资料的段落表都过一遍，
   * 首页、错题页都不需要这份数据，不该在那里付这个成本。
   */
  const [oralScopes, setOralScopes] = useState<OralScopeOption[]>([]);
  /** 当前选中的范围 id */
  const [oralScopeId, setOralScopeId] = useState('all');
  /** 正在按新范围取素材 */
  const [oralScopeLoading, setOralScopeLoading] = useState(false);
  /** 取范围或素材失败的原因 */
  const [oralScopeError, setOralScopeError] = useState<string | null>(null);

  /**
   * 换一个提问范围（2026-11-10）。
   *
   * ## 为什么知识点也要走这个下拉
   *
   * 三期只有「知识点随机」这一条路。加了资料范围后，如果下拉里只列资料，
   * 就会出现「下拉写着整库随机、但实际素材还是知识点」的分裂。
   * 所以把知识点也做成选项之一 —— 一个下拉、一个真相来源。
   * 默认仍选「知识点随机」，保持三期已有的行为不变。
   *
   * ## 为什么要清掉 selectionOralRef
   *
   * 用户从划选进来后又主动改范围，说明他不要「就那一段」了。
   * 不清的话，那个守卫会一直挡着，让范围切换不生效 ——
   * 表现为「下拉选了没反应」。
   */
  const handleOralScopeChange = useCallback(
    async (id: string) => {
      setOralScopeId(id);
      setOralScopeLoading(true);
      setOralScopeError(null);
      try {
        const opt = oralScopes.find((o) => o.id === id);
        if (!opt) throw new Error('这个范围已经不在了，换一个试试。');

        /*
         * 知识点范围不走 materialsForScope（那是资料段落专用）。
         * 直接复用三期的 pointsToMaterials，口径完全一致。
         */
        let pool: OralMaterial[];
        if (opt.scope.kind === 'points') {
          const points = await knowledgeService.listAll();
          const wanted = new Set(opt.scope.pointIds);
          pool = pointsToMaterials(points.filter((p) => wanted.has(p.id)));
        } else {
          pool = await materialsForScope(sourceService, opt.scope);
        }

        if (pool.length === 0) {
          setOralPool([]);
          setOralMaterial(null);
          setOralScopeLabel('这个范围没有可提问的内容');
          return;
        }
        /* 用户主动换范围 → 划选那条路的守卫不再适用 */
        selectionOralRef.current = false;
        setOralScopeLocked(false);
        setOralPool(pool);
        setOralMaterial(pickMaterial(pool));
        setOralScopeLabel(opt.label);
      } catch (e) {
        setOralScopeError(e instanceof Error ? e.message : '取这段内容失败');
      } finally {
        setOralScopeLoading(false);
      }
    },
    [oralScopes, sourceService, knowledgeService],
  );

  const handleOralSave = useCallback(    async (input: {
      material: OralMaterial;
      question: string;
      answer: string;
      judgement: OralJudgement;
      savedAs: 'full' | 'brief';
    }) => {
      await oralReviewService.save(input);
    },
    [],
  );

  /** 换一题：从池子里再抽一条 */
  const handleOralNext = useCallback(() => {
    const next = pickMaterial(oralPool);
    if (next) {
      setOralMaterial(next);
    } else {
      setOralMaterial(null);
    }
  }, [oralPool]);

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
      /*
       * 强制重挂做题层（2026-11-13 下午）。
       *
       * 保活的反面：这一轮是**新的一轮**，上一轮那份组件必须换掉。
       * 不换的话新队列会喂给一个还停在上一轮末尾的旧组件 ——
       * 它的 index 停在上一轮的第 N 题，新队列只有 M 题时表现为
       * 「一进来就是空白 / 上一轮的结果页」。只改 key 最省事也最可靠。
       */
      bumpLayer('practice');
      setPage('practice');
    },
    [bumpLayer],
  );

  /**
   * 打开**指定的一道题**来做（2026-11-19）。
   *
   * ## 为什么需要
   *
   * 用户报：做题时写的笔记，到学习笔记页看时只显示资料名，
   * 点进去跳的是**原文**而不是那道题。他真正想回看的是题目本身
   * （「我当时为什么写这句」）。
   *
   * 展示侧已经把归属说清了（见 NotesPage 的 ownerLabel），
   * 点击也应该落到那道题上 —— 否则等于还是只能去原文。
   *
   * ## 复用 startPractice 而不是另写一套
   *
   * 做题页的队列、计时、上报都挂在 startPractice 上。
   * 这里只把「一张卡」包成队列，其余一律走原路 ——
   * 另写一套必然漏掉「强制重挂做题层」那类保活细节。
   */
  const openSingleQuestion = useCallback(
    async (cardId: string) => {
      /*
       * 按 id 从题目表取，而不是从内存池里翻。
       *
       * 为什么：笔记可能是很久以前写的，那道题所在的题组可能已
       * 重新发布/调整过，内存池里不一定有它。按 id 取最准。
       */
      const q = await decks.getQuestion(cardId);
      if (!q) {
        setQueueError('这道题已经不在了（可能被删掉或进了回收站）。');
        return;
      }
      /*
       * 未发布的草稿题不进做题队列 —— 与 cards-loader 的口径一致
       * （那里只取已发布题组的题）。如实告诉用户原因，不假装打开。
       */
      const deckList = await decks.list();
      const deck = deckList.find((d) => d.id === q.deckId);
      if (!deck || deck.status !== 'published') {
        setQueueError('这道题所在的题组还没发布，所以在做题页打不开。可以到「我的题组」里发布它。');
        return;
      }
      const { questionToCard } = await import('./cards-loader.ts');
      const card = questionToCard(q, deck.sourceId ?? null);
      startPractice({
        cards: [card],
        mode: 'free',
        label: '从笔记回看',
        dueTotal: 1,
      });
    },
    [decks, startPractice],
  );

/**
   * ==================== 学习路线（2026-11-21） ====================
   *
   * 用户原话：「不用单独做个学习顺序的栏，可以把它整合进学习地图里。
   * 可以以杀戮尖塔那种爬塔式的方式做 ui，只不过是横板的，
   * 这样更符合『地图』的概念。」
   *
   * 所以这里只提供服务端接线，UI 在 `MapPage` 的横板路线里。
   *
   * ## 2026-11-21 深夜：换成资料级路线
   *
   * 用户改了口径（见下面 `sourceRoute` 那一段的注释）。
   * 下面这套知识点级接线**保留但不再上地图** —— 地图上的路线改用
   * `SourceRoute`（依据资料本体）。`RoutePreviewDialog` 也还留着。
   */
  const [planRoute, setPlanRoute] = useState<StudyPlan | null>(null);
  const [planRoutePoints, setPlanRoutePoints] = useState<PlanPointInput[]>([]);
  const [planRoutePointById, setPlanRoutePointById] = useState<Map<string, KnowledgePoint>>(
    new Map(),
  );
  /** AI 排出来、还没确认的结果（null = 没有待确认的） */
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);

  /** 读路线 + 排路线的输入。进学习地图时跑一次 */
  const loadPlanRoute = useCallback(async () => {
    try {
      const [saved, bundle] = await Promise.all([
        studyPlanStore.read(),
        loadPlanInputs({
          knowledge: knowledgeService,
          decks,
          reviewService,
          today: todayLocal(),
        }),
      ]);
      setPlanRoute(saved);
      setPlanRoutePoints(bundle.points);
      setPlanRoutePointById(bundle.pointById);
    } catch {
      /*
       * 读不到就保持现状：这是地图的**附加**一块，
       * 它坏了不该让「我哪块弱」那半页也打不开。
       */
    }
  }, [studyPlanStore, knowledgeService, decks, reviewService]);

  /**
   * 进学习地图时读一次路线与排序输入（2026-11-21）。
   *
   * 为什么在这里而不在 MapPage 里：`loadPlanInputs` 要读三张表
   * （知识点 / 题目 / 复习记录），而 App 已经有这些 service。
   * 让 MapPage 自己拼会重复一遍依赖注入。与 `refreshHomeWidgets`
   * 同一个分工 —— 数据装配在上层，页面只管显示。
   */
  useEffect(() => {
    if (page !== 'flow') return;
    void loadPlanRoute();
  }, [page, loadPlanRoute]);

  /**
   * 调 AI 排路线 → 进预览态（**不落库**）。
   *
   * 用户确认过「勾完才存」。所以这里只把结果放进 planDraft，
   * 由 dialog 让用户逐条勾选、点确认，才写库。
   */
  const generatePlanRoute = useCallback(async () => {
    const plan = await studyPlanOrder(planRoutePoints);
    setPlanDraft({
      blocks: plan.blocks,
      unplaced: plan.unplaced,
      dropped: plan.dropped,
    });
  }, [studyPlanOrder, planRoutePoints]);

  /** 用户确认 → 落库，同时把预览关掉 */
  const commitPlanRoute = useCallback(
    async (picked: { blocks: PlanOrder['blocks']; unplaced: number; dropped: number }) => {
      const doc: StudyPlan = {
        steps: planToSteps(picked, (id) => planRoutePointById.get(id)?.statement ?? ''),
        savedAt: new Date().toISOString(),
        unplaced: picked.unplaced,
      };
      await studyPlanStore.write(doc);
      setPlanRoute(doc);
      setPlanDraft(null);
    },
    [studyPlanStore, planRoutePointById],
  );

  const clearPlanRoute = useCallback(async () => {
    await studyPlanStore.write(null);
    setPlanRoute(null);
    setPlanDraft(null);
  }, [studyPlanStore]);

  /**
   * 写入用户勾选的章节（用户确认的第②点）。
   *
   * ⚠️ 这是**写用户真实数据**：`KnowledgePoint.chapter` 是他自己的知识库内容。
   * 所以只在用户逐条勾选并点「写入」后才走到这里 ——
   * `studyPlanChapters` 只返回预览，一个字节都不写库。
   */
  const applyPlanChapters = useCallback(
    async (picks: { pointId: string; chapter: string }[]): Promise<number> => {
      for (const p of picks) {
        await knowledgeService.update(p.pointId, { chapter: p.chapter });
      }
      /* 写完重读，让「缺章节 N 条」和排序输入都跟着更新 */
      await loadPlanRoute();
      return picks.length;
    },
    [knowledgeService, loadPlanRoute],
  );

  /** 点横板上的某一关：去练它 */
  const openPointAsCard = useCallback(
    async (pointId: string) => {
      /*
       * ⚠️ 不能走 `openSingleQuestion`。
       *
       * 那个函数 `decks.getQuestion(cardId)` 查的是**题目表**，
       * 传知识点 id 进去必然查不到，界面会报「这道题已经不在了」——
       * 一个假错误，用户会以为知识点被删了。
       *
       * 知识点在 v2 里**也是卡**（`cards-loader.ts` 的 `pointToCard`：
       * id = 知识点 id，kind = 'point'，prompt = statement）。
       * 所以这里按知识点取、自己构造成卡。
       */
      try {
        const point = await knowledgeService.get(pointId);
        if (!point) {
          setQueueError('这条知识点已经不在了（可能被删掉或进了回收站）。');
          return;
        }
        const { pointToCard } = await import('./cards-loader.ts');
        startPractice({
          cards: [pointToCard(point)],
          mode: 'free',
          label: '从学习路线进入',
          dueTotal: 1,
        });
      } catch (e) {
        setQueueError(e instanceof Error ? e.message : '打不开这一关');
      }
    },
    [knowledgeService, startPractice],
  );

  /* ==================== 学习路线：资料级（2026-11-21 深夜） ==================== */

  /**
   * ## 为什么这一套取代了上面那套（知识点级）
   *
   * 用户原话：
   * > 这个规划路线的规划方法需要修改一下，当前是依据知识库里的知识点进行规划，
   * > 我觉得应该依据资料本体进行构建。
   *
   * 所以地图上的「学习路线」现在读 `settings.sourceRoute`（资料级），
   * 不再读 `settings.studyPlan`（知识点级）。
   *
   * ## 为什么存在 settings 里而不是新分区
   *
   * 与 `studyPlan` 同一个理由（见 `study-plan-store.ts` 文件头）：
   * 路线是一个整体，一次写入天然原子；新分区要动迁移四件套。
   * 而 settings 的恢复白名单 bug 今天已经修掉且有 4 条回归测试守着。
   */
  const [sourceRoute, setSourceRoute] = useState<SourceRoute | null>(null);

  const loadSourceRoute = useCallback(async () => {
    try {
      const s = await library.getSettings();
      const raw = (s as unknown as { sourceRoute?: unknown }).sourceRoute;
      setSourceRoute(normalizeSourceRoute(raw));
    } catch {
      /* 读不到就当作没有路线：这是地图的附加一块，不该影响上半部分 */
    }
  }, [library]);

  useEffect(() => {
    if (page !== 'flow') return;
    void loadSourceRoute();
  }, [page, loadSourceRoute]);

  /**
   * 让 AI 排资料级路线。
   *
   * ## 错误原样抛上去
   *
   * 「没有可用模型 / 读不到 Key / 网络失败 / JSON 残缺 / 全部越界被丢」
   * 是五种完全不同的原因。全吞成一句「AI 没给出结果」会让人没法判断
   * （交接文档记过：AI 组卷原来就这么吞，五种原因变成一个，
   * 只能另写诊断脚本来查真因）。
   */
  const orderSourceRoute = useCallback(
    async ({
      prep,
      subjectName,
      search,
    }: {
      prep: SourcePlanPrep;
      subjectName: string;
      search: SearchResult | null;
    }): Promise<SourceRoute> => {
      const list = await backends.list();
      const readyList = list.filter((b) => b.status === 'ready');
      if (readyList.length === 0) {
        throw new Error('还没有可用的模型。先到「设置」里添加一个后端。');
      }
      const b = readyList[0]!;
      const apiKey = await backends.readCredential(b.id);
      if (!apiKey) throw new Error('读不到这个后端的 API Key，请到设置页重新填一次。');

      const { buildRoutePrompt, parseSourceRoute, attachSegments } = await import(
        '@/core/ai/source-route.ts'
      );
      const { toScopeInfo, loadSourceSegments } = await import(
        '@/v2/core/source-plan-inputs.ts'
      );

      const segments = await loadSourceSegments(sourceService, prep.source.id);
      const scope = toScopeInfo(prep, segments);

      /* 科目名用**用户确认过的**（他可能改过推定值）；edition 用推定值 */
      const subjectWithName = { ...prep.subject, name: subjectName };

      const { system, user } = buildRoutePrompt({
        subject: subjectWithName,
        outline: prep.outline,
        scope,
        search,
      });

      const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
      const res = await chatCompletion({
        apiKey,
        model: b.model,
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        provider: b.provider,
        systemPrompt: system,
        userPrompt: user,
        temperature: 0.2,
        /*
         * 路线只有几块、每块几步，输出不长；但给足预算 ——
         * 截断的 JSON 按设计整轮拒绝，用户会看到「排失败了」，
         * 而那其实只是预算不够。
         */
        maxTokens: 8000,
      });

      if (res.finishReason === 'length') {
        throw new Error('这次调用的输出被长度上限截断了。请重试。');
      }

      const parsed = parseSourceRoute(
        res.content,
        scope,
        { name: subjectName, edition: prep.subject.edition },
        !!search?.searched,
      );
      if (!parsed.ok) throw new Error(parsed.reason);

      /* 回填「这一步对应资料里的哪些段」—— 让「依据资料本体」可验证 */
      return attachSegments(parsed.route, scope);
    },
    [backends, sourceService],
  );

  const saveSourceRoute = useCallback(
    async (route: SourceRoute) => {
      await library.saveSettings({ sourceRoute: route } as never);
      setSourceRoute(route);
    },
    [library],
  );

  const clearSourceRoute = useCallback(async () => {
    await library.saveSettings({ sourceRoute: null } as never);
    setSourceRoute(null);
  }, [library]);

  /**
   * 读搜索 API Key。
   *
   * 存在 `settings.webSearchKey`。⚠️ **必须把它排除在备份导出之外** ——
   * 它是凭据，与 `backends` 的 Key 同性质（那些存在 `secrets` 分区、
   * 刻意不进备份）。见 `sanitizeSettingsForExport` 里补的那一行。
   */
  const readSearchKey = useCallback(async (): Promise<string | null> => {
    try {
      const s = await library.getSettings();
      const k = (s as unknown as { webSearchKey?: unknown }).webSearchKey;
      return typeof k === 'string' && k.trim().length > 0 ? k.trim() : null;
    } catch {
      return null;
    }
  }, [library]);

  const routeAi = useMemo(() => ({ orderRoute: orderSourceRoute }), [orderSourceRoute]);

  /**
   * 横板路线图要的「每章覆盖度」（2026-11-21 深夜补）。
   *
   * ## 为什么需要它
   *
   * 资料级路线的每一步是**一章**，而数据里没有「这一章学完了吗」。
   * 能观测到的事实是：
   *  - 这一章在资料里有多少段正文
   *  - 其中多少段已经出过题
   *
   * 所以进度按「这一章的正文有多少比例已经变成题目」算 ——
   * 这是可验证的，不是猜的。**不假装知道「学会没」**。
   *
   * ## 为什么在这里算而不是在 RouteBoard 里
   *
   * `RouteBoard` 是纯展示组件，不碰存储。它要什么由上层给。
   * 而这里已经能拿到 decks / knowledge / 资料段落。
   *
   * 依赖 `sourceRoute` 与 `page`：只在学习地图页、且有路线时才算。
   */
  const [routeCoverage, setRouteCoverage] = useState<
    Map<number, { segments: number; withQuestions: number }> | undefined
  >(undefined);
  /**
   * 题目的锚点还有效吗（2026-11-21 深夜实测出来的）。
   *
   * 用户库「信号与系统」有 10 道题，但它们的 `anchors[].segmentId`
   * **全部指向已不存在的段** —— 重新整理知识点时段落被替换，锚点没更新。
   *
   * 不知道这件事的话，覆盖度会恒为 0%，界面显示「0 段已出题（0%）」，
   * 用户会以为他一题都没做。所以要把「题目数」与「能对上段的题目数」
   * 一起算出来，界面据此如实说明。
   */
  const [routeAnchorHealth, setRouteAnchorHealth] = useState<
    { total: number; resolved: number } | undefined
  >(undefined);

  useEffect(() => {
    if (page !== 'flow' || !sourceRoute) {
      setRouteCoverage(undefined);
      setRouteAnchorHealth(undefined);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        /* 路线的 subject 是从哪份资料来的？按标题反查 */
        const sources = await sourceService.list();
        const src = sources.find((s) => (s.title || '').indexOf(sourceRoute.subject) >= 0)
          ?? sources.find((s) => sourceRoute.edition && (s.title || '').indexOf(sourceRoute.edition) >= 0);
        if (!src) {
          if (alive) setRouteCoverage(undefined);
          return;
        }

        const segs = await sourceService.getSegments(src.id);

        /* 每段的章号（与 source-plan-inputs 的 toScopeInfo 同一套规则） */
        const chapterOf = (text: string): number | null => {
          const m = /^[ \t]*第[ \t]*([0-9]+)[ \t]*章/m.exec(text);
          return m ? Number(m[1]) : null;
        };

        /* 已经有题的段落：从已发布题组的题目锚点里取 segmentId */
        const deckList = await decks.list();
        const segWithQuestion = new Set<string>();
        await Promise.all(
          deckList
            .filter((d) => d.status === 'published')
            .map(async (d) => {
              try {
                const qs = await decks.getQuestions(d.id);
                for (const q of qs) {
                  for (const a of q.anchors ?? []) {
                    if (a.segmentId) segWithQuestion.add(a.segmentId);
                  }
                }
              } catch {
                /* 题组刚被删，跳过 */
              }
            }),
        );

        const map = new Map<number, { segments: number; withQuestions: number }>();
        let current: number | null = null;
        const segIds = new Set(segs.map((x) => x.id));
        for (const seg of segs.slice().sort((a, b) => a.index - b.index)) {
          const found = chapterOf(seg.text);
          if (found !== null) current = found;
          if (current === null) continue;
          const row = map.get(current) ?? { segments: 0, withQuestions: 0 };
          row.segments += 1;
          if (segWithQuestion.has(seg.id)) row.withQuestions += 1;
          map.set(current, row);
        }

        /*
         * 题目的锚点还有效吗（见 routeAnchorHealth 的注释）。
         *
         * 统计这份资料已发布题组里的题目：共几道、其中几道的锚点
         * 能对上**当前**的段 id。
         */
        let totalQ = 0;
        let resolvedQ = 0;
        await Promise.all(
          deckList
            .filter((d) => d.status === 'published' && d.sourceId === src.id)
            .map(async (d) => {
              try {
                const qs = await decks.getQuestions(d.id);
                for (const q of qs) {
                  totalQ += 1;
                  const hit = (q.anchors ?? []).some((a) => a.segmentId && segIds.has(a.segmentId));
                  if (hit) resolvedQ += 1;
                }
              } catch {
                /* 题组刚被删，跳过 */
              }
            }),
        );

        if (alive) {
          setRouteCoverage(map);
          setRouteAnchorHealth(totalQ > 0 ? { total: totalQ, resolved: resolvedQ } : undefined);
        }
      } catch {
        /* 算不出来就不显示进度 —— 不猜 */
        if (alive) setRouteCoverage(undefined);
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, sourceRoute, sourceService, decks]);

  /**
   * ⚠️ 下面这一组是**知识点级路线**（第一版，2026-11-21 白天做的）。
   *
   * 用户当天晚上改了口径：路线要「依据资料本体」，于是资料级那套
   * （`sourceRoute` / `orderSourceRoute` / `RoutePlanner`）接管了地图。
   *
   * ## 为什么留着而不删
   *
   * 「我有 105 个知识点，先攻哪个」与「整门课按什么顺序学」是两个问题。
   * 前者要看每条知识点的掌握度与错题，后者要看章节结构与学科先修关系。
   * 用户只是说**地图上的路线**要按资料本体，没说知识点级排序以后不要。
   *
   * 删掉的话，那 83 条测试（`plan-order` / `chapter-backfill` /
   * `plan-inputs` / `study-plan-store`）与整套接线都要重写一遍 ——
   * 留着几乎零成本（不渲染就不耗性能），删掉才贵。
   *
   * ## 为什么用 void 引用而不是注释掉
   *
   * 注释掉会让 tsc 看不见它们、也让以后的人以为它是废弃代码。
   * `void` 明确表达「这些是有意保留的活代码，只是当前没有渲染入口」，
   * 同时让 `noUnusedLocals` 不再报错。
   */
  void planRoute;
  void planRoutePoints;
  void planRoutePointById;
  void planDraft;
  void generatePlanRoute;
  void commitPlanRoute;
  void clearPlanRoute;
  void applyPlanChapters;
  void openPointAsCard;
  void studyPlanChapters;
  void studyPlanOrder;
  void setPlanDraft;
  void planToSteps;
  void normalizeStudyPlan;



  /**
   * 装配「答疑记录」（2026-11-19）。
   *
   * 读两个来源、归一、合并排序：
   *  - `oralReviews`：提问式复习的问答
   *  - `questions.explainNotes`：答错后要的讲解
   *
   * 只在展示层合并，两份数据原样保留（见 answer-record.ts）。
   */
  const loadAnswerRows = useCallback(async () => {
    try {
      const [oralRecords, withNotes] = await Promise.all([
        oralReviewService.list(),
        decks.listQuestionsWithExplainNotes(),
      ]);
      /*
       * `listQuestionsWithExplainNotes` 返回 [questionId, notes][]，
       * 但归一需要题干。逐题取一次（通常只有几道题有讲解，
       * 不会成为 N+1 的负担）。
       */
      const questions = await Promise.all(
        withNotes.map(async ([qid, notes]) => {
          const q = await decks.getQuestion(qid);
          return q ? { question: { id: q.id, prompt: q.prompt }, notes } : null;
        }),
      );
      const rows = mergeAnswerRows(
        oralToRows(oralRecords),
        explainToRows(questions.filter((x): x is NonNullable<typeof x> => x !== null)),
      );
      setAnswerRows(rows);
    } catch {
      /* 读不到就保持现有列表，不清空 —— 避免界面突然变空 */
    }
  }, [decks, oralReviewService]);

  // 卡片池是数组，每次渲染都可能是新引用 —— 用内容做 key 避免无谓重算
  const poolKey = useMemo(() => pool.join(','), [pool]);

  /**
   * 侧栏「继续：xxx」—— 只在**页面自己上报了进行中的任务**时才出现。
   *
   * ## 用户报的问题（2026-11-13 傍晚）
   *
   * 「做这个跳页功能是为了知道某些任务的进度，例如文档解析，出题功能。
   *  但没有正在进行文档解析的任务时，这个提示也一直存在。」
   *
   * 根因：第一版判据是「这一页在保活列表里」。保活只说明页面留在内存，
   * 不说明用户在做任何事 —— 打开过一次解析页就永久占一层。
   * 现在判据是 `tasks`（页面自己上报），没上报就没有入口。
   *
   * `resumeTarget` 已经跳过当前页：人就在那一页上时不需要被提醒「继续」。
   */
  const resumeTask = useMemo(() => {
    const target = resumeTarget(tasks, page);
    if (!target) return null;
    return { page: target.page, label: target.label, detail: target.detail ?? null };
  }, [tasks, page]);

  /**
   * 渲染某一页 —— 原来那条 33 分支三元链原样搬在这里。
   *
   * 参数叫 `page` 是刻意的：链里 33 处 `page === 'xxx'` 因此不用改一个字，
   * 参数遮蔽了外层同名 state。改这个函数体时请保持「一条链」的形状，
   * 不要顺手改成分散的表 —— 那会让这次搬家的可核对性消失。
   */
  // eslint-disable-next-line complexity
  const renderPage = (page: PageId) => (
      page === 'board' ? (
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
          focusSourceId={mapFocus.sourceId}
          focusToken={mapFocus.token}
          route={
            /*
             * 学习路线整合进学习地图（2026-11-21 用户要求）。
             *
             * ⚠️ 2026-11-21 深夜换成**资料级**：用户要求
             * 「依据资料本体」而不是「依据知识点」。
             * 知识点级那套（planRoute / generatePlanRoute /
             * RoutePreviewDialog）保留在代码里但不再上地图。
             */
            {
              sourceRoute,
              ai: routeAi,
              sourceService,
              readSearchKey,
              onSaved: saveSourceRoute,
              onClearSaved: clearSourceRoute,
              onOpenParse: () => setPage('parse'),
              ...(routeCoverage ? { coverageByChapter: routeCoverage } : {}),
              ...(routeAnchorHealth ? { anchorHealth: routeAnchorHealth } : {}),
              onStep: () => {
                /* 点横板某一步：去「我的题组」看这一章的题（没有独立的章节页） */
                setPage('decks');
              },
            }
          }
        />
      ) : page === 'exam' ? (
        <ExamPage
          exam={examService}
          decks={decks}
          sourceService={sourceService}
          onOpenDecks={() => setPage('decks')}
          /*
            AI 评分（2026-11-17 方案 3）。
            复用做题页那套 handleShortGrade —— 同一个 grade-short 提示词、
            同一套防注入规则。再写一份必然漂移（交接文档 5.2：
            「反馈只能有一份实现」）。
          */
          onAiGrade={async (input) => {
            try {
              return await handleShortGrade(input);
            } catch {
              /*
                返回 null 而不是抛：考场里的评分是「参考」，
                失败不该打断用户看卷子。面板会显示「读不懂，请重试或自己评」。
              */
              return null;
            }
          }}
          /*
            AI 组卷（2026-11-17 用户要求）。
            读后端凭据 + 发请求放在这里，ExamPage 不碰 Key。
            返回的是**已校验 id** 的结果（parseCompose 里把幻觉 id 丢掉了）。
          */
          onAiCompose={async ({ questions, count, scopeLabel }) => {
            /*
             * ⚠️ 这里**不再吞掉错误**（2026-11-17 实测后改）。
             *
             * 原来是 `catch { return null }` —— 网络失败、Key 错、
             * 被截断、id 全是幻觉……五种完全不同的原因全变成界面上一句
             * 「AI 这次没给出可用的组卷结果」。用户没法判断，
             * 我也只能另写诊断脚本才查得出真因。
             *
             * 现在把真实原因抛上去，由 ExamPage 原样显示。
             */
            const { buildComposePrompt, parseCompose } = await import('@/core/ai/compose-exam.ts');
            const prompt = buildComposePrompt({ questions, count, scopeLabel });
            const b = await resolveBackend();
            const { chatCompletion } = await import('@/core/ai/deepseek-client.ts');
            const res = await chatCompletion({
              apiKey: b.apiKey,
              model: b.model,
              ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
              provider: b.provider,
              systemPrompt: prompt.system,
              userPrompt: prompt.user,
              /* 组卷要稳，不要发挥 */
              temperature: 0.2,
              /*
               * ⚠️ 4000 而不是 1200（2026-11-17 实测改的）。
               *
               * `deepseek-flash` 是**推理模型**：先输出思考（reasoning），
               * 再输出正文（content）。原来设 1200，实测：
               *   completion_tokens: 1200
               *   reasoning_tokens:  1200   ← 全花在思考上
               *   content:           ""     ← 正文一个字都没轮到
               *   finish_reason:     "length"
               *
               * 所以 parseCompose('') 返回 null，界面报「没给出可用结果」。
               * 不是模型不会组卷，是没给它留输出空间。
               */
              maxTokens: 4000,
            });
            /*
              被截断这种情况单独说清楚 —— 它跟「模型答非所问」是两回事。
            */
            if (res.finishReason === 'length' && !res.content.trim()) {
              throw new Error(
                '模型把输出预算全用在思考上了，正文是空的（推理模型的特性）。' +
                  '预算已调到 4000，请再试一次；若还不行，到设置里换一个非推理模型。',
              );
            }
            const parsed = parseCompose(res.content, questions, count);
            if (!parsed) {
              /*
               * 走到这里说明「有内容但不是可用的 JSON」。
               * 把模型原文的前 200 字带上 —— 没有它，用户和我都只能猜。
               */
              const head = res.content.trim().slice(0, 200);
              throw new Error(
                head
                  ? `AI 返回的内容读不懂（不是约定的 JSON）。它开头说的是：「${head}」`
                  : 'AI 返回了空内容，再试一次。',
              );
            }
            /*
             * 把 token 用量带回去（2026-11-17）。
             * 任务页要显示「这次组卷花了多少」—— 不给就只能是 null。
             */
            return { ...parsed, tokens: res.usage?.totalTokens ?? null };
          }}
          /*
            AI 组卷的任务记录（2026-11-17 用户要求）。
            与解析记录同一套：开场 → 结束时无论成败都关掉。
          */
          runRecorder={{
            startCompose: (input) => taskRuns.startComposeRun(input),
            finishCompose: (id, outcome) => taskRuns.finishComposeRun(id, outcome),
          }}
          /*
            「先自己挑，再让 AI 改造」（2026-11-17 用户要求）。

            用户原话：「用户先在题库挑选想要的题目，然后 ai 在这些题目的
            基础上改动出题」。

            ## 为什么复用变式那套素材

            `pickedQuestionsToVariantMaterials` 内部用的就是
            `questionToVariantMaterial` —— 它已经把「原题 + 原答案 + 原解析
            + 选项 + 考点 + 变式维度 + 硬性限制」拼好了，措辞经过
            2026-11-12 那轮修正（防止模型改出另一道题）。再写一份必然漂移。
          */
          onComposeVariantFrom={async ({ questions: picked, axes }) => {
            const { pickedQuestionsToVariantMaterials, composeVariantTitle } = await import(
              '@/core/questions/compose-variant.ts'
            );
            /*
             * 取知识点：用来给变式提供「考点」。
             * 取不到也能改（素材里会写「原题未标注考点」），
             * 所以失败不阻断，只是提示质量差一点。
             */
            const pointsById = new Map<string, import('@/core/model.ts').KnowledgePoint>();
            try {
              for (const src of (await sourceService.list()) ?? []) {
                for (const p of await knowledgeService.listBySource(src.id)) {
                  /* 知识点与题不是一一对应，这里按题干相同来关联 */
                  pointsById.set(p.statement, p);
                }
              }
            } catch {
              /* 没有知识点也能改造 */
            }
            const pointsForQ = new Map<string, import('@/core/model.ts').KnowledgePoint>();
            for (const q of picked) {
              const hit = pointsById.get(q.prompt) ?? pointsById.get(q.topic ?? '');
              if (hit) pointsForQ.set(q.id, hit);
            }

            const materials = pickedQuestionsToVariantMaterials({
              questions: picked,
              pointsById: pointsForQ,
              axes: axes as never,
            });
            if (materials.length === 0) {
              throw new Error('这些题没法用来改造（题干可能是空的）。');
            }

            const b = await resolveBackend();
            /*
             * 构造出题后端（与 GeneratePage 里变式出题同一套）。
             *
             * 为什么不复用 `resolveBackend` 的返回值直接当 backend：
             * 那个返回的是「后端视图」（含 apiKey / status 等 UI 字段），
             * 而 `decks.generate` 要的是 `QuestionBackend` 实现
             * （有 generate 方法）。两者不是一回事。
             */
            const { DeepSeekQuestionBackend } = await import('@/core/questions/deepseek-backend.ts');
            const backend = new DeepSeekQuestionBackend({
              apiKey: b.apiKey,
              provider: b.provider,
              model: b.model,
              ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
            });

            const out = await decks.generate({
              /* 素材优先；points 留空 —— generate 会用 materials */
              points: [],
              materials,
              title: composeVariantTitle(picked.length ? `自选 ${picked.length} 题` : null),
              sourceId: null,
              backend,
              options: {
                kinds: ['single', 'multiple', 'truefalse', 'blank', 'essay', 'calc'],
                /* 一道原题 → 一道变式题（组卷语义：挑几道就出几道） */
                count: picked.length,
                /* 变式不强制难度分布 —— 同一考点换考法比换难度更有意义 */
                levels: null,
                language: 'zh',
              },
              /*
               * 必须给 signal（`GenerateQuestionsInput` 要求它）。
               * 用全新 controller：调用方（ExamPage）没有取消入口，
               * 但传一个不会被 abort 的 signal 是合法且最简单的做法。
               */
              signal: new AbortController().signal,
            });
            return {
              questions: out.questions,
              deckTitle: out.deck.title,
              tokens: out.actualTokens ?? null,
            };
          }}
        />
      ) : page === 'notes' ? (
        <NotesPage
          notes={notesService}
          decks={decks}
          sourceService={sourceService}
          knowledge={knowledge}
          annotations={annotations}
          onOpenSource={(sourceId) => openReader(sourceId, null)}
          /*
            「按资料看」每一条都要能点回**那一处**（2026-11-11），
            所以给带 page/quote 的跳转，而不是只打开资料。
          */
          onOpenSourceAt={(sourceId, page, quote) =>
            openReader(sourceId, {
              sourceId,
              page,
              ...(quote !== undefined ? { quote } : {}),
            })
          }
          onOpenKnowledge={() => setPage('knowledge')}
          /*
            挂在**题目**上的手写笔记，点击回到那道题（2026-11-19）。
            用户报的原问题是「点击跳到了原文而不是题目」——
            他要回看的是「我当时为什么在这道题下写这句」。
          */
          onOpenQuestion={(cardId) => void openSingleQuestion(cardId)}
        />
      ) : page === 'book' ? (
        <BookPage
          decks={decks}
          sourceService={sourceService}
          /*
           * 知识点表：定位到句子要用（2026-11-20）。
           * 题目 → knowledgePointId → 知识点的精确字符偏移。
           */
          knowledge={knowledgeService}
          onOpenSource={(sourceId) => openReader(sourceId, null)}
          /*
           * 自测答错后跳回原文那一页（2026-11-09）。
           * 只传 sourceId 会让阅读器打开第一页 —— 那等于没定位。
           */
          onOpenSourceAt={(sourceId, page, quote) =>
            openReader(sourceId, { sourceId, page, quote })
          }
          /*
           * 精确定位到句子（2026-11-20）。
           *
           * 与上面那个的区别：这个把完整位置（charStart/charEnd/segmentId）
           * 一起带过去，阅读器能圈到具体那一句并标橙光。
           * 只有页码时阅读器只能跳到页首 —— 那就是用户说的
           * 「只能定位到页面，不能具体到句子」。
           */
          onLocateSource={(target) => openReader(target.sourceId, target)}
          onOpenDecks={() => setPage('decks')}
          autoStartReview={autoReview}
          onAutoStartConsumed={() => setAutoReview(false)}
          reviewQueue={reviewQueue}
          onReviewGrade={handleReviewGrade}
          flashcards={flashcards}
          flashcardPoints={flashcardPoints}
          onAddFlashcards={handleAddFlashcards}
          onRemoveFlashcard={handleRemoveFlashcard}
          onPickFlashcardsWithAi={handlePickFlashcards}
          onGoPickKnowledge={() => void handleGoPickKnowledge()}
          autoShowFlashcards={showFlashcardsFromKnowledge}
          onAutoShowFlashcardsConsumed={() => setShowFlashcardsFromKnowledge(false)}
          oralScopeLabel={oralScopeLabel}
          oralMaterial={oralMaterial}
          onOralAsk={handleOralAsk}
          onOralJudge={handleOralJudge}
          onOralSave={handleOralSave}
          onOralNext={handleOralNext}
          autoStartOral={autoOral}
          onAutoStartOralConsumed={() => setAutoOral(false)}
          oralScopes={oralScopes}
          oralScopeId={oralScopeId}
          onOralScopeChange={(id) => void handleOralScopeChange(id)}
          oralScopeLoading={oralScopeLoading}
          oralScopeError={oralScopeError}
          /*
           * 知识点条数要如实显示 —— 0 条时那两条路都不能走，
           * 按钮置灰并说明原因（不做假开关）。
           *
           * 用 `flashcardPoints`：名字是历史遗留（最早只服务闪卡），
           * 但它装的本来就是 `knowledgeService.listAll()` 的全量知识点。
           * 这里只读不写，不引入第二份真相。
           */
          onPickPointsForOral={() => void handleGoPickPointsForOral()}
          oralPointCount={pointsToMaterials(flashcardPoints).length}
          /*
           * 「素材是显式选定的」→ 不给换范围下拉（2026-11-19 晚）。
           * 否则顶部写「选定的 1 条知识点」、下拉写「知识点随机」，
           * 两套信息打架，点一下还会把挑好的覆盖掉。
           */
          oralScopeLocked={oralScopeLocked}
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
            去「文档解析」页并选中那份资料（2026-11-17）。
            用户要求未完成/进行中的任务能点进去「查看进度或重新进行」——
            所以这里跳到解析页，而不是就地重跑一次。
          */
          onOpenParse={(sourceId) => {
            setParseSourceId(sourceId);
            setPage('parse');
          }}
          /* AI 组卷记录 → 模拟考页（2026-11-17） */
          onOpenExam={() => setPage('exam')}
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
      ) : page === 'search' ? (
        /*
         * 搜索页（2026-11-20）。
         *
         * 从顶栏挪出来独立成页 —— 窄的顶栏输入框（329px）
         * 盛不下「好几本书各有多少命中」这个信息。
         * 命中概览的分布条只有整页宽度才看得清。
         */
        <SearchPage
          loadIndex={async () => {
            const [sources, segments] = await Promise.all([
              sourceService.list(),
              sourceService.getAllSegments(),
            ]);
            return { sources, segments };
          }}
          onOpenHit={(target) => openReader(target.sourceId, target)}
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
          /*
           * 错题变式入口（2026-11-12）。
           *
           * 用户反馈：「我需要一个入口，你做了功能可是没有使用入口」。
           * 变式做好后只能从「我的题组 → 新建题组」三步进去，等于没做。
           * 这里把错题页两个入口接上：
           *  - 概览行的「错题变式强化」→ 批量挑错题
           *  - 每题底部的「出变式题」→ 直接用那一题
           *
           * 都跳到「我的题组」并展开新建表单（出题表单就在那里，
           * 没有独立的 generate 页），差别只在有没有预选那道题。
           */
          /*
           * 批量入口传**空数组**而不是 null（2026-11-13 修）。
           *
           * 原来这里写 `setVariantPreselect(null)`，而 GeneratePage 里
           * 切模式的判据是「initialVariant 存在且 questionIds 非空」——
           * null 让那个判据永远不成立，于是点「错题变式」跳进的是
           * 「用资料出题」，变式面板根本没渲染。
           *
           * 用户原话：「错题变式的出题功能是假按钮，点击之后没有反馈」。
           * 空数组表示「要进变式模式，但还没勾选任何题」——
           * 用户进来自己挑，而不是被丢在另一个模式里。
           */
          onOpenVariant={() => {
            setVariantPreselect({ questionIds: [] });
            void navigate('generate');
          }}
          onVariantSingle={(questionId) => {
            setVariantPreselect({ questionIds: [questionId] });
            void navigate('generate');
          }}
          view={wrongbookView}
          onViewChange={setWrongbookView}
          focusCardId={wrongFocus.cardId}
          focusToken={wrongFocus.token}
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
          /*
            收藏知识点（2026-11-11）。
            用 toggleFavorite 而不是让界面拼 patch：取反语义由服务层负责，
            界面上连点两下能回到原状。
          */
          onToggleFavorite={async (id) => {
            await knowledgeService.toggleFavorite(id);
            void refreshShellState();
          }}
          /*
            从别处跳过来挑知识点。
            「加进闪卡」（2026-11-10）与「挑来提问」（2026-11-19 晚）
            共用同一个挑选模式，靠 pickingFor 区分挑完做什么。
            不在挑选模式时是 undefined —— 平时进知识库是纯浏览，不多任何控件。
          */
          onPickPoints={
            pickingFor === 'flashcards'
              ? async (ids) => {
                  await handleAddFlashcards(ids);
                  /*
                   * 加完回闪卡看结果。
                   *
                   * 不留在知识库：用户刚挑的卡最想在翻卡视图里看到，
                   * 留在原地会让他怀疑「到底加进去了没有」
                   * （交接文档记过同类 bug：建完卡停在挑卡页）。
                   */
                  setPickingFor(null);
                  setShowFlashcardsFromKnowledge(true);
                  setPage('book');
                }
              : pickingFor === 'oral'
                ? async (ids) => {
                    /*
                     * 挑来提问：把选中的知识点做成素材池，直接进提问面板。
                     *
                     * 不过滤空池 —— 用户勾了就一定有内容（知识点列表本身
                     * 只列 statement 非空的）。真为空时面板会显示
                     * 「这个范围没有可提问的内容」，比在这里静默拦住好。
                     */
                    const all = flashcardPoints;
                    const wanted = new Set(ids);
                    const picked = pointsToMaterials(all.filter((p) => wanted.has(p.id)));
                    setPickingFor(null);
                    setOralPool(picked);
                    setOralMaterial(pickMaterial(picked));
                    setOralScopeLabel(`选定的 ${picked.length} 条知识点`);
                    /*
                     * 挂守卫：进复习巩固页的那个 effect 会把素材池
                     * 重置成「知识点随机」，不拦会把刚挑的覆盖掉。
                     * 与划选提问同一条守卫（selectionOralRef），
                     * 因为它表达的就是「这一轮素材是显式指定的」。
                     */
                    selectionOralRef.current = true;
                    setOralScopeLocked(true);
                    setAutoOral(true);
                    setPage('book');
                  }
                : undefined
          }
          pickTitle={pickingFor === 'oral' ? '挑要提问的知识点' : '挑要加进闪卡的知识点'}
          pickHintText={
            pickingFor === 'oral' ? '勾选要拿去提问的知识点。' : '勾选要加进闪卡的知识点。'
          }
          onCancelPick={() => setPickingFor(null)}
          /*
           * ⚠️ 「已在闪卡里」只在挑闪卡时置灰（2026-11-19 晚）。
           *
           * 挑来提问时它必须为 false：做过闪卡的知识点一样可以问，
           * 原来无条件置灰会让大部分知识点勾不动 —— 那不是设计，
           * 是复用挑选模式时漏掉的一条耦合。
           */
          pickDisablesPicked={pickingFor === 'flashcards'}
          pickActionLabel={pickingFor === 'oral' ? '用这些提问（{n}）' : '加入闪卡（{n}）'}
          pickBusyLabel={pickingFor === 'oral' ? '正在准备…' : '正在加入…'}
          /*
           * 「已经做成闪卡的」知识点 id（界面据此显示「已加入」）。
           *
           * 2026-11-14 起优先取 `sourceId2`：闪卡独立之后，
           * `knowledgePointId` 只是旧字段（新卡也写，但手写的卡没有）。
           * 两者都看一遍并滤掉空值，否则 Set 里会混进 undefined。
           */
          alreadyPickedIds={flashcards
            .map((v) => v.card.sourceId2 ?? v.card.knowledgePointId)
            .filter((id): id is string => !!id)}
        />
      ) : page === 'study' ? (
        <StudyPage
          service={reviewService}
          cardPool={pool}
          dueCount={queueTotal || null}
          onStartQuiz={() => void navigate('review')}
          /*
           * 「开始复习」= 跳到「复习巩固」栏目（2026-11-13 深夜改）。
           *
           * 用户原话：「开始复习功能不用这种翻面闪卡样式了，
           * 就做成一个跳转到复习巩固栏目的按钮吧」。
           *
           * 原来这里走 startTodayReview()，点了就地起一轮「先回想→翻面→
           * 1-4 自评」的会话（ReviewToday）。那个交互是照 Anki 闪卡做的，
           * 与这一轮要做的闪卡功能撞车。所以拆开：
           *  - 复习 = 去那一页（用户在页里自己选做今日复习还是自测）
           *  - 闪卡 = 翻面看
           *
           * 不再预先把队列算好塞进去：带路不需要知道今天有没有到期，
           * 复习巩固页自己会说明。
           */
          onOpenReviewBook={() => goPage('book')}
          onOpenFlashcards={() => setPage('flashcards')}
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
            onGradeShort={handleShortGrade}
            onExplainWrong={handleExplainWrong}
            onAskHint={handleAskHint}
            explainNotesOf={(id) => explainNotes.get(id) ?? EMPTY_NOTES}
            /*
             * 这一轮做完了（2026-11-13 下午；傍晚改成 dropPage）。
             *
             * 必须把做题页从保活里丢掉：否则它会一直留在下面，
             * 侧栏挂着「继续」，点进去看到的是上一轮的结果页 ——
             * 一个永远无法结束的任务。
             *
             * 现在这一页自己也会在结束时把上报改成 null（见 ReviewPage），
             * 这里是第二道保险：即使它忘了，也不会留下残留入口。
             */
            onFinish={() => {
              setTasks((s) => dropPage(s, 'practice'));
              void navigate('review');
            }}
            onExit={() => {
              setTasks((s) => dropPage(s, 'practice'));
              void navigate('review');
            }}
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
          /*
           * 从资料库直接跳到某一页（2026-11-13）。
           * 阅读器那侧早就有页码输入框，但用户得先打开、再滚到输入框、再输入；
           * 从列表看到「442 页」想直接去第 200 页时，这条路太长。
           */
          onOpenSourceAtPage={(source, page) => openReader(source.id, { sourceId: source.id, page })}
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
          /*
           * 划选提问（2026-11-10）。
           *
           * 没接模型时不传这个 prop —— 阅读器就不显示浮层，
           * 而不是显示一个点了报错的按钮（硬约束第 7 条：不做假开关）。
           */
          onAskAboutSelection={conn.connected ? handleAskAboutSelection : undefined}
          askDisabledReason={conn.connected ? null : '还没接入模型，先到设置里加一个后端'}
          /*
           * 划选正文 → 做成闪卡（2026-11-14，用户要求）。
           *
           * 用户原话：「让 ai 写闪卡这个功能可以再接入资料库，
           * 和让 ai 提问一样，用户可以划选资料内容制作闪卡」。
           *
           * 没接模型时不传（不摆点了没反应的按钮）。
           */
          onMakeCardFromSelection={conn.connected ? handleMakeCardFromSelection : undefined}
          cardDisabledReason={conn.connected ? null : '还没接入模型，先到设置里加一个后端'}
        />
      ) : page === 'parse' ? (
        <ParsePage
          sourceService={sourceService}
          /*
            两个来源共用一个入参（2026-11-17）：
            从整理页跳来的用 organizeSourceId，从任务页点「去重新解析」来的
            用 parseSourceId。后者优先 —— 那是用户刚刚点的那一下。
          */
          initialSourceId={parseSourceId ?? organizeSourceId}
          runRecorder={{
            start: (input) => taskRuns.startParseRun(input),
            finish: (id, outcome) => taskRuns.finishParseRun(id, outcome),
          }}
          onOpenReader={(sourceId) => openReader(sourceId, null)}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
          }}
          /*
           * 云端 OCR 那条路（2026-11-15，用户要求）。
           *
           * 用户原话：「把调用 ocr 识别作为除了本地模型解析 pdf 的另一方式」。
           *
           * 只有接了后端才显示这个选项 —— 没后端时界面上不该出现一条
           * 永远点不了的选项（项目一贯：不做假开关）。
           */
          cloudOcr={cloudOcrProp}
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
          onOpenParse={(sourceId) => {
            /* 2026-11-11：整理页给一句「去文档解析」的提醒，点了跳过去 */
            setOrganizeSourceId(sourceId);
            setPage('parse');
          }}
        />
      ) : page === 'decks' ? (
        <DecksPage
          decks={decks}
          sourceService={sourceService}
          knowledge={knowledge}
          backends={backends}
          reviewService={reviewService}
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
        <StatsPage service={reviewService} cardPool={pool} loadCards={loadCards} />
      ) : page === 'flashcards' ? (
        /*
         * 闪卡管理（2026-11-13 深夜新增）。
         *
         * 用户要求：「错题闪卡改名为闪卡管理。然后在课程准备与管理的
         * 栏目下新开一个闪卡管理栏目」。确认「两种都要」。
         *
         * 这一页只管理，不做「开始背」—— 背闪卡在复习巩固页
         * （那里已有 FlashcardsPanel）。见 FlashcardsPage 头注释。
         */
        <FlashcardsPage
          flashcards={flashcardsService}
          reviewService={reviewService}
          knowledge={knowledgeService}
          loadCards={loadCards}
          onGoReview={() => goPage('book')}
          onMakeCards={handleMakeFlashcards}
          /*
           * 从阅读器划选带过来的 AI 草稿（2026-11-14）。
           *
           * 带着 token：同一段文字再点一次「做成闪卡」也要能重新塞进来，
           * 否则第二次点没反应。
           */
          incomingAiCards={pendingAiCards}
          onIncomingConsumed={() => setPendingAiCards(null)}
        />
      ) : page === 'oral' ? (
        /*
         * 答疑记录（2026-11-19 合并两处记录）。
         *
         * 原来这里只有「提问式复习」的记录。而「答错补充讲解」也有记录，
         * 却存在题目里、没有入口 —— 用户找不到「我之前问过什么」。
         *
         * 两者对用户来说是同一件事：我不懂 → 问 → 得到解释。
         * 现在合成一处，用来源筛选区分。数据没合并（见 answer-record.ts）。
         *
         * 只读页面：不写 reviewLogs / reviewRecords，不改任何复习进度。
         */
        <AnswerRecordPage
          rows={answerRows}
          onOpenSourceAt={(sourceId, pageNum) =>
            openReader(sourceId, { sourceId, page: pageNum })
          }
          onOpenQuestion={(questionId) => void openSingleQuestion(questionId)}
          onRemoveOral={async (id) => {
            await oralReviewService.remove(id);
            await loadAnswerRows();
          }}
        />
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
           * 首页各行的「点进去」（2026-11-13 深夜）。
           *
           * 用户原话：「点击界面上的题组、错题或是资料能直接跳转到
           * 对应的题组、错题或是资料页面，不用再到对于功能栏打开」。
           *
           * 三个去处各不相同，映射表在 home-row-target.ts（有单测）：
           *  - 题组进度行 → 学习地图并展开那份资料（那块统计的是题目）
           *  - 资料阅读行 → 直接打开阅读器并回到上次那一页
           *  - 错题行     → 错题页并展开+滚动+高亮到那一题
           */
          onOpenMapSource={(sourceId) => {
            setMapFocus((prev) => ({ sourceId, token: prev.token + 1 }));
            setPage('flow');
          }}
          onOpenSourceAt={(source, page) =>
            openReader(source.id, {
              sourceId: source.id,
              ...(typeof page === 'number' ? { page } : {}),
            })
          }
          onOpenWrongCard={(cardId) => {
            setWrongFocus((prev) => ({ cardId, token: prev.token + 1 }));
            setPage('wrongbook');
          }}
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
          reviewService={reviewService}
          initialCreate
          /*
           * 从错题页「出变式题」跳来时的预选目标（2026-11-12）。
           * 传下去后出题页会直接切到变式模式并勾上那一题。
           */
          initialVariant={variantPreselect}
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
      )
  );

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
      onOpenSettings={() => goPage('settings')}
      reviewProgress={null}
      trashBadge={trashBadge}
      resumeTask={resumeTask}
      onResumeTask={resumeTask ? () => goPage(resumeTask.page) : undefined}
      /*
       * 顶栏搜索框已撤（2026-11-20）。
       *
       * 用户要求把它改成独立页面（侧栏「课程准备与管理 → 搜索」），
       * 界面参考 Google/Bing。理由：顶栏输入框只有 329px 宽，
       * 结果挤在 380px 的下拉面板里 —— 而「好几本书各有多少命中」
       * 这个信息窄面板根本盛不下。
       *
       * 这里不传 `search`，AppShell 就不渲染搜索框
       * （它的实现是「不传就不显示」，不留空占位）。
       */
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
      {/*
        页面覆盖层（2026-11-13 下午；傍晚按用户反馈重做判据）。

        上半部分：用户报的「跳页后回不到原任务」—— 原来是一条三元链，
        切页即卸载，做题做到一半去看原文，回来题号/选项/倒计时全没了。
        现在把「有活儿在进行」的页留在 DOM 里，只把非当前页藏起来。

        下半部分（2026-11-13 傍晚，用户反馈）：「有活儿在进行」**不能靠白名单猜**。
        他说「没有正在进行文档解析的任务时，这个提示也一直存在」。
        所以现在由页面自己通过 usePageTask() 上报，App 只渲染上报过的页 ——
        没上报的页既不保活、也没有「继续」入口。

        隐藏层加 inert：不能拿焦点、不能点、读屏不念 ——
        否则隐藏的做题页会和当前页一起响应键盘（ReviewToday 等
        在 window 上抢 1-4 和方向键，两层同挂会双响应）。
        见 page-layers.ts、page-task-context.ts。
      */}
      {layersToRender(tasks, page).map((pid) => {
        const active = pid === page;
        return (
          <PageLayerContext key={`${pid}:${layerEpoch[pid] ?? 0}`} value={active}>
            <PageTaskContext.Provider value={reporterFor(pid)}>
              <div
                className={active ? `page-layer page-layer--on` : `page-layer`}
                inert={active ? undefined : true}
              >
                {renderPage(pid)}
              </div>
            </PageTaskContext.Provider>
          </PageLayerContext>
        );
      })}

      {/* 学习路线预览确认（2026-11-21）：AI 排完先给用户勾，勾完才存 */}
      {planDraft ? (
        <RoutePreviewDialog
          draft={planDraft}
          pointById={planRoutePointById}
          onConfirm={(picked) => void commitPlanRoute(picked)}
          onCancel={() => setPlanDraft(null)}
        />
      ) : null}
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
  parse: '文档解析',
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
    book: '复习巩固',
    stats: '统计',
    oral: '提问复习记录',
    flashcards: '闪卡管理',
    skeleton: '知识骨架',
    organize: '整理知识点',
    parse: '文档解析',
    reader: '阅读原文',
    practice: '做题中',
    guide: '功能导览',
    search: '搜索资料',
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
