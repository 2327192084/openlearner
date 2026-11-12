import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import { masteryLabel, todayLocal } from '@/v2/core/srs.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { CardLoader } from './cards-loader.ts';
import {
  dueRows,
  reviewedRows,
  todayDetailEmpty,
  type TodayRow,
} from '@/v2/core/stats-today.ts';
import { TodayDetail } from './TodayDetail.tsx';

/**
 * 统计页。
 *
 * ## 按截图的设计取向
 *
 * 极简、非仪表盘：
 *  - 左侧一个超大数字（连续天数），配小字说明
 *  - 右侧 12 周热力图（朱砂色阶）
 *  - 底部掌握度分布（五档横条）
 *
 * 刻意**不做**等权重统计卡片矩阵 —— 那种布局每张卡一样大，
 * 用户找不到重点在哪。这一页只回答一个问题：我在往前走吗？
 */

export interface StatsPageProps {
  service: ReviewService;
  cardPool: readonly string[];
  /**
   * 读全部卡片。今日明细要显示题干，必须拿到 Card 本体。
   *
   * 为什么不在页面加载时就读：这一页的主体是概览（连续天数、热力图、
   * 分布），明细是用户点开才看的东西。为了一个可能不点开的面板去读
   * 一遍全库题目，会让打开统计页明显变慢。所以按需读，见 `openDetail`。
   */
  loadCards: CardLoader;
}

interface Dist {
  unlearned: number;
  weak: number;
  learning: number;
  familiar: number;
  mastered: number;
}

const DIST_META: { key: keyof Dist; label: string; cls: string }[] = [
  { key: 'unlearned', label: '未学', cls: 'unlearned' },
  { key: 'weak', label: '薄弱', cls: 'weak' },
  { key: 'learning', label: '学习中', cls: 'learning' },
  { key: 'familiar', label: '熟悉', cls: 'familiar' },
  { key: 'mastered', label: '已掌握', cls: 'mastered' },
];

