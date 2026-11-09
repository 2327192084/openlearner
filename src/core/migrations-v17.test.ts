import { describe, expect, it } from 'vitest';
import { migrateBackup } from './migrations.ts';
import type { LibraryBackup } from './model.ts';

/**
 * v16 → v17：给题目锚点补 segmentId（2026-11-09）。
 *
 * 这组测试守的是「不猜」：
 *  - page 唯一对应一段 → 填
 *  - page 对不上或对上多段 → 留空
 *
 * 为什么这条比一般迁移更要紧：填错 segmentId 会让「点回原文」
 * 高亮到**别的段落**，而界面上看不出异常 —— 用户会以为原文就长那样。
 */

/** 造一个最小可用的备份对象 */
function backupOf(over: Partial<LibraryBackup> = {}): LibraryBackup {
  return {
    format: 'openleaner-library',
    schemaVersion: 16,
    exportedAt: '2026-11-09T00:00:00.000Z',
    meta: { id: 'library', name: 't', createdAt: '', updatedAt: '', schemaVersion: 16 },
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

function seg(id: string, sourceId: string, page: number) {
  return { id, sourceId, page, index: page, chapter: null, text: 'x', charCount: 1 } as never;
}

function q(id: string, anchors: unknown[]) {
  return { id, deckId: 'd1', anchors, knowledgePointId: null } as never;
}

describe('v16 → v17 迁移：补 segmentId', () => {
  it('page 唯一对应一段时回填', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5), seg('s2', 'src1', 6)],
      questions: [q('q1', [{ sourceId: 'src1', page: 5, charStart: 0, charEnd: 10 }])],
    });

    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.segmentId).toBe('s1');
    expect(out.schemaVersion).toBe(17);
  });

  it('同一 page 对应多段时**留空**，不挑第一条', () => {
    /*
     * 这是本迁移最重要的行为。挑第一条就是现有 bug 的成因，
     * 迁移里再猜一次等于把错误固化。
     */
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5), seg('s2', 'src1', 5)],
      questions: [q('q1', [{ sourceId: 'src1', page: 5, charStart: 0, charEnd: 10 }])],
    });

    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.segmentId).toBeUndefined();
  });

  it('page 找不到对应段落时留空', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5)],
      questions: [q('q1', [{ sourceId: 'src1', page: 99 }])],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.segmentId).toBeUndefined();
  });

  it('不同资料的同一个 page 不互相串（sourceId 必须一起匹配）', () => {
    const b = backupOf({
      sourceSegments: [seg('a', 'srcA', 5), seg('b', 'srcB', 5)],
      questions: [q('q1', [{ sourceId: 'srcB', page: 5 }])],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    /* 各资料各一段，对 srcB 来说唯一 → 应填 b 而不是 a */
    expect(anchors[0]!.segmentId).toBe('b');
  });

  it('已有 segmentId 的原样保留（幂等）', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5)],
      questions: [q('q1', [{ sourceId: 'src1', page: 5, segmentId: 'already' }])],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.segmentId).toBe('already');
  });

  it('不填 quote —— 旧题没有「用了哪句话」的信息，造引文等于假装精确', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5)],
      questions: [q('q1', [{ sourceId: 'src1', page: 5, charStart: 0, charEnd: 100 }])],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.quote).toBeUndefined();
  });

  it('位置字段一个都不改（只加 segmentId）', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5)],
      questions: [
        q('q1', [{ sourceId: 'src1', page: 5, charStart: 12, charEnd: 34, chapter: '第一章' }]),
      ],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]).toMatchObject({
      sourceId: 'src1',
      page: 5,
      charStart: 12,
      charEnd: 34,
      chapter: '第一章',
    });
  });

  it('多锚点的题逐条处理', () => {
    const b = backupOf({
      sourceSegments: [seg('s1', 'src1', 5), seg('s2', 'src1', 9)],
      questions: [
        q('q1', [
          { sourceId: 'src1', page: 5 },
          { sourceId: 'src1', page: 9 },
        ]),
      ],
    });
    const out = migrateBackup(b);
    const anchors = (out.questions[0] as unknown as { anchors: Array<Record<string, unknown>> }).anchors;
    expect(anchors[0]!.segmentId).toBe('s1');
    expect(anchors[1]!.segmentId).toBe('s2');
  });

  it('题目没有 anchors 字段时不炸', () => {
    const b = backupOf({
      sourceSegments: [],
      questions: [{ id: 'q1', deckId: 'd1' } as never],
    });
    expect(() => migrateBackup(b)).not.toThrow();
  });

  it('来源早已从 v1 的备份也能升到 17（迁移链完整）', () => {
    const b = backupOf({ schemaVersion: 1 });
    const out = migrateBackup(b);
    expect(out.schemaVersion).toBe(17);
  });
});
