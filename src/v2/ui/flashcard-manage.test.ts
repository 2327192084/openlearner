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
  NO_FOLDER,
  NO_SOURCE,
  collectTags,
  countByGroup,
  filterCards,
  groupByFolder,
  groupBySource,
  reconcileTag,
  toUnifiedCards,
  type UnifiedCard,
} from './flashcard-manage.ts';
import type { FlashcardFolder } from '@/v2/core/flashcard-folders.ts';
import type { FlashcardView } from '@/core/flashcards.ts';
import type { Flashcard } from '@/core/model.ts';

const view = (over: {
  id?: string;
  front?: string;
  back?: string | null;
  sourceKind?: Flashcard['sourceKind'];
  knowledgePointId?: string;
  sourceLabel?: string | null;
  sourceId?: string | null;
  tags?: string[];
  format?: 'qa' | 'cloze';
}): FlashcardView => {
  const card = {
    id: over.id ?? 'fc1',
    frontText: over.front ?? '导数的定义',
    backText: over.back ?? null,
    backNote: null,
    ...(over.sourceKind ? { sourceKind: over.sourceKind } : {}),
    ...(over.knowledgePointId ? { knowledgePointId: over.knowledgePointId } : {}),
    origin: 'user' as const,
    sourceId: over.sourceId ?? null,
    ...(over.tags ? { tags: over.tags } : {}),
    ...(over.format ? { format: over.format } : {}),
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

  it('sourceKind=manual → 记忆组（2026-11-23 改名：旧手写卡一张不丢）', () => {
    const [c] = toUnifiedCards([view({ sourceKind: 'manual' })]);
    expect(c?.group).toBe('memory');
  });

  it('旧卡没有 sourceKind：有 knowledgePointId 就当归到知识点组', () => {
    const [c] = toUnifiedCards([view({ knowledgePointId: 'kp1' })]);
    expect(c?.group).toBe('point');
  });

  it('旧卡没有 sourceKind 也没有 knowledgePointId → 记忆组', () => {
    const [c] = toUnifiedCards([view({})]);
    expect(c?.group).toBe('memory');
  });

  it('sourceKind=ai 归到记忆组（它不是来源分类，而是生成方式）', () => {
    /*
     * 'ai' 是「怎么来的」而不是「从哪来」。界面上分组按来源，
     * AI 生成的卡可能来自知识点（那时 sourceKind 会是 point）。
     * 单独出现 'ai' 时归 memory 组是安全的兜底，不会漏显示。
     */
    const [c] = toUnifiedCards([view({ sourceKind: 'ai' })]);
    expect(c?.group).toBe('memory');
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
    expect(countByGroup(cards)).toEqual({ point: 1, wrong: 1, memory: 1, total: 3 });
  });

  it('总数 = 各分组之和', () => {
    const n = countByGroup(cards);
    expect(n.point + n.wrong + n.memory).toBe(n.total);
  });

  it('空列表全是 0', () => {
    expect(countByGroup([])).toEqual({ point: 0, wrong: 0, memory: 0, total: 0 });
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
    expect(filterCards(cards, { ...DEFAULT_FILTER, group: 'memory' })).toHaveLength(0);
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

  it('⚠️ 资料维度与标签维度可叠加（AND），少任一层就是半套功能', () => {
    const mixed = toUnifiedCards([
      view({ id: 'a', sourceId: 's1', tags: ['高数'], sourceKind: 'point' }),
      view({ id: 'b', sourceId: 's1', tags: ['错题本'], sourceKind: 'point' }),
      view({ id: 'c', sourceId: 's2', tags: ['高数'], sourceKind: 'point' }),
    ]);
    /* 只按资料 */
    expect(filterCards(mixed, { ...DEFAULT_FILTER, sourceId: 's1' })).toHaveLength(2);
    /* 只按标签 */
    expect(filterCards(mixed, { ...DEFAULT_FILTER, tag: '高数' })).toHaveLength(2);
    /* 两者叠加：s1 且高数 = 只有 a */
    expect(
      filterCards(mixed, { ...DEFAULT_FILTER, sourceId: 's1', tag: '高数' }),
    ).toEqual([expect.objectContaining({ id: 'a' })]);
  });

  it('NO_SOURCE 筛的是「没关联资料」那一组', () => {
    const mixed = toUnifiedCards([
      view({ id: 'a', sourceId: 's1' }),
      view({ id: 'b', sourceId: null }),
    ]);
    const r = filterCards(mixed, { ...DEFAULT_FILTER, sourceId: NO_SOURCE });
    expect(r.map((c) => c.id)).toEqual(['b']);
  });
});

describe('groupBySource：三大类型下按所属资料分类（2026-11-23 用户要求）', () => {
  const titleOf = (id: string) => (id === 's1' ? '信号与系统' : id === 's2' ? '高等数学' : null);

  it('按资料分堆，组内计数与卡数一致', () => {
    const cards = toUnifiedCards([
      view({ id: 'a', sourceId: 's1' }),
      view({ id: 'b', sourceId: 's1' }),
      view({ id: 'c', sourceId: 's2' }),
    ]);
    const groups = groupBySource(cards, titleOf);
    expect(groups).toHaveLength(2);
    /* 卡数多的在前：s1 有 2 张 */
    expect(groups[0]!.sourceId).toBe('s1');
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.cards).toHaveLength(2);
    /* ⚠️ 关系断言：count 必须等于 cards.length（界面组头显示的就是这个数） */
    for (const g of groups) expect(g.count).toBe(g.cards.length);
  });

  it('未关联资料那一组排最后', () => {
    const cards = toUnifiedCards([
      view({ id: 'a', sourceId: null }),
      view({ id: 'b', sourceId: 's1' }),
      view({ id: 'c', sourceId: 's1' }),
    ]);
    const groups = groupBySource(cards, titleOf);
    const last = groups[groups.length - 1]!;
    expect(last.sourceId).toBeNull();
    expect(last.title).toBe('未关联资料');
  });

  it('⚠️ 标题读不到时显示「（资料名读不到）」，不显示裸 id', () => {
    /*
     * 项目记过 `__all__` 那类"把内部 id 露给用户"的事故。
     * 资料被删了或标题没加载出来时，宁可显示占位文字。
     */
    const cards = toUnifiedCards([view({ id: 'a', sourceId: 'deleted-src' })]);
    const groups = groupBySource(cards, () => null);
    expect(groups[0]!.title).toBe('（资料名读不到）');
    expect(groups[0]!.title).not.toContain('deleted-src');
  });

  it('空列表 → 零组（不崩）', () => {
    expect(groupBySource([], titleOf)).toEqual([]);
  });
});

describe('collectTags：标签筛选条的数据', () => {
  it('汇总每个标签的卡数，多的在前', () => {
    const cards = toUnifiedCards([
      view({ id: 'a', tags: ['高数', '错题本'] }),
      view({ id: 'b', tags: ['高数'] }),
      view({ id: 'c', tags: ['高数'] }),
    ]);
    const t = collectTags(cards);
    expect(t[0]).toEqual({ tag: '高数', count: 3 });
    expect(t).toContainEqual({ tag: '错题本', count: 1 });
  });

  it('⚠️ 一张卡带重复标签时，chip 数的是「有几张卡」而不是出现次数', () => {
    /*
     * 这是本项目反复记的重复计数盲区（11-22「0/26 与 0/78」同一类）：
     * 脏数据里一张卡可能带两次 'x'，若按出现次数算，chip 显示「x 2」
     * 但筛出来只有 1 张卡 —— 数字与结果对不上。
     * 反向验证：把 collectTags 里的 new Set(c.tags) 改回 c.tags，这条必须红。
     */
    const cards = toUnifiedCards([
      view({ id: 'a', tags: ['x', 'x'] }),
      view({ id: 'b', tags: ['x'] }),
    ]);
    const t = collectTags(cards);
    expect(t.find((e) => e.tag === 'x')?.count).toBe(2);
    /* 并且这个数与筛选结果一致（关系断言） */
    expect(filterCards(cards, { ...DEFAULT_FILTER, tag: 'x' })).toHaveLength(2);
  });

  it('没标签的卡不进结果', () => {
    const cards = toUnifiedCards([view({ id: 'a', tags: [] })]);
    expect(collectTags(cards)).toEqual([]);
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

describe('reconcileTag：标签被删光后不能卡死在空列表（修用户报的 bug）', () => {
  it('标签还在 → 保留筛选', () => {
    expect(reconcileTag('高数', ['高数', '线代'])).toBe('高数');
  });

  it('标签没了 → 返回 null（调用方清掉 filter.tag）', () => {
    expect(reconcileTag('高数', ['线代'])).toBeNull();
  });

  it('过一个都不剩时也回 null（清掉最后一个标签的情况）', () => {
    expect(reconcileTag('123', [])).toBeNull();
  });

  it('没筛标签时原样 null，不算"标签丢了"', () => {
    expect(reconcileTag(null, ['高数'])).toBeNull();
    expect(reconcileTag(undefined, ['高数'])).toBeNull();
    expect(reconcileTag('', ['高数'])).toBeNull();
  });

  it('大小写敏感，与 normalizeTags / collectTags 同口径', () => {
    expect(reconcileTag('Gauss', ['gauss'])).toBeNull();
  });

  /*
   * 这条是整个 bug 的回归断言：场景重放一遍。
   * 打标签 → 筛它 → 把这张卡的标签删掉 → 界面不能停在 0 张。
   */
  it('回归：打完标签筛上、删标签后筛选自动解除', () => {
    const withTag = [view({ id: 'a', tags: ['123'] }), view({ id: 'b' })];
    const filterTag = '123';
    expect(filterCards(toUnifiedCards(withTag), { ...DEFAULT_FILTER, tag: filterTag })).toHaveLength(1);

    /* 用户把唯一的标签删了（编辑那张卡，tags 清空） */
    const after = [view({ id: 'a', tags: [] }), view({ id: 'b' })];
    const known = collectTags(toUnifiedCards(after)).map((t) => t.tag);
    const nextTag = reconcileTag(filterTag, known);

    expect(nextTag).toBeNull();
    /* 清掉之后必须能看到全部卡，不能还是 0 张 */
    expect(filterCards(toUnifiedCards(after), { ...DEFAULT_FILTER, tag: nextTag })).toHaveLength(2);
  });

  it('反向验证：若不清（原样留着旧 tag），就会停在 0 张', () => {
    const after = [view({ id: 'a', tags: [] }), view({ id: 'b' })];
    const cards = toUnifiedCards(after);
    /* 故意不清：这就是线上发生的事 */
    expect(filterCards(cards, { ...DEFAULT_FILTER, tag: '123' })).toHaveLength(0);
  });
});

describe('文件夹维度（2026-11-23 晚）', () => {
  const folders: FlashcardFolder[] = [
    { id: 'fold_1', name: '高数错题' },
    { id: 'fold_2', name: '信号公式' },
    { id: 'fold_3', name: '空文件夹' },
  ];

  it('toUnifiedCards 注入归属；不传 assigns 时全为 null', () => {
    const views = [view({ id: 'a' }), view({ id: 'b' })];
    expect(toUnifiedCards(views).map((c) => c.folderId)).toEqual([null, null]);
    expect(toUnifiedCards(views, { a: 'fold_1' }).map((c) => c.folderId)).toEqual(['fold_1', null]);
  });

  it('filterCards 按文件夹筛；NO_FOLDER 只看未归入的', () => {
    const cards = toUnifiedCards(
      [view({ id: 'a' }), view({ id: 'b' }), view({ id: 'c' })],
      { a: 'fold_1', b: 'fold_2' },
    );
    expect(filterCards(cards, { ...DEFAULT_FILTER, folder: 'fold_1' }).map((c) => c.id)).toEqual(['a']);
    expect(filterCards(cards, { ...DEFAULT_FILTER, folder: NO_FOLDER }).map((c) => c.id)).toEqual(['c']);
    /* 不传 folder = 不按文件夹筛 */
    expect(filterCards(cards, DEFAULT_FILTER)).toHaveLength(3);
  });

  it('groupByFolder 按用户建文件夹的顺序排，不按卡数排', () => {
    /* fold_1 只有 1 张、fold_2 有 2 张，但仍按建的顺序 fold_1 在前 */
    const cards = toUnifiedCards(
      [view({ id: 'a' }), view({ id: 'b' }), view({ id: 'c' })],
      { a: 'fold_1', b: 'fold_2', c: 'fold_2' },
    );
    const groups = groupByFolder(cards, folders.slice(0, 2));
    expect(groups.map((g) => g.folderId)).toEqual(['fold_1', 'fold_2']);
    expect(groups.map((g) => g.count)).toEqual([1, 2]);
  });

  it('空文件夹照样出现且计数 0（否则"新建"看不出效果）', () => {
    const groups = groupByFolder([], folders);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.count === 0 && g.cards.length === 0)).toBe(true);
  });

  it('「未归入文件夹」有卡才出现，且排最后', () => {
    const cards = toUnifiedCards([view({ id: 'a' }), view({ id: 'b' })], { a: 'fold_1' });
    const groups = groupByFolder(cards, folders);
    expect(groups[groups.length - 1].folderId).toBeNull();
    expect(groups[groups.length - 1].title).toBe('未归入文件夹');
    expect(groups[groups.length - 1].count).toBe(1);

    /* 全都归好类时不该出现兜底组 */
    const tidy = toUnifiedCards([view({ id: 'a' })], { a: 'fold_1' });
    expect(groupByFolder(tidy, folders).some((g) => g.folderId === null)).toBe(false);
  });

  it('归属指向不存在的文件夹 → 落到「未归入」，卡不能凭空消失（关系断言）', () => {
    const cards = toUnifiedCards([view({ id: 'a' }), view({ id: 'b' })], { a: 'fold_deleted' });
    const groups = groupByFolder(cards, folders);
    const sum = groups.reduce((n, g) => n + g.count, 0);
    expect(sum).toBe(cards.length); /* ★ 计数之和 = 卡数 */
    expect(groups.find((g) => g.folderId === null)?.count).toBe(2);
  });

  it('每组的 count 都等于组内卡片数（防重复计数）', () => {
    const cards = toUnifiedCards(
      [view({ id: 'a' }), view({ id: 'b' }), view({ id: 'c' })],
      { a: 'fold_1', b: 'fold_1', c: 'fold_2' },
    );
    for (const g of groupByFolder(cards, folders)) {
      expect(g.count).toBe(g.cards.length);
    }
  });
});
