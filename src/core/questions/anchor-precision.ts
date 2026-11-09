/**
 * 「这道题能点回原文的哪一格」—— 定位精度判定（2026-11-09）。
 *
 * ## 这一层要解决什么
 *
 * 项目里有两条出题来源，它们的定位能力**根本不同**：
 *
 * | 来源 | 素材 | 锚点精度 |
 * | --- | --- | --- |
 * | 从知识库出题 | KnowledgePoint | 精确到一句话（整理时实测定位过） |
 * | 从原文出题 | SourceSegment | 只到整段（charStart=0，charEnd=整段长度） |
 *
 * 但界面此前对两者承诺同一句话：「可点回原文 · 第 N 页」。
 * 用户点进去，从原文出的题会整页发亮，看起来像定位坏了。
 *
 * ## 为什么不在界面上「假装都能精确」
 *
 * 那正是项目反复踩的坑（不做假开关、不指向不存在的地方）。
 * 宁可明说「本题出自第 9 页这一段」，也不要让高亮亮一整页还叫它精确定位。
 *
 * ## 为什么先做这一层、不改库
 *
 * 判定只需要现有字段（anchors 的跨度 + 是否有 quote），
 * 不需要迁移。先让界面说实话，再加数据能力（segmentId），两步分开验收。
 */

import type { SourceLocation } from '../model.ts';

/**
 * 定位精度三档。
 *
 * 顺序有意义：`exact` 是最好，`block` 是「只能指出大概位置」，
 * `none` 是彻底没位置（粘贴文本、按章节切分且没页码的资料）。
 */
export type AnchorPrecision =
  /** 能圈到具体那句话 / 那一句片段 */
  | 'exact'
  /** 只能定位到一段（整页或整章）。仍然有用 —— 上下文就在眼前 */
  | 'block'
  /** 没有可用位置 */
  | 'none';

/**
 * 判定精度时，「算整段」的字符占比阈值。
 *
 * 0.8 而不是 1.0：`segmentsToMaterials` 用的是 `text.trim().length`
 * 作为 charEnd，而 seg.text 里可能有首尾空白，两者不完全相等。
 * 留 20% 余量避免把「整段」误判成「精确」。
 *
 * 也不设更低：一段 1200 字里圈中 900 字（75%）仍然只算「块级」，
 * 因为用户看到的还是一大片高亮。
 */
export const WHOLE_BLOCK_RATIO = 0.8;

/** 判定所需的上下文（由调用方查库后传入，保持本模块是纯函数） */
export interface PrecisionContext {
  /** 锚点所在段落的正文长度；查不到传 null */
  segmentLength: number | null;
}

/**
 * 判定一条锚点的定位精度。
 *
 * 判据按可靠性排序：
 *  1. 完全没有锚点 → none
 *  2. 有 quote（引文）→ 一定能回查，算 exact
 *     （quote 来自 W3C 双选择器的思路，见 ReaderPage 的 quote 兜底）
 *  3. 跨度占整段 ≥ WHOLE_BLOCK_RATIO → block
 *  4. 跨度明显小于整段 → exact
 *
 * 第 2 条优先于第 3 条是有意的：只要存了引文，即使 charStart/charEnd
 * 是整段范围，也能用 indexOf 精确定位到那句话 —— 这比只看偏移更可信。
 */
export function anchorPrecision(
  anchor: SourceLocation | null | undefined,
  ctx: PrecisionContext = { segmentLength: null },
): AnchorPrecision {
  if (!anchor) return 'none';

  /* 引文优先：有它就能精确定位，不依赖偏移量 */
  if (typeof anchor.quote === 'string' && anchor.quote.trim().length > 0) {
    return 'exact';
  }

  const { charStart, charEnd } = anchor;
  const hasRange =
    typeof charStart === 'number' &&
    typeof charEnd === 'number' &&
    charEnd > charStart;

  /*
   * 没有偏移但有页码：算 block。
   *
   * 「知道在第几页」仍然有价值 —— 阅读器能翻到那一页。
   * 说 none 会让界面丢掉页码这个真实信息。
   */
  if (!hasRange) {
    return typeof anchor.page === 'number' ? 'block' : 'none';
  }

  const span = charEnd - charStart;
  const segLen = ctx.segmentLength;

  /* 查不到段落长度：无法判断占比。按跨度绝对值兜底 */
  if (typeof segLen !== 'number' || segLen <= 0) {
    /* 超过 500 字符的多半是整段（知识点引文一般一两百字） */
    return span >= 500 ? 'block' : 'exact';
  }

  return span / segLen >= WHOLE_BLOCK_RATIO ? 'block' : 'exact';
}

/** 界面上对每一档该说的话 */
export interface PrecisionCopy {
  /** 徽章文字，如「可点回原句」 */
  badge: string;
  /** 提示语，说明这道题的位置有多准。诚实，不承诺做不到的事 */
  hint: string;
}

/**
 * 把精度转成界面文案。
 *
 * 三句话都必须说明**这道题自己的**位置情况，
 * 不能写「部分题目可能…」那种含糊说法 —— 用户看的是这一道题。
 */
export function precisionCopy(kind: AnchorPrecision, page?: number | null): PrecisionCopy {
  const pageText = typeof page === 'number' ? `第 ${page} 页` : '原文';

  switch (kind) {
    case 'exact':
      return {
        badge: '可点回原句',
        hint: `点一下跳到${pageText}，高亮这句话`,
      };
    case 'block':
      return {
        badge: '可点回原文',
        hint: `这道题从原文整段出的，点一下到${pageText}看完整上下文`,
      };
    case 'none':
      return {
        badge: '无原文位置',
        hint: '这道题的出处没有定位信息，只能看题目本身',
      };
  }
}
