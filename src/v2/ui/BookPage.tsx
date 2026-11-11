/**
 * 复习全书：把题库里的题与解析串成一本可读的复习册。
 *
 * ## 和「我的题组」的区别
 *
 * - **我的题组**：管理视角 —— 哪几组题、发没发布、逐题检查。
 * - **复习全书**：阅读视角 —— 把这门课的题按章节/题组串起来读一遍，
 *   不看「题组」这个管理单位，看的是「这门课考什么」。
 *
 * 考前最想要的是后者：一页页翻过去，题干、答案、解析、出处都在，
 * 还能导出成 Markdown 带去打印或别的设备看。
 *
 * ## 数据是纯只读聚合
 *
 * 只读 `decks` / `questions` / `sources`，不写任何东西。
 * 导出走现成的 `DeckService.exportMarkdown()`（按题组），
 * 这里额外提供「整本一起导出」——把多个题组的 Markdown 拼起来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, KnowledgePoint, Question, Source } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { downloadBlob } from '@/pages/slides/download.ts';
import { MathText } from './MathText.tsx';
import { BookSelfTest } from './BookSelfTest.tsx';
import { ReviewToday } from './ReviewToday.tsx';
import { FlashcardsPanel } from './FlashcardsPanel.tsx';
import { OralReviewPanel } from './OralReviewPanel.tsx';
import { OralScopePicker } from './OralScopePicker.tsx';
import type { OralScopeOption } from '@/core/oral-scope-service.ts';
import type { FlashcardView } from '@/core/flashcards.ts';
import type { FlashcardCandidate } from '@/core/ai/pick-flashcards.ts';
import type { OralJudgement, OralMaterial } from '@/core/oral-review.ts';
import {
  startSession,
  type ReviewQueue,
  type ReviewSession,
} from './review-session.ts';
import type { ReviewGrade } from '@/v2/core/srs.ts';

export interface BookPageProps {
  decks: DeckService;
  sourceService: SourceService;
  /** 去阅读器看原文 */
  onOpenSource: (sourceId: string) => void;
  /**
   * 去阅读器并定位到具体页（2026-11-09）。
   *
   * 自测答错后最想做的事是「回去看一眼原文那一段」。
   * 只给 sourceId 会让阅读器打开第一页 —— 那等于没定位。
   */
  onOpenSourceAt?: (sourceId: string, page: number, quote?: string) => void;
  /** 去我的题组 */
  onOpenDecks: () => void;
  /**
   * 从「开始复习」进来时自动进入**今日复习**（2026-11-09 改）。
   *
   * 原来这里进的是「自测」（任意卷、随时翻、不写记录）。用户实测后
   * 明确指出那跟「做题」没区别 —— 所以改成真正的复习会话：
   * 只做今日到期 + 新卡、先回想再看答案、自评四档并**写进间隔**、
   * 做完出今日回顾。
   *
   * 「自测」仍然保留，但改成用户主动点（在卷标题旁），不再由入口触发。
   */
  autoStartReview?: boolean;
  /**
   * 自动复习已消费（2026-11-09）。
   *
   * App 收到后清掉那个标记 —— 否则用户下次从侧栏**正常**进这一页，
   * 也会被直接拽进复习。标记是「这次进来要复习」，不是「永远复习」。
   */
  onAutoStartConsumed?: () => void;
  /** 今日可复习的队列（由 App 用 buildReviewQueue 算好传进来） */
  reviewQueue?: ReviewQueue | null;
  /** 自评一档 → 写复习记录（App 负责落库） */
  onReviewGrade?: (cardId: string, grade: ReviewGrade) => Promise<void> | void;
  /**
   * 记忆闪卡（2026-11-10）。
   *
   * 与「今日复习」不同：翻闪卡**不写复习记录**、不参与排期。
   * 它是用户自己挑出来的重点，随时过一遍。
   */
  flashcards?: readonly FlashcardView[];
  /** 可挑选的全部知识点（闪卡候选） */
  flashcardPoints?: readonly KnowledgePoint[];
  /** 建卡 */
  onAddFlashcards?: (ids: string[]) => Promise<void> | void;
  /** 删卡 */
  onRemoveFlashcard?: (id: string) => Promise<void> | void;
  /** 让 AI 挑一批候选（只返回候选，不建卡） */
  onPickFlashcardsWithAi?: () => Promise<FlashcardCandidate[]>;
  /**
   * 从闪卡「去知识库挑」（2026-11-10）。
   *
   * 用户要求做闪卡时直接跳知识库选 —— 那边有文件分组与类型筛选，
   * 几十条知识点也能收窄。不传则闪卡面板只保留面板内平铺列表。
   */
  onGoPickKnowledge?: () => void;
  /**
   * 从知识库挑完卡回来时自动展开闪卡视图（2026-11-10）。
   *
   * 与 autoStartReview / autoStartOral 同一套「进来就到位」的模式：
   * 用户点的是「加进闪卡」，加完就该看到那些卡。
   * 标记用完即清（由本页回传给宿主清掉）。
   */
  autoShowFlashcards?: boolean;
  /** 消费掉 autoShowFlashcards 标记 */
  onAutoShowFlashcardsConsumed?: () => void;
  /**
   * 提问式复习（2026-11-10）。
   *
   * 与另外两种复习方式的区别：这是**开放回答 + 模型判定**。
   * 今日复习是客观题判分，闪卡是只看不判。
   */
  /** 这一轮从哪来（显示在顶部） */
  oralScopeLabel?: string;
  /** 当前素材；null = 这个范围里没内容 */
  oralMaterial?: OralMaterial | null;
  /** 让 AI 出题 */
  onOralAsk?: (material: OralMaterial) => Promise<string>;
  /** 让 AI 判定 */
  onOralJudge?: (m: OralMaterial, q: string, a: string) => Promise<OralJudgement>;
  /** 保存一条记录 */
  onOralSave?: (input: {
    material: OralMaterial;
    question: string;
    answer: string;
    judgement: OralJudgement;
    savedAs: 'full' | 'brief';
  }) => Promise<void>;
  /** 换一条素材再来一轮 */
  onOralNext?: () => void;
  /**
   * 进来就**直接开始提问**（2026-11-10）。
   *
   * 用户在阅读器里划了一段、点了「用这段提问」，意图已经明确 ——
   * 让他在复习巩固页上再点一次「提问式复习」是多余的一步。
   * 与 autoStartReview 同一套模式：标记用完即清（由宿主回传给清掉）。
   */
  autoStartOral?: boolean;
  /** 消费掉 autoStartOral 标记 */
  onAutoStartOralConsumed?: () => void;
  /**
   * 从资料中提问：可选范围（2026-11-10）。
   *
   * 由 App 读好传下来（读它要过每份资料的段落表，不该由本页重复查）。
   * 与「知识点随机」「划选片段」是并列的三条取素材路径，
   * 面板顶部的下拉就是在这几条范围之间切。
   */
  oralScopes?: readonly OralScopeOption[];
  /** 当前选中的范围 id */
  oralScopeId?: string;
  /** 换范围 */
  onOralScopeChange?: (id: string) => void;
  /** 正在按新范围取素材 */
  oralScopeLoading?: boolean;
  /** 取范围失败的原因 */
  oralScopeError?: string | null;
}

