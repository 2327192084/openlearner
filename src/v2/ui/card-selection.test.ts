/**
 * 导出多选模型的单测（2026-11-23 晚）。
 *
 * 用户要求「加个多选或是全选的按钮」，追问后选了"组头整组勾 + 单卡单独勾都要"。
 * 这里测的全是**关系**：勾上的和真正导出的必须一致，
 * 组头三态必须和实际勾选数一致。
 */

import { describe, expect, it } from 'vitest';
import {
  effectiveIds,
  groupPickState,
  pruneSelection,
  toggleCard,
  toggleGroup,
} from './card-selection.ts';

describe('toggleCard：单卡勾/取消', () => {
  it('勾上再点取消', () => {
    let s: ReadonlySet<string> = new Set<string>();
    s = toggleCard(s, 'a');
    expect([...s]).toEqual(['a']);
    s = toggleCard(s, 'a');
    expect([...s]).toEqual([]);
  });

  it('不改原集合（React 要新引用才重渲染）', () => {
    const before = new Set(['a']);
    const after = toggleCard(before, 'b');
    expect([...before]).toEqual(['a']);
    expect(after).not.toBe(before);
  });
});

describe('toggleGroup：组头整组勾', () => {
  it('一个都没勾 → 整组选上', () => {
    const s = toggleGroup(new Set<string>(), ['a', 'b', 'c']);
    expect([...s].sort()).toEqual(['a', 'b', 'c']);
  });

  it('整组都勾了 → 整组取消', () => {
    const s = toggleGroup(new Set(['a', 'b', 'c', 'z']), ['a', 'b', 'c']);
    expect([...s]).toEqual(['z']);
  });

  /*
   * 部分选中时点组头 = 补齐本组，不是清空。
   * QuestionPicker.toggleDeckAll 同款手感；反过来会让用户"点一下全没了"。
   */
  it('部分选中 → 补齐本组（不清空）', () => {
    const s = toggleGroup(new Set(['a']), ['a', 'b', 'c']);
    expect([...s].sort()).toEqual(['a', 'b', 'c']);
  });

  it('空组不改选择（空数组 every() 是 true 的陷阱）', () => {
    const before = new Set(['x']);
    const s = toggleGroup(before, []);
    expect([...s]).toEqual(['x']);
  });

  it('不动别的组的勾', () => {
    const s = toggleGroup(new Set(['z']), ['a', 'b']);
    expect([...s].sort()).toEqual(['a', 'b', 'z']);
  });
});

describe('groupPickState：组头三态', () => {
  it('none / some / all 三态都要准', () => {
    const sel = new Set(['a', 'b', 'c']);
    expect(groupPickState(new Set(), ['a', 'b'])).toBe('none');
    expect(groupPickState(sel, ['a', 'b'])).toBe('all');
    expect(groupPickState(sel, ['a', 'x'])).toBe('some');
  });

  it('空组是 none，不是 all（反向验证：照抄 every() 会得 all）', () => {
    expect(groupPickState(new Set(['a']), [])).toBe('none');
  });

  it('全选状态下每个非空组都是 all（关系断言）', () => {
    const groups = [
      ['a', 'b'],
      ['c'],
      ['d', 'e', 'f'],
    ];
    let sel: ReadonlySet<string> = new Set<string>();
    for (const g of groups) sel = toggleGroup(sel, g);
    for (const g of groups) expect(groupPickState(sel, g)).toBe('all');
    expect([...sel].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('effectiveIds：勾上的必须真的会被导出', () => {
  it('只回当前可见的，保持可见顺序', () => {
    const sel = new Set(['c', 'a', 'ghost']);
    expect(effectiveIds(sel, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  /*
   * 场景：勾了 5 张，然后搜了个词只剩 2 张可见。
   * 导出必须只有那 2 张 —— 否则界面上看不到的卡被偷偷导出。
   */
  it('筛选收窄后只导出看得见的（不许偷带不可见的）', () => {
    const sel = new Set(['a', 'b', 'c', 'd', 'e']);
    const visibleAfterSearch = ['b', 'd'];
    const ids = effectiveIds(sel, visibleAfterSearch);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(visibleAfterSearch);
  });

  it('全选（选择 = 全部可见）时数量对得上', () => {
    const visible = ['a', 'b', 'c'];
    const sel = new Set(visible);
    expect(effectiveIds(sel, visible)).toHaveLength(3);
  });

  it('没勾任何东西时是空数组，不是全部', () => {
    expect(effectiveIds(new Set(), ['a', 'b'])).toEqual([]);
  });
});

describe('pruneSelection：删卡后修剪选择', () => {
  it('去掉已经不存在的 id', () => {
    const s = pruneSelection(new Set(['a', 'b', 'gone']), ['a', 'b', 'c']);
    expect([...s].sort()).toEqual(['a', 'b']);
  });

  it('全都没了时得空集', () => {
    expect([...pruneSelection(new Set(['x']), [])]).toEqual([]);
  });

  it('修剪后已选数必须等于 effectiveIds 的长度（关系断言）', () => {
    const alive = ['a', 'b'];
    const sel = pruneSelection(new Set(['a', 'b', 'dead1', 'dead2']), alive);
    expect(sel.size).toBe(effectiveIds(sel, alive).length);
  });
});
