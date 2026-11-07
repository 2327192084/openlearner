/**
 * 计时评分标准（默认值 + 用户自定义）。
 *
 * ## 这里解决什么问题
 *
 * 原来的 `inferGrade(card, correct, elapsedMs)` 把四个秒数写死：
 * 8 秒以内算「很熟」、20 秒以内算「正常」、超过算「想了很久」。
 * 三个毛病：
 *
 *  1. **阈值写死**，用户改不了 —— 而每个人的阅读速度差两三倍很正常。
 *  2. **只按题型分两类**，不看题目长短。一道 5 个字的填空和一道
 *     200 字的简答用同一套秒数，短题永远「很熟」，长题永远「想很久」。
 *  3. 答错直接 `again` 是对的，但答对侧只有三档，没有「明显太快、
 *     可能是蒙的」这一档 —— 而蒙对恰恰是最需要被识别的情况。
 *
 * ## 为什么用「倍率」而不是「绝对秒数」
 *
 * 绝对秒数对长短题不公平：同样花 12 秒，30 字的选择题算慢，
 * 而 200 字的简答算快。所以先把「这道题正常要花多久」按
 * 题型与题干长度估出来（基准时长），再用
 * `实际耗时 / 基准时长 = 倍率` 去判。
 *
 * 倍率是无量纲的，换题型、换题目长度都能比。
 *
 * ## 为什么不做成「让用户填 4 个秒数」
 *
 * 那会和「按题目长度归一」直接冲突：用户填的秒数对某一道题合适，
 * 对另一道题就不合适了。所以自定义的入口是**宽容度三档**
 * （宽松 / 标准 / 严格），它整体缩放倍率阈值 ——
 * 用户表达的是「我判得松一点还是严一点」，而不是「我这题该用几秒」。
 *
 * 在此之上（C3）允许**按题型单独设宽容度**：有人读中文长句慢、
 * 算选择题快，一刀切会让他两边都不舒服。
 *
 * 纯函数，不碰存储、不碰界面。所有默认值都在这里，界面只负责渲染。
 */

import type { Card, CardKind } from './cards.ts';

/** 宽容度三档 */
export type GradingStrictness = 'lenient' | 'standard' | 'strict';

export const STRICTNESS_LABEL: Record<GradingStrictness, string> = {
  lenient: '宽松',
  standard: '标准',
  strict: '严格',
};

export const STRICTNESS_HINT: Record<GradingStrictness, string> = {
  lenient: '同样花这些时间，更容易判成「很熟」。适合刚开始、不想被催的人。',
  standard: '默认。按「这道题正常要花多久」来判断。',
  strict: '同样花这些时间，更容易判成「想久了」。适合冲刺、想把虚高的熟练度压下来。',
};

/**
 * 宽容度对倍率阈值的缩放系数。
 *
 * 怎么理解：`standard` 下「很熟」的边界是 r < 0.6。
 *  - `lenient` 把这个边界放大到 0.6 × 1.35 ≈ 0.81 —— 边界更靠外，
 *    更多作答落进「很熟」，也就是**判得更松**。
 *  - `strict` 缩小到 0.6 × 0.8 ≈ 0.48 —— 边界更靠里，
 *    要真的很快才算「很熟」，也就是**判得更严**。
 *
 * 注意方向：倍率越小 = 越快 = 越熟。所以放大阈值 = 放宽标准。
 */
export const STRICTNESS_FACTOR: Record<GradingStrictness, number> = {
  lenient: 1.35,
  standard: 1,
  strict: 0.8,
};

/**
 * 基准耗时公式的系数。
 *
 * `base = fixed + perChar × 字符数`。
 *
 * 这些数字不是拍脑袋：以中文阅读速度约 300–500 字/分钟（5–7 字/秒）
 * 为量级参照，再留出「思考 + 定位 + 选择」的固定开销。
 * 简答题的 perChar 明显更高，因为要真的组织语言写出来。
 */
export interface TimingCoefficients {
  /** 固定开销（秒）：读题干、找感觉 */
  fixed: number;
  /** 题干每字增加（秒） */
  perPromptChar: number;
  /** 选项总字数每字增加（秒）；只有选择题用得上 */
  perOptionChar: number;
  /** 正文字数每字增加（秒）；只有知识点用得上 */
  perBodyChar: number;
}

