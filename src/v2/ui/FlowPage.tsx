/**
 * 学习流：按一份资料，把「学到什么程度、下一步做什么」排成一条线。
 *
 * ## 它和「功能导览」的区别（这是我上一轮判断错的地方）
 *
 * - **功能导览**：这个软件有哪些页面、每页干什么。**与人无关**。
 * - **学习流**：**这份资料**我走到哪一步了、卡在哪、下一步该干嘛。**因人因资料而异**。
 *
 * 上一轮我把这两者当成重复的，砍掉了学习流。实际上导览回答
 * 「软件能做什么」，学习流回答「我现在该做什么」—— 后者才是每天打开时想问的。
 *
 * ## 五个步骤是怎么判定的
 *
 * 全部从现有数据推导，不新增任何存储：
 *
 * | 步骤 | 判定依据 |
 * | --- | --- |
 * | 1 导入资料 | `sources` 里有这条记录 |
 * | 2 正文可读 | `textStatus === 'ready'`（扫描件要 OCR） |
 * | 3 整理知识点 | `knowledgePoints` 里有挂在这份资料上的记录 |
 * | 4 出题并发布 | `decks` 里有它产出的、状态为 published 的题组 |
 * | 5 开始练 | `reviewLogs` 里出现过这些题组的题 |
 *
 * ## 为什么不做成「进度百分比」
 *
 * 百分比会让人以为学习是线性的、有终点的。实际不是 ——
 * 整理完知识点也可以先出题、出完题也可以再补充整理。
 * 所以这里显示**每一步的状态**（完成 / 可做 / 还没到），
 * 并高亮「现在最该做的那一步」，而不是一个 60% 的进度条。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Deck, Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';

export interface FlowPageProps {
  sourceService: SourceService;
  decks: DeckService;
  knowledge: KnowledgeService;
  reviewService: ReviewService;
  /** 去整理这份资料 */
  onOpenOrganize: (sourceId: string) => void;
  /** 去资料页（导入 / 转换） */
  onOpenSources: () => void;
  /** 去阅读器 */
  onOpenSource: (sourceId: string) => void;
  /** 去我的题组（出题 / 发布） */
  onOpenDecks: () => void;
  /** 去开始做题 */
  onOpenPractice: () => void;
}

/** 步骤状态 */
type StepState = 'done' | 'next' | 'blocked';

interface Step {
  key: string;
  title: string;
  /** 一句话说明这一步在做什么 */
  desc: string;
  state: StepState;
  /** 状态旁的具体数字，如「3 个题组 · 24 道题」 */
  detail: string;
  /** 这一步能不能点（blocked 时不能） */
  action?: { label: string; run: () => void };
}

interface FlowRow {
  source: Source;
  steps: Step[];
  /** 当前最该做的那一步（第一个非 done） */
  currentStep: string;
  /** 五步里完成了几步 */
  doneCount: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: FlowRow[] };

