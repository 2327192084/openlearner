/**
 * 提问式复习记录的「回看」视图数据（2026-11-13）。
 *
 * ## 为什么需要它
 *
 * 提问式复习（`docs/交接文档-2026-11-10-晚间.md` 里那套「材料 → AI 提问 →
 * 用户作答 → AI 判定记忆错误 / 理解偏差」）已经能存记录，但**存了看不到**：
 * `OralReviewService.list()` 和 `recentStats()` 都实现了、也有单测，
 * 可是全仓库没有一处 UI 调用它们。用户做完一轮，除了当场的判定，
 * 回头想复习「我上次在哪儿记错了」是没有任何入口的。
 *
 * ## 这一层只做纯逻辑
 *
 * 分组、排序、筛选、文案都在这里；界面只负责画。理由同项目里其它
 * `*-view.ts`：这类「怎么归拢」的规则最容易被写进 JSX，然后就没法单测了。
 *
 * ## 「判定」这个词在用户侧的说法
 *
 * `verdict` 的三个值是模型给的分类，直接摆在界面上是行话：
 *   - `correct`       → 答对了
 *   - `memory`        → 记错了（知识点本身没记住）
 *   - `understanding` → 理解偏了（记住了但用错了）
 *
 * 最后一条是最有价值的：它告诉用户「不是你背不下来，是你理解错了」，
 * 这两种错法的补救方式完全不同。
 */

import type { OralReviewRecord } from '@/core/model.ts';

/** 记录的三种判定，用户侧说法 */
export type OralVerdictKey = OralReviewRecord['verdict'];

export const VERDICT_LABEL: Record<OralVerdictKey, string> = {
  correct: '答对了',
  memory: '记错了',
  understanding: '理解偏了',
};

/**
 * 一句话说明「这类该怎么补」。
 *
 * 为什么值得写：用户看到「理解偏了」会愣一下 —— 那到底该怎么改？
 * 这三句是给下一步动作，不是给分类的。
 */
export const VERDICT_ADVICE: Record<OralVerdictKey, string> = {
  correct: '这题你已经答对了，不用特别补救。',
  memory: '结论没记住：回去把这条原文读一遍，重点记住它的表述。',
  understanding: '不是没记住，是理解偏了：对照下面的原文，看清它到底在说什么。',
};

/** 回看列表里的一行（也是筛选的最小单位） */
export interface OralReviewRow {
  id: string;
  /** 提问来源说明，如「第 9 页 · 1.2 离散时间信号」 */
  scopeLabel: string;
  /** AI 出的问题 */
  question: string;
  /** 用户当时的回答 */
  answer: string;
  /** 判定（用户侧说法与建议见上） */
  verdict: OralVerdictKey;
  /** 判定说明（AI 给的） */
  explanation: string;
  /** 正确的说法 */
  correction: string;
  /**
   * AI 引用的原文依据。
   *
   * 与 `quoteVerified` 一起看：引文为空或校验没过时，界面要**明说**
   * 「它没给出可核对的原文依据」—— 不能让人把一个可能编造的结论
   * 当成教材原话。
   */
  quotedFromSource: string;
  /** 引文是否真的能在材料里找到 */
  quoteVerified: boolean;
  /** 完整原文（savedAs==='full' 才有） */
  fullText: string | null;
  /** 保存形态 */
  savedAs: 'full' | 'brief';
  /** 发生时间（ISO） */
  createdAt: string;
  /** 显示用的日期时间，如「11-13 10:42」 */
  whenText: string;
  /** 跳回原文用 */
  sourceId: string | null;
  page: number | null;
}

/** ISO → 本地「MM-DD HH:mm」。解析不出来给空串，不显示 NaN。 */
export function whenText(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/**
 * 把服务层的记录转成界面行。
 *
 * 排序：**最近的在前**（与 `OralReviewService.list()` 一致，那里已经排过，
 * 这里再排一次是为了这个函数单独用也正确 —— 单测里就是这么用的）。
 */
export function toRows(records: readonly OralReviewRecord[]): OralReviewRow[] {
  return [...records]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map((r) => ({
      id: r.id,
      scopeLabel: r.scopeLabel || '（没有来源说明）',
      question: r.question,
      answer: r.answer,
      verdict: r.verdict,
      explanation: r.explanation,
      correction: r.correction,
      quotedFromSource: r.quotedFromSource,
      quoteVerified: r.quoteVerified,
      fullText: r.fullText,
      savedAs: r.savedAs,
      createdAt: r.createdAt,
      whenText: whenText(r.createdAt),
      sourceId: r.sourceId,
      page: r.page,
    }));
}

/** 筛选维度：全部 / 只看答错的 */
export type OralFilter = 'all' | 'wrong';

/**
 * 按维度筛。
 *
 * 「只看答错的」把 memory 与 understanding 合成一类 —— 用户的心智模型是
 * 「我要复习我错过的」，而不是「我要分别复习两种错法」。
 * 想看细分时下面每条记录自带徽标。
 */
export function filterRows(
  rows: readonly OralReviewRow[],
  filter: OralFilter,
): OralReviewRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => r.verdict !== 'correct');
}

/**
 * 列表顶部那一行摘要。
 *
 * 数据来自 `recentStats(days)`（已实现、有单测），这里只负责把它说成人话。
 * 空的时候要说清「还没有记录」，而不是显示「0 条」了事 ——
 * 后者会让人以为功能坏了。
 */
export function summaryText(
  stats: { memory: number; understanding: number; correct: number; total: number },
  days: number,
): string {
  if (stats.total === 0) {
    return `最近 ${days} 天还没有提问式复习的记录。`;
  }
  const wrong = stats.memory + stats.understanding;
  if (wrong === 0) {
    return `最近 ${days} 天做了 ${stats.total} 次提问式复习，全部答对了。`;
  }
  return `最近 ${days} 天做了 ${stats.total} 次，其中记错 ${stats.memory} 次、理解偏 ${stats.understanding} 次。`;
}

/**
 * 一条记录该不该提示「AI 没给可核对的原文依据」。
 *
 * 规则：判成答对时不必要求引文（它可能直接说「答对了」而不引用）；
 * 判成错的时候，引文是用户判断「它说得对不对」的唯一抓手，
 * 空了或校验没过就必须标出来。
 */
export function needsQuoteWarning(row: OralReviewRow): boolean {
  if (row.verdict === 'correct') return false;
  return !row.quotedFromSource.trim() || !row.quoteVerified;
}

/** 「这道题出自哪」的一句话；没有出处信息时给 null（界面不渲染那个按钮） */
export function anchorText(row: OralReviewRow): string | null {
  if (!row.sourceId) return null;
  if (typeof row.page === 'number' && row.page > 0) return `回到原文第 ${row.page} 页`;
  return '回到原文';
}
