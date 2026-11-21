import { describe, expect, it } from 'vitest';
import type { SourceSegment } from '@/core/model.ts';
import {
  buildOutline,
  coveredChapters,
  findChapterMarks,
  isTocSegment,
  parseTocEntries,
} from './source-outline.ts';

/**
 * 资料目录提取（2026-11-21 深夜）。
 *
 * ## 重点在「三种形态要分开」
 *
 * 用户这轮的技术思路依赖「有目录 / 没目录」两类，但实测真实库后发现
 * 是**三类**：真的目录页 / 只有章节标记 / 两者都没有（片段）。
 * 三类的后续路径完全不同，合并会丢掉最需要的信息。
 *
 * ## 夹具来自真实库
 *
 * 下面几条 `text` 是**用户真实资料的原文片段**（只读探测于 2026-11-21），
 * 不是编出来的理想数据 —— 真实 PDF 提取的文字有页眉、有断行、
 * 有 `##` 这种 markdown 残留，用干净的假数据测不出问题。
 */

function seg(index: number, text: string, chapter: string | null = null): SourceSegment {
  return {
    id: 'seg-' + index,
    sourceId: 'src-1',
    index,
    page: index,
    chapter,
    text,
    charCount: text.length,
  };
}

describe('isTocSegment：认目录页', () => {
  it('认 pptx 那种 CONTENTS 目录（真实数据）', () => {
    /*
     * 用户库《课程知识点一》第 2 段原文。
     */
    const text = `CONTENTS
目 录
青岛科技大学环境与安全工程学院 主讲教师：管雨
1 安全生产现状
2 安全检测技术
3 检测技术基础知识`;
    expect(isTocSegment(text)).toBe(true);
  });

  it('认中文「目录」+ 密集条目', () => {
    const text = `目录
第1章 函数与极限 ......... 1
第2章 导数与微分 ......... 45
第3章 微分中值定理 ....... 98
第4章 不定积分 ........... 150`;
    expect(isTocSegment(text)).toBe(true);
  });

  it('⚠️ 正文里「提到」目录不算目录页', () => {
    /*
     * 只看标记词会误判：前言里说「本书目录如下」就中招。
     * 判据要求「标记词 + 密集条目」两条都满足。
     */
    const text = `第七版前言
本次修订工作是在遵循以下原则进行的。按照精品课程教材的要求，
在保持本书第五版优点的前提下继续坚持改革，反复锤炼。
本书目录如下所示，供读者参考查阅使用。`;
    expect(isTocSegment(text)).toBe(false);
  });

  it('空段 / 太短的段不算', () => {
    expect(isTocSegment('目录')).toBe(false);
    expect(isTocSegment('')).toBe(false);
  });

  it('⚠️ 真教材正文不是目录页（高数前言原文）', () => {
    /*
     * 用户库《高等数学 第7版 上》第 5 段原文。
     * 它被解析器当成了章节（chapter="第七版前言"）—— 这类前置页
     * 绝不能被当成目录，否则路线会按「前言/序」来排。
     */
    const text = `## 第七版前言
本次修订工作是在遵循"坚持改革、不断锤炼、打造精品"的要求下进行的，
修订的内容主要包括以下几个方面:
1. 在与中学数学的衔接上，删去了有关集合的内容，保留了映射与函数，
便于在教学时根据实际情况作灵活处`;
    expect(isTocSegment(text)).toBe(false);
  });
});

