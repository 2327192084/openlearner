import { describe, expect, it } from 'vitest';
import type { SourceRoute } from '@/core/ai/source-route.ts';
import type { SourceSegment } from '@/core/model.ts';
import { buildTreeFromRoute, carryTaskProgress, prereqNote, rebuildSections } from './tree-build.ts';
import { emptyTasks, type ChapterNode, type SourceTree } from './source-tree.ts';

/**
 * 把 v2 扁平路线 + 真实段落装配成带小节的树（2026-11-22）。
 *
 * 这组测试守的是**用户会当场看出来**的几件事：
 *
 * 1. 树上真的有分叉（不是每章一个孤零零的节点）
 * 2. **跨章同号小节不串味**（高数每章都有「1.」—— 最容易写错的一条）
 * 3. 用户勾过的任务状态**重新装配后不丢**（丢了等于白勾）
 * 4. 前置提醒只提醒、不锁
 */

/** 造一段正文 */
function seg(index: number, text: string, sourceId = 'src-1'): SourceSegment {
  return {
    id: `seg-${index}`,
    sourceId,
    index,
    page: index,
    chapter: null,
    text,
    charCount: text.length,
  };
}

/** 造一条 v2 扁平路线 */
function route(steps: { n: number; title: string }[]): SourceRoute {
  return {
    subject: '信号与系统',
    edition: '第二版',
    blocks: [
      {
        title: '基础',
        why: '先打基础',
        steps: steps.map((s) => ({
          chapterNumber: s.n,
          title: s.title,
          segmentIds: [],
          reason: '按目录',
          basis: 'toc' as const,
          difficulty: 2,
        })),
      },
    ],
    beyond: [],
    usedSearch: false,
    droppedOutOfScope: 0,
  };
}

/** 造一个章节点 */
function chapter(over: Partial<ChapterNode> = {}): ChapterNode {
  return {
    number: 1,
    title: '第1章 甲',
    prerequisites: [],
    prereqReason: '',
    difficulty: 2,
    basis: 'toc',
    sections: [
      {
        id: 'sec_a',
        title: '1.1 甲一',
        segmentIds: ['seg-1'],
        origin: 'heading',
        tasks: emptyTasks(),
      },
    ],
    ...over,
  };
}

function tree(over: Partial<SourceTree> = {}): SourceTree {
  return {
    subject: '高等数学',
    edition: '',
    sourceId: 'src-1',
    chapters: [chapter()],
    beyond: [],
    usedSearch: false,
    droppedOutOfScope: 0,
    savedAt: '2026-11-22T00:00:00.000Z',
    ...over,
  };
}

describe('buildTreeFromRoute：树上真的长出小节', () => {
  it('信号与系统那种 `## 1.1 xxx` 能被切出来，章上出现多个小节', () => {
    const segments = [
      seg(1, '第1章 信号与系统\n## 1.1 连续时间信号\n正文甲'),
      seg(2, '## 1.2 离散时间信号\n正文乙'),
      seg(3, '## 1.3 系统的分类\n正文丙'),
    ];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 信号与系统' }]),
      sourceId: 'src-1',
      segments,
    });

    expect(built.tree.chapters).toHaveLength(1);
    const ch = built.tree.chapters[0]!;
    /* 坏实现：不切小节 → 这里会只有 1 个 whole-chapter 节点 */
    expect(ch.sections.length).toBe(3);
    expect(ch.sections.every((s) => s.origin === 'heading')).toBe(true);
    expect(built.drilledChapters).toBe(1);
    expect(built.sectionsFrom).toBe('heading');
  });

  it('小节标题是资料原文（不是章标题复制）', () => {
    const segments = [
      seg(1, '第1章 信号与系统\n## 1.1 连续时间信号\n正文甲'),
      seg(2, '## 1.2 离散时间信号\n正文乙'),
    ];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 信号与系统' }]),
      sourceId: 'src-1',
      segments,
    });
    const titles = built.tree.chapters[0]!.sections.map((s) => s.title);
    expect(titles).toEqual(['1.1 连续时间信号', '1.2 离散时间信号']);
  });

  it('段 id 归到正确的小节（用于算「这一节多少正文」）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA1'),
      seg(2, 'A2'),
      seg(3, '## 1.2 二\nB1'),
    ];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments,
    });
    const [s1, s2] = built.tree.chapters[0]!.sections;
    expect(s1!.segmentIds).toEqual(['seg-1', 'seg-2']);
    expect(s2!.segmentIds).toEqual(['seg-3']);
  });
});

