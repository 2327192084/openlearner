import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlideDeck } from '@/core/model.ts';
import type { RenderSlide } from '@/core/slides/render-plan.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { SlideExport } from './SlideExport.tsx';
import { SlideOutline } from './SlideOutline.tsx';
import { SlidePreview } from './SlidePreview.tsx';
import {
  deckBulletStats,
  describeError,
  editedAfterLastExport,
  figurePageCount,
  formatTime,
  hintFrom,
  lastExport,
} from './types.ts';

/**
 * 一份 PPT 的详情页：大纲编辑 → 预览 → 导出，三块从上到下排。
 *
 * 为什么不做成页签：这三块互相印证。
 * 改了大纲要立刻能在预览里看到，预览里数出来的页数要和导出记录对得上。
 * 藏进页签之后，「预览 12 页、导出 14 页」这类问题会被页签挡住，
 * 而它恰好是这一阶段最容易出的 bug。
 *
 * 页面最上面那个标题输入框是 PPT 标题：改动会防抖保存（500ms）并在失焦时立即落库。
 * 只靠失焦不够——用户改完直接点别的地方、或者焦点本来就在别处时不会触发，
 * 改完没保存比不让人改更糟。
 */

export interface SlideDetailProps {
  deckId: string;
  onBack: () => void;
  /** 任何写入后刷新列表页的元信息（页数、更新时间） */
  onChanged: () => void;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; deck: SlideDeck };

