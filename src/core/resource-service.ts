/**
 * 外部资源的存储服务（2026-11-22，方案第 7 步）。
 *
 * ## 为什么做成 Service 而不是散在组件里
 *
 * 项目一贯分工：**组件不碰存储**。而资源要出现在三处
 *（阅读器右栏 / 小节详情 / 未来的规划预搜），
 * 散着写必然出现"两处规则不一样"。
 *
 * ## 为什么存在 settings 里而不新开表
 *
 * 与 `sourceRoute` / `sourceTrees` 同一套理由：
 * - 一次写入天然原子
 * - 新开表要动迁移四件套（`STORES` / `BACKUP_STORES` /
 *   `StoreRecordMap` / `DB_VERSION`）
 * - `sanitizeSettingsForExport` 是**整体展开**的（只 delete 凭据），
 *   所以新字段自动进备份，没有白名单风险
 *
 * ## 资料删了资源跟着删（用户确认过）
 *
 * `pruneForMissingSources` 在读取时清理。**不级联删存储**：
 * 万一是误删资料，备份里资源还在。
 */

import type { LibraryService } from '@/core/library.ts';
import {
  checkResourceUrl,
  isDuplicateUrl,
  makeResource,
  normalizeResources,
  type SourceResource,
} from '@/v2/core/resource-store.ts';

/** settings 里存资源的键 */
const SETTINGS_KEY = 'sourceResources';

export class ResourceService {
  constructor(private readonly library: LibraryService) {}

  /** 读全部资源（sourceId → 列表） */
  async loadAll(): Promise<Record<string, SourceResource[]>> {
    const st = await this.library.getSettings();
    const raw = (st as unknown as Record<string, unknown>)[SETTINGS_KEY];
    return normalizeResources(raw);
  }

  /**
   * 读某份资料的资源。
   *
   * @param sectionId 给了就只返回挂在这一节上的；`null` = 资料级（不属于某节）
   * @param opts.all  true = 返回这份资料的全部（不按小节过滤）
   */
  async listFor(
    sourceId: string,
    sectionId?: string | null,
    opts: { all?: boolean } = {},
  ): Promise<SourceResource[]> {
    const all = await this.loadAll();
    const list = all[sourceId] ?? [];
    if (opts.all) return list;
    if (sectionId === undefined) return list;
    return list.filter((r) => (r.sectionId ?? null) === (sectionId ?? null));
  }

  /**
   * 加一条资源。
   *
   * ## 校验在这里再做一次（不是重复）
   *
   * 界面也会校验（即时反馈），但服务层必须**自己挡一遍**：
   * 以后接规划预搜时，那条路径不经过界面表单。两层都做不是浪费 ——
   * 它们的信任级别不同。
   *
   * 返回 `{ ok:false, reason }` 而不是抛错：坏输入是**正常用户行为**，
   * 不是异常。抛错会让调用方写 try/catch，而漏写就变成白屏。
   */
  async add(input: {
    sourceId: string;
    url: string;
    title?: string | null;
    note?: string;
    source?: 'search' | 'manual';
    sectionId?: string | null;
  }): Promise<{ ok: true; resource: SourceResource } | { ok: false; reason: string }> {
    const check = checkResourceUrl(input.url);
    if (!check.ok) return { ok: false, reason: check.reason };

    const all = await this.loadAll();
    const list = all[input.sourceId] ?? [];

    if (isDuplicateUrl(check.url, list)) {
      return { ok: false, reason: '这条已经在列表里了。' };
    }

    const resource = makeResource({
      sourceId: input.sourceId,
      url: check.url,
      title: input.title ?? null,
      source: input.source ?? 'manual',
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
    });

    const next = { ...all, [input.sourceId]: [...list, resource] };
    await this.library.saveSettings({ [SETTINGS_KEY]: next } as never);
    return { ok: true, resource };
  }

  /** 删一条（返回删除后的全表，便于调用方更新界面） */
  async remove(sourceId: string, id: string): Promise<Record<string, SourceResource[]>> {
    const all = await this.loadAll();
    const list = all[sourceId] ?? [];
    const nextList = list.filter((r) => r.id !== id);

    const next = { ...all };
    if (nextList.length === 0) {
      /* 删空了就把键去掉，别留空数组（否则备份里全是空壳） */
      delete next[sourceId];
    } else {
      next[sourceId] = nextList;
    }

    await this.library.saveSettings({ [SETTINGS_KEY]: next } as never);
    return next;
  }

  /**
   * 把小节被删后"悬空"的资源回收成资料级（方案 7.6）。
   *
   * ## 为什么不删掉它们
   *
   * 方案明确写：「小节被删 / 路线重排 → 挂在小节上的资源**回到资料级，不丢**」。
   * 用户自己粘进来的链接，因为 AI 重排了一次就消失，是不可接受的。
   */
  async reparentOrphans(
    sourceId: string,
    liveSectionIds: ReadonlySet<string>,
  ): Promise<number> {
    const all = await this.loadAll();
    const list = all[sourceId] ?? [];

    let changed = 0;
    const nextList = list.map((r) => {
      if (r.sectionId && !liveSectionIds.has(r.sectionId)) {
        changed += 1;
        return { ...r, sectionId: null };
      }
      return r;
    });

    if (changed === 0) return 0;

    await this.library.saveSettings({
      [SETTINGS_KEY]: { ...all, [sourceId]: nextList },
    } as never);
    return changed;
  }

  /**
   * 清掉指向已不存在资料的资源（用户确认：资料删了资源跟着删）。
   *
   * 返回被清掉的条数。读页面时调一次即可。
   */
  async pruneForMissingSources(liveSourceIds: ReadonlySet<string>): Promise<number> {
    const all = await this.loadAll();
    let removed = 0;

    const next: Record<string, SourceResource[]> = {};
    for (const [sourceId, list] of Object.entries(all)) {
      if (liveSourceIds.has(sourceId)) {
        next[sourceId] = list;
      } else {
        removed += list.length;
      }
    }

    if (removed > 0) {
      await this.library.saveSettings({ [SETTINGS_KEY]: next } as never);
    }
    return removed;
  }
}