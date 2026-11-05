import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SlideDeck } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, EmptyState, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { SlideDetail } from './SlideDetail.tsx';
import { SlideGenerate } from './SlideGenerate.tsx';
import {
  deckBulletStats,
  deleteConfirmText,
  describeError,
  editedAfterLastExport,
  formatTime,
  hintFrom,
  lastExport,
  type Flash,
  type Load,
} from './types.ts';
import './slides.css';

/**
 * 学习 PPT 页（P4）。
 *
 * 列表和详情用状态切换，不做子路由：注册表里只有 `/slides` 一条路由，
 * 加子路由要改注册表结构，而注册表是四个页面共用的。
 * 这和资料库、知识点、习题集三页的做法一致。
 *
 * 生成面板常驻在列表上方，默认按「列表是不是空的」决定展开：
 * 第一次进来没有 PPT，直接看到生成流程；已经有了就收起来，把列表让出来。
 */

type View = { kind: 'list' } | { kind: 'detail'; deckId: string };

export function SlidesPage() {
  const { slides } = useServices();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [decksState, setDecksState] = useState<Load<SlideDeck[]>>({ kind: 'loading' });
  const [flash, setFlash] = useState<Flash>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState<boolean | null>(null);
  const generateRef = useRef<HTMLDivElement | null>(null);

  const loadDecks = useCallback(async () => {
    try {
      const list = await slides.list();
      setDecksState({ kind: 'ready', data: list });
    } catch (err) {
      setDecksState({
        kind: 'error',
        message: describeError(err),
        hint: 'PPT 列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘已满。',
      });
    }
  }, [slides]);

  useEffect(() => {
    void loadDecks();
  }, [loadDecks]);

  const decks = decksState.kind === 'ready' ? decksState.data : [];
  const open = generateOpen ?? decks.length === 0;

  const expandGenerate = () => {
    setGenerateOpen(true);
    window.setTimeout(() => {
      generateRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
  };

  const removeDeck = async (deck: SlideDeck) => {
    const ok = window.confirm(deleteConfirmText(deck));
    if (!ok) return;
    setRemovingId(deck.id);
    setFlash(null);
    try {
      await slides.remove(deck.id);
      if (view.kind === 'detail' && view.deckId === deck.id) setView({ kind: 'list' });
      await loadDecks();
      setFlash({ tone: 'info', text: `已删除「${deck.title}」` });
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `删除没有完成：${describeError(err)}。${hintFrom(err, '可以刷新后重试；若仍失败，检查本地存储是否可用。')}`,
      });
    } finally {
      setRemovingId(null);
    }
  };

  if (decksState.kind === 'loading') return <LoadingState label="正在读取学习 PPT…" />;
  if (decksState.kind === 'error') {
    return (
      <ErrorState
        title="读不到学习 PPT"
        message={decksState.message}
        hint={decksState.hint}
        onRetry={() => void loadDecks()}
      />
    );
  }

  if (view.kind === 'detail') {
    return (
      <SlideDetail
        deckId={view.deckId}
        onBack={() => setView({ kind: 'list' })}
        onChanged={() => void loadDecks()}
      />
    );
  }

  const totalPages = decks.reduce((n, d) => n + d.pages.length, 0);

  return (
    <div className="page page__stack sl-page">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">学习 PPT</h2>
          <p className="page__summary">
            从知识点生成可编辑的幻灯片。每条要点都带着原文角标，讲课翻到哪一页都能点回教材。
          </p>
        </div>
        <div className="page__head-side">
          <Badge tone="neutral">P4</Badge>
          <Badge tone="ready">可用</Badge>
        </div>
      </header>

      {/* 两个入口：这里就是「学习 PPT」这一栏，另一栏回资料库/知识点去选料 */}
      <nav className="sl-tabs" aria-label="课件与学习 PPT">
        <span className="sl-tabs__item sl-tabs__item--active" aria-current="page">
          学习 PPT（{decks.length}）
        </span>
        <Link className="sl-tabs__item" to="/sources">
          课件 / 讲义
        </Link>
        <Link className="sl-tabs__item" to="/knowledge">
          知识点
        </Link>
      </nav>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <div className="sl-toolbar">
        <div className="sl-toolbar__stats">
          共 <strong>{decks.length}</strong> 份 · 合计 <strong>{totalPages}</strong> 页大纲
          {generateOpen === false || decks.length > 0 ? null : <span>（还没有 PPT，先从下面生成一份）</span>}
        </div>
        <div className="page__row">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => (open ? setGenerateOpen(false) : expandGenerate())}
          >
            {open ? '收起生成面板' : '生成新 PPT'}
          </button>
        </div>
      </div>

      <div ref={generateRef}>
        {open ? (
          <SlideGenerate
            onCancel={() => setGenerateOpen(false)}
            onCreated={(deck) => {
              setGenerateOpen(false);
              setFlash({
                tone: 'info',
                text: `已生成「${deck.title}」，共 ${deck.pages.length} 页大纲。下面可以直接改。`,
              });
              void loadDecks();
              setView({ kind: 'detail', deckId: deck.id });
            }}
          />
        ) : (
          <div className="card sl-collapsed">
            <div className="sl-collapsed__main">
              <div className="sl-collapsed__title">想再做一份？</div>
              <div className="sl-collapsed__desc">
                选一份资料、勾选知识点，就能再生成一份大纲。只有定位到原文的知识点会带角标。
              </div>
            </div>
            <button type="button" className="btn" onClick={expandGenerate}>
              生成新 PPT
            </button>
          </div>
        )}
      </div>

      <section className="page__stack">
        <h3 className="page__section-title">我的学习 PPT（{decks.length}）</h3>
        {decks.length === 0 ? (
          <div className="card">
            <EmptyState
              title="还没有学习 PPT"
              description="选一份资料、勾选里面的知识点，就能生成一份可以改、可以导出 .pptx 的大纲。知识点得先定位到原文，导出的角标才点得回教材。"
              actions={
                <>
                  <Link className="btn" to="/sources">
                    去资料库
                  </Link>
                  <Link className="btn btn--ghost" to="/knowledge">
                    去知识点
                  </Link>
                </>
              }
            />
          </div>
        ) : (
          <ul className="sl-list">
            {decks.map((deck) => (
              <DeckRow
                key={deck.id}
                deck={deck}
                removing={removingId === deck.id}
                onOpen={() => setView({ kind: 'detail', deckId: deck.id })}
                onRemove={() => void removeDeck(deck)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DeckRow({
  deck,
  removing,
  onOpen,
  onRemove,
}: {
  deck: SlideDeck;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const stats = useMemo(() => deckBulletStats(deck), [deck]);
  const latest = lastExport(deck);
  const stale = editedAfterLastExport(deck);

  return (
    <li className="card sl-row">
      <div className="sl-row__main">
        <div className="sl-row__head">
          <button type="button" className="sl-row__title" onClick={onOpen} disabled={removing}>
            {deck.title}
          </button>
          <Badge tone={deck.status === 'ready' ? 'ready' : 'neutral'}>
            {deck.status === 'ready' ? '已定稿' : '大纲'}
          </Badge>
          {stale ? <Badge tone="danger">导出后改过</Badge> : null}
        </div>

        <div className="sl-row__meta">
          <span>{deck.pages.length} 页大纲</span>
          <span className="sl-row__dot" aria-hidden="true">
            ·
          </span>
          <span>{stats.bullets} 条要点</span>
          <span className="sl-row__dot" aria-hidden="true">
            ·
          </span>
          <span>{stats.withCitation} 条带出处</span>
          {stats.withoutCitation > 0 ? (
            <>
              <span className="sl-row__dot" aria-hidden="true">
                ·
              </span>
              <span className="sl-row__warn">{stats.withoutCitation} 条没有出处</span>
            </>
          ) : null}
        </div>

        <div className="sl-row__note">
          {latest
            ? `导出过 ${deck.exports.length} 次，最近一次 ${formatTime(latest.exportedAt)}（${latest.fileName}）`
            : '还没导出过'}
          <span className="sl-row__dot" aria-hidden="true">
            ·
          </span>
          更新于 {formatTime(deck.updatedAt)}
        </div>
      </div>

      <div className="sl-row__side">
        <button type="button" className="btn" onClick={onOpen} disabled={removing}>
          打开
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={onRemove}
          disabled={removing}
          title="删除这份 PPT（会二次确认）"
        >
          {removing ? '正在删除…' : '删除'}
        </button>
      </div>
    </li>
  );
}