describe('buildTreeFromRoute：⚠️ 跨章同号小节不串味', () => {
  /**
   * 高数每章都有「1.」「2.」——**章内序号**。
   * 按编号全局分组会把第 2 章的「1. 导数的定义」错归到第 1 章。
   *
   * 这是方案 4.2 节标明「最容易写错的一条」。
   * 判据必须**同时**验两章的节都在、且内容没互换 ——
   * 只验数量的话，互换内容的坏实现也能通过。
   */
  it('第 2 章的「1.」不会被归到第 1 章（两章内容不互换）', () => {
    const segments = [
      seg(1, '第1章 函数与极限\n## 1. 映射概念\n甲正文'),
      seg(2, '## 2. 数列极限\n甲正文二'),
      seg(3, '第2章 导数与微分\n## 1. 导数的定义\n乙正文'),
      seg(4, '## 2. 求导法则\n乙正文二'),
    ];
    const built = buildTreeFromRoute({
      route: route([
        { n: 1, title: '第1章 函数与极限' },
        { n: 2, title: '第2章 导数与微分' },
      ]),
      sourceId: 'src-1',
      segments,
    });

    const ch1 = built.tree.chapters.find((c) => c.number === 1)!;
    const ch2 = built.tree.chapters.find((c) => c.number === 2)!;

    expect(ch1.sections.map((s) => s.title)).toEqual(['1. 映射概念', '2. 数列极限']);
    expect(ch2.sections.map((s) => s.title)).toEqual(['1. 导数的定义', '2. 求导法则']);

    /* 内容也不能串：第 2 章第一小节的段必须是 seg-3 */
    expect(ch2.sections[0]!.segmentIds).toContain('seg-3');
    expect(ch1.sections[0]!.segmentIds).not.toContain('seg-3');
  });

  it('章序错乱的资料也各归各章（不按出现顺序硬对）', () => {
    /* 第 2 章的内容出现在第 1 章之前（目录页/装订问题） */
    const segments = [
      seg(1, '第2章 乙\n## 1. 乙一\n乙正文'),
      seg(2, '第1章 甲\n## 1. 甲一\n甲正文'),
    ];
    const built = buildTreeFromRoute({
      route: route([
        { n: 1, title: '第1章 甲' },
        { n: 2, title: '第2章 乙' },
      ]),
      sourceId: 'src-1',
      segments,
    });
    const ch1 = built.tree.chapters.find((c) => c.number === 1)!;
    const ch2 = built.tree.chapters.find((c) => c.number === 2)!;
    expect(ch1.sections[0]!.segmentIds).toEqual(['seg-2']);
    expect(ch2.sections[0]!.segmentIds).toEqual(['seg-1']);
  });
});

describe('buildTreeFromRoute：⚠️ 切不出就如实退化', () => {
  it('整份资料没标题（pptx 那种）→ 整章一个节点，不假装有结构', () => {
    const segments = [seg(1, '纯文字没有标题'), seg(2, '还是纯文字')];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments,
    });
    const ch = built.tree.chapters[0]!;
    expect(ch.sections).toHaveLength(1);
    expect(ch.sections[0]!.origin).toBe('whole-chapter');
    /* 没有任何章真被钻取 */
    expect(built.drilledChapters).toBe(0);
    expect(built.sectionsFrom).toBe('none');
  });

  it('只切出 1 个小节也算切不出（树上没有分叉可看）', () => {
    /*
     * 只有 1 个节点的"树"和"整章学"长得一样，用户看不到分叉。
     * 阈值 2 与 `chaptersNeedingAiSplit` 保持一致。
     */
    const segments = [seg(1, '第1章 甲\n## 1.1 唯一一节\n正文')];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments,
    });
    const ch = built.tree.chapters[0]!;
    expect(ch.sections).toHaveLength(1);
    expect(ch.sections[0]!.origin).toBe('whole-chapter');
    expect(built.drilledChapters).toBe(0);
  });

  it('部分章切出、部分切不出 → sectionsFrom = mixed（如实告知）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA'),
      seg(2, '## 1.2 二\nB'),
      seg(3, '第2章 乙\n纯文字'),
    ];
    const built = buildTreeFromRoute({
      route: route([
        { n: 1, title: '第1章 甲' },
        { n: 2, title: '第2章 乙' },
      ]),
      sourceId: 'src-1',
      segments,
    });
    expect(built.drilledChapters).toBe(1);
    expect(built.sectionsFrom).toBe('mixed');
  });

  it('路线里的章在正文里找不到 → 保留原节点（不消失、不白屏）', () => {
    const segments = [seg(1, '第9章 无关内容\n## 9.1 一\nX')];
    const built = buildTreeFromRoute({
      route: route([{ n: 3, title: '第3章 找不到' }]),
      sourceId: 'src-1',
      segments,
    });
    expect(built.tree.chapters).toHaveLength(1);
    expect(built.tree.chapters[0]!.title).toBe('第3章 找不到');
    expect(built.tree.chapters[0]!.sections).toHaveLength(1);
  });

  it('没有段落（解析失败）→ 不崩，仍是退化节点', () => {
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments: [],
    });
    expect(built.tree.chapters).toHaveLength(1);
    expect(built.tree.chapters[0]!.sections[0]!.origin).toBe('whole-chapter');
  });
});