describe('parseTocEntries：抠章级条目', () => {
  it('去掉点线与页码', () => {
    const text = `目录
第1章 函数与极限 ......... 1
第2章 导数与微分 ......... 45`;
    expect(parseTocEntries(text)).toEqual(['第1章 函数与极限', '第2章 导数与微分']);
  });

  it('⚠️ 只收章级，不收节级（1.1）', () => {
    /*
     * 节级上百条，全塞进提示词反而看不清结构。
     */
    const text = `目录
第1章 函数
1.1 集合
1.2 映射与函数
第2章 导数
2.1 导数概念`;
    const out = parseTocEntries(text);
    expect(out).toEqual(['第1章 函数', '第2章 导数']);
  });

  it('去重（目录页常有重复条目）', () => {
    const text = `第1章 函数
第1章 函数
第2章 导数`;
    expect(parseTocEntries(text)).toEqual(['第1章 函数', '第2章 导数']);
  });

  it('认阿拉伯编号式条目', () => {
    const text = `CONTENTS
1 安全生产现状
2 安全检测技术
3 检测技术基础知识`;
    expect(parseTocEntries(text)).toHaveLength(3);
  });

  it('条目过长（> 60 字）丢弃 —— 那是正文不是标题', () => {
    const long = '第1章 ' + '很长的正文内容'.repeat(12);
    expect(parseTocEntries(long)).toEqual([]);
  });
});

describe('findChapterMarks：认章节标记', () => {
  it('认「第N章」并转成数字', () => {
    const marks = findChapterMarks('第1章 信号与系统\n第2章 线性时不变系统');
    expect(marks.map((m) => m.num)).toEqual([1, 2]);
  });

  it('中文数字也认', () => {
    const marks = findChapterMarks('第三章 导数\n第十一章 级数');
    expect(marks.map((m) => m.num)).toEqual([3, 11]);
  });

  it('认 Chapter N', () => {
    const marks = findChapterMarks('Chapter 1 Introduction\nChapter 2 Methods');
    expect(marks.map((m) => m.num)).toEqual([1, 2]);
  });

  it('⚠️ 正文里「提到」第几章不算标记（行首才认）', () => {
    /*
     * 「本章讨论了三种方法」不该被当成章标题。
     * 正则要求行首 + 编号，且行不能太长。
     */
    const marks = findChapterMarks('本章讨论了三种方法，其中第一种用于');
    expect(marks).toEqual([]);
  });

  it('⚠️ 行太长的不认（正文句子常以「第3章」开头）', () => {
    const longLine = '第3章讲的那三个方法在这一节里会逐一展开，首先我们来看第一个方法它的基本思想是把问题分解成若干个子问题然后分别求解最后合并';
    expect(findChapterMarks(longLine)).toEqual([]);
  });
});

describe('buildOutline：三种形态', () => {
  it('有目录页 → kind = toc-page', () => {
    const segs = [
      seg(1, '高等数学 第七版 上册\n同济大学数学系编'),
      seg(2, `目录
第1章 函数与极限
第2章 导数与微分
第3章 微分中值定理`),
      seg(3, '第1章 函数与极限\n正文内容…'),
    ];
    const o = buildOutline(segs);
    expect(o.kind).toBe('toc-page');
    expect(o.tocAt).toBe(1);
    expect(o.entries).toContain('第1章 函数与极限');
    expect(o.chapterNumbers.length).toBeGreaterThan(0);
  });

  it('没目录页但有章节标记 → kind = chapter-marks', () => {
    const segs = [
      seg(1, '第1章 信号与系统\n## 1.0 引言\n在前面绪论中已经提到…'),
      seg(2, '正文内容…'),
      seg(3, '第2章 线性时不变系统\n正文…'),
    ];
    const o = buildOutline(segs);
    expect(o.kind).toBe('chapter-marks');
    expect(o.chapterNumbers).toEqual([1, 2]);
    expect(o.maxChapterNumber).toBe(2);
  });

  it('都没有 → kind = none（片段资料）', () => {
    const segs = [
      seg(1, '这一节讨论的是安全生产的定义与范围。'),
      seg(2, '事故等级的划分标准如下所示。'),
    ];
    const o = buildOutline(segs);
    expect(o.kind).toBe('none');
    expect(o.entries).toEqual([]);
    expect(o.chapterNumbers).toEqual([]);
  });

  it('⚠️ 目录页只在前 15% 才认（书末索引不算主结构）', () => {
    /*
     * 「附录里有个目录」会给出完全不同的章节列表，把路线带偏。
     */
    const segs: SourceSegment[] = [];
    for (let i = 1; i <= 20; i += 1) segs.push(seg(i, '普通正文第 ' + i + ' 段'));
    /* 第 19/20 段才出现目录 */
    segs.push(seg(19, `目录
第A章 附录索引甲
第B章 附录索引乙
第C章 附录索引丙`));

    const o = buildOutline(segs);
    expect(o.kind).not.toBe('toc-page');
  });

  it('空数组不崩', () => {
    const o = buildOutline([]);
    expect(o.kind).toBe('none');
    expect(o.maxChapterNumber).toBe(0);
  });
});

