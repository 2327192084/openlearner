/**
 * 把闪卡导出成 Obsidian Spaced Repetition 插件认的 Markdown。
 *
 * ## 用户要求
 *
 * > 「同时还要有导出功能导出到 obsidian 中（要符合 obsidian 支持的格式，
 * > 应该是 markdown 格式）」
 * （2026-11-23 追加：「闪卡导出功能一同修改」+「探讨有没有技术方法
 *  可以让 obsidian 的闪卡实现翻面」）
 *
 * ## 语法依据：不是读文档，是跑解析器
 *
 * 2026-11-23 让子代理把**已发布的插件产物**（sha256 与 Release digest
 * 逐字节一致）切片拼成可执行 harness，用它**自己的** `parse()` /
 * `CardFrontBackUtil.expand()` 跑了 40+ 个实测用例。
 * 完整取证在 `.tmp/sr-verify/FINDINGS.md`（复现：
 * `node .tmp/sr-verify/build_harness.cjs && node .tmp/sr-verify/run_cases.cjs`）。
 *
 * 下面每条实现都对应一个实测结论，**不是我推测的**：
 *
 * | # | 实测结论（1.9.0 → 1.15.4 三版一致） | 这里的做法 |
 * |---|---|---|
 * | 1 | 纯 callout（无分隔符）→ **0 张卡**；callout 里写 `> ?` 也是 0 张（分隔符是**整行 trim 全等**，`"> ?"` ≠ `"?"`） | 所以 callout 版式必须靠 `==…==` 才能进复习队列 |
 * | 2 | callout 某行含 `==…==` → **1 张 Cloze 卡**，整段 callout 合成一张，`> ` 前缀无害 | `callout` 版式默认把答案包成 `==…==` |
 * | 3 | 一个 callout 内 N 个 `==…==` → 展开成 **N 张**独立卡 | 只包一处（答案行），避免一张卡裂成 N 张 |
 * | 4 | 裸 `??` 一行 → 自动生成反向卡（`expand()` 返回 side1→side2 与 side2→side1） | `review` 版式的「双向卡」开关用它 |
 * | 5 | 标签行会被**吸进卡片正面**（实测 `#flashcards / ? / 答案` → front=`"#flashcards"`） | 标签行与第一张卡之间必须是**真空行** |
 * | 6 | 卡之间用 `>` 分隔会把两张卡并成一张，**且后一张的答案漏进前一张正面** | 卡间只用真空行，绝不用 `>` |
 * | 7 | 行内含 `::` 会被当**单行卡**分隔符（子串匹配，不是整行）——实测 `std::cout 输出 :: 答案` 把正面截断 | 正文里的 `::` 插入零宽空格打断（见 `neutralizeInline`） |
 * | 8 | 整行 trim 等于 `?` / `??` 就是分隔符 | 正文里出现这种行时改成 `` `?` ``（trim 后不再全等） |
 * | 9 | Anki 风格 `{{c1:…}}` 不支持，且会被 `::` 静默劈成垃圾卡 | 同第 7 条一并失效；不生成该语法 |
 *
 * ## 关于「翻面」的实话（写进 UI 文案，不许含糊）
 *
 * Obsidian 里有两条真正可行的翻面路：
 * 1. **原生折叠 callout**：`> [!answer]-`（官方文档 Callouts.md 定义，
 *    插件完全不解析折叠标记，实测无害）。阅读视图点标题展开 —— 但
 *    **没有间隔重复调度**。代价：折叠状态下正文被隐藏，用户核对内容
 *    会以为没了，所以本导出默认用 `[!tip]`（展开），把折叠留给用户自己加。
 * 2. **Cloze 填空卡**：`==答案==` 在复习界面显示成 `[...]`，点开显形 ——
 *    这才是"翻面 + 排期"都有。所以它是 `callout` 版式的默认。
 *
 * 用户本机目前**没装**这个插件（`.obsidian/plugins` 只有 nutstore-sync，
 * `community-plugins.json` 为空），所以导出文件现在只是普通笔记；
 * 界面文案必须这么说，不能宣称"导出就能复习"。
 *
 * ## 复用已有语法，不重新发明
 *
 * `src/core/questions/obsidian-export.ts`（2026-11-12）里那份
 * `wrapFormulas` 继续用；错题导出与闪卡导出共用同一套公式包装，
 * 免得两套规则漂移。
 */

