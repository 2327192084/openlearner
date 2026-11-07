import { describe, expect, it } from 'vitest';
import { parseDeckJson, ImportError } from './import-json.ts';

/**
 * JSON 题组导入的测试。
 *
 * ## 为什么这组测试以「拒绝」为主
 *
 * 导入是把**外部数据**放进用户的题库。外部 JSON 可能来自别的软件、
 * 手写、或者被聊天窗口截断过。宽松接受是必要的（否则用户没法用），
 * 但**坏数据必须当场拒绝并说清第几题**，不能悄悄导进来 ——
 * 那种题在复习时表现为「没有选项的单选题」「答案是 E 但只有 ABCD」，
 * 用户只会觉得软件坏了。
 */

/** 一条最小的合法题目 */
const q = (over: Record<string, unknown> = {}) => ({
  kind: 'single',
  prompt: '以下哪项正确？',
  options: [
    { key: 'A', text: '选项一' },
    { key: 'B', text: '选项二' },
  ],
  answer: 'A',
  explanation: '因为……',
  ...over,
});

describe('parseDeckJson：OpenLeaner 自己导出的格式', () => {
  it('能读回自己导出的结构', () => {
    const json = JSON.stringify({
      format: 'openleaner-deck',
      version: 1,
      deck: { title: '第一章 · 题组', status: 'published' },
      questions: [q()],
    });
    const out = parseDeckJson(json);
    expect(out.format).toBe('openleaner');
    expect(out.title).toBe('第一章 · 题组');
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]!.prompt).toBe('以下哪项正确？');
  });

  it('标题优先取 deck.title', () => {
    const json = JSON.stringify({
      format: 'openleaner-deck',
      deck: { title: '来自 deck' },
      title: '来自顶层',
      questions: [q()],
    });
    expect(parseDeckJson(json).title).toBe('来自 deck');
  });
});

describe('parseDeckJson：外部通用格式', () => {
  it('接受 {title, questions}', () => {
    const out = parseDeckJson(JSON.stringify({ title: '外部题', questions: [q()] }));
    expect(out.format).toBe('generic');
    expect(out.title).toBe('外部题');
  });

  it('接受 {title, cards}', () => {
    const out = parseDeckJson(JSON.stringify({ title: 'Anki 风格', cards: [q()] }));
    expect(out.questions).toHaveLength(1);
  });

  it('接受裸数组', () => {
    const out = parseDeckJson(JSON.stringify([q(), q({ prompt: '第二题？' })]));
    expect(out.questions).toHaveLength(2);
    expect(out.title).toBe('导入的题组');
  });

  it('剥掉 markdown 围栏（从聊天窗口复制的常见情况）', () => {
    const json = '```json\n' + JSON.stringify({ title: 'T', questions: [q()] }) + '\n```';
    expect(parseDeckJson(json).questions).toHaveLength(1);
  });

  it('题干字段名可以叫 question / 题干', () => {
    const a = parseDeckJson(JSON.stringify([{ question: '问一', answer: '答', kind: 'blank' }]));
    expect(a.questions[0]!.prompt).toBe('问一');

    const b = parseDeckJson(JSON.stringify([{ 题干: '问二', 答案: '答', kind: 'blank' }]));
    expect(b.questions[0]!.prompt).toBe('问二');
    expect(b.questions[0]!.answer).toBe('答');
  });

  it('选项可以写成纯字符串数组（key 自动编 A/B/C）', () => {
    const out = parseDeckJson(
      JSON.stringify([{ prompt: '选一个', options: ['甲', '乙'], answer: 'A' }]),
    );
    expect(out.questions[0]!.options).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
  });

  it('题型别名归一（单选/choice/判断/boolean…）', () => {
    const cases: [string, string][] = [
      ['单选', 'single'],
      ['choice', 'single'],
      ['多选', 'multiple'],
      ['checkbox', 'multiple'],
      ['判断', 'truefalse'],
      ['boolean', 'truefalse'],
      ['填空', 'blank'],
      ['fill', 'blank'],
      ['问答', 'essay'],
      ['open', 'essay'],
    ];
    for (const [alias, expected] of cases) {
      /*
       * 每种题型构造一条**内部一致**的数据：
       * 选择题的答案必须真的在选项里，否则会被（正确地）拒绝。
       * 一开始这里答案写的 'x' 而选项是 'a'，测试自己挂了 ——
       * 那是测试数据的问题，不是代码的问题。
       */
      const item =
        expected === 'truefalse'
          ? { kind: alias, prompt: '判断', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer: 'T' }
          : expected === 'single'
            ? { kind: alias, prompt: '题', options: [{ key: 'A', text: 'a' }], answer: 'A' }
            : expected === 'multiple'
              ? { kind: alias, prompt: '题', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], answer: 'A,B' }
              : { kind: alias, prompt: '题', answer: '任意文本', options: [] };
      const out = parseDeckJson(JSON.stringify([item]));
      expect(out.questions[0]!.kind).toBe(expected);
    }
  });

  it('没写题型时按选项数量猜（2 个 → 判断，有选项 → 单选，无 → 填空）', () => {
    const two = parseDeckJson(JSON.stringify([{ prompt: 'p', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer: 'T' }]));
    expect(two.questions[0]!.kind).toBe('truefalse');

    const three = parseDeckJson(
      JSON.stringify([{ prompt: 'p', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }], answer: 'A' }]),
    );
    expect(three.questions[0]!.kind).toBe('single');

    const none = parseDeckJson(JSON.stringify([{ prompt: 'p', answer: 'a' }]));
    expect(none.questions[0]!.kind).toBe('blank');
  });

  it('记录被丢弃的未知字段（如实告知）', () => {
    const out = parseDeckJson(
      JSON.stringify([q({ 未知字段: 1, anotherThing: 'x' })]),
    );
    expect(out.droppedFields).toContain('未知字段');
    expect(out.droppedFields).toContain('anotherThing');
  });
});

