/**
 * 闪卡管理页的「整理」层：分组方式、导出多选、导出选项的**纯逻辑**（2026-11-23 晚）。
 *
 * ## 为什么单独一个文件
 *
 * `FlashcardsPage.tsx` 已经 1158 行（硬约束 8 的基线是 844），
 * 再往里塞状态机与文案计算就没法读了。这里的每条规则都能脱离 React 单测，
 * 而它们的失效方式恰恰是**关系错**（数字对不上、按钮文案和实际动作不一致），
 * 那种错误只有断言能抓。
 *
 * ## 三条必须成立的关系
 *
 * 1. `exportCount()` 的数 = 真正会被导出的卡数。多选开着就说「已选 N 张」，
 *    没开就说「共 N 张」，两者**不许混用**（否则用户按看到的数字期待文件内容）。
 * 2. `canBidirectional()` 只有 review 版式才为真 —— callout 版式下
 *    `??` 双向卡在后面会被解析成两张独立卡，语义完全变了。
 * 3. `folderAssignLabel()` 在没勾任何卡时必须是「先勾卡」而不是「归入 0 张」，
 *    后者看起来像已经做过一次空操作。
 */

import type { FlashcardFolder } from '@/v2/core/flashcard-folders.ts';

/** 列表的分组方式（用户要求三选一，2026-11-23 晚） */
export type GroupMode = 'none' | 'source' | 'folder';

export const GROUP_MODES: { id: GroupMode; label: string; title: string }[] = [
  { id: 'none', label: '不分组', title: '平铺所有卡，找卡最快' },
  { id: 'source', label: '按资料', title: '按卡所属的资料分堆（资料来自地图/课程）' },
  { id: 'folder', label: '按文件夹', title: '按你自己建的文件夹分堆' },
];

/**
 * 分组方式的兜底：宿主没给 `sourceTitleOf` 就分不了资料组。
 *
 * 与旧版 `grouped` 开关同一个原则 —— 不做假开关（硬约束 11）：
 * 分不了资料就在那个选项上灰掉并说明，而不是让用户点了没反应。
 */
export function resolveGroupMode(mode: GroupMode, canGroupBySource: boolean): GroupMode {
  if (mode === 'source' && !canGroupBySource) return 'none';
  return mode;
}

/** 导出按钮文案（数字必须等于真正导出的张数，见文件头第 1 条） */
export function exportButtonLabel(count: number, picking: boolean): string {
  return picking ? `导出所选（${count} 张）` : `导出到 Obsidian（${count} 张）`;
}

/** 多选工具条上的计数文案 */
export function pickSummary(selected: number, total: number): string {
  return `已选 ${selected} / ${total} 张`;
}

/** 「归入文件夹」按钮/下拉文案 */
export function folderAssignLabel(selected: number): string {
  return selected === 0 ? '先勾几张卡再归入' : `归入文件夹（${selected} 张）`;
}

/** 能不能用双向卡（`??`）—— 只有 review 版式有意义 */
export function canBidirectional(format: 'callout' | 'review'): boolean {
  return format === 'review';
}

/** 双向卡不可用时的说明（要写清"为什么"，不是"不可用"三个字） */
export const BIDIRECTIONAL_WHY =
  '双向卡（??）只在「多行问答」版式下有效：callout 版式里 ?? 会被 Obsidian 插件拆成两张独立卡，' +
  '答案会跑到正面去。';

/** 「按标签分卡组」只对 callout 版式有效（review 版式没有卡组概念） */
export function canDeckByTag(format: 'callout' | 'review'): boolean {
  return format === 'callout';
}

/** 导出选项的完整状态（默认值与导出器保持一致，见 flashcard-export.ts） */
export interface ExportOptionState {
  format: 'callout' | 'review';
  clozeAnswer: boolean;
  bidirectional: boolean;
  deckByTag: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptionState = {
  format: 'callout',
  clozeAnswer: true,
  bidirectional: false,
  deckByTag: true,
};

/**
 * 切换版式时把互斥的选项摆正。
 *
 * 不这么做就会出现"界面上勾着双向卡，导出的 callout 里根本没有 ??"
 * 那种设置与实际不符的状态（选项被忽略比选项不存在更糟）。
 */
export function normalizeExportOptions(next: ExportOptionState): ExportOptionState {
  return {
    ...next,
    bidirectional: canBidirectional(next.format) ? next.bidirectional : false,
    deckByTag: canDeckByTag(next.format) ? next.deckByTag : false,
  };
}

/**
 * 传给导出器的选项。
 *
 * 只写**非默认**的键 —— 默认值以导出器为准，两边各写一份默认值
 * 早晚会漂移（这一层只负责开关，不负责语义）。
 */
export function toExporterOptions(state: ExportOptionState): {
  format: 'callout' | 'review';
  includeSource: true;
  clozeAnswer: boolean;
  bidirectional: boolean;
  deckByTag: boolean;
} {
  const n = normalizeExportOptions(state);
  return {
    format: n.format,
    includeSource: true,
    clozeAnswer: n.clozeAnswer,
    bidirectional: n.bidirectional,
    deckByTag: n.deckByTag,
  };
}

/** 新建文件夹输入框的即时校验文案（空 = 可以提交） */
export function newFolderProblem(
  name: string,
  folders: readonly FlashcardFolder[],
): string | null {
  const t = name.trim();
  if (!t) return '名字不能空着';
  if (folders.some((f) => f.name === t)) return '已经有同名文件夹了';
  return null;
}

/** 一组卡的标题（按文件夹分组时，空文件夹也要出名字） */
export function folderGroupTitle(folderId: string | null, folders: readonly FlashcardFolder[]): string {
  if (folderId === null) return '未归入文件夹';
  return folders.find((f) => f.id === folderId)?.name ?? '（文件夹已删除）';
}
