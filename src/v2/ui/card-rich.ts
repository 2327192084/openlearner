/**
 * 闪卡的富文本渲染（2026-11-22，用户给了 Obsidian callout 参考图）。
 *
 * ## 为什么不能直接扩展 `MathText`
 *
 * `MathText` 被阅读器、题目页、答疑面板等**多处**使用（grep 到 6+ 处）。
 * 往它里面加 markdown 解析，等于把所有调用方一起改掉 ——
 * 而阅读器里的正文本来就有大量 `*`（列表、强调、公式里的乘号），
 * 改了会出意料之外的渲染。
 *
 * 所以这里做一层**只给闪卡用**的富文本：先按行切，每行再交给
 * `splitMath` + `renderMath` 处理数学。数学的老逻辑一行不动。
 *
 * ## 支持什么（按用户给的图三反推）
 *
 * | 写法 | 来源 | 渲染成 |
 * |---|---|---|
 * | `**题目**` | AI 写的背面条目标题 | 加粗 |
 * | `1. xxx` / `2. xxx` | 要点列表 | 有序列表项 |
 * | `✅答案：…` | AI 的答案行 | 绿色标记行 |
 * | `💡要点：…` | AI 的要点标题 | 蓝色标记行 |
 * | `⚠️限制条件：…` | AI 的警示行 | 橙色标记行 |
 * | `$$…$$` / `$…$` | LaTeX | 交给 renderMath（公式段不碰 markdown） |
 *
 * ## ⚠️ 一条重要原则：解析不了就原样显示
 *
 * 与 `render-math.ts` 同一套取舍：渲染失败时**保留原文**，
 * 宁可用户看到 `**题目**` 也不要看到空白或错乱的内容。
 * 卡片文字是用户的学习材料，不能因为渲染器的问题丢内容。
 */

import { escapeHtml, renderMath, splitMath } from './render-math.ts';

/** 一行的角色（决定样式） */
export type LineRole =
  | 'plain'
  | 'answer' /** ✅ */
  | 'point' /** 💡 */
  | 'warn' /** ⚠️ */
  | 'ordered' /** 1. 2. 3. */
  | 'bullet'; /** - • */

/** 切好的一行 */
export interface RichLine {
  /** 原文（未渲染） */
  raw: string;
  role: LineRole;
  /** 去掉 emoji 前缀后的正文（用于渲染） */
  body: string;
  /** 有序列表的编号（bullet 为 null） */
  order: number | null;
}

/** 渲染好的一行（HTML 片段） */
export interface RenderedLine extends RichLine {
  /** 已含 KaTeX 与 <strong> 的 HTML */
  html: string;
}

/**
 * 标记行的 emoji 前缀。
 *
 * ⚠️ 只认**行首**的这几个，且要求后面紧跟文字或冒号。
 * 正文中间出现的 ✅ 不算标记行（否则一句"答案对 ✅"会变绿）。
 */
const ROLE_PREFIX: { re: RegExp; role: LineRole }[] = [
  { re: /^✅\s*(.*)$/, role: 'answer' },
  { re: /^💡\s*(.*)$/, role: 'point' },
  /* ⚠ 有两种写法（带 / 不带变体选择符 U+FE0F），都认 */
  { re: /^⚠\uFE0F?\s*(.*)$/, role: 'warn' },
];

/** 有序列表：`1. xxx` / `1、xxx` / `1) xxx` */
const RE_ORDERED_DOT = /^(\d{1,3})\.\s+(.+)$/;
const RE_ORDERED_CJK = /^(\d{1,3})[、)]\s*(.+)$/;
/** 无序列表：`- xxx` / `• xxx` / `* xxx` */
const RE_BULLET = /^[-•]\s+(.+)$/;

/**
 * 把一段文本切成行并判定角色。
 *
 * 空行被丢掉（卡片里空行只是排版，渲染成空白行会让卡片虚高）。
 */
