/**
 * 闪卡聚合逻辑的单测（2026-11-14 按用户反馈重写）。
 *
 * ## 用户反馈
 *
 * > 「应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。」
 *
 * 所以这里的关键断言变了：
 *  - **不存在**「来源已删 / alive / stale」这类状态（来源与卡片无关）
 *  - 卡片就是 flashcards 分区里的真记录，不推导
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  countByGroup,
  filterCards,
  toUnifiedCards,
  type UnifiedCard,
} from './flashcard-manage.ts';
import type { FlashcardView } from '@/core/flashcards.ts';
import type { Flashcard } from '@/core/model.ts';

const view = (over: {
  id?: string;
  front?: string;
  back?: string | null;
  sourceKind?: Flashcard['sourceKind'];
  knowledgePointId?: string;
  sourceLabel?: string | null;
}): FlashcardView => {
  const card = {
    id: over.id ?? 'fc1',
    frontText: over.front ?? '导数的定义',
    backText: over.back ?? null,
    backNote: null,
    ...(over.sourceKind ? { sourceKind: over.sourceKind } : {}),
    ...(over.knowledgePointId ? { knowledgePointId: over.knowledgePointId } : {}),
    origin: 'user' as const,
    sourceId: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  } as Flashcard;

  return {
    card,
    front: card.frontText,
    back: over.back ?? null,
    sourceLabel: over.sourceLabel ?? null,
  };
};

describe('统一形状：不再有「来源还在不在」这种东西', () => {
  it('★ 卡片没有 alive / stale 字段（来源删了与卡片无关）', () => {
    const [c] = toUnifiedCards([view({})]);
    expect(c).not.toHaveProperty('alive');
    expect(c).not.toHaveProperty('stale');
  });

  it('★ 每张卡的 id 就是闪卡自身的 id（不再是「推导出来的假卡」）', () => {
    const [c] = toUnifiedCards([view({ id: 'fc_abc' })]);
    expect(c?.id).toBe('fc_abc');
    expect(c?.key).toBe('fc_abc');
  });

  it('正面背面照搬（内容就是这张卡自己的）', () => {
    const [c] = toUnifiedCards([view({ front: '问题', back: '答案' })]);
    expect(c?.front).toBe('问题');
    expect(c?.back).toBe('答案');
  });

  it('没有背面时是 null（界面据此不显示那一行）', () => {
    const [c] = toUnifiedCards([view({ back: null })]);
    expect(c?.back).toBeNull();
  });
});

describe('分组：按来源追溯（只影响显示，不影响卡片存在）', () => {
  it('sourceKind=point → 知识点组', () => {
    const [c] = toUnifiedCards([view({ sourceKind: 'point' })]);
    expect(c?.group).toBe('point');
  });

  it('sourceKind=wrong → 错题组', () => {
    const [c] = toUnifiedCards([view({ sourceKind: 'wrong' })]);
    expect(c?.group).toBe('wrong');
  });

  it('sourceKind=manual → 手写组', () => {
    const [c] = toUnifiedCards([view({ sourceKind: 'manual' })]);
    expect(c?.group).toBe('manual');
  });

  it('旧卡没有 sourceKind：有 knowledgePointId 就当归到知识点组', () => {
    const [c] = toUnifiedCards([view({ knowledgePointId: 'kp1' })]);
    expect(c?.group).toBe('point');
  });

  it('旧卡没有 sourceKind 也没有 knowledgePointId → 手写组', () => {
    const [c] = toUnifiedCards([view({})]);
    expect(c?.group).toBe('manual');
  });

  it('sourceKind=ai 归到手写组（它不是来源分类，而是生成方式）', () => {
    /*
     * 'ai' 是「怎么来的」而不是「从哪来」。界面上分组按来源，
     * AI 生成的卡可能来自知识点（那时 sourceKind 会是 point）。
     * 单独出现 'ai' 时归 manual 组是安全的兜底，不会漏显示。
     */
    const [c] = toUnifiedCards([view({ sourceKind: 'ai' })]);
    expect(c?.group).toBe('manual');
  });
});

