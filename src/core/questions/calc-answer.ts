/**
 * 计算题的数值答案比对（2026-11-12）。
 *
 * ## 为什么不能直接比字符串
 *
 * 计算题的正确答案是**数值 + 单位**，同一个答案有多种合法写法：
 *
 * | 学生写的 | 标准答案 | 应该判 |
 * |---|---|---|
 * | `0.5` | `1/2` | ✅ 对 |
 * | `50%` | `0.5` | ✅ 对 |
 * | `9.8 m/s^2` | `9.8 m/s²` | ✅ 对 |
 * | `1/3` | `0.3333` | ⚠️ 看精度 |
 * | `-1` | `1` | ❌ 错 |
 *
 * 用填空题那套「文本归一化后严格相等」会把这些正确的写法判错，
 * 那比不出题更伤 —— 学生会以为自己算错了。
 *
 * ## 做法
 *
 * 1. 把两侧都解析成「数值 + 单位」
 * 2. 数值按**相对误差**比较（默认 1%，可通过 `tolerance` 调）
 * 3. 单位必须一致（允许常见等价写法：`m/s^2` = `m/s²`）
 * 4. 单位缺失时**从严**：只有一侧有单位就判错 ——
 *    物理题丢单位是实质错误，不该放过
 *
 * ## 参考
 *
 * 数值比较用相对误差而不是绝对误差：`1e9` 量级的答案，绝对误差 0.01
 * 根本没意义；而 `0.001` 量级的答案，0.01 的绝对误差又太大。
 * 相对误差与量级无关。
 */

/** 解析出的数值答案 */
export interface ParsedNumeric {
  /** 数值（有限小数或分数换算后的结果） */
  value: number;
  /** 单位（已归一化）；空串表示无单位 */
  unit: string;
  /** 是否是百分数（用于把 50% 与 0.5 视为相等） */
  percent: boolean;
}

/**
 * 单位等价写法归一化。
 *
 * 只做**确定安全**的替换：上标数字转 `^n`、去掉空格、统一大小写敏感符号。
 * 不试图理解复合单位的量纲 —— 那需要一张完整的单位表，
 * 而判错一个正常答案的代价比多判几个错高。
 */
function normalizeUnit(raw: string): string {
  let u = raw.trim();
  if (!u) return '';

  /* 上标 → ^n（m/s² → m/s^2） */
  const sup: Record<string, string> = {
    '⁰': '^0', '¹': '^1', '²': '^2', '³': '^3', '⁴': '^4',
    '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9',
    '⁻': '^-',
  };
  u = u.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, (c) => sup[c] ?? c);

  /* 去掉所有空格：`m / s` 与 `m/s` 是同一个单位 */
  u = u.replace(/\s+/g, '');

  /*
   * 常见的等价写法。
   * 注意：这里**不**做 `s` 与 `sec` 这类自由换算 ——
   * 那需要单位表，且容易把 `s`（秒）与 `S`（西门子）搞混。
   */
  u = u.replace(/·/g, '*').replace(/×/g, '*');

  return u;
}

/**
 * 把一段文本解析成「数值 + 单位」。
 *
 * 支持的写法：
 *  - `12`、`-3.5`、`1.2e-3`
 *  - `1/2`、`-3/4`（分数）
 *  - `50%`（百分数，值记为 0.5，但同时保留 percent 标记）
 *  - `9.8 m/s^2`、`9.8m/s²`（数值 + 单位）
 *
 * @returns 解析失败返回 null（说明不是纯数值答案，应退回文本比对）
 */
