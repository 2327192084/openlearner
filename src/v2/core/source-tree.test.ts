import { describe, expect, it } from 'vitest';
import type { SourceRoute } from '@/core/ai/source-route.ts';
import type { SplitChapter } from './section-split.ts';
import {
  chapterProgress,
  chaptersFromSplit,
  emptyTasks,
  fromLegacyRoute,
  isSectionDone,
  normalizeSourceTree,
  treeProgress,
  type ChapterNode,
  type SectionNode,
  type SourceTree,
} from './source-tree.ts';

/**
 * 学习路线的树结构（2026-11-22）。
 *
 * 这组测试守三件事：
 *  1. **完成判定严格照用户要求**：三项 + 自定义全勾；不看掌握度、不看题目对错
 *  2. **坏数据不崩界面**（逐字段校验，不是强转）
 *  3. **旧 v2 路线能转**（用户库里有一条已确认的，不能丢）
 */

/** 造一个最小章节 */
function chapter(over: Partial<ChapterNode> = {}): ChapterNode {
  return {
    number: 1,
    title: '第1章 函数与极限',
    prerequisites: [],
    prereqReason: '',
    difficulty: 2,
    basis: 'toc',
    sections: [section()],
    ...over,
  };
}

function section(over: Partial<SectionNode> = {}): SectionNode {
  return {
    id: 'sec_1',
    title: '1.1 映射概念',
    segmentIds: ['seg-1'],
    origin: 'heading',
    tasks: emptyTasks(),
    ...over,
  };
}

function tree(over: Partial<SourceTree> = {}): SourceTree {
  return {
    subject: '高等数学',
    edition: '第7版',
    sourceId: 'src-1',
    chapters: [chapter()],
    beyond: [],
    usedSearch: false,
    droppedOutOfScope: 0,
    savedAt: '2026-11-22T00:00:00.000Z',
    ...over,
  };
}

describe('isSectionDone：完成判定严格照用户要求', () => {
  it('三项都勾才算完成', () => {
    const s = section({
      tasks: {
        resources: [{ id: 'r1', title: '网课', url: 'https://x.com', source: 'search' }],
        resourceDone: true,
        flashcardsDone: true,
        exerciseDone: true,
        custom: [],
      },
    });
    expect(isSectionDone(s)).toBe(true);
  });

  it('⚠️ 少一项就不算完成（四个组合都验）', () => {
    const base = {
      resources: [],
      resourceDone: true,
      flashcardsDone: true,
      exerciseDone: true,
      custom: [],
    };
    expect(isSectionDone(section({ tasks: { ...base, resourceDone: false } }))).toBe(false);
    expect(isSectionDone(section({ tasks: { ...base, flashcardsDone: false } }))).toBe(false);
    expect(isSectionDone(section({ tasks: { ...base, exerciseDone: false } }))).toBe(false);
  });

  it('⚠️ 自定义任务没勾完也不算完成（用户自己定义的任务也是任务）', () => {
    const s = section({
      tasks: {
        resources: [],
        resourceDone: true,
        flashcardsDone: true,
        exerciseDone: true,
        custom: [
          { id: 'c1', text: '读完课本这一节', done: true },
          { id: 'c2', text: '做笔记', done: false },
        ],
      },
    });
    expect(isSectionDone(s)).toBe(false);
  });

  it('自定义任务全勾才算完成', () => {
    const s = section({
      tasks: {
        resources: [],
        resourceDone: true,
        flashcardsDone: true,
        exerciseDone: true,
        custom: [{ id: 'c1', text: '读完课本这一节', done: true }],
      },
    });
    expect(isSectionDone(s)).toBe(true);
  });

  it('⚠️ 有资源但没标完成 → 不算完成（不能因为"有资源"就推断看过了）', () => {
    /*
     * 这是「不做自动判定」的具体体现：资源存在 ≠ 用户看过。
     */
    const s = section({
      tasks: {
        resources: [
          { id: 'r1', title: '网课', url: 'https://x.com', source: 'search' },
          { id: 'r2', title: '文档', url: 'https://y.com', source: 'manual' },
        ],
        resourceDone: false,
        flashcardsDone: true,
        exerciseDone: true,
        custom: [],
      },
    });
    expect(isSectionDone(s)).toBe(false);
  });

  it('空任务状态默认三项都没完成', () => {
    expect(isSectionDone(section())).toBe(false);
  });
});

