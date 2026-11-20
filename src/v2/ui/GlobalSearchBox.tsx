/**
 * 顶栏全局搜索（2026-11-20）。
 *
 * ## 它解决什么
 *
 * `sourceService.search(sourceId, query)` 只接受单个 sourceId ——
 * 只能在某一本书里搜。真实场景是「我记得在哪本书看过这个概念」。
 * 交接文档把它列为建议的下一项，理由：纯本地、不需要 AI、
 * 能离线完整验证、高频。
 *
 * ## 为什么是「回车才搜」而不是实时搜索
 *
 * 用户库里 1006 段正文、几十万字。每敲一个字就扫全库，
 * 在输入「线性表」四个字的过程中要扫四遍全表 —— 界面会明显卡顿，
 * 而前三遍的结果用户根本来不及看。
 *
 * 回车/点按钮才触发，是拿「少一次自动刷新」换「输入不卡」。
 * （如果以后要做实时搜索，正确做法是加索引或防抖 + 提前返回，
 *   不是把全表扫描塞进 onChange。）
 *
 * ## 结果点进去要落到**那句话**
 *
 * 搜索最典型的场景是「我知道有这么一句，要看它在原文哪里」。
 * 只跳到那一页会丢掉这次搜索的意义 —— 所以点结果走
 * `hitToReaderTarget()`，把 charStart/charEnd 一起带给阅读器，
 * 由它圈出那句话并标橙光（与「定位精确到句子」同一条链路）。
 *
 * ## 为什么单独一个文件
 *
 * 硬约束：`AppShell.tsx` / `App.tsx` 都是大文件，新增 UI 一律独立文件。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source, SourceSegment } from '@/core/model.ts';
import type { GlobalSearchHit, GlobalSearchResult } from '@/v2/core/global-search.ts';
import {
  hitToReaderTarget,
  searchAllSources,
  summarizeResult,
} from '@/v2/core/global-search.ts';
import type { ReaderTarget } from './ReaderPage.tsx';
import './global-search.css';

export interface GlobalSearchBoxProps {
  /**
   * 读搜索索引（全部资料 + 全部段落）。
   *
   * 为什么是「由调用方提供读法」而不是直接收 SourceService：
   * 外壳组件不该知道数据怎么存 —— 测试里可以直接塞假数据，
   * 而 AppShell 也不必 import 服务层。
   */
  loadIndex: () => Promise<{
    sources: readonly Source[];
    segments: readonly SourceSegment[];
  }>;
  /** 点某条结果：跳到那句话 */
  onOpenHit: (target: ReaderTarget) => void;
}

/**
 * 超过这个总数就把资料组默认折起来（2026-11-20）。
 *
 * ## 为什么需要折叠
 *
 * 实测搜「的」有 2365 处，列表列 500 条，而面板限高 620px ——
 * 用户要滚很久才能看到第二、第三份资料。而「哪几本书里有这个词」
 * 恰恰是跨资料搜索要回答的第一个问题。
 *
 * 所以命中很多时：**每份资料只默认展开前几条**，
 * 用户点一下就能展开那一份看他关心的书。
 *
 * 为什么以 80 为界：普通词（实测「极限」48 处）折叠反而添乱 ——
 * 一次能看完的东西不该多一次点击。
 */
const COLLAPSE_THRESHOLD = 80;
/** 折叠状态下每组先显示几条 */
const COLLAPSED_PER_GROUP = 3;

/** 把片段里出现的所有关键词包成 <mark>（不区分大小写） */
function renderSnippet(snippet: string, keyword: string) {
  const kw = keyword.trim();
  if (!kw) return snippet;

  const out: React.ReactNode[] = [];
  const lower = snippet.toLowerCase();
  const lowerKw = kw.toLowerCase();
  let from = 0;
  let n = 0;

  for (;;) {
    const at = lower.indexOf(lowerKw, from);
    if (at === -1) break;
    if (at > from) out.push(snippet.slice(from, at));
    out.push(
      <mark className="gsearch__kw" key={n++}>
        {snippet.slice(at, at + kw.length)}
      </mark>,
    );
    from = at + kw.length;
  }
  if (from < snippet.length) out.push(snippet.slice(from));
  return out.length > 0 ? out : snippet;
}

