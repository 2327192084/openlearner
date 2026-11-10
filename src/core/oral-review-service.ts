/**
 * 提问式复习的存档（2026-11-10）。
 *
 * ## 只做一件事：存取
 *
 * 判定逻辑、提示词、引文校验都在 `core/oral-review.ts`（纯函数）。
 * 这里只管「什么时候写一条、按什么顺序读」。
 *
 * ## 为什么默认不保存
 *
 * 用户可能只是随手试一句，不希望每次问答都往库里塞东西。
 * 保存是**显式动作**（两个按钮：完整原文 / 精简）。
 * 系统设置里的「自动保存」是给「我知道我每条都想要」的人用的。
 */

import type { OralReviewRecord } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';
import { newId, nowIso } from './id.ts';
import type { OralJudgement, OralMaterial } from './oral-review.ts';
import { toBrief } from './oral-review.ts';

/** 保存一条时要提供的东西 */
export interface SaveOralInput {
  material: OralMaterial;
  question: string;
  answer: string;
  judgement: OralJudgement;
  /**
   * 保存形态。
   *
   * `full` 会连同材料全文一起存 —— 那是「我以后要回来读原文」的用法；
   * `brief` 只留说明与纠正，是「我只想知道我错在哪」的用法。
   */
  savedAs: 'full' | 'brief';
}

export class OralReviewService {
  constructor(private readonly storage: StorageAdapter) {}

  /** 全部记录（按时间倒序：最近的在前） */
  async list(): Promise<OralReviewRecord[]> {
    const all = await this.storage.getAll('oralReviews');
    return [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 只读某份资料的记录 */
  async listBySource(sourceId: string): Promise<OralReviewRecord[]> {
    const all = await this.list();
    return all.filter((r) => r.sourceId === sourceId);
  }

  /**
   * 存一条。
   *
   * 精简形态下**不存 fullText** —— 那是这个形态的意义所在：
   * 用户明确只想要「我错在哪」，不是「再读一遍材料」。
   * 存了会让人觉得库在悄悄变大。
   */
  async save(input: SaveOralInput): Promise<OralReviewRecord> {
    const { material, question, answer, judgement, savedAs } = input;
    const brief = toBrief(judgement);

    const record: OralReviewRecord = {
      id: newId('oral'),
      scopeLabel: material.label,
      sourceId: material.sourceId || null,
      page: material.page,
      quote: material.text.slice(0, 80) || null,
      question: question.trim(),
      answer: answer.trim(),
      verdict: judgement.verdict,
      quotedFromSource: judgement.quotedFromSource,
      quoteVerified: judgement.quoteVerified,
      explanation: savedAs === 'brief' ? brief.explanation : judgement.explanation,
      correction: savedAs === 'brief' ? brief.correction : judgement.correction,
      savedAs,
      fullText: savedAs === 'full' ? material.text : null,
      createdAt: nowIso(),
    };

    await this.storage.put('oralReviews', record);
    return record;
  }

  /** 删一条 */
  async remove(id: string): Promise<boolean> {
    const rec = await this.storage.get('oralReviews', id);
    if (!rec) return false;
    await this.storage.remove('oralReviews', id);
    return true;
  }

  /**
   * 统计：最近 N 天里各类判定各多少。
   *
   * 给「复习巩固」页显示一行摘要用 —— 用户能看到「最近 7 天
   * 记错 3 次、理解偏 5 次」，比一个总数有用。
   */
  async recentStats(days = 7, now: Date = new Date()): Promise<{
    memory: number;
    understanding: number;
    correct: number;
    total: number;
  }> {
    const since = new Date(now.getTime() - days * 86400_000).toISOString();
    const all = await this.storage.getAll('oralReviews');
    const recent = all.filter((r) => r.createdAt >= since);

    const out = { memory: 0, understanding: 0, correct: 0, total: recent.length };
    for (const r of recent) out[r.verdict] += 1;
    return out;
  }
}
