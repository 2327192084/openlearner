/**
 * 闪卡文件夹（2026-11-23 晚，用户第二批反馈）。
 *
 * ## 为什么做这个
 *
 * 用户原话：
 *
 * > 按资源分类功能应该增加个类似新建文件夹的功能，
 * > 用户可以自主选择闪卡进行管理分类。
 *
 * 「按资料」只能按卡自带的 `sourceId` 分组，改不了；用户要的是**自己组织**
 * —— 把不同资料的卡塞进同一个「期末冲刺」文件夹里。
 *
 * ## 一张卡只属于一个文件夹（用户 2026-11-23 明确选「一个（像目录）」）
 *
 * 所以归属是 `cardId → folderId` 的单值映射，不是一个数组。
 * 想多归属就得改这个决定，那会影响界面（多选归属）与导出（多条卡片路径），
 * 不是换个类型能收场的，所以这里写死单值。
 *
 * ## 为什么存在 settings 里而不新开表
 *
 * 与 `sourceResources` / `sourceTrees` 同一套理由（见 `resource-service.ts` 文件头）：
 * - 一次写入天然原子（文件夹清单与归属必须同时落，不然会出现指向不存在文件夹的归属）
 * - 新开表要动迁移四件套（`STORES` / `BACKUP_STORES` /
 *   `StoreRecordMap` / `DB_VERSION`）
 * - `sanitizeSettingsForExport` 是**整体展开**的（只 delete 凭据），
 *   所以新字段自动进备份，没有白名单风险
 *
 * 形状：`settings.flashcardFolders = { folders: [...], assigns: { cardId: folderId } }`
 *
 * ## 不往 Flashcard 上加字段
 *
 * 归属如果写进卡里（`card.folderId`），删文件夹就得遍历全库改卡 —— 中途失败
 * 会留下半截状态；而且备份导入时卡与文件夹清单是两张表，谁先到不确定。
 * 放一处、一次写，就没有这类顺序问题。
 *
 * ## 纯函数
 *
 * 不碰 I/O。`normalizeFolderSettings` 把任意形状的库数据变成可信结构 ——
 * 这个值来自用户库，可能是手改备份留下的半截对象，强转会让界面在某个
 * `.map` / `Object.entries` 上崩掉（与 `normalizeResources` 同一套防御）。
 */

import { newId } from '@/core/id.ts';

/** 文件夹名的长度上限（与资源标题 120 不同：这是标签式短名，长了界面放不下） */
export const MAX_FOLDER_NAME = 40;

export interface FlashcardFolder {
  id: string;
  name: string;
}

export interface FlashcardFolderSettings {
  folders: FlashcardFolder[];
  /**
   * 卡 → 文件夹。**一张卡只在一个文件夹里**。
   *
   * 键是卡 id、值是文件夹 id；指向已删文件夹的项在读入时清掉（见 normalize）。
   */
  assigns: Record<string, string>;
}

export const EMPTY_FOLDER_SETTINGS: FlashcardFolderSettings = { folders: [], assigns: {} };

/** 文件夹名的判错结果；`null` = 这个名字可以用 */
export type FolderNameProblem = 'empty' | 'dup' | null;

/**
 * 这个名字能不能用。
 *
 * @param exceptId 改名时要排除自己 —— 否则「把 A 改成 A」会被判重名
 *
 * 重名判定**大小写敏感**，与 `flashcards.ts` 的 `normalizeTags` 同一个口径：
 * 那边 Obsidian 的 `#flashcards/高数` 与 `/高等数学` 是两个卡组，
 * 这边若做成不敏感，就会出现「建得出来但看起来一样」的两个文件夹。
 */
export function folderNameProblem(
  name: string,
  folders: readonly FlashcardFolder[],
  exceptId?: string,
): FolderNameProblem {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'empty';
  if (folders.some((f) => f.id !== exceptId && f.name === trimmed)) return 'dup';
  return null;
}

/** 造一个新文件夹（名字已 trim + 截断；调用方先用 `folderNameProblem` 判过） */
export function makeFolder(name: string, id?: string): FlashcardFolder {
  return {
    id: id ?? newId('fold'),
    name: name.trim().slice(0, MAX_FOLDER_NAME),
  };
}

/**
 * 把库里的 unknown 变成可信的文件夹设置。
 *
 * 丢弃的坏数据（都不是"崩"，是"看起来正常但用不了"，所以静默丢）：
 * - `folders` 非数组 → 空清单
 * - 单项非对象 / 名字 trim 后为空 → 丢
 * - 名字重复（大小写敏感）→ 保留第一个，后面的丢（否则界面上两个同名组
 *   各自显示一半卡，用户没法区分 —— 这正是"重复计数盲区"的一种）
 * - id 缺失或重复 → 生成新 id（重复 id 会让「归入」写到错的文件夹）
 * - `assigns` 里指向不存在文件夹的项 → 丢（卡自动回到「未归入文件夹」）
 * - `assigns` 的键不是字符串 / 值是空串 → 丢
 */
export function normalizeFolderSettings(raw: unknown): FlashcardFolderSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { folders: [], assigns: {} };
  const o = raw as Record<string, unknown>;

  const folders: FlashcardFolder[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  if (Array.isArray(o.folders)) {
    for (const item of o.folders) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;

      const name = typeof it.name === 'string' ? it.name.trim().slice(0, MAX_FOLDER_NAME) : '';
      if (name.length === 0) continue;
      if (seenNames.has(name)) continue;

      let id = typeof it.id === 'string' && it.id.trim().length > 0 ? it.id.trim() : '';
      /* id 重复必须换 —— 否则「归入 A」可能写进 B */
      if (id.length === 0 || seenIds.has(id)) id = newId('fold');

      seenNames.add(name);
      seenIds.add(id);
      folders.push({ id, name });
    }
  }

  const assigns: Record<string, string> = {};
  if (o.assigns && typeof o.assigns === 'object' && !Array.isArray(o.assigns)) {
    for (const [cardId, folderId] of Object.entries(o.assigns as Record<string, unknown>)) {
      const cid = typeof cardId === 'string' ? cardId.trim() : '';
      const fid = typeof folderId === 'string' ? folderId.trim() : '';
      if (cid.length === 0 || fid.length === 0) continue;
      /* 指向已删文件夹 → 丢，卡回到「未归入文件夹」而不是悬空 */
      if (!seenIds.has(fid)) continue;
      assigns[cid] = fid;
    }
  }

  return { folders, assigns };
}

/** 现有文件夹 id 集合（服务层判「归属指向是否还有效」用） */
export function folderIdsOf(settings: FlashcardFolderSettings): Set<string> {
  return new Set(settings.folders.map((f) => f.id));
}

/**
 * 剪掉指向不存在卡片的归属。
 *
 * 卡被删（单卡删、整组删、导入覆盖）后 `assigns` 不会自动变 ——
 * 不剪的话这个对象会一直变大，而且备份里带着一堆死 id。
 * 返回是否有变化，让调用方决定要不要写回（没变化就别写，白费一次存储）。
 */
export function pruneAssigns(
  settings: FlashcardFolderSettings,
  aliveCardIds: ReadonlySet<string>,
): { next: FlashcardFolderSettings; changed: boolean } {
  let changed = false;
  const assigns: Record<string, string> = {};
  for (const [cardId, folderId] of Object.entries(settings.assigns)) {
    if (aliveCardIds.has(cardId)) {
      assigns[cardId] = folderId;
    } else {
      changed = true;
    }
  }
  return { next: changed ? { folders: settings.folders, assigns } : settings, changed };
}
