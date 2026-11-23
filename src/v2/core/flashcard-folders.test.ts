/**
 * 闪卡文件夹纯逻辑单测（2026-11-23 晚）。
 *
 * 这里守的是**「界面上看到的结构」和「库里的结构」一致**：
 * 归一化丢坏数据时不能把好数据一起丢、不能造出两个同名文件夹、
 * 不能留下指向不存在文件夹的归属（那种卡会在界面上永远消失）。
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_FOLDER_SETTINGS,
  MAX_FOLDER_NAME,
  folderIdsOf,
  folderNameProblem,
  makeFolder,
  normalizeFolderSettings,
  pruneAssigns,
  type FlashcardFolder,
} from './flashcard-folders.ts';

const folders: FlashcardFolder[] = [
  { id: 'fold_1', name: '高数错题' },
  { id: 'fold_2', name: '信号公式' },
];

describe('folderNameProblem：建/改名时挡掉的名字', () => {
  it('正常名字可以用', () => {
    expect(folderNameProblem('期末冲刺', folders)).toBeNull();
  });

  it('空的（含全空格）不行', () => {
    expect(folderNameProblem('', folders)).toBe('empty');
    expect(folderNameProblem('   ', folders)).toBe('empty');
    expect(folderNameProblem('\t\n', folders)).toBe('empty');
  });

  it('重名不行（trim 后比较）', () => {
    expect(folderNameProblem('高数错题', folders)).toBe('dup');
    expect(folderNameProblem('  高数错题  ', folders)).toBe('dup');
  });

  /*
   * 大小写敏感是有意的（与 normalizeTags 同口径）。
   * 做成不敏感就会出现「建得出来但看起来一样」的两个文件夹。
   */
  it('大小写不同算两个名字', () => {
    expect(folderNameProblem('Gauss', [{ id: 'x', name: 'gauss' }])).toBeNull();
  });

  it('改名时排自己（把 A 改成 A 不能判重名）', () => {
    expect(folderNameProblem('高数错题', folders, 'fold_1')).toBeNull();
    /* 但改成别的已存在的名字仍然要挡 */
    expect(folderNameProblem('信号公式', folders, 'fold_1')).toBe('dup');
  });
});

describe('makeFolder', () => {
  it('生成 id 并 trim', () => {
    const f = makeFolder('  高数  ');
    expect(f.name).toBe('高数');
    expect(f.id.length).toBeGreaterThan(0);
  });

  it('名字截断到上限（界面上放不下更长的）', () => {
    const long = 'x'.repeat(MAX_FOLDER_NAME + 30);
    expect(makeFolder(long).name).toHaveLength(MAX_FOLDER_NAME);
  });

  it('id 可注入（测试与迁移用）', () => {
    expect(makeFolder('a', 'fold_fixed').id).toBe('fold_fixed');
  });
});