import { wrapFormulas } from '@/core/questions/obsidian-export.ts';
import type { Flashcard } from '@/core/model.ts';
import { backOf, tagsOf } from '@/core/flashcards.ts';
import { calloutKindOf, groupOfSourceKind, type CalloutKind } from '@/v2/core/callout-kind.ts';

/** 版式 */
export type ExportFormat = 'callout' | 'review';

export interface FlashcardExportOptions {
  /** 标签名（不含 #）。默认 flashcards —— 插件默认值 */
  tag?: string;
  /** 是否把疑似公式包成 `$...$`。默认 true */
  wrapFormulas?: boolean;
  /** 是否在卡片里带上来源追溯（「来自：XXX」） */
  includeSource?: boolean;
  /**
   * 版式。默认 `callout` —— 与用户 Obsidian 库里现有闪卡文件同款
   * （`信号与系统/第一章错题闪卡.md` 那种 `> [!tip] 闪卡 N｜标题`）。
   *
   * ⚠️ 单靠 callout 进不了复习队列（实测第 1 条），所以这个版式必须
   * 配合 `clozeAnswer`；两者一起才是"格式一致 + 能翻面复习"。
   */
  format?: ExportFormat;
  /**
   * callout 版式下把答案包成 `==…==`（默认 true）。
   * 关掉 = 导出成静态笔记，Obsidian 里好看但**一张都进不了复习队列**。
   */
  clozeAnswer?: boolean;
  /**
   * review 版式下用 `??`（双向，自动生成反向卡）。默认 false。
   *
   * ⚠️ 只在 `format === 'review'` 时有意义 —— callout 版式里没有
   * `?`/`??` 分隔行，`??` 无处可放（硬塞会把 callout 切断，实测）。
   * 所以 UI 上这个开关在 callout 版式下必须**禁用并说明原因**，
   * 不能摆着让人以为勾了有用（硬约束 11）。
   */
  bidirectional?: boolean;
  /**
   * 按用户标签分节（默认 true）。
   *
   * 每个标签写成一节 `#flashcards/<标签>` —— 官方文档确认嵌套标签
   * 就是插件的卡组划分方式，且"一个标签的作用域到下一个标签出现为止"，
   * 所以同一文件里可以放多个卡组。
   */
  deckByTag?: boolean;
}

const DEFAULT_TAG = 'flashcards';

/** 零宽空格：打断 `::` 子串匹配，视觉上什么都不改 */
const ZWSP = '​';

/**
 * 打断行内的 `::`（实测第 7 条）。
 *
 * ## 为什么要动用户的文字
 *
 * 插件对 `::` 是**行内子串**匹配，不是整行全等。所以
 * 「用 std::cout 输出」这种正文会被从中间劈成一张单行卡，
 * 而且**不报错** —— 用户看到的是一张残缺卡。
 * 信号与系统/高数的内容里 `::` 不常见，但一旦出现就是静默劣化。
 *
 * ## 为什么选零宽空格而不是别的
 *
 * - `\::`：反斜杠转义对 markdown 标点无效，且 `::` 子串还在，**没用**
 * - 换成全角 `：:`：改了内容本身，复制出去是错的字
 * - 零宽空格：渲染完全一致，只打断子串匹配。代价是复制粘贴会带上
 *   一个不可见字符 —— 所以导出结果里如实报告有几处（见 warnings）
 */
function neutralizeInline(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(/:{2,}/g, (run) => {
    hits += 1;
    /* 每两个冒号之间插一个零宽空格：`::` → `:<zwsp>:`，`:::` 同理 */
    return run.split('').join(ZWSP);
  });
  return { text: out, hits };
}

