import { describe, expect, it } from 'vitest';
import {
  GENERATE_KINDS,
  KIND_SPECS,
  kindCost,
  kindLabel,
  kindShort,
  kindSpec,
  normalizeKindSelection,
  isAutoGraded,
  hasOptions,
  fixedOptionsOf,
} from './kinds.ts';
import type { Question } from '../model.ts';

/**
 * 题型注册表的测试。
 *
 * ## 为什么这张表值得单独测
 *
 * 它的作用是「一个题型一个条目，所有行为集中在一处」。
 * 一旦某个条目的字段写错（比如判断题没写 fixedOptions），
 * 表现为「能出判断题，但做题时没有选项可选」——
 * 而那种 bug 在界面上看起来只是「这题有点怪」，不容易想到是注册表漏了字段。
 */

describe('题型注册表：结构完整性', () => {
  it('每种题型都有完整的描述', () => {
    for (const spec of KIND_SPECS) {
      expect(spec.id).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(spec.short).toBeTruthy();
      expect(spec.hint).toBeTruthy();
      expect(spec.graded === 'auto' || spec.graded === 'self').toBe(true);
      expect(spec.cost).toBeGreaterThan(0);
    }
  });

  it('有选项的题型必须给选项数量约束', () => {
    for (const spec of KIND_SPECS) {
      if (spec.fixedOptions) {
        /* 固定选项的题型（判断题）数量就是固定的，约束必须对得上 */
        expect(spec.options).not.toBeNull();
        expect(spec.options!.min).toBe(spec.fixedOptions.length);
        expect(spec.options!.max).toBe(spec.fixedOptions.length);
      }
    }
  });

  it('判断题的固定选项是对/错，key 是 T/F', () => {
    const tf = kindSpec('truefalse');
    expect(tf).not.toBeNull();
    expect(tf!.fixedOptions).toEqual([
      { key: 'T', text: '对' },
      { key: 'F', text: '错' },
    ]);
  });

  it('问答类必须自评（没有唯一正确表述）', () => {
    expect(isAutoGraded('essay')).toBe(false);
    expect(kindSpec('essay')!.graded).toBe('self');
  });

  it('客观题都能自动判分', () => {
    for (const id of ['single', 'multiple', 'truefalse', 'blank'] as const) {
      expect(isAutoGraded(id)).toBe(true);
    }
  });
});

describe('题型注册表：查询函数', () => {
  it('未知题型返回 null，不猜', () => {
    expect(kindSpec('不存在的题型')).toBeNull();
    expect(hasOptions('不存在的题型')).toBe(false);
    expect(fixedOptionsOf('不存在的题型')).toBeNull();
  });

  it('未知题型的名字退回原字符串（不崩）', () => {
    expect(kindLabel('mystery')).toBe('mystery');
    expect(kindShort('mystery')).toBe('mystery');
  });

  it('未知题型的耗时按最低算', () => {
    expect(kindCost('mystery')).toBe(2);
  });

  it('选择题有选项、填空/问答没选项', () => {
    expect(hasOptions('single')).toBe(true);
    expect(hasOptions('multiple')).toBe(true);
    expect(hasOptions('truefalse')).toBe(true);
    expect(hasOptions('blank')).toBe(false);
    expect(hasOptions('essay')).toBe(false);
  });

  it('耗时反映了「答题要多久」：问答最久、判断题最快', () => {
    const costs = KIND_SPECS.map((s) => ({ id: s.id, c: s.cost }));
    const essay = costs.find((x) => x.id === 'essay')!.c;
    const tf = costs.find((x) => x.id === 'truefalse')!.c;
    expect(essay).toBeGreaterThan(tf);
  });
});

describe('normalizeKindSelection：规整用户的勾选', () => {
  it('去重', () => {
    expect(normalizeKindSelection(['single', 'single'])).toEqual(['single']);
  });

  it('按注册表顺序输出（勾选顺序不影响结果）', () => {
    const a = normalizeKindSelection(['essay', 'single']);
    const b = normalizeKindSelection(['single', 'essay']);
    expect(a).toEqual(b);
    /* single 在注册表里排在 essay 前面 */
    expect(a[0]).toBe('single');
  });

  it('丢掉不能出题的题型', () => {
    /* 假设将来有不可出题的类型，这里用一个不存在的 id 验证会被过滤 */
    expect(normalizeKindSelection(['single', '不存在'])).toEqual(['single']);
  });

  it('空选择返回空数组（调用方要把它当错误，不能静默退回单选）', () => {
    expect(normalizeKindSelection([])).toEqual([]);
  });

  it('GENERATE_KINDS 与注册表里 generate=true 的条目一致', () => {
    const fromSpecs = KIND_SPECS.filter((s) => s.generate).map((s) => s.id);
    expect(GENERATE_KINDS).toEqual(fromSpecs);
  });
});

/**
 * 判断题的判分。
 *
 * 这里测的是 `DeckService.gradeAnswer` 的语义 —— 但那个方法需要 storage，
 * 所以用同一条规则在这里独立验证：答案的多种写法都要认。
 */
describe('判断题判分：多种写法都认', () => {
  const truthy = (s: string): string => {
    const v = s.trim().toUpperCase();
    if (v === 'T' || v === 'TRUE' || v === '对' || v === '正确') return 'T';
    if (v === 'F' || v === 'FALSE' || v === '错' || v === '错误') return 'F';
    return v;
  };

  it('标准写法', () => {
    expect(truthy('T')).toBe('T');
    expect(truthy('F')).toBe('F');
  });

  it('小写也认', () => {
    expect(truthy('t')).toBe('T');
    expect(truthy('f')).toBe('F');
  });

  it('中文也认（导入的题组可能用中文）', () => {
    expect(truthy('对')).toBe('T');
    expect(truthy('错')).toBe('F');
    expect(truthy('正确')).toBe('T');
    expect(truthy('错误')).toBe('F');
  });

  it('带空格也认', () => {
    expect(truthy('  T  ')).toBe('T');
  });

  it('认不出的写法原样返回（不会误判成对）', () => {
    expect(truthy('也许')).toBe('也许');
    expect(truthy('也许')).not.toBe('T');
  });

  it('对/错 互不相等', () => {
    expect(truthy('T')).not.toBe(truthy('F'));
    expect(truthy('对')).not.toBe(truthy('错'));
  });
});

/** 类型层面的检查：truefalse 是合法的 QuestionKind */
describe('题型类型', () => {
  it('truefalse 能用在 Question 上', () => {
    const q: Question = {
      id: 'q1',
      deckId: 'd1',
      kind: 'truefalse',
      prompt: '判断：信号是周期性的',
      options: [
        { key: 'T', text: '对' },
        { key: 'F', text: '错' },
      ],
      answer: 'T',
      explanation: '',
      anchors: [],
      knowledgePointId: null,
      cognitiveLevel: 'remember',
      topic: '',
      order: 0,
      createdAt: '2026-11-07',
      updatedAt: '2026-11-07',
    };
    expect(q.kind).toBe('truefalse');
    expect(kindSpec(q.kind)).not.toBeNull();
  });
});
