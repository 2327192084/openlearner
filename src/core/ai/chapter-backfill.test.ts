import { describe, expect, it } from 'vitest';
import {
  buildChapterPreview,
  buildChapterPrompt,
  collectKnownChapters,
  normalizeChapterName,
  parseChapterSuggestions,
  toChapterCandidates,
  type ChapterCandidate,
} from './chapter-backfill.ts';
import type { KnowledgePoint } from '../model.ts';

/**
 * AI 补章节的纯逻辑（2026-11-21）。
 *
 * ## 这组测试盯的是「不许污染用户数据」
 *
 * 补章节要写 `KnowledgePoint.chapter` —— 那是用户自己的知识库内容。
 * 一个假章节名会一直留在他库里，以后按章节筛选/排序都带着它。
 * 所以重点全在**拒绝**：
 *  - 模型编的分组名（「基础篇」）必须被挡掉
 *  - 只补空章节，已有的一律不动
 *  - 判不出来时宁可不补
 */

function kp(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp-1',
    statement: '默认表述',
    chapter: null,
    cognitiveLevel: 'understand',
    tags: [],
    anchors: [],
    quotes: [],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: 'src-1',
    backendId: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as KnowledgePoint;
}

function cand(over: Partial<ChapterCandidate> = {}): ChapterCandidate {
  return {
    id: 'kp-1',
    statement: '导数的定义是差商的极限',
    chapter: null,
    sourceId: 'src-1',
    ...over,
  };
}

describe('normalizeChapterName', () => {
  it('中文数字与阿拉伯数字归一（「第三章」== 「第3章」）', () => {
    /*
     * 用户库里两种写法都出现过。不归一的话，
     * 「已知章节有第3章」而模型写「第三章」会被误判成编造。
     */
    expect(normalizeChapterName('第三章')).toBe(normalizeChapterName('第3章'));
  });

  it('十以上的中文数字也能转', () => {
    expect(normalizeChapterName('第十一章')).toBe(normalizeChapterName('第11章'));
    expect(normalizeChapterName('第二十三章')).toBe(normalizeChapterName('第23章'));
  });

  it('去掉所有空白（模型爱加空格）', () => {
    expect(normalizeChapterName(' 第 3 章  极限 ')).toBe(normalizeChapterName('第3章极限'));
  });
});