describe('chapterProgress / treeProgress', () => {
  it('章的完成进度按小节算', () => {
    const done = section({
      id: 'sec_a',
      tasks: { resources: [], resourceDone: true, flashcardsDone: true, exerciseDone: true, custom: [] },
    });
    const notDone = section({ id: 'sec_b' });
    const c = chapter({ sections: [done, notDone] });
    expect(chapterProgress(c)).toEqual({ done: 1, total: 2 });
  });

  it('整棵树的进度', () => {
    const done = section({
      id: 'sec_a',
      tasks: { resources: [], resourceDone: true, flashcardsDone: true, exerciseDone: true, custom: [] },
    });
    const t = tree({
      chapters: [
        chapter({ number: 1, sections: [done, done] }),
        chapter({ number: 2, sections: [section({ id: 'sec_c' })] }),
      ],
    });
    const p = treeProgress(t);
    expect(p.sectionsDone).toBe(2);
    expect(p.sectionsTotal).toBe(3);
    /* 第 1 章两个小节都完成 → 1 章完成；第 2 章没有 */
    expect(p.chaptersDone).toBe(1);
    expect(p.chaptersTotal).toBe(2);
  });

  it('空章不计入「已完成章」', () => {
    const t = tree({ chapters: [chapter({ sections: [] })] });
    expect(treeProgress(t).chaptersDone).toBe(0);
  });
});

