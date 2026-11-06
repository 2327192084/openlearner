import { describe, expect, it } from 'vitest';
import {
  distToSegment,
  distToStroke,
  strokeHitByEraser,
  strokeBounds,
  shapeBounds,
  pointInPolygon,
  strokeCaughtByLasso,
  shapeCaughtByLasso,
  translateStroke,
  translateShape,
  simplifyStroke,
  pointsBounds,
  PEN_WIDTHS,
  PEN_LABELS,
  SHAPE_LABELS,
} from './annotation-geometry.ts';
import type { InkStroke, ShapeElement } from './model.ts';

/**
 * 标注几何的测试。
 *
 * 这些计算错了很难被用户说清楚：「擦不掉」「点不中」「框选漏了」——
 * 只有把边界行为钉死，才不用靠手试。
 */

const stroke = (pts: [number, number][], width = 0.004): InkStroke => ({
  points: pts.map(([x, y]) => ({ x, y })),
  color: '#000',
  width,
});

const rect = (): ShapeElement => ({
  id: 's1',
  kind: 'rect',
  x1: 0.2,
  y1: 0.2,
  x2: 0.6,
  y2: 0.5,
  color: '#000',
  width: 0.003,
  fill: null,
});

describe('distToSegment：点到线段距离', () => {
  it('垂足在线段内时取垂直距离', () => {
    expect(distToSegment({ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0.5, 6);
  });

  it('点在线段上时距离为 0', () => {
    expect(distToSegment({ x: 0.5, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
  });

  it('垂足在线段外时取到端点的距离', () => {
    // 点在线段延长线上方，最近的是端点 (1,0)
    const d = distToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(d).toBeCloseTo(1, 6);
  });

  it('退化成一个点时不除以零', () => {
    expect(distToSegment({ x: 0.3, y: 0.4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0.5, 6);
  });
});

describe('distToStroke / strokeHitByEraser', () => {
  it('取整条笔迹的最短距离，不是只看首尾', () => {
    const s = stroke([
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
    ]);
    // 点在第二段的中间
    expect(distToStroke({ x: 0.5, y: 0.25 }, s)).toBeLessThan(0.01);
  });

  it('空笔迹距离为无穷（不会误判命中）', () => {
    expect(distToStroke({ x: 0, y: 0 }, stroke([]))).toBe(Infinity);
  });

  it('擦除判定把笔宽算进去：细笔需要更准', () => {
    const thin = stroke([[0, 0], [1, 0]], 0.001);
    const thick = stroke([[0, 0], [1, 0]], 0.05);
    const p = { x: 0.5, y: 0.02 }; // 离线段 0.02
    expect(strokeHitByEraser(p, thin, 0.005)).toBe(false);
    expect(strokeHitByEraser(p, thick, 0.005)).toBe(true);
  });

  it('正好压在笔迹上一定命中', () => {
    expect(strokeHitByEraser({ x: 0.5, y: 0 }, stroke([[0, 0], [1, 0]]), 0)).toBe(true);
  });
});

describe('strokeBounds / shapeBounds / pointsBounds', () => {
  it('笔迹包围盒取所有点的极值', () => {
    const b = strokeBounds(stroke([[0.1, 0.2], [0.7, 0.3], [0.4, 0.9]]));
    expect(b).toEqual({ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.9 });
  });

  it('空笔迹没有包围盒', () => {
    expect(strokeBounds(stroke([]))).toBeNull();
  });

  it('图形包围盒按对角归一（反向拖拽也对）', () => {
    const s = { ...rect(), x1: 0.6, y1: 0.5, x2: 0.2, y2: 0.2 };
    expect(shapeBounds(s)).toEqual({ x1: 0.2, y1: 0.2, x2: 0.6, y2: 0.5 });
  });

  it('点集的包围盒', () => {
    expect(pointsBounds([{ x: 0.3, y: 0.1 }, { x: 0.1, y: 0.5 }])).toEqual({
      x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.5,
    });
    expect(pointsBounds([])).toBeNull();
  });
});

describe('pointInPolygon：套索判定', () => {
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it('内部点算在内', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true);
  });

  it('外部点算在外', () => {
    expect(pointInPolygon({ x: 0.1, y: 0.1 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.9, y: 0.5 }, square)).toBe(false);
  });

  it('少于三个点不成多边形', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square.slice(0, 2))).toBe(false);
  });
});

describe('套索选择', () => {
  const lasso = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it('**任一采样点在内就算选中**：横穿套索的长笔迹也算', () => {
    // 两端都在套索外，中间穿过 —— 按"全部在内"就选不中，用户会觉得套索没用
    const crossing = stroke([
      [0, 0.5],
      [0.5, 0.5],
      [1, 0.5],
    ]);
    expect(strokeCaughtByLasso(crossing, lasso)).toBe(true);
  });

  it('完全在外面的笔迹选不中', () => {
    const outside = stroke([
      [0.85, 0.85],
      [0.95, 0.95],
    ]);
    expect(strokeCaughtByLasso(outside, lasso)).toBe(false);
  });

  it('图形中心在内则选中', () => {
    expect(shapeCaughtByLasso(rect(), lasso)).toBe(true);
  });

  it('图形角落在内也算选中（大图形被部分框住）', () => {
    // 中心在套索外，但左上角在套索内
    const big: ShapeElement = { ...rect(), x1: 0.5, y1: 0.5, x2: 1.5, y2: 1.5 };
    expect(shapeCaughtByLasso(big, lasso)).toBe(true);
  });

  it('完全在外面的图形选不中', () => {
    const far: ShapeElement = { ...rect(), x1: 0.85, y1: 0.85, x2: 0.95, y2: 0.95 };
    expect(shapeCaughtByLasso(far, lasso)).toBe(false);
  });
});

describe('平移', () => {
  it('平移笔迹后所有点都跟着动', () => {
    const moved = translateStroke(stroke([[0.1, 0.1], [0.2, 0.2]]), 0.05, -0.03);
    expect(moved.points[0]).toEqual({ x: 0.15000000000000002, y: 0.07 });
    expect(moved.points[1]!.x).toBeCloseTo(0.25, 6);
  });

  it('平移图形后两端都动', () => {
    const moved = translateShape(rect(), 0.1, 0.1);
    expect(moved.x1).toBeCloseTo(0.3, 6);
    expect(moved.x2).toBeCloseTo(0.7, 6);
  });

  it('平移不改变颜色与宽度', () => {
    const moved = translateStroke(stroke([[0, 0], [1, 1]], 0.02), 0.1, 0.1);
    expect(moved.color).toBe('#000');
    expect(moved.width).toBe(0.02);
  });
});

describe('simplifyStroke：笔迹简化', () => {
  it('两个点原样返回', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(simplifyStroke(pts)).toEqual(pts);
  });

  it('近乎直线的多点被压缩到首尾', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.00001 },
      { x: 0.5, y: 0.00001 },
      { x: 0.75, y: 0.00001 },
      { x: 1, y: 0 },
    ];
    const out = simplifyStroke(pts, 0.001);
    expect(out.length).toBeLessThan(pts.length);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 1, y: 0 });
  });

  it('明显拐弯的点被保留', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 }, // 明显的拐点
      { x: 1, y: 0 },
    ];
    expect(simplifyStroke(pts, 0.0001).length).toBe(3);
  });

  it('简化后首尾一定保留（不然笔迹会缩水）', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 }));
    const out = simplifyStroke(pts, 0.0001);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it('空数组不报错', () => {
    expect(simplifyStroke([])).toEqual([]);
  });
});

describe('配置表', () => {
  it('五种笔形都有宽度与显示名', () => {
    const kinds = ['pen', 'marker', 'highlighter', 'pencil', 'laser'] as const;
    for (const k of kinds) {
      expect(PEN_WIDTHS[k]).toBeGreaterThan(0);
      expect(PEN_LABELS[k].length).toBeGreaterThan(0);
    }
  });

  it('荧光笔比钢笔粗，铅笔比钢笔细', () => {
    expect(PEN_WIDTHS.highlighter).toBeGreaterThan(PEN_WIDTHS.pen);
    expect(PEN_WIDTHS.pencil).toBeLessThan(PEN_WIDTHS.pen);
  });

  it('四种图形都有显示名', () => {
    for (const k of ['line', 'arrow', 'rect', 'ellipse'] as const) {
      expect(SHAPE_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});
