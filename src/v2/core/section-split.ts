/**
 * 从正文里切出「小节」（2026-11-22 凌晨）。
 *
 * ## 用户的口径变了
 *
 * 上一轮做的是**横板线性路径**（一条路走到底）。用户看了截图后要求：
 *
 * > 我设想的地图应该是和图二的树状图一样的，从资料延伸出各个章节，
 * > 然后章节中延伸各个小节。点击一个章节节点后局部放大
 * > （只专注于该节点和节点后延伸出的小节点），通过完成小节任务来完成这一章节。
 *
 * 所以地图从「一条线」变成「资料 → 章 → 小节」的树。
 * 这个文件负责最底下那层：**怎么从正文里认出小节**。
 *
 * ## 为什么不能复用现有的 `parseTocEntries`
 *
 * 那个函数**显式跳过节级**（`source-outline.ts:207-208` 的
 * `if (!isChapter || isSection) continue`）—— 它是为「路线只要章级」
 * 那个已经作废的设计写的。现在要小节，得新写。
 *
 * ## 实测：真实资料的小节标题有三种写法（2026-11-22 抽样）
 *
 * | 写法 | 出现在 | 数量 |
 * |---|---|---|
 * | `## 1.1 连续时间和离散时间信号` | 信号与系统 | 26 个（含 `## 1.1.1` 三级） |
 * | `## 1. 映射概念` | 高等数学 | 8 个（章内序号，没有 1.1 层级） |
 * | 纯文本 `1.1 极限` | 无 markdown 的资料 | 视解析器而定 |
 * | **一个都没有** | 课程知识点一（pptx） | 0 个 |
 *
 * 第三种和第四种决定了：切不出时要有兜底（AI 拆，或退化成整章）。
 * 这个文件只负责「能切就切」；兜底在调用方。
 *
 * ## ⚠️ 最容易写错的一条：小节必须落在自己的父章里
 *
 * 高等数学每章都有「1.」「2.」「3.」——**章内序号**。
 * 如果只按编号全局收集，会把第 2 章的「1. 导数的定义」
 * 错归到第 1 章去。
 *
 * 所以这里的做法是：**按段落顺序走一遍**，记住当前章号，
 * 每认出一个章标题就开一个新的章；小节归属「最近出现的那一章」。
 * 绝不按编号排序或分组。
 *
 * ## 纯函数
 *
 * 不碰 I/O。入参是段数组，出参是结构与段归属。
 */

import type { SourceSegment } from '@/core/model.ts';

/** 切出来的一个小节 */
export interface SplitSection {
  /** 小节标题（原样，含编号） */
  title: string;
  /** 小节编号（如 1.1 的 "1.1"；章内序号那种是 "1."） */
  number: string;
  /** 这个标题出现在第几段（段的 index） */
  headingSegmentIndex: number;
  /**
   * 这个小节覆盖的段 id（含标题段本身，直到下一个小节/章标题为止）。
   *
   * 用来算「这一节有多少正文」「这一节对应的题有几道」。
   */
  segmentIds: string[];
}

/** 切出来的一章 */
export interface SplitChapter {
  /** 章号；0 = 认不出章号（无章节结构的资料） */
  number: number;
  /** 章标题 */
  title: string;
  sections: SplitSection[];
}

/** 切分结果 */
export interface SplitResult {
  chapters: SplitChapter[];
  /**
   * 有没有认出至少一个真正的小节（不是「整章单节点」的退化形态）。
   *
   * 调用方据此决定要不要走 AI 兜底。
   */
  hasRealSections: boolean;
  /** 诊断：各章切出几个小节 */
  stats: { chapterNumber: number; sections: number }[];
}

/**
 * 三种小节标题的正则。
 *
 * ## 为什么 `#{1,3}` 要允许
 *
 * MinerU 转出来的正文会把标题写成 `## 1.1 xxx`。
 * 但有些资料是纯文本（没有 `#`），所以第二个分支也接受裸标题。
 *
 * ## 为什么标题后面要求有空格或直接是文字
 *
 * `1.1连续时间信号`（无空格）在中文排版里常见，所以 `\s*` 而不是 `\s+`。
 * 但要排除 `1.1.1` 被当成 `1.1` —— 所以第三级用可选组，且要求
 * 匹配后不能紧跟数字。
 */
