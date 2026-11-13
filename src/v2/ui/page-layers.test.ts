/**
 * 页面覆盖层（page-layers.ts）的单测。
 *
 * ## 这一轮的重点
 *
 * 用户报了：「没有正在进行文档解析的任务时，这个提示也一直存在」。
 * 根因是第一版把「页面被保活」当成了「有任务在进行」。
 * 所以下面**第一组用例就是用户报的那个场景**，
 * 把它钉死，免得以后又退回「打开过就有提示」。
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_TASKS,
  MAX_RETAINED,
  dropPage,
  isLayerActive,
  layersToRender,
  reportTask,
  resumeTarget,
  type LayerTask,
} from './page-layers.ts';

const parse = (detail?: string): LayerTask => ({ page: 'parse', label: '文档解析', ...(detail ? { detail } : {}) });
const organize = (): LayerTask => ({ page: 'organize', label: '整理知识点' });
const exam = (): LayerTask => ({ page: 'exam', label: '模拟考试' });

describe('用户报的场景：没有进行中的任务时不许有提示', () => {
  it('打开过文档解析页、但什么都没跑 → 没有「继续」提示', () => {
    /*
     * 这是那个 bug 的最小复现：页面被访问过（在旧实现里会进白名单），
     * 但页面**没有上报任何任务**。所以集合是空的。
     */
    const tasks = EMPTY_TASKS;
    expect(resumeTarget(tasks, 'today')).toBeNull();
    /* 打开过的那一页也不会被保活 —— 它没有任务 */
    expect(layersToRender(tasks, 'today')).toEqual(['today']);
  });

  it('文档解析跑完（上报改回 null）→ 提示立刻消失，这一层也不再保活', () => {
    let tasks = reportTask(EMPTY_TASKS, parse('3/12 页'));
    expect(resumeTarget(tasks, 'today')).not.toBeNull();

    /* 解析结束 */
    tasks = reportTask(tasks, null, 'parse');
    expect(tasks).toEqual([]);
    expect(resumeTarget(tasks, 'today')).toBeNull();
    expect(layersToRender(tasks, 'today')).toEqual(['today']);
  });

  it('人就在正在跑的那一页上 → 不提示「继续」（不需要被提醒）', () => {
    const tasks = reportTask(EMPTY_TASKS, parse('3/12 页'));
    expect(resumeTarget(tasks, 'parse')).toBeNull();
  });

  it('进度细节会带上（用户要的是「知道进度」）', () => {
    const tasks = reportTask(EMPTY_TASKS, parse('3/12 页'));
    expect(resumeTarget(tasks, 'today')?.detail).toBe('3/12 页');
    expect(resumeTarget(tasks, 'today')?.label).toBe('文档解析');
  });

  it('没有 detail 时不编造', () => {
    const tasks = reportTask(EMPTY_TASKS, parse());
    expect(resumeTarget(tasks, 'today')?.detail).toBeUndefined();
  });
});

