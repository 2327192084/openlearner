/**
 * 导入 Obsidian Callout 闪卡（2026-11-24）。
 *
 * ## 为什么只认 Callout
 *
 * 用户库里现有的闪卡就是这种版式（他 2026-11-23 亲口说"你可以读取
 * obsidian 的闪卡来制定编写规范"），而且**本应用导出的也是这种**，
 * 所以导入与导出能往返 —— 换台机器、换块库，卡搬得过去。
 *
 * 认两种真实版式（都在用户库里出现过）：
 *
 * 1. **平铺**（主力，信号与系统 / 高数 极限错题闪卡）：
 *    ```
 *    > [!tip] 闪卡 1｜题1.8 复指数
 *    > **题目**
 *    > $$...$$
 *    > ✅答案：...
 *    > 💡要点：...
 *    ```
 * 2. **嵌套**（高数 / 数列极限错题闪卡）：
 *    ```
 *    > [!question] 2.2
 *    > **题目**：...
 *    > > [!answer] ✅答案：A
 *    > > 知识点：...
 *    ```
 *
 * ## 切分规则（与导出器同一条判据）
 *
 * - 头部 `> [!tip] 闪卡 3｜标题` → **标题**取 `｜` 后面的部分；
 *   `闪卡 N` 是导出器写的编号，导回来要剥掉，否则往返一次标题就变成
 *   「闪卡 1｜…」，再导出变成「闪卡 1｜闪卡 1｜…」。
 * - 正文按**答案标记行**切成正面 / 背面：第一个以 `✅`/`💡`/`⚠`/`❌`
 *   开头的行是背面的开始（与 `card-rich.ts` 的 ROLE_PREFIX 同一套标记）。
 * - 没有答案标记也没有嵌套 answer 的（如 `> [!warning] 核心规则卡｜…`
 *   那种整段是规则的卡）：**标题当正面、正文当背面** —— 规则卡的正问是
 *   "这条规则是什么"，答是规则全文。整段塞正面会让用户翻卡时一眼看到答案。
 *
 * ## 为什么标签行不写进卡里
 *
 * `#flashcards/高数` 这行是**分节标题**（导出器按标签分卡组写的）。
 * 它必须被识别成"后面这些卡的标签"，而不是卡片正文 ——
 * Obsidian Spaced Repetition 实测第 5 条：标签行会被吸进卡片正面。
 * 我们导回去的时候按它重建卡组，所以这里也要按它赋标签。
 */

import type { CardGroup } from './callout-kind.ts';

/** 从文件里解析出来的一张卡（还没进库） */
export interface ImportedCard {
  /** 正面（多行时第一行是标题，与导出器 titleOfFront 同一规则） */
  front: string;
  /** 背面；null = 没有答案内容 */
  back: string | null;
  /** 从 `#flashcards/xxx` 分节标题继承来的标签 */
  tags: string[];
  /** 这个 callout 从第几行开始（1 起），预览与告警用 */
  line: number;
}

export interface ImportParseResult {
  cards: ImportedCard[];
  /** 文件里出现过的卡组标签（去重、保序） */
  tags: string[];
  /** 没被当成卡的行数（正文说明、空行、标题等）—— 只用于如实汇报 */
  ignoredLines: number;
  /** 告警：不是错误，是"这几张可能不完整" */
  warnings: string[];
}

/** `> [!tip]- 闪卡 1｜标题` —— 折叠标记 `-`/`+` 允许出现 */
const RE_CALLOUT_HEAD = /^>\s*\[!([A-Za-z][\w-]*)\]([-+])?\s*(.*)$/;
/** 分节标题：`#flashcards` 或 `#flashcards/高数` */
const RE_TAG_HEAD = /^#flashcards(?:\/(.+))?$/i;
/** 背面开始的行（四种标记，与 card-rich.ts 的 ROLE_PREFIX 同一套） */
const RE_ANSWER_LINE = /^(✅|💡|⚠|❌)/;
/** 剥掉导出器写的「闪卡 N｜」编号前缀，以及规则卡的前缀。 */
const RE_EXPORT_TITLE = /^(?:(?:闪卡\s*\d+)|核心规则卡|规则卡)\s*(?:[｜|:：]\s*)?/;

