/**
 * 多张学习地图的存储（2026-11-22 下午，改两级页面时加）。
 *
 * ## 为什么从「一张」改成「多张」
 *
 * 用户原来只有一条路线（信号与系统）。这次他要求：
 *
 * > 每份资料都能创建地图，创建完成后在不同资料底下留个查看地图按钮就行。
 *
 * 也就是**每份资料一张地图，可以并存**。所以不能再用单个
 * `settings.sourceTree` —— 得按 `sourceId` 存一份表。
 *
 * ## 为什么仍然存在 settings 里（不新建表）
 *
 * 与单张时同一个理由（见 `source-tree.ts` 文件头）：
 * - 一条路线一次写入天然原子
 * - 新建表要动迁移四件套（`STORES` / `BACKUP_STORES` /
 *   `StoreRecordMap` / `DB_VERSION`）
 * - `settings` 的导出是**整体展开**的（`sanitizeSettingsForExport`
 *   只 delete 凭据），所以新字段自动进备份，没有白名单风险
 *
 * ## 存储形状
 *
 * ```
 * settings.sourceTrees: { [sourceId]: SourceTree }
 * ```
 *
 * ## ⚠️ 旧数据要能读
 *
 * 上一版存的是 `settings.sourceTree`（单个对象）。用户库里那条
 * 「信号与系统」就是那个形状。所以读取时：
 *   1. `sourceTrees` 有 → 用它
 *   2. 否则 `sourceTree` 有 → 包成 `{ [tree.sourceId]: tree }`
 *
 * **不删旧字段**（保留回退余地，与方案 3.3 的处置一致）。
 *
 * ## 纯函数
 *
 * 不碰 I/O。`normalizeSourceTrees` 负责把任意形状的库数据变成可信的表。
 */

import type { SourceTree } from './source-tree.ts';
import { normalizeSourceTree } from './source-tree.ts';

/** 全部地图：sourceId → 树 */
export type SourceTreeMap = Record<string, SourceTree>;

/**
 * 把库里的 unknown 变成可信的多地图表。
 *
 * 三种输入都处理：
 *  - `undefined` / 非对象 → 空表
 *  - 旧的单张 `SourceTree`（有 chapters 数组、没有 sourceId 键）→ 包成一张
 *  - 新的表 `{ [sourceId]: tree }` → 逐张校验
 *
 * ## 为什么要认「旧单张」这种形状
 *
 * 因为 App 里同时会读 `settings.sourceTree`（旧的）和
 * `settings.sourceTrees`（新的）。如果只认新形状，用户现有的
 * 那张地图会在升级后凭空消失 —— 这正是这个项目反复记的
 * 「换实现只做了一半」。
 */
export function normalizeSourceTrees(raw: unknown): SourceTreeMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const o = raw as Record<string, unknown>;

  /*
   * 旧单张的形状：直接有 chapters（而不是一堆 sourceId 键）。
   *
   * 判据用 `Array.isArray(o.chapters)` —— 那是 `SourceTree` 的
   * 必填字段，而表的键是 sourceId，不会叫 chapters。
   */
  if (Array.isArray(o.chapters)) {
    const single = normalizeSourceTree(raw);
    if (!single || single.sourceId.length === 0) return {};
    return { [single.sourceId]: single };
  }

  const out: SourceTreeMap = {};
  for (const [sourceId, value] of Object.entries(o)) {
    const tree = normalizeSourceTree(value);
    /* 坏数据整张丢掉，不留半截 —— 半截的树点进去会崩 */
    if (!tree) continue;
    /*
     * 键以树自己带的 sourceId 为准（它更可信）。
     * 树没有 sourceId 时用外层的键补上 —— 否则这张图会对不上任何资料。
     */
    const key = tree.sourceId.length > 0 ? tree.sourceId : sourceId;
    if (key.length === 0) continue;
    out[key] = { ...tree, sourceId: key };
  }
  return out;
}

/** 从「新旧两个字段」里读出地图表（App 里就这么调） */
export function readTreeMap(
  settings: { sourceTrees?: unknown; sourceTree?: unknown } | null | undefined,
): SourceTreeMap {
  if (!settings) return {};
  /* 新表优先 */
  if (settings.sourceTrees && typeof settings.sourceTrees === 'object') {
    const map = normalizeSourceTrees(settings.sourceTrees);
    if (Object.keys(map).length > 0) return map;
  }
  /* 回退到旧的单张 */
  return normalizeSourceTrees(settings.sourceTree);
}

/** 放进一张地图（返回新表，不改原对象） */
export function putTree(map: SourceTreeMap, tree: SourceTree): SourceTreeMap {
  if (tree.sourceId.length === 0) return map;
  return { ...map, [tree.sourceId]: tree };
}

/** 删掉一张地图（返回新表） */
export function dropTree(map: SourceTreeMap, sourceId: string): SourceTreeMap {
  const next = { ...map };
  delete next[sourceId];
  return next;
}

/** 有没有这张地图 */
export function hasTree(map: SourceTreeMap, sourceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, sourceId);
}

/**
 * 每张地图的概况（一级页面列「我的地图」用）。
 *
 * ## 为什么要有这一层
 *
 * 一级页只需要「哪份资料有地图、多少章多少小节、完成几节」——
 * 把整棵树搬过去会让组件碰到不该关心的细节。
 */
export interface TreeSummary {
  sourceId: string;
  subject: string;
  edition: string;
  chapters: number;
  sections: number;
  sectionsDone: number;
  savedAt: string;
}

/** 算一张地图的概况 */
export function summarizeTree(tree: SourceTree): TreeSummary {
  let sections = 0;
  let done = 0;
  for (const ch of tree.chapters) {
    sections += ch.sections.length;
    for (const s of ch.sections) {
      const t = s.tasks;
      const isDone =
        t.resourceDone &&
        t.flashcardsDone &&
        t.exerciseDone &&
        t.custom.every((c) => c.done);
      if (isDone) done += 1;
    }
  }
  return {
    sourceId: tree.sourceId,
    subject: tree.subject,
    edition: tree.edition,
    chapters: tree.chapters.length,
    sections,
    sectionsDone: done,
    savedAt: tree.savedAt,
  };
}

/** 全部地图的概况，按保存时间倒序（最近做的排前面） */
export function summarizeAll(map: SourceTreeMap): TreeSummary[] {
  return Object.values(map)
    .map(summarizeTree)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}