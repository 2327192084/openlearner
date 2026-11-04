import type { SourceSegment, SourceLocation } from '../model.ts';

/**
 * 定位器 —— P2 里最关键的 30 行逻辑。
 *
 * ## 为什么必须这样做
 *
 * 让 AI 直接输出「这条知识点在第 12 页」是不可信的：模型看不到分页，
 * 它对页号的任何陈述都是猜的。计划书第 7 节的原话是
 * **「指错页比不能跳转更糟，因为它冒充可信」**。
 *
 * 所以流程反过来：
 *   1. 让模型只输出**原文引用**（它确实能看到文本内容）
 *   2. 我们拿这段引用到真实段落里找
 *   3. 找到 → 记录真实 page + 字符偏移
 *      找不到 → **留空，标记 unlocated，等人处理**
 *
 * 第 3 步的后半句同样重要：绝不「就近凑一个位置」。
 * 一个错误的位置比没有位置更坏，因为用户不会去怀疑它。
 *
 * ## 匹配策略（从严格到宽松，全部可解释）
 *
 * 1. **精确匹配**：引用文本原样出现在某段里
 * 2. **空白归一匹配**：忽略空格/换行差异（PDF 折行、全角空格）
 * 3. **首尾裁剪匹配**：模型常把引用前后多加几个字或省略号，裁掉再试
 *
 * 三级都不中 → unlocated。不做模糊匹配、不做相似度兜底：
 * 那类算法会「大概找到个地方」，正是我们要避免的。
 */

/** 定位结果 */
export interface LocateResult {
  /** 命中的锚点。找不到时为空数组 */
  anchors: SourceLocation[];
  /** 实际命中的原文片段（可能与传入的引用略有差异，如空白归一后的结果） */
  matchedQuotes: string[];
  /** 是否全部命中 */
  located: boolean;
}

/**
 * 去掉模型常加的多余修饰。
 *
 * 实测模型常见的几种「引用偏移」：
 *  - 前后加引号：「……」
 *  - 末尾加省略号：……
 *  - 前面加「原文：」
 * 这些不是内容差异，是我们的提示词没约束够严，不该因此判为未定位。
 */
function stripDecorations(quote: string): string {
  let q = quote.trim();
  // 成对引号
  q = q.replace(/^[「『"'"']+/, '').replace(/[」』"'"']+$/, '');
  // 结尾省略号
  q = q.replace(/[.．。…]+$/, '');
  // 前缀「原文：」
  q = q.replace(/^(原文|出处|引用)[:：]\s*/, '');
  return q.trim();
}

/**
 * 在一块文本里找引用的位置。
 *
 * 返回**原始文本坐标**（不是归一化文本的），这样 charStart/charEnd
 * 可以直接用于高亮切分。
 */
export function findQuoteInText(
  text: string,
  quote: string,
): { start: number; end: number; matched: string } | null {
  const candidates = buildCandidates(quote);

  for (const candidate of candidates) {
    if (!candidate) continue;

    // 1) 原文精确匹配
    const direct = text.indexOf(candidate);
    if (direct !== -1) {
      return {
        start: direct,
        end: direct + candidate.length,
        matched: candidate,
      };
    }

    // 2) 空白归一后匹配：需要把归一化坐标映射回原文坐标
    const normalizedHit = findNormalized(text, candidate);
    if (normalizedHit) return normalizedHit;
  }

  return null;
}

/**
 * 长引用的噪声容错：用「收缩窗口」找出引用中确实存在的那一段。
 *
 * 为什么不用固定裁剪（早先做法，实测失败）：
 * 模型加的噪声往往不对称 —— 前面可能多一整句引导语（「根据教材的说明，」），
 * 后面只多几个字。固定裁 10% 两头都裁，前面裁不够、后面裁过头，两边都不中。
 *
 * 改成滑动窗口：从引用里取连续的中段去试，窗口逐步收窄。
 * 先从两端各去掉 1/8，再 1/4……直到最小保留 60%。
 * 只收窄不扩张，且**必须命中原文**才算数 —— 不存在「模糊猜一个」的空间。
 *
 * 为什么不直接做「最大公共子串」：那会返回任意位置的巧合匹配，
 * 比如引用里「支持随机访问」在另一章也出现过，就会指到错误的页。
 * 按顺序收窄两端，保留的是引用主体，指向的才是原意。
 */
function shrinkWindows(quote: string): string[] {
  const out: string[] = [];
  const t = quote.trim();
  if (t.length < 24) return out;

  // 两端各去掉的比例：12.5%, 25%, 37.5%（保留 75% / 50% / 25%）
  for (const ratio of [0.125, 0.25, 0.375]) {
    const cut = Math.floor(t.length * ratio);
    if (t.length - cut * 2 < 12) break;
    out.push(t.slice(cut, t.length - cut));
  }
  return out;
}

/**
 * 生成候选引用：原样、去修饰、收缩窗口。
 *
 * 关于最小长度：定 2。
 * 早先写 6，把「关键概念」这类 4 字术语和更短的有效引用全挡掉了 ——
 * 真正该防的不是「短」而是「短到没有区分度」，那由 MIN_QUOTE_LENGTH 统一把关。
 */
const MIN_CANDIDATE_LENGTH = 2;

function buildCandidates(quote: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= MIN_CANDIDATE_LENGTH && !out.includes(t)) out.push(t);
  };

  push(quote);
  const stripped = stripDecorations(quote);
  push(stripped);

  // 收缩窗口：应对头尾噪声不对称的情况
  for (const base of [quote, stripped]) {
    for (const w of shrinkWindows(base)) push(w);
  }

  return out;
}

