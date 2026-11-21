/**
 * 资料级学习路线的存储规范化（2026-11-21 深夜）。
 *
 * ## 为什么与 `study-plan-store.ts` 分开
 *
 * 那是**知识点级**路线（`StudyPlan`：一串知识点 id + order）。
 * 这里是**资料级**路线（`SourceRoute`：资料 → 块 → 章级步骤 + 越界告知）。
 *
 * 两者的形状完全不同，合成一个文件会让两边的注释互相干扰 ——
 * 而那两份注释各自都在解释「为什么是这个形状」，混在一起读的人会弄错。
 *
 * ## 为什么挂在 `settings.sourceRoute`（unknown）
 *
 * 与 `studyPlan` 同一套理由（见 `study-plan-store.ts` 文件头）：
 * - 路线是一个整体，一次写入天然原子（摊成每章一个字段反而更脆）
 * - 新分区要动迁移四件套
 * - 与 `homeWidgets` 的 `unknown + normalize` 是同一个先例
 *
 * ⚠️ 依赖 `importBackup` 那处白名单 bug 已修（今天修的），
 * 否则用户换机器恢复备份后路线会静默消失。
 *
 * ## 为什么逐字段校验而不是强转
 *
 * 这个值来自用户库里的一条记录，可能是手改备份留下的半截对象、
 * 上个版本写的、或者压根不是我们写的东西。强转之后界面会在某个
 * `blocks.map` 上崩掉，用户看到的是整页白屏。
 */

import type { SourceRoute, RouteStep } from '@/core/ai/source-route.ts';

/**
 * 把 unknown 变成可信的路线。
 *
 * 返回 null = 没有可用的路线（与 undefined 同样处理）。
 */
export function normalizeSourceRoute(raw: unknown): SourceRoute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawBlocks = o.blocks;
  if (!Array.isArray(rawBlocks)) return null;

  const blocks: SourceRoute['blocks'] = [];

  for (const rb of rawBlocks) {
    if (!rb || typeof rb !== 'object') continue;
    const b = rb as Record<string, unknown>;
    const rawSteps = b.steps;
    if (!Array.isArray(rawSteps)) continue;

    const steps: RouteStep[] = [];
    for (const rs of rawSteps) {
      if (!rs || typeof rs !== 'object') continue;
      const s = rs as Record<string, unknown>;

      const title = typeof s.title === 'string' ? s.title.trim().slice(0, 60) : '';
      if (title.length === 0) continue;

      const chapterNumber = toInt(s.chapterNumber) ?? 0;

      steps.push({
        chapterNumber,
        title,
        /* 段 id 只留字符串，坏值丢掉（它决定界面上「对应几段」的数字） */
        segmentIds: Array.isArray(s.segmentIds)
          ? s.segmentIds.filter((x): x is string => typeof x === 'string')
          : [],
        reason: typeof s.reason === 'string' ? s.reason.slice(0, 80) : '',
        basis:
          s.basis === 'toc' || s.basis === 'search' || s.basis === 'model'
            ? s.basis
            : /* 不认识的依据归 model —— 最保守，不能假装有目录支撑 */
              'model',
        difficulty: toDifficulty(s.difficulty),
      });
    }

    if (steps.length === 0) continue;

    blocks.push({
      title:
        typeof b.title === 'string' && b.title.trim().length > 0
          ? b.title.trim().slice(0, 40)
          : `第 ${blocks.length + 1} 块`,
      why: typeof b.why === 'string' ? b.why.slice(0, 120) : '',
      steps,
    });
  }

  /* 一条有效步骤都没有 → 没有可用路线 */
  if (blocks.length === 0) return null;

  /* beyond：如实告知资料外的部分 */
  const beyond: SourceRoute['beyond'] = [];
  if (Array.isArray(o.beyond)) {
    for (const rb of o.beyond) {
      if (!rb || typeof rb !== 'object') continue;
      const x = rb as Record<string, unknown>;
      const title = typeof x.title === 'string' ? x.title.trim().slice(0, 60) : '';
      if (title.length === 0) continue;
      beyond.push({
        title,
        note: typeof x.note === 'string' ? x.note.slice(0, 160) : '',
      });
    }
  }

  return {
    subject: typeof o.subject === 'string' ? o.subject.slice(0, 40) : '',
    edition: typeof o.edition === 'string' ? o.edition.slice(0, 60) : '',
    blocks,
    beyond,
    usedSearch: o.usedSearch === true,
    droppedOutOfScope: toInt(o.droppedOutOfScope) ?? 0,
  };
}

/** 路线的总步数（界面显示「共 N 步」用） */
export function routeStepCount(route: SourceRoute): number {
  let n = 0;
  for (const b of route.blocks) n += b.steps.length;
  return n;
}

/**
 * 某一步是否「在资料里能找到对应内容」。
 *
 * 用于界面如实标注：
 * - `true`：这一步对应资料里的 N 段正文（可点进去看）
 * - `false`：这一步在资料里没有直接对应（模型按学科知识补充的）
 *
 * 这正是用户「路线不能超出资料范围」要求的**界面呈现**：
 * 越界的部分不该排进路线，但如果模型判断某步确实需要而资料没有，
 * 界面要说清楚「资料里没有」，而不是假装有。
 */
export function stepHasSourceContent(step: RouteStep): boolean {
  return step.segmentIds.length > 0;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toDifficulty(v: unknown): number | null {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) return null;
  return n;
}