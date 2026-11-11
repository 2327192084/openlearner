/**
 * 资料标题消歧（2026-11-11）。
 *
 * ## 为什么需要
 *
 * 实测用户库里有**两份同名 PDF**，内容不同（一份 36 页、一份只有 1-2 页）。
 * 在「文档解析」页的列表里两行字一模一样 —— 用户只能靠猜，
 * 已经因此把分片解析写错过一次（写到另一份上，把那份 2 页的资料撑成 36 段）。
 *
 * ## 设计取舍
 *
 * - 只给**重名的那几份**加编号。不重名的保持干净 ——
 *   绝大多数情况下用户不需要看见「（1）」。
 * - 编号按 `createdAt` 升序，所以**编号是稳定的**：
 *   只要不增删资料，同一份资料每次看到的编号都一样。
 *   若按列表当前顺序编号，排序一变（「待解析」排前面）编号就跟着变，
 *   用户会以为选错了 —— 那比不加编号更糟。
 */
import { describe, expect, it } from 'vitest';
import { disambiguateTitles, formatImportedAt } from './source-title.ts';

const mk = (id: string, title: string, createdAt?: string) => ({ id, title, createdAt });

describe('disambiguateTitles', () => {
  it('不重名时原样返回，不加任何后缀', () => {
    const map = disambiguateTitles([mk('a', '甲'), mk('b', '乙')]);
    expect(map.get('a')).toBe('甲');
    expect(map.get('b')).toBe('乙');
  });

  it('★ 重名时按导入时间加（1）（2）', () => {
    const map = disambiguateTitles([
      mk('old', '信号与系统', '2026-11-11T10:00:00Z'),
      mk('new', '信号与系统', '2026-11-11T15:00:00Z'),
    ]);
    /* 早导入的是（1） */
    expect(map.get('old')).toBe('信号与系统（1）');
    expect(map.get('new')).toBe('信号与系统（2）');
  });

  it('★ 编号与数组顺序无关（排序变了编号不能变）', () => {
    const a = mk('old', '同名', '2026-11-11T10:00:00Z');
    const b = mk('new', '同名', '2026-11-11T15:00:00Z');

    /* 两种顺序，同一份资料的编号必须一样 */
    const m1 = disambiguateTitles([a, b]);
    const m2 = disambiguateTitles([b, a]);
    expect(m1.get('old')).toBe(m2.get('old'));
    expect(m1.get('new')).toBe(m2.get('new'));
    expect(m1.get('old')).toBe('同名（1）');
  });

  it('三份同名 → （1）（2）（3）', () => {
    const map = disambiguateTitles([
      mk('a', 'X', '2026-01-01T00:00:00Z'),
      mk('b', 'X', '2026-02-01T00:00:00Z'),
      mk('c', 'X', '2026-03-01T00:00:00Z'),
    ]);
    expect(map.get('a')).toBe('X（1）');
    expect(map.get('b')).toBe('X（2）');
    expect(map.get('c')).toBe('X（3）');
  });

  it('只有重名的那组加编号，其他组不受影响', () => {
    const map = disambiguateTitles([
      mk('a1', '重名', '2026-01-01T00:00:00Z'),
      mk('a2', '重名', '2026-01-02T00:00:00Z'),
      mk('b', '独一份'),
    ]);
    expect(map.get('a1')).toBe('重名（1）');
    expect(map.get('a2')).toBe('重名（2）');
    expect(map.get('b')).toBe('独一份'); /* 没有后缀 */
  });

  it('首尾空白不影响是否算重名', () => {
    const map = disambiguateTitles([
      mk('a', '标题'),
      mk('b', '  标题  '),
    ]);
    expect(map.get('a')).toContain('（1）');
    expect(map.get('b')).toContain('（2）');
  });

  it('createdAt 缺失时排在后面，不抢（1）', () => {
    const map = disambiguateTitles([mk('noTime', '同名'), mk('hasTime', '同名', '2026-05-05T00:00:00Z')]);
    expect(map.get('hasTime')).toBe('同名（1）');
    expect(map.get('noTime')).toBe('同名（2）');
  });

  it('空列表返回空 Map', () => {
    expect(disambiguateTitles([]).size).toBe(0);
  });
});

describe('formatImportedAt', () => {
  it('格式化成「MM-DD HH:mm」', () => {
    const s = formatImportedAt('2026-11-11T05:25:00.000Z');
    /* 时区依赖环境，只断言形状 */
    expect(s).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('空值 / 非法值返回空串（不显示乱码）', () => {
    expect(formatImportedAt(null)).toBe('');
    expect(formatImportedAt(undefined)).toBe('');
    expect(formatImportedAt('not-a-date')).toBe('');
  });
});
