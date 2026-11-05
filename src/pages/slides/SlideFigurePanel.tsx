import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlideDeck, SlideFigure, Source } from '@/core/model.ts';
import { RenderPageError, renderSourcePage } from '@/core/slides/source-page.ts';
import type { RenderedPage } from '@/core/slides/source-page.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, LoadingState, Notice } from '@/components/states.tsx';
import {
  defaultFigureCaption,
  describeError,
  formatSize,
  hintFrom,
  type Load,
} from './types.ts';

/**
 * 「插入原文页」面板。
 *
 * ## 为什么不做成模态弹层
 *
 * 项目里已有一条约定：`window.confirm` 会阻塞整页，无头验收脚本直接卡死；
 * 页内 modal 又会把「点按钮 → 看结果」这条路径切断（见 P2 GeneratePanel 的注释）。
 * 所以这里也是**就地展开的面板**，插进大纲编辑器上方，操作完自己收起。
 *
 * ## 为什么渲染图文要单独一步
 *
 * 渲染一页约几百毫秒到一秒，且失败原因很具体（页码超范围、PDF 损坏、内存不足）。
 * 如果「插入」按钮一点就同时渲染+落库，用户看不到自己插进去的是哪一页，
 * 出错也只能看到一个总的失败。所以是「填页码 → 渲染预览 → 确认插入」三步，
 * 中间那张缩略图就是「你即将插进去的东西」，所见即所得。
 */

export interface SlideFigurePanelProps {
  deck: SlideDeck;
  /** 插在这一页后面；不传则按 core 的默认位置（封面之后） */
  afterPageId?: string;
  /** 传了就是「换图」：替换这一页已有的截图，图注保留原值可改 */
  replacePageId?: string;
  onDone: (deck: SlideDeck) => void;
  onCancel: () => void;
}

