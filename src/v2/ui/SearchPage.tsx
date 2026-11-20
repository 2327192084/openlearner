/**
 * 搜索页：跨资料全文搜索（2026-11-20）。
 *
 * ## 用户要求
 *
 * > 我们修改一下ui，你看看有没有更好看的放法。我的想法是新开一个功能栏
 * > 在课程准备与管理那里，然后界面参考 Google 或是 bing 类似的搜索引擎。
 *
 * ## 为什么从顶栏挪过来
 *
 * 顶栏那个框只有 329px 宽，结果挤在 380px 的下拉面板里。
 * 而跨资料搜索的核心价值是「一次看清好几本书各有多少命中」——
 * 实测搜「的」时三份资料要滚很久才能看全，窄面板盛不下这个信息。
 * 独立成页才有横向空间把「命中概览」摊开。
 *
 * ## 参考搜索引擎的哪些做法（以及为什么只借这几样）
 *
 * 借：
 *  - **居中大搜索框**：视觉焦点明确，一进页面就知道这是搜索页
 *  - **结果前的命中概览**：「共 N 处 · 3 份资料 · 每份多少」先给全局，
 *    这正是窄面板做不到的事
 *  - **结果条目三段式**：来源路径（小字）→ 标题/位置 → 片段，
 *    一眼看清「哪本书 / 第几页 / 说的什么」
 *  - **关键词高亮**：片段里的词标出来，不用自己找
 *
 * 不借：
 *  - 输入即搜（debounce）：库里 564 段、几十万字，每敲一个字扫全库会卡，
 *    而且用户来不及看中间结果。保留「回车 / 点按钮」才搜。
 *  - 相关性排序：本地全文搜索没有词频权重模型，
 *    硬造一个「相关度」只会显得不可解释。按资料 + 页码排，
 *    用户能预期（这也是「哪本书」优先于「哪处最相关」的场景）。
 *
 * ## 为什么单独一个文件
 *
 * 硬约束：大文件里不要插代码，新增 UI 一律独立文件。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Source, SourceSegment } from '@/core/model.ts';
import type { GlobalSearchResult } from '@/v2/core/global-search.ts';
import {
  hitToReaderTarget,
  searchAllSources,
  summarizeResult,
} from '@/v2/core/global-search.ts';
import type { ReaderTarget } from './ReaderPage.tsx';
import './search-page.css';

export interface SearchPageProps {
  /** 读搜索索引（全部资料 + 全部段落） */
  loadIndex: () => Promise<{
    sources: readonly Source[];
    segments: readonly SourceSegment[];
  }>;
  /** 点某条结果：跳到那句话 */
  onOpenHit: (target: ReaderTarget) => void;
}

/** 命中很多时每份资料默认展开几条（与顶栏那版同一口径） */
const COLLAPSE_THRESHOLD = 80;
const COLLAPSED_PER_GROUP = 3;

/** 片段里把关键词标出来（不区分大小写） */
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
      <mark className="spage__kw" key={n++}>
        {snippet.slice(at, at + kw.length)}
      </mark>,
    );
    from = at + kw.length;
  }
  if (from < snippet.length) out.push(snippet.slice(from));
  return out.length > 0 ? out : snippet;
}

