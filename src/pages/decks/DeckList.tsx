import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, LoadingState, Notice } from '@/components/states.tsx';
import type { Deck } from '@/core/model.ts';
import type { DeckStats } from './types.ts';
import { accuracyText, formatDate } from './types.ts';

/**
 * 习题集列表（`/decks` 的默认视图）。
 *
 * ## 读写分离
 *
 * 列表页**只读元信息**（`Deck`），不读题目正文。
 * 一个习题集可能有 200 道题，每道题的题干+选项+解析加起来几 KB，
 * 列表页只需要「标题、题数、状态、正确率」，把 200 道题全读进来
 * 再渲染一遍是我在自己的机器上就能感觉到的卡顿。
 * 题目正文只在详情页（`DeckDetail`）才 `getQuestions()`。
 *
 * 唯一额外读的是 `getStats()` —— 它内部会数一遍题目，
 * 但**不返回题目内容**，返回的是 4 个数字。这是列表页要显示正确率的
 * 最小代价，而且 8 个习题集就是 8 次调用，不是 N 次。
 *
 * ## 为什么正确率要逐个查而不是从 Deck 上取
 *
 * `Deck` 里只有 `questionCount` 与 `blockingIssues`，没有正确率 ——
 * 正确率依赖 `answerRecords`（学生会反复刷，每次结果不同），
 * 缓存到 Deck 上就必须在每次提交作答时同步更新它，多一处可能不一致的地方。
 * 现算一次是 8 次 map 遍历，比维护一个缓存字段便宜得多。
 */

