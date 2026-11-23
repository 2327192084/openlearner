/**
 * 闪卡管理（2026-11-14 按用户反馈重做）。
 *
 * ## 用户反馈原话
 *
 * > 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 * >  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。
 * >  同时还要有导出功能导出到 obsidian 中（要符合 obsidian 支持的格式，
 * >  应该是 markdown 格式）」
 *
 * ## 这一页现在做四件事
 *
 * 1. **新建**（三种入口）：
 *    - 从知识库挑知识点 → 抄成卡
 *    - 从错题库挑错题 → 正面题干、背面答案+解析
 *    - 空白手写一张
 * 2. **编辑**：正面/背面都能改（它们是这张卡自己的内容）
 * 3. **删除**：删的是这条记录（独立内容，删了不从别处重建）
 * 4. **导出**：Obsidian Spaced Repetition 插件认的 markdown
 *
 * ## 为什么这一页不再有「来源已删」这种标签
 *
 * 上一版把卡做成「引用」，来源删了就标「来源已删」。现在卡是独立的，
 * 来源与卡片无关 —— 所以那种状态字段在数据模型里也已经删掉了
 * （见 model.ts 的 Flashcard 注释）。来源只剩一个追溯标签「来自：XXX」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlashcardService, FlashcardView } from '@/core/flashcards.ts';
import type { ReviewService } from '@/v2/core/review-service.ts';
import type { CardLoader } from './cards-loader.ts';
import type { Card } from '@/v2/core/cards.ts';
import type { KnowledgePoint } from '@/core/model.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import { MathText } from './MathText.tsx';
import { CardCallout } from './CardCallout.tsx';
import { hasCloze } from './card-rich.ts';
import { downloadBlob } from '@/pages/slides/download.ts';
import {
  DEFAULT_FILTER,
  NO_SOURCE,
  collectTags,
  countByGroup,
  filterCards,
  groupBySource,
  toUnifiedCards,
  type CardFilter,
  type FlashcardGroup,
  type UnifiedCard,
} from './flashcard-manage.ts';
import {
  flashcardFileName,
  flashcardsToObsidianMarkdown,
} from '@/v2/core/flashcard-export.ts';
import { PickBanner, PickButton } from './PickBanner.tsx';
import { CardTagEditor } from './CardTagEditor.tsx';

export interface FlashcardsPageProps {
  flashcards: FlashcardService;
  reviewService: ReviewService;
  knowledge: KnowledgeService;
  loadCards: CardLoader;
  /** 真正开始背（在复习巩固页） */
  onGoReview?: () => void;
  /**
   * 让后端 AI 帮忙写卡（2026-11-14，用户要求）。
   *
   * 传入素材，返回写好的正反面。不传就不显示那个按钮（不做假开关）。
   */
  onMakeCards?: (
    material: { kind: 'point' | 'wrong' | 'text'; text: string; hint?: string | null },
    count?: number,
  ) => Promise<{ front: string; back: string }[]>;
  /**
   * 从阅读器划选带过来的 AI 草稿（2026-11-14）。
   *
   * 用户要求「和让 ai 提问一样，用户可以划选资料内容制作闪卡」——
   * 阅读器算完卡会跳到这一页，草稿要能在这里落进「待确认」区。
   * token 存在是为了同一段文字再点一次也能重新塞进来。
   */
  incomingAiCards?: {
    cards: { front: string; back: string }[];
    source: { kind: 'point' | 'wrong' | 'text'; sourceId2?: string | null; sourceId?: string | null };
    error?: string;
    token: number;
  } | null;
  /** 草稿已被这一页接住，请宿主清掉 */
  onIncomingConsumed?: () => void;
  /**
   * 选取会话（2026-11-23，用户待办第 1 项：绑定面板改跳转选取）。
   *
   * 从学习地图小节详情点「+ 去闪卡页挑」进来时非空：
   * 顶部出横幅说明在为哪一节挑，每张卡的操作区多一个「选这个」，
   * 点了即时绑上（`onPickCard`），挑完「返回地图」。
   * 为 null 时这一页和原来完全一样 —— 不加任何控件（假开关双向查）。
   */
  pickContext?: import('./pick-context.ts').PickSession | null;
  /** 这一节已绑的闪卡 id（「选这个」据此显示「已绑上」，防重复计数） */
  pickBoundCardIds?: readonly string[];
  /** 点「选这个」：宿主负责写回树并持久化（本页不碰地图数据） */
  onPickCard?: (cardId: string) => void;
  /** 「返回地图」：宿主清会话 + 回 mapTree + 恢复小节详情 */
  onBackFromPick?: () => void;
  /**
   * 资料 id → 标题（2026-11-23，按资料分组要用）。
   *
   * 由宿主（App）注入 —— 组件不碰存储是项目一贯分工。
   * 不给就退化成「不分组」的平铺列表（而不是显示裸 id，
   * 那类 `__all__` 露内部标识的事故项目记过）。
   */
  sourceTitleOf?: (sourceId: string) => string | null;
}

