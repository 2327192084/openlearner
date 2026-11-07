import { describe, expect, it } from 'vitest';
import {
  buildStudyMap,
  chapterOf,
  sourceOf,
  mapLabel,
  weakestChapter,
  NO_CHAPTER,
  type MapCard,
  type MapPoint,
  type MapProgress,
} from './study-map.ts';

const card = (id: string, sourceId = 's1', extra: Partial<MapCard> = {}): MapCard => ({
  id,
  sourceId,
  prompt: `题 ${id}`,
  anchors: [{ sourceId }],
  ...extra,
});

const prog = (p: Partial<MapProgress> = {}): MapProgress => ({
  mastery: 0,
  due: false,
  learned: false,
  wrong: false,
  ...p,
});

describe('chapterOf：一道题属于哪一章', () => {
  it('优先用知识点上的 chapter', () => {
    const points = new Map<string, MapPoint>([
      ['q1', { id: 'k1', chapter: '第1章 信号与系统', sourceId: 's1' }],
    ]);
    const c = card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '别的章', page: 3 }] });
    expect(chapterOf(c, points)).toBe('第1章 信号与系统');
  });

  it('没有知识点时退到锚点的 chapter', () => {
    const c = card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '第2章' }] });
    expect(chapterOf(c, new Map())).toBe('第2章');
  });

  it('只有页码时退化成「第 N 页」，取最小页', () => {
    const c = card('q1', 's1', {
      anchors: [
        { sourceId: 's1', page: 13 },
        { sourceId: 's1', page: 9 },
      ],
    });
    expect(chapterOf(c, new Map())).toBe('第 9 页');
  });

  it('什么都没有时是未归类，不猜', () => {
    expect(chapterOf(card('q1'), new Map())).toBe(NO_CHAPTER);
  });

  it('知识点有 id 但 chapter 为空 → 不算找到章节', () => {
    const points = new Map<string, MapPoint>([['q1', { id: 'k1', chapter: null, sourceId: 's1' }]]);
    expect(chapterOf(card('q1'), points)).toBe(NO_CHAPTER);
  });
});

/*
 * 这一组锁的是真实库里查出来的问题：
 * 24 道题里有 8 道属于一个 sourceId=null 的已发布题组，
 * 但它们的 anchors[].sourceId 是有值的（就是那本书）。
 * 只看卡片自身的 sourceId，这 8 道会被归进「随机或手工题库」，
 * 学习地图上凭空多出一份不存在的资料。
 */