describe('normalizeFolderSettings：坏数据不能弄丢好数据', () => {
  it('不是对象 → 空设置', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2], true]) {
      expect(normalizeFolderSettings(bad)).toEqual(EMPTY_FOLDER_SETTINGS);
    }
  });

  it('空对象 → 空设置', () => {
    expect(normalizeFolderSettings({})).toEqual(EMPTY_FOLDER_SETTINGS);
  });

  it('正常数据原样保留（顺序不变）', () => {
    const raw = { folders, assigns: { fc1: 'fold_1', fc2: 'fold_2' } };
    const out = normalizeFolderSettings(raw);
    expect(out.folders.map((f) => f.name)).toEqual(['高数错题', '信号公式']);
    expect(out.assigns).toEqual({ fc1: 'fold_1', fc2: 'fold_2' });
  });

  it('名字空的项丢掉，其它照留', () => {
    const out = normalizeFolderSettings({
      folders: [{ id: 'a', name: '好' }, { id: 'b', name: '   ' }, { id: 'c' }],
    });
    expect(out.folders.map((f) => f.name)).toEqual(['好']);
  });

  it('重名只留第一个（两个同名组会各自显示一半卡，用户没法区分）', () => {
    const out = normalizeFolderSettings({
      folders: [
        { id: 'a', name: '高数' },
        { id: 'b', name: '高数' },
      ],
    });
    expect(out.folders).toHaveLength(1);
    expect(out.folders[0].id).toBe('a');
  });

  it('id 重复要换掉（否则「归入 A」可能写进 B）', () => {
    const out = normalizeFolderSettings({
      folders: [
        { id: 'dup', name: '甲' },
        { id: 'dup', name: '乙' },
      ],
    });
    expect(out.folders).toHaveLength(2);
    expect(new Set(out.folders.map((f) => f.id)).size).toBe(2);
    expect(out.folders[0].id).toBe('dup');
    expect(out.folders[1].id).not.toBe('dup');
  });

  it('缺 id 的补一个', () => {
    const out = normalizeFolderSettings({ folders: [{ name: '甲' }] });
    expect(out.folders).toHaveLength(1);
    expect(out.folders[0].id.length).toBeGreaterThan(0);
  });

  it('归属指向不存在的文件夹 → 丢（卡回到未归入，不能悬空）', () => {
    const out = normalizeFolderSettings({
      folders,
      assigns: { fc1: 'fold_1', fc2: 'fold_deleted', fc3: '' },
    });
    expect(out.assigns).toEqual({ fc1: 'fold_1' });
  });

  it('assigns 不是对象 / 是数组 → 空映射', () => {
    expect(normalizeFolderSettings({ folders, assigns: 'x' }).assigns).toEqual({});
    expect(normalizeFolderSettings({ folders, assigns: [1] }).assigns).toEqual({});
    expect(normalizeFolderSettings({ folders, assigns: null }).assigns).toEqual({});
  });

  it('★ 关系断言：归一化后每个归属都指向现存文件夹', () => {
    const out = normalizeFolderSettings({
      folders: [
        { id: 'f1', name: '甲' },
        { id: 'f1', name: '乙' },
      ],
      assigns: { a: 'f1', b: 'ghost', c: 'f1' },
    });
    const ids = folderIdsOf(out);
    for (const fid of Object.values(out.assigns)) {
      expect(ids.has(fid)).toBe(true);
    }
    /* 并且归属数不会因为 id 撞车而被放大 */
    expect(Object.keys(out.assigns).length).toBeLessThanOrEqual(3);
  });

  it('幂等：归一化两次结果一样（页面反复 load 不该越改越乱）', () => {
    const once = normalizeFolderSettings({ folders, assigns: { fc1: 'fold_1' } });
    const twice = normalizeFolderSettings(once);
    expect(twice).toEqual(once);
  });
});

describe('pruneAssigns：删卡后剪掉死归属', () => {
  const settings = { folders, assigns: { fc1: 'fold_1', fc2: 'fold_2', dead: 'fold_1' } };

  it('剪掉不存在的卡，回报 changed', () => {
    const { next, changed } = pruneAssigns(settings, new Set(['fc1', 'fc2']));
    expect(changed).toBe(true);
    expect(next.assigns).toEqual({ fc1: 'fold_1', fc2: 'fold_2' });
  });

  it('没有死 id 时不改、changed=false（别白写一次盘）', () => {
    const { next, changed } = pruneAssigns(settings, new Set(['fc1', 'fc2', 'dead']));
    expect(changed).toBe(false);
    expect(next).toBe(settings);
  });

  it('卡全删光 → assigns 清空，文件夹还在（文件夹不跟着消失）', () => {
    const { next } = pruneAssigns(settings, new Set());
    expect(next.assigns).toEqual({});
    expect(next.folders).toHaveLength(2);
  });

  it('folderIdsOf 给出现存文件夹集合', () => {
    expect([...folderIdsOf(settings)].sort()).toEqual(['fold_1', 'fold_2']);
  });
});
