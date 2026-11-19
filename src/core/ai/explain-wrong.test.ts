import { describe, expect, it } from 'vitest';
import {
  answerKeysOf,
  buildExplainPrompt,
  EXPLAIN_STYLES,
  parseExplain,
  wrongPicksOf,
} from './explain-wrong.ts';

/**
 * 「针对答错专门讲一遍」的纯逻辑测试。
 *
 * ## 这一组的核心断言是什么
 *
 * 不是「能生成一段文字」，而是**提示词里必须出现分岔点的证据**：
 * 用户选了哪个选项、那个选项的 why、正确答案是哪个。
 *
 * 少了这些，模型只能把整题解析重讲一遍 —— 而用户已经读过了。
 * 所以下面几条断言对「只把题干丢给模型」的实现**必然失败**。
 */

const OPTIONS = [
  { key: 'A', text: '有限序列', why: '符合定义：n 个元素的有限序列' },
  { key: 'B', text: '无限序列', why: '把「有限」记成了「无限」，常见误解' },
  { key: 'C', text: '树结构', why: '混淆了线性结构与树形结构' },
  { key: 'D', text: '图结构', why: '图可以有环，线性表不行' },
];

const BASE = {
  prompt: '线性表的定义是？',
  kind: 'single' as const,
  options: OPTIONS,
  answer: 'A',
  explanation: '线性表是有限序列。',
};

describe('计数与归一', () => {
  it('answerKeysOf 把多种写法归一', () => {
    expect(answerKeysOf('A')).toEqual(['A']);
    expect(answerKeysOf('A,C')).toEqual(['A', 'C']);
    expect(answerKeysOf('a， c')).toEqual(['A', 'C']);
    expect(answerKeysOf('')).toEqual([]);
  });

  it('wrongPicksOf 只挑"选了但不对"的（多选题部分正确也要挑出来）', () => {
    /* 单选：选了 B（错） */
    expect(wrongPicksOf(OPTIONS, 'A', 'B')).toEqual(['B']);
    /* 单选：选了 A（对）→ 没有错选 */
    expect(wrongPicksOf(OPTIONS, 'A', 'A')).toEqual([]);
    /* 多选：答案 A,C；用户选 A,B → B 是错的 */
    expect(wrongPicksOf(OPTIONS, 'A,C', 'A,B')).toEqual(['B']);
    /* 未作答 */
    expect(wrongPicksOf(OPTIONS, 'A', '')).toEqual([]);
    /* 给了不存在的键，不当成错选（防止脏数据被当成答案） */
    expect(wrongPicksOf(OPTIONS, 'A', 'Z')).toEqual([]);
  });
});

describe('提示词：必须让模型知道"他错在哪"', () => {
  it('**把用户选错的那个选项 + 它的 why 明确写进提示词**', () => {
    const { user } = buildExplainPrompt({ ...BASE, given: 'B' });

    /* 用户选的那个被标出来 */
    expect(user).toContain('【学生选了这个】');
    expect(user).toMatch(/B\. 无限序列\s*【学生选了这个】/);
    /* 正确答案被标出来 */
    expect(user).toMatch(/A\. 有限序列\s*【正确答案】/);
    /* 那个错误选项的 why 必须出现 —— 否则模型不知道"这个选项对应哪种误解" */
    expect(user).toContain('把「有限」记成了「无限」，常见误解');
    /* 明确指出他选了 B、正确答案是 A */
    expect(user).toContain('他选了 B，这是错的');
    expect(user).toContain('正确答案是 A');
  });

  it('要求围绕"分岔点"讲，而不是重讲整题（对"只给题干"的实现不成立）', () => {
    const { system } = buildExplainPrompt({ ...BASE, given: 'B' });
    expect(system).toContain('针对学生这一次的具体错误');
    expect(system).toContain('他已经看过整题解析了');
    expect(system).toContain('从哪一步开始想错的');
  });

  it('答对了却点开讲解 → 不写成"你错了"', () => {
    const { user } = buildExplainPrompt({ ...BASE, given: 'A' });
    expect(user).not.toContain('这是错的');
    expect(user).toContain('与正确答案一致');
  });

  it('未作答 → 按"讲关键点与常见误解"处理', () => {
    const { user } = buildExplainPrompt({ ...BASE, given: '' });
    expect(user).toContain('学生没有作答');
    expect(user).not.toContain('这是错的');
  });

  it('原题解析标成"学生已经看过，不要照抄"', () => {
    const { user } = buildExplainPrompt({ ...BASE, given: 'B' });
    expect(user).toContain('学生已经看过，不要照抄');
    expect(user).toContain('线性表是有限序列。');
  });
});

