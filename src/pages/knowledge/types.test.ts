import { describe, expect, it } from 'vitest';
import {
  ANCHOR_STATUS_LABEL,
  backendLabel,
  cognitiveLabel,
  defaultBackendFilter,
  locatedRatio,
  locationLabel,
  parsePageRange,
  sumBackends,
} from './types.ts';
import { clampRanges, overlaps, splitParagraphs } from './SliceText.tsx';
import type { KnowledgePoint } from '@/core/model.ts';
import type { KnowledgeBackendSummary } from '@/core/knowledge/service.ts';
import { MANUAL_BACKEND_ID } from '@/core/knowledge/service.ts';

/**
 * 知识点页的纯函数测试。
 *
 * 挑这几处测，是因为它们出错时**界面上看不出来**：
 *  - 页码范围猜错 → 白跑一次整理（还花钱），但界面一切正常；
 *  - 高亮偏移越界 → 高亮悄悄消失，看起来像「这段没有锚点」；
 *  - 状态文案把 unlocated 说成成功 → P2 验收项直接失守。
 */

describe('parsePageRange', () => {
  it('两头都留空表示整份资料', () => {
    expect(parsePageRange('', '')).toEqual({ range: null, error: null });
    expect(parsePageRange('  ', ' ')).toEqual({ range: null, error: null });
  });

  it('只填一头时明确报错，不猜「起始页=1」', () => {
    const onlyFrom = parsePageRange('3', '');
    expect(onlyFrom.range).toBeNull();
    expect(onlyFrom.error).toMatch(/都填/);

    const onlyTo = parsePageRange('', '9');
    expect(onlyTo.range).toBeNull();
    expect(onlyTo.error).toMatch(/都填/);
  });

  it('两头都填时给出范围，且倒序输入自动纠正', () => {
    expect(parsePageRange('3', '9').range).toEqual({ from: 3, to: 9 });
    // 用户填反了不该报错——倒过来才是他想表达的范围
    expect(parsePageRange('9', '3').range).toEqual({ from: 3, to: 9 });
  });

  it('非整数、0、负数都报错', () => {
    expect(parsePageRange('0', '5').error).not.toBeNull();
    expect(parsePageRange('-1', '5').error).not.toBeNull();
    expect(parsePageRange('1.5', '5').error).not.toBeNull();
    expect(parsePageRange('abc', '5').error).not.toBeNull();
  });
});

describe('splitParagraphs', () => {
  it('按空行切段，且每块的偏移对准原文', () => {
    const text = '第一段\n\n第二段\n\n第三段';
    const blocks = splitParagraphs(text);
    expect(blocks.map((b) => b.text)).toEqual(['第一段', '第二段', '第三段']);
    // 关键不变量：用原文坐标去切，得到的必须还是同一段文字
    for (const block of blocks) {
      expect(text.slice(block.start, block.end)).toBe(block.text);
    }
  });

  it('单个换行不切段', () => {
    expect(splitParagraphs('上半句\n下半句')).toHaveLength(1);
  });

  it('空文本得到空数组', () => {
    expect(splitParagraphs('')).toEqual([]);
  });
});

describe('clampRanges', () => {
  const text = '一二三四五六七八九十';

  it('正常范围原样保留', () => {
    expect(clampRanges(text, [{ charStart: 2, charEnd: 5 }])).toEqual([
      { charStart: 2, charEnd: 5 },
    ]);
  });

  it('越界的范围被裁到文本长度内，而不是消失', () => {
    expect(clampRanges(text, [{ charStart: 8, charEnd: 999 }])).toEqual([
      { charStart: 8, charEnd: 10 },
    ]);
  });

  it('完全越界或空范围直接丢弃（画出来是空的高亮）', () => {
    expect(clampRanges(text, [{ charStart: 20, charEnd: 30 }])).toEqual([]);
    expect(clampRanges(text, [{ charStart: 4, charEnd: 4 }])).toEqual([]);
    expect(clampRanges(text, [{ charStart: -5, charEnd: -1 }])).toEqual([]);
  });

  it('负起点被裁到 0', () => {
    expect(clampRanges(text, [{ charStart: -3, charEnd: 2 }])).toEqual([
      { charStart: 0, charEnd: 2 },
    ]);
  });

  it('乱序输入按起点排序输出', () => {
    expect(
      clampRanges(text, [
        { charStart: 6, charEnd: 8 },
        { charStart: 1, charEnd: 3 },
      ]),
    ).toEqual([
      { charStart: 1, charEnd: 3 },
      { charStart: 6, charEnd: 8 },
    ]);
  });
});

describe('overlaps', () => {
  it('相交为真，相接为假', () => {
    expect(overlaps({ charStart: 0, charEnd: 5 }, { charStart: 4, charEnd: 9 })).toBe(true);
    // 首尾相接不算重叠：否则相邻两条知识点的高亮会互相点亮
    expect(overlaps({ charStart: 0, charEnd: 5 }, { charStart: 5, charEnd: 9 })).toBe(false);
  });

  it('包含关系算重叠', () => {
    expect(overlaps({ charStart: 0, charEnd: 10 }, { charStart: 3, charEnd: 4 })).toBe(true);
  });
});

