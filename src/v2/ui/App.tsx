import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import { AppShell } from './AppShell.tsx';
import { TodayPage } from './TodayPage.tsx';
import type { PageId } from './pages.ts';
import './tokens.css';
import './shell.css';
import './paper.css';
import './today-page.css';

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
  /** 当前资料库里的全部卡片 id */
  cardPool: readonly string[];
  hasSources: boolean;
}

export function App({ reviewService, cardPool, hasSources }: AppProps) {
  const [page, setPage] = useState<PageId>('today');
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
      setOverviewCounts(o.dueCount > 0 ? { review: o.dueCount } : {});
    } catch {
      setOverviewCounts({});
    }
  }, [reviewService, cardPool]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  const navigate = useCallback((id: PageId) => {
    setPage(id);
  }, []);

  // 卡片池是数组，每次渲染都可能是新引用 —— 用内容做 key 避免无谓重算
  const poolKey = useMemo(() => cardPool.join(','), [cardPool]);

  return (
    <AppShell current={page} onNavigate={navigate} counts={overviewCounts}>
      {page === 'today' ? (
        <TodayPage
          key={poolKey}
          service={reviewService}
          cardPool={cardPool}
          hasSources={hasSources}
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
    today: '今日',
    sources: '资料',
    generate: '创建题组',
    review: '复习',
    wrongbook: '错题与待巩固',
    stats: '学习统计',
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
        这一页还在重做中。现在能用的是「今日」—— 打开就能看到今天该复习什么。
      </p>
      <button type="button" className="btn-ghost" onClick={onBack}>
        回到今日
      </button>
    </div>
  );
}
