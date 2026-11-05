import { useCallback, useEffect, useState } from 'react';
import type { SlideDeck, SlideOutlinePage } from '@/core/model.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge, Notice } from '@/components/states.tsx';
import {
  describeError,
  hintFrom,
  isPinnedPage,
  layoutLabel,
  layoutTone,
  pageStats,
} from './types.ts';

/**
 * 大纲编辑页。
 *
 * 布局是「左边页列表 + 右边当前页编辑」，因为在编辑一页的时候，
 * 上移/下移/在页后加页这些动作需要看到全局顺序 —— 单页卡片流看不到。
 *
 * 三条界面规则，都是为了让用户不会误以为自己在改一份文档：
 *  1. 每个可编辑字段都是**失焦才保存**，并且在保存过程中禁用，避免连点改出两次写。
 *  2. 封面页的「删除」「上移」「下移」按钮一律渲染但禁用 + 写明原因。
 *     隐藏按钮会让人以为这一页本来就没有这些操作，而实际上它是特例。
 *  3. 每页都显示「N 条要点，其中 M 条有出处」——「有出处」是这份产品的核心卖点，
 *     看不见它的地方就等于没有。
 */

export interface SlideOutlineProps {
  deck: SlideDeck;
  /** 任何一次写操作成功后，把最新的 deck 交给上层（上层据此刷新预览与导出区） */
  onDeck: (deck: SlideDeck) => void;
}

