/**
 * 从资料正文里提取「目录」（2026-11-21 深夜）。
 *
 * ## 为什么需要它
 *
 * 用户改了口径：
 *
 * > 学习路线应该依据资料本体进行构建。对有目录的资料，依据目录内容
 * > 分析出所学科目，自主分析配合网上检索规划学习路线。
 *
 * 而**资料里没有现成的「目录」字段**：`Source` 只有标题/页数，
 * `SourceSegment.chapter` 是解析时用启发式猜的（`parsers/pdf.ts` 的
 * `detectChapter`：第一行短、不以句号结尾就当章节名）。
 *
 * 实测用户真实库（2026-11-21）：
 *
 * | 资料 | 页 | 解析出的章节 | 真实情况 |
 * |---|---|---|---|
 * | 信号与系统 第1章 | 36 | 「第1章 信号与系统」 | 这份**只有第 1 章** |
 * | 高等数学 第7版 上 | 442 | 内容提要/前言/…/目录 | 正文各章**没进库** |
 * | 课程知识点一(pptx) | 86 | 5 个 | 第 2 段是 `CONTENTS 目 录 …` |
 *
 * 所以「有没有目录」必须**从正文里认**，不能指望 chapter 字段。
 *
 * ## 三种目录形态（都要认）
 *
 * 1. **目录页**：正文里明写「目录」/「目 录」/「CONTENTS」，后面跟章节条目
 * 2. **章节标记**：正文里出现 `第3章 xxx` / `3.1 xxx` 这类标题行
 * 3. **两者都没有**：这份资料是片段（如「第1章 信号与系统」本身）
 *
 * 三种情况的后续路径完全不同（目录页→能推断整本书结构；
 * 只有章节标记→只能推断到本资料范围；都没有→必须问用户科目），
 * 所以这里如实区分，合并成一个「有/没有」会丢掉用户最需要的那条信息。
 *
 * ## 纯函数
 *
 * 不碰 I/O、不碰网络。入参是段数组，出参是结构与判断。
 */

import type { SourceSegment } from '@/core/model.ts';

/**
 * 一份资料的目录结构。
 *
 * `kind` 是这里最重要的字段 —— 它决定后面走哪条路。
 */
export interface SourceOutline {
  /**
   * 目录可信度。
   *
   * - `toc-page`：正文里有真的目录页（最可信，能推断整本书范围）
   * - `chapter-marks`：没有目录页，但正文里有章节标题标记
   * - `none`：两者都没有（片段资料，或解析不完整）
   */
  kind: 'toc-page' | 'chapter-marks' | 'none';
  /** 目录条目（章节标题），按出现顺序去重 */
  entries: string[];
  /** 目录页在第几段（0 基）；只有 kind === 'toc-page' 时有值 */
  tocAt: number | null;
  /**
   * 正文里出现的最高章号（1 基）。0 表示没认出来。
   *
   * 这是**边界判断的关键**：「这份资料只到第 1 章」时，
   * 路线绝不能排到第 2 章去（用户明确点名了这个问题）。
   */
  maxChapterNumber: number;
  /**
   * 正文里出现的章号集合（升序）。
   *
   * 与 `maxChapterNumber` 的区别：有些资料是**节选**，
   * 章号不连续（只有第 1、5、7 章）。这时「最高到第 7 章」
   * 不等于「1~7 章都有」—— 边界判断要按集合，不能按区间。
   */
  chapterNumbers: number[];
  /**
   * ⚠️ **正文里实际出现**的章号（不含只在目录页里声明过的）。
   *
   * ## 为什么必须与 `chapterNumbers` 分开
   *
   * 实测用户真实库那份《信号与系统 第1章》：它的目录页列的是
   * 整本教材的 8 章，但这份 PDF **只收录了第 1 章**。
   *
   * 如果边界按 `chapterNumbers`（含目录声明的）算，就会得到 1~8，
   * 于是路线排出第 2~8 章 —— 而那些内容资料里根本没有。
   *
   * 这正是用户点名的问题：
   * > 用户学习高等数学，但资料只解析/涉及了第一章，
   * > 但路线规划却规划了第一章后的内容
   *
   * 所以**边界必须按这一项**：它只认正文里真出现过的章号。
   */
  contentChapterNumbers: number[];
}

