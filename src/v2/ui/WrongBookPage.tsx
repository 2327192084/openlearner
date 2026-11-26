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
 * ## 2026-11-26 重构（用户要求）
 *
 * 用户原话：「一级分组默认按资料分组，去掉来源/知识点分组，
 * 「按题型展开」改成二级筛选，以横排小标签形式展示在分组栏下方：
 * 全部 / 单选 / 多选 / 判断 / 填空等等，默认显示全部」。
 * 原话还说：「新增错题收藏：每张错题卡加一个『收藏』按钮。
 * 收藏的题单独加一个『已收藏』栏目，里面同样按资料分组展示」。
 *
 * 所以现在：
 *  1. 一级分组**只有资料**（同一份资料的题归在一起），题型与章节不再是一级分组
 *  2. 题型是分组栏下方的横排小标签（筛选条件），默认「全部」
 *  3. 每张卡可收藏；「已收藏」是同一层级的一个栏目，同样按资料分组
 *
 * 收藏状态的真相在 `Question.favorite` 上，与题库共用（见 model.ts 该字段注释）：
 * 题库的「已收藏」是全集，这里是「收藏 ∩ 最近一次做错」这个子集。
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
import type { Card, CardKind } from '@/v2/core/cards.ts';
import { chapterOf, sourceOf, type MapPoint } from '@/v2/core/study-map.ts';
import type { Question, QuestionKind, SourceLocation } from '@/core/model.ts';
import { GENERATE_KINDS, kindShort } from '@/core/questions/kinds.ts';
import { anchorPrecision, precisionCopy } from '@/core/questions/anchor-precision.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import { NO_SOURCE, wrongSourceKey, type SortKey } from './wrong-group.ts';

export interface WrongBookPageProps {
  reviewService: ReviewService;
  decks: DeckService;
  loadCards: CardLoader;
  knowledge: KnowledgeService;
  sourceService: SourceService;
  /**
   * 去阅读器看原文，**并定位到这道题的出处**（2026-11-09 改）。
   *
   * 原来只传 `sourceId`，阅读器拿到的 target 是 null，于是总是打开第一页。
   * 用户点「看原文」看到的是封面 —— 这个入口等于没做。
   * 现在把锚点一起带过去，阅读器用现有逻辑定位到那一页那一段。
   */
  onOpenSource: (sourceId: string, anchor?: SourceLocation | null) => void;
  /** 去「开始做题」 */
  onOpenPractice: () => void;
  /**
   * 用错题出变式题（2026-11-12）。
   *
   * 用户反馈：「我需要一个入口，你做了功能可是没有使用入口」。
   * 变式出题功能已实现，但只能从「我的题组 → 新建题组 → 变式出题」进入，
   * 用户根本找不到。错题页是最自然的位置 —— 这里每题都是真实做错的题。
   *
   * 不传时按钮不渲染（不摆假按钮）。
   */
  onOpenVariant?: () => void;
  /** 用**某一道**错题出变式（单题入口） */
  onVariantSingle?: (questionId: string) => void;
  /**
   * 导出为 Obsidian 闪卡。
   *
   * 为什么放在这一页：这里的题就是「错题」，正是最该做成闪卡的材料。
   * 用户的主笔记软件是 Obsidian，导出的 .md 直接丢进库里就能复习 ——
   * 不需要我们自己做一套复习界面。
   */
  onExportObsidian: (deckId: string | null) => Promise<{ fileName: string; count: number }>;
  /**
   * 外部持有的视图状态（2026-11-09）。
   *
   * 用户从错题跳原文再返回时，分组维度 / 排序 / 展开的组
   * 不该丢 —— 丢了就得重新展开、重新找到刚才那一题，
   * 正是「返回后不好定位原先的位置」。
   *
   * 传了就是受控（App 持有），不传就是组件自己管。
   */
  view?: WrongBookView;
  onViewChange?: (next: WrongBookView) => void;
  /**
   * 进来时展开并滚动到这一道题（2026-11-13 深夜）。
   *
   * 首页「错题」那一块的每一行都要能点，且必须落到**那一题**上 ——
   * 原来五行都跳这一页的顶部，用户点了看不出自己点的是哪道，
   * 等于只做到「跳到这个功能」，没做到用户要的「跳到对应的那一个」。
   */
  focusCardId?: string | null;
  /** 每次点首页那一行都递增，让「同一题再点一次」也能重新定位 */
  focusToken?: number;
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
  /** 归属资料 id（三层回退后的结果）；null 表示哪一层都没找到 */
  sourceId: string | null;
  /** 资料标题 */
  sourceTitle: string | null;
  /** 是否收藏。真相在 `Question.favorite`，这里只是读出来的镜像 */
  favorite: boolean;
  /**
   * 真实题型（`Question.kind`）。
   *
   * 不能直接用 `card.kind`：卡片层把「问答」和「计算」都压成了 `short`
   * （见 cards-loader.ts 的 `toCardKind`），压完就分不出计算题了。
   * 而用户明确要求题型筛选「所有可以生成的题型都要做出来，包括计算、判断」，
   * 所以这里从题目本身取，卡片只负责渲染。
   */
  kind: QuestionKind;
}

