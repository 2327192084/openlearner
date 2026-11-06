import { useCallback, useEffect, useState } from 'react';
import type { ReviewService, TodayOverview } from '@/v2/core/review-service.ts';
import { masteryLabel } from '@/v2/core/srs.ts';

/**
 * 今日页 —— 「打开就知道该干什么」。
 *
 * ## 布局参照 StudyHub 的学习库首页
 *
 * 左栏是进度与推荐（宽，1fr），右栏是一叠纸张卡片（窄，340px）。
 * 纸张卡是整页唯一的「实体」，其余都是桌面上的字。
 *
 * 刻意不做等权重统计卡片矩阵 ——
 * 那种布局每张卡一样大，用户找不到重点在哪。
 */

export interface TodayPageProps {
  service: ReviewService;
  /** 当前资料库里的全部卡片 id */
  cardPool: readonly string[];
  onStartReview: () => void;
  onStartNew: () => void;
  onOpenSources: () => void;
  hasSources: boolean;
}

export function TodayPage({
  service,
  cardPool,
  onStartReview,
  onStartNew,
  onOpenSources,
  hasSources,
}: TodayPageProps) {
  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await service.todayOverview(cardPool);
      setOverview(o);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出复习进度');
    }
  }, [service, cardPool]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 没有资料：引导，而不是显示一堆 0 ----
  if (!hasSources) {
    return (
      <div className="today-grid">
        <div>
          <h1 className="today__h1">开始学习</h1>
          <p className="today__lead">
            还没有资料。先导入一份课件或教材，之后就能从中出题，并按遗忘规律安排复习。
          </p>
          <button type="button" className="btn-fill" onClick={onOpenSources}>
            去导入资料
            <span className="btn-fill__arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="today-grid">
        <div>
          <h1 className="today__h1">今日</h1>
          <p className="today__lead today__lead--bad">{error}</p>
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="today-grid">
        <div>
          <h1 className="today__h1">今日</h1>
          <p className="today__lead">正在读取…</p>
        </div>
      </div>
    );
  }

  const nothingToDo = overview.dueCount === 0 && overview.freshCount === 0;

  return (
    <div className="today-grid">
      {/* ---------- 左栏：进度与下一步 ---------- */}
      <div className="today-main">
        <h1 className="today__h1">
          今日
          <span className="today__date">{new Date().toLocaleDateString('zh-CN')}</span>
        </h1>

        {/* 掌握度：细条 + 百分比，这是「看得见变熟」的主入口 */}
        <div className="today__mastery">
          <MasteryBar value={overview.avgMastery} />
          <span className="today__mastery-label">
            {masteryLabel(overview.avgMastery)} · 已学 {overview.learnedCards}/{overview.totalCards}
          </span>
        </div>

        {/* 推荐下一步：一句话说清现在该做什么 */}
        <div className="today__next">
          {overview.dueCount > 0 ? (
            <>
              <div className="today__next-title">
                有 {overview.dueCount} 张卡片到期待复习
              </div>
              <div className="today__next-hint">按遗忘曲线排的，逾期越久越靠前</div>
            </>
          ) : overview.freshCount > 0 ? (
            <>
              <div className="today__next-title">今天没有到期的，可以学 {overview.freshCount} 张新卡</div>
              <div className="today__next-hint">每天最多 20 张，避免明天堆积</div>
            </>
          ) : (
            <>
              <div className="today__next-title">今天的任务都完成了</div>
              <div className="today__next-hint">休息一下，明天再来</div>
            </>
          )}
        </div>

        {/* 今天的实况：四个数字，等宽对齐但不等权重 */}
        <div className="today__stats">
          <Stat label="今天已复习" value={`${overview.doneToday}`} unit="张" />
          <Stat
            label="今天的正确率"
            value={
              overview.accuracyToday === null
                ? '—'
                : `${Math.round(overview.accuracyToday * 100)}`
            }
            unit={overview.accuracyToday === null ? '' : '%'}
          />
          <Stat label="到期" value={`${overview.dueCount}`} unit="张" />
          <Stat label="可学新卡" value={`${overview.freshCount}`} unit="张" />
        </div>

        {nothingToDo ? (
          <p className="today__done">今天的学习任务已完成。明天再来。</p>
        ) : null}

        {/*
          下方补充说明。不是装饰 —— 第一次用的人需要知道
          「这些卡片从哪来、为什么这么排」，否则「9 张可学」
          是个没有上下文的数字。
        */}
        <div className="today__explain">
          <h2 className="today__explain-title">这些卡片从哪来</h2>
          <ol className="today__steps">
            <li>
              <span className="today__step-n">1</span>
              在「资料」里导入课件或教材
            </li>
            <li>
              <span className="today__step-n">2</span>
              在「出题」里让 AI 读资料，生成题目与知识点
            </li>
            <li>
              <span className="today__step-n">3</span>
              每天回到这里，按遗忘曲线复习到期的那几张
            </li>
          </ol>
          <p className="today__explain-note">
            每张卡片都带原文出处，答题时可以随时翻回资料原页对照。
          </p>
        </div>
      </div>

      {/* ---------- 右栏：纸张卡片叠 ---------- */}
      <div className="today-stack">
        <div className="paper">
          <div className="paper__eyebrow">下一步</div>
          {overview.dueCount > 0 ? (
            <>
              <div className="paper__big">{overview.dueCount}</div>
              <div className="paper__unit">张待复习</div>
              <div className="paper__dim paper__note">
                做完这一轮，大约 5 分钟
              </div>
              <button type="button" className="btn-fill" onClick={onStartReview}>
                开始复习
                <span className="btn-fill__arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </>
          ) : overview.freshCount > 0 ? (
            <>
              <div className="paper__big">{overview.freshCount}</div>
              <div className="paper__unit">张可学</div>
              <div className="paper__dim paper__note">还没学过的内容</div>
              <button type="button" className="btn-fill" onClick={onStartNew}>
                学新内容
                <span className="btn-fill__arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </>
          ) : (
            <>
              <div className="paper__big paper__big--muted">✓</div>
              <div className="paper__unit">今天清空了</div>
              <div className="paper__dim paper__note">明天会有新的到期卡片</div>
              <button type="button" className="btn-fill" disabled>
                已完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 熟练度细条（4px 五段配色） */
function MasteryBar({ value }: { value: number }) {
  // 按掌握度映射到段数：0 → 全灰；1 → 全绿
  const filled = Math.round(value * 5);

  /**
   * 0% 时不画分段条，改画一条明确的空槽。
   *
   * 早先直接用五段灰色 —— 平视时看起来就是一条虚线分隔线，
   * 用户根本不会认为那是「进度」。空槽 + 文字说明才读得出
   * 「这里本来会有进度，但还没开始」。
   */
  if (value === 0) {
    return (
      <div className="mastery">
        <div className="mastery__empty" />
        <span className="mastery__pct mastery__pct--zero">未开始</span>
      </div>
    );
  }

  const segs = [0, 1, 2, 3, 4].map((i) => {
    if (i >= filled) return 'unlearned';
    if (filled <= 2) return 'weak';
    if (filled === 3) return 'learning';
    if (filled === 4) return 'familiar';
    return 'mastered';
  });

  return (
    <div className="mastery">
      <div className="mastery__bar">
        {segs.map((kind, i) => (
          <div key={i} className={`mastery__seg mastery__seg--${kind}`} style={{ flex: 1 }} />
        ))}
      </div>
      <span className="mastery__pct">{Math.round(value * 100)}%</span>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </div>
    </div>
  );
}
