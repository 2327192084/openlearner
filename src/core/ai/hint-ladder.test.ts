import { describe, expect, it } from 'vitest';
import {
  buildHintPrompt,
  HINT_STEPS,
  judgeMasteryWithHints,
  parseHint,
  STRONG_HINT_FROM,
  type HintLevel,
} from './hint-ladder.ts';

/**
 * 提示阶梯的纯逻辑测试。
 *
 * ## 两组断言各自在防什么
 *
 * 1. **阶梯真的是递增的**：四级提示的要求必须层层不同（信息量递增）。
 *    如果四级只是"同一句话换个说法"，用户点四级等于把答案看四遍。
 *
 * 2. **强提示后答对不算真会**：这是整个功能里最要紧的一条。
 *    做错的后果是系统性的 —— 让间隔调度误以为学会了，
 *    从而把一道"看了答案才会"的题推向"很熟"。提示于是成了安慰剂。
 */

const BASE = {
  prompt: '下列各组函数中，表示同一个函数的是？',
  kind: 'single',
  options: [
    { key: 'A', text: 'f(x)=x 与 g(x)=√(x²)' },
    { key: 'B', text: 'f(x)=lg x² 与 g(x)=2 lg x' },
  ],
  answer: 'B',
  explanation: '定义域与对应关系都相同才叫同一个函数。',
  given: '',
};

describe('阶梯定义', () => {
  it('四级，级别连续（1..4）', () => {
    expect(HINT_STEPS).toHaveLength(4);
    expect(HINT_STEPS.map((s) => s.level)).toEqual([1, 2, 3, 4]);
  });

  it('**每一级的要求互不相同**（不能是同一句话换说法）', () => {
    const set = new Set(HINT_STEPS.map((s) => s.instruction));
    expect(set.size).toBe(4);
  });

  it('只有 3–4 级带「不算真会」的警告（1–2 级不带）', () => {
    expect(HINT_STEPS.filter((s) => s.warning !== null).map((s) => s.level)).toEqual([3, 4]);
    expect(STRONG_HINT_FROM).toBe(3);
  });
});

describe('提示词：不许直接给答案', () => {
  it('system 里明确禁止说出答案', () => {
    const { system } = buildHintPrompt({ ...BASE, level: 1 });
    expect(system).toContain('不要直接给答案');
    expect(system).toContain('失去了一次自己想起来的机会');
  });

  it('每一级带的是自己的那句要求', () => {
    for (const step of HINT_STEPS) {
      const { system } = buildHintPrompt({ ...BASE, level: step.level });
      expect(system).toContain(step.instruction);
    }
  });

  it('**答案与解析给模型看，但标注了不要转述**', () => {
    const { user } = buildHintPrompt({ ...BASE, level: 3 });
    /* 给了：否则模型判断不了"关键条件"是哪个 */
    expect(user).toContain('正确答案（**只供你判断方向');
    expect(user).toContain('解析（**同样不要在提示里照抄');
  });

  it('**已经给过的提示会被带上，并要求更进一步**', () => {
    const { user } = buildHintPrompt({
      ...BASE,
      level: 2,
      previousHints: [{ level: 1, text: '想想定义域' }],
    });
    expect(user).toContain('已经给过的提示');
    expect(user).toContain('第 1 级：想想定义域');
    expect(user).toContain('不要重复');
  });

  it('学生已作答时，提示可以针对他的选择（但仍不许说"你错了"）', () => {
    const { user } = buildHintPrompt({ ...BASE, level: 2, given: 'A' });
    expect(user).toContain('学生目前的作答');
    expect(user).toContain('别直接说这个选项不对');
  });

  it('没有作答时不出现"你选了什么"那一段', () => {
    const { user } = buildHintPrompt({ ...BASE, level: 1 });
    expect(user).not.toContain('学生目前的作答');
  });
});

describe('解析', () => {
  it('标准 JSON', () => {
    expect(parseHint('{"text":"想想定义域"}', 1)).toEqual({ level: 1, text: '想想定义域' });
  });

  it('带围栏也能解析', () => {
    expect(parseHint('```json\n{"text":"x"}\n```', 2).text).toBe('x');
  });

  it('空 text → 报错（不能给一个空提示）', () => {
    expect(() => parseHint('{"text":"   "}', 1)).toThrow(/没有给出提示内容/);
  });

  it('找不到 JSON → 报错并说清原因', () => {
    expect(() => parseHint('我不知道该怎么提示', 1)).toThrow(/找不到 JSON/);
  });
});

describe('judgeMasteryWithHints：强提示后答对不算真会', () => {
  it('**答对 + 用过 4 级 → 不算真会**', () => {
    const r = judgeMasteryWithHints({ correct: true, maxHintLevel: 4 });
    expect(r.countsAsMastery).toBe(false);
    expect(r.assisted).toBe(true);
    expect(r.note).toContain('不算真会');
  });

  it('**答对 + 用过 3 级 → 也不算**（3 级已经是强提示起点）', () => {
    const r = judgeMasteryWithHints({ correct: true, maxHintLevel: 3 });
    expect(r.countsAsMastery).toBe(false);
  });

  it('答对 + 只用过 1–2 级弱提示 → **算掌握**', () => {
    for (const lv of [1, 2] as HintLevel[]) {
      const r = judgeMasteryWithHints({ correct: true, maxHintLevel: lv });
      expect(r.countsAsMastery).toBe(true);
      expect(r.assisted).toBe(true);
      expect(r.note).toContain('算掌握');
    }
  });

  it('答对 + 没用提示 → 算掌握，且不需要说明', () => {
    const r = judgeMasteryWithHints({ correct: true, maxHintLevel: 0 });
    expect(r.countsAsMastery).toBe(true);
    expect(r.assisted).toBe(false);
    expect(r.note).toBeNull();
  });

  it('答错 → 一律不算（不管用了几级提示）', () => {
    for (const lv of [0, 1, 3, 4] as HintLevel[]) {
      expect(judgeMasteryWithHints({ correct: false, maxHintLevel: lv }).countsAsMastery).toBe(false);
    }
  });

  it('**答错时 note 为 null**（是答错这件事本身要说明，不是提示）', () => {
    expect(judgeMasteryWithHints({ correct: false, maxHintLevel: 4 }).note).toBeNull();
  });

  it('边界：maxHintLevel 只在 0/1/2/3/4 之间，判定单调', () => {
    /* 弱提示 → 强提示，countsAsMastery 只可能从 true 变 false，不会反过来 */
    const order: HintLevel[] = [0, 1, 2, 3, 4];
    const results = order.map((lv) => judgeMasteryWithHints({ correct: true, maxHintLevel: lv }).countsAsMastery);
    expect(results).toEqual([true, true, true, false, false]);
  });
});