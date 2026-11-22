import { describe, expect, it } from 'vitest';
import type { SourceOutline } from '@/v2/core/source-outline.ts';
import type { SubjectGuess } from '@/v2/core/subject-guess.ts';
import {
  attachSegments,
  buildRoutePrompt,
  parseSourceRoute,
  type ScopeInfo,
} from './source-route.ts';

/**
 * 依据资料本体规划路线（2026-11-21 深夜）。
 *
 * ## 这组测试守的是用户三条原话
 *
 * 1. 「规划的路线不能超出现有资料内容范围」
 *    → 提示词里写明 + 解析层机械拦截（两道都要验）
 * 2. 「有目录的资料，依据目录内容」
 *    → 提示词必须带上目录条目
 * 3. 「没有目录的资料，可以询问用户资料涉及的科目」
 *    → 提示词必须说明「没有目录」并禁止编造章号
 *
 * ## 重点在「模型不听话时怎么办」
 *
 * 提示词是软约束。用户点名的那条边界必须是**硬的** ——
 * 所以解析层要能丢掉越界的步骤，并且这条要被测到。
 */

const outlineToc: SourceOutline = {
  kind: 'toc-page',
  entries: ['第1章 函数与极限', '第2章 导数与微分', '第3章 微分中值定理'],
  tocAt: 1,
  maxChapterNumber: 3,
  chapterNumbers: [1, 2, 3],
  contentChapterNumbers: [1],
};

const outlineNone: SourceOutline = {
  kind: 'none',
  entries: [],
  tocAt: null,
  maxChapterNumber: 0,
  chapterNumbers: [],
  contentChapterNumbers: [],
};

const subject: SubjectGuess = {
  id: 'advanced-math',
  name: '高等数学',
  source: 'title',
  evidence: '标题里写着「高等数学」',
  edition: '第7版·同济大学数学系',
};

/** 只覆盖第 1 章的范围（用户点名的那个场景） */
const scopeCh1: ScopeInfo = {
  chapters: [1],
  sourceTitle: '高等数学 第7版 上',
  chapterBySegment: new Map([['seg-1', 1], ['seg-2', 1], ['seg-3', null]]),
};

/** 没有章号概念的范围 */
const scopeNoChapter: ScopeInfo = {
  chapters: null,
  sourceTitle: '课程知识点一',
  chapterBySegment: new Map([['seg-1', null]]),
};

describe('buildRoutePrompt：三条硬约束都要写进提示词', () => {
  it('⚠️ 明确写「范围只到第 N 章」（用户第 1 条要求）', () => {
    const { system } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: null,
    });
    expect(system).toContain('只覆盖第 1 章');
    expect(system).toContain('绝对不能');
    expect(system).toContain('beyond');
  });

  it('⚠️ 有目录时把目录条目带进 user（用户第 2 条要求）', () => {
    const { user } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: null,
    });
    expect(user).toContain('第1章 函数与极限');
    expect(user).toContain('第2章 导数与微分');
    expect(user).toContain('作者写的结构');
  });

  it('⚠️ 没有目录时明确说「不要编造章号」（用户第 3 条要求）', () => {
    const { system, user } = buildRoutePrompt({
      subject,
      outline: outlineNone,
      scope: scopeNoChapter,
      search: null,
    });
    expect(system + user).toContain('没有可用的章节结构');
    expect(user).toContain('没有目录');
    expect(user).toContain('不要编造章号');
  });

  it('要求 basis 如实标注依据来源（不能假装都是 toc）', () => {
    const { system } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: null,
    });
    expect(system).toContain('basis');
    expect(system).toContain('toc');
    expect(system).toContain('search');
    expect(system).toContain('model');
    expect(system).toContain('不要为了让路线好看而假装');
  });

  it('难度说明写清「与掌握度无关」', () => {
    const { system } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: null,
    });
    expect(system).toContain('与学员掌握得怎样无关');
  });

  it('带上学科与版本（检索与规划都要用）', () => {
    const { user } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: null,
    });
    expect(user).toContain('高等数学');
    expect(user).toContain('第7版');
  });

  it('没联网时如实说明「这次没有联网检索」', () => {
    const { user } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: { searched: false, hits: [], note: '没有配置搜索 API Key' },
    });
    expect(user).toContain('这次没有联网检索');
    expect(user).toContain('没有配置搜索 API Key');
  });

  it('联网成功时带上检索结果，并标注为外部数据', () => {
    const { user } = buildRoutePrompt({
      subject,
      outline: outlineToc,
      scope: scopeCh1,
      search: {
        searched: true,
        hits: [{ title: '同济高数第七版目录', snippet: '第一章 函数与极限' }],
        note: '',
      },
    });
    expect(user).toContain('同济高数第七版目录');
    expect(user).toContain('外部数据');
  });
});

