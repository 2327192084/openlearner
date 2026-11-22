import { describe, expect, it } from 'vitest';
import {
  calloutKindOf,
  cardTitleOf,
  renderInlineMarkdown,
  renderRichLine,
  renderRichText,
  splitRichLines,
  splitFrontTitle,
} from './card-rich.ts';

/**
 * 闪卡富文本渲染（2026-11-22，用户给了 Obsidian callout 参考图）。
 *
 * ## 这组测试最重要的一条
 *
 * **公式里的 `**` 不能被当成加粗。**
 *
 * 实现过程中我一开始写的是「先整行渲染数学、再对 HTML 做 markdown」，
 * 并用 KaTeX 实测否掉了自己：
 *
 *   renderToString('a ** b')  →  输出里真的有连续的 `**`
 *
 * 那种做法会把公式内容转成 `<strong>`，公式渲染就坏了。
 * 现在改成「先 splitMath 切段，markdown 只作用于非公式段」——
 * 下面有专门的用例钉住这件事。**如果以后有人改回整行处理，这几条会变红。**
 */

describe('splitRichLines：行角色判定', () => {
  it('✅ 开头是答案行', () => {
    const [l] = splitRichLines('✅答案：e³');
    expect(l!.role).toBe('answer');
    expect(l!.body).toBe('答案：e³');
  });

  it('💡 开头是要点行', () => {
    const [l] = splitRichLines('💡要点：');
    expect(l!.role).toBe('point');
  });

  it('⚠️ 开头是警示行（带/不带变体选择符都认）', () => {
    expect(splitRichLines('⚠️限制条件：x')[0]!.role).toBe('warn');
    /* U+26A0 不带 U+FE0F */
    expect(splitRichLines('⚠限制条件：x')[0]!.role).toBe('warn');
  });

  it('⚠️ 星号在**行中**不算标记行（"答案对 ✅"不该变绿）', () => {
    const [l] = splitRichLines('这个答案对 ✅');
    expect(l!.role).toBe('plain');
  });

  it('编号列表 1. / 1、/ 1) 都认', () => {
    expect(splitRichLines('1. 万能公式')[0]!.role).toBe('ordered');
    expect(splitRichLines('2、拓展公式')[0]!.role).toBe('ordered');
    expect(splitRichLines('3) 另一种')[0]!.role).toBe('ordered');
  });

  it('⚠️ 「1.8 节」这种不被误判成列表（编号必须 ≤20 且后面有内容）', () => {
    /* "1.8 极限" 里 1.8 不是列表序号 */
    const [l] = splitRichLines('1.8 无穷远处极限');
    expect(l!.role).toBe('plain');
  });

  it('编号超过 20 不当列表（多半是正文以数字开头）', () => {
    expect(splitRichLines('2024 年的真题')[0]!.role).toBe('plain');
  });

  it('无序列表 - 与 •', () => {
    expect(splitRichLines('- 甲')[0]!.role).toBe('bullet');
    expect(splitRichLines('• 甲')[0]!.role).toBe('bullet');
  });

  it('空行被丢掉（否则卡片虚高）', () => {
    const out = splitRichLines('甲\n\n\n乙');
    expect(out).toHaveLength(2);
  });

  it('用户图三那段真实文本：角色全对', () => {
    const back = [
      '**题目**',
      '$$\\lim\\limits_{x \\to \\infty}\\left(\\dfrac{x+2}{x-1}\\right)^x$$',
      '✅答案：$\\boldsymbol{e^3}$',
      '💡要点：',
      '1. $1^\\infty$未定式，万能公式 $\\lim u^v=e^{\\lim v(u-1)}$',
      '2. 拓展简化公式：$x$',
      '⚠️限制条件：简化公式只适用于底数为$1+\\dfrac{a}{x}$',
    ].join('\n');
    const lines = splitRichLines(back);
    expect(lines.map((l) => l.role)).toEqual([
      'plain',
      'plain',
      'answer',
      'point',
      'ordered',
      'ordered',
      'warn',
    ]);
    expect(lines[4]!.order).toBe(1);
    expect(lines[5]!.order).toBe(2);
  });
});

