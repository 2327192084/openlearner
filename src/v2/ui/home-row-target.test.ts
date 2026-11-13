/**
 * 首页行跳转目标的单测（2026-11-13 深夜）。
 *
 * 用户要求：「点击界面上的题组、错题或是资料能直接跳转到对应的
 * 题组、错题或是资料页面，不用再到对于功能栏打开」。
 *
 * 这里钉的是**四块各去哪**，尤其是两条容易被写错的：
 * - 「题组进度」不该去资料库（那统计的是题目，不是阅读）
 * - 「资料阅读」带页码时要真的带上（否则首页写着「到过第 10 页」，
 *   点进去停在第 1 页，那个数字就成了假的）
 */

import { describe, expect, it } from 'vitest';
import { homeRowAction, targetPageOf } from './home-row-target.ts';

describe('题组进度行 → 学习地图', () => {
  it('带的是 sourceId，去学习地图', () => {
    const a = homeRowAction('study-progress', 'src-1');
    expect(a).toEqual({ kind: 'focus-map', sourceId: 'src-1' });
    expect(targetPageOf(a)).toBe('flow');
  });

  it('不去资料库（那里的行是文件，看不到题目掌握度）', () => {
    const a = homeRowAction('study-progress', 'src-1');
    expect(a.kind).not.toBe('open-source');
  });
});

describe('资料阅读行 → 直接开阅读器', () => {
  it('不带页码时只给 sourceId，由阅读器按 readProgress 自己恢复', () => {
    const a = homeRowAction('read-progress', 'src-2');
    expect(a).toEqual({ kind: 'open-source', sourceId: 'src-2' });
    expect(targetPageOf(a)).toBe('reader');
  });

  it('带页码时把页码一起带上（否则「到过第 N 页」是假的）', () => {
    const a = homeRowAction('read-progress', 'src-2', { page: 10 });
    expect(a).toEqual({ kind: 'open-source', sourceId: 'src-2', page: 10 });
  });

  it('page 为 0 这种边界也照带（不当作「没有」）', () => {
    const a = homeRowAction('read-progress', 'src-2', { page: 0 });
    expect(a).toEqual({ kind: 'open-source', sourceId: 'src-2', page: 0 });
  });

  it('有页码时仍然去阅读器', () => {
    expect(targetPageOf(homeRowAction('read-progress', 'src-2', { page: 3 }))).toBe('reader');
  });
});

describe('最近在练的题组 → 我的题组并展开', () => {
  it('带的是 deckId', () => {
    const a = homeRowAction('deck', 'deck-9');
    expect(a).toEqual({ kind: 'focus-deck', deckId: 'deck-9' });
    expect(targetPageOf(a)).toBe('decks');
  });
});

describe('错题行 → 错题页并定位到那一题', () => {
  it('带的是 cardId，不是「去错题页顶部」', () => {
    const a = homeRowAction('wrong-card', 'card-7');
    expect(a).toEqual({ kind: 'focus-wrong', cardId: 'card-7' });
    expect(targetPageOf(a)).toBe('wrongbook');
  });

  it('每道题的目标各不相同（原来五行都跳同一页顶部）', () => {
    const targets = ['c1', 'c2', 'c3'].map((id) => homeRowAction('wrong-card', id));
    const uniq = new Set(targets.map((t) => JSON.stringify(t)));
    expect(uniq.size).toBe(3);
  });
});

describe('不变式', () => {
  it('每一种行类型都有去处（不存在「点了没反应」）', () => {
    const kinds = ['study-progress', 'read-progress', 'deck', 'wrong-card'] as const;
    for (const k of kinds) {
      const a = homeRowAction(k, 'x');
      expect(a, k).toBeTruthy();
      expect(targetPageOf(a), k).toBeTruthy();
    }
  });

  it('目标页都在 PageId 允许的范围内', () => {
    const allowed = new Set(['reader', 'flow', 'decks', 'wrongbook']);
    for (const k of ['study-progress', 'read-progress', 'deck', 'wrong-card'] as const) {
      expect(allowed.has(targetPageOf(homeRowAction(k, 'x'))), k).toBe(true);
    }
  });
});
