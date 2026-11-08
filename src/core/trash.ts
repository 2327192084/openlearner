/**
 * 回收站：删除的东西先放这里，30 天后彻底删。
 *
 * ## 为什么不是软删除
 *
 * 软删除（给每条记录加 `deletedAt` 标记）看着省事，实际很危险：
 * 每个读取路径都要记得加 `if (!deleted)`。漏一处，已删除的资料
 * 就会出现在列表里、被搜索到、被拿去出题。而项目里已经有过
 * 「answerRecords 分区是空的却一直留着」这种遗留 —— 标记式删除更容易出事。
 *
 * 这里的做法：**真删除**（从原分区拿走），同时把整条记录序列化进回收站。
 * 语义只有一处，「还原」就是把它放回去。
 *
 * ## 30 天是怎么算的
 *
 * 删除那一刻算出 `expiresAt = deletedAt + 30 天`，冗余存下来。
 * 好处是过期判定不用每次算日期（也避免时区问题反复出现），
 * 直接比字符串/时间戳即可。
 *
 * 用**本地日历**推 30 天，不是 UTC：用户看到的是「11月8日删的，12月8日过期」。
 * 这条在 dueAt 上踩过坑（UTC 下东八区凌晨 0-8 点算前一天），这里直接用 Date 的
 * 本地日期加法，不引入时区偏移。
 *
 * ## 大二进制为什么不进来
 *
 * 删一份资料时，它的原始 PDF（几十 MB）和插图（几 MB）会一起被清掉。
 * 把它们塞进回收站会让库膨胀几倍，而它们**都能重新生成**：
 *  - 原始 PDF：用户手里有原文件
 *  - 插图：能从原 PDF 重新裁（前提是 MinerU 缓存还在）
 *
 * 所以刻意不收，但**如实记进 `skipped`** —— 列表里明说
 * 「原始 PDF 未保留，还原后需要重新导入」。静默丢弃是最坏的做法。
 */

import { newId, nowIso } from './id.ts';
import type { TrashKind, TrashRecord } from './model.ts';
import type { StorageAdapter, StoreRecordMap } from './storage/types.ts';

/** 保留天数。用户要求 30 天 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * 过期提醒阈值（小时）。用户要求「距过期 24 小时时弹出提醒」。
 *
 * 为什么提前 24 小时而不是 1 小时：用户不一定每天开这个应用。
 * 提前一天，还有机会在「明天要上班」的晚上看到并决定要不要留。
 */
export const TRASH_REMIND_HOURS = 24;

/** 一小时多少毫秒（只在 hoursUntilExpiry 里用一次，留成常量便于读） */
const HOUR_MS = 60 * 60 * 1000;

/**
 * 算出过期时间。
 *
 * 用**日历加法**而不是 `+30*86400000`：前者在日期层面加，
 * 后者加的是固定毫秒数。两者只差时区/夏令时，但日历加法更符合
 * 「30 天后」这个说法，也更好在界面上解释。
 */
export function computeExpiresAt(deletedAt: string): string {
  const d = new Date(deletedAt);
  if (Number.isNaN(d.getTime())) return deletedAt;
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + TRASH_RETENTION_DAYS);
  return next.toISOString();
}

/** 距离彻底删除还剩多少小时（负数表示已经过期） */
export function hoursUntilExpiry(record: TrashRecord, now: number = Date.now()): number {
  const at = new Date(record.expiresAt).getTime();
  if (Number.isNaN(at)) return 0;
  return (at - now) / HOUR_MS;
}

/** 是否已过期（到点该彻底删了） */
export function isExpired(record: TrashRecord, now: number = Date.now()): boolean {
  return hoursUntilExpiry(record, now) <= 0;
}

/**
 * 是否该提醒用户（距过期 ≤ 24 小时，但还没过期）。
 *
 * 过期的那些不提醒 —— 它们下次清理就没了，提醒「你有个东西要过期」
 * 然后紧接着删掉，只会让人措手不及。
 */
export function shouldRemind(record: TrashRecord, now: number = Date.now()): boolean {
  const h = hoursUntilExpiry(record, now);
  return h > 0 && h <= TRASH_REMIND_HOURS;
}

/** 一次删除要收进回收站的东西 */
export interface TrashEntry {
  kind: TrashKind;
  title: string;
  summary: string;
  payload: unknown;
}

/** 删除时没能收进回收站的东西（大二进制），如实记录 */
export interface TrashSkipped {
  what: string;
  reason: string;
}

/** 清理结果 */
export interface PurgeResult {
  /** 彻底删掉的条数 */
  purged: number;
  /** 其中触发提醒（≤24h）的条数，用于界面提示 */
  reminded: number;
}

/**
 * 回收站服务。
 *
 * 所有删除入口都应该走 `moveToTrash` —— 直接调 `storage.remove`
 * 会绕过回收站，用户就再也找不回来了。
 */