describe('renderInlineMarkdown：只处理加粗与行内代码', () => {
  it('**加粗** 转 strong', () => {
    expect(renderInlineMarkdown('**题目**')).toContain('<strong');
    expect(renderInlineMarkdown('**题目**')).toContain('题目');
  });

  it('`代码` 转 code', () => {
    expect(renderInlineMarkdown('用 `x^2` 表示')).toContain('<code');
  });

  it('代码里的星号不当加粗', () => {
    const out = renderInlineMarkdown('`a ** b`');
    expect(out).not.toContain('<strong');
    expect(out).toContain('<code');
  });

  it('不认 _斜体_（数学下标 x_1 极常见，认了会吃掉公式）', () => {
    expect(renderInlineMarkdown('x_1 与 x_2')).not.toContain('<em');
  });

  it('单个星号不动（LaTeX 乘号等）', () => {
    expect(renderInlineMarkdown('f * g')).toBe('f * g');
  });
});

describe('⚠️ 公式与 markdown 的边界（推翻过的假设钉在这里）', () => {
  /**
   * 这几条是本轮最容易回归的地方。
   * 坏实现（先整行 renderTextWithMath 再对 HTML 做 markdown）
   * 会让下面第一条变红。
   */
  /**
   * ⚠️ 这条断言守的是**设计约定**，实测拦不住坏实现 —— 说清楚。
   *
   * 我原本以为「公式里的星号」能区分两种实现，做反向验证时
   * 把实现改坏（先整行渲染数学、再对 HTML 做 markdown），
   * **测试照样全绿**。用真实模块打印后查出了原因：
   *
   *   KaTeX 会把 ASCII 的 `*` 转成 `∗`（U+2217），
   *   所以公式渲染结果里根本没有可被加粗规则匹配的 ASCII 星号。
   *
   * 也就是说两种实现在这个输入上**行为相同**。保留这条断言的理由：
   *  - 它把「markdown 不进公式段」这个设计约定钉住，
   *    以后有人改 `render-math`（比如不再转换 `*`）时它会变成真防线
   *  - 好实现的分段结构本身就是正确写法，不该退化成"对 HTML 做正则"
   *
   * 教训：**反向验证没变红，先怀疑断言，别怀疑实现。**
   */
  it('公式里的 `**` 不会被转成 strong', () => {
    const [l] = renderRichText('$a ** b ** c$');
    expect(l!.html).not.toContain('<strong');
    /* 公式内容进了 KaTeX（输出含 katex 类名） */
    expect(l!.html).toContain('katex');
  });

  it('公式外的 `**` 正常加粗', () => {
    const [l] = renderRichText('**题目**');
    expect(l!.html).toContain('<strong');
  });

  it('同一行里公式外加粗、公式内星号各归各', () => {
    const [l] = renderRichText('✅答案：**e³**，公式 $a ** b ** c$');
    /*
     * 只应有**一处** strong（来自 **e³**）。
     * 坏实现会多出一处（把公式里的 `** b **` 也加粗）。
     */
    const strongCount = (l!.html.match(/<strong/g) || []).length;
    expect(strongCount).toBe(1);
    expect(l!.html).toContain('e³');
  });

  it('HTML 被转义（卡片内容不可信）', () => {
    const [l] = renderRichText('<img src=x onerror=alert(1)>');
    expect(l!.html).not.toContain('<img');
    expect(l!.html).toContain('&lt;img');
  });

  it('公式渲染失败退回原文（不显示 KaTeX 红色错误块）', () => {
    /* \frac 缺参数 → 渲染失败 */
    const [l] = renderRichText('$\\frac$');
    expect(l!.html).toContain('$');
    /* 不是 katex-error 那种 */
    expect(l!.html).not.toContain('katex-error');
  });

  it('块公式 $$...$$ 正常渲染', () => {
    const [l] = renderRichText('$$\\lim\\limits_{x \\to \\infty}x^2$$');
    expect(l!.html).toContain('katex');
  });
});

