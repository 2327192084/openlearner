/**
 * 认知层级的显示名与顺序（2026-11-10）。
 *
 * ## 为什么单独一个文件
 *
 * 这套「四个类型」原本在三个地方各写了一份：
 *  - `SkeletonPage.tsx` 的 `LEVELS`（记忆 / 理解 / 应用 / 分析）
 *  - `pages/decks/types.ts` 的 `COGNITIVE_LEVELS`（识记 / 理解 / 应用 / 分析）
 *  - `KnowledgePage.tsx` 的 `LEVEL_LABEL`（记忆 / 理解 / 应用 / 分析）
 *
 * 前两者连用词都不一致（「记忆」vs「识记」）。用户要求知识库
 * 「按知识骨架那四个类型」分类，那就必须以骨架页为准，
 * 三处漂着迟早会出现「同一个类型在两页叫不同名字」。
 *
 * 所以抽到这里，三处都从这里取。**改这里就是改全部**。
 *
 * ## 顺序为什么是这条
 *
 * 由浅到深（记忆 → 理解 → 应用 → 分析）：这是布鲁姆分类的前四层，
 * 也是项目里出题时给知识点打 level 的那套。骨架页的注释原话是
 * 「顺序即由浅到深」。
 */

import type { KnowledgePoint } from './model.ts';

/** 一个认知层级的定义 */
export interface CognitiveLevelMeta {
  /** 存进 KnowledgePoint.cognitiveLevel 的值 */
  key: KnowledgePoint['cognitiveLevel'];
  /** 给用户看的名字 */
  label: string;
  /** 悬停说明：这一层到底要求什么 */
  hint: string;
}

/**
 * 四个层级，由浅到深。
 *
 * `satisfies` 而不是直接标注类型：保住字面量联合类型，
 * 让 `LEVEL_LABEL[lv.key]` 这类索引保持精确。
 */
export const COGNITIVE_LEVEL_META = [
  { key: 'remember', label: '记忆', hint: '能记住定义与事实' },
  { key: 'understand', label: '理解', hint: '能解释、能举例' },
  { key: 'apply', label: '应用', hint: '能用来解题' },
  { key: 'analyze', label: '分析', hint: '能比较、能推论' },
] as const satisfies readonly CognitiveLevelMeta[];

/** 值 → 显示名的查表（渲染单条知识点时用） */
export const COGNITIVE_LEVEL_LABEL: Record<KnowledgePoint['cognitiveLevel'], string> =
  Object.fromEntries(
    COGNITIVE_LEVEL_META.map((m) => [m.key, m.label]),
  ) as Record<KnowledgePoint['cognitiveLevel'], string>;
