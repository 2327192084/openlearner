/**
 * 复习全书：把题库里的题与解析串成一本可读的复习册。
 *
 * ## 和「我的题组」的区别
 *
 * - **我的题组**：管理视角 —— 哪几组题、发没发布、逐题检查。
 * - **复习全书**：阅读视角 —— 把这门课的题按章节/题组串起来读一遍，
 *   不看「题组」这个管理单位，看的是「这门课考什么」。
 *
 * 考前最想要的是后者：一页页翻过去，题干、答案、解析、出处都在，
 * 还能导出成 Markdown 带去打印或别的设备看。
 *
 * ## 数据是纯只读聚合
 *
 * 只读 `decks` / `questions` / `sources`，不写任何东西。
 * 导出走现成的 `DeckService.exportMarkdown()`（按题组），
 * 这里额外提供「整本一起导出」——把多个题组的 Markdown 拼起来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, Question, Source } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { downloadBlob } from '@/pages/slides/download.ts';
import { MathText } from './MathText.tsx';
import { BookSelfTest } from './BookSelfTest.tsx';

export interface BookPageProps {
  decks: DeckService;
  sourceService: SourceService;
  /** 去阅读器看原文 */
  onOpenSource: (sourceId: string) => void;
  /**
   * 去阅读器并定位到具体页（2026-11-09）。
   *
   * 自测答错后最想做的事是「回去看一眼原文那一段」。
   * 只给 sourceId 会让阅读器打开第一页 —— 那等于没定位。
   */
  onOpenSourceAt?: (sourceId: string, page: number, quote?: string) => void;
  /** 去我的题组 */
  onOpenDecks: () => void;
  /**
   * 从「开始复习」进来时自动进入自测模式（2026-11-09）。
   *
   * 用户要求把「开始复习」绑到这一页。带这个标记进来就直接开始自测，
   * 不用再点一次「自测」—— 点了「开始复习」就该开始复习。
   */
  autoStartSelfTest?: boolean;
  /**
   * 自动自测已消费（2026-11-09）。
   *
   * App 收到后清掉那个标记 —— 否则用户下次从侧栏**正常**进这一页，
   * 也会被直接拽进自测。标记是「这次进来要自测」，不是「永远自测」。
   */
  onAutoStartConsumed?: () => void;
}

/** 一个题组在书里的样子 */
interface BookDeck {
  deck: Deck;
  questions: Question[];
}

/** 按资料分的一卷 */
interface BookVolume {
  sourceId: string | null;
  title: string;
  decks: BookDeck[];
  total: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; volumes: BookVolume[] };