describe('sourceOf：资料归属的三层回退', () => {
  it('卡片自身有 sourceId → 直接用', () => {
    const c = card('q1', 's_card', { anchors: [{ sourceId: 's_anchor' }] });
    expect(sourceOf(c, new Map())).toBe('s_card');
  });

  it('卡片没有 → 退回知识点所属资料', () => {
    const c = card('q1', '', { anchors: [{ sourceId: 's_anchor' }] });
    const points = new Map([['q1', { id: 'k1', chapter: null, sourceId: 's_point' }]]);
    expect(sourceOf(c, points)).toBe('s_point');
  });

  it('卡片与知识点都没有 → 退回锚点', () => {
    const c = card('q1', '', { anchors: [{ sourceId: 's_anchor' }] });
    expect(sourceOf(c, new Map())).toBe('s_anchor');
  });

  it('三层都没有 → 空串（调用方会归到「随机或手工题库」）', () => {
    const c = card('q1', '', { anchors: [] });
    expect(sourceOf(c, new Map())).toBe('');
  });

  it('聚合时按三层回退分组，不会凭空多出一份资料', () => {
    const cards = [
      // 题组 sourceId 为空，但锚点指向 s1
      card('q1', '', { anchors: [{ sourceId: 's1', page: 9 }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', page: 5 }] }),
    ];
    const map = buildStudyMap(cards, new Map(), new Map(), {
      sourceTitleOf: (id) => (id === 's1' ? '信号与系统' : null),
    });
    expect(map.sources).toHaveLength(1);
    expect(map.sources[0]!.title).toBe('信号与系统');
    expect(map.sources[0]!.total).toBe(2);
  });
});

describe('buildStudyMap：聚合', () => {
  it('按资料与章节分组，并统计总数', () => {
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '第1章' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: '第1章' }] }),
      card('q3', 's1', { anchors: [{ sourceId: 's1', chapter: '第2章' }] }),
    ];
    const map = buildStudyMap(cards, new Map());
    expect(map.all.total).toBe(3);
    expect(map.sources).toHaveLength(1);
    expect(map.sources[0]!.chapters).toHaveLength(2);
  });

  it('掌握度按题数加权，不是各章平均', () => {
    /*
     * 第1章 3 道全熟（1.0），第2章 1 道没学过（0）。
     * 加权平均 = (3*1 + 1*0) / 4 = 0.75
     * 天真平均 = (1.0 + 0) / 2 = 0.5  ← 这是错的
     */
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '第1章' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: '第1章' }] }),
      card('q3', 's1', { anchors: [{ sourceId: 's1', chapter: '第1章' }] }),
      card('q4', 's1', { anchors: [{ sourceId: 's1', chapter: '第2章' }] }),
    ];
    const progress = new Map<string, MapProgress>([
      ['q1', prog({ mastery: 1, learned: true })],
      ['q2', prog({ mastery: 1, learned: true })],
      ['q3', prog({ mastery: 1, learned: true })],
    ]);
    const map = buildStudyMap(cards, progress);
    expect(map.all.mastery).toBeCloseTo(0.75, 5);
  });

  it('没学过的卡算进题数，掌握度按 0 计', () => {
    const cards = [card('q1'), card('q2')];
    const progress = new Map([['q1', prog({ mastery: 1, learned: true })]]);
    const map = buildStudyMap(cards, progress);
    expect(map.all.total).toBe(2);
    expect(map.all.learned).toBe(1);
    expect(map.all.mastery).toBeCloseTo(0.5, 5);
  });

  it('到期数与错题数照实累计', () => {
    const cards = [card('q1'), card('q2'), card('q3')];
    const progress = new Map([
      ['q1', prog({ due: true, wrong: true, learned: true, mastery: 0.2 })],
      ['q2', prog({ due: true, learned: true, mastery: 0.4 })],
    ]);
    const map = buildStudyMap(cards, progress);
    expect(map.all.due).toBe(2);
    expect(map.all.wrong).toBe(1);
  });

  it('章节按掌握度从低到高排（最弱的在最上面）', () => {
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '好' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: '弱' }] }),
    ];
    const progress = new Map([
      ['q1', prog({ mastery: 1, learned: true })],
      ['q2', prog({ mastery: 0.1, learned: true })],
    ]);
    const map = buildStudyMap(cards, progress);
    expect(map.sources[0]!.chapters.map((c) => c.title)).toEqual(['弱', '好']);
  });

  it('资料标题由调用方提供；没有时退回 sourceId，不编造', () => {
    const map = buildStudyMap([card('q1', 'src_x')], new Map());
    expect(map.sources[0]!.title).toBe('src_x');

    const titled = buildStudyMap([card('q1', 'src_x')], new Map(), new Map(), {
      sourceTitleOf: (id) => (id === 'src_x' ? '信号与系统' : null),
    });
    expect(titled.sources[0]!.title).toBe('信号与系统');
  });

  it('空题库不炸，全零', () => {
    const map = buildStudyMap([], new Map());
    expect(map.all.total).toBe(0);
    expect(map.all.mastery).toBe(0);
    expect(map.sources).toEqual([]);
  });

  it('sourceId 为空的卡归到「随机或手工题库」，不丢', () => {
    const map = buildStudyMap([card('q1', '')], new Map());
    expect(map.all.total).toBe(1);
    expect(map.sources[0]!.title).toBe('随机或手工题库');
  });
});

