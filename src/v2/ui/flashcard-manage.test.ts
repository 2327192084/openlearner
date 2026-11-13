/**
 * 闪卡管理聚合逻辑的单测（2026-11-13 深夜）。
 *
 * 用户要求「错题闪卡改名为闪卡管理」，并确认「两种都要」。
 *
 * 这里钉住两种闪卡的**本质差异**，因为界面要据此决定给不给删除按钮：
 *  - 知识点闪卡是独立记录 → 能删
 *  - 错题闪卡是从复习记录推导的 → **不能删**（删了下次刷新又出现）
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  countByGroup,
  filterCards,
  fromPointFlashcards,
  fromWrongCards,
  type UnifiedCard,
} from './flashcard-manage.ts';
import type { FlashcardView } from '@/core/flashcards.ts';
import type { Card } from '@/v2/core/cards.ts';

const pointView = (over: Partial<FlashcardView> = {}): FlashcardView =>
  ({
    card: {
      id: 'f1',
      knowledgePointId: 'kp1',
      frontText: '导数的定义',
      backNote: '我自己写的笔记',
      origin: 'user',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    point: {
      id: 'kp1',
      sourceId: 's1',
      statement: '导数的定义',
      chapter: '第2章',
    },
    stale: false,
    ...over,
  }) as unknown as FlashcardView;

const wrongCard = (over: Partial<Card> = {}): Card =>
  ({
    id: 'c1',
    kind: 'single',
    prompt: '下列各组函数中，表示同一个函数的是：',
    answer: 'D',
    explanation: '定义域与对应法则都要相同。',
    options: [],
    ...over,
  }) as unknown as Card;

describe('知识点闪卡 → 统一形状', () => {
  it('正面用 frontText，背面用 backNote', () => {
    const [c] = fromPointFlashcards([pointView()]);
    expect(c?.front).toBe('导数的定义');
    expect(c?.back).toBe('我自己写的笔记');
    expect(c?.group).toBe('point');
  });

  it('没有 frontText 时退回知识点的表述（不显示空白正面）', () => {
    const v = pointView();
    // @ts-expect-error 故意造一个缺 frontText 的卡
    v.card.frontText = undefined;
    const [c] = fromPointFlashcards([v]);
    expect(c?.front).toBe('导数的定义');
  });

  it('知识点被删 → alive=false 但仍然列出来', () => {
    const [c] = fromPointFlashcards([pointView({ point: null })]);
    expect(c?.alive).toBe(false);
    expect(c?.front).toBe('导数的定义');
  });

  it('知识点被改过 → stale 透传（界面要提醒「你背的是旧表述」）', () => {
    const [c] = fromPointFlashcards([pointView({ stale: true })]);
    expect(c?.stale).toBe(true);
  });

  it('知识点闪卡可删（它是独立记录）', () => {
    const [c] = fromPointFlashcards([pointView()]);
    expect(c?.deletable).toBe(true);
  });

  it('正面为空也列出来，不悄悄跳过（否则用户以为卡丢了）', () => {
    const v = pointView();
    v.card.frontText = '';
    v.point = null;
    const out = fromPointFlashcards([v]);
    expect(out).toHaveLength(1);
    expect(out[0]?.front).toBe('');
  });

  it('没有笔记时背面是 null（不是空字符串，界面据此不显示那一行）', () => {
    const v = pointView();
    v.card.backNote = null;
    const [c] = fromPointFlashcards([v]);
    expect(c?.back).toBeNull();
  });
});

describe('错题闪卡 → 统一形状', () => {
  const rows = [{ cardId: 'c1', wrongCount: 3, lastWrongDay: '2026-11-10' }];

  it('正面是题干，背面是答案 + 解析', () => {
    const map = new Map([['c1', wrongCard()]]);
    const [c] = fromWrongCards(rows, (id) => map.get(id));
    expect(c?.front).toContain('下列各组函数中');
    expect(c?.back).toContain('答案：D');
    expect(c?.back).toContain('定义域与对应法则都要相同');
  });

  it('★ 错题闪卡不能删（它没有独立存储，删了下次刷新又出现）', () => {
    const map = new Map([['c1', wrongCard()]]);
    const [c] = fromWrongCards(rows, (id) => map.get(id));
    expect(c?.deletable).toBe(false);
  });

  it('题目被删 → 仍然列出并标 alive=false（孤儿数据要看得见才清得掉）', () => {
    const [c] = fromWrongCards(rows, () => undefined);
    expect(c?.alive).toBe(false);
    expect(c?.front).toContain('已不在题库');
  });

  it('只有答案没有解析时，背面只有答案', () => {
    const map = new Map([['c1', wrongCard({ explanation: '' })]]);
    const [c] = fromWrongCards(rows, (id) => map.get(id));
    expect(c?.back).toBe('答案：D');
  });

  it('答案和解析都没有时背面是 null', () => {
    const map = new Map([['c1', wrongCard({ answer: '', explanation: '' })]]);
    const [c] = fromWrongCards(rows, (id) => map.get(id));
    expect(c?.back).toBeNull();
  });

  it('不加「坑」那一行（用户确认先不做）', () => {
    const map = new Map([['c1', wrongCard()]]);
    const [c] = fromWrongCards(rows, (id) => map.get(id));
    expect(c?.back).not.toContain('坑');
  });
});

describe('两种卡合在一起', () => {
  const all: UnifiedCard[] = [
    ...fromPointFlashcards([pointView()]),
    ...fromWrongCards([{ cardId: 'c1', wrongCount: 1, lastWrongDay: '2026-11-10' }], () =>
      wrongCard(),
    ),
  ];

  it('key 前缀区分来源，不会撞 key', () => {
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
  });

  it('计数来自同一份数据', () => {
    expect(countByGroup(all)).toEqual({ point: 1, wrong: 1, broken: 0, total: 2 });
  });

  it('来源失效的也算进 broken', () => {
    const broken = [
      ...fromPointFlashcards([pointView({ point: null })]),
      ...fromWrongCards([{ cardId: 'x', wrongCount: 1, lastWrongDay: '2026-11-10' }], () => undefined),
    ];
    expect(countByGroup(broken).broken).toBe(2);
  });
});

describe('筛选', () => {
  const all: UnifiedCard[] = [
    ...fromPointFlashcards([pointView()]),
    ...fromWrongCards([{ cardId: 'c1', wrongCount: 1, lastWrongDay: '2026-11-10' }], () =>
      wrongCard(),
    ),
  ];

  it('默认不过滤', () => {
    expect(filterCards(all, DEFAULT_FILTER)).toHaveLength(2);
  });

  it('按来源分组', () => {
    expect(filterCards(all, { ...DEFAULT_FILTER, group: 'point' })).toHaveLength(1);
    expect(filterCards(all, { ...DEFAULT_FILTER, group: 'wrong' })).toHaveLength(1);
  });

  it('搜索同时搜正面和背面（用户只记得那句话，不记得在哪一面）', () => {
    /* 「定义域」只出现在错题卡的背面 */
    const r = filterCards(all, { ...DEFAULT_FILTER, query: '定义域' });
    expect(r).toHaveLength(1);
    expect(r[0]?.group).toBe('wrong');
  });

  it('搜索不区分大小写', () => {
    const cards: UnifiedCard[] = [
      { key: 'wrong:x', group: 'wrong', front: 'Laplace Transform', back: null, alive: true, stale: false, deletable: false },
    ];
    expect(filterCards(cards, { ...DEFAULT_FILTER, query: 'laplace' })).toHaveLength(1);
  });

  it('只看来源失效的', () => {
    const mixed = [all[0]!, { ...all[1]!, alive: false }];
    const r = filterCards(mixed, { ...DEFAULT_FILTER, onlyBroken: true });
    expect(r).toHaveLength(1);
    expect(r[0]?.alive).toBe(false);
  });

  it('空搜索词等同于不过滤（不要因为多了个空格就全空）', () => {
    expect(filterCards(all, { ...DEFAULT_FILTER, query: '   ' })).toHaveLength(2);
  });

  it('搜不到就返回空（界面据此显示空态）', () => {
    expect(filterCards(all, { ...DEFAULT_FILTER, query: '不可能出现的词' })).toHaveLength(0);
  });
});
