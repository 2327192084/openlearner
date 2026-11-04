import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Deck, KnowledgePoint, Source } from '@/core/model.ts';
import { DeckDetail } from './DeckDetail.tsx';
import { DeckGenerate } from './DeckGenerate.tsx';
import { DeckList, DeckListHint, deleteConfirmText } from './DeckList.tsx';
import { describeError, hintFrom } from './types.ts';
import type { DeckStats, Flash, Load } from './types.ts';
import './decks.css';

/**
 * 习题集页（P3 第一半）：出题 + 列表 + 草稿审阅。
 *
 * ## 为什么出题面板是**列表页内联的一块**，而不是一个独立视图
 *
 * 一开始我做的是「列表 / 出题 / 详情」三视图切换，要出一套题得先点「出题」。
 * 但库是空的时候那个按钮藏在空态里，用户看到的是「还没有习题集」，
 * 而不是「这里可以出题」——这正是 P2 的教训：新用户进来只看到空态，
 * 不知道下一步在哪。知识点页的整理面板就是常驻在页面上的。
 *
 * 所以改成：出题面板**常驻在列表上方**，没有习题集时默认展开，
 * 有习题集时默认折叠（省屏幕）。「出题」按钮只是把它展开并滚上去。
 *
 * ## 读写分离
 *
 * 列表只读元信息（`Deck`），**不读题目正文**。
 * 一个习题集可能有 200 道题，把它们的题干+选项+解析全读进来再渲染，
 * 在题多的库上是能感觉到的卡顿。题目正文只在 `DeckDetail` 里才 `getQuestions()`。
 *
 * 唯一额外读的是 `getStats()` —— 它内部会数一遍题目，但**不返回题目内容**，
 * 返回 4 个数字。这是列表要显示正确率的代价，8 个习题集就是 8 次调用。
 *
 * ## 关于视图
 *
 * `list` / `detail` 两种，用状态表示而不是子路由 ——
 * 注册表只有 `/decks` 一条（`core/registry.ts` 是别人的域，不能加子路由）。
 * P1 的资料页与 P2 的知识点页都用了同一个解法。
 */

type View = { kind: 'list' } | { kind: 'detail'; deckId: string };