/** 目录页特征词。中文书里常见写法有好几种（含全角空格） */
const TOC_MARKERS = [
  '目录',
  '目 录',
  '目　录',
  'contents',
  'table of contents',
  'mulu',
];

/**
 * 章节标题行的正则。
 *
 * 只认这几种教材常见写法，宁窄勿宽 —— 放宽会把正文里
 * 「第 3 章讲的三个方法…」这种句子也当成章节标题。
 *
 * 关键约束：**行首**且**顶层编号**（第N章 / Chapter N）。
 * `3.1 极限` 这种节级编号在 `parseTocEntries` 里被显式跳过。
 */
const CHAPTER_RE = /^[ \t]*第[ \t]*([0-9一二三四五六七八九十百]+)[ \t]*章/m;
const CHAPTER_EN_RE = /^[ \t]*chapter[ \t]*([0-9]+)/im;

/** 中文数字转阿拉伯（只覆盖教材章号会出现的范围） */
const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnToNum(cn: string): number | null {
  if (/^[0-9]+$/.test(cn)) return Number(cn);
  if (cn.length === 1) return CN_DIGIT[cn] ?? null;
  if (cn === '百') return 100;
  /* 十一 / 二十三 / 三十 */
  if (cn.startsWith('十')) {
    const rest = CN_DIGIT[cn.slice(1)];
    return rest === undefined ? 10 : 10 + rest;
  }
  const [tens, ones] = cn.split('十');
  const t = CN_DIGIT[tens ?? ''];
  if (t === undefined) return null;
  const o = ones ? CN_DIGIT[ones] : 0;
  if (o === undefined) return null;
  return t * 10 + o;
}

/**
 * 这一段是不是目录页。
 *
 * ## 判据为什么是「标记词 + 密集条目」两条都要
 *
 * 只看标记词会误判：正文里出现「见目录」、前言里提「本书目录如下」
 * 都会被当成目录页。只看密集条目也会误判：一个列表型的正文段
 * 看起来也像条目。
 *
 * 两条都要，且条目要**像章节**（以编号开头、或短且无句号）。
 */
export function isTocSegment(text: string): boolean {
  const t = text.toLowerCase();
  const hasMarker = TOC_MARKERS.some((m) => t.includes(m.toLowerCase()));
  if (!hasMarker) return false;

  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return false;

  /*
   * 数「像条目的行」：以章/节编号开头，或者短（≤24 字）且不以句号结尾。
   * 阈值取「至少 3 行」且「占非空行的一半以上」——
   * 目录页的主体就是条目，零散提到几行不该算。
   */
  let entryLike = 0;
  for (const line of lines) {
    const isNumbered = /^第[0-9一二三四五六七八九十百]+[章节]/.test(line) || /^[0-9]{1,2}(\.[0-9]{1,2})*[\s.、]/.test(line);
    const isShortTitle = line.length <= 24 && !/[。；]$/.test(line);
    if (isNumbered || isShortTitle) entryLike += 1;
  }

  return entryLike >= 3 && entryLike / lines.length >= 0.5;
}

/**
 * 从目录页的文本里抠出章节条目。
 *
 * 只保留「顶层章节」那一级（`第1章 xxx` / `1 xxx`），
 * 节级（`1.1 xxx`）不收 —— 路线要的是章级结构，
 * 节级上百条，全塞进提示词反而看不清。
 */
export function parseTocEntries(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    /*
     * 目录页的行经常带页码与点线：
     *   「第1章 函数与极限 ......... 1」
     * 先把它们擦掉再判断。
     */
    const cleaned = line
      .replace(/[.·…]{2,}/g, ' ')
      .replace(/\s+[0-9]{1,4}\s*$/, '')
      .trim();

    if (cleaned.length === 0 || cleaned.length > 60) continue;

    const isChapter =
      /^第[0-9一二三四五六七八九十百]+[章讲篇部]/.test(cleaned) ||
      /^[0-9]{1,2}[\s.、][^\n]{1,40}$/.test(cleaned) ||
      /^chapter\s*[0-9]+/i.test(cleaned);

    /* 节级（1.1）跳过 —— 只收章级 */
    const isSection = /^[0-9]{1,2}\.[0-9]{1,2}/.test(cleaned);
    if (!isChapter || isSection) continue;

    const key = cleaned.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }

  return out;
}

