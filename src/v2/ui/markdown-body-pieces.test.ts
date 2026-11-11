import { describe, expect, it } from 'vitest';
import { toPieces } from './MarkdownBodyMarked.tsx';
import { splitBlocks } from './markdown-marks.ts';

/**
 * 标注偏移的坐标系（2026-11-11 第二轮）。
 *
 * ## 这一层为什么必须钉死
 *
 * 用户报「标注部分与实际渲染部分有偏移」，实测第 1 页原文 1048 字、
 * 渲染后 DOM 文本 606 字（差 442 字），原因是原文偏移被当成 DOM 偏移用。
 * 修法是渲染时把每片段的原文范围写进 `data-raw`。
 *
 * 那个修法**成立的前提**是：所有片段首尾相接、总长等于原文长度。
 * 一旦这条破了（漏掉一个 `$`、把定界符算错），标注又会漂 ——
 * 而且这次是静默漂，界面上看不出异常。所以用单测钉死。
 *
 * ## 测试边界
 *
 * vitest 跑在 node 环境（`environment: 'node'`），没有 DOM，
 * 所以这里只测**纯函数**的坐标计算。真正的「画在哪」仍靠
 * Electron + CDP 截图与读 DOM 验证。
 */

describe('toPieces：片段的原文坐标', () => {
  it('纯文本：单一片段，覆盖整段', () => {
    const pieces = toPieces('一段没有公式的正文', 0);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.from).toBe(0);
    expect(pieces[0]!.to).toBe('一段没有公式的正文'.length);
    expect(pieces[0]!.math).toBe(false);
  });

  it('从非零起点开始：片段坐标是绝对偏移', () => {
    const pieces = toPieces('后半段', 100);
    expect(pieces[0]!.from).toBe(100);
    expect(pieces[0]!.to).toBe(103);
  });

  it('行内公式：公式按 $...$ 的**完整长度**计入原文', () => {
    /*
     * `$v_{s}$` 在原文里是 7 个字符（含两个 $）。
     * 若只算 5（漏了定界符），公式后面的文字偏移就全错。
     */
    const text = '电压 $v_{s}$ 变化';
    const pieces = toPieces(text, 0);

    expect(pieces.map((p) => p.math)).toEqual([false, true, false]);
    expect(pieces[1]!.latex).toBe('v_{s}');
    expect(pieces[1]!.to - pieces[1]!.from).toBe(7); /* $ + v_{s} + $ */
  });

  it('块级公式：$$...$$ 计 4 个定界符', () => {
    /*
     * `x^2` 是 3 个字符，加 `$$` 两侧共 4 个定界符 = 7。
     * （最初写成 9 是算错了 —— 把 `x^2` 当 5 个字符。
     *  测试先红后绿正是它该有的作用。）
     */
    const pieces = toPieces('$$x^2$$', 0);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.math).toBe(true);
    expect(pieces[0]!.to - pieces[0]!.from).toBe(7); /* 4 + 3 */
  });

  it('★ 不变量：首尾相接、总长等于原文长度', () => {
    /*
     * 这是整个修法的地基。任何多算 / 少算一个字，
     * 后面所有标注都会整体偏移，而且界面上看不出来。
     */
    const cases = [
      '普通段落',
      '电压 $v_{s}$ 和 $v_{c}$ 的变化',
      '开头就有公式 $a$ 然后是文字',
      '文字结尾有个公式 $b$',
      '$$块级$$ 与 $行内$ 混排，还有 $\\rho v$ 这种',
      '含不成对的 $ 符号（价格 $5 和 $10）',
      '公式 $x$ 和 $y$ 紧挨着$x$$y$',
    ];

    for (const text of cases) {
      const pieces = toPieces(text, 0);
      /* 首尾相接 */
      for (let i = 1; i < pieces.length; i++) {
        expect(pieces[i]!.from).toBe(pieces[i - 1]!.to);
      }
      /* 总长等于原文 */
      const total = pieces.reduce((n, p) => n + (p.to - p.from), 0);
      expect(total).toBe(text.length);
      /* 起点从 0 开始 */
      if (pieces.length > 0) expect(pieces[0]!.from).toBe(0);
    }
  });

  it('★ 不变量：带绝对起点时同样首尾相接', () => {
    const text = '前半 $a$ 后半';
    const pieces = toPieces(text, 500);
    expect(pieces[0]!.from).toBe(500);
    const total = pieces.reduce((n, p) => n + (p.to - p.from), 0);
    expect(total).toBe(text.length);
  });

  it('空串 → 没有片段（不制造空 Range）', () => {
    expect(toPieces('', 0)).toEqual([]);
  });

  it('纯文本片段的 text 与原文逐字一致', () => {
    /*
     * 纯文本片段是要直接渲染成文字的，若这里改了字，
     * 「渲染出来的文字与原文一致」这条承诺就破了。
     */
    const text = '电压 $v_{s}$ 变化';
    const pieces = toPieces(text, 0);
    const texts = pieces.filter((p) => !p.math).map((p) => p.text);
    expect(texts.join('')).toBe('电压  变化');
  });
});

describe('splitBlocks 与 toPieces 的坐标一致性', () => {
  it('块内所有片段都落在块区间内', () => {
    /*
     * 渲染时用块的 from 去切片段。若片段越出块区间，
     * 说明 splitBlocks 与 toPieces 对「哪些字符属于这个块」的判断不一致，
     * 标注会落到相邻块上。
     */
    const md = [
      '## 第1章 信号与系统',
      '',
      '电压 $v_{s}$ 和电容器上的电压 $v_{c}$ 的变化都是信号的例子。',
      '',
      '- 第一条 $a$',
      '- 第二条 $b$',
    ].join('\n');

    for (const b of splitBlocks(md)) {
      const blockText = md.slice(b.from, b.to);
      const pieces = toPieces(blockText, b.from);
      for (const p of pieces) {
        expect(p.from).toBeGreaterThanOrEqual(b.from);
        expect(p.to).toBeLessThanOrEqual(b.to);
      }
    }
  });
});
