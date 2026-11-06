import { describe, expect, it } from 'vitest';
import {
  MinerUError,
  needsConversion,
  parseMiddleJson,
} from './convert.ts';
import { summarize, toSegments } from './write-back.ts';

/**
 * 这些测试的核心是**页码 1:1 对应**。
 *
 * 用户的原话是「转换的文档要与原文件对应的转换页数一一相对，
 * 方便用户对照生成的文档是否有错误」。
 * 所以任何「跳过空页」「按数组下标编页」的行为都是 bug，
 * 而这类 bug 在界面上看不出来 —— 只有拿页码去比才发现错位。
 * 下面每条断言都在钉这件事。
 */

/** 造一份最简 middle_json（形状照 2026-11-06 本机 MinerU 4.1.7 实测输出） */
function makeRaw(pages: Array<{ idx: number; texts: string[] }>, pageCount?: number) {
  return {
    metadata: {
      producer: { name: 'mineru', version: '4.1.7' },
      document: { page_count: pageCount ?? pages.length },
    },
    extensions: { mineru: { tier: 'standard', parse_mode: 'ocr' } },
    pages: pages.map((p) => ({
      page_idx: p.idx,
      blocks: p.texts.map((t, i) => ({
        type: i === 0 ? 'paragraph_title' : 'text',
        index: i,
        bbox: [0.1, 0.1, 0.9, 0.2],
        content: [{ type: 'text', content: t }],
      })),
    })),
  };
}