/**
 * 从正文里认章节标记（没有目录页时用）。
 *
 * 返回章号集合与对应标题。标题取该行本身（截断到 40 字）。
 */
export function findChapterMarks(text: string): { num: number; title: string }[] {
  const found: { num: number; title: string }[] = [];
  const seen = new Set<number>();

  const pushMatch = (num: number, title: string) => {
    if (num <= 0 || num > 200) return;
    if (seen.has(num)) return;
    seen.add(num);
    found.push({ num, title: title.trim().slice(0, 40) });
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 60) continue;

    const cn = CHAPTER_RE.exec(line);
    if (cn) {
      const n = cnToNum(cn[1] ?? '');
      if (n !== null) pushMatch(n, line);
      continue;
    }
    const en = CHAPTER_EN_RE.exec(line);
    if (en) {
      pushMatch(Number(en[1]), line);
    }
  }

  return found.sort((a, b) => a.num - b.num);
}

/**
 * 建一份资料的目录结构。
 *
 * 优先级：目录页 > 章节标记 > none。
 *
 * ## 为什么目录页在**前 15%** 才算
 *
 * 目录页总在开头（封面、版权、前言之后）。而「附录里有个目录」
 * 这种（书末索引）不该被当成主结构的依据 —— 它会给出
 * 完全不同的章节列表，把路线带偏。
 */
export function buildOutline(segments: readonly SourceSegment[]): SourceOutline {
  const sorted = [...segments].sort((a, b) => a.index - b.index);

  /* ---------- 1. 找目录页（只在前 15%，且最多看前 20 段） ---------- */
  const scanLimit = Math.max(3, Math.min(20, Math.ceil(sorted.length * 0.15)));
  let tocAt: number | null = null;
  let tocEntries: string[] = [];

  for (let i = 0; i < Math.min(scanLimit, sorted.length); i += 1) {
    const seg = sorted[i];
    if (!seg) continue;
    if (isTocSegment(seg.text)) {
      const entries = parseTocEntries(seg.text);
      /*
       * 目录页至少要给出 3 条章级条目才算数。
       * 1~2 条的多半是「本书共两篇」这类叙述，不足以当结构。
       */
      if (entries.length >= 3) {
        tocAt = i;
        tocEntries = entries;
        break;
      }
    }
  }

  /* ---------- 2. 找章节标记（全文扫，但**跳过目录页本身**） ---------- */
  /*
   * ⚠️ 必须跳过目录页，否则会把目录里列的章号当成「正文有这一章」。
   *
   * 这是用户点名那个边界 bug 的真正根因：
   * 《信号与系统 第1章》的目录页列了整本书 8 章，
   * 若不跳过，`contentChapterNumbers` 就是 1~8，
   * 边界判断会认为「这份资料覆盖到第 8 章」→ 排出资料里没有的内容。
   *
   * 跳过整个目录页太武断了（真目录后面可能紧跟正文），
   * 但**目录页本身不含正文**是确定的 —— 它就是一页条目列表。
   */
  const marks: { num: number; title: string }[] = [];
  const seenNum = new Set<number>();
  for (let i = 0; i < sorted.length; i += 1) {
    const seg = sorted[i];
    if (!seg) continue;
    if (tocAt !== null && i === tocAt) continue;
    for (const m of findChapterMarks(seg.text)) {
      if (seenNum.has(m.num)) continue;
      seenNum.add(m.num);
      marks.push(m);
    }
  }
  marks.sort((a, b) => a.num - b.num);
  const chapterNumbers = marks.map((m) => m.num);
  const maxChapterNumber = chapterNumbers.length > 0 ? Math.max(...chapterNumbers) : 0;

  /* ---------- 3. 决定 kind 与 entries ---------- */
  if (tocAt !== null && tocEntries.length >= 3) {
    /*
     * 有目录页：entries 用目录页的（它是**作者写的结构**，最权威）。
     * 但章号仍从章节标记里取 —— 目录页的条目可能带「第1章」，
     * 也可能只有标题，两个来源合起来最稳。
     */
    const fromToc = tocEntries
      .map((e) => {
        const cn = /第[ \t]*([0-9一二三四五六七八九十百]+)[ \t]*章/.exec(e);
        if (cn) return cnToNum(cn[1] ?? '');
        const ar = /^([0-9]{1,2})[\s.、]/.exec(e);
        if (ar) return Number(ar[1]);
        return null;
      })
      .filter((n): n is number => n !== null && n > 0 && n <= 200);

    const nums = [...new Set([...fromToc, ...chapterNumbers])].sort((a, b) => a - b);

    return {
      kind: 'toc-page',
      entries: tocEntries,
      tocAt,
      maxChapterNumber: nums.length > 0 ? Math.max(...nums) : maxChapterNumber,
      chapterNumbers: nums,
      /*
       * 边界只认正文实际出现的（不含目录声明的）——
       * 目录列的是整本书，这份资料可能只是其中一章（见类型注释）。
       */
      contentChapterNumbers: chapterNumbers,
    };
  }

  if (marks.length > 0) {
    return {
      kind: 'chapter-marks',
      entries: marks.map((m) => m.title),
      tocAt: null,
      maxChapterNumber,
      chapterNumbers,
      /* 没有目录页时两者相同（章号全都来自正文） */
      contentChapterNumbers: chapterNumbers,
    };
  }

  return {
    kind: 'none',
    entries: [],
    tocAt: null,
    maxChapterNumber: 0,
    chapterNumbers: [],
    contentChapterNumbers: [],
  };
}