/**
 * 导出器给"没有背面"的卡写的占位句。
 *
 * `flashcard-export.ts` 在两个版式里都写「（这张卡还没有写背面）」，
 * 因为空 callout 在 Obsidian 里翻开来是纯白的。导回来时要把这句认成
 * 「没有背面」，否则往返一次每张空背面的卡都凭空多出一句占位话，
 * 用户再导出时它就变成真的背面内容了 —— 越搬越脏。
 */
const BACK_PLACEHOLDER = '（这张卡还没有写背面）';

/** 去掉一层引用前缀（`> ` / `>`），保留其余原样 */
function stripQuote(line: string): string {
  return line.replace(/^\s*>\s?/, '');
}

/** 去掉首尾的空行（中间的空行保留 —— 那可能是用户排版的一部分） */
function trimBlankEdges(lines: readonly string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a += 1;
  while (b > a && lines[b - 1]!.trim() === '') b -= 1;
  return lines.slice(a, b);
}

/**
 * 读一个 callout 块的**正文行**（不含头部行）。
 *
 * ⚠️ 必须从 `start + 1` 开始：头部那行 `> [!tip] 闪卡 7｜导数定义`
 * 的标题已经单独解析过了，再收进正文就会让正面变成
 * `导数定义\n[!tip] 闪卡 7｜导数定义`（标题写两遍）。
 */
function readBlock(lines: readonly string[], start: number): { rows: string[]; next: number } {
  const rows: string[] = [];
  let i = start + 1;
  while (i < lines.length && /^\s*>/.test(lines[i]!)) {
    rows.push(lines[i]!);
    i += 1;
  }
  return { rows, next: i };
}

/**
 * 解析一段 Markdown 里的 Callout 闪卡。
 *
 * 纯函数：不读文件、不碰存储。文件读取在调用方（UI）做 ——
 * 这样解析规则能被单测直接钉住，也能在 Node 里跑。
 *
 * @param markdown 文件全文
 * @param options.defaultTags 文件里没有 `#flashcards/xxx` 时用的标签（一般是空）
 */