export function DecksPage() {
  const navigate = useNavigate();
  const { decks: deckService, sources: sourceService, knowledge } = useServices();

  const [view, setView] = useState<View>({ kind: 'list' });
  const [decksState, setDecksState] = useState<Load<Deck[]>>({ kind: 'loading' });
  const [flash, setFlash] = useState<Flash>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  /**
   * 出题面板是否展开。
   *
   * `null` = 还没决定（首次加载时按「有没有习题集」自动定一次）。
   * 用 null 而不是 false 起步，是为了让「库空 → 默认展开」这件事
   * 只在第一次渲染后发生一次，不覆盖用户之后的手动折叠。
   */
  const [generateOpen, setGenerateOpen] = useState<boolean | null>(null);
  const generateRef = useRef<HTMLDivElement | null>(null);

  // ---- 列表页需要的附加信息（全部只读元信息，不碰题目正文） ----
  const [stats, setStats] = useState<Record<string, DeckStats>>({});
  const [statsLoading, setStatsLoading] = useState(false);
  const [sources, setSources] = useState<Source[] | null>(null);
  /** 全库「已定位」的知识点数，用于出题前置检查 */
  const [locatedPoints, setLocatedPoints] = useState<number | null>(null);

  const loadDecks = useCallback(async () => {
    try {
      const list = await deckService.list();
      setDecksState({ kind: 'ready', data: list });
    } catch (err) {
      setDecksState({
        kind: 'error',
        message: describeError(err),
        hint: '习题集列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘是否已满。',
      });
    }
  }, [deckService]);

  useEffect(() => {
    void loadDecks();
  }, [loadDecks]);

  const decks = decksState.kind === 'ready' ? decksState.data : [];
  const open = generateOpen ?? decks.length === 0;

  /**
   * 前置检查：有没有资料、有没有已定位的知识点。
   *
   * 与习题集列表无关，只跑一次 —— 它回答的是「现在能不能出题」。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const allSources = await sourceService.list();
        if (!alive) return;
        setSources(allSources);
        const nested = await Promise.all(
          allSources.map((s) => knowledge.listBySource(s.id).catch(() => [] as KnowledgePoint[])),
        );
        if (!alive) return;
        setLocatedPoints(
          nested.flat().filter((p) => p.anchorStatus === 'located' && p.anchors.length > 0).length,
        );
      } catch {
        if (!alive) return;
        setSources([]);
        setLocatedPoints(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sourceService, knowledge]);

  /**
   * 各习题集的正确率。
   *
   * 依赖一个**稳定的签名**而不是 decks 数组本身：
   * `list()` 每次都返回新数组，直接依赖它会每次渲染都重查一遍统计。
   */
  const deckSignature = useMemo(() => decks.map((d) => d.id).join('|'), [decks]);

  useEffect(() => {
    if (!deckSignature) {
      setStats({});
      setStatsLoading(false);
      return;
    }
    let alive = true;
    setStatsLoading(true);
    void (async () => {
      const ids = deckSignature.split('|');
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const s = await deckService.getStats(id);
            return [id, s] as const;
          } catch {
            return null;
          }
        }),
      );
      if (!alive) return;
      const next: Record<string, DeckStats> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setStats(next);
      setStatsLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [deckSignature, deckService]);

  /** 详情页里任何写动作之后，列表页的题数/阻塞数要跟着变 */
  const refreshAll = useCallback(async () => {
    await loadDecks();
  }, [loadDecks]);

  const handleDelete = async (deck: Deck) => {
    const ok = window.confirm(deleteConfirmText(deck, stats[deck.id]));
    if (!ok) return;
    setRemovingId(deck.id);
    setFlash(null);
    try {
      await deckService.removeDeck(deck.id);
      // 删掉的正好是当前打开的，就退回列表
      if (view.kind === 'detail' && view.deckId === deck.id) setView({ kind: 'list' });
      await loadDecks();
      setFlash({ tone: 'info', text: `已删除「${deck.title}」及其题目与作答记录` });
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `删除没有完成：${describeError(err)}。${hintFrom(
          err,
          '可以刷新后重试；若仍失败，检查本地存储是否可用。',
        )}`,
      });
    } finally {
      setRemovingId(null);
    }
  };

  const handlePractice = (deckId: string) => {
    /*
     * 练习是另一个注册页面（`/practice`），用 hash 路由跳过去。
     * 带上 `?deck=<id>` 让它直接选中这套题 —— 少一步「再选一次」。
     */
    navigate(`/practice?deck=${encodeURIComponent(deckId)}`);
  };

  const expandGenerate = () => {
    setGenerateOpen(true);
    setFlash(null);
    // 展开后滚上去，否则用户点了按钮还得自己找面板在哪
    window.setTimeout(() => {
      generateRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
  };

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  if (decksState.kind === 'loading') return <LoadingState label="正在读取习题集…" />;

  if (decksState.kind === 'error') {
    return (
      <ErrorState
        title="读不到习题集"
        message={decksState.message}
        hint={decksState.hint}
        onRetry={() => void loadDecks()}
      />
    );
  }

  if (view.kind === 'detail') {
    return (
      <div className="page page__stack dk-page">
        <DeckDetail
          deckId={view.deckId}
          onBack={() => {
            setView({ kind: 'list' });
            void refreshAll();
          }}
          onChanged={refreshAll}
          onPractice={handlePractice}
        />
      </div>
    );
  }

  return (
    <div className="page page__stack dk-page">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">习题集</h2>
          <p className="page__summary">
            从知识点出题，先落草稿、人工检查后才发布。每题都带答案、解析，
            以及能点回原文的出处——这是「不是 AI 瞎编」最直接的证据。
          </p>
        </div>
        <div className="page__head-side">
          <Badge tone="neutral">P3</Badge>
          <Badge tone="ready">可用</Badge>
        </div>
      </header>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <div className="dk-toolbar">
        <div className="dk-toolbar__stats">
          {decks.length > 0 ? (
            <>
              <span>
                共 <strong>{decks.length}</strong> 个习题集
              </span>
              <span className="page__muted">
                （已发布 {decks.filter((d) => d.status === 'published').length} 个）
              </span>
            </>
          ) : (
            <span className="page__muted">还没有习题集，从下面出题开始</span>
          )}
        </div>
        <div className="page__row">
          <Link className="btn btn--ghost" to="/practice">
            去练习
          </Link>
          <button type="button" className="btn" onClick={() => setGenerateOpen(!open)}>
            {open ? '收起面板' : '写新的一套题'}
          </button>
        </div>
      </div>

      <DeckListHint
        hasSources={(sources?.length ?? 0) > 0}
        locatedPoints={locatedPoints}
        loading={sources === null}
      />

      {/* ---------- 出题面板（常驻，可折叠） ---------- */}
      <div ref={generateRef}>
        {open ? (
          <DeckGenerate
            onGenerated={(deckId, summary) => {
              // 出完直接进审阅页：草稿就是给人检查的，不该让用户再找一次。
              // 汇报文案一起带过去，否则「产出几道、用多少 token」就丢了。
              setFlash(summary);
              setView({ kind: 'detail', deckId });
              void refreshAll();
            }}
            onCancel={() => setGenerateOpen(false)}
          />
        ) : (
          <div className="dk-collapsed">
            <div>
              <div className="dk-collapsed__title">出题</div>
              <div className="dk-collapsed__desc">
                选一份资料，从它已定位的知识点出题。结果进草稿，检查后发布。
              </div>
            </div>
            <button type="button" className="btn btn--primary" onClick={expandGenerate}>
              展开出题面板
            </button>
          </div>
        )}
      </div>

      {/* ---------- 列表 ---------- */}
      {decks.length > 0 ? (
        <section className="page__stack">
          <h3 className="page__section-title">我的习题集（{decks.length}）</h3>
          <DeckList
            decks={decks}
            stats={stats}
            statsLoading={statsLoading}
            busy={removingId}
            onOpen={(deckId) => {
              setFlash(null);
              setView({ kind: 'detail', deckId });
            }}
            onPractice={handlePractice}
            onDelete={(deck) => void handleDelete(deck)}
            onStartGenerate={expandGenerate}
            hasSources={(sources?.length ?? 0) > 0}
          />
        </section>
      ) : null}
    </div>
  );
}

/** 供出题面板显示「可用知识点」的紧凑文案 */
export function pointsSummaryText(located: number, total: number): string {
  if (total === 0) return '没有知识点';
  return `${located} / ${total} 条已定位`;
}