describe('coveredChapters：用户点名的边界问题', () => {
  it('⚠️ 只有第1章的资料 → 范围就是 1~1（不能排第2章）', () => {
    /*
     * 用户原话：
     * > 例如：用户学习高等数学，但资料只解析/涉及了第一章，
     * > 但路线规划却规划了第一章后的内容
     *
     * 这是那条要求的最小复现。
     */
    const segs = [seg(1, '第1章 信号与系统\n## 1.0 引言'), seg(2, '正文…')];
    const o = buildOutline(segs);
    const cov = coveredChapters(o);
    expect(cov).toMatchObject({ from: 1, to: 1, complete: true });
  });

  it('章号不连续（节选）→ complete = false', () => {
    const segs = [
      seg(1, '第1章 甲\n正文'),
      seg(2, '第5章 乙\n正文'),
      seg(3, '第7章 丙\n正文'),
    ];
    const o = buildOutline(segs);
    const cov = coveredChapters(o);
    expect(cov).toMatchObject({ from: 1, to: 7, complete: false });
  });

  it('完整 1~3 章 → complete = true', () => {
    const segs = [
      seg(1, '第1章 甲\n正文'),
      seg(2, '第2章 乙\n正文'),
      seg(3, '第3章 丙\n正文'),
    ];
    const cov = coveredChapters(buildOutline(segs));
    expect(cov).toMatchObject({ from: 1, to: 3, complete: true });
  });

  it('没有章节信息 → null（不能按章排）', () => {
    expect(coveredChapters(buildOutline([seg(1, '一段没有章号的正文')]))).toBeNull();
  });

  it('⚠️⚠️ 目录列 4 章但正文只有第 1 章 → 范围必须收在 1~1（用户点名的边界 bug）', () => {
    /*
     * 真实情况：目录页列出整本书，但这份资料是「第1章单行本」。
     * 用户库《信号与系统 第1章》就是这种。
     *
     * ## 这条测试的历史
     *
     * 第一版 `coveredChapters` 用 `chapterNumbers`（含目录声明的），
     * 于是这里会返回 1~4 —— **正是用户点名的那个 bug**：
     * 按它排路线就会排出资料里根本没有的第 2~4 章。
     *
     * 修法：新增 `contentChapterNumbers`（只认正文实际出现的），
     * 边界一律按它算。这条测试就是那个修复的回归。
     */
    const segs = [
      seg(1, `目录
第1章 函数与极限
第2章 导数与微分
第3章 微分中值定理
第4章 不定积分`),
      seg(2, '第1章 函数与极限\n正文…'),
    ];
    const o = buildOutline(segs);
    expect(o.kind).toBe('toc-page');

    /* 目录声明的结构确实有 4 章 */
    expect(o.chapterNumbers).toContain(4);
    /* 但正文只有第 1 章 */
    expect(o.contentChapterNumbers).toEqual([1]);

    const cov = coveredChapters(o);
    /* 边界只到第 1 章 */
    expect(cov).toMatchObject({ from: 1, to: 1, complete: true });
    /* 同时告诉界面「目录其实列到第 4 章」——那是节选，不是解析没做完 */
    expect(cov?.declaredTo).toBe(4);
  });

  it('目录与正文一致时 declaredTo 为 null（不产生噪音）', () => {
    const segs = [
      seg(1, `目录
第1章 甲
第2章 乙
第3章 丙`),
      seg(2, '第1章 甲\n正文'),
      seg(3, '第2章 乙\n正文'),
      seg(4, '第3章 丙\n正文'),
    ];
    const cov = coveredChapters(buildOutline(segs));
    expect(cov?.declaredTo).toBeNull();
  });
});