describe('提示词：填空/问答/计算题（无选项）走另一条路', () => {
  const open = {
    prompt: '简述顺序表与链表的取舍。',
    kind: 'essay' as const,
    options: [],
    answer: '顺序表随机访问快、插入删除慢；链表相反。',
    explanation: '看是否需要随机访问。',
  };

  it('把学生的作答摆出来，要求指出缺了哪个要点', () => {
    const { user } = buildExplainPrompt({ ...open, given: '顺序表慢。' });
    expect(user).toContain('学生的作答');
    expect(user).toContain('顺序表慢。');
    expect(user).toContain('哪个要点缺了或错了');
    /* 不该出现选项区 */
    expect(user).not.toContain('## 选项');
  });

  it('无选项时未作答也不写成"选错了"', () => {
    const { user } = buildExplainPrompt({ ...open, given: '' });
    expect(user).toContain('学生没有作答');
    expect(user).not.toContain('他选了');
  });
});

describe('讲解策略', () => {
  it('每种策略都能切换提示词里的那句要求', () => {
    const seen = new Set<string>();
    for (const s of EXPLAIN_STYLES) {
      const { system } = buildExplainPrompt({ ...BASE, given: 'B', styleId: s.id });
      expect(system).toContain(s.instruction);
      seen.add(s.instruction);
    }
    /* 策略不能是同一个句子的多个副本 */
    expect(seen.size).toBe(EXPLAIN_STYLES.length);
  });

  it('未知 styleId 退回第一种（不崩、不留空）', () => {
    const { system } = buildExplainPrompt({ ...BASE, given: 'B', styleId: 'nope' });
    expect(system).toContain(EXPLAIN_STYLES[0].instruction);
  });

  it('自定义要求会进提示词', () => {
    const { user } = buildExplainPrompt({ ...BASE, given: 'B', customStyle: '用初学者的口吻' });
    expect(user).toContain('学生的额外要求');
    expect(user).toContain('用初学者的口吻');
  });
});

describe('解析模型输出', () => {
  it('标准 JSON 能解析', () => {
    const r = parseExplain(
      JSON.stringify({ crux: '把有限记成了无限', body: '第一段\n\n第二段', nextStep: '再看一眼定义' }),
    );
    expect(r.crux).toBe('把有限记成了无限');
    expect(r.body).toBe('第一段\n\n第二段');
    expect(r.nextStep).toBe('再看一眼定义');
  });

  it('带 ```json 围栏也能解析', () => {
    const r = parseExplain('```json\n{"crux":"c","body":"b","nextStep":""}\n```');
    expect(r.body).toBe('b');
    /* 空 nextStep 归一成 null，界面据此不显示那一行 */
    expect(r.nextStep).toBeNull();
  });

  it('前后有多余说明文字也能捞出 JSON', () => {
    const r = parseExplain('好的，这是讲解：\n{"crux":"c","body":"b"}\n希望有帮助');
    expect(r.body).toBe('b');
  });

  it('没有 body → 报错（不能给一个空白讲解）', () => {
    expect(() => parseExplain(JSON.stringify({ crux: 'c', body: '   ' }))).toThrow(/没有给出讲解内容/);
  });

  it('找不到 JSON → 报错并说清原因', () => {
    expect(() => parseExplain('抱歉我无法回答')).toThrow(/找不到 JSON/);
  });

  it('JSON 坏掉 → 报错（不静默返回空）', () => {
    expect(() => parseExplain('{"crux": "c", "body": ')).toThrow(/无法解析|找不到 JSON/);
  });
});
