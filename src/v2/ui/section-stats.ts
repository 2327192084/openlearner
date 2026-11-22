/**
 * 小节的统计（闪卡数 / 习题数）—— **纯逻辑**（2026-11-22）。
 *
 * ## 为什么需要它，且要能表达"算不出来"
 *
 * 小节详情要显示「这一节有 12 张卡 / 3 道题」。这些数字不在小节里，
 * 得从三条数据反查：
 *
 *   小节 —(segmentIds)→ 知识点（`anchors[].segmentId` 命中）
 *        —(knowledgePointId)→ 闪卡 / 题目
 *
 * ## ⚠️ 用户库里真的会出现"有题但算不出"
 *
 * 实测：用户库「信号与系统」有 10 道题，但 `anchors[].segmentId`
 * **全部指向已不存在的段**（重新整理知识点时段落被替换，锚点没更新）。
 * 照常算会得到 0 —— 用户会以为他一题都没做。
 *
 * 所以返回类型**不是数字**，而是三种状态：
 *  - `{ kind: 'count', n }`：算出来了
 *  - `{ kind: 'unknown' }`：这份资料没有可用来反查的数据
 *  - `{ kind: 'stale', n }`：有 n 条记录，但它们的锚点全失效了
 *
 * 界面据此三种文案。**绝不把 stale 显示成 0**。
 *
 * ## 纯函数
 *
 * 不碰 I/O。入参是内存数组，出参是结构。
 */

import type { SectionNode } from '@/v2/core/source-tree.ts';

/** 一个可数的事物的统计结果 */
export type StatCount =
  | { kind: 'count'; n: number }
  | { kind: 'unknown' }
  /** 有记录，但锚点全失效（`n` = 那些记录的总数，用于如实说明） */
  | { kind: 'stale'; n: number };

/** 一小节的统计 */
export interface SectionStats {
  /** 闪卡：这一节对应的知识点上挂了几张卡 */
  flashcards: StatCount;
  /** 习题：这一节对应的段落上锚了几道题 */
  questions: StatCount;
}

/** 参与反查的最小知识点形状 */
export interface StatPoint {
  id: string;
  /** 它的出处锚点（段 id） */
  segmentIds: readonly string[];
}

/** 参与反查的最小闪卡形状 */
export interface StatCard {
  /**
   * 它挂在哪些知识点上。
   *
   * ⚠️ 用**数组**而不是单个 id：`Flashcard` 同时有旧字段
   * `knowledgePointId` 与新字段 `sourceId2`，而项目自己的
   * `flashcards.ts:251` 用的是「任一命中即算」语义。
   * 两个字段常常写成同一个 id，所以数组**必须去重** ——
   * 否则同一张卡会被数两次。
   */
  knowledgePointIds: readonly string[];
}

/** 参与反查的最小题目形状 */
export interface StatQuestion {
  /** 它的锚点段 id（可能多个，任一命中即算这一节的题） */
  segmentIds: readonly string[];
}

/** 反查输入 */
export interface StatsInput {
  /** 全库知识点 */
  points: readonly StatPoint[];
  /** 全库闪卡 */
  cards: readonly StatCard[];
  /** 全库题目 */
  questions: readonly StatQuestion[];
  /**
   * 这份资料当前的段 id 集合。
   *
   * 用来判断题目的锚点是否**还有效**。没有它就只能报告 unknown
   * 而不是 stale —— 分不清"本来就没题"和"锚点坏了"时，不许猜。
   */
  currentSegmentIds: ReadonlySet<string>;
}

/**
 * 给每一小节算出统计。
 *
 * ## 为什么一次算全部而不是按小节查
 *
 * 30 个小节 × 每节遍历全库 = O(小节数 × 全库)。
 * 这里先把「段 id → 知识点 id」「知识点 id → 卡数」建好索引，
 * 再逐小节查表 —— 与 `source-plan-inputs.ts` 里"一次读全表"同一套理由。
 */
