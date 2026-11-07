/**
 * 错题与待巩固。
 *
 * ## 这一页和「开始做题 → 错题巩固」的区别
 *
 * | | 这一页 | 开始做题 → 错题巩固 |
 * | --- | --- | --- |
 * | 做什么 | **看**：错题全貌、错几次、错在哪、按什么归类 | 直接开做 |
 * | 数据 | 只读 | 会写新的复习记录 |
 *
 * 两者共用同一个数据源（最近一次评级是 `again` 的题），
 * 所以「这里看到的」和「那儿能练的」永远一致 ——
 * 不会出现「列表里有 8 道，点开始只做 3 道」那种对不上的情况。
 *
 * ## 「错题」的定义（必须让用户看见）
 *
 * **最近一次作答是错的。** 不是「曾经错过」——
 * 改对之后就会从列表里消失。这个规则如果不说，
 * 用户重做答对后发现题目不见了，会以为记录丢了。
 *
 * ## 2026-11-07 重做：错题一多就乱
 *
 * 用户原话：「一旦错题多起来，界面会很繁杂，做个收起来的功能。
 * 再增加错题类型分类的功能，不仅能根据题型分类，还能根据哪本书的哪一章
 * 知识点进行分类。」
 *
 * 做法：
 *  1. **分组 + 折叠**：默认只显示每组标题与条数，点开才铺开题目。
 *     默认全部收起 —— 一屏能看到全貌，而不是滚几十道题。
 *  2. **两个归类维度**：章节/知识点（默认）与题型，可切换。
 *  3. 排序（错得最多 / 错的比例 / 最近错的）在分组内部生效。
 *
 * ## 为什么不需要「让 AI 给题打标签」
 *
 * 用户的思路是「出题阶段让 AI 打标签」。查过数据后确认**不需要**：
 *   `Question.knowledgePointId` → `KnowledgePoint.chapter`（章节名）
 *   `Question.anchors[].chapter` / `.page`（出处）
 *   `Question.kind`（题型，本来就有）
 * 分类信息全在，只差聚合。多花一次模型调用去生成一个已有的字段，
 * 既慢又可能和原文对不上（模型给的章名和知识点里的章名会打架）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '@/v2/core/cards.ts';
import { CARD_KIND_LABEL } from '@/v2/core/cards.ts';
import { chapterOf, sourceOf, NO_CHAPTER, type MapPoint } from '@/v2/core/study-map.ts';
import type { Question } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';

export interface WrongBookPageProps {
  reviewService: ReviewService;
  decks: DeckService;
  loadCards: CardLoader;
  knowledge: KnowledgeService;
  sourceService: SourceService;
  /** 去阅读器看原文 */
  onOpenSource: (sourceId: string) => void;
  /** 去「开始做题」 */
  onOpenPractice: () => void;
}

interface WrongRow {
  card: Card;
  wrongCount: number;
  reviewCount: number;
  lastWrongDay: string;
  wrongRate: number;
  deckTitle: string | null;
  /** 归属章节（知识点上的 chapter / 锚点 chapter / 第 N 页 / 未归类） */
  chapter: string;
  /** 资料标题 */
  sourceTitle: string | null;
}

/**
 * 归类维度。
 *
 * `deck` 默认 —— 用户 2026-11-07 反馈：按知识点分组仍然臃肿，
 * 根因是「知识点太多太散」，一个题组能炸出十几个章节分组。
 * 题组是出题的自然单位，数量天然少（用户库里 3 个），一屏就能看完。
 * 章节/知识点保留为可切换项 —— 用户说「后续再思考能不能做」，
 * 所以不做删减，只把默认换掉。
 */
type GroupBy = 'deck' | 'chapter' | 'kind';
/** 组内排序 */
type SortKey = 'wrongCount' | 'lastWrong' | 'wrongRate';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'wrongCount', label: '错得最多' },
  { key: 'wrongRate', label: '错的比例最高' },
  { key: 'lastWrong', label: '最近错的' },
];

interface Group {
  key: string;
  title: string;
  /** 次要说明（如资料名） */
  note: string | null;
  rows: WrongRow[];
  /** 这一组里错得最多的次数，用于组标题只显示一个数字 */
  worst: number;
}

