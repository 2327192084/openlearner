/**
 * 闪卡的 callout 类型与来源分组映射（2026-11-23 抽出来）。
 *
 * ## 为什么要单独一个 core 模块
 *
 * 这份映射有**两个使用方**：
 *
 * | 使用方 | 用来做什么 |
 * |---|---|
 * | `src/v2/ui/card-rich.ts` | 界面上画哪种色条与图标 |
 * | `src/v2/core/flashcard-export.ts` | 导出到 Obsidian 时写 `[!tip]` 还是 `[!note]` |
 *
 * 原来它只在 card-rich.ts 里，导出器要用就得 import 一个 UI 模块 ——
 * 而 card-rich 依赖 `render-math`（KaTeX），把整个数学渲染层拖进
 * 纯数据路径。反过来（两边各写一份）更糟：
 * 界面显示「知识点=note」、导出写成「知识点=tip」，
 * 那就是本项目反复记的**两个部分说的不是同一件事**。
 *
 * 所以放在 core：纯映射、零依赖，两边引用同一份。
 */

/** 展示用的三大类型（与 flashcard-manage.ts 的 FlashcardGroup 同名同义） */
export type CardGroup = 'point' | 'wrong' | 'memory';

/** 数据层里的来源类型（旧卡可能没有这个字段） */
export type SourceKind = 'point' | 'wrong' | 'manual' | 'ai';

/**
 * 来源 → 展示分组。
 *
 * ⚠️ `manual` 与 `ai` 都归 `memory`（2026-11-23 用户要求
 * 「去掉手写的闪卡这一栏」）—— 数据层不改名，只在这里合并，
 * 所以旧手写卡一张不丢，只是换个栏显示。
 */
export function groupOfSourceKind(kind: SourceKind | undefined, hasKnowledgePoint: boolean): CardGroup {
  if (kind === 'point') return 'point';
  if (kind === 'wrong') return 'wrong';
  if (kind === 'manual' || kind === 'ai') return 'memory';
  /* 旧卡没有 sourceKind：按 knowledgePointId 推断（与 sourceKindOf 同一规则） */
  return hasKnowledgePoint ? 'point' : 'memory';
}

/** Obsidian 的 callout 类型（本项目只用这三种） */
export type CalloutKind = 'tip' | 'note' | 'quote';

/**
 * 该用哪种 callout 类型。
 *
 * 用户只给了**错题卡**的格式（`[!tip]`）。知识点与记忆按同样思路配：
 *
 * | 组 | callout | 理由 |
 * |---|---|---|
 * | `wrong` 错题 | `tip` | 用户给的就是这个；错题是"要点提醒"性质 |
 * | `point` 知识点 | `note` | 知识点是中性陈述，不该用提示色抢注意力 |
 * | `memory` 记忆 | `quote` | 自己写/让 AI 组织的，更像摘录与自述 |
 *
 * 类型只影响**色条与图标**，不改内容排版 —— 三种卡片的正文结构一致，
 * 用户切换组别时不会看到版式跳变。
 */
export function calloutKindOf(group: CardGroup): CalloutKind {
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