export function StatsPage({ service, cardPool, loadCards }: StatsPageProps) {
  const [streak, setStreak] = useState<number | null>(null);
  const [cells, setCells] = useState<{ day: string; count: number }[] | null>(null);
  const [dist, setDist] = useState<Dist | null>(null);
  const [overview, setOverview] = useState<{ dueCount: number; doneToday: number; avgMastery: number; totalCards: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 今日明细的口数据。
   *
   * `open` 用一个状态而不是两个（比如 open + loading）来控制面板显示 ——
   * 面板要先出来，再在里面显示「正在读…」，否则用户点一下没反应，
   * 会以为按钮又是假的（这个项目刚因为假按钮被投诉过一次）。
   */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [doneRows, setDoneRows] = useState<TodayRow[] | null>(null);
  const [dueRowsList, setDueRowsList] = useState<TodayRow[] | null>(null);
  const [cardMap, setCardMap] = useState<ReadonlyMap<string, Card>>(new Map());

  const load = useCallback(async () => {
    try {
      const [s, h, d, o] = await Promise.all([
        service.streakDays(),
        service.heatmap(12),
        service.masteryDistribution(cardPool),
        service.todayOverview(cardPool),
      ]);
      setStreak(s);
      setCells(h);
      setDist(d);
      setOverview({
        dueCount: o.dueCount,
        doneToday: o.doneToday,
        avgMastery: o.avgMastery,
        totalCards: o.totalCards,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出统计数据');
    }
  }, [service, cardPool]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 读今日明细。
   *
   * 三份数据一次读完（题目 / 日志 / 待复习 id），全部来自同一时刻 ——
   * 分三次读的话，中途用户可能刚好复习完一张，明细里的行会和上面
   * 概览的数字对不上（项目里「同一屏的数字必须来自同一个池子」
   * 那条教训）。
   */
  const loadDetail = useCallback(async () => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const day = todayLocal();
      const [cards, logs, dueIds] = await Promise.all([
        loadCards(),
        service.listLogs(),
        service.dueCards(cardPool),
      ]);
      const byId = new Map(cards.map((c) => [c.id, c]));
      const records = await service.getRecords(dueIds);
      setCardMap(byId);
      setDoneRows(reviewedRows(logs, day, byId));
      setDueRowsList(dueRows(dueIds, records, byId, day));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '读不出今日明细');
    } finally {
      setDetailLoading(false);
    }
  }, [service, cardPool, loadCards]);

  const toggleDetail = useCallback(() => {
    setDetailOpen((prev) => {
      const next = !prev;
      // 第一次打开（或上次读失败）时去读；已读成功过就直接复用，
      // 免得反复点开关都打一次全库
      if (next && doneRows === null) void loadDetail();
      return next;
    });
  }, [doneRows, loadDetail]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  /*
   * 展开之后把面板滚进视口（2026-11-13）。
   *
   * 为什么需要：今日栏在整页最底部（截图量过：1440×900 下
   * 面板展开后整块落在视口外）。用户点一下，只看到「看明细」
   * 变成「收起」，内容一个字也没看见 —— 那和之前那个假按钮
   * 给他的感受是一样的。
   *
   * 用 `block: 'nearest'`：已经完整可见时什么都不做，
   * 不做那种「点一下页面就跳」的多余动作。
   */
  useEffect(() => {
    if (!detailOpen) return;
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [detailOpen]);

  /*
   * 概览数字变了（比如刚复习完回来）就把明细作废，下次打开重读。
   * 不这样做的话，明细会停在旧数据上，和上面的数字打架。
   */
  const doneToday = overview?.doneToday ?? 0;
  useEffect(() => {
    setDoneRows(null);
    setDueRowsList(null);
  }, [doneToday]);

  if (error) {
    return (
      <div className="stats-page">
        <h1 className="stats-h1">学习统计</h1>
        <div className="stats-error">
          {error}
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (streak === null || !cells || !dist || !overview) {
    return (
      <div className="stats-page">
        <h1 className="stats-h1">学习统计</h1>
        <p className="stats-lead">正在读取…</p>
      </div>
    );
  }

  const maxCount = Math.max(1, ...cells.map((c) => c.count));
  const activeDays = cells.filter((c) => c.count > 0).length;
  const totalReviews = cells.reduce((n, c) => n + c.count, 0);
  const distTotal = DIST_META.reduce((n, m) => n + dist[m.key], 0);

  return (
    <div className="stats-page">
      <h1 className="stats-h1">学习统计</h1>

      {/* ---- 主区：超大连续天数 + 热力图 ---- */}
      <div className="stats-grid">
        {/* 左：连续天数 */}
        <div className="stats-streak">
          <div className="stats-streak__num">{streak}</div>
          <div className="stats-streak__label">天连续学习</div>
          <div className="stats-streak__meta">
            {activeDays} 个活跃日 · 累计复习 {totalReviews} 次
          </div>
          <div className="stats-streak__meta">
            到期待复习 <strong>{overview.dueCount}</strong> 张
          </div>
        </div>

        {/* 右：12 周热力图 */}
        <div className="stats-heat">
          <div className="stats-heat__label">近 12 周</div>
          <div className="stats-heat__grid" role="img" aria-label="近 12 周复习热力图">
            {cells.map((c) => {
              /*
               * 五档色阶。用 0 与最大值之间的相对位置分档，
               * 而不是固定阈值 —— 数据量差别很大时固定阈值会全落在一档。
               */
              const level =
                c.count === 0 ? 0 : Math.min(5, 1 + Math.floor((c.count / maxCount) * 4));
              return (
                <div
                  key={c.day}
                  className={`heat-cell heat-cell--${level}`}
                  title={`${c.day}：${c.count} 次`}
                />
              );
            })}
          </div>
          <div className="stats-heat__legend">
            <span>少</span>
            {[0, 1, 2, 3, 4, 5].map((l) => (
              <span key={l} className={`heat-cell heat-cell--${l}`} />
            ))}
            <span>多</span>
          </div>
        </div>
      </div>

      {/* ---- 掌握度分布 ---- */}
      <div className="stats-dist">
        <div className="stats-dist__head">
          <span className="stats-dist__title">掌握度分布</span>
          <span className="stats-dist__avg">
            整体 {Math.round(overview.avgMastery * 100)}% · {masteryLabel(overview.avgMastery)}
          </span>
        </div>

        {distTotal === 0 ? (
          <p className="stats-lead">还没有复习记录。去「复习」做几张，这里就会有数据。</p>
        ) : (
          <>
            {/* 堆叠条：一眼看出比例 */}
            <div className="dist-bar">
              {DIST_META.map((m) =>
                dist[m.key] > 0 ? (
                  <div
                    key={m.key}
                    className={`dist-bar__seg dist-bar__seg--${m.cls}`}
                    style={{ flex: dist[m.key] }}
                    title={`${m.label} ${dist[m.key]} 张`}
                  />
                ) : null,
              )}
            </div>

            {/* 明细：五档各多少张 */}
            <div className="dist-rows">
              {DIST_META.map((m) => (
                <div key={m.key} className="dist-row">
                  <span className={`dist-dot dist-dot--${m.cls}`} aria-hidden="true" />
                  <span className="dist-row__label">{m.label}</span>
                  <span className="dist-row__n">{dist[m.key]}</span>
                </div>
              ))}
            </div>

            {/*
              「已掌握」的门槛要写出来（2026-11-08）。

              为什么必须有这行：上一轮把「已掌握」从「分数 >= 0.8」改成
              「间隔 >= 21 天 且 连续答对 >= 2 且 分数 >= 0.85」之后，
              用户看到的数字会比以前小。不解释原因的话，他会以为
              「我明明练熟了，怎么掉下来了」—— 那是界面在偷偷改规则。

              措辞用「要同时满足」，把三条都列出来，不藏。
            */}
            <p className="dist-note">
              「已掌握」要同时满足：距下次复习还有 21 天以上、连续答对 2 次以上、
              熟练度 85% 以上。只看分数会让「蒙对一次」也被算成掌握，所以加了前两条。
            </p>
          </>
        )}
      </div>

      {/* ---- 今日情况：整条可点开看明细 ---- */}
      <div className="stats-today">
        <button
          type="button"
          className={`stats-today__toggle${detailOpen ? ' stats-today__toggle--on' : ''}`}
          onClick={toggleDetail}
          aria-expanded={detailOpen}
          title="点开看今天具体做了哪几张、还差哪几张"
        >
          <span className="stats-today__label">今天</span>
          <span className="stats-today__item">已复习 {overview.doneToday} 张</span>
          <span className="stats-today__item">待复习 {overview.dueCount} 张</span>
          <span className="stats-today__item">总卡片 {overview.totalCards} 张</span>
          <span className="stats-today__more">{detailOpen ? '收起' : '看明细'} ›</span>
        </button>

        {detailOpen ? (
          <div className="stats-today__panel" ref={panelRef}>
            {detailLoading ? (
              <p className="stats-lead">正在读今天的记录…</p>
            ) : detailError ? (
              <div className="stats-error">
                {detailError}
                <button type="button" className="btn-ghost" onClick={() => void loadDetail()}>
                  重试
                </button>
              </div>
            ) : doneRows && dueRowsList ? (
              <TodayDetail
                done={doneRows}
                due={dueRowsList}
                cards={cardMap}
                emptyDone={todayDetailEmpty('done')}
                emptyDue={todayDetailEmpty('due')}
              />
            ) : (
              <p className="stats-lead">正在读今天的记录…</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
