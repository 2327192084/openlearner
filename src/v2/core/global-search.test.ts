import { describe, expect, it } from 'vitest';
import {
  hitToReaderTarget,
  searchAllSources,
  summarizeResult,
} from './global-search.ts';
import type { Source, SourceSegment } from '@/core/model.ts';

/**
 * 跨资料全文搜索（2026-11-20）。
 *
 * 核心要证的三件事：
 * 1. 一份资料里搜不到、但另一份里有 → 能找到（这是「跨资料」的意义）
 * 2. 匹配口径与单份搜索完全一致（忽略空白、跨行、大小写）——
 *    口径漂了的话，同一句话在阅读器里搜得到、在全局搜不到
 * 3. 没有正文的资料要**如实计入 skipped**，不能静默跳过
 */

function src(id: string, title: string): Source {
  /* 测试只关心 id/title，其余字段与本用例无关 —— 用 unknown 中转避免补一堆无关字段 */
  return {
    id,
    title,
    kind: 'text',
    pageCount: 10,
    textStatus: 'ready',
    createdAt: '',
    updatedAt: '',
    segmentCount: 1,
    readProgress: null,
  } as unknown as Source;
}

function seg(over: Partial<SourceSegment> & { sourceId: string; id: string }): SourceSegment {
  return {
    index: 1,
    page: 1,
    chapter: null,
    text: '',
    charCount: 0,
    ...over,
  } as SourceSegment;
}

describe('searchAllSources · 跨资料', () => {
  const sources = [src('s1', '高等数学'), src('s2', '信号与系统')];
  const segments = [
    seg({ id: 'a1', sourceId: 's1', index: 1, page: 16, text: '设 f 是映射，像唯一但原像不一定唯一。' }),
    seg({ id: 'b1', sourceId: 's2', index: 1, page: 9, text: '离散时间信号只在整数点有定义。' }),
  ];

  it('**在第二份资料里的内容也能搜到**（单份搜索做不到这条）', () => {
    const r = searchAllSources(sources, segments, '整数点');
    expect(r.total).toBe(1);
    expect(r.groups[0]!.sourceId).toBe('s2');
    expect(r.groups[0]!.sourceTitle).toBe('信号与系统');
  });

  it('**跨两份资料都命中时分成两组**，各带自己的标题', () => {
    /*
     * 「定」在两段里都有（一定 / 有定义）。
     * 第一版拿「不」当测试词，但第二段「离散时间信号只在整数点有定义」
     * 里根本没有「不」—— 测试自己写错了，不是代码问题。
     */
    const r = searchAllSources(sources, segments, '定');
    expect(r.sourceCount).toBe(2);
    expect(r.groups.map((g) => g.sourceTitle).sort()).toEqual(['信号与系统', '高等数学'].sort());
    expect(r.total).toBe(r.groups.reduce((n, g) => n + g.count, 0));
  });

  it('结果里每条都带 sourceId 与 sourceTitle（否则用户不知道是哪本书）', () => {
    const r = searchAllSources(sources, segments, '信');
    for (const g of r.groups) {
      for (const h of g.hits) {
        expect(h.sourceId).toBeTruthy();
        expect(h.sourceTitle).toBeTruthy();
      }
    }
  });
});

describe('searchAllSources · 匹配口径与单份搜索一致', () => {
  it('**跨行命中**（中文原文里有换行，搜索词没有空白）', () => {
    const s = [src('s1', '书')];
    const sg = [
      seg({ id: 'a', sourceId: 's1', text: '这句话被换行拆开：句\n后还有内容。' }),
    ];
    const r = searchAllSources(s, sg, '句后');
    expect(r.total).toBe(1);
    /* 偏移必须映射回原文坐标，能切出跨行的那几个字 */
    const h = r.groups[0]!.hits[0]!;
    expect(sg[0]!.text.slice(h.charStart, h.charEnd)).toBe('句\n后');
  });

  it('大小写不敏感（英文资料）', () => {
    const s = [src('s1', 'book')];
    const sg = [seg({ id: 'a', sourceId: 's1', text: 'The Algorithm is fast.' })];
    expect(searchAllSources(s, sg, 'algorithm').total).toBe(1);
    expect(searchAllSources(s, sg, 'ALGORITHM').total).toBe(1);
  });

  it('同一段里多处命中全部返回（不是只给第一个）', () => {
    const s = [src('s1', '书')];
    const sg = [seg({ id: 'a', sourceId: 's1', text: '映射是什么？映射就是一个对应关系。' })];
    const r = searchAllSources(s, sg, '映射');
    expect(r.total).toBe(2);
  });
});