export function BookPage({
  decks,
  sourceService,
  onOpenSource,
  onOpenSourceAt,
  onOpenDecks,
  autoStartSelfTest = false,
  onAutoStartConsumed,
}: BookPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  /** 当前显示的筛选：只看某一份资料 */
  const [volumeFilter, setVolumeFilter] = useState<string>('');
  /** 是否显示答案与解析（默认显示，考前复习要看得见） */
  const [showAnswers, setShowAnswers] = useState(true);
  const [busy, setBusy] = useState(false);

  /**
   * 正在自测的那一卷（2026-11-09）。
   *
   * null = 阅读模式（原来的样子）；非 null = 自测这一卷的题。
   * 用「卷」而不是整本书做单位：一次只测一组，测完退出再来下一组，
   * 几十道题一口气测完没人受得了。
   */
  const [selfTestVolume, setSelfTestVolume] = useState<BookVolume | null>(null);

  /**
   * 从「开始复习」进来时自动开始。
   *
   * 为什么要在数据就绪后再选卷：卷是 load() 出来的，
   * 进页面那一刻还没有数据。所以用 effect 等 state 变 ready 再挑。
   */
  const autostartedRef = useRef(false);
  useEffect(() => {
    if (!autoStartSelfTest || autostartedRef.current) return;
    if (state.kind !== 'ready') return;
    const first = state.volumes.find((v) => v.total > 0);
    if (!first) return;
    autostartedRef.current = true;
    setSelfTestVolume(first);
    /* 自测要遮答案，否则一眼就看到了 */
    setShowAnswers(false);
    /* 让 App 清掉标记：下次正常进这一页不该又被拽进自测 */
    onAutoStartConsumed?.();
  }, [autoStartSelfTest, state, onAutoStartConsumed]);

  const load = useCallback(async () => {
    try {
      const [deckList, srcs] = await Promise.all([decks.list(), sourceService.list()]);
      const published = deckList.filter((d) => d.status === 'published');

      const withQuestions = await Promise.all(
        published.map(async (d) => ({ deck: d, questions: await decks.getQuestions(d.id) })),
      );

      /*
       * 按资料分卷。
       *
       * 为什么不按题组平铺：一份资料常常出了好几组题（不同批次、不同题型），
       * 平铺会让人看不出「这些题其实来自同一章」。
       * 按资料聚起来才像「一本书的章」。
       */
      const srcTitle = new Map<string, string>(srcs.map((s: Source) => [s.id, s.title]));
      const bySource = new Map<string | null, BookDeck[]>();
      for (const item of withQuestions) {
        if (item.questions.length === 0) continue;
        const key = item.deck.sourceId;
        const arr = bySource.get(key) ?? [];
        arr.push(item);
        bySource.set(key, arr);
      }

      const volumes: BookVolume[] = [];
      for (const [sourceId, list] of bySource) {
        /* 题组按创建时间排，早出的在前 —— 与学习顺序一致 */
        list.sort((a, b) => (a.deck.createdAt < b.deck.createdAt ? -1 : 1));
        volumes.push({
          sourceId,
          title: sourceId ? (srcTitle.get(sourceId) ?? '（资料已删除）') : '未关联资料的题',
          decks: list,
          total: list.reduce((n, d) => n + d.questions.length, 0),
        });
      }
      /* 题多的卷排前面 */
      volumes.sort((a, b) => b.total - a.total);

      setState({ kind: 'ready', volumes });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出题库',
      });
    }
  }, [decks, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  const volumes = state.kind === 'ready' ? state.volumes : [];

  const visible = useMemo(
    () =>
      volumeFilter === ''
        ? volumes
        : volumes.filter((v) => (v.sourceId ?? '') === volumeFilter),
    [volumes, volumeFilter],
  );

  const grandTotal = visible.reduce((n, v) => n + v.total, 0);

  /** 整本导出：把所有可见题组的 Markdown 拼成一份 */
  async function exportAll() {
    setBusy(true);
    try {
      const parts: string[] = [];
      for (const vol of visible) {
        parts.push(`\n\n# ${vol.title}\n`);
        for (const bd of vol.decks) {
          /*
           * 用 ExportOptions 的真实字段 includeAnswers，
           * 不是自定义的 withAnswer —— 之前写成 as never 强转，
           * 那会让「关掉答案」这个选项静默失效（字段名不对，
           * 导出函数仍按默认值走 includeAnswers: true）。
           */
          const { content } = await decks.exportMarkdown(bd.deck.id, {
            includeAnswers: showAnswers,
            includeAnchors: true,
          });
          /*
           * 题组导出自带一级标题（# 题组名），这里降一级接在「卷」下面，
           * 否则整本导出会出现一堆同级标题、结构散掉。
           */
          parts.push(content.replace(/^# /gm, '## '));
        }
      }
      /*
       * 导出标题沿用「复习全书」这个说法（2026-11-09 改名后保留）。
       *
       * 界面上的导航叫「复习巩固」，但导出的是**一份可打印的复习册**，
       * 「全书」更准确地描述那份文件是什么。改文件里的标题会让
       * 已经导出过的用户对不上号，而导出的内容本身没变。
       */
      const text = `# 复习全书\n\n共 ${grandTotal} 道题。\n${parts.join('\n')}`;
      downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), '复习全书.md');
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '导出失败',
      });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="book-page">
        <p className="bk-hint">正在把题组装订成书…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="book-page">
        <p className="bk-error">{state.message}</p>
      </div>
    );
  }

  /*
   * 自测模式（2026-11-09）。
   *
   * 在「卷」这一层切换：进自测就整页变成一次小测，退出回到阅读。
   * 不并排显示 —— 一边看着答案一边作答，自测就没意义了。
   */
  if (selfTestVolume) {
    const qs = selfTestVolume.decks.flatMap((d) => d.questions);
    return (
      <div className="book-page">
        <BookSelfTest
          title={selfTestVolume.title}
          questions={qs}
          onExit={() => setSelfTestVolume(null)}
          onOpenAnchor={
            onOpenSourceAt && selfTestVolume.sourceId
              ? (page, quote) => onOpenSourceAt(selfTestVolume.sourceId!, page, quote)
              : undefined
          }
        />
      </div>
    );
  }

  if (volumes.length === 0) {
    return (
      <div className="book-page">
        <header className="bk-head">
          <h1 className="bk-title">复习巩固</h1>
        </header>
        <div className="bk-empty">
          <p>还没有可读的内容 —— 复习巩固只收「已发布」题组里的题。</p>
          <p className="bk-hint">
            草稿里的题是给你自己检查用的，不放进复习册。
          </p>
          <button type="button" className="btn-ghost" onClick={onOpenDecks}>
            去我的题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="book-page">
      <header className="bk-head">
        <h1 className="bk-title">复习巩固</h1>
        <p className="bk-lead">
          把已发布题组里的题按资料聚成一册：题干、答案、解析、出处都在。
          想检验自己就点「自测这一卷」—— 遮住答案逐题作答，当场判对错、看解析。
          也可以导出成 Markdown 带走。
        </p>
      </header>

      {/* ---- 工具条 ---- */}
      <div className="bk-toolbar">
        <span className="bk-count">{grandTotal} 道题</span>

        <label className="bk-field">
          <span className="bk-field__label">范围</span>
          <select
            className="bk-select"
            value={volumeFilter}
            onChange={(e) => setVolumeFilter(e.target.value)}
          >
            <option value="">全部（{volumes.reduce((n, v) => n + v.total, 0)} 道）</option>
            {volumes.map((v) => (
              <option key={v.sourceId ?? '__none__'} value={v.sourceId ?? ''}>
                {v.title}（{v.total} 道）
              </option>
            ))}
          </select>
        </label>

        <label className="bk-check">
          <input
            type="checkbox"
            checked={showAnswers}
            onChange={(e) => setShowAnswers(e.target.checked)}
          />
          <span>显示答案与解析</span>
        </label>

        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => void exportAll()}
          disabled={busy}
        >
          {busy ? '导出中…' : '整本导出 Markdown'}
        </button>
      </div>

      {/* ---- 正文 ---- */}
      {visible.map((vol) => (
        <section key={vol.sourceId ?? '__none__'} className="bk-volume">
          <div className="bk-volume__head">
            <h2 className="bk-volume__title">{vol.title}</h2>
            <span className="bk-volume__meta">{vol.total} 道</span>
            {/*
              自测这一卷（2026-11-09）。
              放在卷标题旁而不是页顶：自测的单位是「一组题」，
              用户在这一卷上点，明确知道要测的是哪些题。
            */}
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => {
                setSelfTestVolume(vol);
                setShowAnswers(false);
              }}
            >
              自测这一卷（{vol.total} 道）
            </button>
            {vol.sourceId ? (
              <button type="button" className="btn-text" onClick={() => onOpenSource(vol.sourceId!)}>
                看原文
              </button>
            ) : null}
          </div>

          {vol.decks.map((bd) => (
            <div key={bd.deck.id} className="bk-deck">
              <h3 className="bk-deck__title">
                {bd.deck.title}
                <span className="bk-deck__meta">{bd.questions.length} 道</span>
                {bd.deck.kinds && bd.deck.kinds.length > 0 ? (
                  <span className="bk-deck__kind">{bd.deck.kinds.map(kindLabel).join(' / ')}</span>
                ) : null}
              </h3>

              <ol className="bk-questions">
                {bd.questions.map((q, i) => (
                  <li key={q.id} className="bk-q">
                    <div className="bk-q__head">
                      <span className="bk-q__no">{i + 1}</span>
                      <span className="bk-q__kind">{kindLabel(q.kind)}</span>
                    </div>
                    <p className="bk-q__prompt"><MathText text={q.prompt} /></p>

                    {q.options.length > 0 ? (
                      <ul className="bk-q__options">
                        {q.options.map((o) => (
                          <li
                            key={o.key}
                            className={`bk-q__option${
                              showAnswers && isAnswerKey(q, o.key) ? ' bk-q__option--right' : ''
                            }`}
                          >
                            <span className="bk-q__key">{o.key}</span>
                            <span><MathText text={o.text} /></span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {showAnswers ? (
                      <>
                        {q.options.length === 0 ? (
                          <p className="bk-q__answer">参考答案：<MathText text={q.answer} /></p>
                        ) : (
                          <p className="bk-q__answer">正确答案：<MathText text={q.answer} /></p>
                        )}
                        {q.explanation ? (
                          <p className="bk-q__explain"><MathText text={q.explanation} /></p>
                        ) : null}
                      </>
                    ) : null}

                    {q.anchors.length > 0 && q.anchors[0] ? (
                      <p className="bk-q__from">
                        出处：第 {q.anchors[0].page} 页
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 题型中文名 */
function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'blank':
      return '填空';
    case 'essay':
    case 'short':
      return '问答';
    default:
      return k;
  }
}

/** 某个选项是不是正确答案 */
function isAnswerKey(q: Question, key: string): boolean {
  const a = q.answer.trim().toUpperCase();
  if (q.kind === 'multiple') {
    return a
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .includes(key.toUpperCase());
  }
  return a === key.toUpperCase();
}
