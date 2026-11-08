import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Card } from '@/v2/core/cards.ts';
import { isCorrect, CARD_KIND_LABEL } from '@/v2/core/cards.ts';
import type { ReviewGrade } from '@/v2/core/srs.ts';
import { mastery, todayLocal } from '@/v2/core/srs.ts';
import { previewDays } from '@/v2/core/ebbinghaus.ts';
import { explainInterval } from '@/v2/core/interval-reason.ts';
import type { ReviewState } from '@/v2/core/srs.ts';
import type { ReviewService, ReviewRecord } from '@/v2/core/review-service.ts';
import type { GradingRules } from '@/v2/core/grading.ts';
import { judgeByTiming, DEFAULT_GRADING_RULES } from '@/v2/core/grading.ts';
import { useCardTimer, formatElapsed } from './use-card-timer.ts';
import type { NoteService } from '@/core/notes.ts';
import { NoteBox } from './NoteBox.tsx';
import { pickOption } from './option-pick.ts';
import { MathText } from './MathText.tsx';

/**
 * 复习页：题卡 + 选项行 + 0-5 评分档。
 *
 * ## 按 StudyHub 的 ui/review/question.css 还原
 *
 * 关键规格（源码实测值）：
 *  - 卡片宽 min(700px, 100% - 48px)，上下 32/56px 留白
 *  - 进度条 2px 高，朱砂色
 *  - 选项**不是按钮盒**：每项是 border-top 1px 分隔行，
 *    padding 16px 10px，字号 17px，左侧 28px 圆形字母标
 *  - 答题后每项的判定与解释从 0 高度展开（0.46s）
 *
 * ## 为什么选项不用按钮盒
 *
 * 按钮盒会让四个选项看起来像四个「动作」；
 * 而选择题的选项是**卡上的一道道横线**，
 * 状态只体现在左侧的字母圆标上（选中/正确/错误）。
 * 这个差别决定了它读起来像「试卷」还是像「设置面板」。
 */

/**
 * 评分档。
 *
 * ## 从 6 档改成 4 档（2026-11-07 用户反馈）
 *
 * 原来是 0–5 六档，但它们只能映射到 4 个调度档：
 * ```
 * 0 完全忘记 → again
 * 1 记得一点 → again   ← 与 0 结果相同
 * 2 有印象   → again   ← 与 0、1 结果相同
 * 3 勉强答对 → hard
 * 4 熟练     → good
 * 5 轻松掌握 → easy
 * ```
 * 用户原话：「复习时间的区分度不大，只有 5 分才与其他分数做出了区分」。
 * 根因就在这里 —— **三个按钮点了结果一模一样**，用户当然感觉不到区别。
 *
 * 现在每一档都有**各自不同的间隔**，而且按钮上直接写出来，
 * 用户点之前就知道下次什么时候再见到这道题。
 * 这也是 Anki / 不背单词 等主流软件的做法（4 档，不是 6 档）。
 */
const GRADES: { score: number; label: string; hint: string; grade: ReviewGrade }[] = [
  { score: 0, label: '忘记', hint: '完全想不起来', grade: 'again' },
  { score: 1, label: '勉强', hint: '想起来了，但很吃力', grade: 'hard' },
  { score: 2, label: '一般', hint: '正常回忆出来', grade: 'good' },
  { score: 3, label: '熟练', hint: '毫不费力', grade: 'easy' },
];

/**
 * SM-2 四级评分的中文名。
 *
 * 计时判定用的是四级（again/hard/good/easy），而界面上的手动档是 0–5 六档 ——
 * 两者不是同一套刻度。这里给四级单独起名，避免把
 * 「good」直接叫成「熟练」（那是第 4 档的名字，会让人以为是同一件事）。
 */
const GRADE_TO_LABEL: Record<ReviewGrade, string> = {
  again: '需要重来',
  hard: '想了一会儿',
  good: '正常速度',
  easy: '一眼就会',
};

/**
 * 按当前卡片状态算出每个评分档**实际**会给出的间隔。
 *
 * ⚠️ 这里踩过一个坑：原先把间隔写死在表里（熟练=20天），
 * 但 SM-2 首次复习 good 只给 1 天 —— 用户点了「熟练」，
 * 界面承诺 20 天，实际第二天又来，会觉得软件在骗他。
 *
 * 现在用 previewDays() 真实算一遍，显示的是**这一次点了会发生什么**。
 * 数字与算法永远一致，改算法不用改界面。
 */