const RE_SECTION_MD = /^#{1,3}\s*([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?)\s*(.+)$/;
const RE_SECTION_PLAIN = /^([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?)\s+(\S.+)$/;
/** 章内序号：`## 1. 映射概念` / `1、映射概念` */
const RE_INNER_NUMBER_MD = /^#{1,3}\s*([0-9]{1,2})[.、]\s*(.+)$/;
const RE_INNER_NUMBER_PLAIN = /^([0-9]{1,2})[.、]\s*(\S.+)$/;
/** 章标题：`第1章 xxx` / `## 第1章 xxx` / `Chapter 1` */
const RE_CHAPTER = /^#{0,3}\s*第\s*([0-9一二三四五六七八九十百]+)\s*章\s*(.*)$/;
const RE_CHAPTER_EN = /^#{0,3}\s*chapter\s*([0-9]+)\s*(.*)$/i;

/** 中文数字转阿拉伯（只覆盖教材章号范围） */
const CN: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnToNum(cn: string): number | null {
  if (/^[0-9]+$/.test(cn)) return Number(cn);
  if (cn.length === 1) return CN[cn] ?? null;
  if (cn === '百') return 100;
  if (cn.startsWith('十')) {
    const rest = CN[cn.slice(1)];
    return rest === undefined ? 10 : 10 + rest;
  }
  const [tens, ones] = cn.split('十');
  const t = CN[tens ?? ''];
  if (t === undefined) return null;
  const o = ones ? CN[ones] : 0;
  return o === undefined ? null : t * 10 + o;
}

/**
 * 判断一行是不是标题样的行。
 *
 * 三条排除（都是实测会踩的）：
 *  - 太长（> 60 字）→ 那是正文句子
 *  - 以句号/分号/逗号结尾 → 那是句子，不是标题
 *  - 以「图」「表」「例」「式」开头 → 那是图表题注
 */
function looksLikeHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (/[。；，、]$/.test(t)) return false;
  if (/^(图|表|例|式|注)\s*[0-9]/.test(t)) return false;
  return true;
}

/** 从一段正文里按行找标题 */
interface HeadingHit {
  kind: 'chapter' | 'section' | 'inner';
  number: string;
  chapterNumber?: number;
  title: string;
}

function scanHeadings(text: string): HeadingHit[] {
  const out: HeadingHit[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!looksLikeHeadingLine(line)) continue;

    /* ---------- 章 ---------- */
    const ch = RE_CHAPTER.exec(line);
    if (ch) {
      const n = cnToNum(ch[1] ?? '');
      if (n !== null) {
        out.push({ kind: 'chapter', number: String(n), chapterNumber: n, title: line });
        continue;
      }
    }
    const chEn = RE_CHAPTER_EN.exec(line);
    if (chEn) {
      const n = Number(chEn[1]);
      if (Number.isFinite(n)) {
        out.push({ kind: 'chapter', number: String(n), chapterNumber: n, title: line });
        continue;
      }
    }

    /* ---------- 小节（1.1 / 1.1.1） ---------- */
    const sec = RE_SECTION_MD.exec(line) ?? RE_SECTION_PLAIN.exec(line);
    if (sec) {
      out.push({ kind: 'section', number: sec[1] ?? '', title: line });
      continue;
    }

    /* ---------- 章内序号（1. / 1、） ---------- */
    /*
     * ⚠️ 这一条要放在最后，而且**只在有 `#` 标记时才认**。
     *
     * 理由：裸文本里的「1. 首先…」是列表项，不是标题。
     * 只有当它被显式标成标题（`## 1. 映射概念`）时才可信 ——
     * MinerU 那种转换会保留标题标记。
     */
    if (/^#{1,3}\s/.test(line)) {
      const inner = RE_INNER_NUMBER_MD.exec(line);
      if (inner) {
        out.push({ kind: 'inner', number: inner[1] ?? '', title: line });
        continue;
      }
    }
    /* 裸文本的章内序号：要求短（≤ 24 字）且不以标点结尾，风险较高但真实资料里有 */
    const innerPlain = RE_INNER_NUMBER_PLAIN.exec(line);
    if (innerPlain && line.length <= 24) {
      out.push({ kind: 'inner', number: innerPlain[1] ?? '', title: line });
    }
  }
  return out;
}

/**
 * 把一份资料的段落切成「章 → 小节」。
 *
 * ## 算法：一遍扫描，记住当前章
 *
 * 绝不按编号分组 —— 那样会把各章的「1.」混在一起（见文件头）。
 *
 * 三种认不出章的情况：
 *  - 完全没章标题 → 全部段落归入一个 `number: 0` 的伪章
 *  - 有章标题但没小节 → 该章 `sections` 为空（调用方决定兜底）
 *
 * @param segments 已按 index 排好的段落
 */