export class TrashService {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * 把一批记录收进回收站（同一个删除动作产生的一批，合成一条 TrashRecord）。
   *
   * 为什么「一批」合成一条而不是每条一条：
   * 删一份资料会连带删 36 个段 + 若干注释。若每条各占一条记录，
   * 回收站里会瞬间多出几十条，用户根本不知道哪几条是「同一次删除」。
   * 合成一条后，还原也是「整份资料一起回来」——那才符合直觉。
   *
   * 第一条 entry 视为**主记录**（用户看到的就是它）。
   */
  async moveToTrash(
    entries: TrashEntry[],
    skipped: TrashSkipped[] = [],
  ): Promise<TrashRecord | null> {
    if (entries.length === 0) return null;

    const primary = entries[0]!;
    const deletedAt = nowIso();
    const record: TrashRecord = {
      id: newId('trash'),
      kind: primary.kind,
      originalId: extractId(primary.payload),
      title: primary.title,
      summary: primary.summary,
      payload: primary.payload,
      attachments: entries.slice(1).map((e) => ({ kind: e.kind, payload: e.payload })),
      skipped: skipped.map((s) => ({ what: s.what, reason: s.reason })),
      deletedAt,
      expiresAt: computeExpiresAt(deletedAt),
    };

    await this.storage.put('trash', record);
    return record;
  }

  /** 列出回收站，最近删的在前 */
  async list(): Promise<TrashRecord[]> {
    const all = await this.storage.getAll('trash');
    return all.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  }

  /** 只看某类 */
  async listByKind(kind: TrashKind): Promise<TrashRecord[]> {
    const all = await this.list();
    return all.filter((r) => r.kind === kind);
  }

  /** 有没有东西快要彻底删了（启动时用它决定要不要弹提醒） */
  async pendingReminders(now: number = Date.now()): Promise<TrashRecord[]> {
    const all = await this.list();
    return all.filter((r) => shouldRemind(r, now));
  }

  /**
   * 还原一条。把主记录与附属记录一起放回各自分区。
   *
   * ## 同名冲突怎么办
   *
   * 不覆盖。如果原 id 已经被新记录占用（用户删了又新建了同 id 的东西，
   * 理论上不该发生，但备份恢复可能造成），这里**照原 id 写回** ——
   * 因为回收站里的 id 就是当初那条记录的 id，覆盖等于让它回到删除前。
   *
   * 真正的风险是「资料已删除、但它的段被单独还原」这种半截状态，
   * 所以入口只在「还原」时按整批处理，不提供「只还原其中一段」。
   */
  async restore(id: string): Promise<{ restored: number } | null> {
    const rec = await this.storage.get('trash', id);
    if (!rec) return null;

    let restored = 0;

    // 主记录
    await this.putBack(rec.kind, rec.payload);
    restored += 1;

    // 附属记录
    for (const a of rec.attachments) {
      await this.putBack(a.kind, a.payload);
      restored += 1;
    }

    await this.storage.remove('trash', id);
    return { restored };
  }

  /** 彻底删除一条（不可恢复） */
  async purge(id: string): Promise<boolean> {
    const rec = await this.storage.get('trash', id);
    if (!rec) return false;
    await this.storage.remove('trash', id);
    return true;
  }

  /** 清空回收站 */
  async purgeAll(): Promise<number> {
    const all = await this.storage.getAll('trash');
    for (const r of all) await this.storage.remove('trash', r.id);
    return all.length;
  }

  /**
   * 启动时扫一遍：把已过期的彻底删掉，并报告还有哪些要提醒。
   *
   * ## 为什么启动时扫而不是定时器
   *
   * 这个应用不是常驻后台的（用户开着才用）。定时器在关闭期间不会跑，
   * 而「启动时扫一遍」保证每次打开都会清理，语义更简单。
   * 也不用担心漏 —— 30 天的窗口，用户一个月内总会开一次。
   *
   * 顺带说明为什么不在**每次打开回收站**时才扫：
   * 那意味着不打开回收站就永远不清理，过期的东西会一直占着。
   */
  async sweep(now: number = Date.now()): Promise<PurgeResult> {
    const all = await this.storage.getAll('trash');
    let purged = 0;
    let reminded = 0;

    for (const r of all) {
      if (isExpired(r, now)) {
        await this.storage.remove('trash', r.id);
        purged += 1;
      } else if (shouldRemind(r, now)) {
        reminded += 1;
      }
    }

    return { purged, reminded };
  }

  /** 按 kind 写回对应分区。类型断言集中在这一处，方便审查 */
  private async putBack(kind: TrashKind, payload: unknown): Promise<void> {
    switch (kind) {
      case 'sources':
        return this.storage.put('sources', payload as StoreRecordMap['sources']);
      case 'sourceSegments':
        return this.storage.put('sourceSegments', payload as StoreRecordMap['sourceSegments']);
      case 'sourceAnnotations':
        return this.storage.put('sourceAnnotations', payload as StoreRecordMap['sourceAnnotations']);
      case 'knowledgePoints':
        return this.storage.put('knowledgePoints', payload as StoreRecordMap['knowledgePoints']);
      case 'decks':
        return this.storage.put('decks', payload as StoreRecordMap['decks']);
      case 'questions':
        return this.storage.put('questions', payload as StoreRecordMap['questions']);
      case 'notes':
        return this.storage.put('notes', payload as StoreRecordMap['notes']);
      case 'todos':
        return this.storage.put('todos', payload as StoreRecordMap['todos']);
      case 'generationRuns':
        return this.storage.put('generationRuns', payload as StoreRecordMap['generationRuns']);
    }
  }
}

/** 从任意带 id 的记录里取 id；取不到返回空串（不该发生，但不抛） */
function extractId(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'id' in payload) {
    const id = (payload as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}
