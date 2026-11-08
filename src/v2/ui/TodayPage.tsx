/**
 * 学习库首页 —— 「每次打开先看这里：今天的安排、各门课的进度、最近在练的题」。
 *
 * ## 为什么重写（2026-11-07 用户反馈）
 *
 * 用户对照「功能导览」里对这一页的描述，发现实际界面讲的是别的事情：
 * 导览说「今天的安排 / 各门课的进度 / 最近在练的题」，而界面给的是
 * 「这些卡片从哪来」的三步说明 —— 那是**新手引导**，不是每天要看的仪表盘。
 *
 * 三步说明属于「第一次使用时讲一遍」，所以它挪到了 `!hasSources` 的分支里
 * （新用户仍然看得到），有资料之后这一页改成真正的概览。
 *
 * ## 三块内容的来源（全部只读，不新增存储）
 *
 * | 区块 | 数据来源 |
 * | --- | --- |
 * | 今天的安排 | `todayOverview`：到期 / 可学 / 今天已做 / 正确率 |
 * | 各门课的进度 | `buildStudyMap`：按**资料 → 章节**汇总掌握度（`courses` 目前是空的） |
 * | 最近在练的题 | `reviewLogs` 里最近几天做过、或答错的题 |
 *
 * 「各门课的进度」在数据里叫 course，但当前库一门课都没有，
 * 真正的归属维度是**资料**（`anchors[].sourceId`）与**章节**。
 * 所以标题写「资料进度」——不写一个界面上根本不存在的概念。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewService, TodayOverview } from '@/v2/core/review-service.ts';
import { masteryLabel } from '@/v2/core/srs.ts';
import { mapLabel, weakestChapter, type StudyMap } from '@/v2/core/study-map.ts';
import type { Card } from '@/v2/core/cards.ts';
import { recentDecksOf, type RecentDeck } from './recent-decks.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { CardLoader } from './cards-loader.ts';
import { buildSnapshot, type StudySnapshot } from './study-snapshot.ts';
import { IconCheck, IconUpload } from './icons.tsx';

export interface TodayPageProps {
  service: ReviewService;
  cardPool: readonly string[];
  hasSources: boolean;
  /** 是否已接入模型 */
  connected: boolean;
  /** 已接入的模型名 */
  modelName?: string | null;
  /** 打开「我的题组」 */
  onOpenDecks: () => void;
  /** 打开「我的题组」并展开指定题组 */
  onOpenDeck: (deckId: string) => void;
  /** 去「资料」页 */
  onOpenSources: () => void;
  /** 开始今日题组 */
  onStartReview: () => void;
  /** 打开学习地图（原「学习流」） */
  onOpenMap: () => void;
  /** 打开错题页 */
  onOpenWrongBook: () => void;
  /* ---- 装配学习地图需要的东西 ---- */
  loadCards: CardLoader;
  decks: DeckService;
  knowledge: KnowledgeService;
  sourceService: SourceService;
}

/** 错题预览一项 */
interface WrongPreview {
  card: Card;
  wrongCount: number;
  lastWrongDay: string;
}

