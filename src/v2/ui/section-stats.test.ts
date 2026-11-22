import { describe, expect, it } from 'vitest';
import { buildSectionStats, countStale, hasReal, statText } from './section-stats.ts';

/**
 * 小节统计（2026-11-22）。
 *
 * 最重要的一条：**「算不出来」不能变成 0**。
 * 用户库真实存在「有 10 道题但锚点全失效」——
 * 显示 0 会让他以为一题没做。这是项目反复记的同一类错误。
 */

function sec(id: string, segmentIds: string[]) {
  return {
    id,
    title: id,
    segmentIds,
    origin: 'heading' as const,
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

const CURRENT = new Set(['seg-1', 'seg-2', 'seg-3']);

describe('buildSectionStats：正常算出数字', () => {
  it('按 段→知识点→闪卡 反查，只算这一节的', () => {
    const stats = buildSectionStats([sec('a', ['seg-1']), sec('b', ['seg-2'])], {
      points: [
        { id: 'kp-1', segmentIds: ['seg-1'] },
        { id: 'kp-2', segmentIds: ['seg-2'] },
      ],
      cards: [
        { knowledgePointIds: ['kp-1'] },
        { knowledgePointIds: ['kp-1'] },
        { knowledgePointIds: ['kp-2'] },
      ],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 2 });
    expect(stats.get('b')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('题目按锚点段反查，一节里同一道题只算一次（多锚点去重）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1', 'seg-2'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [],
      questions: [
        /* 这道题同时锚了 seg-1 和 seg-2，都属于这一节 → 只算 1 道 */
        { segmentIds: ['seg-1', 'seg-2'] },
      ],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.questions).toEqual({ kind: 'count', n: 1 });
  });

  it('真的一道题都没有 → count 0（这时 0 是诚实的）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.questions).toEqual({ kind: 'count', n: 0 });
  });
});

describe('⚠️ 锚点失效不能显示成 0', () => {
  /**
   * 实测情形：用户库「信号与系统」10 道题，anchors[].segmentId
   * 全部指向已不存在的段（重新整理时换过段落）。
   */
  it('有题但所有锚点都失效 → stale（带上真实总数），不是 0', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [],
      /* 10 道题，锚点全指向已不存在的段 */
      questions: Array.from({ length: 10 }, () => ({ segmentIds: ['seg-gone'] })),
      currentSegmentIds: CURRENT,
    });
    const q = stats.get('a')!.questions;
    expect(q).toEqual({ kind: 'stale', n: 10 });
    /* 坏实现会返回 { kind: 'count', n: 0 } —— 那正是要避免的 */
    expect(statText(q, '道题')).toContain('出处已失效');
  });

  it('部分题锚点有效时，这一节算 0 是诚实的（不是全失效）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [],
      cards: [],
      questions: [
        { segmentIds: ['seg-gone'] },
        /* 有一道题锚在 seg-3（有效，但不属于这一节） */
        { segmentIds: ['seg-3'] },
      ],
      currentSegmentIds: CURRENT,
    });
    /* 全库锚点不是"全失效"，所以这一节就是 0 道 */
    expect(stats.get('a')!.questions).toEqual({ kind: 'count', n: 0 });
  });
});

describe('⚠️ 没有知识点时闪卡是 unknown，不是 0', () => {
  it('整份资料没整理过（0 条知识点）→ unknown', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'unknown' });
  });

  it('有知识点但没锚到这一节 → 这一节真的是 0 张卡', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-2'] }],
      cards: [{ knowledgePointIds: ['kp-1'] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 0 });
  });
});

describe('边界与坏数据', () => {
  it('小节没有段 id → 0，不崩', () => {
    const stats = buildSectionStats([sec('a', [])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 0 });
  });

  it('没有挂知识点的闪卡不算进任何小节（不重复计数）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [{ knowledgePointIds: [] }, { knowledgePointIds: [] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 0 });
  });

  it('空小节列表 → 空 map', () => {
    const stats = buildSectionStats([], {
      points: [],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.size).toBe(0);
  });
});