/**
 * 空白归一匹配。
 *
 * 关键：**剔除**空白，而不是把它们压成空格。
 *
 * 早先压成空格，实测漏了一种常见情况：PDF 折行在段落内部留下 `\n`，
 * 原文变成「线性结构\n与非线性结构」，而模型给的引用是
 * 「线性结构与非线性结构」（没有空格）。压成空格后原文是
 * 「线性结构 与非线性结构」，仍然对不上 —— 一个字符之差就全废。
 *
 * 剔除空白则两边都变成「线性结构与非线性结构」，稳定命中。
 * 这也符合中文的书写习惯：中文本来就不用空格分词。
 *
 * 难点是坐标映射：剔除空白会改变字符数，所以边扫描边记
 * 「归一化字符 → 原文下标」，命中后再映射回去。
 */
function findNormalized(
  text: string,
  quote: string,
): { start: number; end: number; matched: string } | null {
  const chars: string[] = [];
  const origIndex: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue; // 直接丢掉，不占位
    chars.push(ch);
    origIndex.push(i);
  }

  const target = [...quote].filter((c) => !/\s/.test(c)).join('');
  if (target.length < 6) return null;

  const normalized = chars.join('');
  const hit = normalized.indexOf(target);
  if (hit === -1) return null;

  const startOrig = origIndex[hit];
  const endOrig = origIndex[hit + target.length - 1] + 1;

  return {
    start: startOrig,
    end: endOrig,
    // 返回原文里的真实片段（可能含换行），而不是归一化后的字符串
    matched: text.slice(startOrig, endOrig),
  };
}

/**
 * 一条引用至少要有这么长才算「有区分度」。
 *
 * 定 4：中文里 4 个字（如「关键概念」「随机访问」）已经足够特指，
 * 而 1–3 个字（「的」「数据」「线性表」）在教材里几乎必然出现多次，
 * 匹配到哪一处都没有说服力。这类引用不是「定位失败」，
 * 而是「模型给的引用本身不够用」—— 两者界面提示不同，但都不能给位置。
 */
const MIN_QUOTE_LENGTH = 4;

/**
 * 在一份资料的若干段里定位一条引用。
 *
 * 多段都可能命中的情况（同一句话在教材里出现两次）：取**第一处**，
 * 因为学生通常是按顺序读的，第一次出现的位置最符合直觉。
 * 这里刻意不返回多个锚点 —— 一条知识点挂多个位置会让「点回原文」
 * 变成「点开一个列表让你选」，反而降低可信度。人工可以手动改。
 */
export function locateQuote(
  segments: SourceSegment[],
  quote: string,
  sourceId: string,
): LocateResult {
  const cleaned = stripDecorations(quote);

  if (!cleaned || cleaned.length < MIN_QUOTE_LENGTH) {
    return { anchors: [], matchedQuotes: [], located: false };
  }

  for (const seg of segments) {
    const found = findQuoteInText(seg.text, quote);
    if (found) {
      return {
        anchors: [
          {
            sourceId,
            page: seg.page,
            chapter: seg.chapter ?? undefined,
            charStart: found.start,
            charEnd: found.end,
          },
        ],
        matchedQuotes: [found.matched],
        located: true,
      };
    }
  }

  return { anchors: [], matchedQuotes: [], located: false };
}

/**
 * 批量定位一条知识点的多条引用。
 *
 * 只有**全部**引用都定位成功才算 located：
 * 一条知识点若引了两处原文、只找到一处，那说明模型对这条的把握不完整，
 * 应该让人看一眼，而不是当作成功。
 */
export function locateQuotes(
  segments: SourceSegment[],
  quotes: string[],
  sourceId: string,
): LocateResult {
  const usableQuotes = quotes.map((q) => q.trim()).filter(Boolean);

  if (usableQuotes.length === 0) {
    return { anchors: [], matchedQuotes: [], located: false };
  }

  const anchors: SourceLocation[] = [];
  const matchedQuotes: string[] = [];

  for (const quote of usableQuotes) {
    const result = locateQuote(segments, quote, sourceId);
    if (!result.located) {
      // 有一条找不到就整体判失败，但保留已找到的引用文本供人工参考
      return {
        anchors: anchors.length > 0 ? anchors : [],
        matchedQuotes,
        located: false,
      };
    }
    anchors.push(...result.anchors);
    matchedQuotes.push(...result.matchedQuotes);
  }

  return { anchors, matchedQuotes, located: true };
}
