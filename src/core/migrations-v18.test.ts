import { describe, expect, it } from 'vitest';
import { migrateBackup } from './migrations.ts';
import { LIBRARY_SCHEMA_VERSION } from './model.ts';
import type { LibraryBackup } from './model.ts';

/**
 * v17 → v18：新增 flashcards 分区（2026-11-10）。
 *
 * 这条迁移的要点是「补空数组，但不造卡片」：
 * 升级前没有闪卡功能，所以以后也不该在升级时静默塞进任何卡 ——
 * 那会让用户以为哪来的垃圾。
 */

function backupOf(over: Record<string, unknown> = {}): LibraryBackup {
  return {
    format: 'openleaner-library',
    schemaVersion: 17,
    exportedAt: '2026-11-10T00:00:00.000Z',
    meta: { id: 'library', name: 't', createdAt: '', updatedAt: '', schemaVersion: 17 },
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
    secrets: [],
    answerRecords: [],
    ...over,
  } as unknown as LibraryBackup;
}

describe('v17 → v18 迁移：flashcards', () => {
  it('补空数组，并把版本升到最新', () => {
    const out = migrateBackup(backupOf());
    /* 断言「升到当前最新」而不是写死 18 —— 每加一条迁移都改数字是没意义的负担 */
    expect(out.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(Array.isArray((out as unknown as { flashcards: unknown[] }).flashcards)).toBe(true);
    expect((out as unknown as { flashcards: unknown[] }).flashcards).toHaveLength(0);
  });

  it('**不自动生成任何闪卡**', () => {
    /*
     * 这条是刻意守的：生成闪卡要调模型判断哪些知识点适合，
     * 是一次有成本的调用，而且用户可能不想要。升级时静默塞卡
     * 会让人以为数据脏了。
     */
    const b = backupOf({
      knowledgePoints: [
        { id: 'kp1', statement: '线性时不变系统的定义', cognitiveLevel: 'remember', tags: [] },
        { id: 'kp2', statement: '傅里叶变换', cognitiveLevel: 'understand', tags: [] },
      ],
    });
    const out = migrateBackup(b);
    expect((out as unknown as { flashcards: unknown[] }).flashcards).toHaveLength(0);
  });

  it('已有 flashcards 的备份原样保留（幂等）', () => {
    const existing = [
      {
        id: 'fc1',
        knowledgePointId: 'kp1',
        frontText: '线性时不变系统',
        backNote: null,
        origin: 'user',
        sourceId: 's1',
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z',
      },
    ];
    const out = migrateBackup(backupOf({ flashcards: existing }));
    expect((out as unknown as { flashcards: unknown[] }).flashcards).toHaveLength(1);
  });

  it('从 v1 一路升到最新（迁移链完整）', () => {
    const out = migrateBackup(backupOf({ schemaVersion: 1 }));
    expect(out.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('flashcards 被写成非数组时纠正为空数组', () => {
    /* 手改坏了的备份不该让整次导入失败 */
    const out = migrateBackup(backupOf({ flashcards: 'oops' }));
    expect(Array.isArray((out as unknown as { flashcards: unknown[] }).flashcards)).toBe(true);
  });
});
