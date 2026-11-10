import { describe, expect, it } from 'vitest';
import { buildPickPrompt, parsePicks } from './pick-flashcards.ts';
import type { KnowledgePoint } from '../model.ts';

/**
 * AI 挑闪卡的纯逻辑（2026-11-10）。
 *
 * 重点在**解析的容错与拒绝**：
 * 模型经常把编号写错、重复、越界。挑错卡会让用户背错内容，
 * 比少挑一条严重得多 —— 所以宁可丢弃，不猜。
 */

function point(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp-' + (over.statement ?? 'x').slice(0, 4),
    statement: '默认表述',
    chapter: '第1章',
    cognitiveLevel: 'remember',
    tags: ['1.1 小节'],
    anchors: [],
    quotes: [],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: 's1',
    backendId: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as KnowledgePoint;
}

const POINTS = [
  point({ id: 'a', statement: '线性时不变系统同时满足叠加性与时不变性' }),
  point({ id: 'b', statement: '傅里叶变换把时域信号变到频域' }),
  point({ id: 'c', statement: '本章分为三部分' }),
];

describe('buildPickPrompt', () => {
  it('知识点用编号列出，不给模型 id', () => {
    /*
     * 让模型回传 uuid 很容易抄错（实测会串号）。
     * 编号抄错的代价小，且能校验范围。
     */
    const { user } = buildPickPrompt(POINTS, 10);
    expect(user).toContain('1. 线性时不变系统');
    expect(user).toContain('2. 傅里叶变换');
    expect(user).toContain('3. 本章分为三部分');
    expect(user).not.toContain('kp-');
  });

  it('system 里说明了「什么样适合」与「什么不适合」', () => {
    const { system } = buildPickPrompt(POINTS, 10);
    expect(system).toContain('独立');
    expect(system).toContain('不要挑'); // 排除条件
    expect(system).toContain('宁少勿滥');
  });

  it('limit 写进提示词', () => {
    expect(buildPickPrompt(POINTS, 7).system).toContain('7');
  });
});

describe('parsePicks', () => {
  it('正常解析', () => {
    const out = parsePicks('{"picks":[{"n":1,"reason":"定义清楚"}]}', POINTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.knowledgePointId).toBe('a');
    expect(out[0]!.reason).toBe('定义清楚');
  });

  it('带 ```json 围栏也能解析', () => {
    const c = '```json\n{"picks":[{"n":2,"reason":"公式"}]}\n```';
    expect(parsePicks(c, POINTS)[0]!.knowledgePointId).toBe('b');
  });

  it('前后有说明文字也能解析', () => {
    const c = '好的，我挑了这些：\n{"picks":[{"n":1,"reason":"核心"}]}\n希望有帮助。';
    expect(parsePicks(c, POINTS)).toHaveLength(1);
  });

  it('n 是字符串也能认', () => {
    expect(parsePicks('{"picks":[{"n":"3","reason":"x"}]}', POINTS)[0]!.knowledgePointId).toBe('c');
  });

  it('编号越界一律丢弃（不猜它想指谁）', () => {
    expect(parsePicks('{"picks":[{"n":0},{"n":99},{"n":-1}]}', POINTS)).toHaveLength(0);
  });

  it('重复编号只算一次', () => {
    const out = parsePicks('{"picks":[{"n":1},{"n":1},{"n":1}]}', POINTS);
    expect(out).toHaveLength(1);
  });

  it('非整数编号丢弃', () => {
    expect(parsePicks('{"picks":[{"n":1.5},{"n":"abc"},{"n":null}]}', POINTS)).toHaveLength(0);
  });

  it('缺 reason 也给候选（不能用它的理由，但卡本身有效）', () => {
    const out = parsePicks('{"picks":[{"n":1}]}', POINTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe('');
  });

  it('picks 不是数组时返回空', () => {
    expect(parsePicks('{"picks":"oops"}', POINTS)).toEqual([]);
    expect(parsePicks('{}', POINTS)).toEqual([]);
  });

  it('完全不是 JSON 时返回空，不抛错', () => {
    expect(parsePicks('我不想挑', POINTS)).toEqual([]);
    expect(parsePicks('', POINTS)).toEqual([]);
  });

  it('reason 过长时截断（防止模型写一篇小作文）', () => {
    const long = '理由'.repeat(100);
    const out = parsePicks(JSON.stringify({ picks: [{ n: 1, reason: long }] }), POINTS);
    expect(out[0]!.reason.length).toBeLessThanOrEqual(60);
  });

  it('空知识点列表时任何编号都越界', () => {
    expect(parsePicks('{"picks":[{"n":1}]}', [])).toHaveLength(0);
  });
});
