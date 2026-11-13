/**
 * 页面覆盖层（page-layers.ts）的单测。
 *
 * 这些用例钉的是**语义**，不是实现。三条最要紧的：
 * 「跳走再回来还在」「去别处看一眼不会挤掉」「不像样的当前页也要渲染」。
 * 任何一条错了用户的进度就丢一次，或者直接黑屏。
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_LAYERS,
  MAX_RETAINED,
  dropLayer,
  isKeepAlive,
  isLayerActive,
  layersToRender,
  resumeTarget,
  retainLayer,
} from './page-layers.ts';

describe('白名单', () => {
  it('有进行中状态的页面在白名单里', () => {
    for (const id of ['practice', 'review', 'exam', 'book', 'organize', 'parse'] as const) {
      expect(isKeepAlive(id), `${id} 应该保活`).toBe(true);
    }
  });

  it('没有进行中状态的页面不在白名单里', () => {
    for (const id of ['today', 'sources', 'stats', 'settings', 'trash'] as const) {
      expect(isKeepAlive(id), `${id} 不该保活 —— 它没有进行中的状态，保活只会看到过期数据`).toBe(
        false,
      );
    }
  });

  it('阅读器不在白名单里（它靠 readProgress 落库恢复，不靠内存保活）', () => {
    expect(isKeepAlive('reader')).toBe(false);
  });
});

describe('retainLayer：跳走再回来还在', () => {
  it('做题 → 阅读器 → 回来，做题还在', () => {
    const a = retainLayer(EMPTY_LAYERS, 'practice');
    expect(a.retained).toEqual(['practice']);

    /* 去看原文。reader 不保活，也不该把 practice 挤掉 */
    const b = retainLayer(a, 'reader');
    expect(b.retained).toEqual(['practice']);

    /* 回来 */
    const c = retainLayer(b, 'practice');
    expect(c.retained).toEqual(['practice']);
  });

  it('去不保活的页面看一眼，不会挤掉正在进行的页面', () => {
    const a = retainLayer(EMPTY_LAYERS, 'exam');
    const b = retainLayer(a, 'today');
    const c = retainLayer(b, 'settings');
    const d = retainLayer(c, 'stats');
    expect(d.retained).toEqual(['exam']);
  });

  it('两层都保活时下面的那层留下', () => {
    const a = retainLayer(EMPTY_LAYERS, 'exam');
    const b = retainLayer(a, 'organize');
    expect(b.retained).toEqual(['exam', 'organize']);
  });

  it('重复进同一页不产生重复项，且挪到末尾', () => {
    const a = retainLayer(EMPTY_LAYERS, 'exam');
    const b = retainLayer(a, 'book');
    const c = retainLayer(b, 'exam');
    expect(c.retained).toEqual(['book', 'exam']);
  });

  it('超上限从最久没访问的开始丢', () => {
    let s = EMPTY_LAYERS;
    for (const id of ['practice', 'exam', 'book'] as const) s = retainLayer(s, id);
    expect(s.retained.length).toBe(MAX_RETAINED);

    s = retainLayer(s, 'organize');
    expect(s.retained).toEqual(['exam', 'book', 'organize']);
  });

  it('丢的顺序按「最久没访问」，被重新访问的层回到最新', () => {
    let s = EMPTY_LAYERS;
    for (const id of ['practice', 'exam', 'book'] as const) s = retainLayer(s, id);
    /* 回去用 practice —— 它变成最新的 */
    s = retainLayer(s, 'practice');
    expect(s.retained).toEqual(['exam', 'book', 'practice']);

    /* 再加一层：现在最旧的是 exam */
    s = retainLayer(s, 'organize');
    expect(s.retained).toEqual(['book', 'practice', 'organize']);
  });
});

