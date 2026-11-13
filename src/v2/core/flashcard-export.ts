/**
 * 把闪卡导出成 Obsidian Spaced Repetition 插件认的 Markdown。
 *
 * ## 用户要求
 *
 * > 「同时还要有导出功能导出到 obsidian 中（要符合 obsidian 支持的格式，
 * >  应该是 markdown 格式）」
 *
 * ## 复用已有语法，不重新发明
 *
 * 项目里**已经有**一份逐条对照官方文档的导出实现：
 * `src/core/questions/obsidian-export.ts`（2026-11-12，为错题导出写的）。
 * 它的头注释记着从 `st3v3nmw/obsidian-spaced-repetition` 的
 * `docs/docs/zh/flashcards.md` 抄下来的规则：
 *
 * | 插件规则 | 实现 |
 * | --- | --- |
 * | 多行卡正面与反面以**单独一行**的 `?` 分隔 | 用这个 |
 * | 卡片之间必须**空行**，否则会连成一张卡 | join('\n\n') |
 * | 需要复习的笔记要有标签（默认 `#flashcards`） | 文件顶部放 |
 * | 行内公式 `$...$`，块级 `$$...$$` | 见 wrapFormulas |
 *
 * 所以这里**只复用 `wrapFormulas`**，卡片拼接自己写 ——
 * 因为闪卡的形状（front/back 两个纯文本字段）与题目的形状
 * （题干/选项/答案/解析）不同，不能直接套 `questionToFlashcard`。
 *
 * ## 为什么导出的是「一张卡一段」而不是「一道题一段」
 *
 * 闪卡是独立内容：用户可能把一张卡写的正面改得与来源完全不同，
 * 也可能手写一张跟任何题目都没关系的卡。按闪卡本身导出才对得上。
 */

import { wrapFormulas } from '@/core/questions/obsidian-export.ts';
import type { Flashcard } from '@/core/model.ts';
import { backOf } from '@/core/flashcards.ts';

export interface FlashcardExportOptions {
  /** 标签名（不含 #）。默认 flashcards —— 插件默认值 */
  tag?: string;
  /**
   * 是否把疑似公式包成 `$...$`。
   *
   * 默认 true。关掉的话导出纯文本，不会误伤
   * （万一某段文字被误判成公式，用户可以关掉重导）。
   */
  wrapFormulas?: boolean;
  /** 是否在卡片里带上来源追溯（「来自：XXX」） */
  includeSource?: boolean;
}

const DEFAULT_TAG = 'flashcards';

/** 一张闪卡 → 一段 Markdown（不含卡片间的空行） */
export function flashcardToMarkdown(
  card: Flashcard,
  options: FlashcardExportOptions = {},
  sourceLabel?: string | null,
): string {
  const wrap = options.wrapFormulas !== false;
  const f = wrap ? wrapFormulas : (s: string) => s;

  const lines: string[] = [];

  /* 正面 */
  lines.push(f(card.frontText.trim()));

  /* 分隔符：必须单独一行 —— 这是插件识别多行卡的唯一依据 */
  lines.push('?');

  /* 反面 */
  const back = backOf(card);
  if (back) {
    lines.push(f(back));
  } else {
    /*
     * 没有背面时**不省略 `?` 前面的结构**，而是明确写一句。
     *
     * 为什么：插件要求 `?` 两边都有内容，只有正面没有反面的卡
     * 在复习时翻开来是空的。写一句「（这张卡没有写背面）」
     * 比留白诚实 —— 用户导出到 Obsidian 后能一眼看出
     * 「这张卡我在应用里就没写背面」，而不是以为导出坏了。
     */
    lines.push('（这张卡还没有写背面）');
  }

  if (options.includeSource && sourceLabel) {
    lines.push('');
    lines.push(`*来自：${sourceLabel}*`);
  }

  return lines.join('\n');
}

/**
 * 一批闪卡 → 一个 .md 文件的完整内容。
 *
 * 结构（与 deckToObsidianMarkdown 一致）：
 *   ---
 *   title: "..."
 *   ---
 *
 *   #flashcards
 *
 *   卡片1
 *   （空行）
 *   卡片2
 *
 * 为什么要有 frontmatter：Obsidian 里一个文件可能同时是笔记和卡片集，
 * 有 title 才能在「快速切换」里按名字找到它。
 *
 * 为什么顶部要 `#flashcards`：插件靠标签识别「哪些笔记要进复习队列」，
 * 不写的话卡片不会出现在复习里 —— 用户会以为导出坏了。
 */
export function flashcardsToObsidianMarkdown(
  title: string,
  cards: readonly Flashcard[],
  options: FlashcardExportOptions = {},
  sourceLabelOf?: (card: Flashcard) => string | null,
): { content: string; count: number } {
  const tag = options.tag ?? DEFAULT_TAG;

  const header = [
    '---',
    `title: ${JSON.stringify(title)}`,
    '---',
    '',
    `#${tag}`,
    '',
  ].join('\n');

  const bodies = cards.map((c) =>
    flashcardToMarkdown(c, options, sourceLabelOf?.(c) ?? null),
  );

  /* 卡片之间必须空行，否则插件会把它们连成一张卡 */
  return { content: header + bodies.join('\n\n') + '\n', count: cards.length };
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