describe('来源标签只是追溯，没有也不报错', () => {
  it('有标签就带上', () => {
    const [c] = toUnifiedCards([view({ sourceLabel: '信号与系统 · 第2章' })]);
    expect(c?.sourceLabel).toBe('信号与系统 · 第2章');
  });

  it('没有标签是 null（不是错误状态）', () => {
    const [c] = toUnifiedCards([view({ sourceLabel: null })]);
    expect(c?.sourceLabel).toBeNull();
  });
});

describe('计数', () => {
  const cards = toUnifiedCards([
    view({ id: 'a', sourceKind: 'point' }),
    view({ id: 'b', sourceKind: 'wrong' }),
    view({ id: 'c', sourceKind: 'manual' }),
  ]);

  it('三种分组各算各的', () => {
    expect(countByGroup(cards)).toEqual({ point: 1, wrong: 1, manual: 1, total: 3 });
  });

  it('总数 = 各分组之和', () => {
    const n = countByGroup(cards);
    expect(n.point + n.wrong + n.manual).toBe(n.total);
  });

  it('空列表全是 0', () => {
    expect(countByGroup([])).toEqual({ point: 0, wrong: 0, manual: 0, total: 0 });
  });
});

describe('筛选', () => {
  const cards: UnifiedCard[] = toUnifiedCards([
    view({ id: 'a', front: '导数的定义', back: '差商的极限', sourceKind: 'point' }),
    view({ id: 'b', front: '同一函数判断', back: '定义域与对应法则都要相同', sourceKind: 'wrong' }),
  ]);

  it('默认不过滤', () => {
    expect(filterCards(cards, DEFAULT_FILTER)).toHaveLength(2);
  });

  it('按分组筛', () => {
    expect(filterCards(cards, { ...DEFAULT_FILTER, group: 'point' })).toHaveLength(1);
    expect(filterCards(cards, { ...DEFAULT_FILTER, group: 'wrong' })).toHaveLength(1);
    expect(filterCards(cards, { ...DEFAULT_FILTER, group: 'manual' })).toHaveLength(0);
  });

  it('★ 搜索同时搜正面和背面（用户只记得那句话，不记得在哪一面）', () => {
    const r = filterCards(cards, { ...DEFAULT_FILTER, query: '定义域' });
    expect(r).toHaveLength(1);
    expect(r[0]?.group).toBe('wrong');
  });

  it('搜索不区分大小写', () => {
    const latin = toUnifiedCards([view({ front: 'Laplace Transform', sourceKind: 'manual' })]);
    expect(filterCards(latin, { ...DEFAULT_FILTER, query: 'laplace' })).toHaveLength(1);
  });

  it('空搜索词等同于不过滤', () => {
    expect(filterCards(cards, { ...DEFAULT_FILTER, query: '   ' })).toHaveLength(2);
  });

  it('搜不到返回空（界面据此显示空态）', () => {
    expect(filterCards(cards, { ...DEFAULT_FILTER, query: '不可能出现的词' })).toHaveLength(0);
  });

  it('分组 + 搜索同时生效', () => {
    /* 「定义域」只在错题卡里，按知识点组筛就应该是空的 */
    const r = filterCards(cards, { group: 'point', query: '定义域' });
    expect(r).toHaveLength(0);
  });
});

describe('不变式', () => {
  it('转换不丢卡、不改顺序', () => {
    const views = [view({ id: 'a' }), view({ id: 'b' }), view({ id: 'c' })];
    const out = toUnifiedCards(views);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('key 唯一（React 列表需要）', () => {
    const out = toUnifiedCards([view({ id: 'a' }), view({ id: 'b' })]);
    expect(new Set(out.map((c) => c.key)).size).toBe(2);
  });
});