describe('searchAllSources · 如实报告搜不了的资料', () => {
  it('**没有正文的资料计入 skippedSources**（不能静默跳过）', () => {
    const s = [src('s1', '有正文'), src('s2', '没正文')];
    const sg = [seg({ id: 'a', sourceId: 's1', text: '有内容的一段话。' })];
    const r = searchAllSources(s, sg, '内容');
    expect(r.skippedSources).toBe(1);
    expect(r.sourceCount).toBe(1);
  });

  /**
   * 这条是界面文案正确性的前提：
   * 用户搜不到东西时必须能分辨「真没有」和「这几份还没解析」。
   */
  it('搜不到但有跳过的资料时，摘要里说明这一点', () => {
    const s = [src('s1', '有正文'), src('s2', '没正文')];
    const sg = [seg({ id: 'a', sourceId: 's1', text: '有内容。' })];
    const r = searchAllSources(s, sg, '根本不存在的词');
    const msg = summarizeResult(r, '根本不存在的词');
    expect(msg).toContain('没有找到');
    expect(msg).toContain('1 份资料还没有正文');
  });

  it('搜不到且全部资料都有正文时，只说没找到', () => {
    const s = [src('s1', '书')];
    const sg = [seg({ id: 'a', sourceId: 's1', text: '有内容。' })];
    const r = searchAllSources(s, sg, '不存在');
    const msg = summarizeResult(r, '不存在');
    expect(msg).toContain('没有找到');
    expect(msg).not.toContain('没有正文');
  });
});

describe('searchAllSources · 边界', () => {
  const sources = [src('s1', '书')];
  const segments = [seg({ id: 'a', sourceId: 's1', text: '一些内容。' })];

  it('空搜索词返回空结果（不扫全库）', () => {
    for (const q of ['', '   ', '\n']) {
      const r = searchAllSources(sources, segments, q);
      expect(r.total).toBe(0);
      expect(r.groups).toEqual([]);
    }
  });

  it('**limit 生效**（防搜「的」这类高频词卡死界面）', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      seg({ id: 'a' + i, sourceId: 's1', index: i, page: i + 1, text: '的的的的的' }),
    );
    const r = searchAllSources(sources, many, '的', 20);
    expect(r.total).toBeLessThanOrEqual(20);
  });

  it('没有任何资料时返回空，不抛错', () => {
    const r = searchAllSources([], [], '任意');
    expect(r.total).toBe(0);
    expect(r.skippedSources).toBe(0);
  });

  it('片段带上下文（不是只有关键词本身）', () => {
    const s = [src('s1', '书')];
    const long = '前面有很多铺垫文字'.repeat(3) + '关键命中词' + '后面还有很多内容'.repeat(3);
    const sg = [seg({ id: 'a', sourceId: 's1', text: long })];
    const r = searchAllSources(s, sg, '关键命中词');
    const h = r.groups[0]!.hits[0]!;
    expect(h.snippet).toContain('关键命中词');
    expect(h.snippet.length).toBeGreaterThan('关键命中词'.length + 20);
  });
});

describe('hitToReaderTarget', () => {
  /**
   * 点搜索结果必须跳到**那句话**并标橙光，不是只跳页。
   * 这与昨晚做的「定位精确到句子」是同一条链路。
   */
  it('**带完整偏移与段 id**（阅读器据此圈到句子）', () => {
    const t = hitToReaderTarget({
      sourceId: 's1',
      sourceTitle: '书',
      segmentId: 'seg_a',
      page: 16,
      chapter: '第一章',
      charStart: 5,
      charEnd: 12,
      snippet: '…',
    });
    expect(t).toEqual({
      sourceId: 's1',
      page: 16,
      charStart: 5,
      charEnd: 12,
      segmentId: 'seg_a',
    });
  });
});

describe('summarizeResult', () => {
  it('有结果时给出「几处 / 几份资料」', () => {
    const s = [src('s1', '甲'), src('s2', '乙')];
    const sg = [
      seg({ id: 'a', sourceId: 's1', text: '映射映射' }),
      seg({ id: 'b', sourceId: 's2', text: '映射' }),
    ];
    const r = searchAllSources(s, sg, '映射');
    const msg = summarizeResult(r, '映射');
    expect(msg).toContain('3 处');
    expect(msg).toContain('2 份资料');
  });

  it('空搜索词返回空串（不显示「共 0 处」这种噪音）', () => {
    expect(summarizeResult({ groups: [], total: 0, sourceCount: 0, skippedSources: 0 }, '  ')).toBe('');
  });
});