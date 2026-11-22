import { describe, expect, it } from 'vitest';
import type { SectionNode } from '@/v2/core/source-tree.ts';
import { assembleStats, flattenSections, type StatsSources } from './stats-assemble.ts';

/**
 * 真实数据 → 小节统计的装配（2026-11-22）。
 *
 * 这一层的风险全在**字段形态**上：`KnowledgePoint.anchors`、
 * `Flashcard` 的新旧两个知识点字段、`Question.anchors`。
 * 认错一个字段，整批数字就变成 0，而界面上看起来"正常"。
 */

function sec(id: string, segmentIds: string[]): SectionNode {
  return {
    id,
    title: id,
    segmentIds,
    origin: 'heading',
    tasks: {
      resources: [],
      resourceDone: false,
      flashcardsDone: false,
      exerciseDone: false,
      custom: [],
    boundFlashcardIds: [],
    boundDeckIds: [],
  },
  };
}

/** 造一份最小真实数据 */
function sources(over: Partial<StatsSources> = {}): StatsSources {
  return {
    points: [],
    cards: [],
    questions: [],
    segments: [
      { id: 'seg-1', sourceId: 'src-1', index: 1, page: 1, chapter: null, text: 'a', charCount: 1 },
      { id: 'seg-2', sourceId: 'src-1', index: 2, page: 2, chapter: null, text: 'b', charCount: 1 },
    ],
    ...over,
  };
}

/** 造一条知识点（只填反查要用的字段） */
function point(id: string, segmentIds: string[]): StatsSources['points'][number] {
  return {
    id,
    statement: 'x',
    chapter: null,
    cognitiveLevel: 'understand',
    tags: [],
    anchors: segmentIds.map((sid) => ({ segmentId: sid, sourceId: 'src-1', page: 1, charStart: 0, charEnd: 1 })),
    quotes: [],
    anchorStatus: 'ok',
    origin: 'material',
  } as unknown as StatsSources['points'][number];
}

describe('assembleStats：知识点锚点 → 闪卡', () => {
  it('按 anchors[].segmentId 反查到知识点，再数它挂的卡', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      points: [point('kp-1', ['seg-1'])],
      cards: [{ knowledgePointId: 'kp-1' } as StatsSources['cards'][number]],
    }));
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('⚠️ 只认新字段的卡（sourceKind=point + sourceId2）也能算到', () => {
    /*
     * 新建的卡不再写旧字段 `knowledgePointId`（见 flashcards.ts:183-185
     * 的写法：两个都写，但**旧卡只有旧的、新卡可能只有新的**）。
     * 只认一个字段会有一整批卡算成 0。
     */
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      points: [point('kp-1', ['seg-1'])],
      cards: [
        { sourceKind: 'point', sourceId2: 'kp-1' } as StatsSources['cards'][number],
      ],
    }));
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('⚠️ 一张卡两个字段指向同一个知识点 → 只算 1 张（不双计数）', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      points: [point('kp-1', ['seg-1'])],
      cards: [
        {
          knowledgePointId: 'kp-1',
          sourceKind: 'point',
          sourceId2: 'kp-1',
        } as StatsSources['cards'][number],
      ],
    }));
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('不挂知识点的卡（sourceKind=manual）不算进任何小节', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      points: [point('kp-1', ['seg-1'])],
      cards: [{ sourceKind: 'manual' } as StatsSources['cards'][number]],
    }));
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 0 });
  });
});

describe('assembleStats：题目锚点', () => {
  it('题目锚在本节的段上 → 算 1 道', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      questions: [
        {
          anchors: [{ segmentId: 'seg-1', sourceId: 'src-1', page: 1, charStart: 0, charEnd: 1 }],
        } as StatsSources['questions'][number],
      ],
    }));
    expect(stats.get('a')!.questions).toEqual({ kind: 'count', n: 1 });
  });

  it('⚠️ 锚点全失效 → stale（如实告知），不是 0', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      questions: Array.from({ length: 10 }, () => ({
        anchors: [{ segmentId: 'seg-gone', sourceId: 'src-1', page: 9, charStart: 0, charEnd: 1 }],
      })) as unknown as StatsSources['questions'],
    }));
    const q = stats.get('a')!.questions;
    expect(q.kind).toBe('stale');
    expect(q).toEqual({ kind: 'stale', n: 10 });
  });
});

describe('assembleStats：坏数据不崩', () => {
  it('知识点 anchors 为空数组 → 不崩，卡算 0', () => {
    expect(() =>
      assembleStats([sec('a', ['seg-1'])], sources({ points: [point('kp-1', [])] })),
    ).not.toThrow();
  });

  it('题目没有 anchors 字段 → 不崩', () => {
    expect(() =>
      assembleStats([sec('a', ['seg-1'])], sources({
        questions: [{} as StatsSources['questions'][number]],
      })),
    ).not.toThrow();
  });

  it('段 id 为 null/空串的锚点被忽略（不污染统计）', () => {
    const stats = assembleStats([sec('a', ['seg-1'])], sources({
      points: [
        {
          ...point('kp-1', []),
          anchors: [
            { segmentId: null as unknown as string, sourceId: 'src-1', page: 1, charStart: 0, charEnd: 1 },
            { segmentId: '', sourceId: 'src-1', page: 1, charStart: 0, charEnd: 1 },
          ],
        } as unknown as StatsSources['points'][number],
      ],
      cards: [{ knowledgePointId: 'kp-1' } as StatsSources['cards'][number]],
    }));
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 0 });
  });
});

describe('flattenSections', () => {
  it('把多章的小节摊平成一维', () => {
    expect(flattenSections([[sec('a', []), sec('b', [])], [sec('c', [])]])).toHaveLength(3);
  });

  it('空输入 → 空数组', () => {
    expect(flattenSections([])).toEqual([]);
    expect(flattenSections([[]])).toEqual([]);
  });
});