/**
 * 把正文里"看起来就是分隔符"的行改掉（实测第 8 条）。
 *
 * 整行 trim 等于 `?` / `??` 就是卡片分隔符 —— 用户某行只写了个问号
 * 就会被当成切卡。改成 `` `?` ``：trim 后不再全等，Obsidian 里渲染成
 * 行内代码的一个问号，意思不变。
 */
function escapeSeparatorLines(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '?' || t === '??') {
        hits += 1;
        return '`' + t + '`';
      }
      return line;
    })
    .join('\n');
  return { text: out, hits };
}

/** 正文安全化：两条实测规则一起过一遍 */
function sanitizeBody(text: string): { text: string; inlineHits: number; sepHits: number } {
  const a = escapeSeparatorLines(text);
  const b = neutralizeInline(a.text);
  return { text: b.text, inlineHits: b.hits, sepHits: a.hits };
}

/**
 * 标题行（callout 头部用）。
 *
 * ⚠️ 与 `card-rich.ts` 的 `splitFrontTitle` **同一条规则**：
 * 只有正面确实多行时，第一行才是标题；单行正面**没有标题**。
 * 那边是界面（11-23 出过"头部重述正文"的回归，每张卡中招），
 * 这边是导出 —— 规则不一致的话，导出的文件在 Obsidian 里
 * 会把同一句话写两遍（标题一次、正文一次）。
 * 所以这里宁可重复实现这段极简逻辑，也不 import UI 模块
 * （card-rich 依赖 KaTeX，纯数据路径不该拖进数学渲染层）。
 * 两边各有一条测试钉住同一个判据。
 */
function titleOfFront(front: string): { title: string | null; body: string } {
  const lines = front
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length <= 1) return { title: null, body: front.trim() };
  return { title: lines[0] ?? null, body: lines.slice(1).join('\n') };
}

/** 标题压短（导出文件名/头部用；与界面 cardTitleOf 同一取舍） */
function shortTitle(title: string, max = 40): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

/**
 * 背面里"答案在哪一行"（cloze 目标）。
 *
 * 优先 `✅` 开头那行（规范里的答案行）；没有就退回**第一行非空**；
 * 背面为空返回 -1（这张卡没法做成填空卡，要如实报告）。
 *
 * ## 为什么只包一处
 *
 * 实测第 3 条：一个 callout 里 N 个 `==…==` 会展开成 **N 张独立卡**。
 * 把要点也包上就会"导出一张、复习出现三张" —— 数量对不上。
 */
function clozeLineIndexOf(backLines: readonly string[]): number {
  for (let i = 0; i < backLines.length; i++) {
    if (/^✅/.test(backLines[i]!.trim())) return i;
  }
  for (let i = 0; i < backLines.length; i++) {
    if (backLines[i]!.trim().length > 0) return i;
  }
  return -1;
}

/** 一张闪卡的 callout 类型（与界面同一份映射） */
export function cardCalloutKind(card: Flashcard): CalloutKind {
  return calloutKindOf(
    groupOfSourceKind(card.sourceKind, !!card.knowledgePointId),
  );
}

/**
 * 一张闪卡 → 一段 callout Markdown（版式与用户库里现有文件一致）。
 *
 * `cloze` 说明这张卡在插件里靠什么进复习队列：
 * - `'answer'` 答案被包成 `==…==`（普通问答卡的默认）
 * - `'front'` 正面本来就含 `==…==`（用户手写的填空卡，原样保留）
 * - `null` 没做成填空卡（关了开关，或没有可包的背面）—— 这种卡
 *   在 Obsidian 里**不会被识别**，必须如实报告，不能静默导出。
 */
export type ClozeSource = 'answer' | 'front' | null;

