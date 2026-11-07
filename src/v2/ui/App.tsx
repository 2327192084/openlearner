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
  /** 当前资料库里的全部卡片 id */
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
      const [o, srcs] = await Promise.all([reviewService.todayOverview(cardPool), sourceService.list()]);
      /**
       * 「复习」显示待复习数量，0 时不显示徽章 —— 没有待办就不该有标记。
       * 「资料」显示份数（0 也有意义：说明库是空的）。
       */
      setOverviewCounts({
        sources: srcs.length,
        ...(o.dueCount > 0 ? { review: o.dueCount } : {}),
      });
    } catch {
      setOverviewCounts({});
    }
  }, [reviewService, cardPool, sourceService]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

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
          const due = all.filter((c) => {
            const r = byId.get(c.id);
            if (!r) return true; // 没学过也算今天可学
            return r.state.dueAt <= today;
          });
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
          setQueueTotal(due.length);
        } catch (err) {
          setQueueError(err instanceof Error ? err.message : '读不出卡片');
          setDueCards([]);
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
  const poolKey = useMemo(() => cardPool.join(','), [cardPool]);

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
        <BoardPage todos={todoService} />
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
          cardPool={cardPool}
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
          onImported={() => void refreshCounts()}
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
            void refreshCounts();
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
          onGenerated={() => void refreshCounts()}
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
            void refreshCounts();
            void refreshShellState();
          }}
        />
      ) : page === 'stats' ? (
        <StatsPage service={reviewService} cardPool={cardPool} />
      ) : page === 'settings' ? (
        <SettingsPage onChanged={() => void refreshShellState()} />
      ) : page === 'today' ? (
        <TodayPage
          key={poolKey}
          service={reviewService}
          cardPool={cardPool}
          hasSources={hasSources}
          connected={conn.connected}
          modelName={conn.modelName}
          onOpenSources={() => setPage('sources')}
          onStartReview={() => setPage('review')}
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
          onGenerated={() => void refreshCounts()}
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
            void refreshCounts();
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
