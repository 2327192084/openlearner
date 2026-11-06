import { useCallback, useEffect, useState } from 'react';
import type { ReviewService, TodayOverview } from '@/v2/core/review-service.ts';
import { masteryLabel } from '@/v2/core/srs.ts';

/**
 * 今日概览面板 —— 「打开就知道今天该干什么」。
 *
 * ## 为什么这是界面层第一块
 *
 * 它只读复习引擎的产出，不写数据、不依赖其他界面。
 * 实现量小，但它把「间隔复习」这个看不见的机制变成了
 * 用户每天看得见的三件事：该复习几张、可以学几张、今天做得怎样。
 *
 * ## 设计取舍
 *
 * 不做成图表仪表盘。备考用户打开软件时只想知道
 * 「现在开始做什么」，不需要看曲线。趋势图放在次级位置。
 *
 * 数字必须来自同一时刻的快照 —— 早先的功能里出现过
 * 「显示到期 5 张但列表只有 3 张」这类矛盾，用户会觉得软件在乱报。
 */

export interface TodayPanelProps {
  service: ReviewService;
  /** 当前资料库里的全部卡片 id（题目 + 知识点） */
  cardPool: readonly string[];
  /** 点「开始复习」 */
  onStartReview: () => void;
  /** 点「学新内容」 */
  onStartNew: () => void;
  /** 是否已有资料（没有资料时显示引导而不是空数字） */
  hasSources: boolean;
  /** 回调：打开资料库 */
  onOpenSources: () => void;
}

export function TodayPanel({
  service,
  cardPool,
  onStartReview,
  onStartNew,
  hasSources,
  onOpenSources,
}: TodayPanelProps) {
  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const [trend, setTrend] = useState<{ day: string; count: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // 一次取两样，保证数字与趋势是同一时刻的
      const [o, t] = await Promise.all([
        service.todayOverview(cardPool),
        service.recentActivity(7),
      ]);
      setOverview(o);
      setTrend(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出复习进度');
    }
  }, [service, cardPool]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 没有资料：引导去做第一步，而不是显示一堆 0 ----
  if (!hasSources) {
    return (
      <section className="today">
        <h2 className="today__title">开始学习</h2>
        <p className="today__lead">
          还没有资料。先导入一份课件或教材，之后就能从中出题并按遗忘规律复习。
        </p>
        <button type="button" className="btn btn--primary" onClick={onOpenSources}>
          去导入资料
        </button>
      </section>
    );
  }

  if (error) {
    return (
      <section className="today">
        <h2 className="today__title">今日</h2>
        <div className="today__error">
          {error}
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  if (!overview) {
    return (
      <section className="today">
        <h2 className="today__title">今日</h2>
        <p className="today__lead">正在读取…</p>
      </section>
    );
  }

  const nothingToDo = overview.dueCount === 0 && overview.freshCount === 0;
  const maxTrend = Math.max(1, ...(trend ?? []).map((t) => t.count));

  return (
    <section className="today">
      <h2 className="today__title">
        今日
        <span className="today__date">{new Date().toLocaleDateString('zh-CN')}</span>
      </h2>

      {/*
        主区只放两个数字：该复习的、可以学的。
        第三个数字（已学总数）放次级 —— 用户此刻不需要它。
      */}
      <div className="today__cards">
        <div className="today__card today__card--primary">
          <div className="today__card-label">待复习</div>
          <div className="today__card-value">{overview.dueCount}</div>
          <div className="today__card-hint">
            {overview.dueCount > 0 ? '按遗忘曲线排的，逾期越久越靠前' : '今天没有到期的'}
          </div>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onStartReview}
            disabled={overview.dueCount === 0}
          >
            开始复习
          </button>
        </div>

        <div className="today__card">
          <div className="today__card-label">可学新内容</div>
          <div className="today__card-value">{overview.freshCount}</div>
          <div className="today__card-hint">
            {overview.freshCount > 0 ? '每天最多 20 张，避免堆积' : '全部内容都学过了'}
          </div>
          <button
            type="button"
            className="btn"
            onClick={onStartNew}
            disabled={overview.freshCount === 0}
          >
            学新内容
          </button>
        </div>
      </div>

      {nothingToDo ? (
        <p className="today__lead today__lead--done">
          今天的学习任务都完成了。休息一下，明天再来。
        </p>
      ) : null}

      {/* ---- 今天的情况 ---- */}
      <div className="today__stats">
        <div className="today__stat">
          <span className="today__stat-label">今天已复习</span>
          <span className="today__stat-value">{overview.doneToday} 张</span>
        </div>
        <div className="today__stat">
          <span className="today__stat-label">今天的正确率</span>
          <span className="today__stat-value">
            {/*
              没有复习记录时显示「—」而不是 0% ——
              0% 会让用户以为全错，那是错误信息。
            */}
            {overview.accuracyToday === null
              ? '—'
              : `${Math.round(overview.accuracyToday * 100)}%`}
          </span>
        </div>
        <div className="today__stat">
          <span className="today__stat-label">整体熟练度</span>
          <span className="today__stat-value">
            {Math.round(overview.avgMastery * 100)}%
            <span className="today__stat-note">{masteryLabel(overview.avgMastery)}</span>
          </span>
        </div>
        <div className="today__stat">
          <span className="today__stat-label">已学 / 总数</span>
          <span className="today__stat-value">
            {overview.learnedCards} / {overview.totalCards}
          </span>
        </div>
      </div>

      {/* ---- 近 7 天趋势：极简柱状，不做图表库 ---- */}
      {trend && trend.some((t) => t.count > 0) ? (
        <div className="today__trend">
          <div className="today__trend-label">近 7 天复习量</div>
          <div className="today__bars">
            {trend.map((t) => (
              <div key={t.day} className="today__bar-wrap" title={`${t.day}：${t.count} 张`}>
                <div
                  className="today__bar"
                  style={{ height: `${Math.max(2, (t.count / maxTrend) * 100)}%` }}
                />
                <div className="today__bar-day">{t.day.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
