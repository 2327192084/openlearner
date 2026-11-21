/**
 * 学习顺序路线的存储与规范化（2026-11-21）。
 *
 * ## 为什么路线存在 `settings.studyPlan`（unknown）而不是新分区
 *
 * 三条理由，按重要性排：
 *
 * 1. **路线是一个整体**。它表达的是「这 30 条按这个顺序排」，
 *    不是每条知识点各自的属性。摊成每条的 `planOrder` 会有两个问题：
 *    重排要逐条写 105 个知识点（中途失败会留下「一半新一半旧」的路线，
 *    比没有路线更糟），而且没法表达「这是一次排序的结果」。
 *    存一处就是一次写入，天然原子。
 *
 * 2. **新分区成本高**。要动迁移四件套（STORES / BACKUP_STORES /
 *    StoreRecordMap / DB_VERSION），而这条路线是纯 UI 派生数据。
 *
 * 3. **与 `homeWidgets` 同一个先例**。它是 `unknown` + normalize ——
 *    坏数据只丢那一条，不会让整页白屏。
 *
 * ## ⚠️ 与 `importBackup` 的耦合（已修）
 *
 * 2026-11-21 之前，`importBackup` 恢复 settings 是逐字段白名单，
 * 白名单外的字段恢复备份后会**静默丢失**。`homeWidgets` 与
 * `dailyQuoteEndpoint` 已经因此丢过。
 *
 * 这个字段加进来的同一天把那个白名单拆掉了，
 * 并由 `library.test.ts` 的 4 条回归测试钉住。
 * 改动这里之前先看 `docs/修复-恢复备份丢settings字段.md`。
 *
 * ## 为什么路线里存知识点 id 的快照之外还要存陈述
 *
 * 用户删掉一条知识点后，路线里的那一步就没有对应实体了。
 * 存一份 `statement` 快照，界面才能如实显示「第 5 步：『xxx』（这条知识点已删除）」
 * 而不是让那一步**凭空消失** —— 路线少一步，用户会以为是自己记错了。
 */

/** 路线里的一步 */
export interface StudyPlanStep {
  pointId: string;
  /** 排在第几步（1 基，连续） */
  order: number;
  /** 所属块序号（0 基） */
  blockIndex: number;
  /** 块标题（冗余存一份，块被改过也能显示当时的样子） */
  blockTitle: string;
  /** AI 判断的难度 1–5；null = 未知（不猜） */
  difficulty: number | null;
  /** 为什么排在这个位置 */
  reason: string;
  /** 凭什么这么判断 */
  basis: string;
  /** 知识点陈述的快照（知识点被删后仍能显示这一步是什么） */
  statement: string;
}

/** 一条已确认的路线 */
export interface StudyPlan {
  steps: StudyPlanStep[];
  /** 什么时候确认的（ISO） */
  savedAt: string;
  /**
   * 保存时 AI 有没有排全。
   *
   * 记录这个是因为「没排全」和「排全了」在界面上该说的话不同：
   * 前者要如实写「还有 N 条不在路线里」，否则用户以为整门课都排完了。
   */
  unplaced: number;
}

/**
 * 把 unknown 变成可信的路线结构。
 *
 * ## 为什么逐字段校验而不是 `as StudyPlan` 强转
 *
 * 这个值来自用户库里的一条记录，可能是：
 *  - 手改备份留下的半截对象
 *  - 上一个版本写的、字段名不同
 *  - 压根不是我们写的东西
 *
 * 强转之后界面会在某个 `steps.map` 上崩掉，而用户看到的是整页白屏。
 * 逐字段校验 + 整体丢弃是 `normalizeWidgets` 用的做法，这里照做。
 *
 * 返回 null 表示「没有可用的路线」—— 与 `undefined` 同样处理。
 */
export function normalizeStudyPlan(raw: unknown): StudyPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawSteps = o.steps;
  if (!Array.isArray(rawSteps)) return null;

  const steps: StudyPlanStep[] = [];
  for (const rs of rawSteps) {
    if (!rs || typeof rs !== 'object') continue;
    const r = rs as Record<string, unknown>;

    const pointId = typeof r.pointId === 'string' ? r.pointId.trim() : '';
    if (pointId.length === 0) continue;

    const order = toInt(r.order);
    if (order === null || order < 1) continue;

    steps.push({
      pointId,
      order,
      blockIndex: toInt(r.blockIndex) ?? 0,
      blockTitle: typeof r.blockTitle === 'string' ? r.blockTitle.slice(0, 40) : '',
      difficulty: toDifficulty(r.difficulty),
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 60) : '',
      basis: typeof r.basis === 'string' ? r.basis.slice(0, 80) : '',
      statement: typeof r.statement === 'string' ? r.statement.slice(0, 200) : '',
    });
  }

  if (steps.length === 0) return null;

  /*
   * 按 order 排序并**重新连续编号**。
   *
   * 为什么要重排：一个坏记录可能写着 order: 5, 7, 100 ——
   * 直接信它会让界面上出现「第 5 步、第 7 步、第 100 步」，
   * 而学员实际只有 3 步。「第几步」是相对位置，必须连续。
   */
  steps.sort((a, b) => a.order - b.order);
  for (let i = 0; i < steps.length; i += 1) steps[i]!.order = i + 1;

  return {
    steps,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    unplaced: toInt(o.unplaced) ?? 0,
  };
}

/** 把 PlanOrder（AI 解析结果）转成可存的路线 */
export function planToSteps(
  plan: { blocks: { title: string; items: { pointId: string; order: number; blockIndex: number; difficulty: number | null; reason: string; basis: string }[] }[] },
  statementOf: (pointId: string) => string,
): StudyPlanStep[] {
  const out: StudyPlanStep[] = [];
  for (const block of plan.blocks) {
    for (const item of block.items) {
      out.push({
        pointId: item.pointId,
        order: item.order,
        blockIndex: item.blockIndex,
        blockTitle: block.title,
        difficulty: item.difficulty,
        reason: item.reason,
        basis: item.basis,
        statement: statementOf(item.pointId),
      });
    }
  }
  return out;
}

/**
 * 路线走到第几步（纯函数）。
 *
 * @param plan 已保存的路线
 * @param isLearned 某条知识点是否已学过（由调用方按掌握度判断）
 *
 * 为什么要「按条算」而不是「按块算」：
 * 用户心里的进度是「这几条我会了」，不是「第 2 块整块会了」。
 * 按块算会出现「块里 8 条会了 7 条，进度仍是 0/3 块」的失真。
 */
export function routeProgress(
  plan: StudyPlan,
  isLearned: (pointId: string) => boolean,
): {
  learnedCount: number;
  total: number;
  nextPointId: string | null;
  nextOrder: number | null;
} {
  let learnedCount = 0;
  let next: StudyPlanStep | null = null;

  for (const step of plan.steps) {
    if (isLearned(step.pointId)) {
      learnedCount += 1;
    } else if (!next) {
      next = step;
    }
  }

  return {
    learnedCount,
    total: plan.steps.length,
    nextPointId: next?.pointId ?? null,
    nextOrder: next?.order ?? null,
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/** 难度只认 1–5；其余 null（不猜，不夹到边界值） */
function toDifficulty(v: unknown): number | null {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) return null;
  return n;
}