export function DeckList({
  decks,
  stats,
  statsLoading,
  busy,
  onOpen,
  onPractice,
  onDelete,
  onStartGenerate,
  hasSources,
}: {
  decks: Deck[];
  /** deckId → 统计。还没查完的 key 不在这个表里 */
  stats: Record<string, DeckStats>;
  statsLoading: boolean;
  /** 正在被删除的 deckId，用于禁用那一行 */
  busy: string | null;
  onOpen: (deckId: string) => void;
  onPractice: (deckId: string) => void;
  onDelete: (deck: Deck) => void;
  onStartGenerate: () => void;
  /** 是否有任何资料。没有资料时不该把用户引去出题（那里也是空的） */
  hasSources: boolean;
}) {
  if (decks.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="还没有习题集"
          description={
            hasSources ? (
              <>
                习题集是从知识点出题生成的。先去「知识点」页把资料整理成知识点，
                校对好出处，再回来出题——题目会继承知识点的位置，所以每道题都能点回原文。
              </>
            ) : (
              <>
                出题需要先有知识点，知识点来自资料。先去「资料库」导入一份教材或课件，
                整理成知识点后，这里就能出题了。
              </>
            )
          }
          actions={
            <>
              {hasSources ? (
                <button type="button" className="btn btn--primary" onClick={onStartGenerate}>
                  开始出题
                </button>
              ) : null}
              <Link className="btn" to="/knowledge">
                去知识点页
              </Link>
              {!hasSources ? (
                <Link className="btn" to="/sources">
                  去导入资料
                </Link>
              ) : null}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="dk-list">
      {statsLoading ? <LoadingState label="正在统计各习题集的正确率…" /> : null}

      <ul className="dk-list__items">
        {decks.map((deck) => {
          const stat = stats[deck.id];
          const published = deck.status === 'published';
          const blocked = deck.blockingIssues > 0;
          const removing = busy === deck.id;

          return (
            <li key={deck.id} className="card dk-row">
              <div className="dk-row__main">
                <div className="dk-row__head">
                  <button
                    type="button"
                    className="dk-row__title"
                    onClick={() => onOpen(deck.id)}
                    disabled={removing}
                  >
                    {deck.title}
                  </button>
                  {published ? (
                    <Badge tone="ready">已发布</Badge>
                  ) : (
                    <Badge tone="planned">草稿</Badge>
                  )}
                  {/*
                    阻塞问题数直接写在列表上：让用户在不点进去的情况下
                    就知道「这个草稿还不能发布」。
                  */}
                  {blocked ? <Badge tone="danger">{deck.blockingIssues} 个待修</Badge> : null}
                </div>

                <div className="dk-row__meta">
                  <span>{deck.questionCount} 题</span>
                  <span className="dk-row__dot" aria-hidden="true">
                    ·
                  </span>
                  <span title={stat ? `${stat.answered} / ${stat.total} 题做过` : undefined}>
                    正确率 {accuracyText(stat?.accuracy ?? null)}
                  </span>
                  <span className="dk-row__dot" aria-hidden="true">
                    ·
                  </span>
                  <span>创建于 {formatDate(deck.createdAt)}</span>
                  {deck.publishedAt ? (
                    <>
                      <span className="dk-row__dot" aria-hidden="true">
                        ·
                      </span>
                      <span>发布于 {formatDate(deck.publishedAt)}</span>
                    </>
                  ) : null}
                </div>

                {/*
                  草稿状态下明确说清「还不能刷」。
                  用户看到一份有 20 道题的习题集，第一反应是去刷 ——
                  如果界面上不说，他会以为功能坏了（按钮没有），
                  而不是意识到这是发布流程的一部分。
                */}
                {!published ? (
                  <div className="dk-row__note">
                    草稿：检查并发布后，才能开始刷题。
                    {blocked ? ' 有阻塞问题必须先修好。' : ''}
                  </div>
                ) : null}
              </div>

              <div className="dk-row__side">
                {published ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => onPractice(deck.id)}
                    disabled={removing}
                  >
                    刷题
                  </button>
                ) : null}
                <button
                  type="button"
                  className={published ? 'btn' : 'btn btn--primary'}
                  onClick={() => onOpen(deck.id)}
                  disabled={removing}
                >
                  {published ? '查看 / 改回草稿' : '继续编辑'}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => onDelete(deck)}
                  disabled={removing}
                >
                  {removing ? '正在删除…' : '删除'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 出题前的前置检查提示。
 *
 * 抽成独立小卡片而不是塞进列表空态：**已经有习题集**时仍然可能需要它
 * （用户想出第二批题，但手上没有已定位的知识点）。
 * 它出现在列表页顶部，只在确实存在问题时显示。
 */
export function DeckListHint({
  hasSources,
  locatedPoints,
  loading,
}: {
  hasSources: boolean;
  /** 全库已定位的知识点数。null = 还不知道 */
  locatedPoints: number | null;
  loading: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);

  // 依赖变化时允许重新提示（比如用户去知识点页处理完回来）
  useEffect(() => {
    setDismissed(false);
  }, [hasSources, locatedPoints]);

  const problem = useMemo(() => {
    if (loading || dismissed) return null;
    if (!hasSources) return '还没有资料。出题需要知识点，知识点来自资料。';
    if (locatedPoints === 0) {
      return '还没有「已定位」的知识点。出题只用已定位的条目——未定位的题目无法点回原文，产品承诺就不成立了。';
    }
    return null;
  }, [hasSources, locatedPoints, loading, dismissed]);

  if (!problem) return null;

  return (
    <Notice tone="warning" title="出题前还差一步">
      {problem}
      <div className="dk-hint__actions">
        <Link className="btn btn--sm" to="/sources">
          去资料库
        </Link>
        <Link className="btn btn--sm btn--primary" to="/knowledge">
          去知识点页整理 / 校对
        </Link>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDismissed(true)}>
          我知道了
        </button>
      </div>
    </Notice>
  );
}

/**
 * 删除确认的文案。
 *
 * 单独一个函数而不是内联字符串：这段文案是这个操作**唯一**的告知，
 * 「会连题目和作答记录一起删掉」这句话不能说漏，也不能在别处写一个更短的版本。
 */
export function deleteConfirmText(deck: Deck, stats: DeckStats | undefined): string {
  const records = stats ? `（其中 ${stats.answered} 道题有作答记录）` : '';
  return (
    `删除习题集「${deck.title}」？\n\n` +
    `这会一并删除它的 ${deck.questionCount} 道题${records}，以及这些题的作答历史。\n` +
    '删除后无法恢复，也不影响资料原文和知识点。\n\n' +
    '如果只是想暂时不让它出现在练习里，可以把它「改回草稿」。'
  );
}
