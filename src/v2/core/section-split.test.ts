import { describe, expect, it } from 'vitest';
import type { SourceSegment } from '@/core/model.ts';
import { chaptersNeedingAiSplit, splitSections } from './section-split.ts';

/**
 * 从正文切小节（2026-11-22）。
 *
 * ## 这组测试的重点：**小节必须落在自己的父章里**
 *
 * 实测：高等数学每章都有「1.」「2.」「3.」这种**章内序号**。
 * 如果按编号全局分组，第 2 章的「1. 导数的定义」会被错归到第 1 章去，
 * 整棵树就废了。
 *
 * 所以这里最重的一条是「跨章同号不合并」。
 *
 * ## 夹具来自真实资料
 *
 * 三种标题写法都是从用户真实库抽出来的原文格式
 * （信号与系统的 `## 1.1 xxx`、高数的 `## 1. xxx`、pptx 的什么都没有）。
 */

function seg(index: number, text: string): SourceSegment {
  return {
    id: 'seg-' + index,
    sourceId: 'src-1',
    index,
    page: index,
    chapter: null,
    text,
    charCount: text.length,
  };
}

describe('splitSections：三种标题写法', () => {
  it('认 markdown 的 `## 1.1 xxx`（信号与系统那种）', () => {
    const segs = [
      seg(1, '## 第1章 信号与系统\n## 1.0 引言\n前面绪论中已经提到…'),
      seg(2, '正文内容'),
      seg(3, '## 1.1 连续时间和离散时间信号\n信号可以表示为…'),
      seg(4, '更多正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.number).toBe(1);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.0', '1.1']);
    expect(r.hasRealSections).toBe(true);
  });

  it('认 `## 1.1.1` 三级编号', () => {
    const segs = [
      seg(1, '## 第1章 信号与系统\n## 1.1 连续时间和离散时间信号\n## 1.1.1 举例与数学表示\n正文'),
    ];
    const r = splitSections(segs);
    const nums = r.chapters[0]!.sections.map((s) => s.number);
    expect(nums).toContain('1.1');
    expect(nums).toContain('1.1.1');
  });

  it('认 `## 1. xxx` 章内序号（高数那种）', () => {
    const segs = [
      seg(1, '## 第1章 函数与极限\n## 1. 映射概念\n正文'),
      seg(2, '## 2. 逆映射与复合映射\n正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1', '2']);
  });

  it('认无 markdown 的纯文本 `1.1 极限`', () => {
    const segs = [
      seg(1, '第1章 极限\n1.1 数列极限\n正文内容'),
      seg(2, '1.2 函数极限\n正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.1', '1.2']);
  });

  it('认 `第N章` 与 `Chapter N`', () => {
    const r1 = splitSections([seg(1, '第3章 微分中值定理\n## 3.1 罗尔定理\n正文')]);
    expect(r1.chapters[0]!.number).toBe(3);

    const r2 = splitSections([seg(1, 'Chapter 2 Methods\n## 2.1 Foo\nbody')]);
    expect(r2.chapters[0]!.number).toBe(2);
  });
});

