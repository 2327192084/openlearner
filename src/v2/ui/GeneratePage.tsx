import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Source,
  KnowledgePoint,
  Question,
  QuestionKind,
  SourceSegment,
} from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import {
  pickRandom,
  pointsToMaterials,
  segmentsToMaterials,
  type QuestionMaterial,
} from '@/core/questions/materials.ts';
import { OriginPicker, type MaterialOrigin } from './OriginPicker.tsx';
import { KindPicker } from './KindPicker.tsx';
import { QuotaPicker, totalOfCounts, type CognitiveLevel } from './QuotaPicker.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { VariantPanel, type VariantSelection } from './VariantPanel.tsx';
import { GenFeedback, type GenDone, type GenProgress } from './GenFeedback.tsx';
import type { ReviewService } from '@/v2/core/review-service.ts';
import {
  knowledgePointsToVariantMaterials,
  wrongQuestionsToVariantMaterials,
} from '@/core/questions/variants.ts';
import './import-panel.css';
import './kind-picker.css';
import type { DeckService } from '@/core/questions/service.ts';
import type { BackendService } from '@/core/backends.ts';
import { IconDoc, IconGenerate, IconUpload } from './icons.tsx';

/**
 * 出题页。
 *
 * ## 按截图还原四种方式
 *
 * 用资料出题 / 导入 JSON 题组 / 案例分析题 / 主会话里录题
 *
 * 只有第一种会真的工作（其余三种 v1 没有对应能力）。
 * 未实现的卡片**显示为禁用并说明原因**，不做成「点了没反应的按钮」。
 *
 * ## 流程
 *
 * 选资料 → 选题型/数量 → 生成前显示预估 token → 生成 → 进待审核
 *
 * 预估 token 是 StudyHub 明确做了的事（「出之前可以看到大概要花多少」），
 * 用户在点下去之前应该知道会花多少钱。
 */

export interface GeneratePageProps {
  sourceService: SourceService;
  knowledge: KnowledgeService;
  decks: DeckService;
  backends: BackendService;
  onGenerated: () => void;
  onOpenSources: () => void;
  /** 知识点不够时跳去整理页，带上当前选中的资料 */
  onOpenOrganize: (sourceId: string | null) => void;
  /** 出完题跳到「我的题组」并展开这一组 —— 否则用户找不到刚生成的题 */
  onOpenDecks: (deckId?: string | null) => void;
  /**
   * 复习服务（2026-11-12）。变式出题要用它取真实做错过的题。
   * 可选：不传时「从错题变式」显示引导语。
   */
  reviewService?: ReviewService;
  /**
   * 从错题页跳来时的预选目标（2026-11-12）。
   *
   * 有值时直接进「变式出题」模式，并把这几道题勾上 ——
   * 用户点了某道错题的「出变式题」，不该再要他翻列表找一遍。
   */
  initialVariant?: { questionIds: string[] } | null;
  /**
   * 返回题组列表。
   *
   * 这个组件现在**嵌在「我的题组」页里**（用户要求把「创建题组」
   * 和「我的题组」整合成一页），所以需要一条回去的路。
   */
  onBack?: () => void;
}

type Mode = 'from-source' | 'variant' | 'import-json' | 'case' | 'capture';

/**
 * 四个出题入口。
 *
 * ## 关于第 4 个入口的改动（2026-11-07 用户指出）
 *
 * 原来它叫「在主会话里录题」，描述是「题册、刷题软件、错题或截图」。
 * 那是**照搬 StudyHub** 的说法 —— StudyHub 是 DSH 的插件，
 * 用户有一个 AI 主会话，所以「在主会话里录题」指的是在对话里贴截图让 AI 转成题。
 *
 * OpenLeaner 是**独立桌面软件**，没有「主会话」这个东西。
 * 留着那个名字等于挂一个用户永远无法理解的入口。
 *
 * 改成「从截图或题册导入」：说的是**同一件事**（把手头已有的题弄进来），
 * 但用的是我们这个软件里真实存在的东西 —— 文件。
 * 实现上它也需要 OCR/视觉模型，所以现在标「还没做」并写明依赖。
 */