export function SlideOutline({ deck, onDeck }: SlideOutlineProps) {
  const { slides } = useServices();
  const [selectedId, setSelectedId] = useState<string | null>(deck.pages[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 页被删掉后选中项会失效，退回第一页而不是留下一个指向空白的编辑区
  useEffect(() => {
    if (selectedId && deck.pages.some((p) => p.id === selectedId)) return;
    setSelectedId(deck.pages[0]?.id ?? null);
  }, [deck.pages, selectedId]);

  const run = useCallback(
    async (action: () => Promise<SlideDeck>, fallbackHint: string, message?: string) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const fresh = await action();
        onDeck(fresh);
        if (message) setNote(message);
        return true;
      } catch (err) {
        setError({ message: describeError(err), hint: hintFrom(err, fallbackHint) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onDeck],
  );

  const page = deck.pages.find((p) => p.id === selectedId) ?? null;
  const pageIndex = page ? deck.pages.indexOf(page) : -1;
  const pinned = page ? isPinnedPage(page.layout) : false;

  return (
    <div className="sl-outline">
      <div className="sl-outline__col">
        <div className="sl-outline__col-head">
          <strong>页（{deck.pages.length}）</strong>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => slides.addPage(deck.id),
                '新页没有加进去。刷新页面后重试。',
                '已在末尾加了一页，接着点「在页后加页」可以插到指定页后面。',
              )
            }
          >
            ＋ 末尾加页
          </button>
        </div>
        <ol className="sl-outline__pages">
          {deck.pages.map((item, index) => {
            const stats = pageStats(deck, item.id);
            const active = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`sl-outline__page${active ? ' sl-outline__page--active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="sl-outline__page-top">
                    <span className="sl-outline__page-no">{index + 1}</span>
                    <Badge tone={layoutTone(item.layout)}>{layoutLabel(item.layout)}</Badge>
                  </span>
                  <span className="sl-outline__page-title">{item.title || '（无标题）'}</span>
                  <span className="sl-outline__page-stats">
                    {item.layout === 'bullets'
                      ? `${stats.bullets} 条要点，其中 ${stats.withCitation} 条有出处`
                      : item.layout === 'title'
                        ? '封面页'
                        : item.layout === 'section'
                          ? '章节分隔页'
                          : '资料页'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="sl-outline__editor">
        {error ? (
          <Notice tone="danger" title="这次修改没有保存">
            {error.message}
            <br />
            <strong>下一步：</strong>
            {error.hint}
          </Notice>
        ) : null}
        {note ? <Notice tone="info">{note}</Notice> : null}

        {page ? (
          <PageEditor
            key={page.id}
            deck={deck}
            page={page}
            index={pageIndex}
            busy={busy}
            pinned={pinned}
            onMove={(direction) =>
              void run(
                () => slides.movePage(deck.id, page.id, direction),
                '页没有移动。可能是已经到头了，或者恰好碰到封面页。',
                `${direction === -1 ? '上移' : '下移'}完成。`,
              )
            }
            onDelete={() =>
              void run(
                () => slides.removePage(deck.id, page.id),
                '这一页没有删除。如果是封面页，请改标题而不是删掉它。',
                '这一页已删除，它用不到的角标也一起清掉了。',
              )
            }
            onAddAfter={() =>
              void run(
                () => slides.addPage(deck.id, page.id),
                '新页没有加进去。刷新页面后重试。',
                '已在这一页后面加了一页空白的要点页。',
              )
            }
            onPatchTitle={(value) =>
              void run(
                () => slides.updatePageTitle(deck.id, page.id, value),
                '标题没有保存。可以再改一次，或者刷新页面后重试。',
              )
            }
            onPatchSubtitle={(value) =>
              void run(
                () => slides.updatePageSubtitle(deck.id, page.id, value),
                '副标题没有保存。可以再改一次，或者刷新页面后重试。',
              )
            }
            onPatchBullet={(bulletId, value) =>
              void run(
                () => slides.updateBulletText(deck.id, page.id, bulletId, value),
                '这条要点没有保存。可以再改一次，或者刷新页面后重试。',
              )
            }
            onAddBullet={(value) =>
              void run(
                () => slides.addBullet(deck.id, page.id, value),
                '要点没有加进去。确认这一页是「要点」版式，并且内容不是空的。',
                '已加了一条要点。它现在没有角标，因为它是新写的、还没有对应的原文位置。',
              )
            }
            onRemoveBullet={(bulletId) =>
              void run(
                () => slides.removeBullet(deck.id, page.id, bulletId),
                '这条要点没有删除。刷新页面后重试。',
              )
            }
          />
        ) : (
          <div className="empty">
            <div className="empty__title">这份大纲是空的</div>
            <div className="empty__desc">先加一页再编辑。</div>
          </div>
        )}
      </div>
    </div>
  );
}

interface PageEditorProps {
  deck: SlideDeck;
  page: SlideOutlinePage;
  index: number;
  busy: boolean;
  pinned: boolean;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onAddAfter: () => void;
  onPatchTitle: (value: string) => void;
  onPatchSubtitle: (value: string) => void;
  onPatchBullet: (bulletId: string, value: string) => void;
  onAddBullet: (value: string) => void;
  onRemoveBullet: (bulletId: string) => void;
}

function PageEditor({
  deck,
  page,
  index,
  busy,
  pinned,
  onMove,
  onDelete,
  onAddAfter,
  onPatchTitle,
  onPatchSubtitle,
  onPatchBullet,
  onAddBullet,
  onRemoveBullet,
}: PageEditorProps) {
  const stats = pageStats(deck, page.id);
  const isFirst = index === 0;
  const isLast = index === deck.pages.length - 1;
  const canMoveUp = !pinned && !isFirst;
  const canMoveDown = !pinned && !isLast;
  const canDelete = !pinned;
  const [draftBullet, setDraftBullet] = useState('');

  const moveUpReason = pinned
    ? '封面页固定在第一页，不能移动'
    : isFirst
      ? '已经是第一页了'
      : null;
  const moveDownReason = pinned
    ? '封面页固定在第一页，不能移动'
    : isLast
      ? '已经是最后一页了'
      : null;

  return (
    <div className="page__stack">
      <div className="sl-page-head">
        <div className="sl-page-head__main">
          <Badge tone={layoutTone(page.layout)}>{layoutLabel(page.layout)}</Badge>
          <span className="page__muted">
            第 {index + 1} 页 / 共 {deck.pages.length} 页
          </span>
        </div>
        <div className="page__row">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || !canMoveUp}
            title={moveUpReason ?? '与上一页交换位置'}
            onClick={() => onMove(-1)}
          >
            上移
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || !canMoveDown}
            title={moveDownReason ?? '与下一页交换位置'}
            onClick={() => onMove(1)}
          >
            下移
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={onAddAfter}
            title="在这一页后面插入一页空白要点页"
          >
            在页后加页
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={busy || !canDelete}
            title={canDelete ? '删除这一页' : '封面页不能删除。如果想换标题，直接改封面页的标题文字。'}
            onClick={onDelete}
          >
            删除本页
          </button>
        </div>
      </div>

      {pinned ? (
        <div className="sl-page-head__note">
          封面页固定在第一页，不能删除也不能移动。想换标题就直接改下面的「标题」；想加内容就用「在页后加页」。
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor={`sl-page-title-${page.id}`}>
          本页标题
        </label>
        <input
          className="input"
          id={`sl-page-title-${page.id}`}
          type="text"
          key={`title-${page.title}`}
          defaultValue={page.title}
          disabled={busy}
          onBlur={(event) => {
            const value = event.currentTarget.value;
            // 空标题会让这一页在列表里变成「(无标题)」，用户多半是误删，
            // 直接还原而不是存一个空串。
            if (value.trim() === '') {
              event.currentTarget.value = page.title;
              return;
            }
            if (value === page.title) return;
            onPatchTitle(value);
          }}
        />
        <div className="field__hint">失焦即保存。留空会还原成原来的标题。</div>
      </div>

      {page.layout === 'title' || page.layout === 'section' ? (
        <div className="field">
          <label className="field__label" htmlFor={`sl-page-sub-${page.id}`}>
            副标题
          </label>
          <input
            className="input"
            id={`sl-page-sub-${page.id}`}
            type="text"
            key={`sub-${page.subtitle ?? ''}`}
            defaultValue={page.subtitle ?? ''}
            disabled={busy}
            onBlur={(event) => {
              const value = event.currentTarget.value;
              const next = value.trim() === '' ? '' : value;
              if (next === (page.subtitle ?? '')) return;
              // 传空串：core 会把 subtitle 置为 null（不是空字符串），
              // 于是「没有副标题」和「副标题是空串」不会在导出时表现成两种东西。
              onPatchSubtitle(next);
            }}
          />
          <div className="field__hint">留空则不显示副标题。封面副标题默认是「资料名 · N 个知识点」。</div>
        </div>
      ) : (
        <div className="field">
          <span className="field__label">副标题</span>
          <div className="field__hint">
            只有封面页和章节页有副标题。这一页是「{layoutLabel(page.layout)}」版式，标题下方直接是要点
            {page.layout === 'sources' ? '（这一页是导出的资料来源页，不参与编辑）' : ''}。
          </div>
        </div>
      )}

      <div className="sl-page-stats">
        <span>
          这一页有 <strong>{stats.bullets}</strong> 条要点，其中 <strong>{stats.withCitation}</strong> 条有出处
        </span>
        {stats.withoutCitation > 0 ? (
          <span className="sl-page-stats__warn">
            {stats.withoutCitation} 条没有出处，导出的 PPT 里它们不会带角标
          </span>
        ) : null}
      </div>

      {page.layout === 'bullets' ? (
        <div className="field">
          <span className="field__label">要点（{page.bullets.length} 条）</span>
          <ol className="sl-bullets">
            {page.bullets.map((bullet, bulletIndex) => (
              <li className="sl-bullet" key={bullet.id}>
                <span className="sl-bullet__no">{bulletIndex + 1}</span>
                <textarea
                  className="textarea sl-bullet__text"
                  rows={2}
                  key={`${bullet.id}-${bullet.text}`}
                  defaultValue={bullet.text}
                  disabled={busy}
                  onBlur={(event) => {
                    const value = event.currentTarget.value;
                    if (value.trim() === '') {
                      event.currentTarget.value = bullet.text;
                      return;
                    }
                    if (value === bullet.text) return;
                    onPatchBullet(bullet.id, value);
                  }}
                />
                <span className="sl-bullet__side">
                  {bullet.citationIndex !== null ? (
                    <Badge tone="info">[{bullet.citationIndex}]</Badge>
                  ) : (
                    <span className="sl-bullet__nocite">无出处</span>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => onRemoveBullet(bullet.id)}
                    title="删除这条要点"
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
            {page.bullets.length === 0 ? (
              <li className="sl-bullets__empty">这一页还没有要点。在下面加一条。</li>
            ) : null}
          </ol>

          <div className="sl-bullet-add">
            <input
              className="input"
              type="text"
              placeholder="写一条新的要点"
              value={draftBullet}
              disabled={busy}
              onChange={(event) => setDraftBullet(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const value = draftBullet.trim();
                if (value === '') return;
                onAddBullet(value);
                setDraftBullet('');
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || draftBullet.trim() === ''}
              onClick={() => {
                const value = draftBullet.trim();
                if (value === '') return;
                onAddBullet(value);
                setDraftBullet('');
              }}
            >
              加要点
            </button>
          </div>
          <div className="field__hint">
            新加的要点没有角标：它只是文字，还没有对应的原文位置。要带角标，得从知识点生成。
          </div>
        </div>
      ) : page.layout === 'sources' ? (
        <div className="notice notice--info">
          <div className="notice__title">这一页是导出的资料来源页</div>
          <div className="notice__body">
            它由角标自动汇总生成，不占大纲里的位置，也不能单独编辑。改要点文字或删要点之后，这一页的内容会跟着变。
          </div>
        </div>
      ) : (
        <div className="notice notice--info">
          <div className="notice__title">
            这一页是「{layoutLabel(page.layout)}」版式，没有要点
          </div>
          <div className="notice__body">
            只有「要点」版式能加要点。想放正文，用「在页后加页」加一页要点页；或者把这一页的版式留给标题/章节。
          </div>
        </div>
      )}
    </div>
  );
}
