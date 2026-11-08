import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMath, renderTextWithMath, splitMath } from './render-math.ts';

/**
 * LaTeX 渲染。
 *
 * 背景（2026-11-08 用户报的）：读《信号与系统》时看到的是
 * `$\rho v$ 为正比于汽车速度 $v$ 的摩擦力` ——
 * 那不是乱码，是 MinerU 正确输出了 LaTeX 而我们当纯文本显示。
 * 全文 36 页有 36 处公式。
 */

describe('splitMath：切分文本与公式', () => {
  it('行内公式', () => {
    const p = splitMath('电压 $v_{s}$ 和电流');
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual({ math: false, value: '电压 ' });
    expect(p[1]).toEqual({ math: true, value: 'v_{s}' });
    expect(p[2]).toEqual({ math: false, value: ' 和电流' });
  });

  it('块级公式 $$...$$', () => {
    const p = splitMath('前 $$\\int_0^1 x dx$$ 后');
    const math = p.find((x) => x.math);
    expect(math?.block).toBe(true);
    expect(math?.value).toContain('\\int_0^1');
  });

  /*
   * 这一条是关键：$$ 必须先于 $ 匹配。
   * 否则 `$$x$$` 会被切成「空 $ + $x$ + 空 $」，碎片化。
   */
  it('$$ 优先于 $ 匹配，不会被切碎', () => {
    const p = splitMath('$$a+b$$');
    expect(p).toHaveLength(1);
    expect(p[0]!.math).toBe(true);
    expect(p[0]!.block).toBe(true);
    expect(p[0]!.value).toBe('a+b');
  });

  it('多个行内公式', () => {
    const p = splitMath('$a$ 与 $b$');
    const maths = p.filter((x) => x.math);
    expect(maths).toHaveLength(2);
    expect(maths.map((m) => m.value)).toEqual(['a', 'b']);
  });

  /*
   * 钱不是公式：`价格 $5 到 $10` 里有两个 $，但内容是「5 到 」，
   * 渲染出来是错的。这种要原样保留。
   *
   * 注意：这个用例实际会被切成一个 math 片段（因为恰好成对）——
   * 真正的保护在 renderMath 失败时退回原文（见下面的测试）。
   * 这里只锁「不会崩」。
   */
  it('不成对的 $ 当普通字符，不丢内容', () => {
    const text = '价格 $5 元';
    const p = splitMath(text);
    // 拼回去必须等于原文（无论怎么切）
    const rebuilt = p.map((x) => (x.math ? `$${x.value}$` : x.value)).join('');
    expect(rebuilt).toBe(text);
  });

  it('跨行的 $...$ 不当作公式（行内公式不跨行）', () => {
    const p = splitMath('第一行 $a\nb$ 第二行');
    expect(p.filter((x) => x.math)).toHaveLength(0);
  });

  it('空字符串', () => {
    expect(splitMath('')).toEqual([]);
  });

  it('没有公式时整段是文本', () => {
    const p = splitMath('这是一段没有公式的中文。');
    expect(p).toHaveLength(1);
    expect(p[0]!.math).toBe(false);
  });

  it('公式在开头 / 结尾', () => {
    expect(splitMath('$a$ 后面')[0]!.math).toBe(true);
    expect(splitMath('前面 $a$').at(-1)!.math).toBe(true);
  });
});

describe('escapeHtml：防注入', () => {
  it('转义尖括号与引号', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('转义 & 在最前，避免二次转义', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderMath：单条公式', () => {
  it('正常公式渲染出 katex 结构', () => {
    const html = renderMath('v_{s}');
    expect(html).not.toBeNull();
    expect(html).toContain('katex');
    // 下标应该变成 msub
    expect(html).toContain('msupsub');
  });

  it('块级公式带 display 模式', () => {
    const html = renderMath('\\int_0^1 x dx', true);
    expect(html).toContain('katex-display');
  });

  it('希腊字母', () => {
    const html = renderMath('\\rho v');
    expect(html).not.toBeNull();
    // \rho 渲染成希腊字母 ρ
    expect(html).toContain('ρ');
  });

  it('语法错误返回 null（调用方退回原文）', () => {
    // 不配对的括号是明确的语法错
    expect(renderMath('\\frac{a}{')).toBeNull();
  });

  it('空 LaTeX 不崩', () => {
    // KaTeX 对空串返回空 span，不抛错
    const html = renderMath('');
    expect(html === null || typeof html === 'string').toBe(true);
  });
});

describe('renderTextWithMath：整段渲染', () => {
  /*
   * 这一条用的是用户真实看到的那句话 ——
   * 修完之后它应该渲染出 ρv 而不是显示 $\rho v$。
   */
  it('真实样本：$\rho v$ 渲染成公式', () => {
    const r = renderTextWithMath('$\\rho v$ 为正比于汽车速度 $v$ 的摩擦力');
    expect(r.hasMath).toBe(true);
    expect(r.failed).toBe(0);
    // 不应再出现源码里的 $\rho v$
    expect(r.html).not.toContain('$\\rho v$');
    // 应该出现渲染后的 rho
    expect(r.html).toContain('ρ');
    // 中文完好
    expect(r.html).toContain('为正比于汽车速度');
  });

  it('真实样本：电压 $v_{s}$', () => {
    const r = renderTextWithMath('图1.1 含有电压源 $v_{s}$ 和电容器');
    expect(r.hasMath).toBe(true);
    expect(r.html).toContain('msupsub');
    expect(r.html).toContain('含有电压源');
  });

  it('没有公式时原样输出（只做转义）', () => {
    const r = renderTextWithMath('这是一段 <纯文本> & 符号');
    expect(r.hasMath).toBe(false);
    expect(r.html).toBe('这是一段 &lt;纯文本&gt; &amp; 符号');
  });

  /*
   * 渲染失败时退回原文：用户宁可看到 `$...$` 源码，
   * 也不要看到 KaTeX 的红色报错块 —— 那个更吓人也更没用。
   */
  it('公式语法错误 → 退回原文，不丢内容', () => {
    const r = renderTextWithMath('坏公式 $\\frac{a}{$ 后面');
    expect(r.failed).toBeGreaterThan(0);
    // 原文内容仍然在
    expect(r.html).toContain('\\frac{a}{');
    expect(r.html).toContain('后面');
  });

  it('转义普通文本里的 HTML，防止注入', () => {
    const r = renderTextWithMath('<img src=x onerror=alert(1)> 与 $a$');
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img');
  });

  it('块级公式渲染', () => {
    const r = renderTextWithMath('$$\\sum_{i=1}^{n} i$$');
    expect(r.html).toContain('katex-display');
  });

  it('多个公式都渲染', () => {
    const r = renderTextWithMath('$a$ 和 $b$ 和 $c$');
    const count = (r.html.match(/katex/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 用真实资料的原文回归 —— 这些句子是从用户库里抄的。
 */
describe('真实教材文本', () => {
  it('第一页那段（含两个公式）', () => {
    const text =
      '图1.1 含有电压源 $v_{s}$ 和电容器\n\n电压 $v_{e}$ 的简单电路\n\n图1.2 一辆汽车。 $f$ 为来自发动机的外加力，\n\n$\\rho v$ 为正比于汽车速度 $v$ 的摩擦力';
    const r = renderTextWithMath(text);
    expect(r.hasMath).toBe(true);
    expect(r.failed).toBe(0);
    // 所有公式都被渲染了（源码里的 $ 不应该残留成 $xxx$ 形式）
    expect(r.html).not.toMatch(/\$\\?[a-zA-Z]/);
  });
});