/**
 * 三种新建来源。
 *
 * ⚠️ `'manual'` 是**内部标识**（对应界面上的「记忆闪卡」入口），
 * 不改名是为了不牵动 addManual 那一串调用；
 * 界面上这一栏 2026-11-23 已从「手写的」改名「记忆闪卡」（用户要求）。
 */
type NewKind = 'point' | 'wrong' | 'manual';

/**
 * 背面标记行的插入模板（2026-11-23，规范 A4）。
 *
 * 四种标记与三处保持同步（少一处就是"说的和做的两件事"）：
 * - 渲染器认的：`card-rich.ts` 的 ROLE_PREFIX / ROLE_ICON
 * - AI 提示词要求的：`make-flashcards.ts` 的 buildCardPrompt
 * - 导出时写的：`flashcard-export.ts`
 * 规范全文在 `docs/规范-闪卡编写格式.md`。
 */
const MARK_INSERTS: { mark: string; insert: string; title: string }[] = [
  { mark: '✅', insert: '✅答案：', title: '插入答案行' },
  { mark: '💡', insert: '💡要点：', title: '插入要点行（多条时下面接 1. 2. 列表）' },
  { mark: '⚠️', insert: '⚠️限制条件：', title: '插入适用条件/不成立情形' },
  { mark: '❌', insert: '❌坑：', title: '插入最常见的错法（错题卡建议必写）' },
];

