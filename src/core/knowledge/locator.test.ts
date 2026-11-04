import { describe, expect, it } from 'vitest';
import { findQuoteInText, locateQuote, locateQuotes } from './locator.ts';
import type { SourceSegment } from '../model.ts';

/**
 * 定位器测试 —— P2 里最要紧的一组。
 *
 * 计划书第 7 节：「抽查最关键的一条：任意一条知识点／一道题／一个 PPT 角标，
 * 点回原文是否真的落在正确位置。指错页比不能跳转更糟，因为它冒充可信。」
 *
 * 所以这里不测「能找到大概位置」，而测：
 *   - 找到的位置**必须精确**（切片还原后逐字相等）
 *   - 找不到时**必须返回空**，不能凑一个
 */

function seg(page: number, text: string, chapter: string | null = null): SourceSegment {
  return {
    id: `seg_${page}`,
    sourceId: 'src_1',
    index: page,
    page,
    chapter,
    text,
    charCount: text.length,
  };
}

const SEGMENTS: SourceSegment[] = [
  seg(
    1,
    '第一章 数据结构绪论\n\n数据结构研究的是数据元素之间的关系以及在这些关系上的操作。\n\n逻辑结构分为线性结构与非线性结构两大类。',
    '第一章 数据结构绪论',
  ),
  seg(
    2,
    '第二章 线性表\n\n线性表是由 n 个数据元素构成的有限序列，n 称为表长。\n\n顺序表用一段地址连续的存储单元依次存放元素，支持随机访问。',
    '第二章 线性表',
  ),
  seg(
    3,
    '第三章 栈与队列\n\n栈是只允许在一端进行插入和删除的线性表，遵循后进先出原则。\n\n循环队列用取模运算把顺序存储的首尾相接，解决了假溢出的问题。',
    '第三章 栈与队列',
  ),
];

describe('精确匹配', () => {
  it('整句引用能定位到正确页', () => {
    const result = locateQuote(SEGMENTS, '线性表是由 n 个数据元素构成的有限序列', 'src_1');

    expect(result.located).toBe(true);
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0].page).toBe(2);
    expect(result.anchors[0].sourceId).toBe('src_1');
  });

  it('偏移能精确切回原文（这是高亮的前提）', () => {
    const quote = '循环队列用取模运算把顺序存储的首尾相接';
    const result = locateQuote(SEGMENTS, quote, 'src_1');
    const anchor = result.anchors[0];

    const segText = SEGMENTS.find((s) => s.page === anchor.page)!.text;
    // 关键断言：按存下来的偏移切片，必须逐字等于引用
    expect(segText.slice(anchor.charStart!, anchor.charEnd!)).toBe(quote);
  });

  it('chapter 会一并带上，便于界面上标注来源章节', () => {
    const result = locateQuote(SEGMENTS, '栈是只允许在一端进行插入和删除的线性表', 'src_1');
    expect(result.anchors[0].chapter).toBe('第三章 栈与队列');
  });

  it('同一句话多处出现时取第一处', () => {
    const dup: SourceSegment[] = [
      seg(1, '第一段里重复出现的一句话：这是需要定位的原文内容。'),
      seg(2, '第二段里重复出现的一句话：这是需要定位的原文内容。'),
    ];
    const result = locateQuote(dup, '这是需要定位的原文内容', 'src_1');

    // 取第一处：学生按顺序读，第一次出现最符合直觉
    expect(result.located).toBe(true);
    expect(result.anchors[0].page).toBe(1);
  });
});

describe('空白差异容错（PDF 折行常见）', () => {
  it('引用里的空格数量与原文不同也能命中', () => {
    const result = locateQuote(SEGMENTS, '线性表是由 n  个数据元素', 'src_1');
    expect(result.located).toBe(true);
  });

  it('跨段内换行的引用能命中', () => {
    const withBreak = [seg(1, '逻辑结构分为线性结构\n与非线性结构两大类。')];
    const result = locateQuote(withBreak, '线性结构与非线性结构两大类', 'src_1');
    expect(result.located).toBe(true);
  });

  it('空白归一时偏移仍对应原文，不会越界', () => {
    // 用有区分度的短语：少于 4 字会被判为「引用不够用」（见 MIN_QUOTE_LENGTH）
    const text = '甲段内容  乙段内容\n丙段内容 丁段内容';
    const s = [seg(1, text)];
    const result = locateQuote(s, '乙段内容 丙段内容', 'src_1');

    expect(result.located).toBe(true);
    const a = result.anchors[0];
    const sliced = text.slice(a.charStart!, a.charEnd!);
    expect(sliced).toContain('乙段内容');
    expect(sliced).toContain('丙段内容');
  });
});