export function SlideDetail({ deckId, onBack, onChanged }: SlideDetailProps) {
  const { slides } = useServices();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [plan, setPlan] = useState<RenderSlide[]>([]);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const deck = state.kind === 'ready' ? state.deck : null;

  /** 把最新 deck 写进 state，并同时重建渲染计划（预览就是计划本身） */
  const applyDeck = useCallback(
    async (next: SlideDeck) => {
      setState({ kind: 'ready', deck: next });
      try {
        const fresh = await slides.getPlan(next.id);
        setPlan(fresh);
      } catch {
        // 计划读不出来不影响编辑，预览区自己会显示空态；
        // 这里不再叠一层错误，否则用户改一个字就弹一次错。
        setPlan([]);
      }
    },
    [slides],
  );

  const load = useCallback(async () => {
    try {
      const found = await slides.get(deckId);
      if (!found) {
        setState({
          kind: 'error',
          message: '这份 PPT 已经不在了。',
          hint: '它可能刚被删除，或者在另一个窗口里被删了。返回列表重新选一份。',
        });
        return;
      }
      setState({ kind: 'ready', deck: found });
      if (found.title !== titleDraft) {
        setTitleDraft(found.title);
        titleDraftRef.current = found.title;
      }
      const freshPlan = await slides.getPlan(deckId);
      setPlan(freshPlan);
    } catch (err) {
      setState({
        kind: 'error',
        message: describeError(err),
        hint: '刷新页面重试；若提示存储不可用，检查是否在无痕模式或磁盘已满。',
      });
    }
    // titleDraft 故意不进依赖：它只是用来初始化输入框，变化不该触发重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, slides]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------- 标题保存：防抖 + 失焦双保险 ---------------- */

  const savedTitleRef = useRef('');
  const titleTimerRef = useRef<number | null>(null);
  // 输入框里最新的值。失焦保存读这个，而不是读 state：
  // blur 回调闭包里的 titleDraft 可能还是上一次渲染的旧值，
  // 那样会把「刚改的新标题」当成「没改」直接跳过。
  const titleDraftRef = useRef('');

  useEffect(() => {
    savedTitleRef.current = deck?.title ?? '';
  }, [deck?.title]);

  useEffect(
    () => () => {
      if (titleTimerRef.current !== null) window.clearTimeout(titleTimerRef.current);
    },
    [],
  );

  const commitTitle = useCallback(
    async (value: string) => {
      if (!deck) return;
      const trimmed = value.trim();
      // 空标题不提交：core 会保留原标题，界面也不该存一个空串进去
      if (trimmed === '' || trimmed === savedTitleRef.current) return;
      try {
        const next = await slides.updateTitle(deck.id, trimmed);
        savedTitleRef.current = next.title;
        // 存的是去掉首尾空白的版本，让输入框和存储一致（不然「已保存」和眼前文字对不上）
        if (next.title !== titleDraftRef.current) {
          titleDraftRef.current = next.title;
          setTitleDraft(next.title);
        }
        setState({ kind: 'ready', deck: next });
        onChanged();
      } catch (err) {
        setError({
          message: describeError(err),
          hint: hintFrom(err, '标题没有保存。可以再改一次；若一直失败，刷新页面后重试。'),
        });
      }
    },
    [deck, slides, onChanged],
  );

  const scheduleTitleSave = (value: string) => {
    setTitleDraft(value);
    titleDraftRef.current = value;
    if (titleTimerRef.current !== null) window.clearTimeout(titleTimerRef.current);
    titleTimerRef.current = window.setTimeout(() => {
      titleTimerRef.current = null;
      void commitTitle(value);
    }, 500);
  };

  const flushTitleSave = () => {
    if (titleTimerRef.current !== null) {
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    void commitTitle(titleDraftRef.current);
  };

  /* ---------------- 定稿 ---------------- */

  const confirmDeck = async () => {
    if (!deck || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await slides.confirm(deck.id);
      await applyDeck(next);
      onChanged();
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(err, '状态没有改。刷新页面后重试。'),
      });
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading') return <LoadingState label="正在读取这份 PPT…" />;
  if (state.kind === 'error') {
    return (
      <ErrorState
        title="打不开这份 PPT"
        message={state.message}
        hint={state.hint}
        onRetry={() => void load()}
        retryLabel="重新读取"
      />
    );
  }

  const current = state.deck;
  const bulletStats = deckBulletStats(current);
  const stale = editedAfterLastExport(current);
  const latest = lastExport(current);
  const noCitation = bulletStats.withoutCitation;
  const figures = figurePageCount(current);

  return (
    <div className="page page__stack sl-detail">
      <div className="sl-detail__topbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← 返回 PPT 列表
        </button>
        <div className="page__row">
          <Badge tone={current.status === 'ready' ? 'ready' : 'neutral'}>
            {current.status === 'ready' ? '已定稿' : '大纲阶段'}
          </Badge>
          <span className="page__muted">共 {current.pages.length} 页大纲</span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || current.status === 'ready'}
            onClick={() => void confirmDeck()}
            title="只是标记状态，之后仍然可以继续编辑"
          >
            {current.status === 'ready' ? '已定稿' : '标记为已定稿'}
          </button>
        </div>
      </div>

      <div className="sl-detail__head">
        <div className="field sl-detail__title-field">
          <label className="field__label" htmlFor="sl-deck-title">
            PPT 标题
          </label>
          <input
            className="input sl-detail__title-input"
            id="sl-deck-title"
            type="text"
            value={titleDraft}
            disabled={busy}
            onChange={(event) => scheduleTitleSave(event.target.value)}
            onBlur={flushTitleSave}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <div className="field__hint">
            改完自动保存（停手半秒就存，离开输入框也会存）。更新于 {formatTime(current.updatedAt)}
          </div>
        </div>
        <div className="sl-detail__numbers">
          <div className="sl-detail__number">
            <span className="sl-detail__number-value">{current.pages.length}</span>
            <span className="sl-detail__number-label">页大纲</span>
          </div>
          <div className="sl-detail__number">
            <span className="sl-detail__number-value">{bulletStats.bullets}</span>
            <span className="sl-detail__number-label">条要点</span>
          </div>
          <div className="sl-detail__number">
            <span className="sl-detail__number-value">{bulletStats.withCitation}</span>
            <span className="sl-detail__number-label">条带出处</span>
          </div>
          <div className="sl-detail__number">
            <span className="sl-detail__number-value">{figures}</span>
            <span className="sl-detail__number-label">页原文截图</span>
          </div>
          <div className="sl-detail__number">
            <span className="sl-detail__number-value">{plan.length}</span>
            <span className="sl-detail__number-label">页导出</span>
          </div>
        </div>
      </div>

      {noCitation > 0 ? (
        <Notice tone="warning" title={`${noCitation} 条要点没有出处`}>
          这些知识点没有定位到原文，导出的 PPT 里它们不会带角标，学生点不回原文。
          想要它们也能点，去「知识点」页把位置补上，然后重新生成一份大纲。
        </Notice>
      ) : null}

      {stale && latest ? (
        <Notice tone="warning" title="导出后又改过，当前文件不是最新的">
          最近一次导出是 {formatTime(latest.exportedAt)}，之后大纲又改过。要给学生的版本请重新导出。
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title="这次操作没有完成">
          {error.message}
          <br />
          <strong>下一步：</strong>
          {error.hint}
        </Notice>
      ) : null}

      <section className="page__stack">
        <h3 className="page__section-title">大纲</h3>
        <p className="page__muted sl-detail__section-note">
          左边选页，右边改内容。每个字段失焦即保存。封面页固定在第一页，不能删除也不能移动。
          想放原文那一页的图，用左边的「插入原文页」把它截进来。
        </p>
        <SlideOutline
          deck={current}
          onDeck={(next) => {
            void applyDeck(next);
            onChanged();
          }}
        />
      </section>

      <section className="page__stack">
        <h3 className="page__section-title">预览</h3>
        <p className="page__muted sl-detail__section-note">
          这里按导出的同一份渲染计划画出来，页数就是导出后的页数。点角标看原文。
        </p>
        <SlidePreview deck={current} plan={plan} />
      </section>

      <SlideExport
        deck={current}
        onDeck={(next) => {
          void applyDeck(next);
          onChanged();
        }}
      />
    </div>
  );
}