export function flashcardToCalloutMarkdown(
  card: Flashcard,
  options: FlashcardExportOptions = {},
  sourceLabel?: string | null,
  index = 0,
): { md: string; cloze: ClozeSource } {
  const wrap = options.wrapFormulas !== false;
  const f = wrap ? wrapFormulas : (s: string) => s;
  const kind = cardCalloutKind(card);
  const clozeAnswer = options.clozeAnswer !== false;

  const front = sanitizeBody(f(card.frontText.trim()));
  const { title, body } = titleOfFront(front.text);

  const backRaw = backOf(card) ?? '';
  const back = sanitizeBody(f(backRaw));
  const backLines = back.text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  /* 头部：`> [!tip] 闪卡 3｜标题`；没有标题就只写编号（Obsidian 允许） */
  const head = title === null
    ? `> [!${kind}] 闪卡 ${index + 1}`
    : `> [!${kind}] 闪卡 ${index + 1}｜${shortTitle(title)}`;

  const lines: string[] = [head];

  /* 正文（正面的剩余行；单行正面就是整句） */
  for (const l of body.split('\n').filter((x) => x.trim().length > 0)) {
    lines.push(`> ${l}`);
  }

  /* 背面各行；需要 cloze 的那一行把答案部分包成 ==…== */
  /*
   * ⚠️ 正面已经含 `==…==` 时**不再包答案**（2026-11-23 实测加的防护）。
   *
   * 插件的规则是"一个 callout 内 N 个 ==…== 展开成 N 张独立卡"
   * （实测第 3 条）。那种卡本来就是用户手写的挖空卡，再包一层答案
   * 就会「导出 1 张、复习出现 2 张」—— 数量对不上，
   * 而且两张的内容互相重叠，用户会以为导出坏了。
   * 保持用户自己的挖空、不额外加，才是"导几张=复习几张"。
   */
  const frontHasCloze = /==(?:[^=\n]|=(?!=)){1,200}==/.test(front.text);
  const target = clozeAnswer && !frontHasCloze ? clozeLineIndexOf(backLines) : -1;
  let cloze: ClozeSource = frontHasCloze ? 'front' : null;
  backLines.forEach((l, i) => {
    if (i !== target) {
      lines.push(`> ${l}`);
      return;
    }
    /*
     * 只包「冒号后面的内容」，保留 `✅答案：` 这个标记前缀 ——
     * 包成全行会把标记也变成挖空，复习时 `[...]` 前面什么都不剩，
     * 用户不知道在答什么。
     */
    const m = /^([✅⚠️💡❌][^\uFF1A:]*[\uFF1A:])\s*(.+)$/u.exec(l);
    if (m) {
      lines.push(`> ${m[1]}==${m[2]}==`);
    } else {
      lines.push(`> ==${l}==`);
    }
    cloze = 'answer';
  });

  if (backLines.length === 0) {
    /*
     * 没有背面时**不省略结构**，明确写一句 ——
     * 与 review 版式同一个取舍：留白会让用户以为导出坏了。
     */
    lines.push('> （这张卡还没有写背面）');
  }

  if (options.includeSource && sourceLabel) {
    lines.push(`> *来自：${sanitizeBody(sourceLabel).text}*`);
  }

  return { md: lines.join('\n'), cloze };
}

/** 一张闪卡 → 一段 review 版式 Markdown（多行 `?` / `??`） */
export function flashcardToMarkdown(
  card: Flashcard,
  options: FlashcardExportOptions = {},
  sourceLabel?: string | null,
): string {
  const wrap = options.wrapFormulas !== false;
  const f = wrap ? wrapFormulas : (s: string) => s;

  const front = sanitizeBody(f(card.frontText.trim()));
  const lines: string[] = [front.text];

  /*
   * 分隔符必须单独一行 —— 这是插件识别多行卡的唯一依据（实测整行 trim 全等）。
   * `??` 会额外生成一张反向卡（实测 expand() 返回两张）。
   */
  const sep = options.format === 'review' && options.bidirectional ? '??' : '?';
  lines.push(sep);

  const back = sanitizeBody(f(backOf(card) ?? ''));
  if (back.text.trim().length > 0) {
    lines.push(back.text);
  } else {
    /*
     * 没有背面时不省略结构，而是明确写一句。
     *
     * 为什么：插件要求 `?` 两边都有内容，只有正面没有反面的卡
     * 在复习时翻开来是空的。写一句「（这张卡还没有写背面）」
     * 比留白诚实 —— 用户能一眼看出「这张卡我在应用里就没写背面」，
     * 而不是以为导出坏了。
     */
    lines.push('（这张卡还没有写背面）');
  }

  if (options.includeSource && sourceLabel) {
    lines.push('');
    lines.push(`*来自：${sanitizeBody(sourceLabel).text}*`);
  }

  return lines.join('\n');
}