describe('parseSourceRoute：范围校验（用户点名的硬边界）', () => {
  it('⚠️⚠️ 越界的章号必须被丢掉（资料只到第 1 章，模型排了第 2 章）', () => {
    /*
     * 这条例子的场景就是用户原话：
     * > 用户学习高等数学，但资料只解析/涉及了第一章，
     * > 但路线规划却规划了第一章后的内容
     *
     * 提示词里已经说了不许，但模型不一定听。解析层必须机械拦掉。
     */
    const content = JSON.stringify({
      blocks: [
        {
          title: '基础',
          why: '先学开头',
          steps: [
            { chapterNumber: 1, title: '第1章 函数与极限', difficulty: 2, reason: '起点', basis: 'toc' },
            { chapterNumber: 2, title: '第2章 导数与微分', difficulty: 3, reason: '下一步', basis: 'model' },
            { chapterNumber: 3, title: '第3章 微分中值定理', difficulty: 4, reason: '更难', basis: 'model' },
          ],
        },
      ],
    });

    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const allSteps = r.route.blocks.flatMap((b) => b.steps);
    expect(allSteps).toHaveLength(1);
    expect(allSteps[0]!.chapterNumber).toBe(1);
    expect(r.dropped).toBe(2);
    expect(r.route.droppedOutOfScope).toBe(2);
  });

  it('⚠️ 全部越界时整轮失败（不是返回一条空路线当成功）', () => {
    const content = JSON.stringify({
      blocks: [
        {
          title: 'x',
          steps: [
            { chapterNumber: 2, title: '第2章', basis: 'model' },
            { chapterNumber: 3, title: '第3章', basis: 'model' },
          ],
        },
      ],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('没有任何一步落在资料范围内');
  });

  it('⚠️ 有范围的资料里，缺章号的步骤也丢掉（很可能自己编的）', () => {
    const content = JSON.stringify({
      blocks: [
        {
          title: 'x',
          steps: [
            { title: '没有章号的一步', basis: 'model' },
            { chapterNumber: 1, title: '第1章', basis: 'toc' },
          ],
        },
      ],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route.blocks.flatMap((b) => b.steps)).toHaveLength(1);
      expect(r.dropped).toBe(1);
    }
  });

  it('没有章号概念的资料不按章号挡（scope.chapters = null）', () => {
    const content = JSON.stringify({
      blocks: [
        {
          title: 'x',
          steps: [
            { title: '安全生产的定义', basis: 'toc' },
            { title: '事故等级划分', basis: 'toc' },
          ],
        },
      ],
    });
    const r = parseSourceRoute(content, scopeNoChapter, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.blocks.flatMap((b) => b.steps)).toHaveLength(2);
  });
});

describe('parseSourceRoute：beyond 如实告知资料外内容', () => {
  it('beyond 被保留（资料只到第 1 章时，后续章节该告诉他）', () => {
    const content = JSON.stringify({
      blocks: [
        { title: '基础', steps: [{ chapterNumber: 1, title: '第1章 函数与极限', basis: 'toc' }] },
      ],
      beyond: [{ title: '第2章 导数与微分', note: '按常规进度这是下一步，但这份资料没有' }],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.beyond).toHaveLength(1);
    expect(r.route.beyond[0]!.title).toContain('第2章');
  });

  it('beyond 缺失时不崩（空数组）', () => {
    const content = JSON.stringify({
      blocks: [{ title: 'x', steps: [{ chapterNumber: 1, title: '第1章', basis: 'toc' }] }],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.beyond).toEqual([]);
  });
});

describe('parseSourceRoute：整轮拒绝', () => {
  it('截断 JSON 整轮拒绝（不修补括号）', () => {
    const content = '{"blocks":[{"title":"基础","steps":[{"chapterNumber":1,"title":"第1章"}]}';
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不完整');
  });

  it('没有 blocks 数组拒绝', () => {
    const r = parseSourceRoute('{"steps":[]}', scopeCh1, subject, false);
    expect(r.ok).toBe(false);
  });

  it('空内容拒绝', () => {
    const r = parseSourceRoute('', scopeCh1, subject, false);
    expect(r.ok).toBe(false);
  });

  it('带 markdown 围栏也能解析', () => {
    const content =
      '结果如下：\n```json\n{"blocks":[{"title":"基础","steps":[{"chapterNumber":1,"title":"第1章","basis":"toc"}]}]}\n```';
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
  });
});

describe('parseSourceRoute：字段归一', () => {
  it('⚠️ 不认识的 basis 归到 model（最保守，不能假装有目录依据）', () => {
    const content = JSON.stringify({
      blocks: [
        { title: 'x', steps: [{ chapterNumber: 1, title: '第1章', basis: '因为我猜的' }] },
      ],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.blocks[0]!.steps[0]!.basis).toBe('model');
  });

  it('难度越界置 null（不夹边界值）', () => {
    const content = JSON.stringify({
      blocks: [
        { title: 'x', steps: [{ chapterNumber: 1, title: '第1章', basis: 'toc', difficulty: 99 }] },
      ],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.blocks[0]!.steps[0]!.difficulty).toBeNull();
  });

  it('缺标题的步骤丢掉', () => {
    const content = JSON.stringify({
      blocks: [{ title: 'x', steps: [{ chapterNumber: 1, basis: 'toc' }] }],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(false);
  });

  it('块没标题时用「第 N 块」兜底', () => {
    const content = JSON.stringify({
      blocks: [{ steps: [{ chapterNumber: 1, title: '第1章', basis: 'toc' }] }],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.blocks[0]!.title).toBe('第 1 块');
  });

  it('usedSearch 如实记录', () => {
    const content = JSON.stringify({
      blocks: [{ title: 'x', steps: [{ chapterNumber: 1, title: '第1章', basis: 'search' }] }],
    });
    const r = parseSourceRoute(content, scopeCh1, subject, true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.usedSearch).toBe(true);
  });
});

describe('attachSegments：证明「依据资料本体」是可验证的', () => {
  it('按章号回填对应的段 id', () => {
    const route = {
      subject: '高等数学',
      edition: '',
      blocks: [
        {
          title: '基础',
          why: '',
          steps: [
            {
              chapterNumber: 1, title: '第1章', difficulty: 2, reason: '', basis: 'toc' as const,
              segmentIds: [], sections: [], prerequisites: [], prereqReason: '',
            },
          ],
        },
      ],
      beyond: [],
      usedSearch: false,
      droppedOutOfScope: 0,
    };
    const out = attachSegments(route, scopeCh1);
    expect(out.blocks[0]!.steps[0]!.segmentIds).toEqual(['seg-1', 'seg-2']);
  });

  it('⚠️ 章节对不上的步骤留空数组（界面要如实说「资料里没有直接对应」）', () => {
    const route = {
      subject: 'x',
      edition: '',
      blocks: [
        {
          title: 'x',
          why: '',
          steps: [
            {
              chapterNumber: 9, title: '第9章', difficulty: null, reason: '', basis: 'model' as const,
              segmentIds: [], sections: [], prerequisites: [], prereqReason: '',
            },
          ],
        },
      ],
      beyond: [],
      usedSearch: false,
      droppedOutOfScope: 0,
    };
    const out = attachSegments(route, scopeCh1);
    expect(out.blocks[0]!.steps[0]!.segmentIds).toEqual([]);
  });
});
describe('小节与前置关系（2026-11-22 下午，方案第 3 步）', () => {
  /**
   * AI 现在要额外给两样东西：
   *  - `sections`：这一章分几个小节，每节带一句**原文片段**
   *  - `prerequisites`：需要先学哪几章（只提醒不锁）
   *
   * 解析层要做的校验是方案第九节点名要求的：
   * 越界章号丢弃、自引用丢弃、不存在的章号丢弃。
   */

  const scope = {
    chapters: [1, 2],
    sourceTitle: '信号与系统',
    chapterBySegment: new Map<string, number | null>([
      ['seg-1', 1],
      ['seg-2', 1],
      ['seg-3', 2],
    ]),
  };

  /** 造一个含指定字段的模型返回 */
  function payload(steps: unknown[]): string {
    return JSON.stringify({
      blocks: [{ title: '基础', why: '打基础', steps }],
    });
  }

  function parse(content: string) {
    return parseSourceRoute(content, scope, { name: '信号与系统', edition: '' }, false);
  }

  it('解析出 sections（title + quote 都留）', () => {
    const r = parse(
      payload([
        {
          chapterNumber: 1,
          title: '第1章',
          sections: [
            { title: '1.1 连续时间信号', quote: '连续时间信号在时间上是连续的' },
            { title: '1.2 离散时间信号', quote: '离散时间信号只在离散时刻有定义' },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secs = r.route.blocks[0]!.steps[0]!.sections;
    expect(secs).toHaveLength(2);
    expect(secs[0]!.title).toBe('1.1 连续时间信号');
    expect(secs[0]!.quote).toContain('连续时间信号');
  });

  it('⚠️ 没有 quote 的小节被丢掉（没法回填段 id，留着更糟）', () => {
    const r = parse(
      payload([
        {
          chapterNumber: 1,
          title: '第1章',
          sections: [
            { title: '1.1 有依据', quote: '原句' },
            { title: '1.2 没依据', quote: '' },
            { title: '1.3 也没', quote: '   ' },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[0]!.sections.map((s) => s.title)).toEqual(['1.1 有依据']);
  });

  it('sections 缺字段 / 不是数组 → 空数组（旧模型不返回这字段也不崩）', () => {
    const r = parse(payload([{ chapterNumber: 1, title: '第1章' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[0]!.sections).toEqual([]);
  });

  it('重复标题的小节只留第一个', () => {
    const r = parse(
      payload([
        {
          chapterNumber: 1,
          title: '第1章',
          sections: [
            { title: '1.1 甲', quote: 'a' },
            { title: '1.1 甲', quote: 'b' },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[0]!.sections).toHaveLength(1);
  });

  it('解析出 prerequisites（有效章号留下）', () => {
    const r = parse(
      payload([
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章', prerequisites: [1], prereqReason: '第2章要用第1章' },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[1]!.prerequisites).toEqual([1]);
    expect(r.route.blocks[0]!.steps[1]!.prereqReason).toContain('第1章');
  });

  it('⚠️ 不存在的章号被丢弃（方案第九节的硬要求）', () => {
    const r = parse(
      payload([
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章', prerequisites: [7, 99], prereqReason: '编的' },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[1]!.prerequisites).toEqual([]);
  });

  it('⚠️ 自引用被丢弃', () => {
    const r = parse(
      payload([{ chapterNumber: 2, title: '第2章', prerequisites: [2], prereqReason: '废话' }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[0]!.prerequisites).toEqual([]);
  });

  it('一个有效一个无效 → 只留有效的', () => {
    const r = parse(
      payload([
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章', prerequisites: [1, 88] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[1]!.prerequisites).toEqual([1]);
  });

  it('重复前置去重、并按章号升序', () => {
    const r = parse(
      payload([
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章', prerequisites: [1, 1] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[1]!.prerequisites).toEqual([1]);
  });

  it('prerequisites 是字符串数字也能认', () => {
    const r = parse(
      payload([
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章', prerequisites: ['1'] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.blocks[0]!.steps[1]!.prerequisites).toEqual([1]);
  });

  it('没有章节范围（chapters=null）时不按章号过滤，但自引用仍丢', () => {
    const noScope = {
      chapters: null,
      sourceTitle: 'x',
      chapterBySegment: new Map<string, number | null>([['seg-1', null]]),
    };
    const r = parseSourceRoute(
      payload([{ chapterNumber: 5, title: '第5章', prerequisites: [3, 5] }]),
      noScope,
      { name: 'x', edition: '' },
      false,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* 3 留下（没范围就没法判越界），5 自引用丢掉 */
    expect(r.route.blocks[0]!.steps[0]!.prerequisites).toEqual([3]);
  });

  it('⚠️ 提示词里真的要求了小节与前置（不是只改了解析层）', () => {
    const { system } = buildRoutePrompt({
      subject: { name: '信号与系统', edition: '', evidence: '', source: 'title' } as never,
      outline: { kind: 'none', entries: [], chapterNumbers: [], tocSegmentIds: [] } as never,
      scope,
      search: null,
    });
    expect(system).toContain('sections');
    expect(system).toContain('quote');
    expect(system).toContain('prerequisites');
    /* 必须明确"只写真的需要先学的"，否则模型会把所有前章都列上 */
    expect(sysMatch(system, '不要把前面所有章都列成前置')).toBe(true);
  });
});

/** 小工具：断言文本包含（避免在上面的 it 里写长断言） */
function sysMatch(text: string, needle: string): boolean {
  return text.indexOf(needle) >= 0;
}