export function GlobalSearchBox({ loadIndex, onOpenHit }: GlobalSearchBoxProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  /** 这次结果是搜哪个词得到的（结果里的关键词高亮要用它，不是输入框的实时值） */
  const [searchedFor, setSearchedFor] = useState('');
  /**
   * 哪些资料组是**用户主动展开**的（2026-11-20）。
   *
   * 命中很多时默认折叠（每组只显示 3 条），点「展开」才全列。
   * 记「展开的」而不是「折叠的」：每次新搜索都是全新结果，
   * 记折叠的会让上一次的折叠状态污染这一次。
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement | null>(null);

  /**
   * 点外面收起结果。
   *
   * 不收起的话结果面板会一直挡住正文，而用户点正文时以为已经关掉了。
   */
  useEffect(() => {
    if (!result) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setResult(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [result]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * 只读一次全表（loadIndex → getAllSegments），在内存里按资料分组匹配。
       * 循环调 getSegments(sourceId) 会把全表读 N 遍 ——
       * 那是 O(资料数 × 全表)，资料一多就明显卡。
       */
      const { sources, segments } = await loadIndex();
      setResult(searchAllSources(sources, segments, q));
      setSearchedFor(q);
      /* 新一次搜索：上一轮的展开状态作废（结果是全新的） */
      setExpanded(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : '搜索失败');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, busy, loadIndex]);

  const pick = useCallback(
    (hit: GlobalSearchHit) => {
      setResult(null);
      onOpenHit(hitToReaderTarget(hit) as ReaderTarget);
    },
    [onOpenHit],
  );

  const open = result !== null;

  return (
    <div className={`gsearch${open ? ' gsearch--open' : ''}`} ref={boxRef}>
      <div className="gsearch__bar">
        <input
          className="gsearch__input"
          type="search"
          value={query}
          placeholder="搜索全部资料…"
          aria-label="搜索全部资料"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runSearch();
            }
            if (e.key === 'Escape') setResult(null);
          }}
        />
        <button
          type="button"
          className="gsearch__go"
          onClick={() => void runSearch()}
          disabled={busy || query.trim().length === 0}
          title="搜索全部资料（回车）"
        >
          {busy ? '搜索中…' : '搜索'}
        </button>
      </div>

      {error ? <p className="gsearch__error">{error}</p> : null}

      {open ? (
        <div className="gsearch__panel" role="dialog" aria-label="搜索结果">
          <div className="gsearch__head">
            <span className="gsearch__summary">{summarizeResult(result, searchedFor)}</span>
            <button type="button" className="gsearch__close" onClick={() => setResult(null)}>
              收起
            </button>
          </div>

          {/*
            空态判断用 `matchCount`（真实命中数），**不是** `total`（展示条数）。
            两者在截断时可能不同：若 limit 被前面的资料占满，
            后面资料的 hits 是空的但 matchCount 不为 0 ——
            用 total 判断会把「找到了、只是没列出」说成「没找到」。
          */}
          {result.matchCount === 0 ? (
            <p className="gsearch__empty">
              换个词试试，或者先确认资料已经解析出正文（「资料」页能看到段数）。
            </p>
          ) : (
            <ul className="gsearch__groups">
              {result.groups.map((g) => {
                /*
                 * 命中很多时默认每组只显示 3 条（2026-11-20）。
                 *
                 * 实测搜「的」列 500 条、面板限高 620px ——
                 * 用户要滚很久才能看到第二本书，而「哪几本书里有」
                 * 正是跨资料搜索要回答的第一个问题。
                 *
                 * 折叠后一眼能看到所有资料各自的命中数，
                 * 想看哪本就展开哪本。
                 */
                const collapsible = result.matchCount > COLLAPSE_THRESHOLD;
                const isOpen = expanded.has(g.sourceId);
                const shownHits =
                  collapsible && !isOpen ? g.hits.slice(0, COLLAPSED_PER_GROUP) : g.hits;
                const hiddenByCollapse = g.hits.length - shownHits.length;

                return (
                  <li key={g.sourceId} className="gsearch__group">
                    {/*
                      按资料分组（组头是书名）。
                      不分组的话 500 条结果平铺，用户分不清哪条来自哪本书 ——
                      而「在哪本书里」正是这次搜索要回答的问题。
                    */}
                    <p className="gsearch__group-head">
                      <span className="gsearch__source">{g.sourceTitle}</span>
                      {/*
                        组头上的数字是**真实命中数**，不是列表长度（2026-11-20）。
                        两者可能不同：触到 limit 时列表被截断。
                        只显示列表长度会让用户以为「这本书只有 12 处」，
                        而其实它有 800 处 —— 那是在骗人。
                      */}
                      <span className="gsearch__count">
                        {g.count} 处
                        {g.hits.length < g.count ? (
                          <span className="gsearch__count-shown">
                            （列前 {g.hits.length} 处）
                          </span>
                        ) : null}
                      </span>
                      {/*
                        折叠开关只在「本组真被折叠了」时出现 ——
                        不能给一个点了没变化的按钮（不做假开关）。
                      */}
                      {hiddenByCollapse > 0 ? (
                        <button
                          type="button"
                          className="gsearch__toggle"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              next.add(g.sourceId);
                              return next;
                            })
                          }
                        >
                          展开全部 {g.hits.length} 条
                        </button>
                      ) : collapsible && isOpen && g.hits.length > COLLAPSED_PER_GROUP ? (
                        <button
                          type="button"
                          className="gsearch__toggle"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              next.delete(g.sourceId);
                              return next;
                            })
                          }
                        >
                          收起
                        </button>
                      ) : null}
                    </p>
                    <ul className="gsearch__hits">
                      {shownHits.map((h, i) => (
                        <li key={`${h.segmentId}:${h.charStart}:${i}`}>
                          <button
                            type="button"
                            className="gsearch__hit"
                            onClick={() => pick(h)}
                            title="跳到这一句"
                          >
                            <span className="gsearch__where">
                              第 {h.page} 页
                              {h.chapter ? (
                                <span className="gsearch__chapter">{h.chapter}</span>
                              ) : null}
                            </span>
                            <span className="gsearch__snippet">
                              {renderSnippet(h.snippet, searchedFor)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {/*
                      底部提示：**把「折叠」与「截断」合成一句**，不要两条并列
                      （2026-11-20）。两条并列时会出现
                      「这份资料还有 348 处没列出」+「已折叠 164 条」
                      —— 用户要自己相减才知道总共还有多少，纯属添乱。
                    */}
                    {g.hits.length < g.count || hiddenByCollapse > 0 ? (
                      <p className="gsearch__more">
                        {(() => {
                          /* 相对「这次搜索全部命中数」还差多少没展示 */
                          const notShown = g.count - shownHits.length;
                          if (notShown <= 0) return null;
                          /*
                           * 两种原因可能同时存在：
                           *  - 列表本身被 limit 截断（g.hits 就不全）
                           *  - 折叠了（g.hits 有，但默认没显示）
                           */
                          if (hiddenByCollapse > 0) {
                            return `还有 ${notShown} 处没显示（默认只列 3 条，点「展开全部」看）`;
                          }
                          return `还有 ${notShown} 处没显示（结果太多，只列前 ${g.hits.length} 处；换个更具体的词能缩小范围）`;
                        })()}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}