describe('splitSections：⚠️ 小节必须落在父章里（最容易写错的一条）', () => {
  it('**跨章同号不合并**（高数每章都有「1.」）', () => {
    /*
     * 这是本文件最重要的一条测试。
     *
     * 按编号全局分组会把第 2 章的「1. 导数的定义」错归到第 1 章 ——
     * 那样整棵树都是错的，而且肉眼很难发现（编号看起来都对）。
     */
    const segs = [
      seg(1, '## 第1章 函数与极限\n## 1. 映射概念\n正文一'),
      seg(2, '## 2. 函数的几种特性\n正文二'),
      seg(3, '## 第2章 导数与微分\n## 1. 导数的定义\n正文三'),
      seg(4, '## 2. 求导法则\n正文四'),
    ];
    const r = splitSections(segs);

    expect(r.chapters).toHaveLength(2);

    const ch1 = r.chapters.find((c) => c.number === 1)!;
    const ch2 = r.chapters.find((c) => c.number === 2)!;
    expect(ch1.sections.map((s) => s.number)).toEqual(['1', '2']);
    expect(ch2.sections.map((s) => s.number)).toEqual(['1', '2']);

    /* 第 2 章的「1.」标题文本必须是导数的定义，不是映射概念 */
    expect(ch2.sections[0]!.title).toContain('导数的定义');
    expect(ch1.sections[0]!.title).toContain('映射概念');
  });

  it('章号顺序打乱也按出现顺序归（不排序）', () => {
    /*
     * 有些资料章号不按顺序（节选、编辑错误）。
     * 按出现顺序建章，不按编号排序 —— 排序会把内容顺序搞乱。
     */
    const segs = [
      seg(1, '第5章 甲\n## 5.1 a\n正文'),
      seg(2, '第2章 乙\n## 2.1 b\n正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters.map((c) => c.number)).toEqual([5, 2]);
  });

  it('同号章只建一次（页眉重复章标题）', () => {
    const segs = [
      seg(1, '第1章 函数\n## 1.1 a\n正文'),
      seg(2, '第1章 函数\n更多正文'),
      seg(3, '## 1.2 b\n正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.1', '1.2']);
  });
});

describe('splitSections：段 id 归属', () => {
  it('小节收录自己的标题段与后续正文段', () => {
    const segs = [
      seg(1, '第1章 甲\n## 1.1 第一小节\n正文A'),
      seg(2, '正文B'),
      seg(3, '## 1.2 第二小节\n正文C'),
    ];
    const r = splitSections(segs);
    const s1 = r.chapters[0]!.sections[0]!;
    const s2 = r.chapters[0]!.sections[1]!;

    expect(s1.segmentIds).toContain('seg-1');
    expect(s1.segmentIds).toContain('seg-2');
    expect(s1.segmentIds).not.toContain('seg-3');
    expect(s2.segmentIds).toEqual(['seg-3']);
  });

  it('章标题之后、第一小节之前的正文补给第一个小节（不丢段）', () => {
    /*
     * 不补的话这些段既不在小节里、也不进任何统计 —— 会彻底消失。
     */
    const segs = [
      seg(1, '第1章 甲'),
      seg(2, '这一章的引言部分'),
      seg(3, '## 1.1 第一小节\n正文'),
    ];
    const r = splitSections(segs);
    const s1 = r.chapters[0]!.sections[0]!;
    expect(s1.segmentIds).toContain('seg-2');
    expect(s1.segmentIds).toContain('seg-3');
  });

  it('封面/前言（第一个章标题之前）不归入任何章', () => {
    const segs = [
      seg(1, '高等数学 第七版 上册'),
      seg(2, '同济大学数学系编'),
      seg(3, '第1章 函数与极限\n## 1.1 映射\n正文'),
    ];
    const r = splitSections(segs);
    const allSegIds = r.chapters.flatMap((c) => c.sections.flatMap((s) => s.segmentIds));
    expect(allSegIds).not.toContain('seg-1');
    expect(allSegIds).not.toContain('seg-2');
  });
});

describe('splitSections：不该被当成标题的行', () => {
  it('⚠️ 图/表/例 题注不是小节', () => {
    const segs = [
      seg(1, '## 1.1 信号分类'),
      seg(2, '图 1.3 一个语音信号的波形[摘自…]'),
      seg(3, '表 1.1 符号说明'),
      seg(4, '例 1.4 考虑一个连续时间系统'),
    ];
    const r = splitSections(segs);
    expect(r.chapters[0]!.sections).toHaveLength(1);
    expect(r.chapters[0]!.sections[0]!.number).toBe('1.1');
  });

  it('⚠️ 以句号/分号结尾的长句不是标题', () => {
    const segs = [
      seg(1, '第1章 甲'),
      seg(2, '1.1 这一节我们要讨论三种不同的信号表示方法以及它们的适用范围。'),
      seg(3, '## 1.2 真正的小节\n正文'),
    ];
    const r = splitSections(segs);
    const nums = r.chapters[0]!.sections.map((s) => s.number);
    /* 1.1 是句子不是标题 */
    expect(nums).toEqual(['1.2']);
  });

  it('⚠️ 裸文本的「1. 首先…」不认（列表项不是标题）', () => {
    /*
     * 没有 `#` 标记时，`1. xxx` 很可能是正文里的有序列表。
     * 所以只认「短且不像句子」的裸序号。
     */
    const segs = [
      seg(1, '第1章 甲'),
      seg(2, '1. 首先我们需要定义什么叫信号，然后才能讨论系统对它的作用。'),
      seg(3, '## 1.1 真正的小节\n正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.1']);
  });

  it('超过 60 字的行不是标题', () => {
    const segs = [
      seg(1, '第1章 甲'),
      seg(2, '## 1.1 ' + '很长的正文内容'.repeat(12)),
    ];
    const r = splitSections(segs);
    expect(r.chapters[0]!.sections).toHaveLength(0);
  });
});

describe('splitSections：退化与边界', () => {
  it('完全没有标题 → 建一个 number 0 的伪章，无小节', () => {
    const segs = [seg(1, '这是一段没有任何标题的正文。'), seg(2, '另一段。')];
    const r = splitSections(segs);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.number).toBe(0);
    expect(r.chapters[0]!.sections).toEqual([]);
    expect(r.hasRealSections).toBe(false);
  });

  it('空数组不崩', () => {
    const r = splitSections([]);
    expect(r.chapters).toEqual([]);
    expect(r.hasRealSections).toBe(false);
  });

  it('资料开头就是小节（没有章标题）→ 建伪章收着', () => {
    const segs = [seg(1, '1.1 第一个小节\n正文'), seg(2, '1.2 第二个小节\n正文')];
    const r = splitSections(segs);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.number).toBe(0);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.1', '1.2']);
  });

  it('一段里同时有章标题和小节标题（信号与系统第 1 段就是）', () => {
    const segs = [
      seg(1, '## 第1章 信号与系统\n## 1.0 引言\n## 1.1 连续时间和离散时间信号\n前面绪论…'),
      seg(2, '正文'),
    ];
    const r = splitSections(segs);
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.sections.map((s) => s.number)).toEqual(['1.0', '1.1']);
  });

  it('stats 如实反映每章切出几个小节', () => {
    const segs = [
      seg(1, '第1章 甲\n## 1.1 a\n正文'),
      seg(2, '第2章 乙\n只有一个章标题，没有小节'),
    ];
    const r = splitSections(segs);
    expect(r.stats).toEqual([
      { chapterNumber: 1, sections: 1 },
      { chapterNumber: 2, sections: 0 },
    ]);
  });
});

