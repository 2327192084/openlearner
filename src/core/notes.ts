/**
 * 学习笔记服务。
 *
 * ## 笔记挂在哪
 *
 * 一条笔记挂在**卡片**（题目/知识点）或**资料**上，见 model.ts 里 Note 的说明。
 * 这个服务只负责存取，不做「这条笔记属于哪」的判断 —— 那是调用方的语义。
 *
 * ## 为什么单独一个服务而不是塞进 DeckService
 *
 * 笔记既可能挂在题上，也可能挂在资料/知识点上，横跨三个领域。
 * 塞进任何一个都会让那个服务多出一块与它无关的职责
 * （DeckService 已经有发布校验、导出、作答记录三条线）。
 */

import type { Note } from '@/core/model.ts';
import type { StorageAdapter } from '@/core/storage/types.ts';
import type { TrashService } from '@/core/trash.ts';
import { newId, nowIso } from '@/core/id.ts';

/** 新建笔记的入参 */
export interface NoteInput {
  /** 归属卡片；与 sourceId 至少一个非空 */
  cardId?: string | null;
  /** 归属资料；与 cardId 至少一个非空 */
  sourceId?: string | null;
  body: string;
}

export class NoteService {
  constructor(
    private readonly storage: StorageAdapter,
    /** 回收站（2026-11-08），可选。不传则删除不可恢复 */
    private readonly trash?: TrashService,
  ) {}

  /**
   * 全部笔记，最近更新的在前。
   *
   * 排序用 `sequence`（单调递增）而不是 `updatedAt`：
   * 时间戳只到毫秒，连续两次操作会相同 —— 那时排序就不稳定，
   * 列表顺序会在两次渲染之间抖动。
   */
  async list(): Promise<Note[]> {
    const all = await this.storage.getAll('notes');
    return all.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
  }

  /** 下一个编辑序号（全局递增，跨笔记也比较） */
  private async nextSequence(): Promise<number> {
    const all = await this.storage.getAll('notes');
    let max = 0;
    for (const n of all) {
      if ((n.sequence ?? 0) > max) max = n.sequence ?? 0;
    }
    return max + 1;
  }

  /** 挂在某张卡上的笔记 */
  async listByCard(cardId: string): Promise<Note[]> {
    const all = await this.storage.getAll('notes');
    return all
      .filter((n) => n.cardId === cardId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** 挂在一份资料上的笔记 */
  async listBySource(sourceId: string): Promise<Note[]> {
    const all = await this.storage.getAll('notes');
    return all
      .filter((n) => n.sourceId === sourceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /**
   * 新建一条笔记。
   *
   * 空正文直接拒绝：允许存空笔记会让「笔记列表」里出现一堆点开什么也没有的行，
   * 而用户又会以为是加载失败。
   */
  async create(input: NoteInput): Promise<Note> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error('笔记内容是空的，没有保存');
    }
    if (!input.cardId && !input.sourceId) {
      throw new Error('笔记必须挂在某道题、某个知识点或某份资料上');
    }

    const ts = nowIso();
    const note: Note = {
      id: newId('note'),
      cardId: input.cardId ?? null,
      sourceId: input.sourceId ?? null,
      body,
      createdAt: ts,
      updatedAt: ts,
      sequence: await this.nextSequence(),
    };
    await this.storage.put('notes', note);
    return note;
  }

  /** 改一条笔记的正文 */
  async update(id: string, body: string): Promise<Note> {
    const existing = await this.storage.get('notes', id);
    if (!existing) throw new Error('这条笔记已经不存在了');

    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new Error('笔记内容是空的。要删掉它请用删除。');
    }

    const next: Note = {
      ...existing,
      body: trimmed,
      updatedAt: nowIso(),
      /* 编辑也要提升序号，否则「最近更新的排前面」不会变 */
      sequence: await this.nextSequence(),
    };
    await this.storage.put('notes', next);
    return next;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.storage.get('notes', id);
    if (existing) {
      await this.trash?.moveToTrash([
        {
          kind: 'notes',
          title: existing.body.slice(0, 60),
          summary: '学习笔记',
          payload: existing,
        },
      ]);
    }
    await this.storage.remove('notes', id);
  }

  /**
   * 删掉某张卡/某份资料时，级联清理它的笔记。
   *
   * 为什么要级联：不清理的话，删了题之后那些笔记还在库里，
   * 「全部笔记」页会显示一堆「（所属内容已删除）」的空壳。
   */
  async removeByCard(cardId: string): Promise<number> {
    const mine = await this.listByCard(cardId);
    for (const n of mine) await this.storage.remove('notes', n.id);
    return mine.length;
  }

  async removeBySource(sourceId: string): Promise<number> {
    const mine = await this.listBySource(sourceId);
    for (const n of mine) await this.storage.remove('notes', n.id);
    return mine.length;
  }
}
