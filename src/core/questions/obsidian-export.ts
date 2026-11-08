/**
 * 导出为 Obsidian Spaced Repetition 插件可识别的闪卡 Markdown。
 *
 * ## 为什么是「导出到 Obsidian」而不是「内置渲染器」
 *
 * 用户的笔记主力是 Obsidian，考研要写大量数学物理公式。所以错题闪卡的
 * 定位不是「在本应用里看」，而是**把卡片送进 Obsidian 的复习流**。
 * 本应用负责挑出「该练的题」，Obsidian 负责复习与笔记关联。
 *
 * ## 语法依据（照抄官方文档，不是猜的）
 *
 * 来源：`st3v3nmw/obsidian-spaced-repetition` 的 `docs/docs/zh/flashcards.md`
 * （仓库地址 https://github.com/st3v3nmw/obsidian-spaced-repetition ）。
 * 取文档用的 GitHub API（raw.githubusercontent 在部分网络下不通）。
 *
 * 关键规则，逐条对应我们的实现：
 *
 * | 插件规则 | 我们怎么用 |
 * | --- | --- |
 * | 多行卡正面 与 反面 以**单独一行**的 `?` 分隔 | 我们的题干/答案都是多行，用这个 |
 * | 卡片之间必须**空行**分隔，否则会被连成一张卡 | `join('\n\n')` |
 * | 需要复习的笔记要有标签（默认 `#flashcards`） | 文件顶部放 `#flashcards` |
 * | 行内公式 `$...$`，块级公式 `$$...$$` | 见 `toLatex` 的说明 |
 * | `<!--SR:...-->` 可用于从队列移除某张卡 | 我们不生成它（那是插件自己写的调度数据） |
 *
 * ## 为什么不用 `::` 单行语法
 *
 * 单行 `问题::答案` 要求问题和答案都在一行内。我们的题干常有换行、
 * 选项要分行列，用单行语法会把格式压平。多行 `?` 语法正好合适。
 *
 * ## 关于公式：只包装，不臆造
 *
 * 真实题库里的公式目前是**纯文本形式**（`x(-t)=-x(t)`、`e^{jπn}`、`(-1)^n`），
 * 既没有 `$` 也不是 LaTeX 命令。直接导出到 Obsidian，这些会原样显示成
 * 普通文本 —— 上标下标不渲染，公式看起来是残的。
 *
 * 所以这里做**保守的**文本→LaTeX 包装：
 *  - 只处理明确的数学记号（上下标 `^{}` `_{}`、常见运算符、希腊字母）
 *  - 认不出来的原样保留（宁可少包一层，也不要把中文裹进公式里）
 *  - 绝不改写题目内容本身 —— 只加 `$` 定界符
 */

import type { Question } from '@/core/model.ts';

/** 一道题 → 一张闪卡的参数 */
export interface FlashcardOptions {
  /** 标签名（不含 #）。默认 flashcards —— 插件默认值 */
  tag?: string;
  /**
   * 是否把疑似公式包成 `$...$`。
   *
   * 默认 true。关掉的话导出的就是纯文本，不会误伤
   * （万一某段文字被误判成公式，用户可以关掉重导）。
   */
  wrapFormulas?: boolean;
  /** 是否在卡片里带上出处（资料名 + 页码） */
  includeSource?: boolean;
}

const DEFAULT_TAG = 'flashcards';

/**
 * 把一段纯文本里的数学记号包成 LaTeX 行内公式。
 *
 * ## 为什么需要它（而不是直接用）
 *
 * 用户的题是这样写的：
 *   `当频率ω₀=π（或π的奇数倍）时，信号e^{jπn}等于______`
 *
 * 在 Obsidian 里，`e^{jπn}` 会显示成字面的 `e^{jπn}` ——
 * 花括号和尖号都在，非常难看。包成 `$e^{j\pi n}$` 才会渲染出上标。
 *
 * ## 保守策略：只包「看起来确实是公式」的片段
 *
 * 判据（任一命中）：
 *  - 含 `^{` 或 `_{`（明确的上下标）
 *  - 含反斜杠命令 `\frac` `\sqrt` 等（已经是 LaTeX）
 *  - 是形如 `x(t)`、`x[-n]` 这种「单字母 + 括号参数」的函数记号
 *  - 是纯符号表达式（`(-1)^n`、`a+b=c` 之类，且不含中文）
 *
 * **含中文的片段一律不包** —— 中文进了公式会渲染成豆腐块或斜体乱码。
 * 这是最容易犯错的地方，所以单独判断。
 */