describe('buildTreeFromRoute：原有信息不丢', () => {
  it('beyond / usedSearch / droppedOutOfScope 原样带过来', () => {
    const r = route([{ n: 1, title: '第1章 甲' }]);
    r.beyond = [{ title: '第2章', note: '资料里没有' }];
    r.usedSearch = true;
    r.droppedOutOfScope = 3;

    const built = buildTreeFromRoute({
      route: r,
      sourceId: 'src-1',
      segments: [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')],
    });
    expect(built.tree.beyond).toEqual([{ title: '第2章', note: '资料里没有' }]);
    expect(built.tree.usedSearch).toBe(true);
    expect(built.tree.droppedOutOfScope).toBe(3);
  });

  it('章的 difficulty / basis 保留（不被切小节冲掉）', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments,
    });
    expect(built.tree.chapters[0]!.difficulty).toBe(2);
    expect(built.tree.chapters[0]!.basis).toBe('toc');
  });
});

describe('rebuildSections：⚠️ 用户勾过的任务状态不能丢', () => {
  /**
   * 这是本文件最贵的一条：用户在一棵树上勾了 20 个小节的
   * 「已看过 / 已学完 / 已做完」，重新进页面时树要重新装配
   * （段落要重新读、小节要重新切）。如果状态丢了，他勾的全白费。
   *
   * 对齐方式：按**小节标题**（id 每次都会重新生成，标题跨次稳定）。
   */
  it('同一标题的小节，三项勾选状态继承下来', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')];
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          title: '第1章 甲',
          sections: [
            {
              id: 'old_1',
              title: '1.1 一',
              segmentIds: ['seg-1'],
              origin: 'heading',
              tasks: {
                resources: [],
                resourceDone: true,
                flashcardsDone: true,
                exerciseDone: false,
                custom: [],
              },
            },
            {
              id: 'old_2',
              title: '1.2 二',
              segmentIds: ['seg-2'],
              origin: 'heading',
              tasks: emptyTasks(),
            },
          ],
        }),
      ],
    });

    const built = rebuildSections(before, segments);
    const [s1, s2] = built.tree.chapters[0]!.sections;
    expect(s1!.title).toBe('1.1 一');
    expect(s1!.tasks.resourceDone).toBe(true);
    expect(s1!.tasks.flashcardsDone).toBe(true);
    expect(s1!.tasks.exerciseDone).toBe(false);
    /* 没勾过的那个仍是全 false */
    expect(s2!.tasks.resourceDone).toBe(false);
  });

  it('自定义任务（含 done 状态）也继承下来', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')];
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          sections: [
            {
              id: 'old_1',
              title: '1.1 一',
              segmentIds: ['seg-1'],
              origin: 'heading',
              tasks: {
                resources: [],
                resourceDone: false,
                flashcardsDone: false,
                exerciseDone: false,
                custom: [{ id: 'c1', text: '看老师的第 3 讲', done: true }],
              },
            },
          ],
        }),
      ],
    });
    const built = rebuildSections(before, segments);
    const s1 = built.tree.chapters[0]!.sections[0]!;
    expect(s1.tasks.custom).toEqual([{ id: 'c1', text: '看老师的第 3 讲', done: true }]);
  });

  it('手工加的资源链接也继承（用户可见的东西不能悄悄消失）', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')];
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          sections: [
            {
              id: 'old_1',
              title: '1.1 一',
              segmentIds: ['seg-1'],
              origin: 'heading',
              tasks: {
                resources: [
                  { id: 'r1', title: 'B站网课', url: 'https://b23.tv/x', source: 'manual' },
                ],
                resourceDone: false,
                flashcardsDone: false,
                exerciseDone: false,
                custom: [],
              },
            },
          ],
        }),
      ],
    });
    const built = rebuildSections(before, segments);
    expect(built.tree.chapters[0]!.sections[0]!.tasks.resources).toHaveLength(1);
    expect(built.tree.chapters[0]!.sections[0]!.tasks.resources[0]!.title).toBe('B站网课');
  });

  it('标题对不上（资料重新解析换了标题）→ 旧状态不串到别的小节上', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 全新标题一\nA'), seg(2, '## 1.2 全新标题二\nB')];
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          sections: [
            {
              id: 'old_1',
              title: '## 1.1 老标题',
              segmentIds: ['seg-1'],
              origin: 'heading',
              tasks: {
                resources: [],
                resourceDone: true,
                flashcardsDone: true,
                exerciseDone: true,
                custom: [],
              },
            },
          ],
        }),
      ],
    });
    const built = rebuildSections(before, segments);
    /* 标题全变了 → 一个新的勾都不该继承（宁可重勾，也不要把状态安错地方） */
    expect(built.tree.chapters[0]!.sections.every((s) => !s.tasks.resourceDone)).toBe(true);
  });

  it('小节 id 每次重新生成（不与旧的撞）', () => {
    const segments = [seg(1, '第1章 甲\n## 1.1 一\nA'), seg(2, '## 1.2 二\nB')];
    const before = tree({
      chapters: [
        chapter({
          number: 1,
          sections: [
            {
              id: 'old_1',
              title: '1.1 一',
              segmentIds: ['seg-1'],
              origin: 'heading',
              tasks: emptyTasks(),
            },
          ],
        }),
      ],
    });
    const built = rebuildSections(before, segments);
    expect(built.tree.chapters[0]!.sections[0]!.id).not.toBe('old_1');
    /* 但仍然是合法格式 */
    expect(built.tree.chapters[0]!.sections[0]!.id.startsWith('sec_')).toBe(true);
  });
});