describe('chaptersFromSplit：切好的章节转树', () => {
  const split: SplitChapter[] = [
    {
      number: 1,
      title: '第1章 函数与极限',
      sections: [
        { title: '## 1.1 映射概念', number: '1.1', headingSegmentIndex: 1, segmentIds: ['seg-1', 'seg-2'] },
        { title: '## 1.2 函数的特性', number: '1.2', headingSegmentIndex: 3, segmentIds: ['seg-3'] },
      ],
    },
  ];

  it('小节从 heading 来，段 id 完整带过来', () => {
    const out = chaptersFromSplit(split, new Map(), () => []);
    expect(out).toHaveLength(1);
    expect(out[0]!.sections).toHaveLength(2);
    expect(out[0]!.sections[0]!.origin).toBe('heading');
    expect(out[0]!.sections[0]!.segmentIds).toEqual(['seg-1', 'seg-2']);
  });

  it('⚠️ 切不出小节的章 → 一个 whole-chapter 节点（如实退化）', () => {
    const splitNoSec: SplitChapter[] = [
      { number: 2, title: '第2章 没结构', sections: [] },
    ];
    const out = chaptersFromSplit(splitNoSec, new Map(), () => ['seg-9', 'seg-10']);
    expect(out[0]!.sections).toHaveLength(1);
    expect(out[0]!.sections[0]!.origin).toBe('whole-chapter');
    expect(out[0]!.sections[0]!.segmentIds).toEqual(['seg-9', 'seg-10']);
    /* 标题用章标题，不编一个假的小节名 */
    expect(out[0]!.sections[0]!.title).toBe('第2章 没结构');
  });

  it('AI 附加信息（难度/前置）按章号挂上', () => {
    const meta = new Map([
      [1, { difficulty: 3, prerequisites: [0], prereqReason: '需要先会函数', basis: 'search' as const }],
    ]);
    const out = chaptersFromSplit(split, meta, () => []);
    expect(out[0]!.difficulty).toBe(3);
    expect(out[0]!.prerequisites).toEqual([0]);
    expect(out[0]!.prereqReason).toBe('需要先会函数');
    expect(out[0]!.basis).toBe('search');
  });

  it('没有 AI 信息时用安全默认（难度 null，不猜）', () => {
    const out = chaptersFromSplit(split, new Map(), () => []);
    expect(out[0]!.difficulty).toBeNull();
    expect(out[0]!.prerequisites).toEqual([]);
    expect(out[0]!.basis).toBe('toc');
  });

  it('每个小节有唯一 id', () => {
    const out = chaptersFromSplit(split, new Map(), () => []);
    const ids = out[0]!.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fromLegacyRoute：v2 扁平路线转树', () => {
  const legacy: SourceRoute = {
    subject: '信号与系统',
    edition: '第二版',
    blocks: [
      {
        title: '信号基础概念',
        why: '先打基础',
        steps: [
          {
            chapterNumber: 1,
            title: '第1章 信号与系统',
            segmentIds: [],
            reason: '起点',
            basis: 'toc',
            difficulty: 2,
          },
        ],
      },
      {
        title: '典型信号与运算',
        why: '接着学',
        steps: [
          {
            chapterNumber: 2,
            title: '第2章 典型信号',
            segmentIds: [],
            reason: '',
            basis: 'model',
            difficulty: 4,
          },
        ],
      },
    ],
    beyond: [{ title: '第3章 傅里叶', note: '资料里没有' }],
    usedSearch: true,
    droppedOutOfScope: 2,
  };

  it('每个 step 变成一个章节点', () => {
    const t = fromLegacyRoute(legacy, 'src-signal');
    expect(t.chapters).toHaveLength(2);
    expect(t.chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(t.chapters[0]!.title).toBe('第1章 信号与系统');
  });

  it('旧路线没有小节 → 每章一个 whole-chapter 占位（不是空壳）', () => {
    /*
     * 转换时可能拿不到段落数据（切小节要段落）。
     * 先给占位，调用方拿到段落后再用 splitSections 替换。
     */
    const t = fromLegacyRoute(legacy, 'src-signal');
    expect(t.chapters[0]!.sections).toHaveLength(1);
    expect(t.chapters[0]!.sections[0]!.origin).toBe('whole-chapter');
  });

  it('难度/依据带过来', () => {
    const t = fromLegacyRoute(legacy, 'src-signal');
    expect(t.chapters[0]!.difficulty).toBe(2);
    expect(t.chapters[0]!.basis).toBe('toc');
    expect(t.chapters[1]!.difficulty).toBe(4);
    expect(t.chapters[1]!.basis).toBe('model');
  });

  it('beyond / usedSearch / droppedOutOfScope 不丢', () => {
    const t = fromLegacyRoute(legacy, 'src-signal');
    expect(t.beyond).toEqual([{ title: '第3章 傅里叶', note: '资料里没有' }]);
    expect(t.usedSearch).toBe(true);
    expect(t.droppedOutOfScope).toBe(2);
  });

  it('sourceId 记下来（树要绑到资料上）', () => {
    expect(fromLegacyRoute(legacy, 'src-signal').sourceId).toBe('src-signal');
  });
});

describe('normalizeSourceTree：坏数据不崩', () => {
  it('null / 数组 / 字符串都返回 null', () => {
    expect(normalizeSourceTree(null)).toBeNull();
    expect(normalizeSourceTree([])).toBeNull();
    expect(normalizeSourceTree('abc')).toBeNull();
    expect(normalizeSourceTree(42)).toBeNull();
  });

  it('没有 chapters 数组 → null', () => {
    expect(normalizeSourceTree({})).toBeNull();
    expect(normalizeSourceTree({ chapters: 'x' })).toBeNull();
    expect(normalizeSourceTree({ chapters: [] })).toBeNull();
  });

  it('缺标题的章丢掉，其余保留', () => {
    const t = normalizeSourceTree({
      subject: 'x',
      chapters: [
        { number: 1, title: '第1章 甲', sections: [{ title: '1.1 a' }] },
        { number: 2, title: '', sections: [{ title: '2.1 b' }] },
      ],
    });
    expect(t?.chapters).toHaveLength(1);
    expect(t?.chapters[0]!.number).toBe(1);
  });

  it('章没有 sections → 补一个 whole-chapter 节点（界面不留空壳）', () => {
    const t = normalizeSourceTree({ chapters: [{ number: 1, title: '第1章 甲' }] });
    expect(t?.chapters[0]!.sections).toHaveLength(1);
    expect(t?.chapters[0]!.sections[0]!.origin).toBe('whole-chapter');
  });

  it('难度越界置 null（不夹边界值）', () => {
    const t = normalizeSourceTree({
      chapters: [{ number: 1, title: 'a', difficulty: 99, sections: [{ title: 's' }] }],
    });
    expect(t?.chapters[0]!.difficulty).toBeNull();
  });

  it('不认识的前置章号类型被丢掉', () => {
    const t = normalizeSourceTree({
      chapters: [{ number: 1, title: 'a', prerequisites: [2, 'x', null, 3], sections: [{ title: 's' }] }],
    });
    expect(t?.chapters[0]!.prerequisites).toEqual([2, 3]);
  });

  it('不认识的 basis 归 toc', () => {
    const t = normalizeSourceTree({
      chapters: [{ number: 1, title: 'a', basis: 'whatever', sections: [{ title: 's' }] }],
    });
    expect(t?.chapters[0]!.basis).toBe('toc');
  });

  it('⚠️ 没有 url 的资源被丢掉（点不开的废数据）', () => {
    const t = normalizeSourceTree({
      chapters: [
        {
          number: 1,
          title: 'a',
          sections: [
            {
              title: 's',
              tasks: {
                resources: [
                  { id: 'r1', title: '好的', url: 'https://ok.com' },
                  { id: 'r2', title: '没网址' },
                  { id: 'r3', title: '', url: 'https://x.com' },
                ],
              },
            },
          ],
        },
      ],
    });
    const res = t?.chapters[0]!.sections[0]!.tasks.resources ?? [];
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toBe('好的');
  });

  it('任务布尔值只有严格 true 才算完成', () => {
    const t = normalizeSourceTree({
      chapters: [
        {
          number: 1,
          title: 'a',
          sections: [
            { title: 's', tasks: { resourceDone: 'yes', flashcardsDone: 1, exerciseDone: true } },
          ],
        },
      ],
    });
    const tasks = t?.chapters[0]!.sections[0]!.tasks;
    expect(tasks?.resourceDone).toBe(false);
    expect(tasks?.flashcardsDone).toBe(false);
    expect(tasks?.exerciseDone).toBe(true);
  });

  it('自定义任务缺文本的丢掉', () => {
    const t = normalizeSourceTree({
      chapters: [
        {
          number: 1,
          title: 'a',
          sections: [{ title: 's', tasks: { custom: [{ text: '读课本', done: true }, { done: false }] } }],
        },
      ],
    });
    expect(t?.chapters[0]!.sections[0]!.tasks.custom).toHaveLength(1);
  });

  it('小节 id 缺失时补一个（不留空 id）', () => {
    const t = normalizeSourceTree({
      chapters: [{ number: 1, title: 'a', sections: [{ title: 's' }] }],
    });
    expect(t?.chapters[0]!.sections[0]!.id).toMatch(/^sec_/);
  });

  it('往返稳定：normalize(tree(json)) 与 tree 等价', () => {
    /*
     * 这是一条"存进去再读出来不会变形"的守门测试。
     * 有了它，改 normalize 时不会静默丢字段。
     */
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          sections: [
            section({
              id: 'sec_x',
              title: '1.1 a',
              segmentIds: ['s1', 's2'],
              tasks: {
                resources: [{ id: 'r1', title: '网课', url: 'https://a.com', source: 'manual' }],
                resourceDone: true,
                flashcardsDone: false,
                exerciseDone: true,
                custom: [{ id: 'c1', text: '做笔记', done: true }],
              },
            }),
          ],
        }),
      ],
    });
    const after = normalizeSourceTree(JSON.parse(JSON.stringify(before)));
    expect(after).toEqual(before);
  });
});