export function TodayPage(props: TodayPageProps) {
  const {
    service,
    cardPool,
    hasSources,
    connected,
    modelName,
    onOpenDecks,
    onOpenDeck,
    onOpenSources,
    onStartReview,
    onOpenMap,
    onOpenWrongBook,
    loadCards,
    decks,
    knowledge,
    sourceService,
  } = props;

  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [recentDecks, setRecentDecks] = useState<RecentDeck[]>([]);
  const [wrongPreview, setWrongPreview] = useState<WrongPreview[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);

      const [o, sources] = await Promise.all([service.todayOverview(cardPool), sourceService.list()]);
      setOverview(o);

      const titleById = new Map(sources.map((s) => [s.id, s.title]));

      const [snap, logs, wrongRows, deckList] = await Promise.all([
        buildSnapshot({
          loadCards,
          decks,
          knowledge,
          reviewService: service,
          sourceTitleOf: (id) => titleById.get(id) ?? null,
          today,
        }),
        service.listLogs(),
        service.wrongCardsDetailed(),
        decks.list(),
      ]);

      setSnapshot(snap);
      /*
       * 错题数按题组统计：错题明细里每条都有 cardId，
       * 而卡片上有 deckId —— 一次遍历就够，不必再查库。
       */
      const wrongByDeck = new Map<string, number>();
      for (const w of wrongRows) {
        const card = snap.cardById.get(w.cardId);
        if (!card) continue;
        wrongByDeck.set(card.deckId, (wrongByDeck.get(card.deckId) ?? 0) + 1);
      }
      setRecentDecks(recentDecksOf(logs, snap.cardById, deckList, wrongByDeck));
      setWrongPreview(
        wrongRows
          .map((w) => {
            const card = snap.cardById.get(w.cardId);
            return card
              ? { card, wrongCount: w.wrongCount, lastWrongDay: w.lastWrongDay }
              : null;
          })
          .filter((x): x is WrongPreview => x !== null)
          .slice(0, 5),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出复习进度');
    }
  }, [service, cardPool, loadCards, decks, knowledge, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ==================== 首次使用：欢迎引导 ==================== */
  if (!hasSources) {
    return (
      <div className="welcome">
        <div className="welcome__eyebrow">开始使用</div>
        <h1 className="welcome__title">欢迎使用 OpenLeaner</h1>
        <p className="welcome__lead">
          把老师的课件变成题，每道题都点得回原页；做完一轮，看得见自己变熟。
        </p>
        <p className="welcome__sub">开源免费，资料存在你电脑上；模型自己选，按用量付费。</p>

        <div className={`welcome__conn${connected ? ' welcome__conn--on' : ''}`}>
          <span className="welcome__conn-icon" aria-hidden="true">
            <IconCheck size={14} />
          </span>
          {connected ? <>已连接：{modelName ?? '模型'}</> : <>还没接入模型 —— 去「设置」里添加一个就能开始出题</>}
        </div>

        <ol className="welcome__steps">
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

          <li className="wstep">
            <span className="wstep__n">3</span>
            <div className="wstep__body">
              <div className="wstep__title">用资料出一组题</div>
              <p className="wstep__desc">
                在「我的题组」里点「新建题组」，AI 读原文后出题，每道题都标出出处。
              </p>
            </div>
          </li>
        </ol>

        <div className="welcome__foot">
          <span className="welcome__foot-note">
            这个库还是空的。按上面的顺序走一遍，之后每次打开都会直接看到今天该复习什么。
          </span>
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

  return (
    <div className="today-grid">
      <div className="today-main">
        <h1 className="today__h1">
          今日
          <span className="today__date">{new Date().toLocaleDateString('zh-CN')}</span>
        </h1>

        {/* ==================== 一、今天的安排 ==================== */}
        <section className="dash-section">
          <h2 className="dash-h2">今天的安排</h2>

          <div className="today__mastery">
            <MasteryBar value={overview.avgMastery} />
            <span className="today__mastery-label">
              {masteryLabel(overview.avgMastery)} · 已学 {overview.learnedCards}/{overview.totalCards}
            </span>
          </div>

          <div className="today__next">
            {overview.dueCount > 0 ? (
              <>
                <div className="today__next-title">有 {overview.dueCount} 张卡片到期待复习</div>
                <div className="today__next-hint">按遗忘曲线排的，逾期越久越靠前</div>
              </>
            ) : overview.freshCount > 0 ? (
              <>
                <div className="today__next-title">今天没有到期的，还有 {overview.freshCount} 张新卡没学过</div>
                <div className="today__next-hint">在「我的题组」里挑一组开始</div>
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
              value={overview.accuracyToday === null ? '—' : `${Math.round(overview.accuracyToday * 100)}`}
              unit={overview.accuracyToday === null ? '' : '%'}
            />
            <Stat label="到期" value={`${overview.dueCount}`} unit="张" />
            <Stat label="没学过" value={`${overview.freshCount}`} unit="张" />
          </div>
        </section>

        {/* ==================== 二、资料进度 ==================== */}
        {snapshot ? (
          <section className="dash-section">
            <h2 className="dash-h2">
              资料进度
              <button type="button" className="dash-more" onClick={onOpenMap}>
                学习地图 →
              </button>
            </h2>
            <SourceProgress map={snapshot.map} onOpenMap={onOpenMap} />
          </section>
        ) : null}

        {/* ==================== 三、最近在练的题组（未完成） ==================== */}
        <section className="dash-section">
          <h2 className="dash-h2">
            最近在练的题组
            <button type="button" className="dash-more" onClick={onOpenDecks}>
              我的题组 →
            </button>
          </h2>
          {recentDecks.length === 0 ? (
            <p className="dash-empty">
              这个库还没练过题。
              <button type="button" className="btn-text" onClick={onOpenDecks}>
                去挑一组开始
              </button>
            </p>
          ) : (
            <ul className="dash-decks">
              {recentDecks.map((d) => (
                <li key={d.deckId}>
                  <button
                    type="button"
                    className="dash-deck"
                    /*
                     * 跳到「我的题组」并展开这一组。
                     * 不直接开始做题：从首页点一下就在没看题的情况下
                     * 掉进做题界面，用户会失去「我在哪」的感觉；
                     * 展开题组能看到题目列表与进度，再决定做不做。
                     */
                    onClick={() => onOpenDeck(d.deckId)}
                  >
                    <span className="dash-deck__title">{d.title}</span>
                    <span className="dash-deck__bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(d.ratio * 100)}%` }} />
                    </span>
                    <span className="dash-deck__meta">
                      练过 {d.done}/{d.total}
                      {d.wrong > 0 ? ` · ${d.wrong} 道错着` : ''}
                    </span>
                    <span className="dash-deck__go" aria-hidden="true">
                      →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ==================== 四、错题（可跳转） ==================== */}
        <section className="dash-section">
          <h2 className="dash-h2">
            错题
            <button type="button" className="dash-more" onClick={onOpenWrongBook}>
              全部错题 →
            </button>
          </h2>
          {wrongPreview.length === 0 ? (
            <p className="dash-empty">
              现在没有错题。做错的题会自动进来，重做答对之后就会从这里消失。
            </p>
          ) : (
            <ul className="dash-recent">
              {wrongPreview.map((w) => (
                <li key={w.card.id}>
                  <button type="button" className="dash-recent__row" onClick={onOpenWrongBook}>
                    <span className="dash-recent__dot dash-recent__dot--wrong" aria-hidden="true" />
                    <span className="dash-recent__prompt">{w.card.prompt}</span>
                    <span className="dash-recent__day">{w.lastWrongDay}</span>
                    <span className="dash-recent__tag">错 {w.wrongCount} 次</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ==================== 右侧：下一步 ==================== */}
      <div className="today-stack">
        <div className="paper">
          <div className="paper__eyebrow">下一步</div>
          {overview.dueCount > 0 ? (
            <>
              <div className="paper__big">{overview.dueCount}</div>
              <div className="paper__unit">张待复习</div>
              <div className="paper__dim paper__note">做完这一轮，看看还剩多少</div>
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
              <div className="paper__unit">张没学过</div>
              <div className="paper__dim paper__note">去「我的题组」挑一组开始练</div>
              <button type="button" className="btn-fill" onClick={onOpenDecks}>
                挑一组开始
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

        {snapshot && snapshot.wrongIds.size > 0 ? (
          <button type="button" className="paper-side" onClick={onOpenWrongBook}>
            <span className="paper-side__n">{snapshot.wrongIds.size}</span>
            <span className="paper-side__label">道错题待巩固 →</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 资料进度：弱的排前面，每行一个掌握度条 */
function SourceProgress({ map, onOpenMap }: { map: StudyMap; onOpenMap: () => void }) {
  const weakest = useMemo(() => weakestChapter(map), [map]);

  if (map.sources.length === 0) {
    return (
      <p className="dash-empty">
        题库里还没有已发布的题。
        <button type="button" className="btn-text" onClick={onOpenMap}>
          去学习地图看看
        </button>
      </p>
    );
  }

  return (
    <>
      <ul className="dash-sources">
        {map.sources.slice(0, 4).map((s) => (
          <li key={s.key} className="dash-source">
            <div className="dash-source__line">
              <span className="dash-source__title">{s.title}</span>
              <span className={`dash-source__pct${s.mastery === 0 && s.learned === 0 ? ' dash-source__pct--zero' : ''}`}>
                {mapLabel(s.mastery, s.learned > 0, s.wrong > 0)}
              </span>
            </div>
            <div className="dash-source__bar" aria-hidden="true">
              <span style={{ width: `${Math.round(s.mastery * 100)}%` }} />
            </div>
            <div className="dash-source__meta">
              {s.total} 道 · 已学 {s.learned}
              {s.due > 0 ? ` · ${s.due} 道到期` : ''}
              {s.wrong > 0 ? ` · ${s.wrong} 道错着` : ''}
            </div>
          </li>
        ))}
      </ul>

      {weakest ? (
        <p className="dash-weak">
          最该补的是 <strong>{weakest.chapter.title}</strong>
          {/* 档位与「练过几道」必须自洽：都从 learned 派生，不并列两句互相打脸的话 */}
          （{mapLabel(weakest.chapter.mastery, weakest.chapter.learned > 0, weakest.chapter.wrong > 0)}，
          {weakest.chapter.learned > 0
            ? `${weakest.chapter.learned}/${weakest.chapter.total} 道练过`
            : `还没开始，共 ${weakest.chapter.total} 道题`}）
        </p>
      ) : null}

      {map.sources.length > 4 ? (
        <button type="button" className="btn-text dash-more-bottom" onClick={onOpenMap}>
          还有 {map.sources.length - 4} 份资料 · 看完整地图
        </button>
      ) : null}
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="today__stat">
      <div className="today__stat-value">
        {value}
        {unit ? <span className="today__stat-unit">{unit}</span> : null}
      </div>
      <div className="today__stat-label">{label}</div>
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
    if (value >= 0.85) return 'mastered';
    if (value >= 0.6) return 'familiar';
    return 'learning';
  });

  return (
    <div className="mastery">
      <span className="mastery__bar">
        {segs.map((s, i) => (
          <span key={i} className={`mastery__seg mastery__seg--${s}`} />
        ))}
      </span>
      <span className="mastery__pct">{Math.round(value * 100)}%</span>
    </div>
  );
}
