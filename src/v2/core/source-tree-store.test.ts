import { describe, expect, it } from 'vitest';
import {
  dropTree,
  hasTree,
  normalizeSourceTrees,
  putTree,
  readTreeMap,
  summarizeAll,
  summarizeTree,
  type SourceTreeMap,
} from './source-tree-store.ts';
import { emptyTasks, type SourceTree } from './source-tree.ts';

/**
 * 多张学习地图的存储（2026-11-22 下午）。
 *
 * 这组测试守两件事：
 *  1. **旧数据不能丢** —— 上一版存的是单个 `settings.sourceTree`，
 *     用户库里就那一张（信号与系统）。升级后必须还读得到。
 *  2. **坏数据不能崩** —— 半截的树点进去会白屏，整张丢掉更安全。
 */

function tree(sourceId: string, over: Partial<SourceTree> = {}): SourceTree {
  return {
    subject: '信号与系统',
    edition: '第二版',
    sourceId,
    chapters: [
      {
        number: 1,
        title: '第1章 甲',
        prerequisites: [],
        prereqReason: '',
        difficulty: 2,
        basis: 'toc',
        sections: [
          {
            id: `sec_${sourceId}_1`,
            title: '1.1 一',
            segmentIds: ['seg-1'],
            origin: 'heading',
            tasks: emptyTasks(),
          },
          {
            id: `sec_${sourceId}_2`,
            title: '1.2 二',
            segmentIds: ['seg-2'],
            origin: 'heading',
            tasks: emptyTasks(),
          },
        ],
      },
    ],
    beyond: [],
    usedSearch: false,
    droppedOutOfScope: 0,
    savedAt: '2026-11-22T10:00:00.000Z',
    ...over,
  };
}

describe('normalizeSourceTrees：旧的单张要能读', () => {
  /**
   * ⚠️ 这是本文件最重要的一条。
   *
   * 用户库里现在存的是 `settings.sourceTree`（单个对象，不是表）。
   * 如果只认新形状 `{ [sourceId]: tree }`，升级后他那张
   * 「信号与系统」地图会凭空消失 —— 他不知道发生了什么。
   */
  it('旧形状（直接有 chapters）→ 包成一张表', () => {
    const old = tree('src-1');
    const map = normalizeSourceTrees(old);
    expect(Object.keys(map)).toEqual(['src-1']);
    expect(map['src-1']!.chapters).toHaveLength(1);
    expect(map['src-1']!.chapters[0]!.sections).toHaveLength(2);
  });

  it('旧形状但 sourceId 为空 → 空表（对不上任何资料，留着也没用）', () => {
    expect(normalizeSourceTrees(tree(''))).toEqual({});
  });

  it('新形状（表）→ 逐张读出来', () => {
    const map = normalizeSourceTrees({
      'src-1': tree('src-1'),
      'src-2': tree('src-2', { subject: '高等数学' }),
    });
    expect(Object.keys(map).sort()).toEqual(['src-1', 'src-2']);
    expect(map['src-2']!.subject).toBe('高等数学');
  });

  it('⚠️ 坏数据整张丢掉（半截的树点进去会白屏）', () => {
    const map = normalizeSourceTrees({
      'src-1': tree('src-1'),
      'src-bad': { chapters: '不是数组' },
      'src-null': null,
      'src-empty': { chapters: [] },
    });
    expect(Object.keys(map)).toEqual(['src-1']);
  });

  it('非对象输入 → 空表，不抛错', () => {
    expect(normalizeSourceTrees(null)).toEqual({});
    expect(normalizeSourceTrees(undefined)).toEqual({});
    expect(normalizeSourceTrees([])).toEqual({});
    expect(normalizeSourceTrees('abc')).toEqual({});
    expect(normalizeSourceTrees(42)).toEqual({});
  });

  it('树自己没 sourceId 时用外层键补上（否则对不上资料）', () => {
    const noId = tree('');
    const map = normalizeSourceTrees({ 'src-x': noId });
    expect(map['src-x']).toBeDefined();
    expect(map['src-x']!.sourceId).toBe('src-x');
  });
});

