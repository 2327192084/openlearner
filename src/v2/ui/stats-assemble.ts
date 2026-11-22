/**
 * 把 App 手里的真实数据装配成树 + 统计（2026-11-22）。
 *
 * ## 为什么这一层单独存在
 *
 * `App.tsx` 已经 3900+ 行，项目硬约束是「大文件里不要插代码，新增 UI 独立文件」。
 * 而「怎么从知识点/闪卡/题目反查出小节的统计」是**纯逻辑**，
 * 放在组件里既测不了、也会让 App 再胖一圈。
 *
 * ## 只做装配，不做判断
 *
 * 这里的每一个数字都来自真实数据；**算不出来时返回"算不出来"**
 * （三态，见 `section-stats.ts`），不编、不填 0。
 */

import type { Flashcard, KnowledgePoint, Question, SourceSegment } from '@/core/model.ts';
import type { SectionNode } from '@/v2/core/source-tree.ts';
import { buildSectionStats, type SectionStats } from './section-stats.ts';

/** 装配统计需要的东西（都由 App 传进来） */
export interface StatsSources {
  points: readonly KnowledgePoint[];
  cards: readonly Flashcard[];
  questions: readonly Question[];
  segments: readonly SourceSegment[];
}

/**
 * 从真实数据算出每一小节的统计。
 *
 * ## 闪卡怎么反查（这是方案 3.1 明确要求的方式）
 *
 * > 闪卡不存卡 id 列表，运行时按知识点反查（存 id 必然与闪卡表漂移）
 *
 * 链路：小节的段 id → 锚在这些段上的知识点 → 挂在这些知识点上的闪卡。
 *
 * ## 闪卡的 knowledgePointId 有两个字段
 *
 * `Flashcard` 既有旧字段 `knowledgePointId`，也有新的
 * `sourceId2 + sourceKind: 'point'`。两处都要认 ——
 * 旧卡（用户库里已有的）只有旧字段，新卡只有新字段。
 * 只认一个会有整批卡算成 0。
 */
export function assembleStats(
  sections: readonly SectionNode[],
  src: StatsSources,
): Map<string, SectionStats> {
  /* 知识点：把它的 anchors[].segmentId 摊平成段 id 列表 */
  const points = src.points.map((p) => ({
    id: p.id,
    segmentIds: (p.anchors ?? [])
      .map((a) => a.segmentId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0),
  }));

  /*
   * 闪卡：两个字段都认（见上面的注释）。
   *
   * 去重很重要 —— 建卡时 `sourceId2` 常常就等于 `knowledgePointId`
   * （见 `flashcards.ts:184`），不去重会把每张卡数成 2 张。
   */
  const cards = src.cards.map((c) => ({
    knowledgePointIds: [c.knowledgePointId, c.sourceKind === 'point' ? c.sourceId2 : null].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    ),
  }));

  /* 题目：锚点段 id */
  const questions = src.questions.map((q) => ({
    segmentIds: (q.anchors ?? [])
      .map((a) => a.segmentId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0),
  }));

  const currentSegmentIds = new Set(src.segments.map((s) => s.id));

  return buildSectionStats(sections, { points, cards, questions, currentSegmentIds });
}

/**
 * 把一棵树的所有小节摊平（统计要的输入是"所有小节"，不分章）。
 */
export function flattenSections(sections: readonly (readonly SectionNode[])[]): SectionNode[] {
  const out: SectionNode[] = [];
  for (const list of sections) for (const s of list) out.push(s);
  return out;
}