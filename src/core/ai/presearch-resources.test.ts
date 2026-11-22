import { describe, expect, it } from 'vitest';
import {
  buildChapterQuery,
  buildPresearchPrompt,
  buildSectionQuery,
  describePresearchCostEstimate,
  parsePresearchItems,
  planPresearchTasks,
  toPresearchedResources,
  type PresearchTask,
} from './presearch-resources.ts';
import { emptyTasks, type ChapterNode, type SectionNode } from '@/v2/core/source-tree.ts';

/**
 * 规划时预搜外部资源（2026-11-22，方案第 7 步最后一块）。
 *
 * ## 这组测试守的三件事
 *
 * 1. **成本可控** —— 请求次数是用户会付出的代价。章级 8 次 vs 小节级 30 次，
 *    `planPresearchTasks` 要能提前算出这个数字，且不能超上限。
 * 2. **不许编网址** —— 资源必须能点开；没有 URL 的"资源"比没有更糟。
 * 3. **坏输入挡住** —— 模型偶尔给 `file://`、空标题、重复 URL。
 */

function section(over: Partial<SectionNode> = {}): SectionNode {
  return {
    id: 'sec-1',
    title: '1.1 连续时间信号',
    segmentIds: ['seg-1'],
    origin: 'heading',
    tasks: emptyTasks(),
    ...over,
  };
}

function chapter(over: Partial<ChapterNode> = {}): ChapterNode {
  return {
    number: 1,
    title: '第1章 信号与系统',
    prerequisites: [],
    prereqReason: '',
    difficulty: 2,
    basis: 'toc',
    sections: [section()],
    ...over,
  };
}

const SEGS = new Map([
  ['seg-1', '连续时间信号在时间上是连续的'],
  ['seg-2', '离散时间信号只在离散时刻有定义'],
]);

