/**
 * 文档解析页（2026-11-11）。
 *
 * ## 为什么单独一页
 *
 * 用户反馈：「我刚刚对一份资料解析了两页，后续想要继续解析时没有入口了。
 * 这个解析应该单独做一个入口，但是整理知识点的这个入口也不用删，
 * 可以提醒用户进行解析。」
 *
 * 根因是 `ConvertPanel` 原来只在 `needsConversion()` 为真时渲染 ——
 * 解析 2 页之后 textStatus 变成 ready，面板整个消失，没有入口继续解析。
 * 而我在上一轮刚把分片解析改成「合并」，正是为了支持「分几次凑齐整本」——
 * 结果入口没了，这个能力等于用不上。
 *
 * ## 与「整理知识点」的分工
 *
 * 两页都保留，职责不同：
 *  - 本页：只管「把 PDF/图片变成正文」这件事
 *  - 整理页：只管「把正文变成知识点」
 *
 * 整理页仍会在需要补正文时内嵌一块解析面板（不打断流程），
 * 但同时给一句「也可以到『文档解析』页慢慢解析」的提醒，
 * 让用户知道有更合适的入口。这比把两件事塞进一页清楚。
 *
 * ## 为什么单独一个文件
 *
 * `App.tsx` 已 1900+ 行（硬约束 5：新增 UI 一律独立文件）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { needsConversion } from '@/core/mineru/convert.ts';
import { ConvertPanel } from './ConvertPanel.tsx';
import { EmptyCard } from './EmptyCard.tsx';
import { IconSources } from './icons.tsx';
import './parse-page.css';

export interface ParsePageProps {
  sourceService: SourceService;
  /** 进来时默认选中的资料（从资料页跳来时用） */
  initialSourceId?: string | null;
  /** 去看这份资料的原文 */
  onOpenReader?: (sourceId: string) => void;
  /** 去「整理知识点」页 */
  onOpenOrganize?: (sourceId: string) => void;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sources: Source[] };

export function ParsePage({
  sourceService,
  initialSourceId,
  onOpenReader,
  onOpenOrganize,
}: ParsePageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [picked, setPicked] = useState<string | null>(initialSourceId ?? null);

  const load = useCallback(async () => {
    try {
      const sources = await sourceService.list();
      setState({ kind: 'ready', sources });
      /* 没指定也没选过时，默认选第一份 —— 让页面一进来就能用 */
      setPicked((prev) => prev ?? sources[0]?.id ?? null);
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出资料列表',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 外部指定了资料时跟过去（从别处跳进来） */
  useEffect(() => {
    if (initialSourceId) setPicked(initialSourceId);
  }, [initialSourceId]);

  const sources = state.kind === 'ready' ? state.sources : [];
  const current = useMemo(
    () => sources.find((s) => s.id === picked) ?? null,
    [sources, picked],
  );

  /**
   * 排序：**还没解析完的排前面**。
   *
   * 这一页的主要用途就是「补正文」，所以待办的应该在最上面。
   * 已经 ready 的排后面（它们只是「想再解析几页」时才会用到）。
   */
  const ordered = useMemo(() => {
    const pending = sources.filter((s) => needsConversion(s.textStatus, s.kind));
    const done = sources.filter((s) => !needsConversion(s.textStatus, s.kind));
    return [...pending, ...done];
  }, [sources]);

  if (state.kind === 'loading') {
    return (
      <div className="parse-page">
        <p className="pp-hint">正在读资料…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="parse-page">
        <p className="pp-error">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="parse-page">
      <header className="pp-head">
        <h1 className="pp-title">文档解析</h1>
        <p className="pp-lead">
          把 PDF 或图片里的文字识别成正文。解析后的正文可以整理成知识点、逐页对照原文。
          大书可以分几次解析 —— 新解析的页会合并进来，已解析的不会丢。
        </p>
      </header>

      {sources.length === 0 ? (
        <EmptyCard
          icon={<IconSources size={22} />}
          title="还没有资料"
          hint="先到「资料」页导入一份 PDF 或图片，再回来这里解析。"
        />
      ) : (
        <>
          {/* ---- 选资料 ---- */}
          <fieldset className="pp-field">
            <legend className="pp-legend">选资料</legend>
            <div className="pp-sources">
              {ordered.map((s) => {
                const needs = needsConversion(s.textStatus, s.kind);
                const on = s.id === picked;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`pp-source${on ? ' pp-source--on' : ''}`}
                    onClick={() => setPicked(s.id)}
                    title={needs ? '还没有正文，需要解析' : '已有正文'}
                  >
                    <span className="pp-source__name">{s.title}</span>
                    <span className="pp-source__meta">
                      {needs ? (
                        <span className="pp-badge pp-badge--todo">待解析</span>
                      ) : (
                        <span className="pp-badge pp-badge--done">
                          {s.segmentCount ?? 0} 段
                        </span>
                      )}
                      {s.pageCount ? <span className="pp-source__pages">{s.pageCount} 页</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* ---- 解析面板 ---- */}
          {current ? (
            <div className="pp-panel">
              {/*
                alwaysShow：即使已有正文也要显示面板。
                这正是用户报的那个问题的修法 ——
                解析过 2 页之后仍然要能接着解析。
              */}
              <ConvertPanel
                source={current}
                sourceService={sourceService}
                alwaysShow
                onConverted={() => void load()}
                {...(onOpenReader
                  ? { onOpenPage: () => onOpenReader(current.id) }
                  : {})}
              />
            </div>
          ) : null}

          {/* ---- 下一步 ---- */}
          {current ? (
            <div className="pp-next">
              <p className="pp-next__lead">
                {needsConversion(current.textStatus, current.kind)
                  ? '解析出正文之后，就可以去整理知识点了。'
                  : '正文已就绪，可以去看原文，或整理成知识点。'}
              </p>
              <div className="pp-next__actions">
                {onOpenReader ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onOpenReader(current.id)}
                  >
                    看原文
                  </button>
                ) : null}
                {onOpenOrganize ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onOpenOrganize(current.id)}
                  >
                    去整理知识点
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
