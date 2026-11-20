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

          {result.total === 0 ? (
            <p className="gsearch__empty">
              换个词试试，或者先确认资料已经解析出正文（「资料」页能看到段数）。
            </p>
          ) : (
            <ul className="gsearch__groups">
              {result.groups.map((g) => (
                <li key={g.sourceId} className="gsearch__group">
                  {/*
                    按资料分组（组头是书名）。
                    不分组的话 500 条结果平铺，用户分不清哪条来自哪本书 ——
                    而「在哪本书里」正是这次搜索要回答的问题。
                  */}
                  <p className="gsearch__group-head">
                    <span className="gsearch__source">{g.sourceTitle}</span>
                    <span className="gsearch__count">{g.count} 处</span>
                  </p>
                  <ul className="gsearch__hits">
                    {g.hits.map((h, i) => (
                      <li key={`${h.segmentId}:${h.charStart}:${i}`}>
                        <button
                          type="button"
                          className="gsearch__hit"
                          onClick={() => pick(h)}
                          title="跳到这一句"
                        >
                          <span className="gsearch__where">
                            第 {h.page} 页
                            {h.chapter ? <span className="gsearch__chapter">{h.chapter}</span> : null}
                          </span>
                          <span className="gsearch__snippet">
                            {renderSnippet(h.snippet, searchedFor)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}