const MODES: { id: Mode; title: string; desc: string; ready: boolean }[] = [
  {
    id: 'from-source',
    title: '用资料出题',
    desc: 'AI 按你的资料出题，并逐题检查',
    ready: true,
  },
  {
    /*
     * 变式出题（2026-11-12）。
     *
     * 用户要求：「出题方式太单一了……让 AI 对特定的知识点，
     * 或是错题进行变式。」
     *
     * 放在第二位而不是最后：它和「用资料出题」是并列的两种主要出题方式，
     * 不是从导入类功能里延伸出来的补充。
     */
    id: 'variant',
    title: '变式出题',
    desc: '拿做错的题或某个知识点，出同类但不同的新题',
    ready: true,
  },
  {
    id: 'import-json',
    title: '导入 JSON 题组',
    desc: '已有题目，或外部 AI 生成的题',
    ready: true,
  },
  {
    id: 'case',
    title: '案例分析题',
    desc: '长案例 + 开放题，按评分标准逐项批改',
    ready: false,
  },
  {
    id: 'capture',
    title: '从截图或题册导入',
    desc: '拍下来的题、刷题软件截图（需要看图模型，还没做）',
    ready: false,
  },
];

export function GeneratePage({
  sourceService,
  knowledge,
  decks,
  backends,
  onGenerated,
  onOpenSources,
  onOpenOrganize,
  onOpenDecks,
  reviewService,
  initialVariant,
  onBack,
}: GeneratePageProps) {
  const [mode, setMode] = useState<Mode>('from-source');

  /*
   * 从错题页带着预选目标进来时，直接切到变式模式（2026-11-12）。
   *
   * 只在挂载时判一次：用户在页面里自己切模式后不该被强行拉回来。
   *
   * 判据是「有没有 initialVariant」，**不要求 questionIds 非空**（2026-11-13 修）：
   * 错题页的批量入口「错题变式」进来时是空数组（让用户自己挑），
   * 原先写 `questionIds.length > 0` 会让那个入口跳到「用资料出题」——
   * 用户的原话是「错题变式的出题功能是假按钮，点击之后没有反馈」。
   */
  useEffect(() => {
    if (initialVariant) {
      setMode('variant');
    }
  }, [initialVariant]);

  /**
   * 出题素材来源（2026-11-07 用户要求）。
   *  - source-text：资料原文段落（原「从资料出题」改成读原文）
   *  - knowledge：知识库知识点（可整库随机 / 指定一份）
   */
  const [origin, setOrigin] = useState<MaterialOrigin>('source-text');
  const [segments, setSegments] = useState<SourceSegment[] | null>(null);
  const [acrossAll, setAcrossAll] = useState(true);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  /*
   * 题型从「单选一种」改成「可勾选多种」。
   *
   * 界面部分抽成了 <KindPicker>（独立文件），这里只存状态。
   * 用数组而不是单个值：勾几种就出几种，按题型轮流分配数量。
   */
  const [kinds, setKinds] = useState<QuestionKind[]>(['single']);
  /**
   * 每种题型各出几道（2026-11-08 改）。
   *
   * 原来是单个 `count`（总数），由模型自己分给各题型 ——
   * 实测真实模型常常全给单选，用户勾的判断题/问答题拿不到。
   * 现在逐种填数字，总数由它求和得出，不再有一个会与它打架的独立总数框。
   */
  const [kindCounts, setKindCounts] = useState<Partial<Record<QuestionKind, number>>>({ single: 8 });
  /** 限定的认知层级；空数组 = 不限（按知识点自身层级出） */
  const [levels, setLevels] = useState<CognitiveLevel[]>([]);

  /*
   * 总题数 = 各题型配额之和。
   *
   * 为什么派生而不是单独存一个 state：两个数字必然会被改到一个不一致的状态，
   * 那时界面上「合计 12 道」和「数量 10」会同时出现，用户不知道该信哪个。
   */
  const count = totalOfCounts(kindCounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 错误附带的下一步建议。
   *
   * ApiError 的构造函数注释写着「不允许只显示 message」，因为
   * 「账号余额不足」只告诉用户发生了什么，没告诉他该做什么。
   * 这些建议在 chat-client 里已经按错误码写好了，不能在这一层丢掉。
   */
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [done, setDone] = useState<GenDone | null>(null);
  /**
   * 进行中的进度（2026-11-13 加）。
   *
   * 一次出题要十几秒到一分钟，原来只有一个「正在生成…」的按钮文字，
   * 用户看不出是还在跑还是卡死了 —— 这是「点了没反馈」的一半原因。
   * 另一半是 error/done 当时只挂在「用资料出题」那块表单里，变式模式下不渲染
   * （见 GenFeedback.tsx 的说明）。
   */
  const [progress, setProgress] = useState<GenProgress | null>(null);

  /** 统一的报错入口：带上 hint 就一起显示，没带就清掉上一条的 */
  const reportError = useCallback((err: unknown, fallback: string) => {
    const e = err as {
      message?: string;
      hint?: string;
      /** 出题中途失败时，DeckService 会把已产出的题挂在草稿题组上带出来 */
      partialDeck?: { id: string; title: string };
      producedCount?: number;
    } | null;
    let msg = e?.message ?? fallback;
    /*
     * 出题中途失败时草稿是保留的（DeckService 有意不丢用户的成果）。
     * 不把这句话说出来，用户会以为白跑了 —— 他其实可以进去接着看。
     */
    if (e?.partialDeck && (e.producedCount ?? 0) > 0) {
      msg += `（已经出的 ${e.producedCount} 道留在《${e.partialDeck.title}》里，可以先去看）`;
    }
    setError(msg);
    setErrorHint(typeof e?.hint === 'string' ? e.hint : null);
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const all = await sourceService.list();
      setSources(all);
      if (all.length === 0 || selected) return;

      /**
       * 默认选中**第一份真的有知识点的资料**，不是列表第一份。
       *
       * ⚠️ 这里踩过坑：原先直接选 all[0]，而用户库里第一份是
       * 没整理过知识点的 PDF —— 打开出题页就看到「暂时无法从这里出题」，
       * 会以为整个功能坏了，其实切一下就正常。
       *
       * 优先选有知识点的，都选不到才退回第一份（并给明确提示）。
       */
      let best: string | null = null;
      for (const s of all) {
        const pts = await knowledge.listBySource(s.id);
        if (pts.some((p) => p.anchors.length > 0)) {
          best = s.id;
          break;
        }
      }
      setSelected(best ?? all[0]!.id);
    } catch (err) {
      reportError(err, '读不出资料');
    }
  }, [sourceService, knowledge, selected]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // 选资料后读它的知识点
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setPoints(null);
      return;
    }
    void (async () => {
      try {
        const all = await knowledge.listBySource(selected);
        if (cancelled) return;
        setPoints(all);
        if (origin === 'source-text') {
          const segs = await sourceService.getSegments(selected);
          if (!cancelled) setSegments(segs);
        }
      } catch {
        if (!cancelled) setPoints(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [knowledge, selected, origin]);

  /**
   * 已定位的知识点才能出题（未定位的没有出处，题目也就点不回原文）
   *
   * 再按选中的章节过滤（2026-11-08，用户要求「按章节限范围出题」）。
   * 为什么先按 anchors 过滤再按章节：两者是独立条件，
   * 但「没定位的不能出题」是硬规则，先执行它能让章节统计更诚实
   * （否则章节下拉里会数进那些根本出不了题的点）。
   */
  const locatablePoints = (points ?? []).filter((p) => p.anchors.length > 0);

  /** 这份资料里有哪些章（按首次出现顺序，保持阅读顺序） */
  const chapters = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of locatablePoints) {
      const name = (p.chapter ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }, [locatablePoints]);

  /**
   * 选中的章节集合。空集 = 不限（全部）。
   *
   * 用「空集表示全部」而不是默认全选：资料有 20 章时全选会让
   * 下拉框一进去就是 20 个勾，用户还得先取消。默认不限制更省事，
   * 而且与「不选就是全要」的直觉一致。
   */
  const [pickedChapters, setPickedChapters] = useState<Set<string>>(new Set());

  /* 换资料时清空章节选择 —— 否则会带着上一份资料的章名去过滤新资料 */
  useEffect(() => {
    setPickedChapters(new Set());
  }, [selected]);

  const usablePoints = useMemo(() => {
    if (pickedChapters.size === 0) return locatablePoints;
    return locatablePoints.filter((p) => pickedChapters.has((p.chapter ?? '').trim()));
  }, [locatablePoints, pickedChapters]);

  /**
   * 资料原文出题（origin === 'source-text'）这条路径不依赖知识点，
   * 它直接读 selected 资料的段落（sourceSegments）。所以「有没有段落」
   * 才是这道按钮该有的前置条件，而不是「有没有知识点」。
   *
   * 2026-11-12 修：原先守卫与 estimatedTokens 都用 usablePoints（知识点），
   * 导致「从资料出题」在没有知识点的资料上一律禁用 —— 这是假按钮的根因。
   * 这里只统计「能出题意的段落」（>=30 字，与 segmentsToMaterials 口径一致），
   * 所以预估 token 和按钮可用性都跟着「段落」走，而不是「知识点」。
   */
  const usableSegments = useMemo(() => {
    if (origin !== 'source-text') return [];
    return (segments ?? []).filter((s) => s.text.trim().length >= 30);
  }, [origin, segments]);

  /** 粗略的 token 预估：按素材字数 × 出题倍率 */
  const estimatedTokens = (() => {
    const srcChars = (() => {
      if (origin === 'source-text') {
        return usableSegments.reduce((n, s) => n + s.text.length, 0);
      }
      return usablePoints.reduce((n, p) => n + p.statement.length, 0);
    })();
    if (srcChars === 0) return 0;
    // 输入约 srcChars 字，输出约每题 150 token；按项目里实测的经验倍率估
    return Math.round(srcChars * 0.6 + count * 150);
  })();

  const generate = useCallback(async () => {
    const hasInput =
      origin === 'source-text' ? usableSegments.length > 0 : usablePoints.length > 0;
    if (busy || !hasInput) return;
    setBusy(true);
    setError(null);
    setErrorHint(null);
    setDone(null);
    setProgress(null);
    try {
      const list = await backends.list();
      const ready = list.filter((b) => b.status === 'ready');
      if (ready.length === 0) {
        setError('还没有可用的模型。先到「设置」里添加一个后端。');
        return;
      }
      const backendId = ready[0]!.id;
      const apiKey = await backends.readCredential(backendId);
      if (!apiKey) {
        setError('读不到这个后端的 API Key，请到设置页重新填一次。');
        return;
      }

      // 动态引入，避免首屏加载出题器
      const { DeepSeekQuestionBackend } = await import('@/core/questions/deepseek-backend.ts');
      const backend = new DeepSeekQuestionBackend({
        apiKey,
        provider: ready[0]!.provider,
        model: ready[0]!.model,
        ...(ready[0]!.baseUrl ? { baseUrl: ready[0]!.baseUrl } : {}),
      });

      /*
       * 按来源取素材（2026-11-07）。
       *
       * 原文出题 → segmentsToMaterials：段落自带页码，锚点天然准确；
       * 知识库出题 → pointsToMaterials：用整理时实测出的 anchors。
       */
      let materials: QuestionMaterial[] = [];
      let titleBase = '';

      if (origin === 'source-text') {
        const segs = await sourceService.getSegments(selected);
        materials = segmentsToMaterials(segs);
        titleBase = sources?.find((s) => s.id === selected)?.title ?? '资料';
      } else if (acrossAll) {
        const allPoints = [];
        for (const src of sources ?? []) {
          allPoints.push(...(await knowledge.listBySource(src.id)));
        }
        /*
         * 抽多少条：出题数 × 3，至少 12。
         * 整库可能有几百条，全塞进去会超上下文，而且大部分用不到。
         */
        materials = pickRandom(pointsToMaterials(allPoints), Math.max(count * 3, 12));
        titleBase = '知识库';
      } else {
        materials = pointsToMaterials(await knowledge.listBySource(selected));
        titleBase = sources?.find((s) => s.id === selected)?.title ?? '资料';
      }

      if (materials.length === 0) {
        setError(
          origin === 'source-text'
            ? '这份资料没有可用来出题的正文。到「资料」页看它是不是扫描件（扫描件要先转成正文）。'
            : '这个范围里没有已定位的知识点。到「整理知识点」把资料过一遍再来。',
        );
        return;
      }
      const controller = new AbortController();
      const out = await decks.generate({
        // 素材优先；points 留空 —— generate 会用 materials
        points: [],
        materials,
        title: `${titleBase} · 题组`,
        /*
         * 是不是随机题组：整库随机抽素材时标记「随机题组」，
         * 这样列表里一眼能看出来，而不是事后想不起这批题从哪来的。
         */
        randomSource: origin === 'knowledge' && acrossAll,
        sourceId: origin === 'source-text' || !acrossAll ? selected : null,
        backend,
        options: {
          kinds,
          count,
          /* 逐种数量：后端据此出题（不再靠「尽量平均」的提示词碰运气） */
          kindCounts,
          levels: levels.length > 0 ? levels : null,
          language: 'zh',
        },
        signal: controller.signal,
        onProgress: (p) => {
          setProgress({ produced: p.produced, total: p.estimatedTotal });
        },
      });

      /* 统计实际出成的题型分布 —— 用户勾了 N 种，模型可能只给了一两种 */
      const kindCount: Record<string, number> = {};
      for (const q of out.questions) kindCount[q.kind] = (kindCount[q.kind] ?? 0) + 1;
      setDone({
        deck: out.deck.title,
        deckId: out.deck.id,
        questions: out.questions.length,
        kinds: kindCount,
      });
      onGenerated();
    } catch (err) {
      reportError(err, '出题失败');
    } finally {
      /* 结束（成功或失败）就不再显示「已经出来 N 道」——结果由下面的 done/error 说 */
      setBusy(false);
      setProgress(null);
    }
  }, [
    busy,
    usableSegments,
    origin,
    usablePoints,
    backends,
    decks,
    sources,
    selected,
    kinds,
    count,
    kindCounts,
    levels,
    onGenerated,
    origin,
    acrossAll,
    knowledge,
    sourceService,
  ]);

  /**
   * 变式出题（2026-11-12）。
   *
   * ## 为什么单独一个函数而不是改 generate
   *
   * `generate` 的素材来自「资料原文 / 知识点库」，且读法是基于
   * `origin` + `selected` 的固定组合。变式的素材来自**另一处**
   * （用户勾选的错题或知识点），形状不同。
   *
   * 硬塞进 generate 会让那个函数多出三四个条件分支，
   * 而它已经 100 行了 —— 拆开更清楚。
   *
   * ## 复用的是什么
   *
   * 后端选择、只校验、进度、落库、`onGenerated()` 全都一样，
   * 只有「materials 从哪来」不同。所以这里复制的是**取素材**那段，
   * 其余照旧 —— 注意不要复制出第二套落库逻辑。
   */
  const startVariant = useCallback(
    async (sel: VariantSelection) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setErrorHint(null);
      setDone(null);
      setProgress(null);
      try {
        const list = await backends.list();
        const ready = list.filter((b) => b.status === 'ready');
        if (ready.length === 0) {
          setError('还没有可用的模型。先到「设置」里添加一个后端。');
          return;
        }
        const backendId = ready[0]!.id;
        const apiKey = await backends.readCredential(backendId);
        if (!apiKey) {
          setError('读不到这个后端的 API Key，请到设置页重新填一次。');
          return;
        }

        const { DeepSeekQuestionBackend } = await import('@/core/questions/deepseek-backend.ts');
        const backend = new DeepSeekQuestionBackend({
          apiKey,
          provider: ready[0]!.provider,
          model: ready[0]!.model,
          ...(ready[0]!.baseUrl ? { baseUrl: ready[0]!.baseUrl } : {}),
        });

        /* ---- 取变式素材（与 generate 唯一的不同点） ---- */
        let materials: QuestionMaterial[] = [];
        let titleBase = '变式';

        if (sel.source === 'wrong') {
          /*
           * 错题来源必须和面板**同一个**（2026-11-13 修）。
           *
           * 面板列的是 reviewService.wrongCardsDetailed()（读 reviewLogs，
           * 也就是用户实际做题的地方）；这里原来调 decks.getWrongQuestions()
           * （读 answerRecords）。用户库里 answerRecords 是空的、
           * reviewLogs 才有时，面板能勾、点开始必然报「选中的错题已经不在
           * 错题本里了」，一道题都出不来 —— 用户看到的就是「点了没反应」。
           *
           * 两边都读同一份数据，这个错位才不会复发。
           */
          const detail = reviewService ? await reviewService.wrongCardsDetailed() : [];
          const wrongCountOf = new Map(detail.map((d) => [d.cardId, d.wrongCount]));
          const picked: Array<{ question: Question; wrongCount: number }> = [];
          for (const id of sel.questionIds) {
            try {
              const q = await decks.getQuestion(id);
              if (q) picked.push({ question: q, wrongCount: wrongCountOf.get(id) ?? 1 });
            } catch {
              /* 单条读不出来不影响其它 */
            }
          }
          if (picked.length === 0) {
            setError('选中的错题已经不在错题本里了，刷新一下再试。');
            return;
          }
          /* 知识点用来给变式题提供出处；取不到也能变，只是没有出处 */
          const pointsById = new Map<string, KnowledgePoint>();
          for (const src of (await sourceService.list()) ?? []) {
            for (const p of await knowledge.listBySource(src.id)) pointsById.set(p.id, p);
          }
          materials = wrongQuestionsToVariantMaterials(picked, pointsById, sel.axes);
          titleBase = '错题变式';
        } else {
          const pointsById = new Map<string, KnowledgePoint>();
          for (const src of (await sourceService.list()) ?? []) {
            for (const p of await knowledge.listBySource(src.id)) pointsById.set(p.id, p);
          }
          const picked = sel.pointIds
            .map((id) => pointsById.get(id))
            .filter((p): p is KnowledgePoint => Boolean(p));
          if (picked.length === 0) {
            setError('选中的知识点找不到了，刷新一下再试。');
            return;
          }
          materials = knowledgePointsToVariantMaterials(picked, sel.axes);
          titleBase = '知识点变式';
        }

        if (materials.length === 0) {
          setError('没有可用来变式的内容。');
          return;
        }

        const controller = new AbortController();

        const out = await decks.generate({
          /* 素材优先；points 留空 —— generate 会用 materials */
          points: [],
          materials,
          title: `${titleBase} · ${new Date().toLocaleDateString('zh-CN')}`,
          sourceId: null,
          backend,
          options: {
            kinds,
            count: sel.count,
            /* 变式不强制题型分布 —— 同一个考点换考法比换题型更有意义 */
            levels: levels.length > 0 ? levels : null,
            language: 'zh',
          },
          signal: controller.signal,
          onProgress: (p) => {
            setProgress({ produced: p.produced, total: p.estimatedTotal });
          },
        });

        const kindCount: Record<string, number> = {};
        for (const q of out.questions) kindCount[q.kind] = (kindCount[q.kind] ?? 0) + 1;
        setDone({
          deck: out.deck.title,
          deckId: out.deck.id,
          questions: out.questions.length,
          kinds: kindCount,
        });
        onGenerated();
      } catch (err) {
        reportError(err, '变式出题失败');
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [
      busy, backends, decks, sources, knowledge, sourceService,
      kinds, levels, onGenerated, reviewService,
    ],
  );

  // ---- 没有资料：先引导导入 ----
  if (sources !== null && sources.length === 0) {
    return (
      <div className="gen-empty">
        <div className="gen-empty__icon" aria-hidden="true">
          <IconDoc size={36} />
        </div>
        <h2 className="gen-empty__title">先添加一份资料</h2>
        <p className="gen-empty__desc">
          讲义、笔记、PDF 或网页都可以。AI 只根据你添加的资料出题，
          并标出每道题的出处。
        </p>
        <div className="gen-empty__actions">
          <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenSources}>
            <IconUpload size={15} />
            添加资料
          </button>
          <button type="button" className="btn-text" onClick={() => setMode('import-json')}>
            已有题目？导入 JSON 题组
          </button>
          {/*
           * 这个组件现在嵌在「我的题组」页里，空态也必须有一条回去的路 ——
           * 否则用户点进「新建题组」发现没资料，就困在这一屏了。
           */}
          {onBack ? (
            <button type="button" className="btn-text" onClick={onBack}>
              返回题组列表
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="gen-page">
      <div className="gen-head">
        <div>
          <h2 className="gen-title">出一组新题</h2>
          <p className="gen-sub">用你的资料让 AI 出题；已经有现成的题目，也可以直接导入。</p>
        </div>
        {onBack ? (
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回题组列表
          </button>
        ) : null}
      </div>

      {/* 四种方式 */}
      <div className="gen-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`gen-mode${mode === m.id ? ' gen-mode--on' : ''}${
              m.ready ? '' : ' gen-mode--soon'
            }`}
            onClick={() => m.ready && setMode(m.id)}
            disabled={!m.ready}
            title={m.ready ? m.desc : `${m.desc}（还没做）`}
          >
            <span className="gen-mode__title">{m.title}</span>
            <span className="gen-mode__desc">{m.desc}</span>
            {!m.ready ? <span className="gen-mode__badge">还没做</span> : null}
          </button>
        ))}
      </div>

      {/*
        ---- 出题反馈：所有模式共用 ----

        2026-11-13 修：这段原来只写在「用资料出题」那块表单里面，
        于是变式模式下点「开始变式」——无论成功、失败还是正在跑，
        界面上一个字都不会变。用户的原话是「点击出题按钮后没有题出现，
        无论有没有产出都没有任何反馈」。

        放在这里（模式卡片下方、各模式表单上方）而不是每个模式里各写一遍：
        三处各写一遍必然会漏一处，这是本项目反复踩过的坑。
      */}
      <GenFeedback
        busy={busy}
        progress={progress}
        error={error}
        errorHint={errorHint}
        done={done}
        kinds={kinds}
        onOpenDecks={onOpenDecks}
      />

      {/* ---- 变式出题 ---- */}
      {mode === 'variant' ? (
        <div className="gen-form">
          <VariantPanel
            decks={decks}
            knowledge={knowledge}
            sources={sourceService}
            /*
             * 没有复习服务时给一个「永远返回空」的替身：
             * 面板会显示「还没有错题记录」的引导语，而不是崩掉。
             * 这是刻意的 —— 比在界面里塞一个「功能不可用」的假按钮好。
             */
            review={
              reviewService ?? {
                wrongCardsDetailed: async () => [],
              }
            }
            busy={busy}
            {...(initialVariant ? { preselect: initialVariant } : {})}
            onStart={(sel) => void startVariant(sel)}
          />
        </div>
      ) : null}

      {/* ---- 导入 JSON 题组 ---- */}
      {mode === 'import-json' ? (
        <div className="gen-form">
          <ImportPanel
            decks={decks}
            disabled={busy}
            onImported={() => {
              /*
               * 导入完成后刷新外层（题组列表计数要更新），
               * 但不自动跳走 —— 用户可能想接着导第二个。
               * 「再导入一个」按钮由面板自己给。
               */
              onGenerated();
            }}
          />
        </div>
      ) : null}

      {/* ---- 用资料出题 ---- */}
      {mode === 'from-source' ? (
        <div className="gen-form">
          {/* 出题素材来源：资料原文 / 知识库知识点 */}
          <OriginPicker
            origin={origin}
            onOriginChange={setOrigin}
            acrossAll={acrossAll}
            onAcrossAllChange={setAcrossAll}
            sources={sources}
            selected={selected}
            onSelectedChange={setSelected}
            locatedPointCount={origin === 'knowledge' ? usablePoints.length : null}
            usableSegmentCount={origin === 'source-text' ? usableSegments.length : null}
            disabled={busy}
            onOpenOrganize={onOpenOrganize}
          />


          <fieldset className="gen-field">
            <legend className="gen-legend">03 / 题型与数量</legend>
            <div className="gen-label gen-label--wide">
              题型（可多选）
              <KindPicker
                value={kinds}
                onChange={(next) => {
                  setKinds(next);
                  /*
                   * 新勾上的题型给一个默认数量（2026-11-08）。
                   *
                   * 不给的话它进来是 0 —— 用户勾了判断题，合计却不变，
                   * 会以为勾选没生效。给 2 道是个合理的「先出一两道看看」。
                   *
                   * 取消勾选的题型保留它的旧数量：用户可能只是临时取消、
                   * 待会又勾回来，清掉会让他重新填一遍。
                   */
                  setKindCounts((prev) => {
                    const out = { ...prev };
                    for (const k of next) {
                      if (!(k in out) || (out[k] ?? 0) <= 0) out[k] = 2;
                    }
                    return out;
                  });
                }}
                disabled={busy}
              />
            </div>
            <QuotaPicker
              kinds={kinds}
              counts={kindCounts}
              onCountsChange={setKindCounts}
              levels={levels}
              onLevelsChange={setLevels}
              disabled={busy}
            />
          </fieldset>

          {/*
            章节范围（2026-11-08，用户要求「按章节限范围出题」）。

            为什么需要：一本 600 页的书整理出几百条知识点，
            而用户往往只想先出「第 3 章」的题。原来只能整本出，
            要么一次烧掉太多 token，要么出的题散落在各章没法按进度练。

            为什么默认不限制：不选就是全部，符合「不选即全要」的直觉；
            默认全选的话，20 章的资料一进来就是 20 个勾，用户还得先取消。
          */}
          {chapters.length > 0 ? (
            <fieldset className="gen-fieldset">
              <legend className="gen-legend">
                章节范围
                <span className="gen-legend__note">
                  {pickedChapters.size === 0
                    ? `不限（全部 ${chapters.length} 章、${locatablePoints.length} 条知识点）`
                    : `已选 ${pickedChapters.size} 章、${usablePoints.length} 条知识点`}
                </span>
              </legend>
              <div className="gen-chapters">
                {chapters.map((name) => {
                  const on = pickedChapters.has(name);
                  const n = locatablePoints.filter((p) => (p.chapter ?? '').trim() === name).length;
                  return (
                    <label key={name} className={'gen-chapter' + (on ? ' gen-chapter--on' : '')}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy}
                        onChange={() =>
                          setPickedChapters((prev) => {
                            const next = new Set(prev);
                            if (next.has(name)) next.delete(name);
                            else next.add(name);
                            return next;
                          })
                        }
                      />
                      <span className="gen-chapter__name">{name}</span>
                      <span className="gen-chapter__n">{n} 条</span>
                    </label>
                  );
                })}
              </div>
              {pickedChapters.size > 0 ? (
                <button
                  type="button"
                  className="gen-chapter__reset"
                  disabled={busy}
                  onClick={() => setPickedChapters(new Set())}
                >
                  不限章节（全部）
                </button>
              ) : null}
            </fieldset>
          ) : null}

          {/* 预估 token：点下去之前就该知道会花多少 */}
          <div className="gen-estimate">
            <span className="gen-estimate__label">预计用量</span>
            <span className="gen-estimate__value">约 {estimatedTokens} token</span>
            <span className="gen-estimate__note">按资料字数与题数估算，实际以服务端返回为准</span>
          </div>

          <div className="gen-actions">
            <button
              type="button"
              className="btn-fill"
              onClick={() => void generate()}
              disabled={busy || (origin === 'source-text' ? usableSegments.length === 0 : usablePoints.length === 0)}
            >
              <IconGenerate size={16} />
              {busy ? '正在生成…' : '生成并检查题组'}
            </button>
            {origin === 'source-text'
              ? usableSegments.length === 0
                ? (
                  <span className="gen-hint">这份资料还没有可出题的正文，先解析成文字（扫描件要先转成正文）</span>
                )
                : null
              : usablePoints.length === 0
                ? (
                  <span className="gen-hint">先有已定位的知识点才能出题</span>
                )
                : null}
          </div>
        </div>
      ) : null}

      {/*
        ---- 未实现的方式：说清为什么，不摆假按钮 ----

        条件必须**逐个列出**真正没做的那几个，不能用 `mode !== 'from-source'`。
        踩过的坑：导入做完之后，那个宽条件把「导入 JSON」也算成「还没做」，
        于是在能用的导入面板下面又挂了一句「这种方式还没做」——
        用户看到互相矛盾的两句话（截图核对时发现的）。
      */}
      {mode === 'case' || mode === 'capture' ? (
        <div className="gen-todo">
          {mode === 'case'
            ? '案例分析题还没做 —— 它需要「长案例 + 评分标准」这套结构，和现在的出题链路是两套。'
            : '从截图或题册导入还没做 —— 它需要看图模型把图片里的题转成文字，这部分还没接。'}
          <br />
          现在能用的是「用资料出题」（AI 读原文出题）和「导入 JSON 题组」（已有题目直接搬进来）。
        </div>
      ) : null}
    </div>
  );
}
