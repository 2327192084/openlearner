import { describe, expect, it } from 'vitest';
import { migrateBackup } from './migrations.ts';
import { LIBRARY_SCHEMA_VERSION } from './model.ts';
import type { LibraryBackup } from './model.ts';

/**
 * v18 → v19：新增 oralReviews 分区（2026-11-10）。
 *
 * 与 flashcards 那条同一个原则：补空数组，**但不造记录**。
 * 提问式复习的每一条都对应「用户真的答过一次」，编不出来。
 */

function backupOf(over: Record<string, unknown> = {}): LibraryBackup {
  return {
    format: 'openleaner-library',
    schemaVersion: 18,
    exportedAt: '2026-11-10T00:00:00.000Z',
    meta: { id: 'library', name: 't', createdAt: '', updatedAt: '', schemaVersion: 18 },
    settings: {} as never,
    sources: [],
    sourceSegments: [],
    sourceFiles: [],
    sourceImages: [],
    knowledgePoints: [],
    questions: [],
    decks: [],
    reviewRecords: [],
    reviewLogs: [],
    examAttempts: [],
    notes: [],
    todos: [],
    focusSessions: [],
    backends: [],
    courses: [],
    usageRecords: [],
    generationRuns: [],
    sourceAnnotations: [],
    slideDecks: [],
    slideImages: [],
    trash: [],
    flashcards: [],
    secrets: [],
    answerRecords: [],
    ...over,
  } as unknown as LibraryBackup;
}

describe('v18 → v19 迁移：oralReviews', () => {
  it('补空数组并升到最新版本', () => {
    const out = migrateBackup(backupOf());
    expect(out.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(Array.isArray((out as unknown as { oralReviews: unknown[] }).oralReviews)).toBe(true);
    expect((out as unknown as { oralReviews: unknown[] }).oralReviews).toHaveLength(0);
  });

  it('**不自动生成任何记录**', () => {
    const b = backupOf({
      knowledgePoints: [{ id: 'kp1', statement: 'x', cognitiveLevel: 'remember' }],
      flashcards: [{ id: 'fc1', knowledgePointId: 'kp1', frontText: 'x' }],
    });
    const out = migrateBackup(b);
    expect((out as unknown as { oralReviews: unknown[] }).oralReviews).toHaveLength(0);
    /* 已有的闪卡要原样保留（不能因为加了新分区就丢了旧数据） */
    expect((out as unknown as { flashcards: unknown[] }).flashcards).toHaveLength(1);
  });

  it('已有 oralReviews 原样保留（幂等）', () => {
    const existing = [
      {
        id: 'oral1',
        scopeLabel: '第 9 页',
        sourceId: 's1',
        page: 9,
        question: 'q',
        answer: 'a',
        verdict: 'memory',
        quotedFromSource: '原文',
        quoteVerified: true,
        explanation: 'e',
        correction: 'c',
        savedAs: 'brief',
        fullText: null,
        createdAt: '2026-11-10T00:00:00.000Z',
      },
    ];
    const out = migrateBackup(backupOf({ oralReviews: existing }));
    expect((out as unknown as { oralReviews: unknown[] }).oralReviews).toHaveLength(1);
  });

  it('从 v1 一路升到最新（迁移链完整）', () => {
    const out = migrateBackup(backupOf({ schemaVersion: 1 }));
    expect(out.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('oralReviews 被写成非数组时纠正为空数组', () => {
    const out = migrateBackup(backupOf({ oralReviews: 'oops' }));
    expect(Array.isArray((out as unknown as { oralReviews: unknown[] }).oralReviews)).toBe(true);
  });
});