describe('reportTask：上报与更新', () => {
  it('同一页重复上报是更新，不重复添加', () => {
    let tasks = reportTask(EMPTY_TASKS, parse('1/12 页'));
    tasks = reportTask(tasks, parse('5/12 页'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.detail).toBe('5/12 页');
  });

  it('上报会把该页挪到最新（= 最近在干这件事）', () => {
    let tasks = reportTask(EMPTY_TASKS, exam());
    tasks = reportTask(tasks, organize());
    expect(tasks.map((t) => t.page)).toEqual(['exam', 'organize']);

    /* 回到考试（重新上报）→ 它变成最近的那个 */
    tasks = reportTask(tasks, exam());
    expect(tasks.map((t) => t.page)).toEqual(['organize', 'exam']);
  });

  it('清空一页不动别的页', () => {
    let tasks = reportTask(EMPTY_TASKS, exam());
    tasks = reportTask(tasks, organize());
    tasks = reportTask(tasks, null, 'exam');
    expect(tasks.map((t) => t.page)).toEqual(['organize']);
  });

  it('清空不存在的页返回同一个数组（避免无谓重渲染）', () => {
    const tasks = reportTask(EMPTY_TASKS, exam());
    expect(reportTask(tasks, null, 'parse')).toBe(tasks);
  });

  it('不带 page 的清空调用是空操作（防止误清全部）', () => {
    const tasks = reportTask(EMPTY_TASKS, exam());
    expect(reportTask(tasks, null)).toBe(tasks);
  });
});

describe('layersToRender：当前页永远要渲染', () => {
  it('当前页有任务时不重复', () => {
    const tasks = reportTask(EMPTY_TASKS, exam());
    expect(layersToRender(tasks, 'exam')).toEqual(['exam']);
  });

  it('当前页没有任务时仍然渲染它并排在最后（首页/资料/设置就是这样）', () => {
    const tasks = reportTask(EMPTY_TASKS, exam());
    expect(layersToRender(tasks, 'today')).toEqual(['exam', 'today']);
  });

  it('上一层被压住时，它排在可见层前面', () => {
    let tasks = reportTask(EMPTY_TASKS, exam());
    tasks = reportTask(tasks, organize());
    const layers = layersToRender(tasks, 'organize');
    expect(layers[layers.length - 1]).toBe('organize');
    expect(layers).toContain('exam');
  });

  it('什么都没有时只剩当前页', () => {
    expect(layersToRender(EMPTY_TASKS, 'sources')).toEqual(['sources']);
  });
});

describe('isLayerActive', () => {
  it('只有当前页是活动层', () => {
    expect(isLayerActive('book', 'book')).toBe(true);
    expect(isLayerActive('book', 'exam')).toBe(false);
  });
});

describe('上限', () => {
  it('超上限从最久没访问的开始丢', () => {
    let tasks = EMPTY_TASKS;
    for (const t of [exam(), organize(), parse()]) tasks = reportTask(tasks, t);
    expect(tasks).toHaveLength(MAX_RETAINED);

    tasks = reportTask(tasks, { page: 'book', label: '复习巩固' });
    expect(tasks.map((t) => t.page)).toEqual(['organize', 'parse', 'book']);
  });

  it('永远不超过上限', () => {
    let tasks = EMPTY_TASKS;
    const items: LayerTask[] = [
      exam(),
      organize(),
      parse(),
      { page: 'book', label: '复习巩固' },
      { page: 'practice', label: '做题中' },
    ];
    for (const t of items) {
      tasks = reportTask(tasks, t);
      expect(tasks.length).toBeLessThanOrEqual(MAX_RETAINED);
    }
  });
});

describe('dropPage', () => {
  it('丢掉明确的一页', () => {
    let tasks = reportTask(EMPTY_TASKS, exam());
    tasks = reportTask(tasks, organize());
    expect(dropPage(tasks, 'exam').map((t) => t.page)).toEqual(['organize']);
  });

  it('丢不存在的页返回同一个数组', () => {
    const tasks = reportTask(EMPTY_TASKS, exam());
    expect(dropPage(tasks, 'parse')).toBe(tasks);
  });
});

describe('不变式', () => {
  it('同一页最多一条任务', () => {
    let tasks = EMPTY_TASKS;
    for (const t of [parse('1/9'), exam(), parse('2/9'), organize(), parse('3/9')]) {
      tasks = reportTask(tasks, t);
      expect(new Set(tasks.map((x) => x.page)).size).toBe(tasks.length);
    }
  });

  it('渲染列表永远没有重复项，且最后一项是当前页', () => {
    let tasks = EMPTY_TASKS;
    for (const t of [exam(), organize(), parse()]) tasks = reportTask(tasks, t);
    for (const cur of ['today', 'exam', 'organize', 'parse', 'sources', 'reader'] as const) {
      const layers = layersToRender(tasks, cur);
      expect(new Set(layers).size).toBe(layers.length);
      expect(layers[layers.length - 1]).toBe(cur);
    }
  });
});