export function wrapFormulas(text: string): string {
  if (!text) return '';

  /*
   * 先把已经包好的 $...$ / $$...$$ 挖出来占位。
   * 用户自己写好的公式不能重复包，否则会变成 $$...$$ 嵌在 $$...$$ 里。
   */
  const kept: string[] = [];
  const PH = '\u0000K'; // 占位前缀（源码里写成转义，不写字面控制字符）
  let work = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => {
    kept.push(m);
    return `${PH}${kept.length - 1}\u0000`;
  });

  const hasCJK = /[\u4e00-\u9fff]/;
  /*
   * 希腊字母 + 数学符号 + 上下标数字。
   *
   * 上下标也要算进来：`a³` 只是一字母加个上标，如果不在这一档，
   * 就会被「至少 2 个字符」的规则挡掉 —— 而它恰恰必须转成 LaTeX，
   * 否则 MathJax 会把 `³` 渲染成缺字方框。
   */
  const GREEK_OR_SYMBOL =
    /[\u03b1-\u03c9\u0391-\u03a9\u221e\u2264\u2265\u2260\u00b1\u00d7\u00f7\u00b2\u00b3\u2070-\u2079\u2080-\u2089]/;

  /** 一段完整 token 是否像公式（只用于决定要不要加 $，不改语义） */
  const looksMath = (s: string): boolean => {
    if (!s) return false;
    if (hasCJK.test(s)) return false; // 中文绝不进公式

    /*
     * ⚠️ 顺序有讲究：**单个数学符号先判，不受长度限制**。
     *
     * 踩过的坑：一开始把「压缩后至少 2 个字符」放在最前面，
     * 结果 `ω`、`≤` 这种单个符号被挡掉 —— `频率 ω 与 π 的关系` 里
     * 两个希腊字母都没转换，而它们恰恰是最该渲染的东西。
     */
    if (GREEK_OR_SYMBOL.test(s)) return true; // ω / π / ≤ / ∞

    const compact = s.replace(/\s/g, '');
    if (compact.length < 2) return false;
    if (/\^\{|_\{/.test(s)) return true; // 明确的上下标
    if (/\\[a-zA-Z]{2,}/.test(s)) return true; // 已是 LaTeX
    if (/[A-Za-z]\s*[([{]/.test(s)) return true; // x(t) / x[-n]
    if (/[=+\-*/<>]/.test(s) && /[A-Za-z0-9)]/.test(s)) return true;
    return false;
  };

  /** 纯文本记号 → LaTeX 命令。只做确定性替换，不猜。 */
  const toTex = (s: string): string =>
    s
      .replace(/π/g, '\\pi ')
      .replace(/ω/g, '\\omega ')
      .replace(/α/g, '\\alpha ')
      .replace(/β/g, '\\beta ')
      .replace(/γ/g, '\\gamma ')
      .replace(/δ/g, '\\delta ')
      .replace(/ε/g, '\\epsilon ')
      .replace(/μ/g, '\\mu ')
      .replace(/σ/g, '\\sigma ')
      .replace(/λ/g, '\\lambda ')
      .replace(/θ/g, '\\theta ')
      .replace(/φ/g, '\\phi ')
      .replace(/ψ/g, '\\psi ')
      .replace(/Ω/g, '\\Omega ')
      .replace(/Δ/g, '\\Delta ')
      .replace(/Σ/g, '\\Sigma ')
      .replace(/∞/g, '\\infty ')
      .replace(/≤/g, '\\le ')
      .replace(/≥/g, '\\ge ')
      .replace(/≠/g, '\\ne ')
      .replace(/±/g, '\\pm ')
      .replace(/×/g, '\\times ')
      .replace(/÷/g, '\\div ')
      /*
       * Unicode 上下标数字转成 LaTeX。
       *
       * 为什么必须转：`ω₀` 里的 `₀` 是 U+2080，MathJax 不认这个字符 ——
       * 包进 `$...$` 后渲染成一个缺字方框。而题目里这写法很常见。
       *
       * ⚠️ `²`(U+00B2) 与 `³`(U+00B3) 不在 U+2070 区间 ——
       * 它们是 Latin-1 里的老式上标。只按区间减偏移会把它们算成负数：
       * 真实导出里 `|x[n]|²` 曾变成 `^{-8126}`，公式里出现一串乱码数字。
       * 所以这两个先单独映射，剩下的才按区间算。
       */
      .replace(/²/g, '^{2}')
      .replace(/³/g, '^{3}')
      .replace(/[⁰¹⁴⁵⁶⁷⁸⁹]/g, (c) => `^{${c.charCodeAt(0) - 0x2070}}`)
      .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => `_{${c.charCodeAt(0) - 0x2080}}`)
      .replace(/\s+/g, ' ')
      .trim();

  /*
   * 逐 token 处理。
   *
   * token 边界：连续的非中文、非空白字符。**括号必须留在 token 内部** ——
   * 早先的版本把 `}` 当尾随标点切掉，结果 $ 插到了花括号里面，
   * 得到 `$e^{j\pi n$}` 这种非法 LaTeX（Obsidian 会直接不渲染）。
   *
   * 所以只把「句读类」标点留在外面（, . ; : ! ? 及全角版本），
   * 括号与运算符全部视为公式的一部分。
   */
  work = work.replace(
    /[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g,
    (token) => {
      const trailing = token.match(/[,.!:;?，。；：！？]+$/)?.[0] ?? '';
      const body = trailing ? token.slice(0, -trailing.length) : token;
      if (!body || !looksMath(body)) return token;

      const tex = toTex(body);
      if (!tex) return token;
      return `$${tex}$${trailing}`;
    },
  );

  work = work.replace(/\u0000K(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? '');
  return work;
}

/** 一道题 → 一张闪卡（不含卡片间的空行） */
export function questionToFlashcard(
  q: Question,
  options: FlashcardOptions = {},
  sourceLabel?: string | null,
): string {
  const wrap = options.wrapFormulas !== false;
  const f = wrap ? wrapFormulas : (s: string) => s;

  const lines: string[] = [];

  /* 正面：题干 + 选项（选项分行，便于阅读） */
  lines.push(f(q.prompt));
  if (q.options.length > 0) {
    lines.push('');
    for (const o of q.options) {
      lines.push(`${o.key}) ${f(o.text)}`);
    }
  }

  /* 分隔符：必须单独一行 */
  lines.push('?');

  /* 反面：答案 + 解析 */
  /*
   * 答案区**逐段包装公式**，绝不能把整块（含 `**A**` 这种 Markdown 标记）
   * 交给 wrapFormulas —— 那样 `**A**` 会被当成数学片段包成 `$**A**$`，
   * 在 Obsidian 里既不渲染粗体、也不渲染公式，两边都坏。
   *
   * 所以这里先按「选项 key + 文本」分别处理，标记与文本各走各的。
   */
  if (q.kind === 'single' || q.kind === 'multiple' || q.kind === 'truefalse') {
    const byKey = new Map(q.options.map((o) => [o.key.toUpperCase(), o.text]));
    const keys = q.answer
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const k of keys) {
      const text = byKey.get(k.toUpperCase());
      // 只包装选项文本，key 保持原样（它是 Markdown 的一部分）
      lines.push(text ? `**${k}**：${f(text)}` : `**${k}**`);
    }
  } else {
    // 填空/问答的答案是纯文本，整段包装即可
    lines.push(f(q.answer));
  }

  if (q.explanation.trim()) {
    lines.push('');
    lines.push(f(q.explanation));
  }
  if (options.includeSource && sourceLabel) {
    lines.push('');
    lines.push(`*出处：${sourceLabel}*`);
  }

  return lines.join('\n');
}

/**
 * 一整个题组 → 一个 .md 文件的内容。
 *
 * 结构：
 *   #flashcards
 *   （空行）
 *   卡片1
 *   （空行）
 *   卡片2
 *
 * 为什么要那行标签：插件靠标签识别「哪些笔记要进复习」，
 * 默认标签就是 `#flashcards`。不写的话卡片不会出现在复习队列里 ——
 * 用户会以为导出坏了。
 */
export function deckToObsidianMarkdown(
  deckTitle: string,
  questions: readonly Question[],
  options: FlashcardOptions = {},
  sourceLabelOf?: (q: Question) => string | null,
): { content: string; count: number } {
  const tag = options.tag ?? DEFAULT_TAG;

  const header = [
    '---',
    `title: ${JSON.stringify(deckTitle)}`,
    '---',
    '',
    `#${tag}`,
    '',
  ].join('\n');

  const cards = questions.map((q) =>
    questionToFlashcard(q, options, sourceLabelOf?.(q) ?? null),
  );

  /*
   * 卡片之间必须空行 —— 文档明确写了：
   * 「请注意，如果问题还有回答当中如果出现 回车+空行，内容是会显示不全的」
   * 反过来，卡片之间**不空行**会被连成一张卡。
   * 所以这里用两个换行连接。
   */
  return { content: header + cards.join('\n\n') + '\n', count: cards.length };
}

/** 导出文件名（去掉文件系统不认的字符） */
export function obsidianFileName(deckTitle: string): string {
  const safe = deckTitle
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || '错题闪卡'}.md`;
}
