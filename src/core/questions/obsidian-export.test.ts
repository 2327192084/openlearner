import { describe, expect, it } from 'vitest';
import {
  deckToObsidianMarkdown,
  obsidianFileName,
  questionToFlashcard,
  wrapFormulas,
} from './obsidian-export.ts';
import type { Question } from '@/core/model.ts';

/**
 * Obsidian 闪卡导出。
 *
 * 语法依据：`st3v3nmw/obsidian-spaced-repetition` 的
 * `docs/docs/zh/flashcards.md`（官方文档，通过 GitHub API 取的）。
 *
 * 这些测试的作用：**格式错一个字符，卡片在 Obsidian 里就认不出来** ——
 * 而那种错误在本应用的界面上完全看不到（导出的文件在别人电脑上打开才知道）。
 * 所以必须用测试钉死。
 */

const q = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  deckId: 'd1',
  kind: 'single',
  prompt: '关于离散时间周期信号，以下说法正确的是？',
  options: [
    { key: 'A', text: '存在正整数 N 使 x[n]=x[n+N]' },
    { key: 'B', text: '周期可以是任意正实数' },
  ],
  answer: 'A',
  explanation: '离散时间周期信号的周期必须是整数。',
  anchors: [],
  knowledgePointId: null,
  cognitiveLevel: 'understand',
  topic: null,
  order: 0,
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
  ...over,
});

describe('questionToFlashcard：多行卡格式', () => {
  it('用单独一行的 ? 分隔正反面', () => {
    const card = questionToFlashcard(q(), { wrapFormulas: false });
    const lines = card.split('\n');
    // ? 必须独占一行（前后不能有别的字符）
    expect(lines).toContain('?');
    const idx = lines.indexOf('?');
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(lines.length - 1);
  });

  it('正面包含题干与全部选项', () => {
    const card = questionToFlashcard(q(), { wrapFormulas: false });
    const front = card.split('\n?')[0]!;
    expect(front).toContain('离散时间周期信号');
    expect(front).toContain('A) ');
    expect(front).toContain('B) ');
  });

  it('反面包含答案与解析', () => {
    const card = questionToFlashcard(q(), { wrapFormulas: false });
    const back = card.split('\n?\n')[1]!;
    expect(back).toContain('**A**');
    // 单选要把 key 换成选项文本，不然导出后看不懂 A 是什么
    expect(back).toContain('存在正整数 N');
    expect(back).toContain('周期必须是整数');
  });

  it('多选题的答案逐行列出每个选项', () => {
    const card = questionToFlashcard(
      q({
        kind: 'multiple',
        options: [
          { key: 'A', text: '任何信号可分解' },
          { key: 'B', text: '偶部定义' },
          { key: 'C', text: '奇部定义' },
        ],
        answer: 'A,B,C',
      }),
      { wrapFormulas: false },
    );
    const back = card.split('\n?\n')[1]!;
    expect(back).toContain('**A**：任何信号可分解');
    expect(back).toContain('**B**：偶部定义');
    expect(back).toContain('**C**：奇部定义');
  });

  it('填空题没有选项，正面只有题干', () => {
    const card = questionToFlashcard(
      q({ kind: 'blank', options: [], answer: '(-1)^n', prompt: 'e^{jπn} 等于______' }),
      { wrapFormulas: false },
    );
    const front = card.split('\n?')[0]!;
    expect(front).not.toContain(') ');
    expect(card).toContain('(-1)^n');
  });

  it('判断题的 T/F 也能转成文字', () => {
    const card = questionToFlashcard(
      q({
        kind: 'truefalse',
        options: [
          { key: 'T', text: '对' },
          { key: 'F', text: '错' },
        ],
        answer: 'T',
        prompt: '所有无记忆系统都是因果系统。',
      }),
      { wrapFormulas: false },
    );
    expect(card).toContain('**T**：对');
  });

  it('带出处时附在反面末尾', () => {
    const card = questionToFlashcard(q(), { wrapFormulas: false, includeSource: true }, '信号与系统 第 9 页');
    expect(card).toContain('*出处：信号与系统 第 9 页*');
  });
});

describe('deckToObsidianMarkdown：文件结构', () => {
  it('顶部有 #flashcards 标签（插件靠它识别）', () => {
    const { content } = deckToObsidianMarkdown('错题集', [q()]);
    expect(content).toContain('#flashcards');
  });

  it('自定义标签', () => {
    const { content } = deckToObsidianMarkdown('错题集', [q()], { tag: '考研错题' });
    expect(content).toContain('#考研错题');
    expect(content).not.toContain('#flashcards');
  });

  it('卡片之间用空行分隔（否则会被连成一张卡）', () => {
    const { content } = deckToObsidianMarkdown('错题集', [q(), q({ id: 'q2', prompt: '第二题' })], {
      wrapFormulas: false,
    });
    // 两张卡之间必须有两个换行
    expect(content).toMatch(/\n\n/);
    // 两张卡的 ? 都独占一行
    const sepLines = content.split('\n').filter((l) => l === '?');
    expect(sepLines).toHaveLength(2);
  });

  it('返回卡片数', () => {
    const r = deckToObsidianMarkdown('错题集', [q(), q({ id: 'q2' }), q({ id: 'q3' })]);
    expect(r.count).toBe(3);
  });

  it('空题组 → 只有头部，count 为 0', () => {
    const r = deckToObsidianMarkdown('空题组', []);
    expect(r.count).toBe(0);
    expect(r.content).toContain('#flashcards');
  });

  it('题目里本身有 ?? 或 :: 不会破坏格式', () => {
    // 插件也支持 ::: 与 ??，但我们的内容里出现这些字符不应该被误解析
    const { content } = deckToObsidianMarkdown(
      '测试',
      [q({ prompt: '什么是 C::P 关系？以及 a??b 是什么？' })],
      { wrapFormulas: false },
    );
    expect(content).toContain('C::P');
    // 分隔符仍然只有我们自己加的那个
    const sepLines = content.split('\n').filter((l) => l === '?');
    expect(sepLines).toHaveLength(1);
  });
});