export function splitRichLines(text: string): RichLine[] {
  const out: RichLine[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    /* 标记行 */
    let matchedRole = false;
    for (const { re, role } of ROLE_PREFIX) {
      const m = re.exec(line);
      if (m) {
        out.push({ raw: line, role, body: (m[1] ?? '').trim(), order: null });
        matchedRole = true;
        break;
      }
    }
    if (matchedRole) continue;

    /*
     * 有序列表：先试 `1.` 这种（要求点后必须有空白），
     * 再试 `1、` / `1)` 这种（中文顿号列表常不写空格）。
     *
     * ⚠️ 顺序不能反：`1.8 极限` 要靠"点后要有空白"这条挡住。
     */
    const ord = RE_ORDERED_DOT.exec(line) ?? RE_ORDERED_CJK.exec(line);
    if (ord) {
      const n = Number(ord[1]);
      /*
       * 编号超过 20 的不当列表 —— 那多半是正文以数字开头
       * （"2024 年的真题…"），不是第 2024 项。
       */
      if (Number.isFinite(n) && n >= 1 && n <= 20) {
        out.push({ raw: line, role: 'ordered', body: (ord[2] ?? '').trim(), order: n });
        continue;
      }
    }

    /* 无序列表 */
    const bul = RE_BULLET.exec(line);
    if (bul) {
      out.push({ raw: line, role: 'bullet', body: (bul[1] ?? '').trim(), order: null });
      continue;
    }

    out.push({ raw: line, role: 'plain', body: line, order: null });
  }

  return out;
}

/**
 * 行内 markdown：`**加粗**` 与 `` `代码` ``。
 *
 * ## 前提：传进来的必须是**已转义**的文本
 *
 * 调用方（`renderRichLine`）对**非公式段**先做了 `escapeHtml` 再传进来。
 * 所以这里**不再转义** —— 再转一次会变成 `&amp;amp;lt;` 那种双重转义。
 *
 * （函数名参数叫 `escaped` 就是这个约定。）
 *
 * 处理顺序：先行内代码（里面的 `*` 不该被当加粗），再加粗。
 *
 * ## 为什么不认 `_斜体_`
 *
 * 数学文本里下标极常见（`x_1`、`a_{ij}`），`_` 一旦当强调符就会
 * 把公式吃掉。图三里也没有斜体。
 */
