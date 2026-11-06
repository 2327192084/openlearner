import { useCallback, useEffect, useState } from 'react';
import type { ReviewService, TodayOverview } from '@/v2/core/review-service.ts';
import { masteryLabel } from '@/v2/core/srs.ts';
import { IconCheck, IconUpload } from './icons.tsx';

/**
 * 学习库首页。
 *
 * 按截图还原两种状态：
 *  1. **首次使用**：欢迎 + 编号步骤引导（② 添加资料 ③ 用资料出题）
 *  2. **已有资料**：今日概览（掌握度、待复习、纸张卡片）
 *
 * 为什么要有两种状态：新用户打开看到一堆 0 会不知道从哪开始；
 * 截图里那个「添加一份资料」的引导才是正确的第一屏。
 */

export interface TodayPageProps {
  service: ReviewService;
  cardPool: readonly string[];
  hasSources: boolean;
  /** 是否已接入模型 */
  connected: boolean;
  /** 已接入的模型名，如 "Qoder (中国版) · DeepSeek-Flash - x0.1" */
  modelName?: string | null;
  onStartReview: () => void;
  onStartNew: () => void;
  onOpenSources: () => void;
}

export function TodayPage({
  service,
  cardPool,
  hasSources,
  connected,
  modelName,
  onStartReview,
  onStartNew,
  onOpenSources,
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

  // ==================== 首次使用：欢迎引导 ====================
  if (!hasSources) {
    return (
      <div className="welcome">
        <div className="welcome__eyebrow">开始使用</div>
        <h1 className="welcome__title">欢迎使用 OpenLeaner</h1>
        <p className="welcome__lead">
          把老师的课件变成题，每道题都点得回原页；做完一轮，看得见自己变熟。
        </p>
        <p className="welcome__sub">
          开源免费，资料存在你电脑上；模型自己选，按用量付费。
        </p>

        {/* 连接状态条 */}
        <div className={`welcome__conn${connected ? ' welcome__conn--on' : ''}`}>
          <span className="welcome__conn-icon" aria-hidden="true">
            <IconCheck size={14} />
          </span>
          {connected ? (
            <>已连接：{modelName ?? '模型'}</>
          ) : (
            <>还没接入模型 —— 去「设置」里添加一个就能开始出题</>
          )}
        </div>

        <ol className="welcome__steps">
          {/* 步骤 2：添加资料（第 1 步「接模型」由上面的连接条承载） */}
          <li className="wstep">
            <span className="wstep__n">2</span>
            <div className="wstep__body">
              <div className="wstep__title">添加一份资料：讲义、课件或笔记</div>
              <p className="wstep__desc">
                PDF、Word、PowerPoint、Markdown、保存下来的网页文件（.html）或文本都可以。
                原文件会保留，添加后就能用它出题。
              </p>
              <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenSources}>
                <IconUpload size={15} />
                添加资料
              </button>
            </div>
          </li>

          {/* 步骤 3：用资料出题 */}
          <li className="wstep">
            <span className="wstep__n">3</span>
            <div className="wstep__body">
              <div className="wstep__title">用资料出一组题</div>
              <p className="wstep__desc">
                选好资料，AI 读原文后出题，每道题都标出出处。出之前会先告诉你要花多少。
              </p>
            </div>
          </li>
        </ol>

        <div className="welcome__foot">
          {/*
            这里原来有两个 btn-text：「想先看看效果？载入示例并开始导览」和「以后再说」。
            两个都是坏按钮：
              - 第一个说「载入示例」，但它只是跳去出题页，一个示例都没有真的载入；
              - 第二个说「以后再说」，点了也只是重新读一遍概览，引导根本没有关掉。
            用户的约束是「不做假开关」——说要做 A 却做了 B 比没有更糟。
            现在换成两句真话：一句指向当前唯一能走的下一步。
          */}
          <span className="welcome__foot-note">
            这个库还是空的。按上面的顺序走一遍，之后每次打开都会直接看到今天该复习什么。
          </span>
        </div>
      </div>
    );
  }

  // ==================== 已有资料：今日概览 ====================
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
      <div className="today-main">
        <h1 className="today__h1">
          今日
          <span className="today__date">{new Date().toLocaleDateString('zh-CN')}</span>
        </h1>

        <div className="today__mastery">
          <MasteryBar value={overview.avgMastery} />
          <span className="today__mastery-label">
            {masteryLabel(overview.avgMastery)} · 已学 {overview.learnedCards}/{overview.totalCards}
          </span>
        </div>

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
              <div className="today__next-title">
                今天没有到期的，可以学 {overview.freshCount} 张新卡
              </div>
              <div className="today__next-hint">每天最多 20 张，避免明天堆积</div>
            </>
          ) : (
            <>
              <div className="today__next-title">今天的任务都完成了</div>
              <div className="today__next-hint">休息一下，明天再来</div>
            </>
          )}
        </div>

        <div className="today__stats">
          <Stat label="今天已复习" value={`${overview.doneToday}`} unit="张" />
          <Stat
            label="今天的正确率"
            value={
              overview.accuracyToday === null ? '—' : `${Math.round(overview.accuracyToday * 100)}`
            }
            unit={overview.accuracyToday === null ? '' : '%'}
          />
          <Stat label="到期" value={`${overview.dueCount}`} unit="张" />
          <Stat label="可学新卡" value={`${overview.freshCount}`} unit="张" />
        </div>

        {nothingToDo ? (
          <p className="today__done">今天的学习任务已完成。明天再来。</p>
        ) : null}

        <div className="today__explain">
          <h2 className="today__explain-title">这些卡片从哪来</h2>
          <ol className="today__steps">
            <li>
              <span className="today__step-n">1</span>
              在「资料」里导入课件或教材
            </li>
            <li>
              <span className="today__step-n">2</span>
              在「创建题组」里让 AI 读资料，生成题目与知识点
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

      <div className="today-stack">
        <div className="paper">
          <div className="paper__eyebrow">下一步</div>
          {overview.dueCount > 0 ? (
            <>
              <div className="paper__big">{overview.dueCount}</div>
              <div className="paper__unit">张待复习</div>
              <div className="paper__dim paper__note">做完这一轮，大约 5 分钟</div>
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

function MasteryBar({ value }: { value: number }) {
  const filled = Math.round(value * 5);

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
