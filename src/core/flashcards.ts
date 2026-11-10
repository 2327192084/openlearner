/**
 * 记忆闪卡（2026-11-10）。
 *
 * ## 它解决什么
 *
 * 知识点是「一句话 + 原文引证」，但知识库那一页是用来**翻阅**的：
 * 一屏几十条，扫过去什么也记不住。记忆需要的是「一次只面对一张卡，
 * 先自己想，再翻面核对」——那正是闪卡的形态。
 *
 * 与「今日复习」的分工：
 *  - **今日复习**：按遗忘曲线排期，只做到期的，会写复习间隔（SRS）
 *  - **记忆闪卡**：用户自己挑出来的重点，随时翻，**不参与排期**
 *
 * 两者都在「复习巩固」页里，但性质不同。混在一起会让用户以为
 * 翻闪卡等于完成今天的复习任务。
 *
 * ## 为什么引用知识点而不是复制内容
 *
 * 见 model.ts 的 Flashcard 注释：知识点自带 anchors 与 quotes，
 * 那是「可点回原文」的凭据。复制一份就丢了这层关系。
 *
 * ## 为什么不写 reviewRecords
 *
 * 闪卡翻看**不写复习记录**。理由与「自测」相同：用户在书里随手过一遍，
 * 不该改变他真实的间隔安排。想排期就去「今日复习」。
 * 这个边界如果不划清，两套东西会互相污染 —— 翻了几张闪卡，
 * 到期队列就变了，用户完全无法理解为什么。
 */

import type { Flashcard, KnowledgePoint } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';
import { newId, nowIso } from './id.ts';

/** 建卡时的输入 */
export interface FlashcardDraft {
  knowledgePointId: string;
  /** 正面文本；不传则从知识点自动取 statement */
  frontText?: string;
  backNote?: string | null;
  origin: 'ai' | 'user';
}

/**
 * 带「是否过期」的闪卡视图。
 *
 * 界面需要知道这张卡引用的知识点还在不在 —— 不在了就要提示
 * 「原知识点已删除」，而不是假装正常（那时的背面引文也取不到）。
 */
export interface FlashcardView {
  card: Flashcard;
  /** 引用的知识点；null = 已被删除 */
  point: KnowledgePoint | null;
  /**
   * 是否已「过期」：知识点被删，或正面文本与知识点当前表述不一致。
   *
   * 不一致也要标出来：用户在闪卡上背的是旧表述，而知识点已经改了 ——
   * 不说的话他会拿着过时的说法去考试。
   */
  stale: boolean;
}

export class FlashcardService {
  constructor(private readonly storage: StorageAdapter) {}

  /** 全部闪卡（按创建时间倒序：新加的在前） */
  async list(): Promise<Flashcard[]> {
    const all = await this.storage.getAll('flashcards');
    return [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * 拼出带知识点与过期标记的视图。
   *
   * 一次把知识点全读出来做 Map，而不是逐卡查询 ——
   * 闪卡通常几十上百张，逐卡 await 会让界面明显卡一下。
   */
  async listWithPoints(): Promise<FlashcardView[]> {
    const [cards, points] = await Promise.all([
      this.list(),
      this.storage.getAll('knowledgePoints'),
    ]);
    const byId = new Map(points.map((p) => [p.id, p]));

    return cards.map((card) => {
      const point = byId.get(card.knowledgePointId) ?? null;
      /*
       * 过期的两种情形：
       *  1. 知识点被删（point 为 null）
       *  2. 知识点的表述变了 —— 闪卡上那句已经不是当前的说法
       *
       * 第二种容易被忽略：用户看到闪卡「正常显示」，却不知道自己
       * 背的是旧表述。所以这里也标出来。
       */
      const stale = point === null || point.statement.trim() !== card.frontText.trim();
      return { card, point, stale };
    });
  }

  /**
   * 批量建卡（AI 挑完后用户勾选确认，一次写入）。
   *
   * 为什么批量而不是逐张：用户勾了 20 条，逐张 await 会让按钮卡住
   * 一段时间且没有进度。这里一次写完，只在开始/结束各给一次反馈。
   *
   * **已有的不会重复建**：按 knowledgePointId 去重。用户可能先手动加过
   * 某条，又让 AI 挑了一遍 —— 不该出现两张一模一样的卡。
   */
  async addMany(drafts: readonly FlashcardDraft[], points: readonly KnowledgePoint[]): Promise<Flashcard[]> {
    const pointById = new Map(points.map((p) => [p.id, p]));
    const existing = await this.storage.getAll('flashcards');
    const taken = new Set(existing.map((c) => c.knowledgePointId));

    const ts = nowIso();
    const created: Flashcard[] = [];

    for (const d of drafts) {
      if (taken.has(d.knowledgePointId)) continue;
      const point = pointById.get(d.knowledgePointId);
      if (!point) continue;

      const front = (d.frontText ?? point.statement).trim();
      if (!front) continue;

      const card: Flashcard = {
        id: newId('fc'),
        knowledgePointId: d.knowledgePointId,
        frontText: front,
        backNote: d.backNote ?? null,
        origin: d.origin,
        sourceId: point.sourceId,
        createdAt: ts,
        updatedAt: ts,
      };
      await this.storage.put('flashcards', card);
      taken.add(d.knowledgePointId);
      created.push(card);
    }

    return created;
  }

  /** 建一张 */
  async add(draft: FlashcardDraft, points: readonly KnowledgePoint[]): Promise<Flashcard | null> {
    const out = await this.addMany([draft], points);
    return out[0] ?? null;
  }

  /** 改背面备注 */
  async setBackNote(id: string, note: string | null): Promise<Flashcard | null> {
    const card = await this.storage.get('flashcards', id);
    if (!card) return null;
    const next: Flashcard = {
      ...card,
      backNote: note && note.trim() ? note.trim() : null,
      updatedAt: nowIso(),
    };
    await this.storage.put('flashcards', next);
    return next;
  }

  /**
   * 删一张。
   *
   * **不进回收站**：闪卡是「从知识点里挑出来的引用」，本身不含
   * 独有的内容 —— 原知识点还在，重新挑一次就有了。
   * 把引用塞进回收站会让用户以为丢了什么，还原出来也只是张卡。
   */
  async remove(id: string): Promise<boolean> {
    const card = await this.storage.get('flashcards', id);
    if (!card) return false;
    await this.storage.remove('flashcards', id);
    return true;
  }

  /** 某个知识点是否已经是闪卡（界面用它显示「已加入」而不是重复按钮） */
  async hasForPoint(knowledgePointId: string): Promise<boolean> {
    const all = await this.storage.getAll('flashcards');
    return all.some((c) => c.knowledgePointId === knowledgePointId);
  }

  /**
   * 知识点被删时，把引用它的闪卡一起删掉。
   *
   * 与「删知识点」联动的理由：留着这些卡只会变成一堆「原知识点已删除」的
   * 空壳，用户还得手动清理。但**必须告诉调用方删了几张**，
   * 否则删知识点时静默带走几张闪卡，用户会觉得东西莫名少了。
   *
   * @returns 被删掉的闪卡张数
   */
  async removeForPoint(knowledgePointId: string): Promise<number> {
    const all = await this.storage.getAll('flashcards');
    const hit = all.filter((c) => c.knowledgePointId === knowledgePointId);
    for (const c of hit) await this.storage.remove('flashcards', c.id);
    return hit.length;
  }

  /** 某份资料的闪卡（按资料翻阅时用） */
  async listBySource(sourceId: string): Promise<Flashcard[]> {
    const all = await this.list();
    return all.filter((c) => c.sourceId === sourceId);
  }
}