describe('parseMiddleJson', () => {
  it('page_idx 从 0 开始，转成我们的 1-based 页码', () => {
    const r = parseMiddleJson(makeRaw([{ idx: 0, texts: ['第一页'] }, { idx: 1, texts: ['第二页'] }]));
    expect(r.pages[0]?.page).toBe(1);
    expect(r.pages[1]?.page).toBe(2);
    expect(r.pageCount).toBe(2);
  });

  it('页数与页码严格 1:1：空页占位，不让后面的页前移', () => {
    // 第 2 页是整页插图（MinerU 没给 blocks）
    const r = parseMiddleJson(
      makeRaw([
        { idx: 0, texts: ['第一页正文'] },
        { idx: 1, texts: [] },
        { idx: 2, texts: ['第三页正文'] },
      ]),
    );
    expect(r.pages).toHaveLength(3);
    expect(r.pages[1]?.text).toBe('');
    // 关键：第三页仍然是 page 3，不是 2
    expect(r.pages[2]?.page).toBe(3);
    expect(r.pages[2]?.text).toBe('第三页正文');
  });

  it('MinerU 跳页时按它给的页码建结果，不按数组下标', () => {
    // MinerU 漏了 page_idx 1，只给了 0 和 2
    const r = parseMiddleJson(
      makeRaw([
        { idx: 0, texts: ['第一页'] },
        { idx: 2, texts: ['第三页'] },
      ]),
    );
    expect(r.pageCount).toBe(3);
    expect(r.pages[1]?.text).toBe(''); // 补出来的空页
    expect(r.pages[2]?.text).toBe('第三页'); // 没有前移到第 2 页
  });

  it('metadata.page_count 比实际给的多时，以 metadata 为准补齐', () => {
    const r = parseMiddleJson(makeRaw([{ idx: 0, texts: ['只有一页有内容'] }], 5));
    expect(r.pageCount).toBe(5);
    expect(r.pages).toHaveLength(5);
    expect(r.pages[4]?.page).toBe(5);
    expect(r.pages[4]?.text).toBe('');
  });

  it('数组顺序被打乱时仍按 page_idx 排序', () => {
    const raw = makeRaw([
      { idx: 2, texts: ['三'] },
      { idx: 0, texts: ['一'] },
      { idx: 1, texts: ['二'] },
    ]);
    const r = parseMiddleJson(raw);
    expect(r.pages.map((p) => p.text)).toEqual(['一', '二', '三']);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it('如实带出 tier / parse_mode / 生产者版本', () => {
    const r = parseMiddleJson(makeRaw([{ idx: 0, texts: ['x'] }]));
    expect(r.tier).toBe('standard');
    expect(r.parseMode).toBe('ocr');
    expect(r.producer).toBe('4.1.7');
  });

  it('没有 pages 时报 bad-output，而不是静默返回空', () => {
    expect(() => parseMiddleJson({ metadata: {} })).toThrow(MinerUError);
    try {
      parseMiddleJson({ pages: [] });
    } catch (err) {
      expect((err as MinerUError).trouble).toBe('bad-output');
    }
  });

  it('非对象输入报错而不是崩在属性访问上', () => {
    expect(() => parseMiddleJson(null)).toThrow(MinerUError);
    expect(() => parseMiddleJson('字符串')).toThrow(MinerUError);
  });

  it('表格/公式块不进纯文本正文，但类型记在 kinds 里', () => {
    const raw = {
      metadata: { producer: { name: 'mineru', version: '4.1.7' }, document: { page_count: 1 } },
      extensions: { mineru: { tier: 'standard', parse_mode: 'ocr' } },
      pages: [
        {
          page_idx: 0,
          blocks: [
            { type: 'text', index: 0, content: [{ type: 'text', content: '正文一句' }] },
            // 表格块：content 是 HTML，不该塞进纯文本
            { type: 'table', index: 1, content: [{ type: 'text', content: '<table><tr><td>1</td></tr></table>' }] },
          ],
        },
      ],
    };
    const r = parseMiddleJson(raw);
    expect(r.pages[0]?.text).toBe('正文一句');
    expect(r.pages[0]?.kinds).toContain('table');
  });
});

describe('toSegments：与原文逐页对应', () => {
  it('段数等于页数，页号连续从 1 开始', () => {
    const r = parseMiddleJson(makeRaw([{ idx: 0, texts: ['a'] }, { idx: 1, texts: ['b'] }, { idx: 2, texts: ['c'] }]));
    const segs = toSegments(r);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it('空页也占一个段（关键：供用户对照原书）', () => {
    const r = parseMiddleJson(
      makeRaw([{ idx: 0, texts: ['a'] }, { idx: 1, texts: [] }, { idx: 2, texts: ['c'] }]),
    );
    const segs = toSegments(r);
    expect(segs).toHaveLength(3);
    expect(segs[1]?.text).toBe('');
    expect(segs[2]?.page).toBe(3);
  });

  it('页首是标题时用作 chapter', () => {
    const r = parseMiddleJson(makeRaw([{ idx: 0, texts: ['第一章 绪论', '正文'] }]));
    const segs = toSegments(r);
    expect(segs[0]?.chapter).toBe('第一章 绪论');
  });

  it('标题在页中间时不当作本章标题（不猜）', () => {
    const raw = {
      metadata: { producer: { name: 'mineru', version: '4.1.7' }, document: { page_count: 1 } },
      extensions: { mineru: { tier: 'standard', parse_mode: 'ocr' } },
      pages: [
        {
          page_idx: 0,
          blocks: [
            { type: 'text', index: 0, content: [{ type: 'text', content: '这一页开头是正文' }] },
            { type: 'paragraph_title', index: 1, content: [{ type: 'text', content: '中间的小标题' }] },
          ],
        },
      ],
    };
    const segs = toSegments(parseMiddleJson(raw));
    expect(segs[0]?.chapter).toBeNull();
  });
});

describe('summarize：如实汇报', () => {
  it('空页页码单独列出来', () => {
    const source = {
      id: 's1',
      title: '测试资料',
    } as Parameters<typeof summarize>[0];
    const r = parseMiddleJson(
      makeRaw([{ idx: 0, texts: ['a'] }, { idx: 1, texts: [] }, { idx: 2, texts: ['c'] }]),
    );
    const report = summarize(source, r, toSegments(r));
    expect(report.pageCount).toBe(3);
    expect(report.pagesWithText).toBe(2);
    expect(report.emptyPages).toEqual([2]);
    expect(report.tier).toBe('standard');
  });
});

describe('needsConversion：什么情况该走 MinerU', () => {
  it('扫描件要转', () => {
    expect(needsConversion('no-text-layer', 'pdf')).toBe(true);
  });

  it('解码失败也要转（是我们的问题，不是让用户换文件）', () => {
    expect(needsConversion('decode-failed', 'pdf')).toBe(true);
  });

  it('图片资料要转', () => {
    expect(needsConversion('ready', 'image')).toBe(true);
  });

  it('已经有文字层的不要转（白费时间）', () => {
    expect(needsConversion('ready', 'pdf')).toBe(false);
    expect(needsConversion('ready', 'text')).toBe(false);
  });
});