export function buildSectionStats(
  sections: readonly SectionNode[],
  input: StatsInput,
): Map<string, SectionStats> {
  const { points, cards, questions, currentSegmentIds } = input;

  /* 段 id → 知识点 id（一个段可能被多条知识点锚到） */
  const pointsBySegment = new Map<string, string[]>();
  for (const p of points) {
    for (const segId of p.segmentIds) {
      const arr = pointsBySegment.get(segId);
      if (arr) arr.push(p.id);
      else pointsBySegment.set(segId, [p.id]);
    }
  }

  /*
   * 知识点 id → 卡数。
   *
   * ⚠️ 同一张卡只能数一次：它的 `knowledgePointIds` 里
   * 两个字段常常是同一个 id（旧字段 + 新字段），数组已去重，
   * 但卡片之间仍可能重复计数 —— 所以用「卡 id → 它挂的点集合」
   * 逐个点累加时，靠 Set 保证一张卡在**同一个点**上只算一次。
   */
  const cardCountByPoint = new Map<string, number>();
  for (const c of cards) {
    const ids = [...new Set(c.knowledgePointIds)].filter((x) => x.length > 0);
    for (const pid of ids) {
      cardCountByPoint.set(pid, (cardCountByPoint.get(pid) ?? 0) + 1);
    }
  }

  /* 段 id → 题数（去重：一道题可能锚到多个段，但对同一小节只算一次） */
  const questionsBySegment = new Map<string, Set<number>>();
  questions.forEach((q, qi) => {
    for (const segId of q.segmentIds) {
      const set = questionsBySegment.get(segId);
      if (set) set.add(qi);
      else questionsBySegment.set(segId, new Set([qi]));
    }
  });

  /* 全库题目总数里，有多少条的锚点还能对上当前资料的段 */
  const resolvedQuestionIdx = new Set<number>();
  questions.forEach((q, qi) => {
    if (q.segmentIds.some((id) => currentSegmentIds.has(id))) resolvedQuestionIdx.add(qi);
  });

  const out = new Map<string, SectionStats>();

  for (const sec of sections) {
    /* ---------- 闪卡 ---------- */
    let flash: StatCount;
    if (points.length === 0) {
      /* 没有任何知识点 —— 这份资料没整理过，不是 0 张卡 */
      flash = { kind: 'unknown' };
    } else {
      const pointIds = new Set<string>();
      for (const segId of sec.segmentIds) {
        for (const pid of pointsBySegment.get(segId) ?? []) pointIds.add(pid);
      }
      let n = 0;
      for (const pid of pointIds) n += cardCountByPoint.get(pid) ?? 0;

      if (n === 0 && pointIds.size === 0) {
        /*
         * 这一节的段落没有被任何知识点锚到。
         * 如果整份资料一条知识点都没有 → unknown（如实说还没整理）；
         * 有知识点但没锚到这一节 → 真的是 0（这一节还没出知识点）。
         */
        flash = points.length === 0 ? { kind: 'unknown' } : { kind: 'count', n: 0 };
      } else {
        flash = { kind: 'count', n };
      }
    }

    /* ---------- 习题 ---------- */
    let quest: StatCount;
    if (questions.length === 0) {
      quest = { kind: 'count', n: 0 };
    } else {
      const idxs = new Set<number>();
      for (const segId of sec.segmentIds) {
        for (const qi of questionsBySegment.get(segId) ?? []) idxs.add(qi);
      }

      if (idxs.size > 0) {
        quest = { kind: 'count', n: idxs.size };
      } else if (resolvedQuestionIdx.size === 0) {
        /*
         * ⚠️ 这一条是实测出来的（用户库信号与系统 10 道题）：
         * 全库有题，但**所有题的锚点都对不上当前资料的段** ——
         * 重新整理时段落被换了、锚点没跟着更新。
         *
         * 这时不能报 0，要报 stale 并带上总数，界面如实说明原因。
         */
        quest = { kind: 'stale', n: questions.length };
      } else {
        quest = { kind: 'count', n: 0 };
      }
    }

    out.set(sec.id, { flashcards: flash, questions: quest });
  }

  return out;
}

/** 统计结果的文案（界面与测试共用一套，避免两处写法不一致） */
export function statText(stat: StatCount, unit: string): string {
  switch (stat.kind) {
    case 'count':
      return `${stat.n} ${unit}`;
    case 'unknown':
      return '算不出来（这份资料还没整理知识点）';
    case 'stale':
      return `${stat.n} ${unit}，但原文出处已失效`;
  }
}

/** 一条记录是否"真的算出来了且大于 0"（决定按钮要不要可点） */
export function hasReal(stat: StatCount): boolean {
  return stat.kind === 'count' && stat.n > 0;
}

/** 供调试：统计里有多少条是 stale（验证脚本用得上） */
export function countStale(stats: ReadonlyMap<string, SectionStats>): number {
  let n = 0;
  for (const s of stats.values()) {
    if (s.flashcards.kind === 'stale') n += 1;
    if (s.questions.kind === 'stale') n += 1;
  }
  return n;
}