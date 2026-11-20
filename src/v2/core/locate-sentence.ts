/**
 * 「这道题能定位到原文哪一句」（2026-11-20）。
 *
 * ## 用户诉求
 *
 * > 定位功能不够，现在只能定位到页面，不能具体到句子。
 * > 现在在修改一下，同时定位到句子时应该和标注的高亮的效果一样，
 * > 只不过换成橙光来用来与高亮和备注区分开来。
 *
 * ## 为什么需要一层判定，不能直接把 anchors 丢给阅读器
 *
 * 阅读器的 `ReaderTarget` **已经支持** `charStart/charEnd/quote/segmentId`
 * 并会做「偏移命中 → 引文兜底 → 只剩页码」三级降级。问题在于
 * **调用方给的位置本身就是整段**，阅读器再聪明也只能圈整段。
 *
 * 实测用户真实库（39 道题 / 59 个知识点 / 1006 段正文）：
 *
 * | 数据 | anchors 实际内容 |
 * |---|---|
 * | 题目（39 道全有 anchors） | `charStart: 0, charEnd: 1366` —— 整段 |
 * | 知识点 | `charStart: 1320, charEnd: 1364` —— 44 字符，真句子 |
 *
 * 所以「定位到句子」的关键是**找到那个更精确的位置**，
 * 而不是改阅读器。三个来源依次试：
 *
 * 1. **题目自己的 anchors**：跨度明显小于整段时它就是句子
 * 2. **题目关联的知识点**：`knowledgePointId` → 知识点的 anchors（真句子）
 * 3. 都没有 → 如实告诉用户「这道题没有精确到句的出处」
 *
 * ## ⚠️ 实测发现：用户库里的题**全都没有** `knowledgePointId`
 *
 * 他那 39 道题是「自选 · 改造组卷」生成的（没有来源知识点）。
 * 所以第 2 条对他的现有数据不会命中 —— 但这不是白写：
 * 从知识点出题 / 从原文出题产生的题**会**带这个字段。
 *
 * 用户对此的要求是明确的：
 * > 自改题可以没有定位功能，给用户个提示就行
 *
 * 所以第 3 条不是失败兜底，而是**设计好的正常分支**。
 *
 * ## 本模块是纯函数
 *
 * 不碰 I/O，不依赖 React。入参是题目、知识点表、正文段表，
 * 出参是「定位到什么 + 定位不到时跟用户说什么」。
 */

import type { Question, KnowledgePoint, SourceSegment } from '@/core/model.ts';

/**
 * 判定「整段锚点」的比例阈值。
 *
 * 与 `ReaderPage` 里的 `WHOLE_SEGMENT_RATIO = 0.8` 保持一致 ——
 * 两处必须同口径，否则会出现「调用方认为这是句子、阅读器认为这是整段」
 * 的矛盾（表现：要么整页刷亮，要么明明有位置却不圈）。
 *
 * 为什么 0.8 而不是 1.0：`charEnd` 常常包含段末空白与换行，
 * 拿整段长度做严格相等会因为差几个字符而误判成「句子」。
 */
export const WHOLE_SEGMENT_RATIO = 0.8;

/** 一个可以交给阅读器的精确定位 */
export interface SentenceTarget {
  sourceId: string;
  page: number;
  /** 字符偏移（相对该页/该章正文） */
  charStart: number;
  charEnd: number;
  /** 所在段的 id（有就传，能让阅读器精确选中那一段） */
  segmentId?: string;
  /** 定位到的原文句子本身（给阅读器做校验 + 给界面显示） */
  quote: string;
}

/** 判定结果 */
export type LocateResult =
  /** 能定位到句子 */
  | { kind: 'sentence'; target: SentenceTarget; from: 'own-anchor' | 'knowledge-point' }
  /** 只能到页（锚点是整段 / 没有偏移）—— 跳页但说明为什么不高亮 */
  | {
      kind: 'page';
      sourceId: string;
      page: number;
      reason: string;
      /**
       * 整段锚点的原始偏移与段 id（2026-11-20 修）。
       *
       * ## 为什么必须带上
       *
       * 阅读器判断「这是整段锚点、所以有意不圈」靠的是
       * `charStart/charEnd` 与段长的比例（`WHOLE_SEGMENT_RATIO`）。
       * 只传 `{sourceId, page}` 的话它拿不到偏移，`spanIsWholeSegment`
       * 恒为 false —— 于是落进最后那个「什么都没找到」分支，
       * **连一句提示都不显示**，用户只看到跳到第 16 页、不知道为什么没高亮。
       *
       * 实测抓到的现象：整段级题的阅读器页面上 `reader-jump` 一个都没有。
       * 所以这里把偏移原样带过去，让阅读器走它自己那条「整段 → 说明原因」分支。
       */
      charStart?: number;
      charEnd?: number;
      segmentId?: string;
    }
  /** 连页都没有（自改题、手工题）—— 不跳，给出提示 */
  | { kind: 'none'; reason: string };

/** 从段表里按 id 或 (sourceId, page) 找那段正文 */
function findSegment(
  segments: readonly SourceSegment[],
  sourceId: string,
  page: number | undefined,
  segmentId: string | undefined,
): SourceSegment | null {
  if (segmentId) {
    const byId = segments.find((s) => s.id === segmentId);
    if (byId) return byId;
  }
  if (page !== undefined) {
    /* 同一 page 可能对应多段（按章节切分时 page=index，但也可能重复），
       取第一段即可 —— 与 ReaderPage 的降级口径一致 */
    return segments.find((s) => s.sourceId === sourceId && s.page === page) ?? null;
  }
  return null;
}