/**
 * 题型筛选的全部选项（2026-11-26，用户要求「题型分类功能做全」）。
 *
 * 不做「只显示实际出现过的题型」那套：列全 6 种，哪一种是 0 道用户自己能看见
 * （点进去是空提示），而不是疑惑「我明明出过计算题，怎么没有计算这个筛子」。
 * 顺序与出题页共用注册表（kinds.ts），加新题型时这里自动跟上。
 */
const KIND_FILTERS: readonly QuestionKind[] = GENERATE_KINDS;

/** 一级栏目：全部错题 / 只在错题里收藏过的题 */
type WrongTab = 'wrong' | 'favorite';

/**
 * 一级分组 = 资料（2026-11-26）。
 *
 * 为什么按资料而不是按题组：用户复习时想的是「这本书我哪几道还错着」，
 * 而不是「第几批生成的题错着」。同一份资料生成过两次题组时，
 * 按题组分组会把同一本书拆成两块，反而看不出整体缺口。
 * 组标题仍用资料名；组内如果跨了多个题组，note 里写「N 个题组」。
 */

/**
 * 错题页的视图状态（可跨页面存活，2026-11-09）。
 *
 * 由 App 持有，这样从错题跳到原文再返回时，
 * 「怎么排序、哪几组是展开的」都还在原位。
 * 2026-11-26 起分组维度固定为资料，不再是可切换项，所以这里只剩两项。
 */