export function SlideFigurePanel({
  deck,
  afterPageId,
  replacePageId,
  onDone,
  onCancel,
}: SlideFigurePanelProps) {
  const { slides, sources: sourceService } = useServices();

  const replacingPage = replacePageId
    ? deck.pages.find((p) => p.id === replacePageId) ?? null
    : null;

  const [sourcesState, setSourcesState] = useState<Load<Source[]>>({ kind: 'loading' });
  const [sourceId, setSourceId] = useState<string | null>(
    replacingPage?.figure?.sourceId ?? deck.sourceId ?? null,
  );
  const [pageText, setPageText] = useState<string>(
    replacingPage?.figure ? String(replacingPage.figure.page) : '',
  );
  /** 选中的资料是否还留着原始字节。null = 正在查 */
  const [storesFile, setStoresFile] = useState<boolean | null>(null);

  const [rendering, setRendering] = useState(false);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [caption, setCaption] = useState(replacingPage?.figure?.caption ?? '');
  /** 用户是否亲手改过图注。没改过时，图注跟着页码自动走。 */
  const [captionTouched, setCaptionTouched] = useState(Boolean(replacingPage?.figure));
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [inserting, setInserting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  /* ---------------- 资料列表 ---------------- */

  useEffect(() => {
    let alive = true;
    sourceService
      .list()
      .then((list) => {
        if (!alive) return;
        setSourcesState({ kind: 'ready', data: list });
        setSourceId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          // 优先挑一份「确实还留着原始文件」的 PDF，否则退回第一份
          const usable = list.find((s) => s.kind === 'pdf' && s.fileStored);
          return usable?.id ?? list[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setSourcesState({
          kind: 'error',
          message: describeError(err),
          hint: '刷新页面重试。资料列表读不出来通常是本地存储的问题，不会影响已经生成的 PPT。',
        });
      });
    return () => {
      alive = false;
    };
  }, [sourceService]);

  /* ---------------- 当前资料有没有原始字节 ---------------- */

  useEffect(() => {
    if (!sourceId) {
      setStoresFile(false);
      return;
    }
    let alive = true;
    setStoresFile(null);
    sourceService
      .hasOriginalFile(sourceId)
      .then((ok) => {
        if (alive) setStoresFile(ok);
      })
      .catch(() => {
        // 查不到就当成没有：宁可让入口明确不可用，也不要让用户点了才报错
        if (alive) setStoresFile(false);
      });
    return () => {
      alive = false;
    };
  }, [sourceService, sourceId]);

  /* 换资料/改页码后，之前那张预览图就不作数了 */
  useEffect(() => {
    setRendered(null);
    setRenderedPage(null);
  }, [sourceId]);

  /* 卸载时取消还在跑的渲染，别让一个关掉的页面继续占 CPU */
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const currentSource = sourcesState.kind === 'ready'
    ? sourcesState.data.find((s) => s.id === sourceId) ?? null
    : null;

  const pageNo = Number.parseInt(pageText, 10);
  const pageValid = Number.isInteger(pageNo) && pageNo >= 1;
  const maxPage = currentSource?.pageCount ?? null;
  const pageOutOfRange = pageValid && maxPage !== null && pageNo > maxPage;

  /* ---------------- 渲染 ---------------- */

  const doRender = useCallback(async () => {
    if (!sourceId || !pageValid) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRendering(true);
    setError(null);
    setRendered(null);
    try {
      const bytes = await sourceService.getOriginalFile(sourceId);
      if (!bytes) {
        setError({
          message: '这份资料的原始文件不在本机了。',
          hint: '可能是导入时超出大小限制、或者被清理过。换一份保留着原始文件的 PDF 试试。',
        });
        return;
      }
      const out = await renderSourcePage(bytes, pageNo, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRendered(out);
      setRenderedPage(pageNo);
      // 图注只在用户没亲手改过的时候跟着页码走，改过就尊重用户的写法
      if (!captionTouched) setCaption(defaultFigureCaption(currentSource?.title ?? '', pageNo));
    } catch (err) {
      // 用户自己取消的不算错误，别弹一个红框吓人
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof RenderPageError) {
        setError({ message: err.message, hint: err.hint });
      } else {
        setError({
          message: describeError(err),
          hint: hintFrom(
            err,
            '这一页没有渲染出来。确认页码没超出范围后重试；如果一直失败，可能是这台机器的浏览器不支持页面渲染。',
          ),
        });
      }
    } finally {
      if (!controller.signal.aborted) setRendering(false);
    }
  }, [sourceId, pageValid, pageNo, sourceService, currentSource?.title, captionTouched]);

  /* ---------------- 插入 / 替换 ---------------- */

  const doInsert = async () => {
    if (!rendered || !sourceId || renderedPage === null) return;
    setInserting(true);
    setError(null);
    try {
      const figure: SlideFigure = {
        sourceId,
        page: renderedPage,
        imageData: rendered.imageData,
        width: rendered.width,
        height: rendered.height,
        caption: caption.trim() || defaultFigureCaption(currentSource?.title ?? '', renderedPage),
      };
      const next = replacePageId
        ? await slides.replaceFigure(deck.id, replacePageId, figure)
        : await slides.addFigurePage(deck.id, figure, afterPageId);
      onDone(next);
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(
          err,
          replacePageId
            ? '图没有换掉。原来的图还在，可以重试一次。'
            : '图文页没有加进去。大纲没有变化，可以重试一次。',
        ),
      });
    } finally {
      setInserting(false);
    }
  };

  /* ---------------- 渲染 ---------------- */

  if (sourcesState.kind === 'loading') return <LoadingState label="正在读取资料列表…" />;
  if (sourcesState.kind === 'error') {
    return (
      <Notice tone="danger" title="读不到资料列表">
        {sourcesState.message}
        <br />
        <strong>下一步：</strong>
        {sourcesState.hint}
      </Notice>
    );
  }

  const pdfSources = sourcesState.data.filter((s) => s.kind === 'pdf');
  const noPdf = pdfSources.length === 0;
  const canRender = !noPdf && storesFile === true && pageValid && !pageOutOfRange && !rendering;

  return (
    <section className="card sl-figure-panel" aria-labelledby="sl-figure-title">
      <div className="card__head">
        <div>
          <h3 className="card__title" id="sl-figure-title">
            {replacePageId ? '换一张原文页' : '插入原文页'}
          </h3>
          <p className="card__subtitle">
            把资料里的某一页原样截成图片贴进 PPT。图和原文是同一页，学生翻书就能对上。
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={inserting}>
          取消
        </button>
      </div>

      <div className="card__body page__stack">
        {noPdf ? (
          <Notice tone="warning" title="没有可以截图的资料">
            图文页需要 PDF 原文。这个学习库里还没有 PDF 资料，先去「资料库」导入一份。
          </Notice>
        ) : null}

        <div className="sl-figure-panel__grid">
          <div className="field">
            <label className="field__label" htmlFor="sl-figure-source">
              取哪份资料
            </label>
            <select
              className="select"
              id="sl-figure-source"
              value={sourceId ?? ''}
              disabled={rendering || inserting}
              onChange={(event) => setSourceId(event.target.value || null)}
            >
              {pdfSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                  {source.pageCount !== null ? `（${source.pageCount} 页）` : ''}
                  {source.fileStored ? '' : ' · 无原始文件'}
                </option>
              ))}
            </select>
            <div className="field__hint">
              只有 PDF 能截取原文页。DOCX / PPTX / 粘贴文本没有固定的分页，截不出「第几页」。
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="sl-figure-page">
              第几页
            </label>
            <div className="sl-figure-panel__page">
              <input
                className="input"
                id="sl-figure-page"
                type="number"
                min={1}
                max={maxPage ?? undefined}
                placeholder="例如 3"
                value={pageText}
                disabled={rendering || inserting}
                onChange={(event) => setPageText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canRender) void doRender();
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={!canRender}
                title={
                  noPdf
                    ? '没有 PDF 资料可以截图'
                    : storesFile === false
                      ? '这份资料导入时没有保留原始文件'
                      : pageOutOfRange
                        ? `这份资料只有 ${maxPage} 页`
                        : !pageValid
                          ? '先填一个从 1 开始的页码'
                          : '渲染这一页的预览'
                }
                onClick={() => void doRender()}
              >
                {rendering ? '渲染中…' : '渲染预览'}
              </button>
            </div>
            <div className="field__hint">
              {maxPage !== null ? `这份资料共 ${maxPage} 页。` : '页码从 1 开始。'}
              {pageOutOfRange ? (
                <span className="field__error">超过了总页数，渲染会失败。</span>
              ) : null}
            </div>
          </div>
        </div>

        {storesFile === false && !noPdf ? (
          <Notice tone="warning" title="这份资料没有保留原始文件">
            导入时只存了解析出来的文字，没有留下 PDF 本身，所以截不出原文页。换一份 PDF，或者重新导入一次这份资料。
          </Notice>
        ) : null}

        {rendering ? (
          <div className="sl-figure-panel__rendering" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>正在渲染第 {pageNo} 页…（一页通常要几百毫秒）</span>
          </div>
        ) : null}

        {error ? (
          <Notice tone="danger" title="这一页没有渲染出来">
            {error.message}
            <br />
            <strong>下一步：</strong>
            {error.hint}
          </Notice>
        ) : null}

        {rendered && renderedPage !== null ? (
          <>
            <div className="sl-figure-panel__preview">
              <img
                className="sl-figure-panel__thumb"
                src={rendered.imageData}
                alt={`原文第 ${renderedPage} 页的截图预览`}
              />
              <div className="sl-figure-panel__meta">
                <Badge tone="ready">已渲染</Badge>
                <span>
                  第 {renderedPage} 页 · {rendered.width} × {rendered.height} px ·{' '}
                  {formatSize(base64Bytes(rendered.imageData))}
                </span>
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="sl-figure-caption">
                图注
              </label>
              <input
                className="input"
                id="sl-figure-caption"
                type="text"
                value={caption}
                disabled={inserting}
                placeholder={defaultFigureCaption(currentSource?.title ?? '', renderedPage)}
                onChange={(event) => {
                  setCaption(event.target.value);
                  setCaptionTouched(true);
                }}
              />
              <div className="field__hint">
                图注显示在图片正下方，也是这一页在大纲里的标题。默认「《资料名》第 N 页」，改不改都行。
              </div>
            </div>
          </>
        ) : null}

        <div className="sl-figure-panel__footer">
          <div className="page__muted">
            {rendered
              ? `准备插入：第 ${renderedPage} 页${replacePageId ? '（替换这一页现有的图）' : ''}`
              : '渲染出预览后再插入，插进去的就是你看到的这张图。'}
          </div>
          <div className="page__row">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={inserting}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!rendered || inserting}
              title={!rendered ? '先渲染出预览' : replacePageId ? '用这张图替换' : '插入一页图文页'}
              onClick={() => void doInsert()}
            >
              {inserting ? '正在保存…' : replacePageId ? '换成这张' : '插入图文页'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** data URL 的实际字节数（base64 每 4 个字符 3 字节），用来告诉用户备份会变大多少 */
function base64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const body = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body * 3) / 4) - padding);
}