describe('辅助函数', () => {
  it('statText 三态文案分明', () => {
    expect(statText({ kind: 'count', n: 3 }, '张卡')).toBe('3 张卡');
    expect(statText({ kind: 'unknown' }, '张卡')).toContain('算不出来');
    expect(statText({ kind: 'stale', n: 10 }, '道题')).toContain('10 道题');
  });

  it('hasReal 只在 count > 0 时为真（决定按钮能不能点）', () => {
    expect(hasReal({ kind: 'count', n: 1 })).toBe(true);
    expect(hasReal({ kind: 'count', n: 0 })).toBe(false);
    expect(hasReal({ kind: 'unknown' })).toBe(false);
    expect(hasReal({ kind: 'stale', n: 10 })).toBe(false);
  });

  it('countStale 数出 stale 的条数', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [],
      cards: [],
      questions: [{ segmentIds: ['seg-gone'] }],
      currentSegmentIds: CURRENT,
    });
    expect(countStale(stats)).toBe(1);
  });
});
describe('⚠️ 同一张卡不能数两次（新旧字段常写同一个 id）', () => {
  /**
   * `flashcards.ts:184` 建卡时 `sourceId2 = d.sourceId2 ?? d.knowledgePointId`，
   * 所以既有卡的老字段与新字段经常是**同一个 id**。
   * 若按两个字段各累加一次，一张卡会变成 2 张 —— 用户看到的数字就是错的。
   */
  it('knowledgePointIds 里同一个 id 出现两次 → 只算 1 张', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      /* 模拟：knowledgePointId 与 sourceId2 都是 kp-1（assembleStats 已去重） */
      cards: [{ knowledgePointIds: ['kp-1'] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('未去重的重复 id 也不会双计数（buildSectionStats 自己也去重）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [{ knowledgePointIds: ['kp-1', 'kp-1'] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });
});

describe('绑定优先于自动反查（2026-11-22）', () => {
  /**
   * 用户原话：
   * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
   * > 但要留个给用户手工绑定的入口
   *
   * ## 为什么绑定优先
   *
   * 自动反查这条路实测会断：
   *  - 用户库**闪卡 0 张** → 反查永远空
   *  - **41 道题锚点全部失效** → 反查永远空
   *
   * 而绑定是明确的意图。所以只要绑过，就照绑定算。
   */

  function secWithBind(flash: string[], decks: string[]) {
    /* 展开成新对象而不是原地改字段：夹具的 tasks 是字面量，字段被推断成 never[] */
    const s = sec('a', ['seg-1']);
    return {
      ...s,
      tasks: {
        ...s.tasks,
        boundFlashcardIds: flash,
        boundDeckIds: decks,
      },
    };
  }

  it('绑了闪卡 → 按绑定数算，不再走反查', () => {
    const stats = buildSectionStats([secWithBind(['c1', 'c2'], [])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      /* 反查本来会算出 5 张（挂在这个知识点上） */
      cards: Array.from({ length: 5 }, () => ({ knowledgePointIds: ['kp-1'] })),
      questions: [],
      currentSegmentIds: CURRENT,
    });
    const s = stats.get('a')!;
    /* 绑定 2 张 > 反查 5 张：用绑定的（用户明确挑了这两张） */
    expect(s.flashcards).toEqual({ kind: 'count', n: 2 });
    expect(s.origin).toBe('bound');
  });

  it('绑了题组 → 按题组的题目数算', () => {
    const stats = buildSectionStats([secWithBind([], ['d1', 'd2'])], {
      points: [],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
      deckQuestionCount: new Map([
        ['d1', 10],
        ['d2', 5],
      ]),
    });
    const s = stats.get('a')!;
    expect(s.questions).toEqual({ kind: 'count', n: 15 });
    expect(s.boundDecks).toBe(2);
    expect(s.boundQuestions).toBe(15);
  });

  it('⚠️ 绑定的卡被删了 → 如实少算（不虚报）', () => {
    const stats = buildSectionStats([secWithBind(['c1', 'c2', 'c3'], [])], {
      points: [],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
      /* 只剩 c1 与 c3 还在 */
      liveCardIds: new Set(['c1', 'c3']),
    });
    expect(stats.get('a')!.boundCards).toBe(2);
  });

  it('没绑过 → 仍走自动反查（origin=auto）', () => {
    const stats = buildSectionStats([sec('a', ['seg-1'])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [{ knowledgePointIds: ['kp-1'] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    const s = stats.get('a')!;
    expect(s.origin).toBe('auto');
    expect(s.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('⚠️ 绑定与反查不叠加（同一张卡只算一次）', () => {
    /*
     * 坏实现：绑定的 + 反查的相加。那样同一张卡会被数两次，
     * 用户看到的数字比他实际拥有的多。
     */
    const stats = buildSectionStats([secWithBind(['c1'], [])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [{ knowledgePointIds: ['kp-1'] }],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    /* 是 1（绑定），不是 2（叠加） */
    expect(stats.get('a')!.flashcards).toEqual({ kind: 'count', n: 1 });
  });

  it('绑了题组但没给题目数映射 → 按 0 算，不崩', () => {
    const stats = buildSectionStats([secWithBind([], ['d1'])], {
      points: [],
      cards: [],
      questions: [],
      currentSegmentIds: CURRENT,
    });
    const s = stats.get('a')!;
    expect(s.questions).toEqual({ kind: 'count', n: 0 });
    /* 但题组数如实给出来 */
    expect(s.boundDecks).toBe(1);
  });

  it('只绑闪卡不绑题组 → 题组仍走反查', () => {
    const stats = buildSectionStats([secWithBind(['c1'], [])], {
      points: [{ id: 'kp-1', segmentIds: ['seg-1'] }],
      cards: [],
      questions: [{ segmentIds: ['seg-1'] }],
      currentSegmentIds: CURRENT,
    });
    const s = stats.get('a')!;
    expect(s.origin).toBe('bound');
    /* 闪卡按绑定 = 1；题组没绑，走反查 = 1 道 */
    expect(s.flashcards).toEqual({ kind: 'count', n: 1 });
    expect(s.questions).toEqual({ kind: 'count', n: 1 });
  });
});