describe('toChapterCandidates', () => {
  it('只收 chapter 为 null 的', () => {
    const points = [
      kp({ id: 'a', chapter: null }),
      kp({ id: 'b', chapter: '第1章' }),
      kp({ id: 'c', chapter: '   ' }),
    ];
    const out = toChapterCandidates(points);
    /* 空串也算「没有章节」 */
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('空列表返回空数组', () => {
    expect(toChapterCandidates([])).toEqual([]);
  });
});

describe('collectKnownChapters', () => {
  it('按资料收集已有章节名，去重保序', () => {
    const points = [
      kp({ id: 'a', chapter: '第1章 函数', sourceId: 's1' }),
      kp({ id: 'b', chapter: '第1章 函数', sourceId: 's1' }),
      kp({ id: 'c', chapter: '第2章 极限', sourceId: 's1' }),
      kp({ id: 'd', chapter: '导论', sourceId: 's2' }),
    ];
    const m = collectKnownChapters(points);
    expect(m.get('s1')).toEqual(['第1章 函数', '第2章 极限']);
    expect(m.get('s2')).toEqual(['导论']);
  });

  it('归一化后相同的只留第一次的写法', () => {
    const points = [
      kp({ id: 'a', chapter: '第3章 导数', sourceId: 's1' }),
      kp({ id: 'b', chapter: '第三章 导数', sourceId: 's1' }),
    ];
    const m = collectKnownChapters(points);
    expect(m.get('s1')).toEqual(['第3章 导数']);
  });

  it('没有章节的知识点不产生条目', () => {
    const m = collectKnownChapters([kp({ chapter: null })]);
    expect(m.size).toBe(0);
  });
});

describe('buildChapterPrompt', () => {
  it('把已有章节名告诉模型（这是防编造的关键）', () => {
    const known = new Map([['src-1', ['第1章 函数', '第2章 极限']]]);
    const { user } = buildChapterPrompt([cand()], known);
    expect(user).toContain('第1章 函数');
    expect(user).toContain('第2章 极限');
  });

  it('提示词要求「判不出来就留空，不要编」', () => {
    const { system } = buildChapterPrompt([cand()], new Map());
    expect(system).toContain('判不出来就留空');
    expect(system).toContain('绝对不要编');
    expect(system).toContain('不要为了填满');
  });

  it('用编号不用 id', () => {
    const { user } = buildChapterPrompt([cand({ id: 'kp-secret' })], new Map());
    expect(user).toContain('1. 导数的定义是差商的极限');
    expect(user).not.toContain('kp-secret');
  });

  it('资料没有已有章节时如实说，不给模型编格式的借口', () => {
    const { user } = buildChapterPrompt([cand()], new Map());
    expect(user).toContain('还没有任何章节名');
  });
});

describe('parseChapterSuggestions：可信性', () => {
  const candidates = [cand({ id: 'kp-1' }), cand({ id: 'kp-2', statement: '第二条' })];
  const known = new Map([['src-1', ['第1章 函数', '第2章 极限']]]);

  it('沿用已有章节名 → fromExisting=true，且用库里原始写法', () => {
    /*
     * 模型写「第二章 极限」而库里是「第2章 极限」：
     * 归一化后相同，应当采用**库里那个写法**，不要模型改过的版本。
     */
    const content = '{"assign":[{"n":1,"chapter":"第二章 极限","reason":"讲极限"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.chapter).toBe('第2章 极限');
    expect(r.suggestions[0]!.fromExisting).toBe(true);
  });

  it('可识别格式的新章节名 → 接受但标 fromExisting=false（界面要提示复核）', () => {
    const content = '{"assign":[{"n":1,"chapter":"第3章 导数与微分","reason":"讲导数"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions[0]!.chapter).toBe('第3章 导数与微分');
    expect(r.suggestions[0]!.fromExisting).toBe(false);
  });

  it('⚠️ 自造分组名（「基础篇」）必须丢弃 —— 这是防污染用户库的核心', () => {
    /*
     * 模型很容易为了填满而造几个听起来合理的名字。
     * 写进用户库以后，他的知识点就有一个凭空的「基础篇」。
     */
    const content = '{"assign":[{"n":1,"chapter":"基础篇","reason":"x"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it('「重点内容」「核心概念」这类也丢弃', () => {
    const content =
      '{"assign":[{"n":1,"chapter":"重点内容"},{"n":2,"chapter":"核心概念"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(0);
    expect(r.dropped).toBe(2);
  });

  it('「3.1 极限的定义」这种编号格式接受', () => {
    const content = '{"assign":[{"n":1,"chapter":"3.1 极限的定义"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestions[0]!.chapter).toBe('3.1 极限的定义');
  });

  it('「模块二」「单元 3」这类接受', () => {
    const content = '{"assign":[{"n":1,"chapter":"模块二"},{"n":2,"chapter":"单元 3"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestions).toHaveLength(2);
  });

  it('空章节名丢弃', () => {
    const content = '{"assign":[{"n":1,"chapter":"   "}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});

describe('parseChapterSuggestions：编号校验', () => {
  const candidates = [cand({ id: 'kp-1' }), cand({ id: 'kp-2' })];
  const known = new Map([['src-1', ['第1章 函数']]]);

  it('编号越界丢弃', () => {
    const content = '{"assign":[{"n":9,"chapter":"第1章 函数"},{"n":1,"chapter":"第1章 函数"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.pointId).toBe('kp-1');
    expect(r.dropped).toBe(1);
  });

  it('重复编号只认第一次', () => {
    const content =
      '{"assign":[{"n":1,"chapter":"第1章 函数"},{"n":1,"chapter":"第2章 导数"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.chapter).toBe('第1章 函数');
    expect(r.dropped).toBe(1);
  });

  it('n 是字符串也认', () => {
    const content = '{"assign":[{"n":"1","chapter":"第1章 函数"}]}';
    const r = parseChapterSuggestions(content, candidates, known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestions).toHaveLength(1);
  });
});

describe('parseChapterSuggestions：整轮拒绝', () => {
  const candidates = [cand()];
  const known = new Map([['src-1', ['第1章 函数']]]);

  it('截断 JSON 整轮拒绝（不修补）', () => {
    const r = parseChapterSuggestions('{"assign":[{"n":1,"chapter":"第1章', candidates, known);
    expect(r.ok).toBe(false);
  });

  it('没有 assign 数组拒绝', () => {
    const r = parseChapterSuggestions('{"list":[]}', candidates, known);
    expect(r.ok).toBe(false);
  });

  it('空内容拒绝', () => {
    const r = parseChapterSuggestions('', candidates, known);
    expect(r.ok).toBe(false);
  });

  it('没有候选时拒绝', () => {
    const r = parseChapterSuggestions('{"assign":[]}', [], known);
    expect(r.ok).toBe(false);
  });

  it('⚠️ 模型一条都不给**不是失败**（提示词允许「判不出来就留空」）', () => {
    /*
     * 这是本模块与 parsePlanOrder 的一处刻意不同：
     * 排顺序时「一条都没排」说明结果不可信；
     * 补章节时「一条都不补」是完全合法的答案 —— 模型遵守了「不要编」。
     */
    const r = parseChapterSuggestions('{"assign":[]}', candidates, known);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.suggestions).toHaveLength(0);
      expect(r.dropped).toBe(0);
    }
  });
});

describe('buildChapterPreview', () => {
  it('只列会被改动的条目，且 from 恒为 null', () => {
    const candidates = [
      cand({ id: 'kp-1', statement: '一', chapter: null }),
      cand({ id: 'kp-2', statement: '二', chapter: null }),
      cand({ id: 'kp-3', statement: '三', chapter: null }),
    ];
    const suggestions = [
      { pointId: 'kp-1', chapter: '第1章', reason: 'x', fromExisting: true },
    ];
    const preview = buildChapterPreview(candidates, suggestions, 2);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]!.from).toBeNull();
    expect(preview.changes[0]!.to).toBe('第1章');
    expect(preview.untouched).toBe(2);
    expect(preview.dropped).toBe(2);
  });

  it('⚠️ 已有章节的知识点即使被建议也不改动', () => {
    /*
     * 本模块只补空章节。已经有章节的是用户/上次整理的结果，
     * 覆盖它等于擅自改写用户的数据。
     */
    const candidates = [cand({ id: 'kp-1', chapter: '第9章 我写的' })];
    const suggestions = [{ pointId: 'kp-1', chapter: '第1章', reason: '', fromExisting: true }];
    const preview = buildChapterPreview(candidates, suggestions);
    expect(preview.changes).toHaveLength(0);
  });

  it('建议里出现清单外的 id 时忽略（不崩）', () => {
    const preview = buildChapterPreview(
      [cand({ id: 'kp-1' })],
      [{ pointId: 'kp-999', chapter: '第1章', reason: '', fromExisting: true }],
    );
    expect(preview.changes).toHaveLength(0);
  });
});