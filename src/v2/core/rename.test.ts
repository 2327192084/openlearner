/**
 * 改名规则的单元测试（2026-11-13 傍晚）。
 *
 * 用户要求：「加个更名功能，可以更名资料库的资料，题组。」
 *
 * 这些用例钉的是**边界**：空名字、超长、带换行、没改动。
 * 每一条都对应一个真实会发生的操作，不是凑数。
 */

import { describe, expect, it } from 'vitest';
import { MAX_TITLE_LENGTH, checkNewTitle, isRenameError } from './rename.ts';

describe('正常的改名', () => {
  it('普通名字通过，并去掉首尾空格', () => {
    const r = checkNewTitle('  第1章 信号与系统  ', '信号与系统（第二版）第1章 信号与系统 正文（不含习题）');
    expect(r).toEqual({ ok: true, title: '第1章 信号与系统' });
  });

  it('用户截图里那种长名字可以改成短的', () => {
    const long = '信号与系统（第二版）第1章 信号与系统 正文（不含习题）';
    const r = checkNewTitle('信号与系统 · 第1章', long);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe('信号与系统 · 第1章');
  });

  it('中文、英文、数字、标点都能用', () => {
    for (const name of ['高数 上册', 'Signals & Systems', '第 3 章 (2024 版)', '题组-A_1']) {
      expect(checkNewTitle(name, '旧名字').ok, name).toBe(true);
    }
  });

  it('刚好等于上限可以通过', () => {
    const name = 'a'.repeat(MAX_TITLE_LENGTH);
    expect(checkNewTitle(name, '旧名字').ok).toBe(true);
  });
});

describe('不接受的输入', () => {
  it('空字符串不行', () => {
    const r = checkNewTitle('', '原名');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('空');
  });

  it('只有空格也不行（全选后误敲空格是最常见的情况）', () => {
    const r = checkNewTitle('     ', '原名');
    expect(r.ok).toBe(false);
  });

  it('超长不行，且提示里给出实际字数与上限', () => {
    const name = 'a'.repeat(MAX_TITLE_LENGTH + 5);
    const r = checkNewTitle(name, '原名');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(String(MAX_TITLE_LENGTH));
      expect(r.reason).toContain(String(MAX_TITLE_LENGTH + 5));
    }
  });

  it('带换行不行（会把单行布局撑坏）', () => {
    expect(checkNewTitle('第一行\n第二行', '原名').ok).toBe(false);
  });

  it('带制表符不行', () => {
    expect(checkNewTitle('前\t后', '原名').ok).toBe(false);
  });

  it('和原来一样 → 不算错误，但也不写库', () => {
    const r = checkNewTitle('同一个名字', '同一个名字');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('和原来的名字一样');
  });

  it('「和原来一样」在去掉首尾空格之后判断', () => {
    const r = checkNewTitle('  同一个名字  ', '同一个名字');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('和原来的名字一样');
  });
});

describe('isRenameError：什么该显示成红字', () => {
  it('「和原来一样」不当错误（用户打开看一眼又回车很常见）', () => {
    expect(isRenameError(checkNewTitle('原名', '原名'))).toBe(false);
  });

  it('空、超长、带换行都算错误', () => {
    expect(isRenameError(checkNewTitle('', '原名'))).toBe(true);
    expect(isRenameError(checkNewTitle('a'.repeat(200), '原名'))).toBe(true);
    expect(isRenameError(checkNewTitle('a\nb', '原名'))).toBe(true);
  });

  it('成功时不算错误', () => {
    expect(isRenameError(checkNewTitle('新名字', '原名'))).toBe(false);
  });
});
