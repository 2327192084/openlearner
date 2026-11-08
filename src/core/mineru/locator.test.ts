import { describe, expect, it } from 'vitest';
import {
  formatLocator,
  kindOfLabel,
  parseImageLine,
  parseLocator,
} from './locator.ts';

/**
 * 定位符解析的单测。
 *
 * 用例取自**真实数据**：2026-11-08 用你的《信号与系统（第二版）第1章》
 * 跑 MinerU 4.1.7 得到的 converted.md，里面的定位符长这样：
 *
 *     ![Image block](doc:87731df/tier:standard/page:1/block:7)
 *
 * 不是编的样本 —— 编的样本只能证明代码符合我的想象。
 */
describe('parseLocator', () => {
  it('解析真实的 Image block 定位符', () => {
    const loc = parseLocator('doc:87731df/tier:standard/page:1/block:7');
    expect(loc).toEqual({
      doc: '87731df',
      tier: 'standard',
      page: 1,
      block: 7,
      raw: 'doc:87731df/tier:standard/page:1/block:7',
    });
  });

  it('解析 Chart block（第 2 页那个真实定位符）', () => {
    const loc = parseLocator('doc:87731df/tier:standard/page:2/block:3');
    expect(loc?.page).toBe(2);
    expect(loc?.block).toBe(3);
    expect(loc?.tier).toBe('standard');
  });

  it('三个 tier 都能解析（实测 basic/flash/standard 都能出图）', () => {
    for (const tier of ['flash', 'basic', 'standard', 'advanced']) {
      expect(parseLocator(`doc:87731df/tier:${tier}/page:1/block:7`)?.tier).toBe(tier);
    }
  });

  it('容错前后空白', () => {
    expect(parseLocator('  doc:87731df/tier:basic/page:3/block:12  ')?.block).toBe(12);
  });

  it('格式不对返回 null，不抛异常', () => {
    const bad = [
      '',
      'doc:',
      'not-a-locator',
      'https://example.com/a.png',
      'doc:87731df/tier:standard/page:1', // 缺 block
      'doc:87731df/page:1/block:7', // 缺 tier
      'docs:87731df/tier:standard/page:1/block:7', // 前缀错
    ];
    for (const b of bad) expect(parseLocator(b)).toBeNull();
  });

  it('页码/块号是 1 基：0 和负数都算坏数据', () => {
    /*
     * 这条不是吹毛求疵。MinerU 的块号是 1 基（源码 _find_block_by_no
     * 里写的就是 block_no - 1），收到 0 说明上游已经错了。
     * 放过去会让 block:0 映射到 index -1，静默取不到图。
     */
    expect(parseLocator('doc:87731df/tier:standard/page:0/block:7')).toBeNull();
    expect(parseLocator('doc:87731df/tier:standard/page:1/block:0')).toBeNull();
    expect(parseLocator('doc:87731df/tier:standard/page:-1/block:7')).toBeNull();
  });

  it('页码/块号必须是整数', () => {
    expect(parseLocator('doc:87731df/tier:standard/page:1.5/block:7')).toBeNull();
  });
});

describe('formatLocator', () => {
  it('拼回带 doc: 前缀的完整串', () => {
    expect(
      formatLocator({ doc: '87731df', tier: 'standard', page: 1, block: 7 }),
    ).toBe('doc:87731df/tier:standard/page:1/block:7');
  });

  it('与 parseLocator 互逆（往返不变）', () => {
    const raw = 'doc:87731df/tier:basic/page:34/block:8';
    const loc = parseLocator(raw)!;
    expect(formatLocator(loc)).toBe(raw);
  });
});

describe('kindOfLabel', () => {
  it('认得 MinerU 的四个块标签（源码 _VISUAL_BLOCK_LABELS）', () => {
    expect(kindOfLabel('Image block')).toBe('image');
    expect(kindOfLabel('Chart block')).toBe('chart');
    expect(kindOfLabel('Table block')).toBe('table');
    expect(kindOfLabel('Formula block')).toBe('formula');
  });

  it('认不出来当 image —— 宁可分类不准，也不要丢图', () => {
    expect(kindOfLabel('随便什么')).toBe('image');
    expect(kindOfLabel('')).toBe('image');
  });
});

describe('parseImageLine', () => {
  it('认出真实图片行并解析出定位符', () => {
    const r = parseImageLine('![Image block](doc:87731df/tier:standard/page:1/block:7)');
    expect(r?.kind).toBe('image');
    expect(r?.label).toBe('Image block');
    expect(r?.locator?.block).toBe(7);
  });

  it('容错前后空白（MinerU 输出带 \\r）', () => {
    const r = parseImageLine('  ![Chart block](doc:87731df/tier:standard/page:2/block:3)  \r');
    expect(r?.kind).toBe('chart');
    expect(r?.locator?.page).toBe(2);
  });

  it('外链图片认出来但 locator 为 null（我们取不了，但不是格式错误）', () => {
    const r = parseImageLine('![示意图](https://example.com/a.png)');
    expect(r).not.toBeNull();
    expect(r?.locator).toBeNull();
  });

  it('正文行不算图片行', () => {
    expect(parseImageLine('图1.1 含有电压源 $v_{s}$ 和电容器')).toBeNull();
    expect(parseImageLine('')).toBeNull();
    expect(parseImageLine('## 第1章 信号与系统')).toBeNull();
  });

  it('夹在文字里的图片不算 —— 只认整行（实测教材里 0 例）', () => {
    /*
     * 这条是**有意的保守**：我们不改 text，靠 charOffset 定位。
     * 如果允许行内图片，偏移计算会复杂很多，而实测用不上。
     * 认不出来只会少一张图，不会把正文搞坏。
     */
    expect(parseImageLine('前面的话 ![Image block](doc:87731df/tier:standard/page:1/block:7)')).toBeNull();
  });
});