export interface WrongBookView {
  sort: SortKey;
  /** 展开了哪些分组 */
  open: Set<string>;
}

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
  onOpenVariant,
  onVariantSingle,
  onExportObsidian,
  view,
  onViewChange,
  focusCardId,
  focusToken,
}: WrongBookPageProps) {
  const [rows, setRows] = useState<WrongRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * 排序 / 展开哪些组 —— 这两样决定「用户现在看到什么」。
   *
   * 2026-11-09 改成可受控：用户从错题跳到原文再返回时，
   * 这些状态原本随组件卸载一起丢了（分组又全部折叠，得重新展开、
   * 重新找到刚才那一题）—— 正是「返回后不好定位原先的位置」。
   *
   * 传了 view 就用外部的（App 持有，跨页面存活）；
   * 不传就退回组件内部 state（单独使用本组件时不改调用方）。
   *
   * 2026-11-26：分组维度固定成「资料」，所以它不再受控 —— 一个常量，
   * 没有「回到页面后还记着上次按什么分组」的必要。
   */
  const [innerSort, setInnerSort] = useState<SortKey>('wrongCount');
  const [innerOpen, setInnerOpen] = useState<Set<string>>(new Set());

  const sort = view?.sort ?? innerSort;
  const open = view?.open ?? innerOpen;

  const setSort = useCallback(
    (next: SortKey) => {
      setInnerSort(next);
      onViewChange?.({ sort: next, open });
    },
    [onViewChange, open],
  );
  const setOpen = useCallback(
    (next: Set<string>) => {
      setInnerOpen(next);
      onViewChange?.({ sort, open: next });
    },
    [onViewChange, sort],
  );

  /**
   * 一级栏目：错题 / 已收藏（2026-11-26）。
   *
   * 「已收藏」不是第三个分组维度，而是与「错题」并列的一个视图 ——
   * 用户要的是「我标过的题在哪」，不是「按收藏这个属性分组」。
   * 两个栏目都按资料分组（这正是用户说的「里面同样按资料分组展示」）。
   */
  const [tab, setTab] = useState<WrongTab>('wrong');
  /** 二级筛选：题型。默认「全部」 */
  const [kindFilter, setKindFilter] = useState<'all' | QuestionKind>('all');
  /** 正在写入收藏的题目 id（防连点，也用来把按钮置灰） */
  const [favBusy, setFavBusy] = useState<string | null>(null);
  /** 收藏失败时的提示（成功不弹，按钮状态本身就是反馈） */
  const [favError, setFavError] = useState<string | null>(null);

  /** 导出结果提示 */
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  /**
   * 从首页「错题」点进来时，落到那一题上（2026-11-13 深夜）。
   *
   * 三步，缺一步用户就觉得「点了没到」：
   *  1. 展开它所在的分组（分组收起着的话，题目根本不在 DOM 里）
   *  2. 滚动到它（错题一多，它可能在好几屏之外）
   *  3. 加高亮（滚动之后用户仍要确认「就是这条」）
   *
   * 依赖带 focusToken：同一题再点一次也要重新定位。
   */
  useEffect(() => {
    if (!focusCardId || !rows) return;
    const target = rows.find((r) => r.card.id === focusCardId);
    if (!target) return;

    /* 找出它属于哪个分组：用与渲染同一套 key 规则（2026-11-26 起一级 = 资料） */
    const groupKey = wrongSourceKey(target.sourceId);
    /*
     * 从首页点进来的一定是「错题」栏目里的题：先把栏目拉回错题、
     * 题型筛选回到「全部」，否则那题根本不在 DOM 里，展开分组也没用。
     */
    setTab('wrong');
    setKindFilter('all');
    /*
     * 用当时的 open 算新集合再交给 setOpen，而不是传函数。
     * `setOpen` 不是 React 的 setState，而是本页封装的
     * 「顺便通知宿主」的 setter（见上面的 setOpen 定义），它只接受一个 Set。
     */
    if (!open.has(groupKey)) {
      const next = new Set(open);
      next.add(groupKey);
      setOpen(next);
    }

    /*
     * 等两帧再滚。
     *
     * 一帧不够：上面 setOpen 触发的重渲染还没提交，目标节点
     * （刚展开的分组里的那一题）此刻**还不在 DOM 里**，
     * scrollIntoView 会作用到 null 上，表现为「进了错题页但没滚」。
     */
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.querySelector(`[data-wrong-card="${CSS.escape(focusCardId)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    /*
     * `rows` 必须在依赖里：错题是**异步读出来的**，首次渲染时 rows 还是 null，
     * 上面那行 `if (!rows) return` 会直接退出。若 rows 不入依赖，
     * 等数据到了 effect 也不会再跑一次 —— 定位就永远不生效。
     * （第一版正是漏了这个，验证脚本报「进了错题页但没高亮」。）
     */
  }, [focusCardId, focusToken, rows]);

  /**
   * 点「可点回原句 / 可点回原文」：把这张卡的锚点一起送到阅读器。
   *
   * 为什么不只传 sourceId：那样阅读器拿到 target=null，
   * 永远打开第一页 —— 用户点了等于没定位。
   */
  const openAtCard = useCallback(
    (card: Card) => {
      const a = anchorOf(card);
      const sid = card.sourceId ?? a?.sourceId ?? null;
      if (!sid) return;
      onOpenSource(sid, a);
    },
    [onOpenSource],
  );

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
      /*
       * 题目 id → 题目。
       * Card.id 就是 Question.id（cards-loader 的 questionToCard 原样带过来），
       * 所以错题的 card.id 可以直接去这里查收藏状态。
       */
      const questionById = new Map<string, Question>();
      await Promise.all(
        deckList.map(async (deck) => {
          try {
            const qs = await decks.getQuestions(deck.id);
            for (const q of qs) {
              pointIdByQuestion.set(q.id, q.knowledgePointId);
              questionById.set(q.id, q);
            }
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
        /*
         * 资料 id 走 sourceOf 的三层回退。
         * 只用 card.sourceId 的话，「题组没归属资料但锚点有出处」的题
         * 在错题页会显示成群标题没有书名 —— 我已经在真实库里见到
         * 同一页有的组有书名、有的没有，看起来像是数据坏了。
         */
        const sourceId = sourceOf(card, pointByQuestion) || null;
        out.push({
          card,
          wrongCount: d.wrongCount,
          reviewCount: d.reviewCount,
          lastWrongDay: d.lastWrongDay,
          wrongRate: d.reviewCount > 0 ? d.wrongCount / d.reviewCount : 1,
          deckTitle: deck?.title ?? null,
          chapter: chapterOf(card, pointByQuestion),
          sourceId,
          sourceTitle: sourceId ? (titleById.get(sourceId) ?? null) : null,
          favorite: questionById.get(card.id)?.favorite === true,
          /* 题被删了就没有 Question，退回卡片层的粗分类（不会显示成「未知」） */
          kind: questionById.get(card.id)?.kind ?? toQuestionKind(card.kind),
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

  /** 二级筛选后的行：先按栏目（错题 / 已收藏），再按题型 */
  const visibleRows = useMemo<WrongRow[]>(() => {
    if (!rows) return [];
    const base = tab === 'favorite' ? rows.filter((r) => r.favorite) : rows;
    return kindFilter === 'all' ? base : base.filter((r) => r.kind === kindFilter);
  }, [rows, tab, kindFilter]);

  /** 每种题型各几道（渲染在筛选项后面，让「0 道」也看得见） */
  const kindCounts = useMemo<Record<string, number>>(() => {
    const base = tab === 'favorite' ? (rows ?? []).filter((r) => r.favorite) : (rows ?? []);
    const out: Record<string, number> = { all: base.length };
    for (const r of base) out[r.kind] = (out[r.kind] ?? 0) + 1;
    return out;
  }, [rows, tab]);

  /** 分组（一级 = 资料）+ 组内排序 */
  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, WrongRow[]>();
    for (const r of visibleRows) {
      const key = wrongSourceKey(r.sourceId);
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
       * 标题 = 资料名。组内跨了多个题组时，note 写「N 个题组」——
       * 一本书先后生成过几批题很常见，写出来用户才知道这组为什么特别长。
       */
      out.push({
        key,
        title: sorted[0]!.sourceTitle ?? NO_SOURCE,
        note: deckNote(sorted),
        rows: sorted,
        worst: Math.max(...sorted.map((r) => r.wrongCount)),
      });
    }

    /*
     * 组间：错得最多的资料排前面。
     * 「未归类」永远最后 —— 它不是一本书，是数据缺口，
     * 摆在一堆正经资料中间会让人误以为那也是要复习的内容。
     */
    out.sort((a, b) => {
      if (a.title === NO_SOURCE) return 1;
      if (b.title === NO_SOURCE) return -1;
      return b.worst - a.worst || b.rows.length - a.rows.length;
    });

    return out;
  }, [visibleRows, sort]);

  const totalWrong = rows?.length ?? 0;
  const totalFavorite = rows?.filter((r) => r.favorite).length ?? 0;
  const repeatWrong = visibleRows.filter((r) => r.wrongCount > 1).length;

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
    /*
     * 直接算新集合，不用 setOpen(prev => ...)。
     * 受控之后 setOpen 是我们自己包的普通函数（它还要把新值上报给 App），
     * 不接受 React 的 updater 形式 —— 这一点在改造时踩到过 tsc 报错。
     */
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  }

  /**
   * 收藏 / 取消收藏一道题（2026-11-26）。
   *
   * 写的是 `Question.favorite`，与题库的「已收藏」是同一份数据 ——
   * 用户要的是「我标过的题」，不是「错题页自己的标记」。
   * 所以这里不落任何本页私有的状态，只把服务返回的结果镜像进 rows。
   *
   * 成功不弹提示：按钮从「☆ 收藏」变「★ 已收藏」本身就是反馈，
   * 多一行「已收藏」的 toast 反而让页面跳。失败才出声。
   */
  async function toggleFavorite(cardId: string) {
    if (favBusy) return;
    setFavBusy(cardId);
    setFavError(null);
    try {
      const updated = await decks.toggleFavorite(cardId);
      /* null = 题已被删（另开窗口删过）。不报错，下次刷新它自然消失 */
      if (!updated) return;
      setRows((prev) =>
        prev
          ? prev.map((r) => (r.card.id === cardId ? { ...r, favorite: updated.favorite === true } : r))
          : prev,
      );
    } catch (err) {
      setFavError(err instanceof Error ? err.message : '收藏失败');
    } finally {
      setFavBusy(null);
    }
  }

  /**
   * 导出当前视图里的错题为 Obsidian 闪卡。
   *
   * 选哪个题组：当前视图里错得最多的那道题所在的题组
   * （与列表默认排序一致，用户看到的第一个）。
   *
   * 为什么不逐个题组各导一个文件：一次点击产生多个下载会让人以为出错。
   */
  async function exportObsidian() {
    if (!groups.length) return;
    setExporting(true);
    setExportNote(null);
    try {
      /*
       * 选错题最多的那道题所在的题组。
       *
       * 2026-11-26 一级分组固定为资料后，一个资料组里的题会跨多个题组，
       * 所以不能再拿 groups[0].key 当题组 id —— 取当前视图里错得最多的
       * 那道题的 deckId。不逐个导多个文件：一次点击产生多个下载会让人以为出错。
       */
      const all = visibleRows.slice().sort((a, b) => b.wrongCount - a.wrongCount);
      const target = all[0]?.card.deckId ?? null;
      if (!target) {
        setExportNote('没有可导出的题组。');
        return;
      }
      const r = await onExportObsidian(target);
      setExportNote(`已导出 ${r.count} 张闪卡：${r.fileName}`);
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
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
          <div className="wbk-empty__actions">
            <button type="button" className="btn-ghost" onClick={onOpenPractice}>
              去开始做题
            </button>
            {/*
              空状态下也给变式入口 —— 用户可能想「直接针对某个知识点练」
              而不是先做错几道再来。这是他真实会走的一条路。
            */}
            {onOpenVariant ? (
              <button type="button" className="btn-text" onClick={onOpenVariant}>
                或直接对知识点出变式题 →
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* ---- 一级栏目：错题 / 已收藏 ---- */}
          <div className="wbk-tabs" role="tablist" aria-label="错题栏目">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'wrong'}
              className={`wbk-tab${tab === 'wrong' ? ' wbk-tab--on' : ''}`}
              onClick={() => setTab('wrong')}
            >
              错题<span className="wbk-tab__n">{totalWrong}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'favorite'}
              className={`wbk-tab${tab === 'favorite' ? ' wbk-tab--on' : ''}`}
              onClick={() => setTab('favorite')}
            >
              已收藏<span className="wbk-tab__n">{totalFavorite}</span>
            </button>
          </div>

          {/*
            ---- 二级筛选：题型 ----
            用户原话：「『按题型展开』改成二级筛选，以横排小标签形式
            展示在分组栏下方：全部 / 单选 / 多选 / 判断 / 填空等等，默认显示全部」。
            2026-11-26 补一句用户要求：「题型分类功能做全，所有可以生成的题型
            都要做出来，包括计算，判断等」—— 所以 6 种全列，不按「有没有出现过」裁掉；
            每种后面的数字直接说明这里有几道，0 道点了会看到空态说明。
          */}
          <div className="wbk-chips" role="group" aria-label="按题型筛选">
            <button
              type="button"
              data-kind="all"
              className={`wbk-chip${kindFilter === 'all' ? ' wbk-chip--on' : ''}`}
              aria-pressed={kindFilter === 'all'}
              onClick={() => setKindFilter('all')}
            >
              全部<span className="wbk-chip__n">{kindCounts.all ?? 0}</span>
            </button>
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                type="button"
                data-kind={k}
                className={`wbk-chip${kindFilter === k ? ' wbk-chip--on' : ''}`}
                aria-pressed={kindFilter === k}
                onClick={() => setKindFilter(k)}
              >
                {kindShort(k)}
                <span className="wbk-chip__n">{kindCounts[k] ?? 0}</span>
              </button>
            ))}
          </div>

          {/* ---- 概览 ---- */}
          <div className="wbk-stats">
            <span className="wbk-stat">
              <span className="wbk-stat__n">{visibleRows.length}</span>
              <span className="wbk-stat__label">{tab === 'wrong' ? '道错题' : '道已收藏'}</span>
            </span>
            <span className="wbk-stat">
              <span className="wbk-stat__n">{groups.length}</span>
              <span className="wbk-stat__label">份资料</span>
            </span>
            {repeatWrong > 0 ? (
              <span className="wbk-stat wbk-stat--warn">
                <span className="wbk-stat__n">{repeatWrong}</span>
                <span className="wbk-stat__label">道错过不止一次</span>
              </span>
            ) : null}
          </div>

          {favError ? <p className="wbk-error wbk-error--inline">{favError}</p> : null}

          {/* ---- 排序 + 右侧动作 ---- */}
          <div className="wbk-toolbar">
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
              {/*
                错题变式（2026-11-12 挪到这里）。

                ## 原来在哪、为什么挪

                原来单独一行浮在统计卡与工具栏之间，两侧大片留白，
                看起来像「忘了归位的按钮」。用户原话：「太过突兀」。

                现在放进工具栏右侧的动作组，与「导出到 Obsidian」同级 ——
                它本来就是「对这一批错题做点什么」的同类动作，
                而不是整个页面的主操作（那是「去练错题」）。
              */}
              {onOpenVariant ? (
                <button
                  type="button"
                  className="wbk-seg__btn wbk-seg__btn--outline"
                  onClick={onOpenVariant}
                  title="挑几道错题，让 AI 出同类但不同的新题"
                >
                  错题变式
                </button>
              ) : null}
              <button
                type="button"
                className="wbk-seg__btn wbk-seg__btn--outline"
                onClick={() => void exportObsidian()}
                disabled={exporting}
                title="导出为 Obsidian 闪卡（.md），可直接放进你的笔记库"
              >
                {exporting ? '导出中…' : '导出到 Obsidian'}
              </button>
              <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenPractice}>
                去练错题
              </button>
            </div>
          </div>

          {/*
            导出结果提示。成功与失败共用一行 ——
            放在工具条下方，紧挨着操作按钮，用户点完就能看到结果。
          */}
          {exportNote ? (
            <p className="wbk-export-note" role="status">
              {exportNote}
            </p>
          ) : null}

          {/* ---- 分组列表（默认收起） ---- */}
          {visibleRows.length === 0 ? (
            <p className="wbk-hint wbk-empty-filter">
              {tab === 'favorite'
                ? '这个筛选下还没有收藏的错题。点题目上的「☆ 收藏」把它收进来。'
                : '这个题型下没有错题，换个题型看看。'}
            </p>
          ) : (
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
                        <li
                          key={r.card.id}
                          className={`wbk-item${
                            focusCardId === r.card.id ? ' wbk-item--focus' : ''
                          }`}
                          /* 定位用：从首页点进来时靠它 scrollIntoView */
                          data-wrong-card={r.card.id}
                        >
                          <div className="wbk-item__head">
                            <span className="wbk-item__count">错 {r.wrongCount} 次</span>
                            <span className="wbk-item__rate">
                              共做 {r.reviewCount} 次 · 错 {Math.round(r.wrongRate * 100)}%
                            </span>
                            <span className="wbk-item__kind">{kindShort(r.kind)}</span>
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
                            {/*
                              收藏（2026-11-26）。
                              紧跟题组名放左边：「对这道题做标记」是题目的属性；
                              右边的「出变式题 / 看原文」才是离开这一页的动作。
                            */}
                            <button
                              type="button"
                              className={`wbk-item__fav${r.favorite ? ' wbk-item__fav--on' : ''}`}
                              aria-pressed={r.favorite}
                              disabled={favBusy === r.card.id}
                              onClick={() => void toggleFavorite(r.card.id)}
                              title={
                                r.favorite
                                  ? '取消收藏（题库的「已收藏」里会同步移除）'
                                  : '收藏这道题（题库的「已收藏」里也能看到）'
                              }
                            >
                              {r.favorite ? '★ 已收藏' : '☆ 收藏'}
                            </button>
                            {/*
                              单题变式（2026-11-12）。
                              用户反馈「我需要一个入口，你做了功能可是没有使用入口」——
                              变式原本只能从「我的题组 → 新建题组」三步进去，
                              而错题页才是最该有它的地方：这里每一题都是做错的题。
                            */}
                            {onVariantSingle ? (
                              <button
                                type="button"
                                className="btn-text wbk-item__variant"
                                onClick={() => onVariantSingle(r.card.id)}
                                title="用这道错题出一道同类但不同的新题"
                              >
                                出变式题
                              </button>
                            ) : null}
                            {r.card.sourceId || anchorOf(r.card) ? (
                              <button
                                type="button"
                                className="btn-text"
                                onClick={() => openAtCard(r.card)}
                                title={precisionCopy(
                                  anchorPrecision(anchorOf(r.card)),
                                  anchorOf(r.card)?.page,
                                ).hint}
                              >
                                {precisionCopy(
                                  anchorPrecision(anchorOf(r.card)),
                                  anchorOf(r.card)?.page,
                                ).badge}
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
          )}
        </>
      )}
    </div>
  );
}

/**
 * 取这张卡的第一条锚点。
 *
 * 只取第一条：一道题可能跨多段（知识点跨页），但用户点「看原文」时
 * 想先看到的是**起点**。把多条都塞过去只会让阅读器不知道跳哪。
 * 其余锚点在阅读器里仍在（它们本来就存在题目上），只是这里不主动引导。
 */
function anchorOf(card: Card): SourceLocation | null {
  const a = card.anchors && card.anchors.length > 0 ? card.anchors[0] : null;
  return a ?? null;
}

/**
 * 卡片层的粗分类 → 题目层的真实题型（只在找不到 Question 时兜底）。
 *
 * 卡片把问答与计算都压成 short，这里没法还原是哪一种 —— 退回 essay
 * （两者交互一样，都是长文本 + 自评），至少不会显示成「单选」。
 */
function toQuestionKind(kind: CardKind): QuestionKind {
  switch (kind) {
    case 'single':
    case 'multiple':
    case 'truefalse':
    case 'blank':
      return kind;
    case 'short':
    case 'point':
      return 'essay';
    default:
      return 'essay';
  }
}

/**
 * 一组的次要说明：这一组跨了几个题组。
 *
 * 一级分组按资料后，同一份资料先后生成过几批题是常态；
 * 只写「12 道」会让人以为漏了，写「3 个题组」才解释得通。
 * 只有一个题组时不写 —— 那是默认情况，多一句只是噪音。
 */
function deckNote(rows: WrongRow[]): string | null {
  const titles = [...new Set(rows.map((r) => r.deckTitle).filter((t): t is string => !!t))];
  if (titles.length <= 1) return null;
  return `${titles.length} 个题组`;
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