describe('状态文案', () => {
  it('unlocated 用「待处理」且不是成功色 —— P2 验收要求它必须显眼', () => {
    expect(ANCHOR_STATUS_LABEL.unlocated.text).toBe('待处理');
    expect(ANCHOR_STATUS_LABEL.unlocated.tone).toBe('planned');
    // 绝不能和已定位同一个样子
    expect(ANCHOR_STATUS_LABEL.unlocated.tone).not.toBe(ANCHOR_STATUS_LABEL.located.tone);
  });

  it('waived 不再有任何警告色', () => {
    expect(ANCHOR_STATUS_LABEL.waived.tone).toBe('neutral');
  });

  it('认知层级四个值都有中文标签', () => {
    expect(cognitiveLabel('remember')).toBe('识记');
    expect(cognitiveLabel('understand')).toBe('理解');
    expect(cognitiveLabel('apply')).toBe('应用');
    expect(cognitiveLabel('analyze')).toBe('分析');
  });
});

describe('locationLabel', () => {
  const base: KnowledgePoint = {
    id: 'kp1',
    statement: '示例',
    chapter: null,
    cognitiveLevel: 'understand',
    tags: [],
    anchors: [],
    quotes: [],
    anchorStatus: 'unlocated',
    origin: 'material',
    sourceId: 's1',
    backendId: 'mock',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('没有锚点时明确说「无位置」，而不是空串', () => {
    expect(locationLabel(base)).toBe('无位置');
  });

  it('有页码时带章节', () => {
    expect(
      locationLabel({
        ...base,
        anchors: [{ sourceId: 's1', page: 12, charStart: 0, charEnd: 5 }],
      }),
    ).toBe('第 12 页');
    expect(
      locationLabel({
        ...base,
        anchors: [{ sourceId: 's1', page: 12, chapter: '第三章', charStart: 0, charEnd: 5 }],
      }),
    ).toBe('第三章 · 第 12 页');
  });
});

/* ==========================================================================
   按后端分组（P5 第 4 条）
   ========================================================================== */

function summary(
  backendId: string,
  count: number,
  located = count,
  unlocated = 0,
  waived = 0,
): KnowledgeBackendSummary {
  return { backendId, count, located, unlocated, waived, lastAt: '2026-01-01T00:00:00.000Z' };
}

describe('sumBackends', () => {
  it('把各分组合计起来', () => {
    const total = sumBackends([summary('mock', 12, 10, 2), summary('backend_a', 8, 8)]);
    expect(total).toEqual({ count: 20, located: 18, unlocated: 2, waived: 0 });
  });

  it('空列表得到全 0，而不是 undefined', () => {
    expect(sumBackends([])).toEqual({ count: 0, located: 0, unlocated: 0, waived: 0 });
  });

  it('合计与各分组同源：逐组相加必须等于总数', () => {
    const groups = [summary('a', 3, 2, 1), summary('b', 5, 5), summary(MANUAL_BACKEND_ID, 2, 0, 0, 2)];
    const total = sumBackends(groups);
    expect(total.count).toBe(groups.reduce((n, g) => n + g.count, 0));
    expect(total.located).toBe(groups.reduce((n, g) => n + g.located, 0));
    expect(total.waived).toBe(2);
  });
});

describe('backendLabel', () => {
  it('手工录入组显示「手工录入」，不是 id 也不是空串', () => {
    expect(backendLabel(MANUAL_BACKEND_ID, {})).toBe('手工录入');
  });

  it('配置还在时用配置里的名字', () => {
    expect(backendLabel('backend_abc', { backend_abc: '智谱 GLM' })).toBe('智谱 GLM');
  });

  it('配置已删时明确说「未知后端（id）」，不能留空', () => {
    const label = backendLabel('backend_gone', {});
    expect(label).not.toBe('');
    expect(label).toContain('未知后端');
    expect(label).toContain('backend_gone');
  });

  it('映射到空字符串时也走「未知后端」，不显示空白', () => {
    expect(backendLabel('backend_x', { backend_x: '   ' })).toContain('未知后端');
  });
});

describe('defaultBackendFilter', () => {
  it('只有 1 个后端时不筛（一个选项的筛选器只是噪音）', () => {
    expect(defaultBackendFilter([summary('mock', 10)])).toBeNull();
    expect(defaultBackendFilter([])).toBeNull();
  });

  it('≥2 个后端时默认选条数最多的那组', () => {
    expect(defaultBackendFilter([summary('mock', 12), summary('backend_a', 8)])).toBe('mock');
  });
});

describe('locatedRatio', () => {
  it('分母是总数，不是「已定位+待处理」', () => {
    expect(locatedRatio(summary('a', 4, 4, 0, 0))).toBe('100%');
    expect(locatedRatio(summary('a', 4, 2, 0, 2))).toBe('50%');
    expect(locatedRatio(summary('a', 10, 7, 3, 0))).toBe('70%');
  });

  it('空组显示「—」而不是 NaN%', () => {
    expect(locatedRatio(summary('a', 0, 0))).toBe('—');
  });
});
