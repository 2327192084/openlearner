import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { AppShell } from './AppShell.tsx';
import { TodayPage } from './TodayPage.tsx';
import { ReviewPage } from './ReviewPage.tsx';
import type { Card } from '@/v2/core/cards.ts';
import type { PageId } from './pages.ts';
import './tokens.css';
import './shell.css';
import './paper.css';
import './today-page.css';
import './review-page.css';

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
   * 侧栏计数。
   *
   * 只给「复习」显示待复习数量 —— 其他页面的计数目前没有可靠来源，
   * 宁可不显示，也不显示一个猜的数字。
   */
  const refreshCounts = useCallback(async () => {
    try {
      const o = await reviewService.todayOverview(cardPool);
      /**
       * 「资料」与「待办」显示条目数（0 也有意义：说明库是空的）。
       * 「复习」显示待复习数量，0 时不显示徽章 —— 没有待办就不该有标记。
       */
      setOverviewCounts({
        sources: 0,
        board: 0,
        ...(o.dueCount > 0 ? { review: o.dueCount } : {}),
      });
    } catch {
      setOverviewCounts({});
    }
  }, [reviewService, cardPool]);

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
      connected={connected}
      libraryName="openleaner"
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
      ) : page === 'today' ? (
        <TodayPage
          key={poolKey}
          service={reviewService}
          cardPool={cardPool}
          hasSources={hasSources}
          connected={connected}
          modelName={modelName}
          onOpenSources={() => setPage('sources')}
          onStartReview={() => setPage('review')}
          onStartNew={() => setPage('generate')}
          onOpenGenerate={() => setPage('generate')}
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
        这一页还在重做中。现在能用的是「学习库」—— 打开就能看到今天该复习什么。
      </p>
      <button type="button" className="btn-ghost" onClick={onBack}>
        回到学习库
      </button>
    </div>
  );
}
