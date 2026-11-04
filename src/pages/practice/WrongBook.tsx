import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { AnswerRecord, Deck, Question, Source } from '@/core/model.ts';
import { SourcePeek } from './SourcePeek.tsx';
import { describeError, formatTime, kindLabel, locationText } from '../decks/types.ts';
import './practice.css';

/**
 * 错题本。
 *
 * ## 我们这边「错题」的定义（必须写清楚）
 *
 * **这道题最近一次作答是错的。**
 *
 * 不是「曾经错过」——学生改对了之后不该继续躺在错题本里，
 * 否则错题本只会越来越长，最后没人看。
 *
 * 这个定义有两处必须让用户知道：
 *  1. 页面上明说（顶部提示条）；
 *  2. 重做后如果答对了，那一瞬间就从列表里消失——如果他不知道规则，
 *     会以为「我的记录丢了」。
 *
 * ## 为什么按 `sequence` 而不是时间排
 *
 * `answeredAt` 精度只到毫秒，连续两次提交时间戳会完全相同，
 * 排不出先后。core 的 `getWrongQuestions()` 已经在内部用 `sequence` 排好了，
 * 界面不要再按时间重排一次（那会把 core 的正确性丢掉）。
 */

type WrongItem = { question: Question; lastRecord: AnswerRecord; wrongCount: number };

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; data: WrongItem[] };