/**
 * 判断一个 anchors 条目是否给出了**句子级**范围。
 *
 * 三个条件缺一不可：
 *  - 有 charStart / charEnd（不然只有页码）
 *  - 长度 > 0（空区间圈不出东西）
 *  - 跨度不接近整段（接近整段说明它是「出自这一段」而不是「这一句」）
 */
function sentenceRangeOf(
  anchor: { charStart?: number; charEnd?: number },
  seg: SourceSegment | null,
  needSegment = true,
): { start: number; end: number } | null {
  const { charStart: cs, charEnd: ce } = anchor;
  if (typeof cs !== 'number' || typeof ce !== 'number') return null;
  if (cs < 0 || ce <= cs) return null;
  if (!seg) {
    /* 没有段正文就无法判断「是不是整段」。
       有偏移但没正文时仍可用（比如按章节切分的旧数据），
       但这种情况无法校验，交给阅读器按偏移+quote 校验。 */
    return needSegment ? null : { start: cs, end: ce };
  }
  if (ce > seg.text.length) return null;
  const span = ce - cs;
  if (span >= seg.text.length * WHOLE_SEGMENT_RATIO) return null;
  return { start: cs, end: ce };
}

/**
 * 给一道题算出「能定位到哪」。
 *
 * @param q 题目
 * @param points 知识点表（用于 `knowledgePointId` 反查）
 * @param segments 正文段表（用于判断跨度 + 取引文）
 */
export function locateQuestion(
  q: Pick<Question, 'id' | 'anchors' | 'knowledgePointId'>,
  points: readonly KnowledgePoint[],
  segments: readonly SourceSegment[],
): LocateResult {
  const own = q.anchors[0];

  /* ---------- 1) 题目自己的锚点如果是句子 ---------- */
  if (own?.sourceId) {
    const seg = findSegment(segments, own.sourceId, own.page, own.segmentId);
    const range = sentenceRangeOf(own, seg, false);
    if (range && seg) {
      return {
        kind: 'sentence',
        from: 'own-anchor',
        target: {
          sourceId: own.sourceId,
          page: own.page ?? seg.page,
          charStart: range.start,
          charEnd: range.end,
          ...(own.segmentId ? { segmentId: own.segmentId } : {}),
          /* 用原文切片当 quote，而不是题干 —— 题干通常不在原文里，匹配不上 */
          quote: seg.text.slice(range.start, range.end).trim(),
        },
      };
    }
  }

  /* ---------- 2) 关联知识点的锚点（通常更精确） ---------- */
  if (q.knowledgePointId) {
    const kp = points.find((p) => p.id === q.knowledgePointId);
    const ka = kp?.anchors[0];
    if (kp && ka?.sourceId) {
      const seg = findSegment(segments, ka.sourceId, ka.page, ka.segmentId);
      const range = sentenceRangeOf(ka, seg, false);
      if (range && seg) {
        return {
          kind: 'sentence',
          from: 'knowledge-point',
          target: {
            sourceId: ka.sourceId,
            page: ka.page ?? seg.page,
            charStart: range.start,
            charEnd: range.end,
            ...(ka.segmentId ? { segmentId: ka.segmentId } : {}),
            quote: seg.text.slice(range.start, range.end).trim(),
          },
        };
      }
      /* 知识点有位置但不是句子（整段）→ 退到「只到页」，但把偏移带给阅读器 */
      if (ka.sourceId) {
        return {
          kind: 'page',
          sourceId: ka.sourceId,
          page: ka.page ?? 1,
          reason: '这道题关联的知识点只标到整段，精确不到具体句子，所以不标注。',
          ...(typeof ka.charStart === 'number' ? { charStart: ka.charStart } : {}),
          ...(typeof ka.charEnd === 'number' ? { charEnd: ka.charEnd } : {}),
          ...(ka.segmentId ? { segmentId: ka.segmentId } : {}),
        };
      }
    }
  }

  /* ---------- 3) 只能到页 ---------- */
  if (own?.sourceId) {
    return {
      kind: 'page',
      sourceId: own.sourceId,
      page: own.page ?? 1,
      reason: '这道题的出处只标到整段，精确不到具体句子，所以不标注。',
      ...(typeof own.charStart === 'number' ? { charStart: own.charStart } : {}),
      ...(typeof own.charEnd === 'number' ? { charEnd: own.charEnd } : {}),
      ...(own.segmentId ? { segmentId: own.segmentId } : {}),
    };
  }

  /* ---------- 4) 什么位置都没有（自改题 / 手工题） ---------- */
  return {
    kind: 'none',
    reason: '这道题没有记录原文出处（自选或改造的题常常如此），所以没有可定位的位置。',
  };
}

/**
 * 一句「定位到句子」的界面文案。
 *
 * 单独抽出来是为了两处一致（题卡按钮的 title、阅读器顶部的说明），
 * 也便于测试断言具体措辞。
 */
export function locateLabel(r: LocateResult): string {
  if (r.kind === 'sentence') return `定位回原文（第 ${r.target.page} 页的具体句子）→`;
  if (r.kind === 'page') return `跳到原文（第 ${r.page} 页）→`;
  return '没有原文出处';
}
