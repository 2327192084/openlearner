import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { AppShell } from './AppShell.tsx';
import { TodayPage } from './TodayPage.tsx';
import { ReviewPage } from './ReviewPage.tsx';
import { SourcesPage } from './SourcesPage.tsx';
import { GeneratePage } from './GeneratePage.tsx';
import { StatsPage } from './StatsPage.tsx';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { BackendService } from '@/core/backends.ts';
import type { SourceService } from '@/core/sources.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { PageId } from './pages.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { OrganizePage } from './OrganizePage.tsx';
import { useServices } from '@/app/services-context.ts';
import './tokens.css';
import './shell.css';
import './paper.css';
import './today-page.css';
import './review-page.css';
import './sources-page.css';
import './generate-page.css';
import './stats-page.css';
import './settings.css';
import './organize-page.css';

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
   * 本轮复习队列。
   *
   * 进「复习」时才构造 —— 每次进入都重新算今日到期，
   * 而不是缓存一份（用户可能中途答完几张又回来）。
   */
  const [queue, setQueue] = useState<Card[] | null>(null);
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

  const { library } = useServices();

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
        // 进复习就现取今日到期队列
        setQueueError(null);
        setQueue(null);
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
          setQueue(due.slice(0, 30));
        } catch (err) {
          setQueueError(err instanceof Error ? err.message : '读不出卡片');
          setQueue([]);
        }
      }
    },
    [loadCards, reviewService],
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
      {page === 'review' ? (
        queue === null ? (
          <p className="today__lead">{queueError ?? '正在准备今日复习…'}</p>
        ) : (
          <ReviewPage
            service={reviewService}
            queue={queue}
            onFinish={() => setPage('today')}
            onExit={() => setPage('today')}
          />
        )
      ) : page === 'sources' ? (
        <SourcesPage
          service={sourceService}
          onOpenSource={(source) => {
            /*
             * 阅读器还没做，所以点资料不是「打开原文」，而是
             * 跳到这份资料的整理页 —— 那是现在真正能对一份资料做的事。
             * 不摆一个点了没反应的资料行。
             */
            setOrganizeSourceId(source.id);
            setPage('organize');
          }}
          onImported={() => void refreshCounts()}
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
        />
      ) : page === 'generate' ? (
        <GeneratePage
          sourceService={sourceService}
          knowledge={knowledge}
          decks={decks}
          backends={backends}
          onGenerated={() => void refreshCounts()}
          onOpenSources={() => setPage('sources')}
          onOpenOrganize={(sourceId) => {
            setOrganizeSourceId(sourceId);
            setPage('organize');
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
          onStartNew={() => setPage('generate')}
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
    review: '复习',
    sources: '资料',
    generate: '创建题组',
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
        这一页还在重做中。现在能用的有：学习库、资料、整理知识点、创建题组、复习、统计、设置。
      </p>
      <button type="button" className="btn-ghost" onClick={onBack}>
        回到学习库
      </button>
    </div>
  );
}
