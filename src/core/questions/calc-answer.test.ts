/**
 * 计算题数值判分的测试（2026-11-12）。
 *
 * ## 为什么这些断言重要
 *
 * 判错一个正确答案，比不出题更伤 —— 学生会以为自己算错了，
 * 花时间去找一个并不存在的错误。所以这里重点守两类：
 *
 *  1. **等价写法要判对**：0.5 / 1/2 / 50%、9.8m/s^2 / 9.8 m/s²
 *  2. **真错的不能放过**：负号、单位不一致、量级差一个数量级
 */
import { describe, expect, it } from 'vitest';
import { compareNumeric, gradeCalcAnswer, parseNumeric } from './calc-answer.ts';

/** 与 service.ts 里 normalizeBlank 行为一致的简化版（测试用） */
const norm = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toLowerCase();

describe('parseNumeric：把答案解析成数值 + 单位', () => {
  it('整数与小数', () => {
    expect(parseNumeric('12')?.value).toBe(12);
    expect(parseNumeric('-3.5')?.value).toBe(-3.5);
    expect(parseNumeric('1.2e-3')?.value).toBeCloseTo(0.0012);
  });

  it('★ 分数按除法算值（1/2 与 0.5 应等价）', () => {
    expect(parseNumeric('1/2')?.value).toBe(0.5);
    expect(parseNumeric('-3/4')?.value).toBe(-0.75);
  });

  it('★ 百分数 50% → 0.5', () => {
    const p = parseNumeric('50%');
    expect(p?.value).toBeCloseTo(0.5);
    expect(p?.percent).toBe(true);
  });

  it('数值 + 单位分开', () => {
    const p = parseNumeric('9.8 m/s^2');
    expect(p?.value).toBeCloseTo(9.8);
    expect(p?.unit).toBe('m/s^2');
  });

  it('★ 上标单位与 ^n 写法归一成同一个', () => {
    expect(parseNumeric('9.8 m/s²')?.unit).toBe('m/s^2');
    expect(parseNumeric('9.8 m/s^2')?.unit).toBe('m/s^2');
  });

  it('去掉 LaTeX 包装（$…$ 与 \\text{}）', () => {
    const p = parseNumeric('$0.5 \\text{m/s}$');
    expect(p?.value).toBe(0.5);
    expect(p?.unit).toBe('m/s');
  });

  it('不是纯数值 → null（让调用方退回文本比对）', () => {
    expect(parseNumeric('R1+R2')).toBeNull();
    expect(parseNumeric('不确定')).toBeNull();
    expect(parseNumeric('')).toBeNull();
  });
});

describe('compareNumeric：等价写法必须判对', () => {
  it('★ 0.5 与 1/2 等价', () => {
    expect(compareNumeric('0.5', '1/2')).toBe(true);
  });

  it('★ 50% 与 0.5 等价', () => {
    expect(compareNumeric('50%', '0.5')).toBe(true);
  });

  it('★ 单位不同写法（上标 / 空格）不影响判定', () => {
    expect(compareNumeric('9.8m/s²', '9.8 m/s^2')).toBe(true);
  });

  it('★ 1/3 与 0.33 在 1% 容差内算对（学生常用近似）', () => {
    expect(compareNumeric('0.33', '1/3')).toBe(true);
  });

  it('容差可调：严格模式下 0.33 判错', () => {
    expect(compareNumeric('0.33', '1/3', { tolerance: 0.001 })).toBe(false);
  });
});

describe('compareNumeric：真错的不能放过', () => {
  it('★ 符号不同必错', () => {
    expect(compareNumeric('-1', '1')).toBe(false);
  });

  it('★ 量级差 10 倍必错', () => {
    expect(compareNumeric('10', '1')).toBe(false);
    expect(compareNumeric('100', '1')).toBe(false);
  });

  it('★ 单位不一致必错（物理题丢单位是实质错误）', () => {
    /*
     * 「力是多少」答 `5` 而不是 `5 N` —— 数值对但没回答问题。
     * 这条刻意从严：放过它会让用户以为「单位无所谓」。
     */
    expect(compareNumeric('5', '5 N')).toBe(false);
    expect(compareNumeric('5 m', '5 N')).toBe(false);
  });

  it('两侧都没有单位 → 视为一致（纯数学题）', () => {
    expect(compareNumeric('5', '5')).toBe(true);
  });

  it('★ 标准答案为 0 时用绝对误差，不除以零', () => {
    expect(compareNumeric('0', '0')).toBe(true);
    expect(compareNumeric('-0', '0')).toBe(true);
    expect(compareNumeric('0.001', '0')).toBe(false);
  });
});

describe('compareNumeric：解析不出时返回 null（交回文本比对）', () => {
  it('答案是公式', () => {
    expect(compareNumeric('R1+R2', 'R1+R2')).toBeNull();
  });

  it('一侧是数值、另一侧是文字', () => {
    expect(compareNumeric('5', '五')).toBeNull();
  });
});

describe('gradeCalcAnswer：先数值，退回文本', () => {
  it('数值能判就按数值判', () => {
    expect(gradeCalcAnswer('0.5', '1/2', norm)).toBe(true);
    expect(gradeCalcAnswer('0.4', '1/2', norm)).toBe(false);
  });

  it('★ 解析不出数值时退回文本比对（公式答案仍可判）', () => {
    expect(gradeCalcAnswer('R1+R2', 'R1+R2', norm)).toBe(true);
    /* 大小写与空格差异被文本归一化吃掉 */
    expect(gradeCalcAnswer('r1 + r2', 'R1+R2', norm)).toBe(true);
  });

  it('退回文本时，真的不同就判错', () => {
    expect(gradeCalcAnswer('R1+R3', 'R1+R2', norm)).toBe(false);
  });
});