/**
 * 各题型的默认系数。
 *
 * - 单选/多选：固定 6 秒读题，题干 0.06 秒/字（16.7 字/秒 的浏览速度），
 *   每个选项 0.03 秒/字。30 字题干 + 4 个 10 字选项 ≈ 6 + 1.8 + 1.2 ≈ 9 秒。
 * - 填空：要回想具体内容，perPromptChar 比选择题高。
 * - 简答：要组织语言，0.35 秒/字，60 字题干 ≈ 8 + 21 ≈ 29 秒。
 * - 知识点：纯阅读，只有阅读时间，没有作答时间。
 */
export const DEFAULT_COEFFICIENTS: Record<CardKind, TimingCoefficients> = {
  single: { fixed: 6, perPromptChar: 0.06, perOptionChar: 0.03, perBodyChar: 0 },
  multiple: { fixed: 7, perPromptChar: 0.065, perOptionChar: 0.035, perBodyChar: 0 },
  /*
   * 判断题比单选快：只有两个固定选项，不用逐个读四个选项。
   * fixed 取 4 秒（读题干 + 判断），perPromptChar 与单选相同。
   * perOptionChar 为 0：选项永远只有「对」「错」两个字，与题目长度无关。
   */
  truefalse: { fixed: 4, perPromptChar: 0.06, perOptionChar: 0, perBodyChar: 0 },
  blank: { fixed: 5, perPromptChar: 0.12, perOptionChar: 0, perBodyChar: 0 },
  short: { fixed: 8, perPromptChar: 0.35, perOptionChar: 0, perBodyChar: 0 },
  point: { fixed: 4, perPromptChar: 0, perOptionChar: 0, perBodyChar: 0.08 },
};

/**
 * 倍率阈值（standard 档）。
 *
 * 语义：`r = 实际 / 基准`，r 越小越快。
 *  - r < easyBelow        → 很熟（easy）
 *  - r < goodBelow        → 正常（good）
 *  - r < hardBelow        → 想了很久（hard）
 *  - 其余                 → 太慢（仍是 hard，但界面会说明）
 */
export const RATIO_THRESHOLDS = {
  /** 低于这个倍率算「一眼就会」 */
  easyBelow: 0.6,
  /** 低于这个倍率算「正常速度」 */
  goodBelow: 1.2,
  /** 低于这个倍率算「想了很久」；再慢也只是 hard，不降到 again */
  hardBelow: 2.5,
} as const;

/**
 * 极端保护。
 *
 * 用户可能切出去干别的再回来，实际耗时几分钟 —— 那反映的不是
 * 「这道题不会」，而是「他没在做题」。所以超过上限时按上限算，
 * 不让一次离开把熟练度打成 `again`。
 */
export const MAX_RATIO = 8;

/** 一份完整的评分规则（默认值或用户自定义后的结果） */
export interface GradingRules {
  /**
   * 总体宽容度。
   *
   * 各题型没单独设置时用它（见 `perKind`）。
   */
  strictness: GradingStrictness;
  /**
   * 按题型覆盖宽容度。
   *
   * 没列出的题型沿用 `strictness`。这是 C3：
   * 允许「选择题判严、简答判松」这类组合。
   */
  perKind: Partial<Record<CardKind, GradingStrictness>>;
}

/** 默认规则：标准宽容度，各题型一致 */
export const DEFAULT_GRADING_RULES: GradingRules = {
  strictness: 'standard',
  perKind: {},
};

/** 取某个题型实际生效的宽容度（perKind 优先于总档） */
export function strictnessFor(kind: CardKind, rules: GradingRules): GradingStrictness {
  return rules.perKind[kind] ?? rules.strictness;
}

/** 字符数。用 Array.from 而不是 .length：emoji 与部分汉字是代理对，.length 会多算 */
function charCount(s: string): number {
  return Array.from(s ?? '').length;
}