export function renderInlineMarkdown(escaped: string): string {
  /* 行内代码：`xxx` */
  const withCode = escaped.replace(/`([^`]+)`/g, (_all, inner: string) => {
    return `<code class="fcrich__code">${inner}</code>`;
  });

  /* 加粗：**xxx** */
  return withCode.replace(/\*\*([^*]+)\*\*/g, (_all, inner: string) => {
    return `<strong class="fcrich__strong">${inner}</strong>`;
  });
}

/**
 * 渲染一行：先按公式切段，**markdown 只作用于非公式段**。
 *
 * ## 为什么不能"先整行渲染数学，再对 HTML 做 markdown"
 *
 * 我一开始就是这么写的，然后用 KaTeX 实测否掉了自己：
 *
 *   renderToString('a ** b')  → 输出里**真的有连续的 `**`**
 *
 * （LaTeX 里 `*` 是合法字符，`throwOnError:false` 下原样进文本节点。）
 * 那种做法会把公式里的 `**` 转成 `<strong>`，把公式渲染弄坏。
 * 而"按 HTML 标签切段"也救不了 —— 那些星号本来就在标签**内部**的文本里。
 *
 * ## 现在的做法
 *
 * 1. `splitMath(body)` 切成「公式段 / 非公式段」
 * 2. 公式段 → `renderMath`（原样交给 KaTeX，不碰）
 * 3. 非公式段 → 先 `escapeHtml` 再做 markdown
 * 4. 拼起来
 *
 * 这样 markdown 永远进不了公式内部，转义也只由我们这一层负责一次。
 * 与 `renderTextWithMath` 的取舍一致：**公式渲染失败就退回原文**
 * （宁可看到 `$...$` 也不要看到 KaTeX 的红色错误块）。
 */
export function renderRichLine(line: RichLine): RenderedLine {
  const parts = splitMath(line.body);

  const html = parts
    .map((p) => {
      if (!p.math) return renderInlineMarkdown(escapeHtml(p.value));

      const rendered = renderMath(p.value, p.block);
      if (rendered === null) {
        /* 退回原文并转义 —— 用户至少能看出"这里原本有个公式" */
        return escapeHtml(p.block ? `$$${p.value}$$` : `$${p.value}$`);
      }
      return rendered;
    })
    .join('');

  return { ...line, html };
}

/** 整段渲染 */
export function renderRichText(text: string): RenderedLine[] {
  return splitRichLines(text).map(renderRichLine);
}

/**
 * 把正面拆成「标题行 + 正文」（2026-11-23 修正）。
 *
 * ## 为什么必须有这一层（我上一版做错了）
 *
 * 上一版是「标题 = 正面的第一行（截断）」，然后**正文仍然渲染整段正面**。
 * 结果截图里每张卡都出现同一句话两遍：
 *
 *   头部：两个周期信号之和的周期性取决于周期之比：若为有理数…
 *   正文：两个周期信号之和的周期性取决于周期之比：若为有理数，和仍为…
 *
 * 用户库里的卡正面**基本都是单行长句**（实测第一张 66 字、只有一行），
 * 所以这个重复不是边角情况，是每张卡都中招。
 * 与项目里「chapter 与正文第一行重复出现两次」是同一类错误。
 *
 * ## 现在的规则
 *
 * **只有正面确实有多行时，第一行才算标题。**
 *
 * - 多行正面 → 第一行当标题，其余当正文（对应图三那种
 *   「题1.8 1∞无穷远处极限」+ 下面「**题目** / 答案 / 要点」）
 * - 单行正面 → **没有标题**（`title: null`），整句就是正文
 *
 * 单行时不硬造标题：callout 头部本来就允许只有类型没有标题
 * （Obsidian 里 `[!tip]` 后面不写标题也是合法的）。
 * 宁可头部只有「知识点 ｜ 闪卡 3」，也不把正文重述一遍。
 */
export function splitFrontTitle(front: string): { title: string | null; body: string } {
  const lines = front
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length <= 1) {
    return { title: null, body: front.trim() };
  }

  return { title: lines[0] ?? null, body: lines.slice(1).join('\n') };
}

/**
 * 把标题行压短用于头部显示（标题本身也可能是一整句）。
 *
 * 只在 `splitFrontTitle` 判定**确实有标题**时调用 ——
 * 单行正面不该有标题（那会把正文重述一遍，见上面的说明）。
 */
export function cardTitleOf(front: string, max = 46): string {
  const first = front.split('\n')[0]?.trim() ?? '';
  if (first.length === 0) return '（没有正面）';
  if (first.length <= max) return first;

  const head = first.slice(0, max);
  const m = /[，。；：、,.;:（(）)\s]/g;
  let lastCut = -1;
  let match: RegExpExecArray | null;
  while ((match = m.exec(head)) !== null) lastCut = match.index;
  if (lastCut >= 8) return head.slice(0, lastCut) + '…';
  return head + '…';
}

/**
 * 该用哪种 callout 类型。
 *
 * 用户只给了**错题卡**的格式（`[!tip]`）。知识点卡与手写卡按同样思路配：
 *
 * | 组 | callout | 理由 |
 * |---|---|---|
 * | `wrong` 错题 | `tip` | 用户给的就是这个；错题是"要点提醒"性质 |
 * | `point` 知识点 | `note` | 知识点是中性陈述，不该用提示色抢注意力 |
 * | `manual` 手写 | `quote` | 自己写的更像摘录/自述，用引文样式 |
 *
 * 类型只影响**色条与图标**，不改内容排版 —— 三种卡片的正文结构一致，
 * 用户切换组别时不会看到版式跳变。
 */
export type CalloutKind = 'tip' | 'note' | 'quote';

export function calloutKindOf(group: 'point' | 'wrong' | 'manual'): CalloutKind {
  if (group === 'wrong') return 'tip';
  if (group === 'point') return 'note';
  return 'quote';
}

/** callout 头部图标（与 Obsidian 的语义一致） */
export const CALLOUT_ICON: Record<CalloutKind, string> = {
  tip: '🔗',
  note: '📘',
  quote: '✏️',
};

/** 供测试与调试用：转义（导出避免各处重复实现） */
export { escapeHtml };