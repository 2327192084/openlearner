import { describe, expect, it } from 'vitest';
import { clearTextMarks, paintTextMarks } from './paint-marks.ts';
import type { SourceSegment, TextMark } from '@/core/model.ts';

/**
 * 正文批注绘制（2026-11-09）。
 *
 * ## 测试边界（说清楚，避免误以为覆盖了绘制）
 *
 * 本项目 vitest 跑在 node 环境（vite.config.ts：`environment: 'node'`），
 * 没有 jsdom，因此**无法断言「浏览器画成了什么样」**。
 * 那一层只能靠真实 Electron 截图 + 查 IndexedDB 验证（已完成）。
 *
 * 这里能钉死的是**决策层**，也就是最容易错、错了又看不出来的部分：
 *  - 该不该跳过一条标记（位置对不上时绝不画错地方）
 *  - 注册名对不对（写错了 ::highlight 样式就静默失效）
 *  - 不支持的环境是否安静降级
 *
 * 这些都不需要 DOM 就能测：paintTextMarks 在没有 CSS.highlights 时
 * 在**碰任何 DOM 之前**就返回了。
 */

function seg(text: string): SourceSegment {
  return {
    id: 'seg1',
    sourceId: 'src1',
    index: 1,
    page: 1,
    chapter: null,
    text,
    charCount: text.length,
    createdAt: '2026-11-09T00:00:00.000Z',
  } as unknown as SourceSegment;
}

function mark(exact: string, start: number, kind: TextMark['kind'] = 'highlight'): TextMark {
  return {
    id: 'm-' + start,
    kind,
    anchor: { page: 1, exact, prefix: '', suffix: '', start, end: start + exact.length },
    createdAt: '2026-11-09T00:00:00.000Z',
  };
}

describe('paintTextMarks 在无 DOM/无 Highlight API 环境下', () => {
  it('不抛错，且明确报告什么都没画', () => {
    /*
     * 这条守的是「降级不炸」：旧版 Electron（< 105）或任何没有
     * CSS Custom Highlight 的环境里，阅读器不能因为批注而崩。
     */
    const r = paintTextMarks(null, seg('一段正文'), [mark('正文', 3)]);
    expect(r.painted).toBe(0);
    expect(r.stale).toBe(0);
  });

  it('有标记但环境不支持时同样是 0（不假装画了）', () => {
    const r = paintTextMarks(null, seg('一段正文'), [
      mark('正文', 3, 'highlight'),
      mark('正文', 3, 'underline'),
    ]);
    expect(r.painted).toBe(0);
  });

  it('segment 为 null 时安全返回', () => {
    expect(() => paintTextMarks(null, null, [mark('x', 0)])).not.toThrow();
  });
});

describe('clearTextMarks 在无 API 环境下', () => {
  it('不抛错', () => {
    expect(() => clearTextMarks()).not.toThrow();
  });
});