export function FlashcardsPage({
  flashcards,
  reviewService,
  knowledge,
  loadCards,
  onGoReview,
  onMakeCards,
  incomingAiCards,
  onIncomingConsumed,
  pickContext = null,
  pickBoundCardIds,
  onPickCard,
  onBackFromPick,
  sourceTitleOf,
}: FlashcardsPageProps) {
  const [views, setViews] = useState<FlashcardView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [filter, setFilter] = useState<CardFilter>(DEFAULT_FILTER);
  /*
   * 按所属资料分组（2026-11-23，用户要求「在三大类型闪卡下按照所属资料进行分类」）。
   *
   * 默认开：用户提这条就是因为他要按资料看。
   * 留开关是因为分组后"找某一张卡"要多绕一层，纯浏览/搜索时平铺更快。
   * ⚠️ 只在宿主给了 sourceTitleOf 时才可能分组 —— 没有标题来源就
   * 老老实实平铺，不显示这个开关（不做假开关，硬约束 11）。
   */
  const [grouped, setGrouped] = useState(true);
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<UnifiedCard | null>(null);

  /** 正在编辑的卡（正面/背面/标签草稿） */
  const [editing, setEditing] = useState<{
    id: string;
    front: string;
    back: string;
    tags: string[];
  } | null>(null);

  /** 新建面板 */
  const [newKind, setNewKind] = useState<NewKind | null>(null);
  const [manualFront, setManualFront] = useState('');
  const [manualBack, setManualBack] = useState('');
  /** 新建时就能打标签（2026-11-23）—— 用户说"编写完成后通过选择标签决定存放位置" */
  const [manualTags, setManualTags] = useState<string[]>([]);

  /** AI 帮忙写的草稿（先给用户看，确认后才入库） */
  const [aiDrafts, setAiDrafts] = useState<{ front: string; back: string }[] | null>(null);
  /**
   * AI 草稿是从哪份素材写的。
   *
   * 必须记住：草稿收下时要写入 sourceKind/sourceId2（追溯用）。
   * 第一版在「收下」按钮那里写死了 kind:'manual'，结果从知识点
   * 用 AI 写的卡会丢掉来源，界面上再也看不出它是从哪来的。
   */
  const [aiSource, setAiSource] = useState<{
    kind: 'point' | 'wrong' | 'text';
    sourceId2?: string | null;
    sourceId?: string | null;
  } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  /** 挑素材时的候选列表 */
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [wrongCards, setWrongCards] = useState<Card[] | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await flashcards.listWithLabels();
      setViews(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不出闪卡');
    }
  }, [flashcards]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 接住从阅读器带过来的 AI 草稿（2026-11-14）。
   *
   * 用 token 做依赖：同一段文字再点一次「做成闪卡」token 会变，
   * 这里就能重新接住 —— 否则第二次点没反应（页面已经挂着旧草稿）。
   */
  useEffect(() => {
    if (!incomingAiCards) return;
    if (incomingAiCards.error) {
      setError(incomingAiCards.error);
      setAiDrafts(null);
    } else {
      setAiDrafts(incomingAiCards.cards);
      setAiSource({
        kind: incomingAiCards.source.kind,
        ...(incomingAiCards.source.sourceId2 !== undefined
          ? { sourceId2: incomingAiCards.source.sourceId2 }
          : {}),
        ...(incomingAiCards.source.sourceId !== undefined
          ? { sourceId: incomingAiCards.source.sourceId }
          : {}),
      });
      setNotice('AI 从你划选的那段写了一张卡，看一眼再决定收不收。');
    }
    onIncomingConsumed?.();
    /*
     * 只依赖 token：incomingAiCards 每次都是新对象，
     * 按引用比会重复消费。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingAiCards?.token]);

  const cards = useMemo(() => (views ? toUnifiedCards(views) : null), [views]);
  const counts = useMemo(() => (cards ? countByGroup(cards) : null), [cards]);
  const visible = useMemo(() => (cards ? filterCards(cards, filter) : []), [cards, filter]);

  /**
   * 库里已有的标签（标签编辑器的候选 + 标签筛选条）。
   * 从**全部卡**算，不是从 visible 算 —— 否则筛掉一批之后
   * 用户就看不到别的标签了，越筛越窄出不来。
   */
  const knownTags = useMemo(() => (cards ? collectTags(cards) : []), [cards]);

  /*
   * 列表要渲染的"行"（2026-11-23，按资料分组）。
   *
   * ## 为什么把组头塞进同一个行流而不是嵌套 <ul>
   *
   * 这一页已经 990+ 行（硬约束 8：大文件别再堆结构）。
   * 行流只改 map 的入口与出口两处，卡片渲染体一行不动；
   * 嵌套两层 <ul> 要把整段 body 缩进重写，那种改动最容易在
   * 中途丢一个 return 而 tsc 还照样过。
   *
   * ## 分组数据来自 visible（不是全部卡）
   *
   * 组头的计数与"这一组有几张显示出来"必须是同一个数 ——
   * 若按全库算组、再按筛选过滤卡，就会出现「信号与系统 8 张」
   * 底下只列 2 张的关系错误（重复计数那类，项目记过多次）。
   */
  const listRows = useMemo(() => {
    type Row =
      | { kind: 'head'; key: string; title: string; count: number; sourceId: string | null; collapsed: boolean }
      | { kind: 'card'; key: string; card: UnifiedCard };

    const rows: Row[] = [];
    const canGroup = !!sourceTitleOf && grouped;
    if (!canGroup) {
      for (const c of visible) rows.push({ kind: 'card', key: c.key, card: c });
      return rows;
    }
    const groups = groupBySource(
      visible,
      (id) => sourceTitleOf!(id),
    );
    for (const g of groups) {
      const key = g.sourceId ?? NO_SOURCE;
      const collapsed = collapsedSources.has(key);
      rows.push({ kind: 'head', key: `h:${key}`, title: g.title, count: g.count, sourceId: g.sourceId, collapsed });
      if (!collapsed) for (const c of g.cards) rows.push({ kind: 'card', key: c.key, card: c });
    }
    return rows;
  }, [visible, sourceTitleOf, grouped, collapsedSources]);

  /**
   * 某张卡在**全部卡**里的序号（不是筛选后的）。
   *
   * 理由见调用处：callout 头部的「闪卡 N」是用户认这张卡的编号，
   * 筛选不该改变它。
   */
  const cardIndexOf = (c: UnifiedCard): number => {
    if (!cards) return 0;
    const at = cards.findIndex((x) => x.id === c.id);
    return at < 0 ? 0 : at;
  };

  /** 打开某个新建面板时按需读候选（不要一进页面就读全库） */
  const openNew = useCallback(
    async (kind: NewKind) => {
      setNewKind(kind === newKind ? null : kind);
      setError(null);
      if (kind === 'point' && points === null) {
        try {
          const list = await knowledge.listAll();
          setPoints(list);
        } catch (e) {
          setError(e instanceof Error ? e.message : '读不出知识点');
        }
      }
      if (kind === 'wrong' && wrongCards === null) {
        try {
          const rows = await reviewService.wrongCardsDetailed();
          const all = await loadCards();
          const byId = new Map(all.map((c) => [c.id, c]));
          setWrongCards(
            rows.map((r) => byId.get(r.cardId)).filter((c): c is Card => !!c),
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : '读不出错题');
        }
      }
    },
    [newKind, points, wrongCards, knowledge, reviewService, loadCards],
  );

  /** 从知识点建卡 —— 内容在这一刻被抄进卡片，之后与知识点无关 */
  async function addFromPoint(p: KnowledgePoint) {
    setBusy(true);
    try {
      const created = await flashcards.add({
        frontText: p.statement,
        backText: null,
        sourceKind: 'point',
        sourceId2: p.id,
        knowledgePointId: p.id,
        sourceId: p.sourceId ?? null,
        origin: 'user',
      });
      setNotice(created ? '已加入闪卡。可以接着挑，或关掉面板看卡片。' : '这张卡已经有了（正面完全相同）。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入失败');
    } finally {
      setBusy(false);
    }
  }

  /** 从错题建卡 —— 题干抄进正面、答案+解析抄进背面 */
  async function addFromWrong(card: Card) {
    setBusy(true);
    try {
      const answer = (card.answer ?? '').trim();
      const why = (card.explanation ?? '').trim();
      const back = answer && why ? `答案：${answer}\n\n${why}` : answer ? `答案：${answer}` : why || null;

      const created = await flashcards.add({
        frontText: card.prompt,
        backText: back,
        sourceKind: 'wrong',
        sourceId2: card.id,
        origin: 'user',
      });
      setNotice(created ? '已做成闪卡。' : '这张卡已经有了（正面完全相同）。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '做成闪卡失败');
    } finally {
      setBusy(false);
    }
  }

  /** 手写一张 */
  async function addManual() {
    if (!manualFront.trim()) {
      setError('正面不能是空的。');
      return;
    }
    setBusy(true);
    try {
      await flashcards.add({
        frontText: manualFront,
        backText: manualBack,
        sourceKind: 'manual',
        origin: 'user',
        /* 标签（2026-11-23）：新建时就带上，不用建完再点编辑 */
        tags: manualTags,
      });
      setManualFront('');
      setManualBack('');
      setManualTags([]);
      setNotice('已新建一张。');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.front.trim()) {
      setError('正面不能是空的。');
      return;
    }
    setBusy(true);
    try {
      await flashcards.update(editing.id, {
        frontText: editing.front,
        backText: editing.back,
        /* 标签（2026-11-23）：整体替换；服务层会 normalizeTags 去空去重 */
        tags: editing.tags,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function removeCard(c: UnifiedCard) {
    setBusy(true);
    try {
      await flashcards.remove(c.id);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除没成功');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 导出成 Obsidian markdown。
   *
   * 导出**当前筛选结果**而不是全部：用户按「错题闪卡」筛完再导出，
   * 期待的就是那一组（导出全部会让他拿到一堆不想要的卡）。
   * 界面上会明写导出了几张。
   */
  function exportObsidian() {
    if (!views) return;
    const picked = new Set(visible.map((c) => c.id));
    const list = views.filter((v) => picked.has(v.card.id)).map((v) => v.card);
    if (list.length === 0) {
      setError('当前筛选结果里没有卡片可导出。');
      return;
    }

    const labelOf = (c: (typeof list)[number]): string | null => {
      const v = views.find((x) => x.card.id === c.id);
      return v?.sourceLabel ?? null;
    };

    /*
     * ⚠️ warnings 必须显示出来（2026-11-23）。
     *
     * 上一版这里只解构 content/count，把 warnings 丢了 ——
     * 那是硬约束 11 的"做了没接上"：导出器花力气算出"有 3 张卡没写背面"
     * "没开填空开关就一张都进不了复习队列"，界面却不吭声，
     * 用户拿到文件才发现不对。
     *
     * 另外文案不能说"放进 Obsidian 库里即可"—— 用户本机目前**没装**
     * Spaced Repetition 插件（取证确认），不装就只是普通笔记。
     */
    const { content, count, warnings } = flashcardsToObsidianMarkdown(
      'Open Learner 闪卡',
      list,
      { includeSource: true },
      labelOf,
    );
    downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), flashcardFileName('Open Learner 闪卡'));
    setNotice(
      `已导出 ${count} 张卡。` +
        (warnings.length > 0 ? ' ' + warnings.join(' ') : '') +
        '（要在 Obsidian 里翻卡复习，需装 Spaced Repetition 插件；没装就只是普通笔记。）',
    );
  }

  /**
   * 让 AI 根据这段素材写卡（2026-11-14）。
   *
   * 结果**先展示、不直接入库** —— 模型偶尔会写出偏离素材的卡，
   * 用户要能先看一眼再决定收不收。这比"自动加进去再让他删"好得多。
   */
  async function makeWithAi(material: {
    kind: 'point' | 'wrong' | 'text';
    text: string;
    hint?: string | null;
    sourceId2?: string | null;
    sourceId?: string | null;
  }) {
    if (!onMakeCards) return;
    setAiBusy(true);
    setError(null);
    setAiDrafts(null);
    setAiSource({ kind: material.kind, sourceId2: material.sourceId2 ?? null, sourceId: material.sourceId ?? null });
    try {
      const cards = await onMakeCards(
        { kind: material.kind, text: material.text, hint: material.hint ?? null },
        1,
      );
      setAiDrafts(cards);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 没能写出卡');
    } finally {
      setAiBusy(false);
    }
  }

  /** 把 AI 写的卡收下 */
  async function acceptAiDrafts(material: {
    kind: 'point' | 'wrong' | 'text' | 'manual';
    text: string;
    sourceId2?: string | null;
    sourceId?: string | null;
  }) {
    if (!aiDrafts) return;
    setBusy(true);
    try {
      const created = await flashcards.addMany(
        aiDrafts.map((c) => ({
          frontText: c.front,
          backText: c.back || null,
          sourceKind:
            material.kind === 'text' || material.kind === 'manual'
              ? ('manual' as const)
              : material.kind,
          sourceId2: material.sourceId2 ?? null,
          sourceId: material.sourceId ?? null,
          origin: 'ai' as const,
          /*
           * 卡型按**内容**推断（2026-11-23）：正面含 ==挖空== 就标 cloze。
           *
           * ⚠️ 为什么不让调用方传：调用方只知道"我要挖空卡"，
           * 但模型有时不守格式（挖空标记漏了）。以内容为准才能保证
           * "标成 cloze 的卡真的有挖空可点" —— 反过来（按调用方传的标）
           * 会出现"卡被标成挖空、界面上一个可点的地方都没有"。
           * 这是"标签与实际内容"的关系断言，理由同 11-23 那几次。
           */
          ...(hasCloze(c.front) ? { format: 'cloze' as const } : {}),
        })),
      );
      setNotice(created.length > 0 ? `已收下 ${created.length} 张 AI 写的卡。` : '这些卡库里已经有了。');
      setAiDrafts(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '收下失败');
    } finally {
      setBusy(false);
    }
  }

  function toggleOpen(id: string) {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!cards) {
    return (
      <div className="fcx">
        <h1 className="fcx__title">闪卡管理</h1>
        <p className="fcx__lead">{error ?? '正在读闪卡…'}</p>
      </div>
    );
  }

  /*
   * 三大类型（2026-11-23：第三栏从「手写的」改成「记忆闪卡」）。
   * 用户原话：「可以去掉手写的闪卡这一栏」—— 旧手写卡不迁移，
   * 只是换个栏显示（映射在 flashcard-manage.ts 的 toUnifiedCards）。
   */
  const TABS: { id: FlashcardGroup | 'all'; label: string; n: number }[] = [
    { id: 'all', label: '全部', n: counts?.total ?? 0 },
    { id: 'point', label: '知识点闪卡', n: counts?.point ?? 0 },
    { id: 'wrong', label: '错题闪卡', n: counts?.wrong ?? 0 },
    { id: 'memory', label: '记忆闪卡', n: counts?.memory ?? 0 },
  ];

  return (
    <div className="fcx">
      {/*
       * 选取模式横幅（2026-11-23）。boundCount 取的是**会话那一节当前已绑**的
       * 真实数量（App 从树里算好传来）—— 横幅数字与写回目标是同一来源，
       * 不许本页自己数 visible 里几个被点过（那会漂）。
       */}
      {pickContext && onBackFromPick ? (
        <PickBanner
          session={pickContext}
          boundCount={(pickBoundCardIds ?? []).length}
          onBack={onBackFromPick}
        />
      ) : null}

      <header className="fcx__head">
        <div>
          <h1 className="fcx__title">闪卡管理</h1>
          <p className="fcx__lead">
            闪卡是**独立的一份内容**：从知识点或错题挑出来之后，它们就和来源无关了 ——
            原件删了、改了，卡片都不受影响。也可以直接从空白写一张。
          </p>
        </div>
        <div className="fcx__head-actions">
          <button type="button" className="btn-fill btn-fill--sm" onClick={() => void openNew('point')}>
            ＋ 从知识点
          </button>
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => void openNew('wrong')}>
            ＋ 从错题
          </button>
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => void openNew('manual')}>
            ＋ 记忆闪卡
          </button>
        </div>
      </header>

      {error ? <p className="fcx__err">{error}</p> : null}
      {notice ? (
        <p className="fcx__notice" role="status">
          {notice}
          <button type="button" className="fcx__notice-x" onClick={() => setNotice(null)} aria-label="关掉提示">
            ×
          </button>
        </p>
      ) : null}

      {/* ---------- 新建面板 ---------- */}
      {newKind === 'manual' ? (
        <div className="fcx__new">
          <h2 className="fcx__new-title">记忆闪卡</h2>
          <p className="fcx__new-hint">
            自己写一张，或让 AI 把你写的组织成一问一答。这一栏 2026-11-23 从「手写」改名为
            「记忆」—— 你原来手写的卡都在这里面，一张没少。
          </p>
          <label className="fcx__field">
            <span className="fcx__field-label">正面（问题/提示）</span>
            <textarea
              className="fcx__textarea"
              value={manualFront}
              onChange={(e) => setManualFront(e.target.value)}
              rows={3}
              placeholder="例如：导数的定义是什么？想挖空就写成：导数是 ==差商的极限=="
              aria-label="正面"
            />
          </label>
          <label className="fcx__field">
            <span className="fcx__field-label">背面（答案/解释，可不填）</span>
            <textarea
              className="fcx__textarea"
              value={manualBack}
              onChange={(e) => setManualBack(e.target.value)}
              rows={4}
              placeholder={'可以按规范写标记行：\n✅答案：…\n💡要点：…\n⚠️限制条件：…\n❌坑：…'}
              aria-label="背面"
            />
          </label>
          {/* 标记行插入（与编辑态同一套模板，不各写一份） */}
          <div className="fcx__marks">
            {MARK_INSERTS.map((m) => (
              <button
                key={m.mark}
                type="button"
                className="fcx__markbtn"
                onClick={() =>
                  setManualBack((prev) => (prev ? prev.replace(/\n$/, '') + '\n' : '') + m.insert)
                }
                disabled={busy}
                title={m.title}
              >
                {m.mark}
              </button>
            ))}
            <span className="fcx__marks-hint">点一下往背面加一行（不强制，随便改）</span>
          </div>
          <CardTagEditor value={manualTags} known={knownTags} onChange={setManualTags} disabled={busy} />
          <div className="fcx__new-actions">
            <button type="button" className="btn-fill btn-fill--sm" onClick={() => void addManual()} disabled={busy}>
              建卡
            </button>
            {onMakeCards && manualFront.trim() ? (
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                disabled={busy || aiBusy}
                onClick={() => void makeWithAi({ kind: 'text', text: manualFront, hint: null })}
                title="把你写的这段交给 AI，让它整理成一张问答卡"
              >
                AI 帮我写
              </button>
            ) : null}
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => setNewKind(null)}>
              收起
            </button>
          </div>
        </div>
      ) : null}

      {newKind === 'point' ? (
        <div className="fcx__new">
          <h2 className="fcx__new-title">从知识点挑</h2>
          <p className="fcx__new-hint">点一条就把它做成一张闪卡。内容会抄进卡片，之后改动知识点不影响它。</p>
          {points === null ? (
            <p className="fcx__lead">正在读知识点…</p>
          ) : points.length === 0 ? (
            <p className="fcx__lead">知识库还是空的。先去「整理知识点」把正文变成知识点。</p>
          ) : (
            <ul className="fcx__pick">
              {points.slice(0, 200).map((p) => {
                const already = cards.some((c) => c.group === 'point' && c.front === p.statement.trim());
                return (
                  <li key={p.id} className="fcx__pick-item">
                    <span className="fcx__pick-text">
                      <MathText text={p.statement} />
                    </span>
                    {p.chapter ? <span className="fcx__pick-ch">{p.chapter}</span> : null}
                    <button
                      type="button"
                      className="fcx__act"
                      disabled={busy || already}
                      onClick={() => void addFromPoint(p)}
                    >
                      {already ? '已加入' : '加入闪卡'}
                    </button>
                    {onMakeCards ? (
                      <button
                        type="button"
                        className="fcx__act"
                        disabled={busy || aiBusy}
                        onClick={() =>
                          void makeWithAi({
                            kind: 'point',
                            text: p.statement,
                            hint: p.chapter ?? null,
                            sourceId2: p.id,
                            sourceId: p.sourceId ?? null,
                          })
                        }
                        title="让 AI 把这条知识点写成一张问答卡"
                      >
                        AI 写一张
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => setNewKind(null)}>
            收起
          </button>
        </div>
      ) : null}

      {newKind === 'wrong' ? (
        <div className="fcx__new">
          <h2 className="fcx__new-title">从错题挑</h2>
          <p className="fcx__new-hint">
            正面是题干，背面是答案 + 解析（都是从题目抄过来的，之后题目改了也不影响）。
          </p>
          {wrongCards === null ? (
            <p className="fcx__lead">正在读错题…</p>
          ) : wrongCards.length === 0 ? (
            <p className="fcx__lead">现在没有错题。做错的题会自动进错题集。</p>
          ) : (
            <ul className="fcx__pick">
              {wrongCards.map((c) => {
                const already = cards.some((x) => x.group === 'wrong' && x.front === c.prompt.trim());
                return (
                  <li key={c.id} className="fcx__pick-item">
                    <span className="fcx__pick-text">
                      <MathText text={c.prompt.length > 120 ? `${c.prompt.slice(0, 120)}…` : c.prompt} />
                    </span>
                    <button
                      type="button"
                      className="fcx__act"
                      disabled={busy || already}
                      onClick={() => void addFromWrong(c)}
                    >
                      {already ? '已加入' : '做成闪卡'}
                    </button>
                    {onMakeCards ? (
                      <button
                        type="button"
                        className="fcx__act"
                        disabled={busy || aiBusy}
                        onClick={() =>
                          void makeWithAi({
                            kind: 'wrong',
                            text: `题干：${c.prompt}
答案：${c.answer ?? ''}
解析：${c.explanation ?? ''}`,
                            hint: null,
                            sourceId2: c.id,
                            sourceId: c.sourceId ?? null,
                          })
                        }
                        title="让 AI 从这道错题写一张卡（背面会点出为什么错）"
                      >
                        AI 写一张
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => setNewKind(null)}>
            收起
          </button>
        </div>
      ) : null}

      {/* ---------- AI 写的草稿：先看后收 ---------- */}
      {aiBusy ? <p className="fcx__lead">AI 正在写卡…</p> : null}
      {aiDrafts ? (
        <div className="fcx__ai">
          <h2 className="fcx__new-title">AI 写的卡（看一眼再决定收不收）</h2>
          <ul className="fcx__ai-list">
            {aiDrafts.map((c, i) => (
              <li key={i} className="fcx__ai-item">
                <p className="fcx__front">
                  <MathText text={c.front} />
                </p>
                {c.back ? (
                  <div className="fcx__back">
                    <MathText text={c.back} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="fcx__new-actions">
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => void acceptAiDrafts({ kind: aiSource?.kind ?? 'text', text: '', sourceId2: aiSource?.sourceId2 ?? null, sourceId: aiSource?.sourceId ?? null })}
              disabled={busy}
            >
              收下这些卡
            </button>
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => setAiDrafts(null)}>
              不要
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- 筛选条 ---------- */}
      <div className="fcx__bar">
        <div className="fcx__tabs" role="tablist" aria-label="闪卡来源">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter.group === t.id}
              className={`fcx__tab${filter.group === t.id ? ' fcx__tab--on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, group: t.id }))}
            >
              {t.label}
              <span className="fcx__tab-n">{t.n}</span>
            </button>
          ))}
        </div>

        <input
          className="fcx__search"
          value={filter.query}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          placeholder="搜正面或背面的内容…"
          spellCheck={false}
          aria-label="搜索闪卡"
        />

        <button type="button" className="fcx__export" onClick={exportObsidian} disabled={visible.length === 0}>
          导出到 Obsidian（{visible.length} 张）
        </button>
      </div>

      {/*
       * 第二行筛选（2026-11-23）：按资料分组开关 + 标签。
       *
       * ⚠️ 整行只在宿主给了 sourceTitleOf 时才出现 ——
       * 没有标题来源就分不了组，摆个开关等于假开关（硬约束 11）。
       */}
      {sourceTitleOf && cards.length > 0 ? (
        <div className="fcx__bar2">
          <label className="fcx__groupsw">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
            />
            按所属资料分组
          </label>

          {knownTags.length > 0 ? (
            <div className="fcx__tagfilter" role="group" aria-label="按标签筛">
              <button
                type="button"
                className={`fcx__tagchip${!filter.tag ? ' fcx__tagchip--on' : ''}`}
                onClick={() => setFilter((f) => ({ ...f, tag: null }))}
              >
                全部标签
              </button>
              {knownTags.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  className={`fcx__tagchip${filter.tag === t.tag ? ' fcx__tagchip--on' : ''}`}
                  onClick={() =>
                    setFilter((f) => ({ ...f, tag: f.tag === t.tag ? null : t.tag }))
                  }
                  title={`库里 ${t.count} 张卡带这个标签`}
                >
                  {t.tag}
                  <span className="fcx__tagn">{t.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------- 列表 ---------- */}
      {cards.length === 0 ? (
        <p className="fcx__empty">
          还没有闪卡。上面三个按钮都能建：从知识点挑、从错题挑，或者建一张记忆闪卡（自己写或让 AI 组织）。
        </p>
      ) : visible.length === 0 ? (
        <p className="fcx__empty">没有符合条件的卡。</p>
      ) : (
        <ul className="fcx__list">
          {listRows.map((row) => {
            /* ---------- 组头（按资料分组时才有） ---------- */
            if (row.kind === 'head') {
              const key = row.sourceId ?? NO_SOURCE;
              return (
                <li key={row.key} className="fcx__ghead">
                  <button
                    type="button"
                    className="fcx__ghead-btn"
                    onClick={() =>
                      setCollapsedSources((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    aria-expanded={!row.collapsed}
                  >
                    <span className={`fcx__ghead-caret${row.collapsed ? '' : ' fcx__ghead-caret--open'}`} aria-hidden="true">
                      ▸
                    </span>
                    <span className="fcx__ghead-title">{row.title}</span>
                    {/* ⚠️ 这个数 = 这一组显示出来的卡数（来自 visible，见 listRows 注释） */}
                    <span className="fcx__ghead-n">{row.count}</span>
                  </button>
                  <button
                    type="button"
                    className="fcx__ghead-filter"
                    onClick={() => setFilter((f) => ({ ...f, sourceId: f.sourceId === key ? null : key }))}
                    title={filter.sourceId === key ? '取消只看这一份资料' : '只看这一份资料的卡'}
                  >
                    {filter.sourceId === key ? '取消只看这组' : '只看这组'}
                  </button>
                </li>
              );
            }

            const c = row.card;
            const isOpen = opened.has(c.id);
            const isEditing = editing?.id === c.id;

            /*
             * 编辑态仍用原来的表单（textarea 要拿原始文本，
             * callout 是渲染态的版式，两者不冲突）。
             */
            if (isEditing) {
              return (
                <li key={c.key} className="fcx__item fcx__item--editing">
                  <label className="fcx__field">
                    <span className="fcx__field-label">正面</span>
                    <textarea
                      className="fcx__textarea"
                      value={editing.front}
                      onChange={(e) => setEditing({ ...editing, front: e.target.value })}
                      rows={3}
                      aria-label="编辑正面"
                    />
                  </label>
                  <label className="fcx__field">
                    <span className="fcx__field-label">背面</span>
                    <textarea
                      className="fcx__textarea"
                      value={editing.back}
                      onChange={(e) => setEditing({ ...editing, back: e.target.value })}
                      rows={4}
                      aria-label="编辑背面"
                    />
                  </label>

                  {/*
                   * 标记行插入（2026-11-23，规范 A4）。
                   *
                   * 只做"往背面追加一行模板"，**不做校验拦截** ——
                   * card-rich.ts 的原则是解析不了就原样显示，
                   * 卡片文字是用户的学习材料，不能因为格式不合规改不动。
                   * 这排按钮是辅助，不是约束。
                   */}
                  <div className="fcx__marks">
                    {MARK_INSERTS.map((m) => (
                      <button
                        key={m.mark}
                        type="button"
                        className="fcx__markbtn"
                        onClick={() =>
                          setEditing({
                            ...editing,
                            back: (editing.back ? editing.back.replace(/\n$/, '') + '\n' : '') + m.insert,
                          })
                        }
                        disabled={busy}
                        title={m.title}
                      >
                        {m.mark}
                      </button>
                    ))}
                    <span className="fcx__marks-hint">点一下往背面加一行（不强制，随便改）</span>
                  </div>

                  {/*
                   * 标签（2026-11-23，用户要求「通过选择标签决定闪卡存放位置」）。
                   * 编辑入口保留在这里：用户可以自由增删标签。
                   */}
                  <CardTagEditor
                    value={editing.tags}
                    known={knownTags}
                    onChange={(tags) => setEditing({ ...editing, tags })}
                    disabled={busy}
                  />
                  <div className="fcx__item-actions">
                    <button
                      type="button"
                      className="fcx__act fcx__act--go"
                      onClick={() => void saveEdit()}
                      disabled={busy}
                    >
                      保存
                    </button>
                    <button type="button" className="fcx__act" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </li>
              );
            }

            /*
             * 渲染态：Obsidian callout 版式（2026-11-22 用户给了参考图）。
             *
             * ⚠️ 序号用**全库序号**而不是筛选后的 i ——
             * 用户说「闪卡 1｜题1.8…」，那个编号在他心里是这张卡的编号。
             * 筛选后从 1 重新数会让同一张卡在不同筛选下显示不同编号，
             * 反而更乱。所以传 `cardIndexOf(c)`（在全部卡里的位置）。
             */
            return (
              <li key={c.key} className="fcx__item fcx__item--callout">
                <CardCallout
                  card={c}
                  index={cardIndexOf(c)}
                  open={isOpen}
                  busy={busy}
                  {...(pickContext && onPickCard
                    ? {
                        pickSlot: (
                          <PickButton
                            picked={(pickBoundCardIds ?? []).indexOf(c.id) >= 0}
                            busy={busy}
                            onPick={() => onPickCard(c.id)}
                          />
                        ),
                      }
                    : {})}
                  onToggleOpen={() => toggleOpen(c.id)}
                  onEdit={() => {
                    setEditing({ id: c.id, front: c.front, back: c.back ?? '', tags: [...c.tags] });
                    setOpened((prev) => new Set(prev).add(c.id));
                  }}
                  onDelete={() => setPendingDelete(c)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- 删除确认 ---------- */}
      {pendingDelete ? (
        <div className="fcx__confirm" role="dialog" aria-label="确认删除闪卡">
          <p className="fcx__confirm-text">
            删掉这张闪卡？
            <br />
            <span className="fcx__confirm-quote">{pendingDelete.front.slice(0, 60)}</span>
          </p>
          <p className="fcx__confirm-note">
            闪卡是独立的内容，删了**不会**影响它原来的知识点或题目 —— 但这张卡本身也找不回来了。
          </p>
          <div className="fcx__confirm-actions">
            <button type="button" className="fcx__act fcx__act--del" onClick={() => void removeCard(pendingDelete)} disabled={busy}>
              {busy ? '删除中…' : '确认删除'}
            </button>
            <button type="button" className="fcx__act" onClick={() => setPendingDelete(null)} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {onGoReview ? (
        <p className="fcx__foot">
          要真正开始翻卡，去
          <button type="button" className="btn-text" onClick={onGoReview}>
            复习巩固
          </button>
          。
        </p>
      ) : null}
    </div>
  );
}