export function splitSections(segments: readonly SourceSegment[]): SplitResult {
  const sorted = [...segments].sort((a, b) => a.index - b.index);

  /** 章的列表（保持出现顺序） */
  const chapters: SplitChapter[] = [];
  /** 当前章 */
  let currentChapter: SplitChapter | null = null;
  /** 当前小节 */
  let currentSection: SplitSection | null = null;
  /** 当前章节的「无小节」正文（章标题之后、第一个小节之前的段） */
  const looseByChapter = new Map<SplitChapter, SourceSegment[]>();

  const ensureChapter = (num: number, title: string): SplitChapter => {
    /* 同号章只建一次（有些资料会在页眉重复章标题） */
    const exist = chapters.find((c) => c.number === num);
    if (exist) return exist;
    const c: SplitChapter = { number: num, title, sections: [] };
    chapters.push(c);
    return c;
  };

  for (const seg of sorted) {
    const hits = scanHeadings(seg.text);

    /*
     * 一段里可能同时有章标题和小节标题（信号与系统第 1 段就是：
     * `## 第1章 信号与系统` 后面紧跟 `## 1.0 引言`）。
     * 所以按出现顺序处理，而不是一段只认一个。
     */
    if (hits.length === 0) {
      /* 没有标题：归给当前小节（或当前章的松散正文） */
      if (currentSection) {
        currentSection.segmentIds.push(seg.id);
      } else if (currentChapter) {
        const arr = looseByChapter.get(currentChapter) ?? [];
        arr.push(seg);
        looseByChapter.set(currentChapter, arr);
      } else {
        /*
         * 还没遇到任何章标题（封面、前言、目录页）。
         * 这些段不归入任何章 —— 它们不是学习内容。
         * 但如果没有章标题（整份资料无结构），后面会兜底建伪章。
         */
      }
      continue;
    }

    for (const hit of hits) {
      if (hit.kind === 'chapter') {
        currentChapter = ensureChapter(hit.chapterNumber ?? 0, hit.title);
        currentSection = null;
        continue;
      }

      /*
       * 小节 / 章内序号：都算「小节」，但**必须有当前章**。
       * 没有当前章时（资料开头就是 `1.1 xxx`），建一个 number 0 的伪章。
       */
      if (!currentChapter) {
        currentChapter = ensureChapter(0, '（未分章）');
      }

      /*
       * 小节编号去重：同一章里同号小节只建一次
       * （页眉/页脚重复小节标题的情况）。
       */
      const dup = currentChapter.sections.find(
        (s) => s.number === hit.number && s.title === hit.title,
      );
      if (dup) {
        currentSection = dup;
        currentSection.segmentIds.push(seg.id);
        continue;
      }

      currentSection = {
        title: hit.title,
        number: hit.number,
        headingSegmentIndex: seg.index,
        /* 标题段本身也算这个小节的内容（跳转时要能看到标题） */
        segmentIds: [seg.id],
      };
      currentChapter.sections.push(currentSection);
    }
  }

  /* ---------- 章标题之后、第一个小节之前的正文：补给第一个小节 ---------- */
  /*
   * 不补给的话，这些段会彻底丢掉（既不在小节里，也没进任何统计）。
   * 补给第一个小节是最合理的：它们就在那一节标题之前，通常是引言。
   * 没有小节的章则忽略（调用方会包成「整章」节点）。
   */
  for (const c of chapters) {
    const loose = looseByChapter.get(c);
    if (!loose || loose.length === 0) continue;
    const first = c.sections[0];
    if (!first) continue;
    first.segmentIds = [...loose.map((s) => s.id), ...first.segmentIds];
  }

  /* ---------- 完全没认出章：兜底建伪章（整份资料一章） ---------- */
  if (chapters.length === 0 && sorted.length > 0) {
    chapters.push({
      number: 0,
      title: '（未分章）',
      sections: [],
    });
  }

  const hasRealSections = chapters.some((c) => c.sections.length >= 2);
  const stats = chapters.map((c) => ({ chapterNumber: c.number, sections: c.sections.length }));

  return { chapters, hasRealSections, stats };
}

/**
 * 哪些章需要 AI 兜底拆小节。
 *
 * ## 判据
 *
 * - `sections.length === 0`：一个都没切出来（pptx 那种）
 * - `sections.length === 1`：只切出一个，等于没切（整章就一个标题）
 *
 * 为什么把「只有 1 个」也算需要兜底：
 * 用户要的是「点章节展开出几个小节」的体验，
 * 一个章只有一个节点，和「整章学」没区别，不如让 AI 拆细一点。
 */
export function chaptersNeedingAiSplit(result: SplitResult): SplitChapter[] {
  return result.chapters.filter((c) => c.sections.length < 2);
}