describe('chaptersNeedingAiSplit', () => {
  it('切出 0 或 1 个小节的章需要 AI 兜底', () => {
    /*
     * 只有 1 个也送去兜底：用户要的是「点章展开出几个小节」的体验，
     * 一个章只有一个节点，和「整章学」没区别。
     */
    const segs = [
      seg(1, '第1章 甲\n## 1.1 唯一小节\n正文'),
      seg(2, '第2章 乙\n完全没有小节'),
      seg(3, '第3章 丙\n## 3.1 a\n## 3.2 b\n正文'),
    ];
    const r = splitSections(segs);
    const need = chaptersNeedingAiSplit(r);
    expect(need.map((c) => c.number)).toEqual([1, 2]);
  });

  it('全都有 2 个以上小节时返回空', () => {
    const segs = [
      seg(1, '第1章 甲\n## 1.1 a\n## 1.2 b\n正文'),
    ];
    const r = splitSections(segs);
    expect(chaptersNeedingAiSplit(r)).toEqual([]);
  });

  it('pptx 那种完全无标题 → 伪章需要兜底', () => {
    const segs = [seg(1, '没有标题的正文'), seg(2, '更多正文')];
    const r = splitSections(segs);
    expect(chaptersNeedingAiSplit(r)).toHaveLength(1);
  });
});