/**
 * 这道题的基准耗时（秒）。
 *
 * 算的是「一个正常速度的人，从看到题到作答完，大致要花多久」。
 * 不含任何个人差异 —— 个人差异用宽容度表达。
 */
export function baseSecondsFor(card: Card): number {
  const co = DEFAULT_COEFFICIENTS[card.kind] ?? DEFAULT_COEFFICIENTS.single;
  const promptChars = charCount(card.prompt);
  // 知识点把正文放在 explanation 里（见 cards-loader 的 pointToCard）
  const bodyChars = card.kind === 'point' ? charCount(card.explanation) : 0;
  const optionChars =
    card.kind === 'single' || card.kind === 'multiple'
      ? card.options.reduce((sum, o) => sum + charCount(o.text), 0)
      : 0;

  const seconds =
    co.fixed + co.perPromptChar * promptChars + co.perOptionChar * optionChars + co.perBodyChar * bodyChars;

  /*
   * 保底 3 秒。
   *
   * 空题干或极短题干会让公式算出很小的基准，
   * 于是任何一次作答的倍率都很大 —— 一道 2 个字的题会被永远判「太慢」。
   * 保底 3 秒让这类退化输入不至于把评分带偏。
   */
  return Math.max(3, seconds);
}

/** 评分结论：映射到 SM-2 的四级评分，外加「为什么」 */
export interface TimingVerdict {
  /** 给 SM-2 用的评分 */
  grade: 'again' | 'hard' | 'good' | 'easy';
  /** 实际耗时（毫秒，已按上限夹取） */
  elapsedMs: number;
  /** 这道题的基准耗时（毫秒） */
  baseMs: number;
  /** 倍率（elapsed / base），已按 MAX_RATIO 夹取 */
  ratio: number;
  /** 是否命中了「太慢」那一档（界面据此说明，但评分仍是 hard） */
  tooSlow: boolean;
  /** 是否被上限夹取过（用户中途离开过） */
  clamped: boolean;
  /** 一句话说明，直接可以显示给用户 */
  reason: string;
}

/**
 * 按耗时和作答结果给出评分。
 *
 * ## 答错永远是 again，不看时间
 *
 * 这是硬规则：答错就是没会，耗时再短也不能「因为手快而放宽」。
 * 反过来，答对但花了很久，说明是「想出来的」而不是「想起来」，
 * 给 hard —— 这正是间隔复习想区分的东西。
 *
 * ## 知识点没有对错，只看停留时间
 *
 * `correct === null` 时按阅读速度判：读得快说明熟。
 * 但知识点不该因为「读得慢」被当成答错，所以最差也只到 hard。
 */