function previewIntervals(state: ReviewState | null, today: string): number[] {
  return GRADES.map((g) => previewDays(state, g.grade, today));
}

/**
 * 间隔的友好写法。
 *
 * 0 天要说「今天内」而不是「今天」：
 * 后者读起来像「今天已经做过了」，而实际含义是「今天之内还要再考一次」。
 */
function fmtInterval(days: number): string {
  if (days <= 0) return '今天内';
  if (days === 1) return '1 天';
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return '1 年';
}

/**
 * 「为什么是这个间隔？」可展开块（2026-11-08）。
 *
 * 默认收起：读题时不该被一段解释占地方。
 * 但按钮上明明写着「1 天」，用户想追问时得点得到。
 *
 * 用原生 <details>：折叠行为、键盘可达性、无障碍语义全都自带，
 * 比自己维护 open 状态少一半代码，也不会在 React 重渲染时丢状态。
 */
function IntervalWhy({
  state,
  grade,
  days,
}: {
  state: ReviewState | null;
  grade: ReviewGrade;
  days: number;
}) {
  const reason = explainInterval(state, grade, days);
  return (
    <details className="interval-why">
      <summary className="interval-why__summary">为什么是 {reason.headline}？</summary>
      <ul className="interval-why__list">
        {reason.details.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
      <p className="interval-why__note">
        间隔按遗忘曲线自动排；这一档是「良好」的情况，你选别的档会不一样。
      </p>
    </details>
  );
}

/**
 * 这批选项里有没有任何一条带「为什么」（2026-11-08）。
 *
 * 老题库的选项只有 key/text，整块逐选项解析就不显示 ——
 * 显示一排只有选项文字、没有解释的列表，比不显示更让人困惑。
 */
function hasOptionWhys(options: readonly { why?: string }[]): boolean {
  return options.some((o) => !!o.why?.trim());
}

/**
 * 这个 key 是不是正确答案。
 *
 * 单选/判断的 answer 是 `'A'`；多选是 `'A,C'`（逗号分隔）。
 * 这里按逗号切再比，与 service 里判分的口径一致。
 */
function isAnswerKey(card: { answer: string }, key: string): boolean {
  return card.answer
    .split(',')
    .map((k) => k.trim())
    .includes(key);
}

export interface ReviewPageProps {
  service: ReviewService;
  /** 本轮要复习的卡片 */
  queue: Card[];
  /**
   * 今天到期的**真实总数**（≥ queue.length）。
   *
   * 复习队列一批最多 30 张，但到期数可能远大于它。不告诉用户的话，
   * 做完 30 张就显示「完成」，而实际还有 50 张 —— 那是在骗人。
   */
  dueTotal?: number;
  /** 练习开始时该组的掌握度（用于显示 +N% 胶囊） */
  groupMasteryBefore?: number;
  /**
   * 计时评分规则。
   *
   * 由外层从设置里读出来传进来 —— 这一页不直接碰存储，
   * 保持「界面只渲染、规则由设置决定」的分工。
   * 不传时用默认规则（标准宽容度），组件单独使用时也能正常工作。
   */
  gradingRules?: GradingRules;
  /**
   * 这一轮是哪种模式。
   *
   * 三种模式的「做完之后」和「还剩多少」语义完全不同：
   *  - `due`    今日该复习的：受到期日约束，做完了就是「今天清空了」
   *  - `free`   自由练习：不受到期限制，想练多久练多久，没有「还剩」这个概念
   *  - `wrong`  错题巩固：只做最近答错的，做对就移出错题集
   *
   * 不传默认 `due`（保持旧行为，单独使用这个组件时不会崩）。
   */
  mode?: 'due' | 'free' | 'wrong';
  /** 模式的显示名，用于顶部与小结（如「自由练习 · 信号与系统」） */
  modeLabel?: string;
  /**
   * 笔记服务。
   *
   * 可选：不传就不显示笔记区（组件单独跑测试时不需要它）。
   * 传了才在做题页出现「记一笔」—— 那是笔记的主要写作入口之一。
   */
  notes?: NoteService;
  onFinish: () => void;
  onExit: () => void;
}

export function ReviewPage({
  service,
  queue,
  dueTotal,
  groupMasteryBefore,
  gradingRules,
  mode = 'due',
  modeLabel,
  notes,
  onFinish,
  onExit,
}: ReviewPageProps) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [textInput, setTextInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState<{ correct: boolean | null } | null>(null);
  const [done, setDone] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  /**
   * 本轮**已揭晓答案**的题数（2026-11-08）。
   *
   * 为什么不复用 `done`：`done` 的语义是「这题彻底结束了」，
   * 它在 submitGrade（用户点评分档之后）才加。而正确率需要
   * **提交答案的那一刻就能看到** —— 那时用户还没点评分档。
   *
   * 两个计数各司其职：
   *  - `answered`：已交卷数，用来算本轮正确率（含刚提交那题）
   *  - `done`    ：已走完流程数，用于其它逻辑
   *
   * 早先我直接用 `done` 当分母，结果答对 1 题时 done 还是 0，
   * 正确率算不出来（截图里只有「做对 1」没有百分比）。
   */
  const [answered, setAnswered] = useState(0);
  const [masteryNow, setMasteryNow] = useState<number | null>(null);
  const [record, setRecord] = useState<ReviewRecord | null>(null);
  /**
   * 提交那一刻冻结的耗时。
   *
   * 为什么不在渲染评分档时现算：评分档要在提交后显示「你用了多久」，
   * 而那时计时器还在跑 —— 现算会得到一个不断增长的数，用户盯着它看会觉得怪。
   * 冻结一次，之后界面显示的都是这个值。
   */
  const [frozenElapsedMs, setFrozenElapsedMs] = useState<number | null>(null);

  const card = queue[index];
  const total = queue.length;

  /**
   * 计时器。
   *
   * 用 card.id 作重置键：换卡就重新起表。
   * 起表本身会等两帧（见 use-card-timer），确保用户真的看到题了。
   */
  const timer = useCardTimer(card?.id);

  const rules = gradingRules ?? DEFAULT_GRADING_RULES;

  // 换卡时重置所有作答状态
  useEffect(() => {
    setPicked([]);
    setTextInput('');
    setRevealed(false);
    setGraded(null);
    setFrozenElapsedMs(null);
  }, [index]);

  // 读当前卡片的进度（用于显示掌握度胶囊）
  useEffect(() => {
    let cancelled = false;
    if (!card) return;
    void (async () => {
      const r = await service.getRecord(card.id);
      if (cancelled) return;
      setRecord(r);
      setMasteryNow(r ? mastery(r.state) : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [service, card]);

  /** 提交答案（客观题） */
  const submitChoice = useCallback(() => {
    if (!card) return;
    let given = '';
    if (card.kind === 'single') given = picked[0] ?? '';
    else if (card.kind === 'truefalse') given = picked[0] ?? '';
    else if (card.kind === 'multiple') given = picked.join(',');
    else if (card.kind === 'blank') given = textInput;
    else if (card.kind === 'short') given = textInput;

    const ok = isCorrect(card, given);
    /*
     * 冻结耗时：**在提交这一刻**取值。
     *
     * 为什么要冻结而不是等用户点评分档时再算：
     * 提交之后用户会先看答案与解析，看多久和「他多快答出来」无关。
     * 若不冻结，看解析花 30 秒会被算进作答时间，
     * 一道明明 5 秒就答对的题会被判成「想了很久」。
     */
    setFrozenElapsedMs(timer.elapsedMs());
    setGraded({ correct: ok });
    setRevealed(true);
    /*
     * 交卷即计数（2026-11-08）：答对答错都在这里 +1。
     * 这样顶部正确率在**提交的那一刻**就准确，不用等用户点评分档。
     */
    setAnswered((n) => n + 1);
    if (ok) {
      setCorrectCount((n) => n + 1);
      return;
    }

    /*
     * ---- 答错：直接记入错题，不弹判定面板 ----
     *
     * 用户明确要求：「这个提醒不需要，答错了直接记入错题就行」。
     * 原来答错后要展示一整块计时判定（需要重来 / 用时 X 秒 /
     * 采用这个判定 / 重新计时）—— 那对答错的场景没有信息量：
     * 判定结果必然是 again，用户没什么可选的，只是在多看一步。
     *
     * 现在：答错当场按 again 记一次评级（这一步是必须的，
     * 错题集正是从 reviewLogs 里 grade === 'again' 派生的，
     * 不记的话「答错进错题」这件事根本不会发生），
     * 然后直接把答案与解析展示出来，让用户看懂为什么错；
     * 评分档不再出现，改为一个「下一题」按钮。
     */
    void (async () => {
      try {
        await service.review(card.id, card.kind === 'point' ? 'point' : 'question', 'again');
        const r = await service.getRecord(card.id);
        setRecord(r);
        setMasteryNow(r ? mastery(r.state) : 0);
      } catch {
        /*
         * 记录失败不阻断流程：用户已经把题做错了，
         * 不该因为写库出错而卡在这一题上看不到答案。
         * 但也不假装成功 —— 错题集里会少这一条，界面上没有额外提示，
         * 因为这种情况只在存储异常时发生。
         */
      }
    })();
  }, [card, picked, textInput, timer, service]);

  /** 提交评分（自评档，用于知识点或答完后确认） */
  const submitGrade = useCallback(
    async (g: ReviewGrade) => {
      if (!card) return;
      await service.review(card.id, card.kind === 'point' ? 'point' : 'question', g);
      const r = await service.getRecord(card.id);
      setRecord(r);
      setMasteryNow(r ? mastery(r.state) : 0);
      setDone((n) => n + 1);
      if (index + 1 >= total) {
        onFinish();
      } else {
        setIndex((i) => i + 1);
      }
    },
    [card, service, index, total, onFinish],
  );

  /**
   * 计时评分结论。
   *
   * 冻结之后就不再变（frozenElapsedMs 一旦有值就锁住），
   * 所以在评分档显示期间它是个稳定值 —— 不会因为计时器继续跑
   * 而导致「判定结果在你眼前跳档」。
   *
   * 知识点没有「提交」这一步：点「看完了」时也会冻结（见底部按钮），
   * 因此正常流程下这个回退分支只在极端情况（例如外部直接改 queue）才走到。
   */
  const { elapsedMs: readElapsed } = timer;
  const verdict = useMemo(() => {
    if (!card) return null;
    const elapsed = frozenElapsedMs ?? readElapsed();
    return judgeByTiming(card, graded?.correct ?? null, elapsed, rules);
  }, [card, graded, frozenElapsedMs, rules, readElapsed, timer.tick]);

  /** 按计时结果自动评分并前进 */
  const autoGrade = useCallback(async () => {
    if (!card || !verdict) return;
    await submitGrade(verdict.grade);
  }, [card, verdict, submitGrade]);

  /**
   * 本题是否「答错了」。
   *
   * `graded.correct === false` 只在客观题判错时成立；
   * 知识点（correct 恒为 null）与答对都不算。
   */
  const answeredWrong = graded?.correct === false;

  /**
   * 答错之后前进。
   *
   * 与 submitGrade 的区别：**不再写一次复习记录**。
   * 答错时 submitChoice 里已经按 again 记过一次了，
   * 这里再记会变成「错一次记两条」，错题次数会虚高一倍。
   * 只做「本地计数 + 翻页」。
   */
  const nextAfterWrong = useCallback(async () => {
    setDone((n) => n + 1);
    if (index + 1 >= total) {
      onFinish();
    } else {
      setIndex((i) => i + 1);
    }
  }, [index, total, onFinish]);

  if (!card) {
    return (
      <div className="review-empty">
        <p>这一轮没有需要做的题。</p>
        <button type="button" className="btn-ghost" onClick={onExit}>
          返回
        </button>
      </div>
    );
  }

  const optionState = (key: string): 'idle' | 'picked' | 'correct' | 'wrong' => {
    const isAnswerKey =
      card.kind === 'multiple'
        ? card.answer.split(/[,，\s]+/).map((s) => s.trim().toUpperCase()).includes(key.toUpperCase())
        : card.answer.trim().toUpperCase() === key.toUpperCase();

    if (!revealed) return picked.includes(key) ? 'picked' : 'idle';
    if (isAnswerKey) return 'correct';
    if (picked.includes(key)) return 'wrong';
    return 'idle';
  };

  // 每个评分档实际会给出的间隔（随卡片当前状态变化）
  const intervals = previewIntervals(record?.state ?? null, todayLocal());

  const canSubmit =
    card.kind === 'single' || card.kind === 'truefalse'
      ? picked.length === 1
      : card.kind === 'multiple'
        ? picked.length > 0
        : card.kind === 'blank' || card.kind === 'short'
          ? textInput.trim().length > 0
          : true;

  return (
    <div className="review-wrap">
      {/* 顶部：进度 + 掌握度胶囊 */}
      <div className="review-head">
        <button type="button" className="btn-text" onClick={onExit}>
          ← 退出做题
        </button>

        {/*
          模式标签：让用户随时知道自己在哪种练习里。
          三种模式的行为差别很大（自由练习不受到期限制、错题巩固会改变错题集），
          不标出来用户会困惑「为什么这题今天不该复习却出现了」。
        */}
        {modeLabel ? <span className="review-mode">{modeLabel}</span> : null}

        <span className="review-progress-text">
          {index + 1} / {total}
          {/*
            只有「今日到期」模式才有「今日到期共 N 张」这个概念。
            自由练习与错题巩固不受到期日约束，写这句话会误导 ——
            用户会以为自己在漏做今天该做的。
          */}
          {mode === 'due' && typeof dueTotal === 'number' && dueTotal > queue.length ? (
            <span className="review-progress-extra" title="今天到期的总数">
              （今日到期 {dueTotal} 张）
            </span>
          ) : null}
        </span>

        {/*
          本轮战绩（2026-11-08 加，用户要求）。
          
          原来顶部只有「3 / 10」——告诉用户做到第几题，
          但**不告诉他做得怎么样**。做完 8 道对了 2 道和对了 8 道，
          顶部长得一模一样，用户得自己心里数。
          
          现在补「做对 N 题」与正确率。两个数都只统计**本轮**（不是历史），
          所以文字写「本轮」而不是「正确率」——后者容易被理解成
          「我所有时候的正确率」。统计页那个才是历史口径。
          
          分母用 done（已作答数）而不是 total（总题数）：
          做到第 3 题时正确率应该是 2/3，而不是 2/10 ——
          后者会让用户以为自己很差。
        */}
        <span
          className="review-score"
          title={`本轮已作答 ${answered} 题，答对 ${correctCount} 题`}
        >
          做对 <strong>{correctCount}</strong>
          {answered > 0 ? (
            <span className="review-score__rate">
              · 本轮正确率 {Math.round((correctCount / answered) * 100)}%
            </span>
          ) : null}
        </span>

        {masteryNow !== null ? (
          <span
            className={`live-mastery${
              groupMasteryBefore !== undefined && masteryNow > groupMasteryBefore
                ? ' live-mastery--up'
                : ''
            }`}
          >
            本组掌握度 {Math.round(masteryNow * 100)}%
            {groupMasteryBefore !== undefined && masteryNow > groupMasteryBefore ? (
              <span className="live-mastery__delta">
                +{Math.round((masteryNow - groupMasteryBefore) * 100)}%
              </span>
            ) : null}
            {/*
              熟练度怎么算的，写出来（2026-11-08 用户要求：
              「有判定逻辑就要写出来，否则隐藏」）。

              选「写出来」而不是「隐藏」：这个数实际影响学习安排
              （哪些题算已掌握、能不能跳过），藏起来就成了黑箱。
              用 <details>，收起时只占「怎么算的」三个字。
            */}
            <details className="mastery-explain">
              <summary className="mastery-explain__summary">怎么算的</summary>
              <div className="mastery-explain__body">
                <p>
                  掌握度 = <strong>间隔分 × 55%</strong> + <strong>正确率 × 45%</strong>
                  ＋ 连对加成（最多 15%）
                </p>
                <ul>
                  <li>
                    <strong>间隔分</strong>：上次间隔 1 天记 0、365 天记 1，中间按对数增长
                    —— 隔得越久说明越记得住
                  </li>
                  <li>
                    <strong>正确率</strong>：1 −（答错次数 ÷ 总复习次数）
                  </li>
                  <li>
                    <strong>连对加成</strong>：每连续答对一次 +3%，最多 +15%
                  </li>
                </ul>
                <p className="mastery-explain__note">
                  标「已掌握」还要三条同时满足：间隔 ≥ 21 天、连续答对 ≥ 2 次、
                  掌握度 ≥ 85% —— 这样「蒙对一次」不会被当成学会了。
                </p>
                <p className="mastery-explain__note">
                  刚学的题掌握度低是正常的：间隔短、还没有连对记录。
                </p>
              </div>
            </details>
          </span>
        ) : null}
      </div>

      {/* 题卡 */}
      <article className="question-card paper" key={card.id}>
        <div className="question-meta">
          <span>
            {index + 1}/{total}
            <span className="question-kind">{CARD_KIND_LABEL[card.kind]}</span>
          </span>
          {record ? (
            <span className="question-meta__dim">
              已复习 {record.state.reviewCount} 次
            </span>
          ) : (
            <span className="question-meta__dim">首次学习</span>
          )}
        </div>

        {/*
          计时器单独一行。
          为什么不做成右上角的小徽章：它每 100 毫秒变一次，
          放在元信息行里会和「首次学习」这种静态文字抢位、
          并且窄屏会被挤到换行 —— 单独一行把它变成一条状态栏，位置稳定。

          右侧**不显示「这类题通常要多少秒」**：那是内部归一化用的估值，
          报给用户就成了「建议时长」，而每道题、每个人的差异都很大，
          摆一个数字出来只会误导（已确认：这个功能不要）。
        */}
        <div className="q-timer-bar">
          <span
            className={`q-timer${timer.paused ? ' q-timer--paused' : ''}${
              revealed ? ' q-timer--frozen' : ''
            }`}
            title={
              timer.userPaused
                ? '已手动暂停：点「继续计时」恢复'
                : timer.paused
                  ? '已暂停计时：你切到了别的窗口，这段时间不算'
                  : '用时会决定下次复习的间隔'
            }
          >
            <span className="q-timer__dot" aria-hidden="true" />
            <span className="q-timer__value">{formatElapsed(frozenElapsedMs ?? timer.elapsedMs())}</span>
            <span className="q-timer__label">
              {timer.userPaused
                ? '已暂停'
                : timer.paused
                  ? '已暂停（切走了）'
                  : revealed
                    ? '本题用时'
                    : '计时中'}
            </span>
          </span>

          {/*
            暂停 / 继续。

            为什么必须有这个按钮：原来只有「切到别的窗口才自动暂停」，
            而那个状态完全不可见 —— 停下来想题时计时照走（会被判「想久了」），
            切出去又回来却不知道暂停过（用时偏短）。两种情况都让数字不可信。

            只在还没揭晓答案时显示：揭晓后耗时已冻结，再暂停没有意义。
          */}
          {!revealed ? (
            <button
              type="button"
              className={`q-timer__toggle${timer.userPaused ? ' q-timer__toggle--on' : ''}`}
              onClick={timer.togglePause}
              aria-pressed={timer.userPaused}
            >
              {timer.userPaused ? '继续计时' : '暂停计时'}
            </button>
          ) : null}
        </div>

        {/* 2px 朱砂进度条 */}
        <div className="card-progress" aria-hidden="true">
          <div
            className="card-progress__fill"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>

        <div className="question-body">
          <h2 className="question-prompt"><MathText text={card.prompt} /></h2>

          {/* ---- 选项行 ---- */}
          {/*
            判断题与选择题共用选项渲染：都是「点一行选一个/多个」。
            区别只在数据上（判断题只有对/错两项、只能选一个），
            所以这里不必为它写一套新 UI。
          */}
          {card.kind === 'single' || card.kind === 'multiple' || card.kind === 'truefalse' ? (
            <div className="options">
              {card.options.map((o) => {
                const st = optionState(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={`option option--${st}`}
                    onClick={() => {
                      if (revealed) return;
                      /*
                       * 选择规则统一在 `option-pick.ts` 里，并有单测盯着。
                       *
                       * 2026-11-08 修：原来这里只判 `card.kind === 'single'`，
                       * 判断题掉进 else 分支走**多选**的 toggle ——
                       * 用户可以同时选中「对」和「错」。而 canSubmit 要求
                       * `picked.length === 1`，于是提交按钮变灰，
                       * 用户卡死在那一题、没有任何提示。
                       *
                       * 这个 bug 活了很久没被发现，因为前两轮一直没拿到
                       * 判断题的实际截图（真实模型没出过判断题）。
                       */
                      setPicked((p) => pickOption(card.kind, p, o.key));
                    }}
                    disabled={revealed}
                  >
                    <span className="option__mark">{o.key}</span>
                    <span className="option__text">
                      <MathText text={o.text} />
                      {revealed && st === 'correct' ? (
                        <span className="option__tag option__tag--ok">正确答案</span>
                      ) : null}
                      {revealed && st === 'wrong' ? (
                        <span className="option__tag option__tag--bad">你的选择</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* ---- 填空 / 简答 ---- */}
          {card.kind === 'blank' || card.kind === 'short' ? (
            <div className="answer-input">
              {card.kind === 'short' ? (
                <textarea
                  className="answer-area"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="写下你的答案…"
                  disabled={revealed}
                  rows={3}
                />
              ) : (
                <input
                  className="answer-field"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="填入答案…"
                  disabled={revealed}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit && !revealed) submitChoice();
                  }}
                />
              )}
            </div>
          ) : null}

          {/* ---- 知识点：只读 ---- */}
          {card.kind === 'point' ? (
            <div className="point-body"><MathText text={card.explanation} /></div>
          ) : null}

          {/* ---- 揭晓：答案与解析 ---- */}
          {revealed ? (
            <div className="reveal">
              {card.kind !== 'point' ? (
                <div className={`reveal__verdict reveal__verdict--${graded?.correct ? 'ok' : 'bad'}`}>
                  {graded?.correct ? '✓ 答对了' : '✕ 答错了'}
                  {card.kind !== 'single' && card.kind !== 'multiple' ? (
                    <span className="reveal__answer">
                      参考答案：<MathText text={card.answer} />
                    </span>
                  ) : null}
                </div>
              ) : null}

              {/*
                逐选项解析（2026-11-08 新增）。
                只有「有选项 + 该选项带 why」时才显示 —— 老题库没有 why 字段，
                那段就整块不出现，不编造理由。

                为什么值得单独一块：用户答错时最想知道的是
                **我选的那个为什么错**，那是他脑子里的错误认知。
                只给「正确答案是 C」并不能改掉它。
              */}
              {hasOptionWhys(card.options) ? (
                <ul className="reveal__options">
                  {card.options.map((o) => {
                    const isAnswer = isAnswerKey(card, o.key);
                    const isPicked = picked.includes(o.key);
                    const tone = isAnswer ? 'correct' : isPicked ? 'wrong' : 'plain';
                    return (
                      <li key={o.key} className={`reveal__option reveal__option--${tone}`}>
                        <div className="reveal__option-head">
                          <span className="reveal__option-key">{o.key}</span>
                          <span className="reveal__option-text">
                            <MathText text={o.text} />
                          </span>
                          {isAnswer ? (
                            <span className="reveal__option-tag reveal__option-tag--ok">
                              正确答案
                            </span>
                          ) : isPicked ? (
                            <span className="reveal__option-tag reveal__option-tag--bad">
                              你的选择
                            </span>
                          ) : null}
                        </div>
                        {o.why ? (
                          <p className="reveal__option-why">
                            <MathText text={o.why} />
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {card.explanation ? (
                <div className="reveal__explain"><MathText text={card.explanation} /></div>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>

      {/*
        记一笔：挂在当前这道题上。
        放在卡片与底部按钮之间 —— 读完题、看完答案之后自然会想到要记点什么。
        不传 notes 时不渲染（组件单独跑测试不需要它）。
      */}
      {notes ? <NoteBox notes={notes} cardId={card.id} label="给这道题记一笔" /> : null}

      {/* ---- 底部：作答按钮 或 评分档 ---- */}
      <div className="review-foot">
        {!revealed ? (
          <button
            type="button"
            className="btn-fill"
            onClick={() => {
              /*
               * 知识点没有「提交答案」这一步，但同样要冻结耗时 ——
               * 否则看解析的时间会被算进阅读时间（见 submitChoice 的说明）。
               */
              if (card.kind === 'point') setFrozenElapsedMs(timer.elapsedMs());
              else submitChoice();
              if (card.kind === 'point') setRevealed(true);
            }}
            disabled={!canSubmit}
          >
            {card.kind === 'point' ? '看完了' : '提交答案'}
            <span className="btn-fill__arrow" aria-hidden="true">
              →
            </span>
          </button>
        ) : answeredWrong ? (
          /*
           * ---- 答错：不展示评分面板，只给一个「下一题」 ----
           *
           * 用户明确要求：「答错了直接记入错题就行」。
           *
           * 答错时判定结果必然是 again，评分面板没有可选项 ——
           * 留着一整块「需要重来 / 采用这个判定 / 重新计时」
           * 只是让用户多点一次，而且那句「答错不计时间」的说明
           * 属于解释系统的内部逻辑，用户不需要。
           *
           * 答案与解析在卡片里（.reveal），已经能看到为什么错。
           * 这里只负责往前走。
           */
          <div className="wrong-next">
            <button type="button" className="btn-fill" onClick={() => void nextAfterWrong()}>
              下一题
              <span className="btn-fill__arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        ) : (
          <div className="grades">
            {/*
              计时结论：告诉用户「系统怎么判的、为什么」。
              没有这块的话，用户看到评分档完全不知道自己该点哪个，
              而自动评分又会在他没意识的情况下决定下次复习间隔。
            */}
            {verdict ? (
              <div className={`timing-verdict timing-verdict--${verdict.grade}`}>
                <div className="timing-verdict__head">
                  <span className="timing-verdict__badge">
                    {GRADE_TO_LABEL[verdict.grade]}
                  </span>
                  {/*
                    只显示「你用了多久」。不显示「这类题约需多少」——
                    那是内部归一化用的估值，对外就是一个不可靠的建议时长。
                  */}
                  <span className="timing-verdict__time">
                    用时 {formatElapsed(verdict.elapsedMs)}
                  </span>
                </div>
                <p className="timing-verdict__reason">{verdict.reason}</p>
                {verdict.clamped ? (
                  <p className="timing-verdict__note">
                    这段时间里你可能离开过，超过上限的部分没有计入评分。
                  </p>
                ) : null}
                <div className="timing-verdict__actions">
                  <button type="button" className="btn-fill btn-fill--sm" onClick={() => void autoGrade()}>
                    采用这个判定（{GRADE_TO_LABEL[verdict.grade]}）
                  </button>
                  {/*
                    「重新计时」在 2026-11-08 被移除。
                    用户反馈「这个功能没用」，核实后同意：
                    题目已经答完、判定已经算出来了，重置计时器不会改变任何结果 ——
                    既不会撤回这次作答，也不会让它重新参与评分。
                    它唯一的效果是把「用时 1.2 秒」清零，然后用户还是得点
                    「采用这个判定」或某个评分档往前走。那是个纯装饰的按钮。
                    删掉比留着一个点了没反应的开关好（「不做假开关」）。
                  */}
                </div>
              </div>
            ) : null}

            <div className="grades__head">
              <span className="grades__title">或者自己评</span>
              <span className="grades__hint">
                每一档给出的间隔都不同 —— 按钮上写的就是点完之后下次什么时候再见
              </span>
            </div>
            <div className="grades__row">
              {GRADES.map((g, i) => {
                const days = intervals[i] ?? 1;
                return (
                  <button
                    key={g.score}
                    type="button"
                    className={`grade grade--${g.score}`}
                    onClick={() => void submitGrade(g.grade)}
                    title={`${g.label}：${g.hint} → ${fmtInterval(days)}后复习`}
                  >
                    <span className="grade__label">{g.label}</span>
                    <span className="grade__days">{fmtInterval(days)}</span>
                    <span className="grade__hint">{g.hint}</span>
                  </button>
                );
              })}
            </div>
            {/*
              这里原来还有一个「按作答情况自动评分」按钮。
              现在计时判定已经在上方以「采用这个判定（正常速度）」的形式给出，
              再放一个功能相同的按钮就是两个入口做同一件事 ——
              上一轮刚因为「两个同名下拉框」踩过这个坑，不重犯。
            */}

            {/*
              「为什么是这个间隔？」（2026-11-08）。
              
              放在评分按钮下方、可展开。用户看到按钮上写着「1 天」时
              最想知道的就是凭什么 —— 原来界面答不上来，那会让他
              觉得排期是随便给的。
              
              解释的是**当前这张卡如果按「良好」走**会怎样（最常见的选择），
              因为评分还没发生，不能假装知道用户会选哪档。
            */}
            {card ? (
              <IntervalWhy
                state={record?.state ?? null}
                grade="good"
                days={intervals[2] ?? 1}
              />
            ) : null}
          </div>
        )}

        {revealed ? (
          <button type="button" className="btn-text" onClick={onFinish}>
            结束这一轮
          </button>
        ) : null}
      </div>

      {/* 本轮小结 */}
      {done > 0 ? (
        <div className="review-stats">
          本轮已评 {done} 张 · 答对 {correctCount} 张
          {/*
           * 如实交代「这一批之外还有多少」。没有这句，用户做完 30 张
           * 会以为今天清空了，而实际可能还剩几十张。
           *
           * 只在「今日到期」模式说：自由练习与错题巩固本来就不受
           * 到期日约束，套用这句话会让用户以为自己在漏做。
           */}
          {mode === 'due' && typeof dueTotal === 'number' && dueTotal > queue.length
            ? ` · 今天到期共 ${dueTotal} 张，还剩 ${dueTotal - queue.length} 张没做`
            : ''}
          {mode === 'free' ? ' · 自由练习不影响到期安排' : ''}
          {mode === 'wrong' ? ' · 答对的题会移出错题集' : ''}
        </div>
      ) : null}
    </div>
  );
}

/** 供外部（测试/调试）复用 */
export { GRADES };
export type { ReviewGrade };
