/**
 * 模拟考试。
 *
 * ## 三个阶段
 *
 *  1. `setup`   选范围（哪份资料/题组）、题目数、时限 → 出卷
 *  2. `taking`  倒计时答题，可随时交卷
 *  3. `result`  分数、逐题对错、可回看历史成绩
 *
 * ## 为什么交卷后才批改
 *
 * 做题（复习）时每题即时揭晓，是为了「马上知道自己会不会」。
 * 模拟考相反：**中途知道对错会影响后面的心态与答题**，
 * 那就不叫模拟考了。所以答案在交卷前一律不显示。
 *
 * ## 为什么不改复习进度
 *
 * 考试时紧张、状态差，用它的结果去改间隔复习的计划会把复习带偏。
 * 成绩单独记录（examAttempts），与 reviewRecords 完全隔离。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExamAnswer, ExamAttempt, Question, Source } from '@/core/model.ts';
import type { ExamService } from '@/core/exam.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import { isCorrect } from '@/v2/core/cards.ts';
import { MathText } from './MathText.tsx';
import { isAutoGraded } from '@/core/questions/kinds.ts';
import { ExamGradePanel } from './ExamGradePanel.tsx';
import { HistoryView } from './ExamHistoryView.tsx';
import { QuestionPicker } from './QuestionPicker.tsx';
import { ConfirmDialog } from './dialog.tsx';
import { usePageTask } from './page-task-context.ts';

export interface ExamPageProps {
  exam: ExamService;
  decks: DeckService;
  sourceService: SourceService;
  onOpenDecks: () => void;
  /**
   * AI 评分（2026-11-17 方案 3）。
   *
   * 用户要求「主要是 AI 评分，要是用户觉得评分不对可以自己再评」。
   * 由 App 注入 —— 本页不碰后端配置与 Key。
   *
   * 不传 = 不显示评分面板（成绩页保持老样子）。
   */
  onAiGrade?: (input: {
    prompt: string;
    answer: string;
    explanation: string;
    response: string;
  }) => Promise<import('@/core/ai/grade-short.ts').ShortGradeResult | null>;
  /**
   * AI 组卷（2026-11-17 用户要求）。
   *
   * 由 App 注入：读后端凭据、发请求都在那边（本页不碰 Key）。
   * 返回**已校验过 id** 的题库子集；失败返回 null。
   *
   * 不传 = 没有可用后端，界面不显示「让 AI 组卷」按钮（不摆假按钮）。
   */
  onAiCompose?: (input: {
    questions: readonly Question[];
    count: number;
    scopeLabel: string;
  }) => Promise<{ picked: string[]; rationale: string; tokens?: number | null } | null>;
  /**
   * 在用户挑中的题基础上，让 AI 改造出新题并组成一套卷（2026-11-17）。
   *
   * 用户原话：「用户先在题库挑选想要的题目，然后 ai 在这些题目的基础上改动出题」。
   *
   * 返回生成好的题目（已经落库成题组），本页拿去开考。
   * 不传 = 没有后端，下拉里那一项置灰。
   */
  onComposeVariantFrom?: (input: {
    questions: readonly Question[];
    axes: readonly string[];
  }) => Promise<{ questions: Question[]; deckTitle: string; tokens?: number | null } | null>;
  /**
   * 任务运行记录（2026-11-17 用户要求：
   * 「这个让 ai 组卷的过程在任务栏目里面也要有记录」）。
   *
   * 不传 = 不记录（单测里不传，避免污染）。
   */
  runRecorder?: {
    startCompose: (input: {
      scopeId: string;
      scopeLabel: string;
      wantCount: number;
      poolSize: number;
    }) => Promise<string>;
    finishCompose: (
      id: string,
      outcome: {
        status: 'completed' | 'stopped' | 'failed';
        picked: number;
        tokens?: number | null;
        error?: string | null;
      },
    ) => Promise<void>;
  };
}

/**
 * 页面阶段。
 *
 * `taking` 直接**带着试卷**，而不是靠一个模块级变量传：
 * 模块级可变状态在 React 里是事故源 —— 组件重渲染时读到的可能是
 * 上一次的残留，热更新时更是完全不可预期。
 */
type Phase =
  | { kind: 'setup' }
  | { kind: 'taking'; paper: Question[]; title: string; limitSec: number }
  | { kind: 'result'; attempt: ExamAttempt; questions: Question[] }
  /**
   * 回看历史试卷（2026-11-17 用户要求）。
   *
   * 「最后下面的历史成绩可以点击查看试卷所有的习题」——
   * 与 `result` 分开：那个是刚交完卷、可以接着评分的；
   * 这个是纯回看，题目可能已经从题组里删掉（找不到的是少数）。
   */
  | { kind: 'history'; attempt: ExamAttempt; questions: Question[] }
  /**
   * 跨题组手动选题（2026-11-17 用户要求）。
   *
   * 单独一个 phase 而不是在 setup 里弹模态框：
   * 选题是个**浏览型**任务（要看几十道题的题干），
   * 塞进窄弹窗里体验很差。
   */
  | { kind: 'picking' };

/** 可选的题目数量 */
const COUNT_OPTIONS = [5, 10, 20, 30, 50];
/** 可选的时限（分钟），0 = 不限时 */
const LIMIT_OPTIONS = [
  { min: 0, label: '不限时' },
  { min: 5, label: '5 分钟' },
  { min: 10, label: '10 分钟' },
  { min: 20, label: '20 分钟' },
  { min: 30, label: '30 分钟' },
  { min: 60, label: '60 分钟' },
];