describe('weakestChapter：最该补的一章', () => {
  it('从「学过但不熟」里挑，不选没学过的那章', () => {
    /*
     * 没学过的章掌握度天然是 0，如果直接取最小值，
     * 永远返回「还没开始的那章」—— 那是废话。
     */
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '没开始' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: '学过一半' }] }),
    ];
    const progress = new Map([['q2', prog({ mastery: 0.4, learned: true })]]);
    const w = weakestChapter(buildStudyMap(cards, progress));
    expect(w?.chapter.title).toBe('学过一半');
  });

  it('全都学过时取掌握度最低的', () => {
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: 'A' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: 'B' }] }),
    ];
    const progress = new Map([
      ['q1', prog({ mastery: 0.9, learned: true })],
      ['q2', prog({ mastery: 0.2, learned: true })],
    ]);
    expect(weakestChapter(buildStudyMap(cards, progress))?.chapter.title).toBe('B');
  });

  it('全都没学过时给出题最多的那一章', () => {
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: '多' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: '多' }] }),
      card('q3', 's1', { anchors: [{ sourceId: 's1', chapter: '少' }] }),
    ];
    expect(weakestChapter(buildStudyMap(cards, new Map()))?.chapter.title).toBe('多');
  });

  it('空地图返回 null', () => {
    expect(weakestChapter(buildStudyMap([], new Map()))).toBeNull();
  });

  /*
   * 截图里当场发现的问题：首页写「最该补的是 第 18 页（还生疏，1/1 道练过）」。
   * 只做过 1 道题的章节说明不了「这块弱」，只说明「刚开始」。
   * 而做过 8 道、错了 6 道的章节才是真的弱。
   * 所以打分要用「缺口 × 练过比例」，不能只看掌握度。
   */
  it('做过 1 道且错 的章节，不该赢过做过 8 道错 6 道的章节', () => {
    const cards = [
      // 少数样本章：只有 1 道，做错了（掌握度 0）
      card('a1', 's1', { anchors: [{ sourceId: 's1', chapter: '刚碰了一题' }] }),
      // 大样本章：8 道，练过 8 道，掌握度 0.4
      ...Array.from({ length: 8 }, (_, i) =>
        card(`b${i}`, 's1', { anchors: [{ sourceId: 's1', chapter: '练了很多但还是错' }] }),
      ),
    ];
    const progress = new Map<string, MapProgress>([
      ['a1', prog({ mastery: 0, learned: true, wrong: true })],
      ...Array.from({ length: 8 }, (_, i) => [`b${i}`, prog({ mastery: 0.4, learned: true })] as const),
    ]);
    const w = weakestChapter(buildStudyMap(cards, progress));
    expect(w?.chapter.title).toBe('练了很多但还是错');
  });

  it('两边样本一样时，才纯按掌握度比', () => {
    const cards = [
      card('q1', 's1', { anchors: [{ sourceId: 's1', chapter: 'A' }] }),
      card('q2', 's1', { anchors: [{ sourceId: 's1', chapter: 'B' }] }),
    ];
    const progress = new Map([
      ['q1', prog({ mastery: 0.9, learned: true })],
      ['q2', prog({ mastery: 0.2, learned: true })],
    ]);
    expect(weakestChapter(buildStudyMap(cards, progress))?.chapter.title).toBe('B');
  });
});

describe('mapLabel：文案档位', () => {
  it('各档位与现有 masteryLabel 说法一致', () => {
    expect(mapLabel(0.9)).toBe('很熟');
    expect(mapLabel(0.7)).toBe('熟练');
    expect(mapLabel(0.4)).toBe('有点印象');
    expect(mapLabel(0.1)).toBe('刚起步');
    expect(mapLabel(0)).toBe('没学过');
  });

  /*
   * 这一条锁的是截图里当场发现的问题：
   * 一行写着「没学过」，同一行还写着「1/1 道练过」—— 两句互相打脸。
   * 根因：mastery() 在 intervalDays=1 时 intervalScore=0，
   * 练过一次且做对的题掌握度也可能贴着 0。
   * 所以「练过但分很低」必须单独一档，不能再叫「没学过」。
   */
  it('练过但掌握度是 0 → 不说「没学过」，说「还生疏」', () => {
    expect(mapLabel(0, true)).toBe('还生疏');
    expect(mapLabel(0, false)).toBe('没学过');
    expect(mapLabel(0, true)).not.toBe(mapLabel(0, false));
  });

  /* 截图里发现：「2/2 道练过 · 2 道错着」显示成「还生疏」太轻了 */
  it('练过但全错 → 说「易错」，比「还生疏」更重', () => {
    expect(mapLabel(0, true, true)).toBe('易错');
    expect(mapLabel(0, true, false)).toBe('还生疏');
    expect(mapLabel(0, false, false)).toBe('没学过');
  });

  it('掌握度不低时，有错题也不改档位（错题影响的是排序，不是结论）', () => {
    expect(mapLabel(0.7, true, true)).toBe('熟练');
  });

  it('练过且分不低时不受 learned 影响', () => {
    expect(mapLabel(0.7, true)).toBe(mapLabel(0.7, false));
    expect(mapLabel(0.1, true)).toBe('刚起步');
  });
});