export function WrongBook({
  onStartRedo,
  deckTitles,
  sourceKindById,
}: {
  /** 开始「只刷错题」 */
  onStartRedo: (questions: Question[]) => void;
  /** deckId → 标题，用于筛选下拉与列表标注 */
  deckTitles: Map<string, string>;
  sourceKindById: Map<string, Source['kind']>;
}) {
  const { decks: deckService } = useServices();

  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [keyword, setKeyword] = useState('');
  /** 空字符串 = 全部习题集 */
  const [deckFilter, setDeckFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const list = await deckService.getWrongQuestions({
        ...(deckFilter ? { deckId: deckFilter } : {}),
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      });
      setState({ kind: 'ready', data: list });
    } catch (err) {
      setState({
        kind: 'error',
        message: describeError(err),
        hint: '错题记录没有被改动。刷新页面重试；若反复失败，可能是本地存储异常。',
      });
    }
  }, [deckService, deckFilter, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = state.kind === 'ready' ? state.data : [];

  const questions = useMemo(() => items.map((i) => i.question), [items]);

  const handleRedoAll = () => {
    if (questions.length === 0) return;
    onStartRedo(questions);
  };

  return (
    <div className="page__stack wb-page">
      <Notice tone="info" title="什么算「错题」">
        这里收的是<strong>最近一次作答答错</strong>的题。重做之后如果这次答对了，
        它会自动从错题本里移出——不用你手动清理，也不会越攒越多。
        （问答题按你自评的结果算。）
      </Notice>

      {/* ---------- 筛选 ---------- */}
      <section className="card wb-filters">
        <div className="card__body wb-filters__body">
          <div className="field wb-filters__field">
            <label className="field__label" htmlFor="wb-deck">
              按习题集筛选
            </label>
            <select
              id="wb-deck"
              className="select"
              value={deckFilter}
              onChange={(e) => setDeckFilter(e.target.value)}
            >
              <option value="">全部习题集</option>
              {[...deckTitles.entries()].map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </div>

          <div className="field wb-filters__field">
            <label className="field__label" htmlFor="wb-keyword">
              搜索题干或概念
            </label>
            <input
              id="wb-keyword"
              className="input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="输入关键词"
            />
            <div className="field__hint">按题干与概念名匹配，不区分大小写。</div>
          </div>

          <div className="wb-filters__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleRedoAll}
              disabled={questions.length === 0}
            >
              只刷错题（{questions.length}）
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setKeyword('');
                setDeckFilter('');
              }}
              disabled={keyword === '' && deckFilter === ''}
            >
              清空筛选
            </button>
          </div>
        </div>
      </section>

      {/* ---------- 列表 ---------- */}
      {state.kind === 'loading' ? (
        <LoadingState label="正在归集错题…" />
      ) : state.kind === 'error' ? (
        <ErrorState
          title="读不出错题"
          message={state.message}
          hint={state.hint}
          onRetry={() => void load()}
        />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={
              keyword || deckFilter ? '这个筛选条件下没有错题' : '错题本是空的'
            }
            description={
              keyword || deckFilter
                ? '换个关键词或选「全部习题集」。也可能是这些题在重做后都答对了——那样它们已经自动移出错题本。'
                : '还没有答错过任何题，或者答错的题在重做后都改对了。去练习页刷几套题，这里会自动收进来。'
            }
            actions={
              keyword || deckFilter ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setKeyword('');
                    setDeckFilter('');
                  }}
                >
                  清空筛选
                </button>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <div className="wb-count">
            共 <strong>{items.length}</strong> 道错题
            {deckFilter ? `（习题集：${deckTitles.get(deckFilter) ?? '未知'}）` : ''}
            {keyword ? `（关键词：${keyword}）` : ''}
          </div>

          <ul className="wb-list">
            {items.map((item) => {
              const q = item.question;
              const sourceKind = sourceKindById.get(q.deckId);
              const open = expanded[q.id] === true;

              return (
                <li key={q.id} className="card wb-item">
                  <div className="wb-item__main">
                    <div className="wb-item__head">
                      <Badge tone="danger">错 {item.wrongCount} 次</Badge>
                      <Badge tone="neutral">{kindLabel(q.kind)}</Badge>
                      <span className="wb-item__deck">
                        {deckTitles.get(q.deckId) ?? '（习题集已删除）'}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="wb-item__prompt"
                      onClick={() => setExpanded((prev) => ({ ...prev, [q.id]: !open }))}
                      aria-expanded={open}
                    >
                      {q.prompt}
                    </button>

                    <div className="wb-item__meta">
                      <span>最近一次作答：{formatTime(item.lastRecord.answeredAt)}</span>
                      <span className="wb-item__dot" aria-hidden="true">
                        ·
                      </span>
                      <span>你的答案：{item.lastRecord.response || '（空）'}</span>
                      {item.lastRecord.elapsedMs !== null ? (
                        <>
                          <span className="wb-item__dot" aria-hidden="true">
                            ·
                          </span>
                          <span>用时 {(item.lastRecord.elapsedMs / 1000).toFixed(1)} 秒</span>
                        </>
                      ) : null}
                    </div>

                    {open ? (
                      <div className="wb-item__detail">
                        <div className="wb-item__field">
                          <span className="wb-item__field-label">正确答案</span>
                          <span>{q.answer || '（空）'}</span>
                        </div>
                        {q.explanation.trim() ? (
                          <div className="wb-item__field">
                            <span className="wb-item__field-label">解析</span>
                            <span>{q.explanation}</span>
                          </div>
                        ) : (
                          <div className="wb-item__field wb-item__field--empty">
                            这道题没有解析。看原文自己对照依据。
                          </div>
                        )}
                        <div className="wb-item__field">
                          <span className="wb-item__field-label">出处</span>
                          {q.anchors.length === 0 ? (
                            <span className="wb-item__field--empty">
                              无出处（依据的知识点没定位到原文）
                            </span>
                          ) : (
                            <span>{locationText(q.anchors[0], sourceKind)}</span>
                          )}
                        </div>
                        {q.anchors[0] ? (
                          <SourcePeek
                            sourceId={q.anchors[0].sourceId}
                            anchor={q.anchors[0]}
                            sourceKind={sourceKind}
                            autoOpen={false}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="wb-item__side">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onStartRedo([q])}
                    >
                      重做这道
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => setExpanded((prev) => ({ ...prev, [q.id]: !open }))}
                    >
                      {open ? '收起' : '展开答案'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** 供外部工具（测试/调试）复用的定义文案，保证与界面一字不差 */
export const WRONG_DEFINITION =
  '错题 = 这道题最近一次作答是错的。重做答对后自动移出。';

/** deckId → 标题 的小工具，PracticePage 用它构造筛选下拉 */
export function toDeckTitleMap(decks: Deck[]): Map<string, string> {
  return new Map(decks.map((d) => [d.id, d.title]));
}