export function ExamPage({
  exam,
  decks,
  sourceService,
  onOpenDecks,
  onAiGrade,
  onAiCompose,
  onComposeVariantFrom,
  runRecorder,
}: ExamPageProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });

  /* ---- 可选题池 ---- */
  const [pools, setPools] = useState<{ id: string; label: string; questions: Question[] }[]>([]);
  const [poolId, setPoolId] = useState('');
  const [count, setCount] = useState(10);
  const [limitMin, setLimitMin] = useState(20);
  const [history, setHistory] = useState<ExamAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 待删除的历史记录（2026-11-17，二次确认框由它驱动） */
  const [pendingDelete, setPendingDelete] = useState<ExamAttempt | null>(null);
  /** 跨题组选题里已勾的题（2026-11-17） */
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  /** AI 组卷状态（2026-11-17） */
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  /**
   * 这次打开选题面板是「原样开考」还是「改造后组卷」（2026-11-17）。
   *
   * 用同一个 QuestionPicker 但两种用途 —— 用户要求
   * 「不用多加个按钮」，所以入口合并成下拉里的两项。
   */
  const [pickerFor, setPickerFor] = useState<'exam' | 'variant'>('exam');
  /**
   * 按**题组**分好的题（2026-11-17 跨题组选题用）。
   *
   * 与 `pools` 分开存：pools 是按「资料」合并的（出卷下拉要那个口径），
   * 而选题面板要看清「这道题来自哪个题组」—— 合并后就看不出边界了。
   */
  const [deckGroups, setDeckGroups] = useState<
    { deckId: string; deckTitle: string; questions: Question[] }[]
  >([]);

  const load = useCallback(async () => {
    try {
      const [deckList, srcs, attempts] = await Promise.all([
        decks.list(),
        sourceService.list(),
        exam.list(),
      ]);
      const published = deckList.filter((d) => d.status === 'published');
      const srcTitle = new Map<string, string>(srcs.map((s: Source) => [s.id, s.title]));

      /* 每个「可考范围」= 一份资料下所有已发布题组的题 */
      const bySource = new Map<string, { label: string; questions: Question[] }>();
      /* 按题组分开留一份（2026-11-17 跨题组选题要用） */
      const byDeck: { deckId: string; deckTitle: string; questions: Question[] }[] = [];
      for (const d of published) {
        const qs = await decks.getQuestions(d.id);
        if (qs.length > 0) byDeck.push({ deckId: d.id, deckTitle: d.title, questions: qs });
        const key = d.sourceId ?? `__deck_${d.id}`;
        const label = d.sourceId
          ? (srcTitle.get(d.sourceId) ?? '（资料已删除）')
          : `题组：${d.title}`;
        const cur = bySource.get(key) ?? { label, questions: [] };
        /*
         * 全部题型都能进考场（2026-11-17 方案 3，用户要求）。
         *
         * 用户原话：「我选方案3（计算题和问答题都放进考场），但是除了自评
         * 还可以加入 ai 评分，主要是 ai 评分，要是用户觉得评分不对可以
         * 自己再评。」
         *
         * ## 为什么现在敢放开
         *
         * 2026-11-12 那次是「把计算题放进来，但判分仍走字符串相似度」——
         * 那才会错。现在自评题交卷时标 `correct: null` + `gradedBy:'pending'`，
         * 不算错、也不算对，评完才落定（见 ExamService.grade / submit）。
         *
         * ## 但仍要知道哪些题需要评
         *
         * 下面的 `needsGrading` 传给界面，用于：
         *  - 出卷时提示「其中 N 道交卷后需评分」
         *  - 成绩页把未评完的卷子标出来
         */
        cur.questions.push(...qs);
        bySource.set(key, cur);
      }

      const list = [...bySource.entries()]
        .filter(([, v]) => v.questions.length > 0)
        .map(([id, v]) => ({ id, label: v.label, questions: v.questions }));

      /* 全库合并池 */
      const all = list.flatMap((p) => p.questions);
      if (all.length > 0) {
        /*
         * label 里不放数量 —— 下拉选项渲染时本来就会补「（N 道）」，
         * 两处都写会变成「全部已发布题目（16 道）(16 道)」（截图核对时发现的）。
         */
        list.unshift({ id: '__all__', label: '全部已发布题目', questions: all });
      }

      setPools(list);
      setPoolId(list[0]?.id ?? '');
      setDeckGroups(byDeck);
      setHistory(attempts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读不出题库');
    } finally {
      setLoading(false);
    }
  }, [decks, sourceService, exam]);

  useEffect(() => {
    void load();
  }, [load]);

  const pool = pools.find((p) => p.id === poolId);
  const available = pool?.questions.length ?? 0;
  /**
   * 这个范围里有多少道是「交卷后要评分」的（方案 3，2026-11-17）。
   *
   * 为什么要提前告诉用户：自评题进考场之后，一场 10 题的卷子
   * 可能有 3 题要等评分。用户在**开考前**就该知道，
   * 而不是交完卷发现「怎么不给我分数」。
   */
  const needsGradingCount = (pool?.questions ?? []).filter((q) => !isAutoGraded(q.kind)).length;

  /**
   * 打开某一次历史考试（2026-11-17 用户要求）。
   *
   * ## 为什么要重新取题目
   *
   * 考试记录里只存了 `questionIds`，题目正文在 `questions` 分区。
   * 题目可能已经被删（题组删了、题被改过）—— 那种情况如实跳过，
   * 不能让整页打不开。
   *
   * 用 `decks` 服务取（它已经按 id 提供了读题能力），
   * 比在 ExamPage 里直接摸 storage 干净。
   */
  const openAttempt = useCallback(
    async (id: string) => {
      try {
        const attempt = await exam.get(id);
        if (!attempt) {
          setErr('这条记录已经不存在了（可能刚被删掉）。');
          return;
        }
        /* 按 questionIds 顺序取题，删掉的跳过 */
        const found: Question[] = [];
        for (const qid of attempt.questionIds) {
          const q = await decks.getQuestion(qid);
          if (q) found.push(q);
        }
        setPhase({ kind: 'history', attempt, questions: found });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '打不开这份试卷');
      }
    },
    [exam, decks],
  );

  /**
   * 删除一条历史记录（2026-11-17 用户要求）。
   *
   * 用户原话：「试卷的历史纪录要能删除，以免后期出卷太多不好查询历史记录」。
   *
   * 二次确认由 `pendingDelete` 驱动（删了就真没了，不像回收站能还原 ——
   * 考试记录本来就是流水账，进回收站反而没意义）。
   */
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await exam.remove(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    }
  }, [pendingDelete, exam, load]);

  /**
   * 让 AI 从当前范围里配一套卷（2026-11-17 用户要求）。
   *
   * ## 为什么是「挑」不是「生成」
   *
   * 用户说的是「不好查询历史记录」+「题型分布符合考试标准」——
   * 他要的是从**已有题**里配。新生成的题没有原文出处、点不回原页，
   * 而这个项目的支点就是「每道题都能点回原文」。
   *
   * ## 凑不够怎么办
   *
   * 模型挑的题可能少于要求（它觉得重复的都只挑一道）。
   * 这里**不自己补题** —— 补的题不受模型判断约束，会破坏它刚配好的分布。
   * 但也不能让用户白等：如实说「配了 N 题」并直接开考。
   */
  const runAiCompose = useCallback(async () => {
    if (!pool || pool.questions.length === 0) {
      setAiErr('这个范围里没有可考的题。');
      return;
    }
    if (!onAiCompose) {
      setAiErr('还没有可用的模型后端。到「设置 → 模型与出题」加一个。');
      return;
    }
    setAiBusy(true);
    setAiErr(null);
    setAiNote(null);

    /*
     * 开一条任务记录（2026-11-17 用户要求：
     * 「这个让 ai 组卷的过程在任务栏目里面也要有记录」）。
     *
     * 与解析记录同样的纪律：**无论成功失败都要关掉**，
     * 否则任务页会永远显示「进行中」。
     */
    let runId: string | null = null;
    if (runRecorder) {
      try {
        runId = await runRecorder.startCompose({
          scopeId: pool.id,
          scopeLabel: pool.label,
          wantCount: Math.min(count, pool.questions.length),
          poolSize: pool.questions.length,
        });
      } catch {
        runId = null;
      }
    }
    const finish = async (
      status: 'completed' | 'failed',
      picked: number,
      tokens: number | null,
      error?: string | null,
    ) => {
      if (!runId || !runRecorder) return;
      try {
        await runRecorder.finishCompose(runId, { status, picked, tokens, error: error ?? null });
      } catch {
        /* 统计失败不影响主流程 */
      }
      runId = null;
    };

    try {
      const want = Math.min(count, pool.questions.length);
      const parsed = await onAiCompose({
        questions: pool.questions,
        count: want,
        scopeLabel: pool.label,
      });
      if (!parsed) {
        void finish('failed', 0, null, '没有返回可用结果');
        /*
         * 现在 App.tsx 会把真实原因**抛上来**（不再吞成 null），
         * 所以走到这里只剩一种情况：没有可用后端（回调被省略）。
         */
        setAiErr('还没有可用的模型后端，或者这次组卷没有返回结果。到「设置 → 模型与出题」检查一下。');
        return;
      }

      const pickedSet = new Set(parsed.picked);
      const paper = pool.questions.filter((q) => pickedSet.has(q.id));
      if (paper.length === 0) {
        void finish('failed', 0, null, '挑的题不在题库里');
        setAiErr('AI 挑的题不在题库里（可能是幻觉 id），再试一次。');
        return;
      }

      /* 按题型统计，让用户看清它配了什么 */
      const byKind = new Map<string, number>();
      for (const q of paper) byKind.set(q.kind, (byKind.get(q.kind) ?? 0) + 1);
      const parts = [...byKind.entries()].map(([k, n]) => `${kindLabel(k)} ${n}`);
      setAiNote(
        `AI 配了 ${paper.length} 题：${parts.join(' / ')}` +
          (parsed.rationale ? `。${parsed.rationale}` : ''),
      );

      void finish('completed', paper.length, parsed.tokens ?? null, null);

      setPhase({
        kind: 'taking',
        paper,
        title: `AI 组卷 · ${pool.label}`,
        limitSec: limitMin * 60,
      });
    } catch (e) {
      void finish('failed', 0, null, e instanceof Error ? e.message : '组卷失败');
      setAiErr(e instanceof Error ? e.message : 'AI 组卷失败');
    } finally {
      setAiBusy(false);
    }
  }, [pool, count, limitMin, onAiCompose, runRecorder]);

  /**
   * 「先自己挑，再让 AI 改造」（2026-11-17 用户要求）。
   *
   * 用户原话：「用户先在题库挑选想要的题目，然后 ai 在这些题目的基础上
   * 改动出题」。
   *
   * ## 与 `runAiCompose` 的区别
   *
   * | | runAiCompose | 本函数 |
   * |---|---|---|
   * | 题从哪来 | AI 从题库里挑 | **用户挑** |
   * | 题目内容 | 原样不动 | **AI 改造出新题** |
   * | 用途 | 快速配一套 | 按自己的重点造一套 |
   *
   * 两条路并存，互不影响 —— 用户明确说「原有的组卷功能上不变」。
   *
   * ## 改造出来的题会落成一个新题组
   *
   * 由 App 侧的 `decks.generate` 负责（它已经有完整的生成+落库链路）。
   * 本函数只管「拿结果去开考」。
   */
  const runComposeVariant = useCallback(
    async (picked: Question[], axes: string[]) => {
      if (!onComposeVariantFrom) {
        setAiErr('这个功能需要先配好模型后端。到「设置 → 模型与出题」加一个。');
        return;
      }
      if (picked.length === 0) {
        setAiErr('先挑至少一道题。');
        return;
      }
      setAiBusy(true);
      setAiErr(null);
      setAiNote(null);

      /* 任务记录：与 AI 组卷同一套纪律（开场 → 无论成败都关） */
      let runId: string | null = null;
      if (runRecorder) {
        try {
          runId = await runRecorder.startCompose({
            scopeId: 'picked-variant',
            scopeLabel: `自选 ${picked.length} 题 · AI 改造`,
            wantCount: picked.length,
            poolSize: picked.length,
          });
        } catch {
          runId = null;
        }
      }
      const finish = async (
        status: 'completed' | 'failed',
        produced: number,
        tokens: number | null,
        error?: string | null,
      ) => {
        if (!runId || !runRecorder) return;
        try {
          await runRecorder.finishCompose(runId, { status, picked: produced, tokens, error: error ?? null });
        } catch {
          /* 统计失败不影响主流程 */
        }
        runId = null;
      };

      try {
        const r = await onComposeVariantFrom({ questions: picked, axes });
        if (!r || r.questions.length === 0) {
          void finish('failed', 0, null, '没有产出可用的新题');
          setAiErr('AI 这次没有改造出可用的题，再试一次，或者换个方向。');
          return;
        }

        /* 按题型统计，让用户看清改造出了什么 */
        const byKind = new Map<string, number>();
        for (const q of r.questions) byKind.set(q.kind, (byKind.get(q.kind) ?? 0) + 1);
        const parts = [...byKind.entries()].map(([k, n]) => `${kindLabel(k)} ${n}`);
        setAiNote(
          `基于你挑的 ${picked.length} 题，AI 改造出 ${r.questions.length} 题：${parts.join(' / ')}。` +
            `已存成题组「${r.deckTitle}」。`,
        );

        void finish('completed', r.questions.length, r.tokens ?? null, null);

        setPhase({
          kind: 'taking',
          paper: r.questions,
          title: r.deckTitle,
          limitSec: limitMin * 60,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '改造失败';
        void finish('failed', 0, null, msg);
        setAiErr(msg);
      } finally {
        setAiBusy(false);
      }
    },
    [onComposeVariantFrom, limitMin, runRecorder],
  );

  if (loading) {
    return (
      <div className="exam-page">
        <p className="ex-hint">正在准备…</p>
      </div>
    );
  }

  if (pools.length === 0) {
    return (
      <div className="exam-page">
        <header className="ex-head">
          <h1 className="ex-title">模拟考试</h1>
        </header>
        <div className="ex-empty">
          <p>还没有可以考的题。</p>
          <p className="ex-hint">
            模拟考试只从<strong>已发布</strong>题组里抽题，而且不含问答、计算这类
            需要你自己判断对错的题（算不出客观分数）。
          </p>
          <button type="button" className="btn-ghost" onClick={onOpenDecks}>
            去我的题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="exam-page">
      {phase.kind === 'setup' ? (
        <SetupView
          pools={pools}
          poolId={poolId}
          onPool={setPoolId}
          count={count}
          onCount={setCount}
          limitMin={limitMin}
          onLimit={setLimitMin}
          available={available}
          needsGrading={needsGradingCount}
          history={history}
          err={err}
          onStart={() => {
            if (!pool) return;
            const paper = exam.buildPaper({ pool: pool.questions, count, title: pool.label });
            if (paper.length === 0) {
              setErr('这个范围里没有可考的题。');
              return;
            }
            setPhase({
              kind: 'taking',
              paper,
              title: pool.label,
              limitSec: limitMin * 60,
            });
          }}
          onOpenDecks={onOpenDecks}
          onOpenAttempt={(id) => void openAttempt(id)}
          onOpenPicker={() => {
            /* 从「自己挑题」按钮进来 = 原样开考（2026-11-17） */
            setPickerFor('exam');
            setPhase({ kind: 'picking' });
          }}
          {...(onComposeVariantFrom
            ? {
                onComposeVariant: () => undefined,
                onOpenPickerForVariant: () => {
                  /* 从「先自己挑，再让 AI 改造」进来 = 改造模式 */
                  setPickerFor('variant');
                  setPhase({ kind: 'picking' });
                },
              }
            : {})}
          {...(onAiCompose ? { onAiCompose: () => runAiCompose() } : {})}
          aiBusy={aiBusy}
          aiNote={aiNote}
          aiErr={aiErr}
          onDeleteAttempt={(a) => setPendingDelete(a)}
        />
      ) : null}

      {phase.kind === 'taking' ? (
        <TakingView
          paper={phase.paper}
          title={phase.title}
          limitSec={phase.limitSec}
          onCancel={() => setPhase({ kind: 'setup' })}
          onSubmit={async (answers, startedAt, usedSec, timedOut) => {
            const attempt = await exam.submit({
              title: `模拟考试 · ${phase.title}`,
              questions: phase.paper,
              answers,
              startedAt,
              limitSec: phase.limitSec,
              usedSec,
              timedOut,
            });
            setPhase({ kind: 'result', attempt, questions: phase.paper });
            setHistory(await exam.list());
          }}
        />
      ) : null}

      {phase.kind === 'result' ? (
        <ResultView
          attempt={phase.attempt}
          questions={phase.questions}
          onAgain={() => {
            setPhase({ kind: 'setup' });
            void load();
          }}
          {...(onAiGrade ? { onAiGrade } : {})}
          /*
            评分落库（2026-11-17 方案 3）。
            用 exam.regradeAnswer —— 它会把整份卷子的 correct / pendingCount
            重算并写回，所以用户评到一半关软件，下次打开还在。
          */
          onRegrade={async (questionId, patch) => {
            const next = await exam.regradeAnswer(phase.attempt.id, questionId, patch);
            if (next) setPhase({ kind: 'result', attempt: next, questions: phase.questions });
          }}
        />
      ) : null}

      {/*
        回看历史试卷（2026-11-17 用户要求）。
        与 result 分开：这里**不给评分入口** —— 那次考试已经结束，
        事后改分没有意义（要改就再考一次）。
        只如实显示当时的答案与判定。
      */}
      {phase.kind === 'history' ? (
        <HistoryView
          attempt={phase.attempt}
          questions={phase.questions}
          onBack={() => setPhase({ kind: 'setup' })}
          onDelete={() => {
            setPendingDelete(phase.attempt);
            setPhase({ kind: 'setup' });
          }}
        />
      ) : null}

      {/* 跨题组选题组卷（2026-11-17 用户要求） */}
      {phase.kind === 'picking' ? (
        <>
          {/*
            改造组卷在这个阶段就会开始跑（点确认之后），
            而提示原本只在设置页显示 —— 用户会停在选题面板上，
            看不到任何「正在跑」的迹象（2026-11-17 发现的真缺口）。

            所以这里也放一条同样的状态条。
          */}
          {aiBusy ? (
            <div className="ex-running" role="status" aria-live="polite">
              <span className="ex-running__spinner" aria-hidden="true" />
              <div className="ex-running__body">
                <p className="ex-running__title">AI 正在改造出题…</p>
                <p className="ex-running__hint">
                  通常十几秒到半分钟。改好后会自动进入考试，不用再点。
                </p>
              </div>
            </div>
          ) : null}
          <QuestionPicker
            groups={deckGroups}
            selected={pickedIds}
            onChange={setPickedIds}
            onCancel={() => setPhase({ kind: 'setup' })}
            busy={aiBusy}
            onConfirm={() => {
            const picked = deckGroups
              .flatMap((g) => g.questions)
              .filter((q) => pickedIds.has(q.id));
            if (picked.length === 0) return;
            /*
             * 同一个选题面板，两种用途（2026-11-17 用户要求）：
             *  - pickerFor === 'variant' → 让 AI 改造后组卷
             *  - 否则 → 原题原样开考
             *
             * 用户要求「不用多加个按钮」，所以用途由入口决定，
             * 面板本身不多摆一个「改造」按钮。
             */
            if (pickerFor === 'variant') {
              void runComposeVariant(picked, []);
              return;
            }
            /*
             * 自己挑的题**不打乱顺序** —— 用户是按一定思路挑的
             * （先单选后计算之类），打乱会破坏那个意图。
             * buildPaper 是「随机抽 N 道」，这里直接给全套。
             */
            setPhase({
              kind: 'taking',
              paper: picked,
              title: `自选卷 · ${picked.length} 题`,
              limitSec: limitMin * 60,
            });
          }}
          /*
            面板里的确认按钮文案随用途变（2026-11-17）。
            「用这些题开考」在改造模式下是错的 —— 那时候是去造题，
            不是直接开考。
          */
          confirmLabel={pickerFor === 'variant' ? '让 AI 改造后组卷' : undefined}
        />
        </>
      ) : null}

      {/* 删除历史记录：二次确认（2026-11-17） */}
      {pendingDelete ? (
        <ConfirmDialog
          title="删除这条考试记录？"
          description={
            `「${pendingDelete.title}」（${formatWhen(pendingDelete.finishedAt)}）` +
            '删除后不能恢复 —— 考试记录不进回收站。' +
            '题组与题目本身不受影响。'
          }
          confirmLabel="删除"
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

/* ============================ 设置试卷 ============================ */

function SetupView({
  pools,
  poolId,
  onPool,
  count,
  onCount,
  limitMin,
  onLimit,
  available,
  needsGrading = 0,
  history,
  err,
  onStart,
  onOpenDecks,
  onOpenAttempt,
  onOpenPicker,
  onAiCompose,
  onComposeVariant,
  onOpenPickerForVariant,
  aiBusy = false,
  aiNote = null,
  aiErr = null,
  onDeleteAttempt,
}: {
  pools: { id: string; label: string; questions: Question[] }[];
  poolId: string;
  onPool: (v: string) => void;
  count: number;
  onCount: (v: number) => void;
  limitMin: number;
  onLimit: (v: number) => void;
  available: number;
  /** 其中有多少道交卷后需要评分（方案 3）。不传 = 0（不显示提示） */
  needsGrading?: number;
  history: ExamAttempt[];
  err: string | null;
  onStart: () => void;
  onOpenDecks: () => void;
  /** 打开某一次考试的试卷详情（2026-11-17 用户要求） */
  onOpenAttempt: (id: string) => void;
  /** 打开跨题组选题（2026-11-17 用户要求） */
  onOpenPicker: () => void;
  /**
   * 触发 AI 组卷（2026-11-17 用户要求）。
   *
   * SetupView 只负责「按一下」—— 真正的组卷逻辑在 ExamPage 里
   * （它拿得到 pool、count、limitMin）。所以这里是个无参回调，
   * 不传 = 没有可用后端，不显示按钮。
   */
  onAiCompose?: () => void;
  /**
   * 「先自己挑，再让 AI 改造」这条路是否可用（2026-11-17）。
   *
   * 不传 = 没有后端，下拉里那一项置灰并说明原因（不摆假开关）。
   */
  onComposeVariant?: () => Promise<void> | void;
  /** 打开选题面板，但选中后走「改造」而不是「原样开考」 */
  onOpenPickerForVariant?: () => void;
  /** AI 组卷进行中（按钮显示「组卷中…」并禁用） */
  aiBusy?: boolean;
  /** AI 组卷的结果说明（「配了 10 题：单选 6 / 计算 2 …」） */
  aiNote?: string | null;
  /** AI 组卷失败原因 */
  aiErr?: string | null;
  /** 删除一条历史记录（2026-11-17 用户要求） */
  onDeleteAttempt: (attempt: ExamAttempt) => void;
}) {
  const usableCount = Math.min(count, available);
  /**
   * 「让 AI 组卷」的二级选项是否展开（2026-11-17 用户要求）。
   *
   * 用户明确说「不用多加个按钮…这样界面看起来不会太臃肿」——
   * 所以两条 AI 路径收在同一个下拉里，不并排摆两个按钮。
   */
  const [aiMenuOpen, setAiMenuOpen] = useState(false);

  return (
    <>
      <header className="ex-head">
        <h1 className="ex-title">模拟考试</h1>
        <p className="ex-lead">
          限时整卷、交卷后统一批改。考试结果<strong>不影响复习安排</strong> ——
          考砸了不会把你的复习计划带偏。
        </p>
      </header>

      {err ? <p className="ex-error">{err}</p> : null}

      <section className="ex-setup">
        <label className="ex-field">
          <span className="ex-field__label">考哪部分</span>
          <select className="ex-select" value={poolId} onChange={(e) => onPool(e.target.value)}>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}（{p.questions.length} 道）
              </option>
            ))}
          </select>
        </label>

        {/*
          自定义组卷入口（2026-11-17 用户要求）。
          用户原话：「建议增加一个可以从浏览题库并从不同题组里组卷出题的功能」。
          做成一条独立的路，而不是塞进上面的下拉 ——
          下拉是「选范围」，这个是「逐题挑」，两种心智模型不该混。
        */}
        <div className="ex-field">
          <span className="ex-field__label">或者自己挑题</span>
          <div className="ex-field__row">
            <button type="button" className="btn-ghost" onClick={onOpenPicker}>
              从题库选题组卷（跨题组）
            </button>
            {/*
              AI 组卷（2026-11-17 用户要求）。
              让模型从当前范围内的题里**挑**一套，而不是新生成题 ——
              新生成的题没有原文出处、点不回原页，那是这个项目的支点。
              不传回调 = 这个环境没有后端，不显示（不摆假按钮）。
            */}
            {onAiCompose ? (
              <>
              <button
                type="button"
                className="btn-ghost"
                disabled={aiBusy}
                onClick={() => setAiMenuOpen((v) => !v)}
                aria-expanded={aiMenuOpen}
                title="让 AI 配一套卷子 —— 可以直接从题库挑，也可以在你挑中的题基础上改造出新题"
              >
                {aiBusy ? 'AI 组卷中…' : '让 AI 组卷'}
                <span className="ex-menu__caret">{aiMenuOpen ? '▴' : '▾'}</span>
              </button>

              {/*
                二级选项（2026-11-17 用户要求：不要多一个按钮，点开再选）。
                
                两条路：
                  A. 直接从题库挑（原有功能，保持不变）
                  B. 先自己挑题 → AI 在那些题基础上改造出新题
                
                做成下拉而不是并排两个按钮：用户明确说
                「不用多加个按钮…这样界面看起来不会太臃肿」。
              */}
              {aiMenuOpen && !aiBusy ? (
                <div className="ex-menu">
                  <button
                    type="button"
                    className="ex-menu__item"
                    onClick={() => {
                      setAiMenuOpen(false);
                      void onAiCompose();
                    }}
                  >
                    <span className="ex-menu__title">直接从题库挑一套</span>
                    <span className="ex-menu__desc">
                      用现有的题，只重新挑，不改题目
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ex-menu__item"
                    disabled={!onComposeVariant}
                    onClick={() => {
                      setAiMenuOpen(false);
                      onOpenPickerForVariant?.();
                    }}
                    title={onComposeVariant ? '' : '需要先有可用模型'}
                  >
                    <span className="ex-menu__title">先自己挑，再让 AI 改造</span>
                    <span className="ex-menu__desc">
                      你在题库里选几道，AI 在这些题基础上出新题（考同一考点、换个问法）
                    </span>
                  </button>
                </div>
              ) : null}
              </>
            ) : null}
          </div>
        </div>

        {/*
          组卷进行中的明确提示（2026-11-17 用户要求）。

          用户原话：「ai组卷需要时间，这个时间内用户并不知道组卷是否成功进行，
          我需要在进行组卷时按钮变灰并提醒用户正在组卷。」

          ## 为什么光靠按钮变灰不够

          按钮变灰 + 文字变「AI 组卷中…」本来就有，但**位置不显眼**：
          它在「或者自己挑题」那一行里，而组卷要 10 秒以上。
          用户的视线可能已经移到下面（题目数、时限、开始考试），
          看不到那个小按钮在说什么，就会以为点了没反应。

          所以这里在**视线所在的区域**（原来显示结果说明的位置）
          放一条带转圈动画的状态条，说清三件事：
           1. 正在做什么（AI 正在配卷）
           2. 大概要多久（十几秒，别急）
           3. 结束后会发生什么（自动进考试）

          ## 为什么不用进度条

          组卷是一次请求，拿不到中间进度 —— 画一个假的百分比
          比不画更糟（用户会盯着一个不动的条等）。转圈是诚实的：
          它只说「在跑」，不假装知道跑了多少。
        */}
        {aiBusy ? (
          <div className="ex-running" role="status" aria-live="polite">
            <span className="ex-running__spinner" aria-hidden="true" />
            <div className="ex-running__body">
              <p className="ex-running__title">AI 正在组卷…</p>
              <p className="ex-running__hint">
                通常十几秒。组好后会自动进入考试，不用再点。
                想放弃就等它结束，或者切到别的页面 —— 它会在后台跑完。
              </p>
            </div>
          </div>
        ) : null}

        {aiNote ? <p className="ex-note">{aiNote}</p> : null}
        {aiErr ? <p className="ex-note ex-note--bad">{aiErr}</p> : null}

        <div className="ex-field">
          <span className="ex-field__label">题目数</span>
          <div className="ex-options">
            {COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`ex-chip${count === n ? ' ex-chip--on' : ''}`}
                onClick={() => onCount(n)}
                disabled={n > available && available > 0}
                title={n > available ? `这个范围只有 ${available} 道` : ''}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="ex-field">
          <span className="ex-field__label">时限</span>
          <div className="ex-options">
            {LIMIT_OPTIONS.map((o) => (
              <button
                key={o.min}
                type="button"
                className={`ex-chip${limitMin === o.min ? ' ex-chip--on' : ''}`}
                onClick={() => onLimit(o.min)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ex-summary">
          这份卷子：<strong>{usableCount}</strong> 道题
          {limitMin > 0 ? ` · ${limitMin} 分钟` : ' · 不限时'}
          {available > 0 && count > available ? `（这个范围只有 ${available} 道，全用）` : ''}
        </div>

        {/*
          提前告知「有些题要评分」（2026-11-17 方案 3）。
          不说的话，用户交完卷看到「待评」会莫名其妙 ——
          他以为考试应该自动出分。
        */}
        {needsGrading > 0 ? (
          <p className="ex-note">
            这个范围里有 <strong>{needsGrading}</strong> 道计算/问答题，
            交卷后需要评分：可以让 AI 评，也可以自己判。没评完之前分数会标「待评」。
          </p>
        ) : null}

        <div className="ex-actions">
          <button
            type="button"
            className="btn-fill"
            onClick={onStart}
            disabled={available === 0}
          >
            开始考试
          </button>
          {available === 0 ? (
            <button type="button" className="btn-text" onClick={onOpenDecks}>
              这个范围没有可考的题，去发布题组
            </button>
          ) : null}
        </div>
      </section>

      {/* ---- 历史成绩 ---- */}
      {history.length > 0 ? (
        <section className="ex-history">
          <h2 className="ex-h2">历史成绩</h2>
          <ul className="ex-history__list">
            {history.slice(0, 10).map((a) => {
              /*
               * 待评的题不进分母（2026-11-17 方案 3）。
               * 拿 correct/total 算，一份还有 4 题没评的卷子会显示成
               * 「19/23 = 83%」，看起来像考砸了 —— 而那 4 题是没评，不是答错。
               */
              const pending = a.pendingCount ?? 0;
              const gradedTotal = a.total - pending;
              const rate = gradedTotal > 0 ? a.correct / gradedTotal : 0;
              return (
                <li key={a.id} className="ex-history__item">
                  {/*
                    整行可点 → 打开那一次的试卷（2026-11-17 用户要求）。
                    用 button 而不是给 li 加 onClick：可聚焦、能回车、
                    屏幕阅读器认得出来。
                  */}
                  <button
                    type="button"
                    className="ex-history__open"
                    onClick={() => onOpenAttempt(a.id)}
                    title="查看这份试卷的每一道题"
                  >
                    <span className="ex-history__score">
                      {a.correct}/{gradedTotal}
                      {pending > 0 ? (
                        <em className="ex-history__pending">+{pending} 待评</em>
                      ) : null}
                    </span>
                    <span className="ex-history__rate">
                      {gradedTotal > 0 ? `${Math.round(rate * 100)}%` : '待评'}
                    </span>
                    <span className="ex-history__title">{a.title}</span>
                    <span className="ex-history__time">{formatWhen(a.finishedAt)}</span>
                    {a.timedOut ? <span className="ex-history__flag">超时交卷</span> : null}
                  </button>
                  {/*
                    删除这一条记录（2026-11-17 用户要求）。
                    用户原话：「试卷的历史纪录要能删除，以免后期出卷太多
                    不好查询历史记录」。
                  */}
                  <button
                    type="button"
                    className="ex-history__del"
                    onClick={() => onDeleteAttempt(a)}
                    title="删除这条考试记录（不能恢复）"
                  >
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* ============================ 考试中 ============================ */

function TakingView({
  paper,
  title,
  limitSec,
  onSubmit,
  onCancel,
}: {
  paper: Question[];
  title: string;
  limitSec: number;
  onSubmit: (
    answers: ExamAnswer[],
    startedAt: string,
    usedSec: number,
    timedOut: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  /** questionId → 作答内容 */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [remain, setRemain] = useState(limitSec);
  const [busy, setBusy] = useState(false);

  /**
   * 上报「正在考试」（2026-11-13 傍晚）。
   *
   * 由 `TakingView` 上报是刻意的：这个组件**只在考试进行中挂载** ——
   * setup（选卷子）和 result（成绩页）都不会渲染它。
   * 所以「上报存在」天然就等于「正在考试」，比在 ExamPage 里
   * 判 `phase.kind === 'taking'` 少一处可能不同步的判断。
   *
   * 进度用已答题数：考试中途跳去看原文时，用户最想知道的就是答了多少。
   */
  usePageTask({ label: '模拟考试', detail: `${index + 1}/${paper.length} 题` });
  const startedAtRef = useRef(new Date().toISOString());
  const startedMsRef = useRef(Date.now());
  /** 防止超时自动交卷触发两次（setInterval 与用户点击可能撞上） */
  const submittedRef = useRef(false);

  const q = paper[index];
  const total = paper.length;

  const doSubmit = useCallback(
    async (timedOut: boolean) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setBusy(true);
      const usedSec = (Date.now() - startedMsRef.current) / 1000;
      const list: ExamAnswer[] = paper.map((qq) => {
        const response = answers[qq.id] ?? '';
        return {
          questionId: qq.id,
          response,
          correct: isCorrect(
            /* 复用 v2 卡片层的判分：与做题时同一套规则，不会两处不一致 */
            {
              id: qq.id,
              sourceId: '',
              kind: qq.kind === 'essay' ? 'short' : (qq.kind as never),
              prompt: qq.prompt,
              options: qq.options,
              answer: qq.answer,
              explanation: qq.explanation,
              anchors: qq.anchors,
              deckId: qq.deckId,
              createdAt: qq.createdAt,
            },
            response,
          ),
        };
      });
      await onSubmit(list, startedAtRef.current, usedSec, timedOut);
    },
    [paper, answers, onSubmit],
  );

  /* 倒计时 */
  useEffect(() => {
    if (limitSec <= 0) return;
    const id = setInterval(() => {
      const left = limitSec - Math.floor((Date.now() - startedMsRef.current) / 1000);
      setRemain(left);
      if (left <= 0) {
        void doSubmit(true);
      }
    }, 500);
    return () => clearInterval(id);
  }, [limitSec, doSubmit]);

  if (!q) return null;

  const answered = Object.values(answers).filter((v) => v.trim().length > 0).length;

  return (
    <>
      <div className="ex-bar">
        <span className="ex-bar__title">{title}</span>
        <span className="ex-bar__progress">
          已答 {answered} / {total}
        </span>
        {limitSec > 0 ? (
          <span className={`ex-bar__clock${remain <= 60 ? ' ex-bar__clock--urgent' : ''}`}>
            {fmtClock(remain)}
          </span>
        ) : (
          <span className="ex-bar__clock">不限时</span>
        )}
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={() => void doSubmit(false)}
          disabled={busy}
        >
          {busy ? '交卷中…' : '交卷'}
        </button>
      </div>

      <div className="ex-card">
        <div className="ex-card__head">
          <span className="ex-card__no">
            第 {index + 1} 题 / 共 {total} 题
          </span>
          <span className="ex-card__kind">{kindLabel(q.kind)}</span>
        </div>

        <p className="ex-card__prompt"><MathText text={q.prompt} /></p>

        {q.options.length > 0 ? (
          <div className="ex-choices">
            {q.options.map((o) => {
              const picked =
                q.kind === 'multiple'
                  ? (answers[q.id] ?? '').split(',').filter(Boolean).includes(o.key)
                  : answers[q.id] === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  className={`ex-choice${picked ? ' ex-choice--on' : ''}`}
                  onClick={() => {
                    setAnswers((prev) => {
                      if (q.kind === 'multiple') {
                        const cur = (prev[q.id] ?? '').split(',').filter(Boolean);
                        const next = cur.includes(o.key)
                          ? cur.filter((k) => k !== o.key)
                          : [...cur, o.key];
                        return { ...prev, [q.id]: next.sort().join(',') };
                      }
                      return { ...prev, [q.id]: o.key };
                    });
                  }}
                >
                  <span className="ex-choice__key">{o.key}</span>
                  <span><MathText text={o.text} /></span>
                </button>
              );
            })}
          </div>
        ) : (
          <input
            className="ex-input"
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
            placeholder="填写答案…"
          />
        )}

        <div className="ex-card__nav">
          <button
            type="button"
            className="btn-text"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
          >
            ← 上一题
          </button>
          <button
            type="button"
            className="btn-text"
            onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
            disabled={index >= total - 1}
          >
            下一题 →
          </button>
        </div>
      </div>

      {/* 题号导航：一眼看出哪些还没答 */}
      <div className="ex-nav">
        {paper.map((qq, i) => {
          const has = (answers[qq.id] ?? '').trim().length > 0;
          return (
            <button
              key={qq.id}
              type="button"
              className={`ex-nav__dot${i === index ? ' ex-nav__dot--cur' : ''}${
                has ? ' ex-nav__dot--done' : ''
              }`}
              onClick={() => setIndex(i)}
              title={`第 ${i + 1} 题${has ? '（已答）' : '（未答）'}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <p className="ex-hint ex-hint--center">
        考试中不显示对错 —— 那是交卷之后的事。
        <button type="button" className="btn-text" onClick={onCancel}>
          放弃这次考试
        </button>
      </p>
    </>
  );
}

/* ============================ 成绩 ============================ */

function ResultView({
  attempt,
  questions,
  onAgain,
  onAiGrade,
  onRegrade,
}: {
  attempt: ExamAttempt;
  questions: Question[];
  onAgain: () => void;
  /** 调 AI 评分（2026-11-17 方案 3）。不传 = 不显示评分面板（保持老行为） */
  onAiGrade?: (input: {
    prompt: string;
    answer: string;
    explanation: string;
    response: string;
  }) => Promise<import('@/core/ai/grade-short.ts').ShortGradeResult | null>;
  /** 把评分结论落库 */
  onRegrade?: (
    questionId: string,
    patch: {
      correct: boolean;
      gradedBy: 'ai' | 'self';
      aiGrade?: ExamAnswer['aiGrade'];
      aiComment?: string | null;
    },
  ) => Promise<void>;
}) {
  /*
   * 分数怎么算（2026-11-17 方案 3）。
   *
   * ⚠️ 不能再用 `correct / total` —— 有题「还没评」时那样算会**压低分数**，
   * 用户看到「60 分」以为答错一堆，实际是 4 道题还没评。
   *
   * 所以分母排除掉待评题：
   *   已评完 → 正常百分比
   *   全待评 → 不给分数，只说「还没评」
   *   部分待评 → 给出「已评部分的正确率」并明确标注基数
   */
  const pending = attempt.answers.filter((a) => a.correct === null).length;
  const gradedTotal = attempt.total - pending;
  const rate = gradedTotal > 0 ? attempt.correct / gradedTotal : 0;
  const qById = new Map(questions.map((q) => [q.id, q]));
  /** 有评分面板才显示逐题评分区 */
  const canGrade = Boolean(onAiGrade && onRegrade);

  return (
    <>
      <header className="ex-head">
        <h1 className="ex-title">成绩</h1>
        <p className="ex-lead">{attempt.title}</p>
      </header>

      <div className="ex-score">
        {gradedTotal > 0 ? (
          <>
            <span className="ex-score__num">{Math.round(rate * 100)}</span>
            <span className="ex-score__unit">分</span>
          </>
        ) : (
          <span className="ex-score__num ex-score__num--pending">待评</span>
        )}
        <span className="ex-score__detail">
          答对 {attempt.correct} / {gradedTotal} 题（已评） · 用时 {fmtClock(attempt.usedSec)}
          {attempt.timedOut ? ' · 超时自动交卷' : ''}
        </span>
      </div>

      {/*
        未评完的提示（方案 3 的关键）。
        不写这句，用户会拿「已评部分的分」当最终成绩 —— 那是在骗人。
      */}
      {pending > 0 ? (
        <p className="ex-pending">
          还有 <strong>{pending}</strong> 道题没评（计算题 / 问答题需要评分）。
          下面的逐题回看里可以让 AI 评，也可以自己判。
        </p>
      ) : null}

      <div className="ex-actions">
        <button type="button" className="btn-fill" onClick={onAgain}>
          再考一次
        </button>
      </div>

      <h2 className="ex-h2">逐题回看</h2>
      <ul className="ex-review">
        {attempt.answers.map((a, i) => {
          const q = qById.get(a.questionId);
          if (!q) return null;
          /*
           * 三态展示（2026-11-17）：
           *   true  → ✓
           *   false → ✕
           *   null  → ?（待评，不是 ✕ —— 判也没判过，不能说错）
           */
          const mark = a.correct === null ? '?' : a.correct ? '✓' : '✕';
          const cls =
            a.correct === null
              ? ' ex-review__item--pending'
              : a.correct
                ? ' ex-review__item--ok'
                : '';
          /** 只有自评题型才需要（且能）评分 */
          const needGrade = a.correct === null || a.gradedBy === 'ai' || a.gradedBy === 'self';

          return (
            <li key={a.questionId} className={`ex-review__item${cls}`}>
              <div className="ex-review__head">
                <span className="ex-review__no">{i + 1}</span>
                <span
                  className={`ex-review__mark${a.correct === true ? ' ex-review__mark--ok' : ''}${
                    a.correct === null ? ' ex-review__mark--pending' : ''
                  }`}
                >
                  {mark}
                </span>
                <span className="ex-review__kind">{kindLabel(q.kind)}</span>
                {a.gradedBy === 'ai' ? (
                  <span className="ex-review__src">AI 评</span>
                ) : a.gradedBy === 'self' ? (
                  <span className="ex-review__src">自评</span>
                ) : null}
              </div>
              <p className="ex-review__prompt"><MathText text={q.prompt} /></p>
              <p className="ex-review__your">
                你的答案：{a.response.trim() || '（未作答）'}
              </p>
              {/*
                正确答案：待评时不提前show —— 先看了答案再让 AI 评分，
                用户会怀疑 AI 是照着答案说的（虽然事实不是）。
                评完或自评后展开。
              */}
              {a.correct !== true && (a.correct !== null || !canGrade) ? (
                <p className="ex-review__right">正确答案：<MathText text={q.answer} /></p>
              ) : null}
              {q.explanation ? (
                <p className="ex-review__explain"><MathText text={q.explanation} /></p>
              ) : null}

              {/* ---- 评分面板（方案 3） ---- */}
              {canGrade && needGrade ? (
                <ExamGradePanel
                  attempt={attempt}
                  question={q}
                  answer={a}
                  onAiGrade={onAiGrade!}
                  onGraded={async (patch) => {
                    await onRegrade!(a.questionId, patch);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ============================ 工具 ============================ */

function kindLabel(k: string): string {
  switch (k) {
    case 'single':
      return '单选';
    case 'multiple':
      return '多选';
    case 'blank':
      return '填空';
    default:
      return k;
  }
}

/** 秒 → mm:ss / h:mm:ss */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