describe('模型常见修饰的容错', () => {
  it('引用被引号包住也能命中', () => {
    const result = locateQuote(SEGMENTS, '「线性表是由 n 个数据元素构成的有限序列」', 'src_1');
    expect(result.located).toBe(true);
  });

  it('引用末尾带省略号也能命中', () => {
    const result = locateQuote(SEGMENTS, '栈是只允许在一端进行插入和删除的线性表……', 'src_1');
    expect(result.located).toBe(true);
  });

  it('带「原文：」前缀也能命中', () => {
    const result = locateQuote(SEGMENTS, '原文：循环队列用取模运算把顺序存储的首尾相接', 'src_1');
    expect(result.located).toBe(true);
  });

  it('长引用头尾各带一点噪声时仍能定位', () => {
    const long =
      '根据教材的说明，顺序表用一段地址连续的存储单元依次存放元素，支持随机访问，这一点很重要';
    const result = locateQuote(SEGMENTS, long, 'src_1');
    expect(result.located).toBe(true);
    expect(result.anchors[0].page).toBe(2);
  });
});

describe('定位失败：必须返回空，绝不凑位置', () => {
  it('原文里没有的内容返回 located=false 且 anchors 为空', () => {
    const result = locateQuote(SEGMENTS, '这句话在教材里根本不存在', 'src_1');

    // 这是整个设计的关键：宁可留空等人处理，也不给一个错的位置
    expect(result.located).toBe(false);
    expect(result.anchors).toEqual([]);
  });

  it('模型编造的页码不会被采信（我们根本不读它的页码）', () => {
    const result = locateQuote(SEGMENTS, '线性表是由 n 个数据元素构成的有限序列', 'src_1');
    // 真实页是 2，不是任何外部声明
    expect(result.anchors[0].page).toBe(2);
  });

  it('空引用直接判失败', () => {
    expect(locateQuote(SEGMENTS, '', 'src_1').located).toBe(false);
    expect(locateQuote(SEGMENTS, '   ', 'src_1').located).toBe(false);
  });

  it('过短的引用不匹配（避免"的""数据"这种词命中到处都是）', () => {
    // 1~3 字在教材里几乎必然多次出现，匹配到哪一处都没说服力
    expect(locateQuote(SEGMENTS, '的', 'src_1').located).toBe(false);
    expect(locateQuote(SEGMENTS, '数据', 'src_1').located).toBe(false);
    expect(locateQuote(SEGMENTS, '线性表', 'src_1').located).toBe(false);
    // 4 字起才算有区分度
    expect(locateQuote(SEGMENTS, '随机访问', 'src_1').located).toBe(true);
  });

  it('改动一个字就找不到（不做模糊匹配）', () => {
    const result = locateQuote(SEGMENTS, '线性表是由 m 个数据元素构成的有限序列', 'src_1');
    expect(result.located).toBe(false);
  });
});

describe('多条引用', () => {
  it('全部命中才算 located', () => {
    const result = locateQuotes(
      SEGMENTS,
      ['数据结构研究的是数据元素之间的关系', '非线性结构两大类'],
      'src_1',
    );

    expect(result.located).toBe(true);
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors.map((a) => a.page)).toEqual([1, 1]);
  });

  it('有一条找不到就整体判失败', () => {
    const result = locateQuotes(
      SEGMENTS,
      ['数据结构研究的是数据元素之间的关系', '这段话不存在'],
      'src_1',
    );

    // 只找到一半说明模型对这条的把握不完整，该让人看一眼
    expect(result.located).toBe(false);
  });

  it('空引用列表判失败', () => {
    expect(locateQuotes(SEGMENTS, [], 'src_1').located).toBe(false);
    expect(locateQuotes(SEGMENTS, ['', '  '], 'src_1').located).toBe(false);
  });
});

describe('findQuoteInText 边界', () => {
  it('在文本开头命中时 start 为 0', () => {
    const hit = findQuoteInText('开头就在这里然后还有很多字', '开头就在这里');
    expect(hit?.start).toBe(0);
  });

  it('在文本末尾命中时 end 等于文本长度', () => {
    const text = '前面很多字然后结尾在这';
    const hit = findQuoteInText(text, '然后结尾在这');
    expect(hit?.end).toBe(text.length);
  });

  it('找不到返回 null', () => {
    expect(findQuoteInText('abc', 'xyz')).toBeNull();
  });

  it('matched 返回原文真实片段（不是归一化后的）', () => {
    const text = '甲段文字  乙段文字\n丙段文字';
    const hit = findQuoteInText(text, '乙段文字 丙段文字');
    expect(hit).not.toBeNull();
    // matched 必须来自原文，含原文里的换行，而不是我们造的 "乙段文字 丙段文字"
    expect(text).toContain(hit!.matched);
  });
});