/** 一整份文件的导出结果 */
export interface FlashcardsExportResult {
  content: string;
  /** 导出的卡数（= 传进来的卡数） */
  count: number;
  /** 每个卡组的卡数（标签归档时 > 1） */
  decks: { tag: string; count: number }[];
  /**
   * 如实说明（界面要显示，不许吞）。
   * 例如「3 张卡没写背面，导出后翻面是空的」「2 张卡正文含 ::，已插入零宽空格」。
   */
  warnings: string[];
}

/**
 * 一批闪卡 → 一个 .md 文件的完整内容。
 *
 * 结构：
 *   ---
 *   title: "..."
 *   ---
 *
 *   #flashcards/标签A
 *
 *   卡片1
 *   （真空行）
 *   卡片2
 *
 *   #flashcards/标签B
 *
 *   卡片3
 *
 * 为什么要有 frontmatter：Obsidian 里一个文件可能同时是笔记和卡片集，
 * 有 title 才能在「快速切换」里按名字找到它。
 *
 * ⚠️ 标签行与第一张卡之间必须是**真空行**（实测第 5 条：
 * 少了那个空行，`#flashcards` 这行会被吸进第一张卡的正面）。
 * 卡与卡之间同理（实测第 6 条：用 `>` 分隔会把两张并成一张，
 * 还会把后一张的答案漏进前一张）。
 */