export function parseNumeric(input: string): ParsedNumeric | null {
  let s = String(input ?? '').trim();
  if (!s) return null;

  /*
   * 去掉包裹的 LaTeX 数学模式与 \text{}
   * 模型有时会给 `$0.5$` 或 `0.5\,\text{m/s}`。
   */
  s = s.replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/\\text\{([^}]*)\}/g, '$1');
  s = s.replace(/\\mathrm\{([^}]*)\}/g, '$1');
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)');
  /* 常见 LaTeX 命令：去掉反斜杠与多余花括号 */
  s = s.replace(/\\left|\\right|\\,|\\;|\\!/g, '');
  s = s.replace(/[{}]/g, '');

  /* 百分数 */
  let percent = false;
  if (/%$/.test(s)) {
    percent = true;
    s = s.replace(/%$/, '').trim();
  }

  /*
   * 拆数值与单位。
   *
   * 数值部分允许：可选正负号、数字、小数点、科学计数、分数、括号。
   * 用一个宽松的字符类先截出前缀，剩下的当单位。
   */
  const m = /^([+-]?\s*(?:\(?[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\)?)(?:\s*\/\s*\(?[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\)?)?)\s*(.*)$/.exec(s);
  if (!m) return null;

  const numText = m[1].replace(/\s+/g, '');
  const unitText = m[2] ?? '';

  let value: number;
  if (numText.includes('/')) {
    const [a, b] = numText.split('/');
    const na = Number(a?.replace(/[()]/g, ''));
    const nb = Number(b?.replace(/[()]/g, ''));
    if (!Number.isFinite(na) || !Number.isFinite(nb) || nb === 0) return null;
    value = na / nb;
  } else {
    value = Number(numText.replace(/[()]/g, ''));
  }

  if (!Number.isFinite(value)) return null;

  /* 百分数：50% → 0.5 */
  if (percent) value = value / 100;

  return { value, unit: normalizeUnit(unitText), percent };
}

/** 比对选项 */
export interface CompareOptions {
  /**
   * 相对误差容忍度，默认 1%。
   *
   * 为什么是 1% 而不是 0：学生用不同精度近似（1/3 写成 0.33）
   * 是常态，严格相等会把它们全判错；而 1% 又不至于把真正算错的放过。
   */
  tolerance?: number;
}

/**
 * 比较两个计算题答案。
 *
 * @returns
 *  - `true`  数值在容差内且单位一致
 *  - `false` 明确不同（数值超容差 / 单位不一致）
 *  - `null`  有一侧解析不出数值 —— 调用方应退回文本比对
 */
export function compareNumeric(
  given: string,
  expected: string,
  opts: CompareOptions = {},
): boolean | null {
  const a = parseNumeric(given);
  const b = parseNumeric(expected);

  /* 任意一侧不是纯数值：交给文本比对，不在这里瞎猜 */
  if (!a || !b) return null;

  /*
   * 单位必须一致。
   *
   * 从严的理由：物理/工程题丢单位是实质错误。
   * 例如「力是多少」答 `5` 而不是 `5 N` —— 数值对但没回答问题。
   *
   * 例外：一侧没写单位、另一侧也没有 → 视为一致（纯数学题）。
   */
  if (a.unit !== b.unit) return false;

  const tol = opts.tolerance ?? 0.01;

  /*
   * 相对误差比较。注意标准答案为 0 的边界。
   *
   * ## 为什么 0 不用相对误差
   *
   * 相对误差要除以 |期望值|，0 做分母无意义。所以对 0 必须换规则。
   *
   * ## 为什么 0 用「严格相等（只留浮点余量）」而不是绝对容差
   *
   * 一开始我写了 `diff <= max(tol, 1e-12)`，也就是 0.001 也算对。
   * 但那会把真实的错误放过：
   *
   *   题：「平衡时合力是多少？」答：0
   *   学生算出 0.001 → 那是算错了，不是精度问题
   *
   * 容差本来是为了容纳「1/3 写成 0.33」这类**有量级**的近似；
   * 标准答案恰好是 0 的题，通常意味着结果应**精确为零**
   * （平衡、抵消、无解），这时出现非零值更可能是错。
   *
   * 所以 0 只留浮点运算的余量（1e-12），不做 1% 放宽。
   */
  const diff = Math.abs(a.value - b.value);
  if (b.value === 0) return diff <= 1e-12;
  return diff / Math.abs(b.value) <= tol;
}

/**
 * 计算题的判分入口：先试数值比对，解析不出再退回文本比对。
 *
 * @param normalizeText 文本归一化函数（复用填空题那套，保持行为一致）
 */
export function gradeCalcAnswer(
  given: string,
  expected: string,
  normalizeText: (s: string) => string,
): boolean {
  const numeric = compareNumeric(given, expected);
  if (numeric !== null) return numeric;

  /*
   * 退回文本比对。
   *
   * 什么时候会走到这：答案是公式而非数值（如 `R_1+R_2`），
   * 或者用户写了一段带文字说明的答案。
   * 这时用填空那套归一化比对是合理的 —— 至少比直接判错好。
   */
  return normalizeText(given) === normalizeText(expected);
}