/**
 * 这份资料**自身覆盖的章范围**是什么。
 *
 * ## 这是用户点名的那个边界问题的答案
 *
 * 用户原话：
 * > 没有目录的资料要注意边界，规划的路线不能超出现有资料内容范围。
 * > 例如：用户学习高等数学，但资料只解析/涉及了第一章，
 * > 但路线规划却规划了第一章后的内容
 *
 * ## ⚠️ 关键：只认正文实际出现的章号，不认目录声明的
 *
 * 实测真实库《信号与系统 第1章》：目录页列了整本书 8 章，
 * 但这份 PDF **只有第 1 章**。按目录算就会得到 1~8，
 * 路线便排出资料里没有的内容 —— 正是用户点名的 bug。
 *
 * 所以这里用 `contentChapterNumbers`（正文实际出现的）。
 *
 * ## `complete` 的含义
 *
 * - `true`：正文覆盖了 from~to 的每一章（可以按这个范围排路线）
 * - `false`：章号不连续（节选），或只有一章而目录声明更多 ——
 *   路线必须如实只覆盖已有章，且界面要说明「这份资料只到第 N 章」
 */
export function coveredChapters(outline: SourceOutline): {
  from: number;
  to: number;
  /** 是否覆盖了 from~to 的每一章 */
  complete: boolean;
  /**
   * 资料**声明**的最后一章（来自目录页）；只有 kind === 'toc-page' 时有值。
   *
   * 用途：当 `declaredTo > to` 时，说明这份资料是**整本书的节选**——
   * 界面要能说「目录列到第 8 章，这份资料只含第 1 章」，
   * 而不是笼统地说「只到第 1 章」（用户会以为是解析没做完）。
   */
  declaredTo: number | null;
} | null {
  const actual = outline.contentChapterNumbers;
  if (actual.length === 0) return null;

  const from = Math.min(...actual);
  const to = Math.max(...actual);

  /* 完整性：正文是否覆盖了 from~to 的每一章 */
  const expected = to - from + 1;
  const complete = actual.length === expected;

  /*
   * 目录声明到第几章。只有当目录确实比正文多时才值得告诉用户 ——
   * 否则这个字段只是噪音（大多数情况下两者相等）。
   */
  const declaredMax = outline.chapterNumbers.length > 0
    ? Math.max(...outline.chapterNumbers)
    : 0;
  const declaredTo = declaredMax > to ? declaredMax : null;

  return { from, to, complete, declaredTo };
}