export function flashcardsToObsidianMarkdown(
  title: string,
  cards: readonly Flashcard[],
  options: FlashcardExportOptions = {},
  sourceLabelOf?: (card: Flashcard) => string | null,
): FlashcardsExportResult {
  const tag = options.tag ?? DEFAULT_TAG;
  const format: ExportFormat = options.format ?? 'callout';
  const clozeAnswer = options.clozeAnswer !== false;
  const byTag = options.deckByTag !== false && format === 'callout';

  /** 如实说明（界面要显示，不许吞） */
  const warnings: string[] = [];
  const pushWarning = (s: string) => {
    if (warnings.indexOf(s) < 0) warnings.push(s);
  };

  /* ---------- 分卡组 ---------- */
  type Bucket = { tag: string; cards: Flashcard[] };
  const buckets: Bucket[] = [];
  let untagged = 0;

  if (!byTag || cards.length === 0) {
    /*
     * 空列表也走这一支（2026-11-23 补）。
     *
     * ⚠️ 原来空列表 + byTag 会进 else 分支，map 是空的 → buckets 一个都没有
     * → 导出的文件**连 `#flashcards` 标签行都没有**，在 Obsidian 里
     * 就是一篇普通笔记、进不了任何卡组。空库时点导出会得到这种废文件。
     */
    buckets.push({ tag, cards: [...cards] });
  } else {
    const map = new Map<string, Flashcard[]>();
    for (const c of cards) {
      const ts = tagsOf(c);
      /*
       * 一张卡多个标签时，只进**第一个**标签的卡组。
       *
       * ⚠️ 为什么不全进：官方文档里"一个标签的作用域到下一个标签为止"，
       * 同一张卡写进两节 = 插件里出现两张同名卡，复习时会被排两次。
       * 界面不承诺"多标签进多卡组"，所以这里也不做
       * （说了没做 / 做了没说，两个方向都算假开关）。
       */
      const key = ts.length > 0 ? `${tag}/${ts[0]}` : tag;
      if (ts.length === 0) untagged += 1;
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    /* 默认卡组（没标签的）排最后，用户先看到自己分好的组 */
    for (const [t, list] of [...map.entries()].sort((a, b) => {
      if (a[0] === tag) return 1;
      if (b[0] === tag) return -1;
      return a[0].localeCompare(b[0], 'zh-Hans-CN');
    })) {
      buckets.push({ tag: t, cards: list });
    }
    if (untagged > 0) {
      pushWarning(`有 ${untagged} 张卡没打标签，导出后落在默认卡组 #${tag} 里。`);
    }
  }

  /* ---------- 逐张渲染（统计在同一次遍历里做，不重复渲染） ---------- */
  let noBack = 0;
  let inlineHits = 0;
  let sepHits = 0;
  let notClozed = 0;

  const bodies: string[] = [];
  let n = 0;
  for (const b of buckets) {
    const cardBodies: string[] = [];
    for (const c of b.cards) {
      const label = sourceLabelOf?.(c) ?? null;
      const back = backOf(c);
      if (!back || back.trim().length === 0) noBack += 1;

      /* 安全化统计：对这张卡的正文算一次（渲染内部也会做，这里只为计数） */
      const stat = sanitizeBody(c.frontText + '\n' + (back ?? ''));
      inlineHits += stat.inlineHits;
      sepHits += stat.sepHits;

      if (format === 'callout') {
        const r = flashcardToCalloutMarkdown(c, options, label, n);
        cardBodies.push(r.md);
        /*
         * 只有"既没包答案、正面也没有填空"才算进不了复习队列。
         * `cloze === 'front'`（用户手写的挖空卡）是正常态，不计。
         */
        if (r.cloze === null && back && back.trim().length > 0) notClozed += 1;
      } else {
        cardBodies.push(flashcardToMarkdown(c, options, label));
      }
      n += 1;
    }

    /*
     * ⚠️ 卡与卡之间必须是**真空行**（join('\n\n')），不是单换行 ——
     * 插件的断卡规则是"空行结束一张卡"（实测第 6 条）。
     *
     * 这里曾写成 `section.join('\n')`，实测结果：**导出 5 张卡、
     * 插件只认 1 个 question**（整节的卡全粘成一张，后一张的答案
     * 还会漏进前一张的正面）。`toContain('#flashcards')` 那种断言
     * 完全抓不到 —— 它只查标签在不在，不查卡有没有被切开。
     * 所以 flashcard-export.test.ts 里另有一条结构断言
     * （"连续非空行只属于一张卡"），它是照插件的断卡规则写的。
     */
    bodies.push([`#${b.tag}`, '', cardBodies.join('\n\n'), ''].join('\n'));
  }

  const header = ['---', `title: ${JSON.stringify(title)}`, '---', ''].join('\n');

  if (noBack > 0) {
    pushWarning(`有 ${noBack} 张卡没写背面，导出后那一面会写明「还没有写背面」。`);
  }
  if (format === 'callout' && !clozeAnswer) {
    pushWarning(
      '没开「答案包成填空」：callout 版式在 Obsidian 里一张都进不了复习队列' +
        '（插件不认 callout 里的 ?，实测确认）。要复习请开这个开关或改用问答版式。',
    );
  }
  if (format === 'callout' && notClozed > 0) {
    pushWarning(`其中 ${notClozed} 张卡有背面但没能做成填空卡（答案行格式不认识），它们在 Obsidian 里不会被识别。`);
  }
  if (inlineHits > 0) {
    pushWarning(
      `有 ${inlineHits} 处正文含 ::，已插入零宽空格避免被插件当成单行卡切错` +
        '（复制文字时会带上这个不可见字符）。',
    );
  }
  if (sepHits > 0) {
    pushWarning(`有 ${sepHits} 行正文只有一个问号，已改成行内代码避免被当成卡片分隔符。`);
  }

  /* 节与节、卡与卡之间都是真空行（实测第 6 条：绝不能用 '>'） */
  const content = header + bodies.join('\n') + '\n';

  return {
    content,
    count: cards.length,
    decks: buckets.map((b) => ({ tag: b.tag, count: b.cards.length })),
    warnings,
  };
}

/**
 * 文件名。
 *
 * 与题组导出同一个规则：去掉 Windows/Linux/macOS 都不允许的字符，
 * 并限长（Obsidian 对超长文件名在部分同步盘上会出问题）。
 */
export function flashcardFileName(title: string, stamp?: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const suffix = stamp ?? new Date().toISOString().slice(0, 10);
  return `${safe || '闪卡'} · ${suffix}.md`;
}