export function parseFlashcardMarkdown(
  markdown: string,
  options: { defaultTags?: readonly string[] } = {},
): ImportParseResult {
  const cards: ImportedCard[] = [];
  const warnings: string[] = [];
  const tagOrder: string[] = [];
  let ignoredLines = 0;

  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  /** 当前分节标签（`#flashcards/xxx` 之后的所有卡） */
  let sectionTags: string[] = [...(options.defaultTags ?? [])];

  let i = 0;
  /* 跳过 YAML frontmatter（导出器写的 `--- title: ... ---`） */
  if (lines[0]?.trim() === '---') {
    for (let j = 1; j < lines.length; j += 1) {
      if (lines[j]!.trim() === '---') {
        i = j + 1;
        break;
      }
    }
  }

  for (; i < lines.length; ) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (trimmed === '') {
      i += 1;
      continue;
    }

    /* 分节标题：`#flashcards/高数` */
    const tagHit = RE_TAG_HEAD.exec(trimmed);
    if (tagHit) {
      const name = (tagHit[1] ?? '').trim();
      sectionTags = name ? [name] : [];
      if (name && tagOrder.indexOf(name) < 0) tagOrder.push(name);
      i += 1;
      continue;
    }

    const head = RE_CALLOUT_HEAD.exec(raw);
    if (!head) {
      /* 普通正文 / markdown 标题 / 普通引用 —— 不是卡，如实计数 */
      ignoredLines += 1;
      i += 1;
      continue;
    }

    const { rows, next } = readBlock(lines, i);
    i = next;

    const headRest = (head[3] ?? '').trim();
    const title = headRest.replace(RE_EXPORT_TITLE, '').trim();

    /* 一层引用剥掉后的内容 */
    const level1 = rows.map(stripQuote);

    /*
     * 先滤掉导出器写的「没有背面」占位句（见 BACK_PLACEHOLDER）。
     *
     * ⚠️ 必须在切正背面**之前**滤：那张卡的正面是单行、没有标题，
     * 占位句又不以 ✅/💡/⚠/❌ 开头，答不出"答案从哪开始"，
     * 于是整段（正面 + 占位句）都会被拼进正面。
     */
    const content = level1.filter((l) => l.trim() !== BACK_PLACEHOLDER);

    /*
     * 嵌套 callout（版式2）：`> > [!answer] …`
     * 找到第一个嵌套头，之前的算正面、之后的算背面。
     */
    const nestedAt = content.findIndex((l) => RE_CALLOUT_HEAD.test(l));
    const outerRows = nestedAt >= 0 ? content.slice(0, nestedAt) : content;
    const outer = trimBlankEdges(outerRows);

    let front: string;
    let back: string | null = null;

    if (nestedAt >= 0) {
      const nestedRows = content.slice(nestedAt);
      const nestedHead = RE_CALLOUT_HEAD.exec(nestedRows[0]!)!;
      const nestedRest = (nestedHead[3] ?? '').trim();
      const nestedBody = trimBlankEdges(nestedRows.slice(1).map(stripQuote));
      const backLines = [
        ...(nestedRest ? [nestedRest] : []),
        ...nestedBody,
      ];
      back = backLines.length > 0 ? backLines.join('\n') : null;
      front = [title, ...outer].filter((s) => s.length > 0).join('\n');
    } else {
      const answerAt = outer.findIndex((l) => RE_ANSWER_LINE.test(l.trim()));
      if (answerAt >= 0) {
        const frontLines = trimBlankEdges(outer.slice(0, answerAt));
        const backLines = trimBlankEdges(outer.slice(answerAt));
        back = backLines.length > 0 ? backLines.join('\n') : null;
        front = [title, ...frontLines].filter((s) => s.length > 0).join('\n');
      } else if (title) {
        /*
         * 没有答案标记但有标题 —— 规则卡（`> [!warning] 核心规则卡｜…`）。
         * 标题当正面、正文当背面：整段塞正面会让翻卡时一眼看到答案。
         */
        front = title;
        back = outer.length > 0 ? outer.join('\n') : null;
      } else {
        front = outer.join('\n');
        if (front.trim()) {
          warnings.push(
            `第 ${i - rows.length + 1} 行那张卡没找到答案行（✅/💡/⚠/❌），整段当成正面了。`,
          );
        }
      }
    }

    if (!front.trim()) {
      ignoredLines += rows.length;
      continue;
    }

    /*
     * 占位句还原成「没有背面」（见 BACK_PLACEHOLDER 注释）。
     * 只在整段背面**就是**那句占位时才还原 —— 用户真在背面里写了别的内容，
     * 那句留着是他自己的正文，不该替他删。
     */
    if (back) {
      const backOnly = back
        .split('\n')
        .map((l) => stripQuote(l).trim())
        .filter((l) => l.length > 0 && l !== BACK_PLACEHOLDER);
      back = backOnly.length === 0 ? null : back;
    }

    cards.push({
      front: front.trim(),
      back: back && back.trim() ? back.trim() : null,
      tags: [...sectionTags],
      line: i - rows.length + 1,
    });
  }

  return { cards, tags: tagOrder, ignoredLines, warnings };
}

/**
 * 展示分组 → 数据层的 `sourceKind`。
 *
 * 与 `callout-kind.ts` 的 `groupOfSourceKind` 是**反向**映射，
 * 故意放在这里而不是 core 共享：那边是"读旧数据怎么归组"，
 * 这里是"新建的卡按用户选的组写成什么"。两个方向的默认值不一样
 * （旧卡没字段时靠 knowledgePointId 推断，新卡是用户明确选的），
 * 硬合成一个双向函数反而容易两边都错。
 */
export function sourceKindOfGroup(group: CardGroup): 'point' | 'wrong' | 'manual' {
  if (group === 'point') return 'point';
  if (group === 'wrong') return 'wrong';
  return 'manual';
}