export function SearchPage({ loadIndex, onOpenHit }: SearchPageProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  /** 这次结果是搜哪个词得到的（高亮要用它，不是输入框实时值） */
  const [searchedFor, setSearchedFor] = useState('');
  /** 用户主动展开的资料组 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { sources, segments } = await loadIndex();
      setResult(searchAllSources(sources, segments, q));
      setSearchedFor(q);
      setExpanded(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : '搜索失败');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, busy, loadIndex]);

  const pick = useCallback(
    (hit: Parameters<typeof hitToReaderTarget>[0]) => {
      onOpenHit(hitToReaderTarget(hit) as ReaderTarget);
    },
    [onOpenHit],
  );

  /**
   * 命中概览（搜索引擎那种「一共找到多少」）。
   *
   * 先给全局数字，再给每份资料的分布 —— 窄面板做不到的事，
   * 这一页的主要价值就在这里。
   */
  const overview = useMemo(() => {
    if (!result || result.matchCount === 0) return null;
    const max = Math.max(...result.groups.map((g) => g.count), 1);
    return result.groups.map((g) => ({
      ...g,
      /* 条形宽度百分比，用于画分布条 */
      width: Math.max(2, Math.round((g.count / max) * 100)),
    }));
  }, [result]);

  return (
    <div className="spage">
      <div className="spage__hero">
        <h1 className="spage__title">搜索资料</h1>
        <p className="spage__lead">
          在全部资料里搜一句话或一个词，结果按书分组，点一条跳到原文那一句
        </p>

        <div className="spage__bar">
          <input
            ref={inputRef}
            className="spage__input"
            type="search"
            value={query}
            placeholder="输入关键词，回车搜索"
            aria-label="搜索全部资料"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
          <button
            type="button"
            className="spage__go"
            onClick={() => void runSearch()}
            disabled={busy || query.trim().length === 0}
          >
            {busy ? '搜索中…' : '搜索'}
          </button>
        </div>

        {error ? <p className="spage__error">{error}</p> : null}
      </div>

      {result ? (
        result.matchCount === 0 ? (
          <div className="spage__empty">
            <p className="spage__empty-title">{summarizeResult(result, searchedFor)}</p>
            <p className="spage__empty-hint">
              换个词试试，或者先确认资料已经解析出正文（「资料」页能看到段数）。
            </p>
          </div>
        ) : (
          <>
            {/* ---- 命中概览（搜索引擎式） ---- */}
            <div className="spage__overview">
              <p className="spage__summary">{summarizeResult(result, searchedFor)}</p>
              <ul className="spage__dist">
                {overview?.map((g) => (
                  <li key={g.sourceId} className="spage__dist-row">
                    <span className="spage__dist-name" title={g.sourceTitle}>
                      {g.sourceTitle}
                    </span>
                    <span className="spage__dist-track" aria-hidden="true">
                      <span className="spage__dist-fill" style={{ width: g.width + '%' }} />
                    </span>
                    <span className="spage__dist-num">{g.count}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ---- 结果列表 ---- */}
            <ul className="spage__groups">
              {result.groups.map((g) => {
                const collapsible = result.matchCount > COLLAPSE_THRESHOLD;
                const isOpen = expanded.has(g.sourceId);
                const shownHits =
                  collapsible && !isOpen ? g.hits.slice(0, COLLAPSED_PER_GROUP) : g.hits;
                const hidden = g.hits.length - shownHits.length;
                const notShown = g.count - shownHits.length;

                return (
                  <li key={g.sourceId} className="spage__group">
                    <div className="spage__group-head">
                      <span className="spage__source">{g.sourceTitle}</span>
                      <span className="spage__count">
                        {g.count} 处
                        {g.hits.length < g.count ? (
                          <span className="spage__count-sub">（列前 {g.hits.length} 处）</span>
                        ) : null}
                      </span>
                      {hidden > 0 ? (
                        <button
                          type="button"
                          className="spage__toggle"
                          onClick={() =>
                            setExpanded((prev) => new Set(prev).add(g.sourceId))
                          }
                        >
                          展开全部 {g.hits.length} 条
                        </button>
                      ) : collapsible && isOpen && g.hits.length > COLLAPSED_PER_GROUP ? (
                        <button
                          type="button"
                          className="spage__toggle"
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
                    </div>

                    <ul className="spage__hits">
                      {shownHits.map((h, i) => (
                        <li key={`${h.segmentId}:${h.charStart}:${i}`}>
                          <button
                            type="button"
                            className="spage__hit"
                            onClick={() => pick(h)}
                            title="跳到这一句"
                          >
                            {/*
                              三段式（借搜索引擎的结果条目结构）：
                              来源路径 → 位置 → 片段。
                              位置在前是因为「第几页」是用户找东西的坐标。
                            */}
                            <span className="spage__where">
                              第 {h.page} 页
                              {h.chapter ? (
                                <span className="spage__chapter">{h.chapter}</span>
                              ) : null}
                            </span>
                            <span className="spage__snippet">
                              {renderSnippet(h.snippet, searchedFor)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>

                    {notShown > 0 ? (
                      <p className="spage__more">
                        {hidden > 0
                          ? `还有 ${notShown} 处没显示（默认只列 ${COLLAPSED_PER_GROUP} 条，点上面「展开全部」看）`
                          : `还有 ${notShown} 处没显示（结果太多，只列前 ${g.hits.length} 处；换个更具体的词能缩小范围）`}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )
      ) : null}
    </div>
  );
}