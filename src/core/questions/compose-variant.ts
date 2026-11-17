/**
 * 「选题 → AI 改造 → 组卷」的纯逻辑（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「在原有的组卷功能上不变，但是多个功能。参考 ai 变式功能还有自己组卷功能，
 *   用户先在题库挑选想要的题目，然后 ai 在这些题目的基础上改动出题」
 *
 * 也就是把两个已有能力**串**起来：
 *  1. 自己组卷（`QuestionPicker`）—— 用户挑选
 *  2. AI 变式（`variants.ts` + `decks.generate`）—— AI 改造
 *
 * ## 与另外两个功能的区别（这个功能不是它们的替代品）
 *
 * | 功能 | 输入 | 输出 | 用途 |
 * |---|---|---|---|
 * | AI 组卷（compose） | 题库 | **原来的题**，只是重新挑选 | 快速配一套卷子 |
 * | AI 变式（variant） | 错题 / 知识点 | 新题 | 从错题或考点造题 |
 * | **本功能（改造组卷）** | **用户挑的题** | **改造出的新题** | 按自己挑的重点造一套卷 |
 *
 * 三条路各自独立，互不影响 —— 用户明确说「原有的组卷功能上不变」。
 *
 * ## 为什么复用 `questionToVariantMaterial` 而不是另写提示词
 *
 * 它已经把「原题 + 原答案 + 原解析 + 原选项 + 考点 + 变式维度 + 硬性限制」
 * 拼好了，而且那套措辞经过 2026-11-12 那轮修正（防止模型改出另一道题）。
 * 再写一份必然漂移 —— 交接文档 5.2「反馈只能有一份实现」。
 *
 * ## 与 `variants.ts` 的差别只有一个：素材来源
 *
 * `wrongQuestionsToVariantMaterials` / `knowledgePointsToVariantMaterials`
 * 是「按错题/知识点筛」；这里是「用户手挑的题，全都要」。
 * 所以只需要一个很薄的分组函数，不需要新的提示词逻辑。
 */

import type { KnowledgePoint, Question } from '../model.ts';
import type { QuestionMaterial } from './materials.ts';
import { questionToVariantMaterial, VARIANT_AXES, type VariantAxis } from './variants.ts';

export interface ComposeVariantInput {
  /** 用户手挑的题（顺序即他希望的顺序） */
  questions: readonly Question[];
  /** 题 → 它关联的知识点（用来给变式提供考点与出处；取不到也能改） */
  pointsById: ReadonlyMap<string, KnowledgePoint>;
  /** 改造维度；空数组 = 让模型自己选一个等价考法 */
  axes: readonly VariantAxis[];
}

/**
 * 把用户挑的题转成变式素材。
 *
 * ## 为什么每道题都要出素材（而不是只出几道）
 *
 * 用户挑了几道，就希望改造出几道 —— 这是「组卷」的语义。
 * 少造几道会让卷子比预期短；那要由用户自己决定，不能悄悄少。
 *
 * （真正发出去时模型可能少给，那是另一回事，由 `generate` 的产出计数如实报。）
 *
 * ## 顺序保持
 *
 * 素材顺序 = 用户挑选顺序。`decks.generate` 会按素材顺序落题，
 * 用户挑的顺序就是他想要的卷子顺序（先易后难之类）。
 */
export function pickedQuestionsToVariantMaterials(
  input: ComposeVariantInput,
): QuestionMaterial[] {
  return input.questions.map((q) =>
    questionToVariantMaterial(q, input.pointsById.get(q.id) ?? null, input.axes),
  );
}

/**
 * 生成卷子标题。
 *
 * 带上日期：用户会攒很多套卷，没有日期分不清哪套是哪天造的
 * （与 `GeneratePage` 里变式出题的标题口径一致）。
 */
export function composeVariantTitle(sourceLabel: string | null, at: Date = new Date()): string {
  const day = at.toLocaleDateString('zh-CN');
  const base = sourceLabel ? `${sourceLabel} · 改造组卷` : '改造组卷';
  return `${base} · ${day}`;
}

/**
 * 维度可选项（界面直接用）。
 *
 * 直接复用 `VARIANT_AXES` —— 不另立一套，否则两处的措辞会漂移，
 * 用户在不同入口看到的「换情境」描述不一样。
 */
export const COMPOSE_VARIANT_AXES = VARIANT_AXES;

/**
 * 从题库里挑完题之后，检查这批题能不能用来改造。
 *
 * 返回 `null` 表示能用；否则是给用户看的原因。
 *
 * ## 为什么要这个检查
 *
 * 有些题不适合改造：
 *  - `point`（知识点卡）不是题，没有「原答案」可改
 *  - 空题干的题（数据损坏）改出来也是空的
 *
 * 与其让模型对着垃圾产出垃圾，不如提前说清。
 */
export function validateComposeVariantInput(questions: readonly Question[]): string | null {
  if (questions.length === 0) return '先挑至少一道题。';
  const bad = questions.filter((q) => !q.prompt.trim());
  if (bad.length > 0) {
    return `有 ${bad.length} 道题的题干是空的，改不出来。换几道再试。`;
  }
  return null;
}