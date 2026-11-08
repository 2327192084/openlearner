import { describe, expect, it } from 'vitest';
import {
  clampWidgets,
  DAILY_QUOTES,
  DEFAULT_WIDGETS,
  MAX_WIDGETS,
  normalizeWidgets,
  pickDailyQuote,
  todayLocalYmd,
  widgetsFromSettings,
  type HomeWidget,
} from './home-widgets.ts';

/**
 * 首页小组件的测试（2026-11-08）。
 *
 * 重点守三条：
 *  1. 同一天永远是同一句（刷新不会变）—— 变了用户会以为文案在乱跳
 *  2. 相邻两天不重复 —— 否则「每日一句」名不副实
 *  3. 坏配置不该让首页白屏 —— 一件坏数据只丢那一个组件
 */

describe('pickDailyQuote', () => {
  it('同一天总是同一句', () => {
    const a = pickDailyQuote('2026-11-08');
    const b = pickDailyQuote('2026-11-08');
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });

  it('连续 30 天不出现重复', () => {
    /*
     * 这条是「每日一句」的底线：如果相邻两天撞同一句，
     * 用户会觉得这功能没在动。
     *
     * 语料库 30 条，取 30 天必然把整个库走一遍 —— 用 hash 打散后
     * 不会按顺序取，但仍要求 30 天内不重复（语料库长度 ≥ 30 时成立）。
     */
    const seen = new Set<string>();
    const start = new Date('2026-11-01T12:00:00');
    for (let i = 0; i < DAILY_QUOTES.length; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      seen.add(pickDailyQuote(todayLocalYmd(d)));
    }
    expect(seen.size).toBe(DAILY_QUOTES.length);
  });

  it('取到的句子一定在语料库里（不可能是 undefined 拼出来的）', () => {
    for (let i = 0; i < 400; i++) {
      const d = new Date(2026, 0, 1 + i);
      expect(DAILY_QUOTES).toContain(pickDailyQuote(todayLocalYmd(d)));
    }
  });

  it('语料库没有空串或重复', () => {
    expect(DAILY_QUOTES.every((q) => q.trim().length > 0)).toBe(true);
    expect(new Set(DAILY_QUOTES).size).toBe(DAILY_QUOTES.length);
  });
});

describe('todayLocalYmd', () => {
  it('用本地日期，不是 UTC', () => {
    /*
     * 这条防的是 dueAt 那个老问题：UTC 下东八区凌晨会算成前一天。
     * 本地 2026-11-08 00:30 在 UTC 是 11-07 16:30 —— 必须拿到 11-08。
     */
    const local = new Date(2026, 10, 8, 0, 30);
    expect(todayLocalYmd(local)).toBe('2026-11-08');
  });

  it('补零到两位', () => {
    expect(todayLocalYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('normalizeWidgets', () => {
  it('没配过 → 给默认的每日一句', () => {
    expect(normalizeWidgets(undefined)).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets(null)).toEqual(DEFAULT_WIDGETS);
    expect(normalizeWidgets('不是数组')).toEqual(DEFAULT_WIDGETS);
  });

  it('空数组也给默认（首页总得有点东西）', () => {
    expect(normalizeWidgets([])).toEqual(DEFAULT_WIDGETS);
  });

  it('正常配置原样保留', () => {
    const list: HomeWidget[] = [
      { id: 'w1', kind: 'text', title: '座右铭', body: '慢慢来，比较快' },
      { id: 'w2', kind: 'focus', title: '', body: '' },
    ];
    expect(normalizeWidgets(list)).toEqual(list);
  });

  it('坏组件只丢那一个，其余保留（不让首页白屏）', () => {
    const raw = [
      { id: 'good', kind: 'text', title: 'a', body: 'b' },
      { id: 'bad', kind: '不存在的类型', title: 'x', body: 'y' },
      null,
      '字符串',
      { kind: 'focus' },
    ];
    const out = normalizeWidgets(raw);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe('good');
    // 没 id 的补一个，而不是丢
    expect(out[1]!.kind).toBe('focus');
    expect(out[1]!.id).toBeTruthy();
  });

  it('title / body 缺失补空串，不产生 undefined', () => {
    const out = normalizeWidgets([{ id: 'a', kind: 'quote' }]);
    expect(out[0]!.title).toBe('');
    expect(out[0]!.body).toBe('');
  });

  it('超过上限只保留前 MAX_WIDGETS 个', () => {
    const many = Array.from({ length: MAX_WIDGETS + 3 }, (_, i) => ({
      id: `w${i}`, kind: 'text' as const, title: '', body: '',
    }));
    expect(normalizeWidgets(many)).toHaveLength(MAX_WIDGETS);
  });
});

describe('clampWidgets', () => {
  it('保存时截到上限', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`, kind: 'text' as const, title: '', body: '',
    }));
    expect(clampWidgets(many)).toHaveLength(MAX_WIDGETS);
  });

  it('不超限时原样返回', () => {
    const two = DEFAULT_WIDGETS.slice(0, 1);
    expect(clampWidgets(two)).toEqual(two);
  });
});

describe('widgetsFromSettings', () => {
  it('settings 为空 → 默认', () => {
    expect(widgetsFromSettings(null)).toEqual(DEFAULT_WIDGETS);
    expect(widgetsFromSettings(undefined)).toEqual(DEFAULT_WIDGETS);
  });

  it('settings 里有配置就用它', () => {
    const settings = {
      homeWidgets: [{ id: 'w1', kind: 'text', title: '单词', body: 'ubiquitous' }],
    } as never;
    const out = widgetsFromSettings(settings);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe('ubiquitous');
  });

  it('settings 里字段是坏值 → 默认，不抛', () => {
    expect(widgetsFromSettings({ homeWidgets: 42 } as never)).toEqual(DEFAULT_WIDGETS);
  });
});