describe('buildChapterQuery：查询词要能搜到"那一章"的资料', () => {
  it('带学科 + 版次 + 章号 + 章名', () => {
    const q = buildChapterQuery({
      subject: '信号与系统',
      edition: '第二版',
      chapterNumber: 2,
      chapterTitle: '第2章 连续时间系统的时域分析',
    });
    expect(q).toContain('信号与系统');
    expect(q).toContain('第二版');
    expect(q).toContain('第2章');
    expect(q).toContain('连续时间系统的时域分析');
  });

  it('⚠️ 章标题自带的「第2章」前缀被去掉（否则查询词里出现两次）', () => {
    const q = buildChapterQuery({
      subject: '信号与系统',
      edition: '',
      chapterNumber: 2,
      chapterTitle: '第2章 时域分析',
    });
    const matches = q.match(/第\s*2\s*章/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('带「网课 讲解」提示资源类型（用户要的是能看的，不是论文）', () => {
    const q = buildChapterQuery({
      subject: 'x',
      edition: '',
      chapterNumber: 1,
      chapterTitle: '甲',
    });
    expect(q).toContain('网课');
    expect(q).toContain('讲解');
  });

  it('没有版次也正常', () => {
    const q = buildChapterQuery({
      subject: 'x',
      edition: '',
      chapterNumber: 1,
      chapterTitle: '甲',
    });
    expect(q.startsWith('x')).toBe(true);
  });

  it('章号为 0（无章节结构的资料）不硬塞「第0章」', () => {
    const q = buildChapterQuery({
      subject: 'x',
      edition: '',
      chapterNumber: 0,
      chapterTitle: '整体',
    });
    expect(q).not.toContain('第0章');
  });
});

describe('buildSectionQuery', () => {
  it('带小节标题', () => {
    const q = buildSectionQuery({
      subject: '信号与系统',
      edition: '',
      chapterNumber: 1,
      sectionTitle: '1.1 连续时间信号',
    });
    expect(q).toContain('1.1 连续时间信号');
  });
});

describe('buildPresearchPrompt：三条防护', () => {
  const prompt = buildPresearchPrompt({
    subject: '信号与系统',
    chapterNumber: 2,
    chapterTitle: '第2章 时域分析',
    excerpt: '这一章讲卷积',
  });

  it('⚠️ 明确要求不许编造网址', () => {
    expect(prompt.system).toContain('不许编造网址');
    /* 还要说清"点不开的资源比没有更糟"这个道理 */
    expect(prompt.system).toContain('能直接点开');
  });

  it('⚠️ 明确说「宁可给 1 条真的，也不要凑 3 条假的」', () => {
    expect(prompt.system).toContain('宁可给 1 条真的');
    expect(prompt.system).toContain('也不要凑');
  });

  it('要求只给真实存在的网址（http/https）', () => {
    expect(prompt.system).toContain('http://');
    expect(prompt.system).toContain('https://');
  });

  it('排除盗版/需登录/题库（用户要的是能看的资料）', () => {
    expect(prompt.system).toContain('盗版');
    expect(prompt.system).toContain('需要登录');
  });

  it('正文摘录进提示词（帮模型判断这章讲什么）', () => {
    expect(prompt.user).toContain('卷积');
  });

  it('摘录超长会被截断（防止撑爆提示词）', () => {
    const p = buildPresearchPrompt({
      subject: 'x',
      chapterNumber: 1,
      chapterTitle: '甲',
      excerpt: 'y'.repeat(1000),
    });
    expect(p.user.indexOf('y'.repeat(500))).toBe(-1);
  });

  it('没有摘录时不留空行', () => {
    const p = buildPresearchPrompt({
      subject: 'x',
      chapterNumber: 1,
      chapterTitle: '甲',
      excerpt: '',
    });
    expect(p.user).not.toContain('\n\n\n');
  });
});

describe('parsePresearchItems：坏输入必须挡住', () => {
  it('正常三条', () => {
    const r = parsePresearchItems(
      JSON.stringify({
        items: [
          { title: '甲', url: 'https://a.com/1', why: '讲第一节' },
          { title: '乙', url: 'https://b.com/2', why: '' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(2);
  });

  it('⚠️ `file://` 被拒（只认 http/https）', () => {
    const r = parsePresearchItems(
      JSON.stringify({ items: [{ title: '本机文件', url: 'file:///C:/x.pdf' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it('⚠️ 没有协议的网址被拒（模型有时只给域名）', () => {
    const r = parsePresearchItems(
      JSON.stringify({ items: [{ title: '甲', url: 'www.a.com/x' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([]);
  });

  it('⚠️ 空标题被拒（列表里没法辨认）', () => {
    const r = parsePresearchItems(
      JSON.stringify({ items: [{ title: '   ', url: 'https://a.com' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([]);
  });

  it('⚠️ 重复 URL 只留第一条（同一资源给两遍没意义）', () => {
    const r = parsePresearchItems(
      JSON.stringify({
        items: [
          { title: '甲', url: 'https://a.com/x' },
          { title: '乙', url: 'https://www.a.com/x/' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('甲');
    expect(r.dropped).toBe(1);
  });

  it('空数组是合法结果（搜不到就不给，不是失败）', () => {
    const r = parsePresearchItems('{"items":[]}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([]);
  });

  it('带 ```json 围栏能解析', () => {
    const r = parsePresearchItems('```json\n{"items":[{"title":"甲","url":"https://a.com"}]}\n```');
    expect(r.ok).toBe(true);
  });

  it('⚠️ 残缺 JSON 整份拒绝（不修补括号）', () => {
    const r = parsePresearchItems('{"items":[{"title":"甲","url":"https://a.com"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('截断');
  });

  it('没有 items 字段 → 明确报错', () => {
    const r = parsePresearchItems('{"foo":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('items');
  });

  it('空内容 → 明确报错', () => {
    expect(parsePresearchItems('').ok).toBe(false);
  });

  it('items 里混了 null / 字符串 → 跳过并计入 dropped', () => {
    const r = parsePresearchItems(
      JSON.stringify({ items: [null, 'x', { title: '甲', url: 'https://a.com' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.dropped).toBe(2);
  });
});

describe('planPresearchTasks：成本必须可控', () => {
  const chapters: ChapterNode[] = [
    chapter({ number: 1, sections: [section({ id: 's1' }), section({ id: 's2' })] }),
    chapter({ number: 2, sections: [section({ id: 's3' })] }),
  ];

  it('章级：每章一次（2 章 = 2 次）', () => {
    const tasks = planPresearchTasks({
      subject: 'x',
      edition: '',
      chapters,
      segmentsById: SEGS,
      granularity: 'chapter',
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.sectionId === null)).toBe(true);
  });

  it('小节级：每节一次（3 节 = 3 次）', () => {
    const tasks = planPresearchTasks({
      subject: 'x',
      edition: '',
      chapters,
      segmentsById: SEGS,
      granularity: 'section',
    });
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.sectionId !== null)).toBe(true);
  });

  it('⚠️ 小节级的请求数远多于章级（这就是成本差别）', () => {
    const ch = planPresearchTasks({
      subject: 'x', edition: '', chapters, segmentsById: SEGS, granularity: 'chapter',
    });
    const sec = planPresearchTasks({
      subject: 'x', edition: '', chapters, segmentsById: SEGS, granularity: 'section',
    });
    expect(sec.length).toBeGreaterThan(ch.length);
  });

  it('⚠️ maxTasks 上限生效（防止超大资料一次发几十个请求）', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      chapter({ number: i + 1, sections: [section({ id: `s${i}` })] }),
    );
    const tasks = planPresearchTasks({
      subject: 'x',
      edition: '',
      chapters: many,
      segmentsById: SEGS,
      granularity: 'chapter',
      maxTasks: 8,
    });
    expect(tasks).toHaveLength(8);
  });

  it('小节级：没有正文的节不发请求（搜了也白搜）', () => {
    const tasks = planPresearchTasks({
      subject: 'x',
      edition: '',
      chapters: [
        chapter({
          number: 1,
          sections: [
            section({ id: 'with', segmentIds: ['seg-1'] }),
            section({ id: 'empty', segmentIds: [] }),
          ],
        }),
      ],
      segmentsById: SEGS,
      granularity: 'section',
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sectionId).toBe('with');
  });

  it('空章节列表 → 零任务', () => {
    const tasks = planPresearchTasks({
      subject: 'x', edition: '', chapters: [], segmentsById: SEGS, granularity: 'chapter',
    });
    expect(tasks).toEqual([]);
  });

  it('每个任务都带可直接用的查询词', () => {
    const tasks = planPresearchTasks({
      subject: '信号与系统', edition: '', chapters, segmentsById: SEGS, granularity: 'chapter',
    });
    for (const t of tasks) {
      expect(t.query.length).toBeGreaterThan(5);
      expect(t.query).toContain('信号与系统');
    }
  });
});

describe('toPresearchedResources', () => {
  const task: PresearchTask = {
    chapterNumber: 2,
    chapterTitle: '第2章 时域分析',
    sectionId: null,
    sectionTitle: null,
    query: 'q',
  };

  it('带上章号（用于挂到树上）', () => {
    const out = toPresearchedResources(task, [
      { title: '甲', url: 'https://a.com', why: '讲卷积' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.chapterNumber).toBe(2);
    expect(out[0]!.sectionId).toBeNull();
  });

  it('小节级任务带上 sectionId', () => {
    const secTask: PresearchTask = { ...task, sectionId: 'sec-9', sectionTitle: '2.1 卷积' };
    const out = toPresearchedResources(secTask, [
      { title: '甲', url: 'https://a.com', why: '' },
    ]);
    expect(out[0]!.sectionId).toBe('sec-9');
  });

  it('最多取 3 条（多了是噪音）', () => {
    const out = toPresearchedResources(
      task,
      Array.from({ length: 10 }, (_, i) => ({
        title: `t${i}`,
        url: `https://a.com/${i}`,
        why: '',
      })),
    );
    expect(out).toHaveLength(3);
  });

  it('保留 why（让用户知道为什么推荐这条）', () => {
    const out = toPresearchedResources(task, [
      { title: '甲', url: 'https://a.com', why: '讲卷积的定义' },
    ]);
    expect(out[0]!.why).toBe('讲卷积的定义');
  });

  it('空输入 → 空输出', () => {
    expect(toPresearchedResources(task, [])).toEqual([]);
  });
});

describe('describePresearchCostEstimate：话术不许超过真实上限（2026-11-23）', () => {
  it('章级：8 章教材 → 说 8 次（不谎报，也不截）', () => {
    const t = describePresearchCostEstimate({ chapterCount: 8, granularity: 'chapter' });
    expect(t).toContain('8 次');
    expect(t).not.toContain('最多');
  });

  it('⚠️ 章级：14 章教材 → 明说最多 10 次（话术与实际调用数是同一来源）', () => {
    const t = describePresearchCostEstimate({ chapterCount: 14, granularity: 'chapter' });
    expect(t).toContain('最多搜 10 次');
    /*
     * 反向验证：把上限写回旧默认 12 → 这条必须红。
     * （这条断言钉的是"话术说的数 = PRESEARCH_MAX_TASKS.chapter"，
     * 不是钉 10 这个数字本身；改上限时记得连同这条一起改。）
     */
    expect(t).not.toContain('12');
  });

  it('小节级：上限是 30，不能被章级的 10 截（用户选的就是这个量级）', () => {
    const t = describePresearchCostEstimate({ chapterCount: 8, granularity: 'section' });
    expect(t).toContain('30');
    expect(t).not.toContain('最多 10');
  });

  it('没有章结构 → 如实说估不了，不编数字', () => {
    const t = describePresearchCostEstimate({ chapterCount: null, granularity: 'chapter' });
    expect(t).toContain('估不');
  });

  it('两种粒度都说清"每次是一次完整模型调用"（成本要如实提示）', () => {
    expect(
      describePresearchCostEstimate({ chapterCount: 5, granularity: 'chapter' }),
    ).toContain('完整模型调用');
    expect(
      describePresearchCostEstimate({ chapterCount: 5, granularity: 'section' }),
    ).toContain('完整模型调用');
  });
});

describe('PRESEARCH_MAX_TASKS 按粒度分表（2026-11-23）', () => {
  it('planPresearchTasks 缺省上限按粒度取：15 个小节的资料，小节级不被章级的 10 截', () => {
    /* 1 章 × 15 节（都有正文）—— 章级 1 个任务，小节级 15 个 */
    const oneChManySec = [
      chapter({
        number: 1,
        sections: Array.from({ length: 15 }, (_, j) =>
          section({ id: `s${j}`, segmentIds: ['seg-1'] }),
        ),
      }),
    ];
    const chTasks = planPresearchTasks({
      subject: 'x', edition: '', chapters: oneChManySec, segmentsById: SEGS, granularity: 'chapter',
    });
    const secTasks = planPresearchTasks({
      subject: 'x', edition: '', chapters: oneChManySec, segmentsById: SEGS, granularity: 'section',
    });
    expect(chTasks).toHaveLength(1);
    /*
     * 反向验证：如果把缺省上限改回不分粒度的 10，这条变红 ——
     * 钉的是"小节级用 30 这个量级"（用户 11-22 选的），不是钉 15。
     */
    expect(secTasks).toHaveLength(15);
  });
});