describe('prereqNote：只提醒、不锁', () => {
  it('有前置且未完成 → 出提醒文案，含章号与理由', () => {
    const chapters = [
      chapter({ number: 1 }),
      chapter({
        number: 2,
        prerequisites: [1],
        prereqReason: '第 2 章的导数要用到第 1 章的极限',
      }),
    ];
    const note = prereqNote(chapters[1]!, chapters);
    expect(note).not.toBeNull();
    expect(note!.chapters).toEqual([1]);
    expect(note!.text).toContain('第 1 章');
    expect(note!.text).toContain('极限');
    /* 必须明确说"不拦你" —— 用户要求章节可并行 */
    expect(note!.text).toContain('不拦你');
  });

  it('没有前置 → 不出提醒（不是空字符串，是 null）', () => {
    const chapters = [chapter({ number: 1, prerequisites: [] })];
    expect(prereqNote(chapters[0]!, chapters)).toBeNull();
  });

  it('⚠️ 不存在的章号被丢弃（AI 可能给出这份资料里没有的章）', () => {
    const chapters = [
      chapter({ number: 1 }),
      chapter({ number: 2, prerequisites: [7], prereqReason: '想象出来的' }),
    ];
    expect(prereqNote(chapters[1]!, chapters)).toBeNull();
  });

  it('⚠️ 自引用被丢弃（「第 2 章需要先学第 2 章」是废话）', () => {
    const chapters = [chapter({ number: 2, prerequisites: [2], prereqReason: '自己的' })];
    expect(prereqNote(chapters[0]!, chapters)).toBeNull();
  });

  it('⚠️ 前置章已完成时不再提醒（催用户学已学过的章是噪音）', () => {
    const doneTasks = {
      resources: [],
      resourceDone: true,
      flashcardsDone: true,
      exerciseDone: true,
      custom: [],
    };
    const chapters = [
      chapter({
        number: 1,
        sections: [
          {
            id: 's1',
            title: '1.1',
            segmentIds: [],
            origin: 'heading',
            tasks: doneTasks,
          },
        ],
      }),
      chapter({ number: 2, prerequisites: [1], prereqReason: '要用到第 1 章' }),
    ];
    expect(prereqNote(chapters[1]!, chapters)).toBeNull();
  });

  it('一个有效一个无效 → 只提醒有效的那个', () => {
    const chapters = [
      chapter({ number: 1 }),
      chapter({ number: 3 }),
      chapter({ number: 4, prerequisites: [1, 99], prereqReason: '理由' }),
    ];
    const note = prereqNote(chapters[2]!, chapters);
    expect(note!.chapters).toEqual([1]);
    expect(note!.text).not.toContain('99');
  });

  it('重复的前置章号去重', () => {
    const chapters = [chapter({ number: 1 }), chapter({ number: 2, prerequisites: [1, 1] })];
    const note = prereqNote(chapters[1]!, chapters);
    expect(note!.chapters).toEqual([1]);
  });

  it('多个前置按章号升序（文案读起来自然）', () => {
    const chapters = [
      chapter({ number: 1 }),
      chapter({ number: 2 }),
      chapter({ number: 3, prerequisites: [2, 1] }),
    ];
    const note = prereqNote(chapters[2]!, chapters);
    expect(note!.chapters).toEqual([1, 2]);
  });

  it('没有理由时文案也不怪（不留悬空破折号 / 空括号）', () => {
    const chapters = [chapter({ number: 1 }), chapter({ number: 2, prerequisites: [1] })];
    const note = prereqNote(chapters[1]!, chapters);
    const t = note!.text;
    /* 悬空的「—— 」是坏实现：理由为空还拼破折号 */
    expect(t).not.toContain('—— ');
    /* 空括号「（）」也是坏实现 */
    expect(t).not.toContain('（）');
    /* 但「不拦你」那句必须还在 —— 那是用户要求的语气 */
    expect(t).toContain('不拦你');
  });
});
describe('⚠️ 同章号多步不能重复吃同一批小节（截图发现的真实 bug）', () => {
  /**
   * 用户库里那条 v2 路线是 AI 对**同一章**做的三段细分：
   * 三步都是 `chapterNumber: 1`。
   *
   * 坏实现按章号匹配，于是三步各拿全部 26 个小节 ——
   * 界面上三个章都显示「0 / 26」，标题栏 `0 / 78`（3×26）。
   * 这个 bug 是**看截图**发现的，此前 32 条 CDP 断言全绿
   *（它们只查章数、分叉，没查总数有没有重复计）。
   *
   * 判据必须验**总数**，不只验"每章有节点"：
   * 只验后者的话，坏实现照样绿。
   */
  it('三步同号 → 小节总数等于切出来的总数（不 ×3）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA'),
      seg(2, '## 1.2 二\nB'),
      seg(3, '## 1.3 三\nC'),
    ];
    const r = route([
      { n: 1, title: '信号的描述与分类' },
      { n: 1, title: '基本连续信号与运算' },
      { n: 1, title: '系统的描述与线性时不变性' },
    ]);
    r.blocks[0]!.steps = r.blocks[0]!.steps; // keep 3 steps in one block
    const built = buildTreeFromRoute({ route: r, sourceId: 'src-1', segments });

    const total = built.tree.chapters.reduce((n, c) => n + c.sections.length, 0);
    /* 切出 3 个小节 → 三个章加起来必须正好 3，不是 9 */
    expect(total).toBe(3);
  });

  it('分摊后每步都有小节，且互不重复（段 id 不重叠）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA'),
      seg(2, '## 1.2 二\nB'),
      seg(3, '## 1.3 三\nC'),
      seg(4, '## 1.4 四\nD'),
    ];
    const r = route([
      { n: 1, title: '第一步' },
      { n: 1, title: '第二步' },
    ]);
    const built = buildTreeFromRoute({ route: r, sourceId: 'src-1', segments });

    const all = built.tree.chapters.flatMap((c) => c.sections);
    expect(all.length).toBe(4);
    /* 段 id 不许在两步之间重复出现 */
    const seen = new Set<string>();
    for (const s of all) {
      for (const id of s.segmentIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    /* 两步都非空 */
    expect(built.tree.chapters.every((c) => c.sections.length > 0)).toBe(true);
  });

  it('小节标题也不重复（同一个标题不该在两章各出现一次）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA'),
      seg(2, '## 1.2 二\nB'),
      seg(3, '## 1.3 三\nC'),
      seg(4, '## 1.4 四\nD'),
    ];
    const r = route([
      { n: 1, title: '第一步' },
      { n: 1, title: '第二步' },
    ]);
    const built = buildTreeFromRoute({ route: r, sourceId: 'src-1', segments });
    const titles = built.tree.chapters.flatMap((c) => c.sections.map((s) => s.title));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('单步的章行为不变（不分摊，拿到全部小节）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 一\nA'),
      seg(2, '## 1.2 二\nB'),
      seg(3, '## 1.3 三\nC'),
    ];
    const built = buildTreeFromRoute({
      route: route([{ n: 1, title: '第1章 甲' }]),
      sourceId: 'src-1',
      segments,
    });
    expect(built.tree.chapters[0]!.sections).toHaveLength(3);
  });

  it('不同章号各拿各的（不因分摊逻辑串味）', () => {
    const segments = [
      seg(1, '第1章 甲\n## 1.1 甲一\nA'),
      seg(2, '## 1.2 甲二\nB'),
      seg(3, '第2章 乙\n## 1. 乙一\nC'),
      seg(4, '## 2. 乙二\nD'),
    ];
    const built = buildTreeFromRoute({
      route: route([
        { n: 1, title: '第1章 甲' },
        { n: 2, title: '第2章 乙' },
      ]),
      sourceId: 'src-1',
      segments,
    });
    const ch1 = built.tree.chapters.find((c) => c.number === 1)!;
    const ch2 = built.tree.chapters.find((c) => c.number === 2)!;
    expect(ch1.sections.map((s) => s.title)).toEqual(['1.1 甲一', '1.2 甲二']);
    expect(ch2.sections.map((s) => s.title)).toEqual(['1. 乙一', '2. 乙二']);
  });
});

