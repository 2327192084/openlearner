import { describe, expect, it } from 'vitest';
import {
  SLIDE_LIMITS,
  chunkBullets,
  continuationTitle,
  foldTitle,
  splitLongText,
} from './limits.ts';

/**
 * 分页与拆句的单元测试。
 *
 * 这一层的两个硬要求，都在计划书 P4 第 6 条里：
 *   - 内容超长时**合理分页**
 *   - **不截断**
 *
 * "不截断"容易被写成"太长就省略号"，那是最省事也最伤的做法：
 * 学生看到的是残缺的句子，而软件显示"已导出"。
 * 所以这里逐条断言：拆完拼回去必须逐字相等。
 */

describe('splitLongText：长文本拆分不丢字', () => {
  it('短文本原样返回一条', () => {
    expect(splitLongText('线性系统满足叠加性。', 88)).toEqual(['线性系统满足叠加性。']);
  });

  it('拆开后按顺序拼接必须与原文完全一致', () => {
    const text =
      '傅里叶变换把时域信号映射到频域；对于周期信号，可以展开成傅里叶级数；' +
      '对于非周期信号，则使用傅里叶变换。采样定理指出，采样频率必须大于信号最高频率的两倍，' +
      '否则会发生频谱混叠，导致无法从采样结果恢复原信号。';
    const parts = splitLongText(text, 40);

    expect(parts.length).toBeGreaterThan(1);
    // 这是核心断言：一个字符都不能少，也不能多
    expect(parts.join('')).toBe(text);
  });

  it('每一段都不超过上限', () => {
    const text = '甲'.repeat(10) + '。' + '乙'.repeat(30) + '；' + '丙'.repeat(20);
    for (const part of splitLongText(text, 25)) {
      expect(part.length).toBeLessThanOrEqual(25);
    }
  });

  it('优先在标点处断开，不把词切两半', () => {
    const text = '第一部分内容比较长需要断开。第二部分内容也不短。';
    const parts = splitLongText(text, 20);

    // 每段都应该以标点结尾（或本身是最后一段）
    for (const part of parts.slice(0, -1)) {
      expect(/[。；;，,、！!？?]$/.test(part)).toBe(true);
    }
    expect(parts.join('')).toBe(text);
  });

  it('完全没有标点的超长文本硬切，仍然不丢字', () => {
    const text = '无标点'.repeat(40); // 120 字，无任何断句符
    const parts = splitLongText(text, 50);

    expect(parts.join('')).toBe(text);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(50);
  });

  it('标点位置太靠前时不在那里断（否则每段太短）', () => {
    // 第 3 个字就是句号，若在处断会切出 3 字一段
    const text = '短。' + '后面的内容很长很长'.repeat(10);
    const parts = splitLongText(text, 30);

    // 断点要在上限的一半之后
    expect(parts[0].length).toBeGreaterThanOrEqual(15);
    expect(parts.join('')).toBe(text);
  });

  it('空文本返回空数组（不要返回一条空字符串）', () => {
    expect(splitLongText('')).toEqual([]);
    expect(splitLongText('   ')).toEqual([]);
  });
});

describe('chunkBullets：按页切分', () => {
  it('正好整除时不产生空页', () => {
    const chunks = chunkBullets([1, 2, 3, 4], 2);
    expect(chunks).toEqual([[1, 2], [3, 4]]);
  });

  it('有余数时最后一页不满', () => {
    const chunks = chunkBullets([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('不足一页时只有一页', () => {
    expect(chunkBullets([1], 5)).toEqual([[1]]);
  });

  it('空数组返回空（不要返回一页空的）', () => {
    // 返回 [[]] 的话界面会显示一张「要点页」但一条要点都没有
    expect(chunkBullets([], 5)).toEqual([]);
  });
});

describe('continuationTitle：续页标题', () => {
  it('只有一页时不加序号', () => {
    expect(continuationTitle('资料来源', 0, 1)).toBe('资料来源');
  });

  it('多页时加序号', () => {
    expect(continuationTitle('资料来源', 0, 3)).toBe('资料来源 · 1/3');
    expect(continuationTitle('资料来源', 2, 3)).toBe('资料来源 · 3/3');
  });
});

describe('foldTitle：标题折行', () => {
  it('短标题原样返回', () => {
    expect(foldTitle('信号与系统', 40)).toBe('信号与系统');
  });

  it('超长标题在中文标点处换行', () => {
    const title = '第三章：连续时间系统的频域分析——从傅里叶级数到拉普拉斯变换';
    const folded = foldTitle(title, 20);
    expect(folded).toContain('\n');
    // 折行不能改动文字内容
    expect(folded.replace(/\n/g, '')).toBe(title);
  });

  it('没有合适断点时按长度硬折，不丢字', () => {
    const title = '一二三四五六七八九十一二三四五六七八九十一二三四五';
    const folded = foldTitle(title, 10);
    expect(folded.replace(/\n/g, '')).toBe(title);
  });
});

describe('SLIDE_LIMITS 的取值自洽', () => {
  it('每条要点不超过正文区能放下的量', () => {
    // 正文区 4.55 英寸，18pt 行高约 0.34 英寸 → 约 13 行；
    // 5 条要点每条最多占 2 行多，留出余量
    const linesAvailable = Math.floor(SLIDE_BOX_BODY / 0.34);
    const needed = SLIDE_LIMITS.maxBulletsPerPage * 2.5;
    expect(needed).toBeLessThanOrEqual(linesAvailable);
  });
});

// 与 render-plan.ts 的 SLIDE_BOX.bodyHeight 保持一致（这里写死避免循环依赖）
const SLIDE_BOX_BODY = 4.55;