export function FlowPage(props: FlowPageProps) {
  const { sourceService, decks, knowledge, reviewService } = props;
  const [state, setState] = useState<Load>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const [sources, deckList, logs] = await Promise.all([
        sourceService.list(),
        decks.list(),
        /* 只用来判断「这份资料的题有没有做过」，不需要完整日志内容 */
        reviewService.listRecords(),
      ]);

      /* 知识点按资料分组计数 */
      const kpCount = new Map<string, number>();
      for (const s of sources) {
        const points = await knowledge.listBySource(s.id);
        kpCount.set(s.id, points.length);
      }

      /* 题组按资料分组 */
      const decksBySource = new Map<string, Deck[]>();
      for (const d of deckList) {
        if (!d.sourceId) continue;
        const arr = decksBySource.get(d.sourceId) ?? [];
        arr.push(d);
        decksBySource.set(d.sourceId, arr);
      }

      /* 已学过的卡片 id（有复习记录即算「练过」） */
      const practiced = new Set(logs.map((r) => r.cardId));

      /*
       * 一次把所有题组的题目 id 取出来建索引。
       *
       * 不能在下面的 map 里 await：那会让循环变成异步、
       * 而且每份资料都要重新查一次题（N 份资料 × M 个题组次查询）。
       * 先批量取好，后面就是纯内存判断。
       */
      const qIdsByDeck = new Map<string, string[]>();
      for (const d of deckList) {
        const qs = await decks.getQuestions(d.id);
        qIdsByDeck.set(d.id, qs.map((q) => q.id));
      }

      const rows: FlowRow[] = sources.map((s) => {
        const pts = kpCount.get(s.id) ?? 0;
        const myDecks = decksBySource.get(s.id) ?? [];
        const published = myDecks.filter((d) => d.status === 'published');
        const qCount = published.reduce((n, d) => n + d.questionCount, 0);

        /*
         * 「练过」的判断：这份资料的题组里，有没有任何一道题出现在复习记录里。
         * 不能只看 reviewRecords 的总数 —— 那可能是别的资料。
         * 这里没有逐题反查（题 id 在 decks 里），所以用题组是否「有复习记录」
         * 这个更粗但可靠的口径：只要这份资料产出的题组被练过就算。
         */
        /* 这份资料产出的题组里，有没有任何一道题出现在复习记录里 */
        const hasPracticed = published.some((d) =>
          (qIdsByDeck.get(d.id) ?? []).some((qid) => practiced.has(qid)),
        );

        const step1: Step = {
          key: 'import',
          title: '导入资料',
          desc: '把讲义、教材或笔记放进来',
          state: 'done',
          detail: `${s.kind.toUpperCase()} · ${s.pageCount ?? s.segmentCount} 页`,
          action: { label: '看原文', run: () => props.onOpenSource(s.id) },
        };

        const textReady = s.textStatus === 'ready';
        const step2: Step = {
          key: 'text',
          title: '正文可读',
          desc: textReady ? '正文已解析，可以读也能用来出题' : '扫描件还没转成文字',
          state: textReady ? 'done' : 'next',
          detail: textReady ? `${s.segmentCount} 段` : '需要先转成正文',
          ...(textReady
            ? { action: { label: '看原文', run: () => props.onOpenSource(s.id) } }
            : { action: { label: '去转换', run: () => props.onOpenSources() } }),
        };

        const step3: Step = {
          key: 'organize',
          title: '整理知识点',
          desc: pts > 0 ? '已整理出知识点' : '把正文整理成一条条能点回原文的知识点',
          state: pts > 0 ? 'done' : textReady ? 'next' : 'blocked',
          detail: pts > 0 ? `${pts} 条` : textReady ? '还没整理' : '要等正文可读',
          ...(textReady
            ? { action: { label: pts > 0 ? '再整理' : '去整理', run: () => props.onOpenOrganize(s.id) } }
            : {}),
        };

        const step4: Step = {
          key: 'generate',
          title: '出题并发布',
          desc:
            published.length > 0
              ? '已有发布的题组'
              : myDecks.length > 0
                ? '有草稿题组，还没发布'
                : '用知识点或原文出一组题',
          state: published.length > 0 ? 'done' : pts > 0 ? 'next' : 'blocked',
          detail:
            published.length > 0
              ? `${published.length} 组 · ${qCount} 道`
              : myDecks.length > 0
                ? `${myDecks.length} 组草稿`
                : pts > 0
                  ? '还没出题'
                  : '要等有知识点',
          ...(pts > 0 ? { action: { label: '去题组', run: () => props.onOpenDecks() } } : {}),
        };

        const step5: Step = {
          key: 'practice',
          title: '开始练',
          desc: hasPracticed ? '已经练过这份资料的题' : '做一遍题，答错的会进错题集',
          state: hasPracticed ? 'done' : published.length > 0 ? 'next' : 'blocked',
          detail: hasPracticed
            ? '有练习记录'
            : published.length > 0
              ? `${qCount} 道可练`
              : '要等题组发布',
          ...(published.length > 0
            ? { action: { label: '开始做题', run: () => props.onOpenPractice() } }
            : {}),
        };

        const steps = [step1, step2, step3, step4, step5];
        const doneCount = steps.filter((x) => x.state === 'done').length;
        const current = steps.find((x) => x.state !== 'done');

        return {
          source: s,
          steps,
          currentStep: current?.key ?? 'all-done',
          doneCount,
        };
      });

      /* 进度浅的排前面 —— 那是更需要动手的 */
      rows.sort((a, b) => a.doneCount - b.doneCount);

      setState({ kind: 'ready', rows });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出学习进度',
      });
    }
    /*
     * 依赖里**不能放 props**：它是每次渲染都新建的对象，
     * 会触发 effect → setState → 重新渲染 → effect 的死循环。
     * 只依赖真正用到的服务引用（它们是稳定的单例）。
     * 回调函数不参与依赖：它们只在按钮 onClick 时被调用，不影响加载逻辑。
     */
  }, [sourceService, decks, knowledge, reviewService]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state.kind === 'ready' ? state.rows : [];

  /** 全部都能走完的资料数 —— 给个整体感，但不做百分比 */
  const finished = useMemo(() => rows.filter((r) => r.doneCount >= 5).length, [rows]);

  if (state.kind === 'loading') {
    return (
      <div className="flow-page">
        <p className="fl-hint">正在读学习进度…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flow-page">
        <p className="fl-error">{state.message}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flow-page">
        <header className="fl-head">
          <h1 className="fl-title">学习流</h1>
        </header>
        <div className="fl-empty">
          <p>还没有资料，所以还没有学习流。</p>
          <p className="fl-hint">
            学习流会按每份资料，把「导入 → 正文可读 → 整理知识点 → 出题发布 → 开始练」
            五步的进度摆出来。
          </p>
          <button type="button" className="btn-ghost" onClick={props.onOpenSources}>
            去导入资料
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-page">
      <header className="fl-head">
        <h1 className="fl-title">学习流</h1>
        <p className="fl-lead">
          按每份资料看走到哪一步了。五步的顺序是建议而不是规定 ——
          但「正文可读」之前做不了整理，「有知识点」之前出不了题。
        </p>
      </header>

      <div className="fl-stats">
        <span className="fl-stat">
          <span className="fl-stat__n">{rows.length}</span>
          <span className="fl-stat__label">份资料</span>
        </span>
        <span className="fl-stat">
          <span className="fl-stat__n">{finished}</span>
          <span className="fl-stat__label">份已走完五步</span>
        </span>
      </div>

      <ul className="fl-list">
        {rows.map((r) => (
          <li key={r.source.id} className="fl-item">
            <div className="fl-item__head">
              <span className="fl-item__title">{r.source.title}</span>
              <span className="fl-item__progress">
                {r.doneCount} / 5
              </span>
            </div>

            <ol className="fl-steps">
              {r.steps.map((st, i) => (
                <li
                  key={st.key}
                  className={`fl-step fl-step--${st.state}${
                    st.key === r.currentStep ? ' fl-step--current' : ''
                  }`}
                >
                  <span className="fl-step__n" aria-hidden="true">
                    {st.state === 'done' ? '✓' : i + 1}
                  </span>
                  <div className="fl-step__body">
                    <div className="fl-step__title">
                      {st.title}
                      {st.key === r.currentStep ? (
                        <span className="fl-step__badge">该做这个</span>
                      ) : null}
                    </div>
                    <div className="fl-step__desc">{st.desc}</div>
                    <div className="fl-step__detail">{st.detail}</div>
                  </div>
                  {st.action ? (
                    <button
                      type="button"
                      className="fl-step__btn"
                      onClick={st.action.run}
                      disabled={st.state === 'blocked'}
                    >
                      {st.action.label}
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </div>
  );
}