export function WrongBookPage({
  reviewService,
  decks,
  loadCards,
  knowledge,
  sourceService,
  onOpenSource,
  onOpenPractice,
}: WrongBookPageProps) {
  const [rows, setRows] = useState<WrongRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('deck');
  const [sort, setSort] = useState<SortKey>('wrongCount');
  /** 展开的分组 key 集合（默认空 = 全部收起） */
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [detailed, allCards, deckList, sources] = await Promise.all([
        reviewService.wrongCardsDetailed(),
        loadCards(),
        decks.list(),
        sourceService.list(),
      ]);

      const cardById = new Map(allCards.map((c) => [c.id, c]));
      const deckById = new Map(deckList.map((d) => [d.id, d]));
      const titleById = new Map(sources.map((s) => [s.id, s.title]));

      /*
       * 章节要经过「题 → 知识点」这一跳。
       * 逐组取题是因为 DeckService 没有按 id 批量取题的接口，
       * 而 getAll('questions') 会把草稿题也捞出来。
       */
      const pointIdByQuestion = new Map<string, string | null>();
      await Promise.all(
        deckList.map(async (deck) => {
          try {
            const qs = await decks.getQuestions(deck.id);
            for (const q of qs) pointIdByQuestion.set(q.id, q.knowledgePointId);
          } catch {
            /* 题组刚被删：跳过 */
          }
        }),
      );

      const uniquePointIds = [
        ...new Set([...pointIdByQuestion.values()].filter((id): id is string => !!id)),
      ];
      const points = await Promise.all(
        uniquePointIds.map(async (id) => {
          try {
            return await knowledge.get(id);
          } catch {
            return null;
          }
        }),
      );
      const pointsById = new Map(
        points.filter((p): p is NonNullable<typeof p> => !!p).map((p) => [p.id, p]),
      );
      const pointByQuestion = new Map<string, MapPoint>();
      for (const [questionId, pointId] of pointIdByQuestion) {
        const p = pointId ? pointsById.get(pointId) : null;
        if (!p) continue;
        pointByQuestion.set(questionId, { id: p.id, chapter: p.chapter, sourceId: p.sourceId });
      }

      const out: WrongRow[] = [];
      for (const d of detailed) {
        const card = cardById.get(d.cardId);
        if (!card) continue; // 题已被删：不显示点不开的空壳
        const deck = deckById.get(card.deckId);
        out.push({
          card,
          wrongCount: d.wrongCount,
          reviewCount: d.reviewCount,
          lastWrongDay: d.lastWrongDay,
          wrongRate: d.reviewCount > 0 ? d.wrongCount / d.reviewCount : 1,
          deckTitle: deck?.title ?? null,
          chapter: chapterOf(card, pointByQuestion),
          /*
           * 资料名要走 sourceOf 的三层回退。
           * 只用 card.sourceId 的话，「题组没归属资料但锚点有出处」的题
           * 在错题页会显示成群标题没有书名 —— 我已经在真实库里见到
           * 同一页有的组有书名、有的没有，看起来像是数据坏了。
           */
          sourceTitle: sourceTitleOf(card, pointByQuestion, titleById),
        });
      }

      setRows(out);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出错题');
    }
  }, [reviewService, decks, loadCards, knowledge, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 分组 + 组内排序 */
  const groups = useMemo<Group[]>(() => {
    if (!rows) return [];

    const byKey = new Map<string, WrongRow[]>();
    for (const r of rows) {
      /*
       * 分组 key 必须带资料 id。
       *
       * 踩过的坑：key 只用章节名时，两本书的「第 9 页」会被合并成一组，
       * 标题写着「第 9 页 · 信号与系统」，里面却混着另一本书的题 ——
       * 用户点开发现跟标题说的不是一回事。章节名只在**同一份资料内**唯一。
       */
      const key =
        groupBy === 'deck'
          ? r.card.deckId
          : groupBy === 'chapter'
            ? `${r.card.sourceId}::${r.chapter}`
            : kindLabel(r.card);
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }

    const out: Group[] = [];
    for (const [key, list] of byKey) {
      const sorted = [...list];
      if (sort === 'wrongCount') sorted.sort((a, b) => b.wrongCount - a.wrongCount);
      else if (sort === 'wrongRate') sorted.sort((a, b) => b.wrongRate - a.wrongRate);
      else sorted.sort((a, b) => (a.lastWrongDay < b.lastWrongDay ? 1 : -1));

      /*
       * 标题：
       *  - 按题组 → 题组名（没有就退回 id 末段，绝不编造）
       *  - 按章节 → 章节名，资料名放 note
       *  - 按题型 → 题型名
       * 标题要能被扫描，所以章节名和资料名分开两栏，
       * 「第 9 页 信号与系统（第二版）第1章…」混在一起会让每行都长得一样。
       */
      const title =
        groupBy === 'deck'
          ? (sorted[0]!.deckTitle ?? '未命名题组')
          : groupBy === 'chapter'
            ? sorted[0]!.chapter
            : key;
      const note = groupBy === 'deck' ? null : groupBy === 'chapter' ? sourceNote(sorted) : null;

      out.push({
        key,
        title,
        note,
        rows: sorted,
        worst: Math.max(...sorted.map((r) => r.wrongCount)),
      });
    }

    /*
     * 分组排序：错得最多的组排前面。
     * 「未归类」永远排最后 —— 它不是一块知识，是数据缺口，
     * 摆在一堆正经章节中间会让人误以为那也是要复习的内容。
     */
    out.sort((a, b) => {
      if (a.title === NO_CHAPTER) return 1;
      if (b.title === NO_CHAPTER) return -1;
      return b.worst - a.worst || b.rows.length - a.rows.length;
    });

    return out;
  }, [rows, groupBy, sort]);

  const totalWrong = rows?.length ?? 0;
  const repeatWrong = rows?.filter((r) => r.wrongCount > 1).length ?? 0;

  if (error) {
    return (
      <div className="wrongbook-page">
        <h1 className="wbk-title">错题与待巩固</h1>
        <p className="wbk-error">{error}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="wrongbook-page">
        <p className="wbk-hint">正在读错题…</p>
      </div>
    );
  }

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 全部展开 / 全部收起 */
  function toggleAll() {
    if (open.size > 0) setOpen(new Set());
    else setOpen(new Set(groups.map((g) => g.key)));
  }

  return (
    <div className="wrongbook-page">
      <header className="wbk-head">
        <h1 className="wbk-title">错题与待巩固</h1>
        <p className="wbk-lead">
          这里的「错题」指<strong>最近一次作答是错的</strong>题。重做答对之后它就会从这里消失，
          所以这个列表只会越来越短。
        </p>
      </header>

      {totalWrong === 0 ? (
        <div className="wbk-empty">
          <p>现在没有错题。</p>
          <p className="wbk-hint">做错的题会自动进来；如果你还没做过题，先去练一轮。</p>
          <button type="button" className="btn-ghost" onClick={onOpenPractice}>
            去开始做题
          </button>
        </div>
      ) : (
        <>
          {/* ---- 概览 ---- */}
          <div className="wbk-stats">
            <span className="wbk-stat">
              <span className="wbk-stat__n">{totalWrong}</span>
              <span className="wbk-stat__label">道错题</span>
            </span>
            <span className="wbk-stat">
              <span className="wbk-stat__n">{groups.length}</span>
              <span className="wbk-stat__label">
                {groupBy === 'deck'
                  ? '个题组'
                  : groupBy === 'chapter'
                    ? '个章节/知识点'
                    : '种题型'}
              </span>
            </span>
            {repeatWrong > 0 ? (
              <span className="wbk-stat wbk-stat--warn">
                <span className="wbk-stat__n">{repeatWrong}</span>
                <span className="wbk-stat__label">道错过不止一次</span>
              </span>
            ) : null}
          </div>

          {/* ---- 归类维度 + 排序 ---- */}
          <div className="wbk-toolbar">
            <div className="wbk-seg" role="group" aria-label="归类方式">
              <button
                type="button"
                className={`wbk-seg__btn${groupBy === 'deck' ? ' wbk-seg__btn--on' : ''}`}
                aria-pressed={groupBy === 'deck'}
                onClick={() => {
                  setGroupBy('deck');
                  setOpen(new Set());
                }}
              >
                按题组
              </button>
              <button
                type="button"
                className={`wbk-seg__btn${groupBy === 'chapter' ? ' wbk-seg__btn--on' : ''}`}
                aria-pressed={groupBy === 'chapter'}
                onClick={() => {
                  setGroupBy('chapter');
                  setOpen(new Set());
                }}
              >
                按章节/知识点
              </button>
              <button
                type="button"
                className={`wbk-seg__btn${groupBy === 'kind' ? ' wbk-seg__btn--on' : ''}`}
                aria-pressed={groupBy === 'kind'}
                onClick={() => {
                  setGroupBy('kind');
                  setOpen(new Set());
                }}
              >
                按题型
              </button>
            </div>

            <div className="wbk-sort" role="group" aria-label="组内排序">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`wbk-sort__btn${sort === s.key ? ' wbk-sort__btn--on' : ''}`}
                  aria-pressed={sort === s.key}
                  onClick={() => setSort(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="wbk-toolbar__right">
              {/*
                用和分段控件同一套视觉（wbk-seg__btn），不借 btn-ghost：
                btn-ghost 是「次要动作」的样式，文字本来就偏暗，
                夹在分段控件和实心主按钮之间会看着像被禁用的。
                项目踩过「禁用按钮看起来能点」，反向也要避免「能点的像禁用」。
              */}
              <button type="button" className="wbk-seg__btn wbk-seg__btn--outline" onClick={toggleAll}>
                {open.size > 0 ? '全部收起' : '全部展开'}
              </button>
              <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenPractice}>
                去练错题
              </button>
            </div>
          </div>

          {/* ---- 分组列表（默认收起） ---- */}
          <ul className="wbk-groups">
            {groups.map((g) => {
              const isOpen = open.has(g.key);
              return (
                <li key={g.key} className="wbk-group">
                  <button
                    type="button"
                    className="wbk-group__head"
                    onClick={() => toggle(g.key)}
                    aria-expanded={isOpen}
                  >
                    <span
                      className={`wbk-caret${isOpen ? ' wbk-caret--open' : ''}`}
                      aria-hidden="true"
                    />
                    {/* title 属性：题组名太长被省略号截断时，悬停能看全 */}
                    <span className="wbk-group__title" title={g.title}>
                      {g.title}
                    </span>
                    {g.note ? <span className="wbk-group__note">{g.note}</span> : null}
                    <span className="wbk-group__count">
                      {g.rows.length} 道{g.worst > 1 ? ` · 最多错 ${g.worst} 次` : ''}
                    </span>
                  </button>

                  {isOpen ? (
                    <ul className="wbk-list">
                      {g.rows.map((r) => (
                        <li key={r.card.id} className="wbk-item">
                          <div className="wbk-item__head">
                            <span className="wbk-item__count">错 {r.wrongCount} 次</span>
                            <span className="wbk-item__rate">
                              共做 {r.reviewCount} 次 · 错 {Math.round(r.wrongRate * 100)}%
                            </span>
                            <span className="wbk-item__kind">{kindLabel(r.card)}</span>
                            <span className="wbk-item__date">最近错于 {r.lastWrongDay}</span>
                          </div>
                          <p className="wbk-item__prompt">{r.card.prompt}</p>

                          {r.card.options.length > 0 ? (
                            <ul className="wbk-item__options">
                              {r.card.options.map((o) => (
                                <li
                                  key={o.key}
                                  className={`wbk-item__option${
                                    isAnswerKey(r.card, o.key) ? ' wbk-item__option--right' : ''
                                  }`}
                                >
                                  <span className="wbk-item__key">{o.key}</span>
                                  <span>{o.text}</span>
                                  {isAnswerKey(r.card, o.key) ? (
                                    <span className="wbk-item__tag">正确答案</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="wbk-item__answer">参考答案：{r.card.answer}</p>
                          )}

                          {r.card.explanation ? (
                            <p className="wbk-item__explain">{r.card.explanation}</p>
                          ) : null}

                          <div className="wbk-item__foot">
                            {r.deckTitle ? (
                              <span className="wbk-item__deck">{r.deckTitle}</span>
                            ) : null}
                            {r.card.sourceId ? (
                              <button
                                type="button"
                                className="btn-text"
                                onClick={() => onOpenSource(r.card.sourceId)}
                              >
                                看原文
                              </button>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** 资料名：走和 study-map 同一套三层回退，两页的归属判断必须一致 */
function sourceTitleOf(
  card: Card,
  pointByQuestion: ReadonlyMap<string, MapPoint>,
  titleById: ReadonlyMap<string, string>,
): string | null {
  const id = sourceOf(card, pointByQuestion);
  if (!id) return null;
  return titleById.get(id) ?? null;
}

/** 题型中文名 —— 统一从注册表取，避免加了新题型忘同步（项目踩过） */
function kindLabel(card: Card): string {
  return CARD_KIND_LABEL[card.kind] ?? card.kind;
}

/**
 * 一组的次要说明：列出这一组涉及的资料名。
 *
 * 只列第一份、超过一份时写「等 N 份」——
 * 一个章节名后面跟五个书名会把标题行挤爆。
 */
function sourceNote(rows: WrongRow[]): string | null {
  const titles = [...new Set(rows.map((r) => r.sourceTitle).filter((t): t is string => !!t))];
  if (titles.length === 0) return null;
  if (titles.length === 1) return titles[0]!;
  return `${titles[0]} 等 ${titles.length} 份资料`;
}

/** 某个选项是不是正确答案（多选用逗号分隔） */
function isAnswerKey(card: Card, key: string): boolean {
  const answer = card.answer.trim().toUpperCase();
  if (card.kind === 'multiple') {
    return answer
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .includes(key.toUpperCase());
  }
  return answer === key.toUpperCase();
}

/** 题型中文名（对外导出，供别处复用） */
export const QUESTION_KIND_LABEL: Record<Question['kind'], string> = {
  single: '单选',
  multiple: '多选',
  truefalse: '判断',
  blank: '填空',
  essay: '问答',
};
