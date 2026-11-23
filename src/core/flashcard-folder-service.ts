/**
 * 闪卡文件夹的存储服务（2026-11-23 晚）。
 *
 * 纯逻辑在 `@/v2/core/flashcard-folders.ts`，这里只负责读写 settings。
 * 与 `ResourceService` 同一套分工（组件不碰存储、规则只写一处）。
 *
 * 形状：`settings.flashcardFolders = { folders, assigns }`（见 flashcard-folders.ts 文件头）
 *
 * ## 为什么"读一次、改一处、整体写回"就够
 *
 * 桌面端是单用户单窗口（Electron 里就一个页面），没有并发写入。
 * 每次操作都从 settings 重新读（`loadAll`），不缓存在实例里 ——
 * 缓存与库一旦不同步，界面上就会出现"删了又回来"。
 */

import type { LibraryService } from '@/core/library.ts';
import {
  EMPTY_FOLDER_SETTINGS,
  folderNameProblem,
  makeFolder,
  normalizeFolderSettings,
  pruneAssigns,
  type FlashcardFolder,
  type FlashcardFolderSettings,
  type FolderNameProblem,
} from '@/v2/core/flashcard-folders.ts';

/** settings 里存文件夹的键 */
const SETTINGS_KEY = 'flashcardFolders';

/** 操作结果：成功带最新全表，失败带原因（界面据此就地报错，不关对话框） */
export type FolderOpResult =
  | { ok: true; settings: FlashcardFolderSettings; folder: FlashcardFolder }
  | { ok: false; reason: FolderNameProblem };

export class FlashcardFolderService {
  constructor(private readonly library: LibraryService) {}

  /** 读全部（读入时防御式归一，坏数据不会让界面崩） */
  async loadAll(): Promise<FlashcardFolderSettings> {
    const st = await this.library.getSettings();
    const raw = (st as unknown as Record<string, unknown>)[SETTINGS_KEY];
    return normalizeFolderSettings(raw);
  }

  private async write(next: FlashcardFolderSettings): Promise<void> {
    await this.library.saveSettings({ [SETTINGS_KEY]: next } as never);
  }

  /**
   * 新建文件夹。
   *
   * 名字先 trim 再判：`folderNameProblem` 负责「空 / 重名」，
   * 这样界面上按回车时不用自己再写一遍判定（两处规则必然走偏）。
   */
  async create(name: string): Promise<FolderOpResult> {
    const settings = await this.loadAll();
    const reason = folderNameProblem(name, settings.folders);
    if (reason) return { ok: false, reason };

    const folder = makeFolder(name);
    const next: FlashcardFolderSettings = {
      folders: [...settings.folders, folder],
      assigns: settings.assigns,
    };
    await this.write(next);
    return { ok: true, settings: next, folder };
  }

  /** 改名（`exceptId` 排除自己，否则改成原名会被判重名） */
  async rename(id: string, name: string): Promise<FolderOpResult | { ok: false; reason: 'missing' }> {
    const settings = await this.loadAll();
    const target = settings.folders.find((f) => f.id === id);
    if (!target) return { ok: false, reason: 'missing' };

    const reason = folderNameProblem(name, settings.folders, id);
    if (reason) return { ok: false, reason };

    const folder = { id, name: name.trim().slice(0, 40) };
    const next: FlashcardFolderSettings = {
      folders: settings.folders.map((f) => (f.id === id ? folder : f)),
      assigns: settings.assigns,
    };
    await this.write(next);
    return { ok: true, settings: next, folder };
  }

  /**
   * 删文件夹。
   *
   * **卡不删**：只把归属清掉，那些卡回到「未归入文件夹」（用户 2026-11-23
   * 明确说这个语义）。删文件夹连带删卡是不可逆的误伤，没人会预期。
   */
  async remove(id: string): Promise<FlashcardFolderSettings> {
    const settings = await this.loadAll();
    const assigns: Record<string, string> = {};
    for (const [cardId, folderId] of Object.entries(settings.assigns)) {
      if (folderId !== id) assigns[cardId] = folderId;
    }
    const next: FlashcardFolderSettings = {
      folders: settings.folders.filter((f) => f.id !== id),
      assigns,
    };
    await this.write(next);
    return next;
  }

  /**
   * 把一批卡放进某个文件夹（`folderId = null` = 移出文件夹）。
   *
   * 一张卡只属一个文件夹，所以这里是**覆盖**不是追加：原本在别的文件夹里的卡
   * 会被搬到这个文件夹（用户可见结果=它从旧组消失、出现在新组，不会两份）。
   *
   * @returns 实际改动的卡数（不变的不算，界面用它判断"要不要提示已保存"）
   */
  async assign(cardIds: readonly string[], folderId: string | null): Promise<number> {
    const settings = await this.loadAll();

    /* 目标文件夹不存在就别写 —— 否则造出指向不存在文件夹的归属 */
    if (folderId !== null && !settings.folders.some((f) => f.id === folderId)) return 0;

    const assigns = { ...settings.assigns };
    let changed = 0;
    for (const cardId of cardIds) {
      if (folderId === null) {
        if (assigns[cardId] !== undefined) {
          delete assigns[cardId];
          changed += 1;
        }
      } else if (assigns[cardId] !== folderId) {
        assigns[cardId] = folderId;
        changed += 1;
      }
    }

    if (changed > 0) await this.write({ folders: settings.folders, assigns });
    return changed;
  }

  /**
   * 剪掉指向已不存在卡片的归属。
   *
   * 页面 `load()` 之后调一次。没变化就不写盘（每次进页面都写一次 settings
   * 会让备份时间戳一直变，而且白费一次 IndexedDB 事务）。
   *
   * @returns 是否真的剪掉了东西
   */
  async prune(aliveCardIds: ReadonlySet<string>): Promise<boolean> {
    const settings = await this.loadAll();
    const { next, changed } = pruneAssigns(settings, aliveCardIds);
    if (changed) await this.write(next);
    return changed;
  }
}

export { EMPTY_FOLDER_SETTINGS };