describe('layersToRender：当前页永远要渲染', () => {
  it('当前页在 retained 末尾时不重复', () => {
    const s = retainLayer(retainLayer(EMPTY_LAYERS, 'exam'), 'book');
    expect(layersToRender(s, 'book')).toEqual(['exam', 'book']);
  });

  it('当前页不在白名单时，仍然渲染它并排在最后', () => {
    const s = retainLayer(EMPTY_LAYERS, 'practice');
    /*
     * 这是第一版设计错掉的那个用例：「做题 → 看原文」时
     * current=reader 不在 retained 里。若不把它加进来，界面是空的。
     */
    expect(layersToRender(s, 'reader')).toEqual(['practice', 'reader']);
  });

  it('当前页是保活页但不在 retained 里（刚清空过）也照样渲染', () => {
    expect(layersToRender(EMPTY_LAYERS, 'exam')).toEqual(['exam']);
  });

  it('返回进行中的任务时，被压住的那层重新变成最后一项', () => {
    const s = retainLayer(EMPTY_LAYERS, 'practice');
    /* 在 reader 里 */
    expect(layersToRender(s, 'reader')).toEqual(['practice', 'reader']);
    /* 返回 practice */
    expect(layersToRender(s, 'practice')).toEqual(['practice']);
  });

  it('隐藏层排在可见层前面（DOM 顺序不影响视觉，但影响读屏顺序）', () => {
    const s = retainLayer(retainLayer(EMPTY_LAYERS, 'exam'), 'organize');
    const layers = layersToRender(s, 'organize');
    expect(layers[layers.length - 1]).toBe('organize');
  });
});

describe('isLayerActive', () => {
  it('只有当前页是活动层', () => {
    expect(isLayerActive('book', 'book')).toBe(true);
    expect(isLayerActive('book', 'exam')).toBe(false);
  });
});

describe('resumeTarget：该回到哪个进行中的任务', () => {
  it('取最近访问的那个保活页', () => {
    let s = EMPTY_LAYERS;
    for (const id of ['practice', 'exam'] as const) s = retainLayer(s, id);
    expect(resumeTarget(s, 'today')).toBe('exam');
  });

  it('跳过当前页自己', () => {
    const s = retainLayer(EMPTY_LAYERS, 'exam');
    expect(resumeTarget(s, 'exam')).toBeNull();
  });

  it('没有进行中的任务时返回 null（界面据此不画按钮）', () => {
    expect(resumeTarget(EMPTY_LAYERS, 'today')).toBeNull();
  });

  /*
   * 下面这条是截图复核之后补的（2026-11-13 下午）。
   * 当时人已经在做题页，侧栏还写着「继续：做题」——
   * 断言全过，只有肉眼看图才发现。所以把它钉成用例：
   * **人在任务页时不许再提示「继续这个任务」**。
   */
  it('人在白名单页时不应该再提示「继续」（App 侧用 isKeepAlive 判，此处钉住前提）', () => {
    const s = retainLayer(retainLayer(EMPTY_LAYERS, 'exam'), 'practice');
    /* 站在 practice 上：resumeTarget 会返回 exam —— 但 App 会先看 isKeepAlive(page) */
    expect(isKeepAlive('practice')).toBe(true);
    expect(resumeTarget(s, 'practice')).toBe('exam');
    /* 所以在非白名单页时才需要入口 */
    expect(isKeepAlive('today')).toBe(false);
    expect(resumeTarget(s, 'today')).toBe('practice');
  });
});

describe('dropLayer', () => {
  it('丢掉明确的一层', () => {
    const s = retainLayer(retainLayer(EMPTY_LAYERS, 'exam'), 'book');
    expect(dropLayer(s, 'exam').retained).toEqual(['book']);
  });

  it('丢不存在的层返回同一个对象（避免无谓重渲染）', () => {
    const s = retainLayer(EMPTY_LAYERS, 'exam');
    expect(dropLayer(s, 'book')).toBe(s);
  });
});

describe('不变式', () => {
  it('retained 长度永远不超过上限', () => {
    const pages = ['practice', 'exam', 'book', 'organize', 'parse', 'review'] as const;
    let s = EMPTY_LAYERS;
    for (const p of pages) {
      s = retainLayer(s, p);
      expect(s.retained.length).toBeLessThanOrEqual(MAX_RETAINED);
    }
  });

  it('retained 没有重复项', () => {
    const pages = ['practice', 'exam', 'practice', 'book', 'exam', 'practice'] as const;
    let s = EMPTY_LAYERS;
    for (const p of pages) {
      s = retainLayer(s, p);
      expect(new Set(s.retained).size).toBe(s.retained.length);
    }
  });

  it('渲染列表永远没有重复项', () => {
    const pages = ['practice', 'today', 'exam', 'reader', 'book', 'settings'] as const;
    let s = EMPTY_LAYERS;
    for (const p of pages) {
      s = retainLayer(s, p);
      const layers = layersToRender(s, p);
      expect(new Set(layers).size).toBe(layers.length);
      expect(layers[layers.length - 1]).toBe(p);
    }
  });
});