/* ==========================================================================
 * 「重新生成地图」保留勾选（2026-11-22 下午）
 * ========================================================================== */

function secNode(over: Partial<import('./source-tree.ts').SectionNode> = {}) {
  return {
    id: 'sec_' + Math.random().toString(36).slice(2, 8),
    title: '1.1 一',
    segmentIds: ['seg-1'],
    origin: 'heading' as const,
    tasks: {
      resources: [],
      resourceDone: false,
      flashcardsDone: false,
      exerciseDone: false,
      custom: [],
    },
    ...over,
  };
}

function treeOf(sections: ReturnType<typeof secNode>[]): import('./source-tree.ts').SourceTree {
  return {
    subject: '信号与系统',
    edition: '第二版',
    sourceId: 'src-1',
    chapters: [
      {
        number: 1,
        title: '第1章 甲',
        prerequisites: [],
        prereqReason: '',
        difficulty: 2,
        basis: 'toc' as const,
        sections,
      },
    ],
    beyond: [],
    usedSearch: false,
    droppedOutOfScope: 0,
    savedAt: '2026-11-22T10:00:00.000Z',
  };
}

describe('carryTaskProgress：重新生成时保留勾选', () => {
  /**
   * 用户原话：「可以改成那样」（保留已完成小节的状态）。
   *
   * 关键在于：AI 重排后章节结构会变，但资料里的小节标题是原文、
   * 跨次稳定 —— 所以按标题对齐。对不上的**绝不能安到别的节上**。
   */
  it('同名小节的三项勾选搬过去', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 连续时间信号',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: true,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 连续时间信号' })]);

    const r = carryTaskProgress(next, prev);
    expect(r.carried).toBe(1);
    expect(r.lost).toBe(0);
    expect(r.tree.chapters[0]!.sections[0]!.tasks.resourceDone).toBe(true);
    expect(r.tree.chapters[0]!.sections[0]!.tasks.flashcardsDone).toBe(true);
    expect(r.tree.chapters[0]!.sections[0]!.tasks.exerciseDone).toBe(false);
  });

  it('标题里的空格差异不影响对齐（「1.1 一」vs「1.1  一」）', () => {
    const prev = treeOf([
      secNode({
        title: '1.1  连续时间信号',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 连续时间信号' })]);
    expect(carryTaskProgress(next, prev).carried).toBe(1);
  });

  it('自定义任务（含 done）搬过去', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 一',
        tasks: {
          resources: [],
          resourceDone: false,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [{ id: 'c1', text: '看第 3 讲', done: true }],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 一' })]);
    const r = carryTaskProgress(next, prev);
    expect(r.tree.chapters[0]!.sections[0]!.tasks.custom).toEqual([
      { id: 'c1', text: '看第 3 讲', done: true },
    ]);
  });

  it('⚠️ 只搬手工加的资源，联网搜的不搬（会和新结果混）', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 一',
        tasks: {
          resources: [
            { id: 'r1', title: '手工的', url: 'https://a.com', source: 'manual' },
            { id: 'r2', title: '搜来的', url: 'https://b.com', source: 'search' },
          ],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 一' })]);
    const got = carryTaskProgress(next, prev).tree.chapters[0]!.sections[0]!.tasks.resources;
    expect(got).toHaveLength(1);
    expect(got[0]!.source).toBe('manual');
  });

  it('⚠️ 对不上就不搬，且绝不把 A 的状态安到 B 上', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 旧的标题',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: true,
          exerciseDone: true,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 全新的标题' })]);
    const r = carryTaskProgress(next, prev);
    /* 新树仍是全未勾 —— 没有把旧的勾选安过去 */
    expect(r.tree.chapters[0]!.sections[0]!.tasks.resourceDone).toBe(false);
    expect(r.carried).toBe(0);
    /* 但如实报告丢了 1 节 */
    expect(r.lost).toBe(1);
    expect(r.lostTitles).toEqual(['1.1 旧的标题']);
  });

  it('部分对上部分对不上 → 各算各的', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 能对上',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
      secNode({
        title: '1.2 对不上',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ title: '1.1 能对上' }), secNode({ title: '1.9 新的' })]);
    const r = carryTaskProgress(next, prev);
    expect(r.carried).toBe(1);
    expect(r.lost).toBe(1);
    expect(r.tree.chapters[0]!.sections[0]!.tasks.resourceDone).toBe(true);
    expect(r.tree.chapters[0]!.sections[1]!.tasks.resourceDone).toBe(false);
  });

  it('⚠️ 没有痕迹的小节不算「丢失」（否则新地图会被报丢 26 节）', () => {
    const prev = treeOf([secNode({ title: '1.1 没动过' }), secNode({ title: '1.2 也没动' })]);
    const next = treeOf([secNode({ title: '1.9 全新' })]);
    const r = carryTaskProgress(next, prev);
    expect(r.lost).toBe(0);
    expect(r.lostTitles).toEqual([]);
  });

  it('旧树为 null → 原样返回新树（第一次创建地图）', () => {
    const next = treeOf([secNode({ title: '1.1 一' })]);
    const r = carryTaskProgress(next, null);
    expect(r.carried).toBe(0);
    expect(r.lost).toBe(0);
    expect(r.tree).toBe(next);
  });

  it('新树为空 → 不崩，旧痕迹全算丢失', () => {
    const prev = treeOf([
      secNode({
        title: '1.1 一',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([]);
    const r = carryTaskProgress(next, prev);
    expect(r.carried).toBe(0);
    expect(r.lost).toBe(1);
  });

  it('搬过去的小节 id 用的是新树的（不与旧 id 撞）', () => {
    const prev = treeOf([
      secNode({
        id: 'old_id',
        title: '1.1 一',
        tasks: {
          resources: [],
          resourceDone: true,
          flashcardsDone: false,
          exerciseDone: false,
          custom: [],
        },
      }),
    ]);
    const next = treeOf([secNode({ id: 'new_id', title: '1.1 一' })]);
    const r = carryTaskProgress(next, prev);
    expect(r.tree.chapters[0]!.sections[0]!.id).toBe('new_id');
  });

  it('章的结构（章号/标题/难度）用新树的，不被旧树覆盖', () => {
    const prev = treeOf([secNode({ title: '1.1 一' })]);
    prev.chapters[0]!.title = '旧的章名';
    const next = treeOf([secNode({ title: '1.1 一' })]);
    next.chapters[0]!.title = '新的章名';
    const r = carryTaskProgress(next, prev);
    expect(r.tree.chapters[0]!.title).toBe('新的章名');
  });
});