describe('parseDeckJson：拒绝坏数据', () => {
  it('空内容', () => {
    expect(() => parseDeckJson('')).toThrow(ImportError);
    expect(() => parseDeckJson('   ')).toThrow(/空/);
  });

  it('JSON 语法错误要说清是语法问题', () => {
    expect(() => parseDeckJson('{ 不是 json }')).toThrow(/JSON 格式错误/);
  });

  it('顶层是字符串/数字', () => {
    expect(() => parseDeckJson('"hello"')).toThrow(ImportError);
    expect(() => parseDeckJson('123')).toThrow(ImportError);
  });

  it('找不到题目数组', () => {
    expect(() => parseDeckJson('{"title":"x"}')).toThrow(/找不到题目数组/);
  });

  it('题目数组是空的', () => {
    expect(() => parseDeckJson('{"questions":[]}')).toThrow(/空的/);
  });

  it('某道题缺题干时指出第几题', () => {
    try {
      parseDeckJson(JSON.stringify([q(), { answer: 'A' }]));
      throw new Error('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).questionIndex).toBe(2);
      expect((err as ImportError).message).toMatch(/第 2 题/);
    }
  });

  it('某道题缺答案时指出第几题', () => {
    try {
      parseDeckJson(JSON.stringify([{ prompt: '只有题干' }]));
      throw new Error('应该抛错');
    } catch (err) {
      expect((err as ImportError).questionIndex).toBe(1);
      expect((err as ImportError).message).toMatch(/答案/);
    }
  });

  it('**选择题的答案不在选项里要拒绝**（否则做题时判分永远错）', () => {
    try {
      parseDeckJson(JSON.stringify([q({ answer: 'E' })]));
      throw new Error('应该抛错');
    } catch (err) {
      expect((err as ImportError).message).toMatch(/不在选项里/);
      expect((err as ImportError).hint).toMatch(/A\/B/);
    }
  });

  it('判断题答案不是对/错要拒绝', () => {
    expect(() =>
      parseDeckJson(
        JSON.stringify([
          { kind: 'truefalse', prompt: '判断', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer: '也许' },
        ]),
      ),
    ).toThrow(/不是对\/错/);
  });

  it('不认识的题型要拒绝（不静默当成单选）', () => {
    expect(() => parseDeckJson(JSON.stringify([q({ kind: '连线题' })]))).toThrow(/不认识/);
  });

  it('options 不是数组要拒绝', () => {
    expect(() => parseDeckJson(JSON.stringify([q({ options: 'A,B' })]))).toThrow(/不是数组/);
  });
});

describe('parseDeckJson：判断题与答案归一', () => {
  const tf = (answer: unknown) =>
    parseDeckJson(
      JSON.stringify([
        { kind: 'truefalse', prompt: '判断', options: [{ key: 'T', text: '对' }, { key: 'F', text: '错' }], answer },
      ]),
    ).questions[0]!;

  it('T / 对 / true 都归一成 T', () => {
    expect(tf('T').answer).toBe('T');
    expect(tf('对').answer).toBe('T');
    expect(tf('true').answer).toBe('T');
    expect(tf(true).answer).toBe('T');
  });

  it('F / 错 / false 都归一成 F', () => {
    expect(tf('F').answer).toBe('F');
    expect(tf('错').answer).toBe('F');
    expect(tf('false').answer).toBe('F');
    expect(tf(false).answer).toBe('F');
  });

  it('判断题的选项被强制成固定的对/错（不信外部给的）', () => {
    const out = tf('T');
    expect(out.options).toEqual([
      { key: 'T', text: '对' },
      { key: 'F', text: '错' },
    ]);
  });

  it('多选答案支持数组写法', () => {
    const out = parseDeckJson(
      JSON.stringify([
        {
          kind: 'multiple',
          prompt: '多选',
          options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }],
          answer: ['A', 'C'],
        },
      ]),
    );
    expect(out.questions[0]!.answer).toBe('A,C');
  });
});

describe('parseDeckJson：认知层级', () => {
  const lv = (level: string) =>
    parseDeckJson(JSON.stringify([q({ cognitiveLevel: level }), q({ cognitiveLevel: level, prompt: 'p2' })]))
      .questions[0]!.cognitiveLevel;

  it('认识标准值与中文', () => {
    expect(lv('understand')).toBe('understand');
    expect(lv('理解')).toBe('understand');
    expect(lv('apply')).toBe('apply');
    expect(lv('analyze')).toBe('analyze');
  });

  it('认不出时退回 remember（不猜更高的层级）', () => {
    expect(lv('最高级')).toBe('remember');
    expect(lv('')).toBe('remember');
  });
});
