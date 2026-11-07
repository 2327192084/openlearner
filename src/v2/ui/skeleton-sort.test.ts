import { describe, expect, it } from 'vitest';
import { naturalCompare } from './SkeletonPage.tsx';

/**
 * 章节排序的测试。
 *
 * ## 为什么单独测这个
 *
 * 「知识骨架」按章节名排序。看起来是个小事，但**字典序会把第 10 章排到
 * 第 2 章前面**：
 * ```
 * 第10章  <  第2章   ← 字符串比较的结果
 * ```
 * 用户拿着这个顺序去对照原书，会完全错位 —— 而这在界面上看不出是 bug，
 * 只会让人觉得「这软件的章序是乱的」。
 */

describe('naturalCompare：章节自然序', () => {
  it('第2章排在 第10章 前面（字典序会排反）', () => {
    expect(naturalCompare('第2章', '第10章')).toBeLessThan(0);
    expect(naturalCompare('第10章', '第2章')).toBeGreaterThan(0);
  });

  it('整组章节排序正确', () => {
    const chapters = ['第10章', '第2章', '第1章', '第11章', '第3章'];
    const sorted = [...chapters].sort(naturalCompare);
    expect(sorted).toEqual(['第1章', '第2章', '第3章', '第10章', '第11章']);
  });

  it('一位数与两位数混合', () => {
    const chapters = ['第9章', '第10章', '第1章'];
    expect([...chapters].sort(naturalCompare)).toEqual(['第1章', '第9章', '第10章']);
  });

  it('纯文字章节按本地化顺序比较（不是码位）', () => {
    /*
     * 关键点：两个方向必须**符号相反**，且不为 0 ——
     * 这保证比较是自洽的（排序才稳定）。
     *
     * 不断言具体谁先谁后：那取决于 zh-CN 的排序规则（拼音/笔画），
     * 把它钉死会让测试在换 locale 数据时莫名失败，
     * 而我们真正关心的是「顺序稳定且自洽」。
     */
    const ab = naturalCompare('附录', '正文');
    const ba = naturalCompare('正文', '附录');
    expect(ab).not.toBe(0);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });

  it('相同字符串返回 0', () => {
    expect(naturalCompare('第1章', '第1章')).toBe(0);
  });

  it('「未归章」永远排最后（不是插在中间）', () => {
    /*
     * 这条一开始是失败的：当时用普通字典序，「未归章」会按码位排到
     * 「第1章」前面 —— 用户会看到一堆没章节的知识点顶在最上面，
     * 误以为那才是第一块内容。
     *
     * 现在 naturalCompare 里对它做了特判（沉底）。
     */
    const chapters = ['第1章', '未归章', '第2章', '第10章'];
    const sorted = [...chapters].sort(naturalCompare);
    expect(sorted).toEqual(['第1章', '第2章', '第10章', '未归章']);
  });

  it('只有「未归章」时也不出错', () => {
    expect([...['未归章'].values()].sort(naturalCompare)).toEqual(['未归章']);
  });

  it('小数与多级编号不会崩', () => {
    expect(() => naturalCompare('1.2 节', '1.10 节')).not.toThrow();
    // 1.2 < 1.10（按数字段比较）
    expect(naturalCompare('1.2 节', '1.10 节')).toBeLessThan(0);
  });
});