describe('cardTitleOf：callout 头部的短标题', () => {
  it('短正面原样用', () => {
    expect(cardTitleOf('题1.8 无穷远处极限')).toBe('题1.8 无穷远处极限');
  });

  it('取第一行（多行正面不拼起来）', () => {
    expect(cardTitleOf('第一行\n第二行')).toBe('第一行');
  });

  it('超长在标点处断', () => {
    const t = cardTitleOf('两个周期信号之和的周期性取决于周期之比：若为有理数，和仍为周期信号，其基波周期是二者周期的最小公倍数');
    expect(t.length).toBeLessThanOrEqual(47);
    expect(t).toContain('…');
    /* 断在冒号处 —— 后半句不该出现 */
    expect(t).not.toContain('最小公倍数');
  });

  it('空正面给占位文字（不留空白头部）', () => {
    expect(cardTitleOf('')).toBe('（没有正面）');
  });

  it('没有标点可断时硬切加省略号', () => {
    const t = cardTitleOf('字'.repeat(80));
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('calloutKindOf：三组卡片的类型分配', () => {
  /**
   * 用户只给了**错题卡**的格式（[!tip]）。
   * 知识点与手写按同样思路配，理由写在实现注释里。
   */
  it('错题 → tip（用户给的那种）', () => {
    expect(calloutKindOf('wrong')).toBe('tip');
  });

  it('知识点 → note（中性陈述，不该用提示色抢注意力）', () => {
    expect(calloutKindOf('point')).toBe('note');
  });

  it('手写 → quote（自己写的更像摘录）', () => {
    expect(calloutKindOf('manual')).toBe('quote');
  });

  it('三种类型互不相同（否则版式没意义）', () => {
    const kinds = new Set(['wrong', 'point', 'manual'].map((g) => calloutKindOf(g as never)));
    expect(kinds.size).toBe(3);
  });
});

describe('renderRichLine：不丢内容', () => {
  it('每行都产出 html（渲染失败也不能丢字）', () => {
    const lines = renderRichText('甲\n乙\n丙');
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l.html.length).toBeGreaterThan(0);
    }
  });

  /* renderRichLine 收一行、返回一行（不是数组）—— 上一版我按数组解构了 */
  it('body 与 raw 都保留（编辑时还要用原文）', () => {
    const l = renderRichLine({
      raw: '✅答案：e³',
      role: 'answer',
      body: '答案：e³',
      order: null,
    });
    expect(l.raw).toBe('✅答案：e³');
    expect(l.body).toBe('答案：e³');
    expect(l.role).toBe('answer');
  });

  it('空文本 → 零行（不崩）', () => {
    expect(renderRichText('')).toEqual([]);
    expect(renderRichText('   \n  \n')).toEqual([]);
  });
});
describe('splitFrontTitle：标题不能重述正文（2026-11-23 修的缺陷）', () => {
  /**
   * ## 这个函数为什么存在
   *
   * 上一版 callout 是「标题 = 正面第一行截断」，而**正文仍然渲染整段正面**。
   * 用户库里的卡正面基本都是单行长句（实测第一张 66 字、只有一行），
   * 于是每张卡都把同一句话显示两遍：
   *
   *   头部：两个周期信号之和的周期性取决于周期之比：若为有理数…
   *   正文：两个周期信号之和的周期性取决于周期之比：若为有理数，和仍为…
   *
   * 截图才发现，33 条断言一条都没报。
   *
   * ## 判据要点
   *
   * 单行正面必须 `title === null` —— 这条是整个修复的核心。
   * 坏实现（永远把第一行当标题）会让下面第二条变红。
   */
  it('图三那种多行正面：第一行是标题，其余是正文', () => {
    const front = '题1.8 $1^\infty$无穷远处极限【新增拓展公式】\n补充说明一行';
    const r = splitFrontTitle(front);
    expect(r.title).toBe('题1.8 $1^\infty$无穷远处极限【新增拓展公式】');
    expect(r.body).toBe('补充说明一行');
  });

  it('⚠️ 单行长句正面：没有标题（否则正文会被重述一遍）', () => {
    const front =
      '两个周期信号之和的周期性取决于周期之比：若为有理数，和仍为周期信号，其基波周期是二者周期的最小公倍数；若为无理数，和不再是周期信号。';
    const r = splitFrontTitle(front);
    /* 坏实现会给一个标题 —— 那样头部和正文就是同一句话 */
    expect(r.title).toBeNull();
    expect(r.body).toBe(front);
  });

  it('标题与正文不重叠（body 里不含 title 那行）', () => {
    const front = '甲\n乙\n丙';
    const r = splitFrontTitle(front);
    expect(r.title).toBe('甲');
    expect(r.body).toBe('乙\n丙');
    /* 这条断言直接钉住"不重述" */
    expect(r.body).not.toContain('甲');
  });

  it('空正面 → 无标题、空正文（不崩）', () => {
    expect(splitFrontTitle('')).toEqual({ title: null, body: '' });
  });

  it('只有空白行 → 无标题、正文为空（不是把空白原样返回）', () => {
    /* 实现走 front.trim()，空白正面得到空串 —— 正文渲染时是零行 */
    expect(splitFrontTitle('  \n  \n')).toEqual({ title: null, body: '' });
  });

  it('多行但每行都空 → 无标题', () => {
    const r = splitFrontTitle('  \n   ');
    expect(r.title).toBeNull();
  });

  it('正面首尾空白不影响判定', () => {
    const r = splitFrontTitle('\n  甲  \n  乙  \n');
    expect(r.title).toBe('甲');
    expect(r.body).toBe('乙');
  });
});
