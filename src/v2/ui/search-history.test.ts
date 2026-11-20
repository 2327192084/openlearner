import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHistory,
  HISTORY_LIMIT,
  loadHistory,
  pushHistory,
  removeHistory,
  saveHistory,
} from './search-history.ts';

/**
 * 测试环境是 node（`environment: 'node'`），没有 localStorage。
 *
 * 不为此引入 jsdom：搜索历史只需要 get / set / remove 三个方法，
 * 补一个 20 行的内存实现比换测试环境（会拖慢全量测试、且可能引出
 * 别的 DOM 依赖差异）更划算。
 *
 * 放在 import 之后、用例之前执行，`beforeEach` 里清空。
 */
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => {
        mem.set(k, String(v));
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
      clear: () => {
        mem.clear();
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

/**
 * 搜索历史（2026-11-21）。
 *
 * 纯函数部分（pushHistory / removeHistory）是重点 ——
 * 去重与顺序错了会让「一排胶囊」变成重复的垃圾堆。
 */

describe('pushHistory · 去重与顺序', () => {
  it('新词加到最前', () => {
    expect(pushHistory(['英语'], '高数')).toEqual(['高数', '英语']);
  });

  it('**同一个词再搜一次 → 提到最前，不产生第二条**', () => {
    const after = pushHistory(['高数', '英语', '线代'], '英语');
    expect(after).toEqual(['英语', '高数', '线代']);
    /* 关键：不出现两条「英语」 */
    expect(after.filter((x) => x === '英语')).toHaveLength(1);
  });

  it('**大小写归一后算同一个词**（英文搜索不乱堆）', () => {
    const after = pushHistory(['Algorithm'], 'algorithm');
    expect(after).toEqual(['algorithm']);
  });

  it('**首尾空白归一后算同一个词**', () => {
    const after = pushHistory(['高数'], '  高数  ');
    expect(after).toEqual(['高数']);
  });

  it('保留用户这次输入的原样写法（不强行用小写覆盖显示）', () => {
    const after = pushHistory(['algorithm'], 'Algorithm');
    expect(after[0]).toBe('Algorithm');
  });

  it('空词不记录（避免历史里塞空胶囊）', () => {
    for (const t of ['', '   ', '\n\t']) {
      expect(pushHistory(['高数'], t)).toEqual(['高数']);
    }
  });

  it('**超过上限时砍掉最老的**', () => {
    let h: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = pushHistory(h, '词' + i);
    expect(h).toHaveLength(HISTORY_LIMIT);
    /* 最新的在最前 */
    expect(h[0]).toBe('词' + (HISTORY_LIMIT + 4));
    /* 最老的已经被挤掉 */
    expect(h).not.toContain('词0');
  });

  it('超长词被截断（否则胶囊会把一行撑破）', () => {
    const long = 'x'.repeat(100);
    const after = pushHistory([], long);
    expect(after[0]!.length).toBeLessThanOrEqual(40);
  });

  it('不修改传入的数组（纯函数）', () => {
    const original = ['英语'];
    pushHistory(original, '高数');
    expect(original).toEqual(['英语']);
  });
});

describe('removeHistory', () => {
  it('按归一后的词删掉那一条', () => {
    expect(removeHistory(['高数', '英语'], '  高数 ')).toEqual(['英语']);
  });

  it('删不存在的词 → 原样返回', () => {
    expect(removeHistory(['高数'], '物理')).toEqual(['高数']);
  });

  it('大小写不同也能删（用户看到的就是那一条）', () => {
    expect(removeHistory(['Algorithm'], 'algorithm')).toEqual([]);
  });
});

describe('localStorage 读写', () => {
  beforeEach(() => {
    clearHistory();
  });

  it('存了能读回来', () => {
    saveHistory(['高数', '英语']);
    expect(loadHistory()).toEqual(['高数', '英语']);
  });

  it('没存过 → 空数组（不是 null，调用方不用判空）', () => {
    expect(loadHistory()).toEqual([]);
  });

  /** 坏数据不能让搜索页打不开 —— 这是「便利功能」的底线 */
  it('**坏 JSON → 空数组，不抛错**', () => {
    localStorage.setItem('openleaner.search.history', '{不是 JSON');
    expect(loadHistory()).toEqual([]);
  });

  it('存的不是数组 → 空数组', () => {
    localStorage.setItem('openleaner.search.history', '{"a":1}');
    expect(loadHistory()).toEqual([]);
  });

  it('数组里混进非字符串 → 过滤掉，不崩', () => {
    localStorage.setItem('openleaner.search.history', JSON.stringify(['高数', 42, null, '英语']));
    expect(loadHistory()).toEqual(['高数', '英语']);
  });

  it('存的时候受上限约束', () => {
    saveHistory(Array.from({ length: 30 }, (_, i) => '词' + i));
    expect(loadHistory()).toHaveLength(HISTORY_LIMIT);
  });

  it('清空后读到空数组', () => {
    saveHistory(['高数']);
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});