/** 一个题组在书里的样子 */
interface BookDeck {
  deck: Deck;
  questions: Question[];
}

/** 按资料分的一卷 */
interface BookVolume {
  sourceId: string | null;
  title: string;
  decks: BookDeck[];
  total: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; volumes: BookVolume[] };

export function BookPage({
  decks,
  sourceService,
  onOpenSource,
  onOpenSourceAt,
  onOpenDecks,
  autoStartReview = false,
  onAutoStartConsumed,
  reviewQueue,
  onReviewGrade,
  flashcards = [],
  flashcardPoints = [],
  onAddFlashcards,
  onRemoveFlashcard,
  onPickFlashcardsWithAi,
  onGoPickKnowledge,
  autoShowFlashcards = false,
  onAutoShowFlashcardsConsumed,
  oralScopeLabel = '随机提问',
  oralMaterial = null,
  onOralAsk,
  onOralJudge,
  onOralSave,
  onOralNext,
  autoStartOral = false,
  onAutoStartOralConsumed,
  oralScopes = [],
  oralScopeId = 'all',
  onOralScopeChange,
  oralScopeLoading = false,
  oralScopeError = null,
}: BookPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  /** 当前显示的筛选：只看某一份资料 */
  const [volumeFilter, setVolumeFilter] = useState<string>('');
  /** 是否显示答案与解析（默认显示，考前复习要看得见） */
  const [showAnswers, setShowAnswers] = useState(true);
  const [busy, setBusy] = useState(false);

  /**
   * 正在自测的那一卷（2026-11-09）。
   *
   * null = 阅读模式；非 null = 自测这一卷的题。
   * 用「卷」而不是整本书做单位：一次只测一组，测完退出再来下一组。
   *
   * 注意：自测与「今日复习」是**两件不同的事** ——
   * 自测不写复习记录、可自由挑卷；今日复习只做到期、会写间隔。
   */
  const [selfTestVolume, setSelfTestVolume] = useState<BookVolume | null>(null);

  /**
   * 今日复习会话（2026-11-09 加）。
   *
   * null = 不在复习；非 null = 正在这一轮复习里。
   * 会话状态放在这里而不是 ReviewToday 内部：换批、退出后重进
   * 都要能重置，由宿主控制更清楚。
   */
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);

  /**
   * 是否在闪卡面板里（2026-11-10）。
   *
   * 与 reviewSession / selfTestVolume 并列的第三种「全屏子视图」。
   * 三者互斥：进闪卡时另外两个必须是 null，否则界面上会叠两层。
   */
  const [showFlashcards, setShowFlashcards] = useState(false);
  /**
   * 是否在提问式复习里（2026-11-10）。
   *
   * 第四种全屏子视图。用 key 而不是布尔值：换素材（再来一题）时
   * 要**重建组件**，否则面板内部的 phase（judged）会留在原地 ——
   * 用户看到的是上一题的判定结果，而问题已经换了。
   */
  const [oralKey, setOralKey] = useState<number | null>(null);
  const enterOral = useCallback(() => {
    setReviewSession(null);
    setSelfTestVolume(null);
    setShowFlashcards(false);
    setOralKey((k) => (k ?? 0) + 1);
  }, []);
  /* 进任一子视图时把另外两个清掉 —— 互斥的约束集中在一处，不靠调用方记得 */
  const enterFlashcards = useCallback(() => {
    setReviewSession(null);
    setSelfTestVolume(null);
    setOralKey(null);
    setShowFlashcards(true);
  }, []);

  /**
   * 从「开始复习」进来时自动开始今日复习。
   *
   * 为什么用 effect 等标记而不是直接在渲染里判断：
   * 标记是「这次进来要复习」，消费掉就该清空，
   * 否则用户下次从侧栏正常进这一页也会被拽进复习。
   */
  const autostartedRef = useRef(false);
  useEffect(() => {
    if (!autoStartReview || autostartedRef.current) return;
    if (!reviewQueue) return;
    autostartedRef.current = true;
    setReviewSession(startSession(reviewQueue));
    /* 让 App 清掉标记：下次正常进这一页不该又被拽进复习 */
    onAutoStartConsumed?.();
  }, [autoStartReview, reviewQueue, onAutoStartConsumed]);

  /**
   * 从阅读器「用这段提问」进来时直接开始提问（2026-11-10）。
   *
   * ## 为什么要等 oralMaterial
   *
   * 不做这个判断就会进到提问面板却**没有素材** —— 面板会显示
   * 「这一轮没问题可问」那种空白态。用户刚划了一段字，
   * 看到空白会以为划选没生效。
   *
   * ## 为什么复用 oralKey 而不是另开一个状态
   *
   * oralKey 的语义本来就是「进提问面板 + 换一轮」。这里要的正是它，
   * 而且它已经有「换素材必须重建组件」的保证（否则 phase 会停在
   * 上一题的判定结果上）。
   *
   * ## 为什么单独一个 ref
   *
   * 与 autostartedRef 分开：两个标记可能同时到达（从首页点复习、
   * 又从阅读器提问），共用一个 ref 会让后来的那个永远进不去。
   */
  const oralAutostartedRef = useRef(false);
  useEffect(() => {
    if (!autoStartOral || oralAutostartedRef.current) return;
    if (!onOralAsk || !onOralJudge) return;
    /* 素材还没就位就先等着 —— 下面的依赖会在它到位后重跑 */
    if (!oralMaterial) return;
    oralAutostartedRef.current = true;
    enterOral();
    onAutoStartOralConsumed?.();
  }, [autoStartOral, oralMaterial, onOralAsk, onOralJudge, enterOral, onAutoStartOralConsumed]);

  /**
   * 从知识库挑完卡回来时自动展开闪卡（2026-11-10）。
   *
   * 用 effect + ref 而不是直接在渲染里判断：标记是「这次进来要展开」，
   * 消费掉就该清空，否则用户下次从侧栏进这一页也会被拽进闪卡。
   * ref 与 autostartedRef 分开 —— 两个标记可能在不同时机到达。
   */
  const flashAutoshownRef = useRef(false);
  useEffect(() => {
    if (!autoShowFlashcards || flashAutoshownRef.current) return;
    flashAutoshownRef.current = true;
    enterFlashcards();
    onAutoShowFlashcardsConsumed?.();
  }, [autoShowFlashcards, enterFlashcards, onAutoShowFlashcardsConsumed]);

  const load = useCallback(async () => {
    try {
      const [deckList, srcs] = await Promise.all([decks.list(), sourceService.list()]);
      const published = deckList.filter((d) => d.status === 'published');

      const withQuestions = await Promise.all(
        published.map(async (d) => ({ deck: d, questions: await decks.getQuestions(d.id) })),
      );

      /*
       * 按资料分卷。
       *
       * 为什么不按题组平铺：一份资料常常出了好几组题（不同批次、不同题型），
       * 平铺会让人看不出「这些题其实来自同一章」。
       * 按资料聚起来才像「一本书的章」。
       */
      const srcTitle = new Map<string, string>(srcs.map((s: Source) => [s.id, s.title]));
      const bySource = new Map<string | null, BookDeck[]>();
      for (const item of withQuestions) {
        if (item.questions.length === 0) continue;
        const key = item.deck.sourceId;
        const arr = bySource.get(key) ?? [];
        arr.push(item);
        bySource.set(key, arr);
      }

      const volumes: BookVolume[] = [];
      for (const [sourceId, list] of bySource) {
        /* 题组按创建时间排，早出的在前 —— 与学习顺序一致 */
        list.sort((a, b) => (a.deck.createdAt < b.deck.createdAt ? -1 : 1));
        volumes.push({
          sourceId,
          title: sourceId ? (srcTitle.get(sourceId) ?? '（资料已删除）') : '未关联资料的题',
          decks: list,
          total: list.reduce((n, d) => n + d.questions.length, 0),
        });
      }
      /* 题多的卷排前面 */
      volumes.sort((a, b) => b.total - a.total);

      setState({ kind: 'ready', volumes });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出题库',
      });
    }
  }, [decks, sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  const volumes = state.kind === 'ready' ? state.volumes : [];

  const visible = useMemo(
    () =>
      volumeFilter === ''
        ? volumes
        : volumes.filter((v) => (v.sourceId ?? '') === volumeFilter),
    [volumes, volumeFilter],
  );

  const grandTotal = visible.reduce((n, v) => n + v.total, 0);

  /** 整本导出：把所有可见题组的 Markdown 拼成一份 */
  async function exportAll() {
    setBusy(true);
    try {
      const parts: string[] = [];
      for (const vol of visible) {
        parts.push(`\n\n# ${vol.title}\n`);
        for (const bd of vol.decks) {
          /*
           * 用 ExportOptions 的真实字段 includeAnswers，
           * 不是自定义的 withAnswer —— 之前写成 as never 强转，
           * 那会让「关掉答案」这个选项静默失效（字段名不对，
           * 导出函数仍按默认值走 includeAnswers: true）。
           */
          const { content } = await decks.exportMarkdown(bd.deck.id, {
            includeAnswers: showAnswers,
            includeAnchors: true,
          });
          /*
           * 题组导出自带一级标题（# 题组名），这里降一级接在「卷」下面，
           * 否则整本导出会出现一堆同级标题、结构散掉。
           */
          parts.push(content.replace(/^# /gm, '## '));
        }
      }
      /*
       * 导出标题沿用「复习全书」这个说法（2026-11-09 改名后保留）。
       *
       * 界面上的导航叫「复习巩固」，但导出的是**一份可打印的复习册**，
       * 「全书」更准确地描述那份文件是什么。改文件里的标题会让
       * 已经导出过的用户对不上号，而导出的内容本身没变。
       */
      const text = `# 复习全书\n\n共 ${grandTotal} 道题。\n${parts.join('\n')}`;
      downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), '复习全书.md');
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '导出失败',
      });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="book-page">
        <p className="bk-hint">正在把题组装订成书…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="book-page">
        <p className="bk-error">{state.message}</p>
      </div>
    );
  }

  /*
   * 今日复习（2026-11-09 加，方案二 + 方案三）。
   *
   * 与下面「自测」是两件不同的事：
   *  - 今日复习：只做到期 + 新卡、**先回想再看答案**、自评四档写进间隔、
   *    做完出今日回顾。这是「复习」。
   *  - 自测：自由挑一卷、随时翻、不写记录。这是「检验」。
   */
  if (reviewSession && reviewQueue) {
    return (
      <div className="book-page">
        <ReviewToday
          session={reviewSession}
          available={reviewQueue.availableBeforeLimit}
          onGrade={async (cardId, g) => {
            await onReviewGrade?.(cardId, g);
          }}
          onExit={() => setReviewSession(null)}
          /*
           * 再来一批。用同一个队列重新开始不合适（刚评过的卡已经
           * 不在「今天到期」里了）—— 交给 App 重新算，这里只清空
           * 会话，让宿主下次进来时带新队列。
           */
          onNextBatch={undefined}
        />
      </div>
    );
  }

  /*
   * 提问式复习（2026-11-10）。
   *
   * 第四种子视图。key 每次进入都变 —— 见 oralKey 的注释：
   * 换素材必须重建组件，否则 phase 停在上一题的判定结果上。
   */
  if (oralKey !== null) {
    return (
      <div className="book-page">
        <OralReviewPanel
          /*
           * key 里带上素材 id（2026-11-10 修）。
           *
           * 原来只用 oralKey，它只在「换一题」时自增。加了范围下拉之后
           * 出现一个真 bug：换了范围、素材也换了，但 oralKey 没变，
           * 组件不重建 → phase 停在上一个范围的那道题上。
           * 截图实测：范围已经写着「导读：这一节要解决什么问题」，
           * 底下问题还是「确定性信号与随机信号…」。
           *
           * 把 material.id 拼进 key，任何素材变化都会重建。
           * 这比「在换范围的回调里手动 +oralKey」可靠 ——
           * 那条路要求每个改素材的地方都记得自增，漏一处就复发。
           */
          key={`${oralKey}:${oralMaterial?.id ?? 'none'}`}
          scopeLabel={oralScopeLabel}
          material={oralMaterial}
          onAsk={async (m) => (onOralAsk ? onOralAsk(m) : Promise.reject(new Error('未接入出题')))}
          onJudge={async (m, q, a) =>
            onOralJudge ? onOralJudge(m, q, a) : Promise.reject(new Error('未接入判定'))
          }
          onSave={async (input) => {
            await onOralSave?.(input);
          }}
          onNext={() => {
            /* 换一题 = 换素材 + 重建面板 */
            onOralNext?.();
            setOralKey((k) => (k ?? 0) + 1);
          }}
          onExit={() => setOralKey(null)}
          /*
           * 范围选择器（2026-11-10）。
           *
           * 只有「从资料中提问」这条路给下拉：划选提问已经明确了
           * 「就这段」，再给一个下拉会让用户以为划选没生效。
           * 判断依据是 onOralScopeChange 有没有传 ——
           * 宿主不传就是不支持按资料换范围。
           */
          scopePicker={
            onOralScopeChange ? (
              <OralScopePicker
                options={oralScopes}
                value={oralScopeId}
                onChange={onOralScopeChange}
                loading={oralScopeLoading}
                error={oralScopeError}
              />
            ) : null
          }
          onOpenAnchor={
            onOpenSourceAt
              ? (sourceId, page, quote) => onOpenSourceAt(sourceId, page ?? 1, quote ?? undefined)
              : undefined
          }
        />
      </div>
    );
  }

  /*
   * 记忆闪卡（2026-11-10）。
   *
   * 与「今日复习」「自测」并列的第三种全屏子视图，三者互斥。
   * 闪卡不参与间隔排期 —— 见 core/flashcards.ts 头部注释。
   */
  if (showFlashcards) {
    return (
      <div className="book-page">
        <FlashcardsPanel
          cards={flashcards}
          points={flashcardPoints}
          onAdd={async (ids) => {
            await onAddFlashcards?.(ids);
          }}
          onRemove={async (id) => {
            await onRemoveFlashcard?.(id);
          }}
          onOpenAnchor={
            onOpenSourceAt
              ? (sourceId, page, quote) => onOpenSourceAt(sourceId, page ?? 1, quote)
              : undefined
          }
          onPickWithAi={onPickFlashcardsWithAi}
          onGoKnowledge={onGoPickKnowledge}
          onExit={() => setShowFlashcards(false)}
        />
      </div>
    );
  }

  /*
   * 自测模式（2026-11-09）。
   *
   * 在「卷」这一层切换：进自测就整页变成一次小测，退出回到阅读。
   * 不并排显示 —— 一边看着答案一边作答，自测就没意义了。
   */
  if (selfTestVolume) {
    const qs = selfTestVolume.decks.flatMap((d) => d.questions);
    return (
      <div className="book-page">
        <BookSelfTest
          title={selfTestVolume.title}
          questions={qs}
          onExit={() => setSelfTestVolume(null)}
          onOpenAnchor={
            onOpenSourceAt && selfTestVolume.sourceId
              ? (page, quote) => onOpenSourceAt(selfTestVolume.sourceId!, page, quote)
              : undefined
          }
        />
      </div>
    );
  }

  if (volumes.length === 0) {
    return (
      <div className="book-page">
        <header className="bk-head">
          <h1 className="bk-title">复习巩固</h1>
        </header>
        <div className="bk-empty">
          <p>还没有可读的内容 —— 复习巩固只收「已发布」题组里的题。</p>
          <p className="bk-hint">
            草稿里的题是给你自己检查用的，不放进复习册。
          </p>
          <button type="button" className="btn-ghost" onClick={onOpenDecks}>
            去我的题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="book-page">
      <header className="bk-head">
        <h1 className="bk-title">复习巩固</h1>
        <p className="bk-lead">
          把已发布题组里的题按资料聚成一册：题干、答案、解析、出处都在。
          想检验自己就点「自测这一卷」—— 遮住答案逐题作答，当场判对错、看解析。
          也可以导出成 Markdown 带走。
        </p>
      </header>

      {/* ---- 工具条 ---- */}
      <div className="bk-toolbar">
        <span className="bk-count">{grandTotal} 道题</span>

        {/*
          今日复习入口（2026-11-09）。
          只在真有可复习内容时显示 —— 队列空时按钮点了只会看到空页面，
          那属于「假开关」。数量写在按钮上，让人知道点进去要花多久。
        */}
        {reviewQueue && reviewQueue.total > 0 ? (
          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => setReviewSession(startSession(reviewQueue))}
            title="只做今天到期的和新卡；先自己回想，再看答案，然后自评"
          >
            开始今日复习（{reviewQueue.total} 张）
          </button>
        ) : null}

        {/*
          记忆闪卡入口（2026-11-10）。
          只要有知识点就能挑卡，所以不依赖 reviewQueue。
          已有卡时显示张数，让用户知道点进去会看到什么。
        */}
        {flashcardPoints.length > 0 || flashcards.length > 0 ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={enterFlashcards}
            title="一次一张、先自己想再翻面；不参与复习排期"
          >
            记忆闪卡{flashcards.length > 0 ? `（${flashcards.length} 张）` : ''}
          </button>
        ) : null}

        {/*
          提问式复习入口（2026-11-10）。
          只要接了 AI 就能用 —— 它不依赖闪卡或队列。
          门放在「有没有可提问的素材」上：没素材点进去只会看到空页面。

          ⚠️ 判定条件放宽（2026-11-10 加范围选择器时改的）：
          原来写 `oralMaterial ?`，要求「已经有一条素材」才显示入口。
          加了范围下拉之后，素材可能因为「刚切换范围、还没取完」而暂时为空，
          入口就会消失 —— 用户选完范围发现按钮没了，等于把功能关掉。
          改成看「可选的提问范围」有没有：有范围就说明这个库能提问，
          素材由面板自己按范围去取。
        */}
        {onOralAsk && onOralJudge && (oralMaterial || oralScopes.length > 0) ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={enterOral}
            title="就一段材料向你提问，你回答后由模型判断是记错还是理解偏了"
          >
            提问式复习
          </button>
        ) : null}

        <label className="bk-field">
          <span className="bk-field__label">范围</span>
          <select
            className="bk-select"
            value={volumeFilter}
            onChange={(e) => setVolumeFilter(e.target.value)}
          >
            <option value="">全部（{volumes.reduce((n, v) => n + v.total, 0)} 道）</option>
            {volumes.map((v) => (
              <option key={v.sourceId ?? '__none__'} value={v.sourceId ?? ''}>
                {v.title}（{v.total} 道）
              </option>
            ))}
          </select>
        </label>

        <label className="bk-check">
          <input
            type="checkbox"
            checked={showAnswers}
            onChange={(e) => setShowAnswers(e.target.checked)}
          />
          <span>显示答案与解析</span>
        </label>

        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => void exportAll()}
          disabled={busy}
        >
          {busy ? '导出中…' : '整本导出 Markdown'}
        </button>
      </div>

      {/* ---- 正文 ---- */}
      {visible.map((vol) => (
        <section key={vol.sourceId ?? '__none__'} className="bk-volume">
          <div className="bk-volume__head">
            <h2 className="bk-volume__title">{vol.title}</h2>
            <span className="bk-volume__meta">{vol.total} 道</span>
            {/*
              自测这一卷（2026-11-09）。
              放在卷标题旁而不是页顶：自测的单位是「一组题」，
              用户在这一卷上点，明确知道要测的是哪些题。
            */}
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => {
                setSelfTestVolume(vol);
                setShowAnswers(false);
              }}
            >
              自测这一卷（{vol.total} 道）
            </button>
            {vol.sourceId ? (
              <button type="button" className="btn-text" onClick={() => onOpenSource(vol.sourceId!)}>
                看原文
              </button>
            ) : null}
          </div>

          {vol.decks.map((bd) => (
            <div key={bd.deck.id} className="bk-deck">
              <h3 className="bk-deck__title">
                {bd.deck.title}
                <span className="bk-deck__meta">{bd.questions.length} 道</span>
                {bd.deck.kinds && bd.deck.kinds.length > 0 ? (
                  <span className="bk-deck__kind">{bd.deck.kinds.map(kindLabel).join(' / ')}</span>
                ) : null}
              </h3>

              <ol className="bk-questions">
                {bd.questions.map((q, i) => (
                  <li key={q.id} className="bk-q">
                    <div className="bk-q__head">
                      <span className="bk-q__no">{i + 1}</span>
                      <span className="bk-q__kind">{kindLabel(q.kind)}</span>
                    </div>
                    <p className="bk-q__prompt"><MathText text={q.prompt} /></p>

                    {q.options.length > 0 ? (
                      <ul className="bk-q__options">
                        {q.options.map((o) => (
                          <li
                            key={o.key}
                            className={`bk-q__option${
                              showAnswers && isAnswerKey(q, o.key) ? ' bk-q__option--right' : ''
                            }`}
                          >
                            <span className="bk-q__key">{o.key}</span>
                            <span><MathText text={o.text} /></span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {showAnswers ? (
                      <>
                        {q.options.length === 0 ? (
                          <p className="bk-q__answer">参考答案：<MathText text={q.answer} /></p>
                        ) : (
                          <p className="bk-q__answer">正确答案：<MathText text={q.answer} /></p>
                        )}
                        {q.explanation ? (
                          <p className="bk-q__explain"><MathText text={q.explanation} /></p>
                        ) : null}
                      </>
                    ) : null}

                    {q.anchors.length > 0 && q.anchors[0] ? (
                      <p className="bk-q__from">
                        出处：第 {q.anchors[0].page} 页
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 题型中文名 */
function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'blank':
      return '填空';
    case 'essay':
    case 'short':
      return '问答';
    default:
      return k;
  }
}

/** 某个选项是不是正确答案 */
function isAnswerKey(q: Question, key: string): boolean {
  const a = q.answer.trim().toUpperCase();
  if (q.kind === 'multiple') {
    return a
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .includes(key.toUpperCase());
  }
  return a === key.toUpperCase();
}