export function judgeByTiming(
  card: Card,
  correct: boolean | null,
  elapsedMs: number,
  rules: GradingRules = DEFAULT_GRADING_RULES,
): TimingVerdict {
  const baseSec = baseSecondsFor(card);
  const baseMs = baseSec * 1000;

  // 负数和 NaN 都按 0 处理：时钟回拨或异常输入不该算出负数倍率
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const rawRatio = safeElapsed / baseMs;
  const clamped = rawRatio > MAX_RATIO;
  const ratio = clamped ? MAX_RATIO : rawRatio;

  const kind = card.kind;
  const factor = STRICTNESS_FACTOR[strictnessFor(kind, rules)];
  const easyBelow = RATIO_THRESHOLDS.easyBelow * factor;
  const goodBelow = RATIO_THRESHOLDS.goodBelow * factor;
  const hardBelow = RATIO_THRESHOLDS.hardBelow * factor;

  const fmt = (sec: number): string =>
    sec < 60 ? `${Math.round(sec)} 秒` : `${(sec / 60).toFixed(1)} 分钟`;

  // ---- 答错：无条件 again ----
  if (correct === false) {
    return {
      grade: 'again',
      elapsedMs: safeElapsed,
      baseMs,
      ratio,
      tooSlow: false,
      clamped,
      /*
       * reason 留空字符串而不是写解释。
       *
       * 用户明确要求「答错了直接记入错题就行」——答错时界面不再展示判定面板，
       * 所以这里写任何解释都不会被显示，只会作为死字符串进包
       * （发布校验时抓到过一次，当时的文案是「答错不计时间…」）。
       *
       * 留空还有个好处：将来若有别处要用 verdict.reason 展示，
       * 空字符串会立刻暴露「这里没有说明」，而不是悄悄给出一句可能已过时的话。
       */
      reason: '',
    };
  }

  /*
   * 下面的文案**不出现「这类题通常要多少秒」**。
   *
   * 那是我们按题型与字数估出来的一个数，用来做归一化可以，
   * 但摆到用户面前就是「建议时长」—— 而他明确说过这个不好估计：
   * 同一道题不同人、不同心情差好几倍，报一个数出来只会误导，
   * 还会让人下意识地拿自己跟这个数字比、觉得自己慢了。
   *
   * 所以对外只说「你用了多久」和「这次判成什么」，不公布内部基准。
   */

  // ---- 知识点：只有阅读，没有对错 ----
  if (card.kind === 'point' || correct === null) {
    const grade = ratio < easyBelow ? 'easy' : ratio < goodBelow ? 'good' : 'hard';
    const reason =
      grade === 'easy'
        ? `读得很快（${fmt(safeElapsed / 1000)}）。`
        : grade === 'good'
          ? `读完了（${fmt(safeElapsed / 1000)}），速度正常。`
          : `读得偏慢（${fmt(safeElapsed / 1000)}），可能需要再过一遍。`;
    return { grade, elapsedMs: safeElapsed, baseMs, ratio, tooSlow: false, clamped, reason };
  }

  // ---- 答对：按倍率分档 ----
  if (ratio < easyBelow) {
    return {
      grade: 'easy',
      elapsedMs: safeElapsed,
      baseMs,
      ratio,
      tooSlow: false,
      clamped,
      reason: `一眼就会（用了 ${fmt(safeElapsed / 1000)}）。`,
    };
  }
  if (ratio < goodBelow) {
    return {
      grade: 'good',
      elapsedMs: safeElapsed,
      baseMs,
      ratio,
      tooSlow: false,
      clamped,
      reason: `正常速度（用了 ${fmt(safeElapsed / 1000)}）。`,
    };
  }

  const tooSlow = ratio >= hardBelow;
  const reason = tooSlow
    ? `花的时间偏长（${fmt(safeElapsed / 1000)}）。答对了，但更像是「想出来的」而不是「一眼就会」，所以下次复习会更早一些。`
    : `停顿了一下（${fmt(safeElapsed / 1000)}）。答对了，但不算熟练。`;

  return { grade: 'hard', elapsedMs: safeElapsed, baseMs, ratio, tooSlow, clamped, reason };
}

/**
 * 用户自定义规则是否等于默认值。
 *
 * 设置页用它决定「恢复默认」按钮是否可点 —— 已经是默认时不该可点。
 */
export function isDefaultRules(rules: GradingRules): boolean {
  return rules.strictness === DEFAULT_GRADING_RULES.strictness && Object.keys(rules.perKind).length === 0;
}

/**
 * 把存储里读出来的、形状不可信的值收敛成一个合法规则。
 *
 * 备份文件可能来自旧版本、也可能被人手改过。
 * 这里**不抛错**：读到一个坏值就退回默认，总比让设置页整页打不开好。
 */
export function normalizeGradingRules(raw: unknown): GradingRules {
  const isStrictness = (v: unknown): v is GradingStrictness =>
    v === 'lenient' || v === 'standard' || v === 'strict';

  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GRADING_RULES, perKind: {} };

  const obj = raw as Record<string, unknown>;
  const strictness = isStrictness(obj.strictness) ? obj.strictness : DEFAULT_GRADING_RULES.strictness;

  const perKind: Partial<Record<CardKind, GradingStrictness>> = {};
  const rawPerKind = obj.perKind;
  if (rawPerKind && typeof rawPerKind === 'object') {
    const kinds: CardKind[] = ['single', 'multiple', 'truefalse', 'blank', 'short', 'point'];
    for (const k of kinds) {
      const v = (rawPerKind as Record<string, unknown>)[k];
      if (isStrictness(v)) perKind[k] = v;
    }
  }

  return { strictness, perKind };
}