describe('readTreeMap：新表优先，旧字段兜底', () => {
  it('有 sourceTrees → 用它', () => {
    const map = readTreeMap({
      sourceTrees: { 'src-2': tree('src-2') },
      sourceTree: tree('src-1'),
    });
    expect(Object.keys(map)).toEqual(['src-2']);
  });

  it('没有 sourceTrees 但有旧 sourceTree → 用旧的', () => {
    const map = readTreeMap({ sourceTree: tree('src-1') });
    expect(Object.keys(map)).toEqual(['src-1']);
  });

  it('两个都没有 → 空表', () => {
    expect(readTreeMap({})).toEqual({});
    expect(readTreeMap(null)).toEqual({});
  });

  it('sourceTrees 是空表时回退到旧字段（不能把用户的地图弄没）', () => {
    const map = readTreeMap({ sourceTrees: {}, sourceTree: tree('src-1') });
    expect(Object.keys(map)).toEqual(['src-1']);
  });
});

describe('putTree / dropTree / hasTree', () => {
  it('放一张新的进去', () => {
    const map = putTree({}, tree('src-1'));
    expect(hasTree(map, 'src-1')).toBe(true);
  });

  it('放进已有的键会替换（同一份资料重规划）', () => {
    const before = putTree({}, tree('src-1', { subject: '旧的' }));
    const after = putTree(before, tree('src-1', { subject: '新的' }));
    expect(after['src-1']!.subject).toBe('新的');
    expect(Object.keys(after)).toEqual(['src-1']);
  });

  it('不改原对象（纯函数）', () => {
    const before: SourceTreeMap = {};
    putTree(before, tree('src-1'));
    expect(before).toEqual({});
  });

  it('两张并存', () => {
    const map = putTree(putTree({}, tree('src-1')), tree('src-2'));
    expect(Object.keys(map).sort()).toEqual(['src-1', 'src-2']);
  });

  it('sourceId 为空的地图放不进去（对不上资料）', () => {
    expect(putTree({}, tree(''))).toEqual({});
  });

  it('删一张不影响另一张', () => {
    const map = putTree(putTree({}, tree('src-1')), tree('src-2'));
    const after = dropTree(map, 'src-1');
    expect(Object.keys(after)).toEqual(['src-2']);
    /* 原对象不变 */
    expect(Object.keys(map).sort()).toEqual(['src-1', 'src-2']);
  });

  it('删不存在的键不崩', () => {
    expect(dropTree({}, 'nope')).toEqual({});
  });
});

describe('summarizeTree：一级页要的概况', () => {
  it('数出章数、小节数、已完成小节数', () => {
    const t = tree('src-1');
    const s = summarizeTree(t);
    expect(s.chapters).toBe(1);
    expect(s.sections).toBe(2);
    expect(s.sectionsDone).toBe(0);
  });

  it('三项 + 自定义全勾才算完成（与 isSectionDone 同一判据）', () => {
    const t = tree('src-1');
    const sec = t.chapters[0]!.sections[0]!;
    sec.tasks = {
      resources: [],
      resourceDone: true,
      flashcardsDone: true,
      exerciseDone: true,
      custom: [{ id: 'c1', text: '自定义', done: false }],
    boundFlashcardIds: [],
    boundDeckIds: [],
  };
    /* 自定义没勾完 → 不算完成 */
    expect(summarizeTree(t).sectionsDone).toBe(0);

    sec.tasks.custom[0]!.done = true;
    expect(summarizeTree(t).sectionsDone).toBe(1);
  });

  it('没有小节的地图不崩（sections=0）', () => {
    const t = tree('src-1', { chapters: [] });
    const s = summarizeTree(t);
    expect(s.chapters).toBe(0);
    expect(s.sections).toBe(0);
  });
});

describe('summarizeAll：按保存时间倒序', () => {
  it('最近做的排前面', () => {
    const map = normalizeSourceTrees({
      a: tree('a', { savedAt: '2026-11-22T08:00:00.000Z' }),
      b: tree('b', { savedAt: '2026-11-22T12:00:00.000Z' }),
      c: tree('c', { savedAt: '2026-11-21T12:00:00.000Z' }),
    });
    const list = summarizeAll(map);
    expect(list.map((x) => x.sourceId)).toEqual(['b', 'a', 'c']);
  });

  it('空表 → 空数组', () => {
    expect(summarizeAll({})).toEqual([]);
  });
});