describe('wrapFormulas：纯文本公式 → LaTeX', () => {
  it('上下标记号会被包成 $...$', () => {
    const out = wrapFormulas('信号 e^{jπn} 等于');
    expect(out).toContain('$');
    expect(out).toContain('e^{j\\pi n}');
  });

  it('含中文的片段不包（中文进公式会乱码）', () => {
    const out = wrapFormulas('这是一个普通的中文句子，没有公式。');
    expect(out).toBe('这是一个普通的中文句子，没有公式。');
  });

  it('纯中文不受影响', () => {
    expect(wrapFormulas('离散时间信号的定义')).toBe('离散时间信号的定义');
  });

  it('已经包好的 $...$ 不会重复包', () => {
    const input = '公式 $e^{j\\pi n}$ 已经写好了';
    const out = wrapFormulas(input);
    expect(out).toBe(input);
    // 不能出现 $$
    expect(out).not.toContain('$$');
  });

  it('函数记号 x(t) 会被包', () => {
    const out = wrapFormulas('奇信号满足 x(-t)=-x(t)');
    expect(out).toMatch(/\$[^$]*x\(-t\)/);
  });

  it('希腊字母转成 LaTeX 命令', () => {
    const out = wrapFormulas('频率 ω 与 π 的关系');
    expect(out).toContain('\\omega');
    expect(out).toContain('\\pi');
  });

  it('不等式符号转换', () => {
    const out = wrapFormulas('当 n ≤ 10 时');
    expect(out).toContain('\\le');
  });

  it('空字符串安全', () => {
    expect(wrapFormulas('')).toBe('');
  });

  it('单个字母不包（太短，不值得）', () => {
    expect(wrapFormulas('变量 a 的值')).toBe('变量 a 的值');
  });

  it('符号表达式 (-1)^n 会被包', () => {
    const out = wrapFormulas('答案 (-1)^n');
    const stripped = out.replace(/\s/g, '');
    expect(stripped).toContain('(-1)^n');
    expect(stripped).toContain('$');
  });
});

describe('obsidianFileName', () => {
  it('去掉文件系统不认的字符', () => {
    expect(obsidianFileName('第1章/信号:与"系统"')).toBe('第1章-信号-与-系统-.md');
  });

  it('空标题给兜底名', () => {
    expect(obsidianFileName('')).toBe('错题闪卡.md');
  });

  it('过长标题截断', () => {
    const name = obsidianFileName('x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(84);
    expect(name.endsWith('.md')).toBe(true);
  });
});

/**
 * 用真实题库里的内容做回归 —— 这些形状是从用户库里抄的。
 * 导出的东西最终要在 Obsidian 里能读，所以测真实文本比测构造文本有用。
 */
describe('真实题目形状', () => {
  it('填空题：e^{jπn} 会被包成公式，中文保留', () => {
    const card = questionToFlashcard(
      q({
        kind: 'blank',
        options: [],
        prompt: '在离散时间复指数信号中，当频率ω₀=π（或π的奇数倍）时，信号e^{jπn}等于______，以至于信号在每一点上都改变符号。',
        answer: '(-1)^n',
        explanation: '由e^{jπn}=(e^{jπ})^n=(-1)^n，信号在相邻样本间符号交替。',
      }),
      {},
    );
    // 关键点：中文没被裹进公式
    expect(card).toContain('在离散时间复指数信号中');
    // 公式被包了
    expect(card).toMatch(/\$[^$]*e\^\{j/);
    // 分隔符仍独占一行
    expect(card.split('\n').filter((l) => l === '?')).toHaveLength(1);
  });

  it('多选题：选项里的公式也被包，但中文描述完好', () => {
    const card = questionToFlashcard(
      q({
        kind: 'multiple',
        options: [
          { key: 'A', text: '任何信号都能分解为偶信号与奇信号之和' },
          { key: 'B', text: '偶部定义为Ev{x(t)}=[x(t)+x(-t)]/2' },
        ],
        answer: 'A,B',
        prompt: '关于信号的偶部与奇部，下列说法正确的有？',
        explanation: '偶部为[x(t)+x(-t)]/2。',
      }),
      {},
    );
    expect(card).toContain('任何信号都能分解为偶信号与奇信号之和');
    expect(card).toMatch(/\$[^$]*x\(t\)/);
  });
});

/**
 * Unicode 上下标的转换（2026-11-08 真实导出里发现的 bug）。
 *
 * `²` 是 U+00B2，不在 Unicode 上标区 U+2070–2079 里 ——
 * 只按区间减偏移会算出 -8126，导出的公式里出现 `^{-8126}` 这种乱码。
 */
describe('Unicode 上下标转换', () => {
  it('² (U+00B2) 转成 ^{2}，不是负数', () => {
    const out = wrapFormulas('|x[n]|²');
    expect(out).toContain('^{2}');
    expect(out).not.toContain('-8126');
  });

  it('³ (U+00B3) 转成 ^{3}', () => {
    const out = wrapFormulas('体积 a³');
    expect(out).toContain('^{3}');
  });

  it('₀ (U+2080) 转成 _{0}', () => {
    const out = wrapFormulas('频率 ω₀');
    expect(out).toContain('_{0}');
  });

  it('⁰ (U+2070) 转成 ^{0}', () => {
    const out = wrapFormulas('指数 1⁰');
    expect(out).toContain('^{0}');
  });
});
