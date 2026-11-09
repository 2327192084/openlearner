import { describe, expect, it } from 'vitest';
import {
  pickRandom,
  pointsToMaterials,
  segmentsToMaterials,
  toSourcePoint,
} from './materials.ts';
import type { KnowledgePoint, SourceSegment } from '../model.ts';

/**
 * 出题素材的两种来源。
 *
 * 用户要求：「多加一个从知识库出题的功能……然后原先的从资料出题功能，
 * 应该让 ai 从 pdf 解析后的资料原文里出题，不再从原先资料的知识点出题」。
 *
 * 这组测试钉的是**两条来源都能产出可信的 anchors** ——
 * 因为「点回原文」成立的前提就是位置不是模型给的。
 */

function makePoint(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp1',
    statement: '线性表是有限序列',
    chapter: '第一章 线性表',
    cognitiveLevel: 'understand',
    tags: [],
    anchors: [{ sourceId: 's1', page: 3, charStart: 10, charEnd: 20 }],
    quotes: ['线性表是由 n 个数据元素构成的有限序列'],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: 's1',
    backendId: null,
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...over,
  };
}

function makeSeg(over: Partial<SourceSegment> = {}): SourceSegment {
  const text = '线性表是由 n 个数据元素构成的有限序列，n 称为表长。顺序表支持随机访问。';
  return {
    id: 'seg1',
    sourceId: 's1',
    index: 1,
    page: 5,
    chapter: '第一章 线性表',
    text,
    charCount: text.length,
    ...over,
  };
}

describe('pointsToMaterials：从知识库出题', () => {
  it('已定位的知识点转成素材', () => {
    const m = pointsToMaterials([makePoint()]);
    expect(m).toHaveLength(1);
    expect(m[0]!.id).toBe('kp1');
    expect(m[0]!.page).toBe(3);
  });

  it('没定位的知识点被排除（它们出不了点回原文的题）', () => {
    const m = pointsToMaterials([
      makePoint({ id: 'ok' }),
      makePoint({ id: 'bad', anchors: [], anchorStatus: 'unlocated' }),
    ]);
    expect(m.map((x) => x.id)).toEqual(['ok']);
  });

  it('anchors 的位置字段原样带出，且是副本（不给外部改动的机会）', () => {
    /*
     * 2026-11-09 改：锚点不再「一个字段都不加」地照搬，而是补一个 quote
     * （知识点自带的逐字引文），用于精确定位那一句话。
     *
     * 位置字段仍然逐字段继承 —— 那才是「出处不采信模型」的保证。
     * 所以这里用 toMatchObject 断言位置，再单独断言 quote。
     */
    const p = makePoint();
    const m = pointsToMaterials([p]);
    expect(m[0]!.anchors[0]).toMatchObject({
      sourceId: 's1',
      page: 3,
      charStart: 10,
      charEnd: 20,
    });
    expect(m[0]!.anchors[0]).not.toBe(p.anchors[0]);
  });

  it('知识点自带引文时，写进锚点用于精确定位（2026-11-09 加）', () => {
    const p = makePoint({ quotes: ['线性表是由 n 个数据元素构成的有限序列'] });
    const m = pointsToMaterials([p]);
    expect(m[0]!.anchors[0]!.quote).toBe('线性表是由 n 个数据元素构成的有限序列');
  });

  it('知识点没有引文时不编造 quote', () => {
    const p = makePoint({ quotes: [] });
    const m = pointsToMaterials([p]);
    expect(m[0]!.anchors[0]!.quote).toBeUndefined();
  });

  it('素材标明来源种类：知识点出题的 origin 是 knowledge', () => {
    /*
     * 这个字段决定落库时 knowledgePointId 写什么。
     * 原文出题的素材 id 是段落 id，写进 knowledgePointId 会让
     * 「错题 → 知识点」断链（实测库里 10 道题 0 命中）。
     */
    expect(pointsToMaterials([makePoint()])[0]!.origin).toBe('knowledge');
    expect(segmentsToMaterials([makeSeg()])[0]!.origin).toBe('segment');
  });
});

describe('segmentsToMaterials：从资料原文出题', () => {
  it('一段正文转成一条素材，页号来自段落', () => {
    const m = segmentsToMaterials([makeSeg()]);
    expect(m).toHaveLength(1);
    expect(m[0]!.id).toBe('seg1');
    expect(m[0]!.page).toBe(5);
    expect(m[0]!.chapter).toBe('第一章 线性表');
  });

  it('锚点覆盖整段（让用户看到完整上下文）', () => {
    const seg = makeSeg();
    const m = segmentsToMaterials([seg]);
    expect(m[0]!.anchors[0]).toMatchObject({
      sourceId: 's1',
      page: 5,
      charStart: 0,
      charEnd: seg.text.trim().length,
    });
  });

  it('quotes 装整段原文（模型需要完整上下文）', () => {
    const seg = makeSeg();
    const m = segmentsToMaterials([seg]);
    expect(m[0]!.quotes[0]).toBe(seg.text.trim());
  });

  it('太短的段落被跳过（页眉、孤行出不了题）', () => {
    const m = segmentsToMaterials([
      makeSeg({ id: 'short', text: '页眉' }),
      makeSeg({ id: 'ok' }),
    ]);
    expect(m.map((x) => x.id)).toEqual(['ok']);
  });

  it('空白段落被跳过', () => {
    const m = segmentsToMaterials([makeSeg({ id: 'blank', text: '   \n  ' })]);
    expect(m).toHaveLength(0);
  });

  it('不只依赖 charCount，而是按实际文本长度算（防止切错）', () => {
    // charCount 故意写错，锚点应该跟真实文本走
    const seg = makeSeg({ charCount: 9999 });
    const m = segmentsToMaterials([seg]);
    expect(m[0]!.anchors[0]!.charEnd).toBe(seg.text.trim().length);
    expect(m[0]!.anchors[0]!.charEnd).not.toBe(9999);
  });
});

describe('toSourcePoint：归一成后端认识的形状', () => {
  it('两种来源产出的素材都能转成同一种 SourcePoint', () => {
    const fromPoint = toSourcePoint(pointsToMaterials([makePoint()])[0]!);
    const fromSeg = toSourcePoint(segmentsToMaterials([makeSeg()])[0]!);

    // 后端只认这几个字段，两条来源都必须齐
    for (const sp of [fromPoint, fromSeg]) {
      expect(typeof sp.id).toBe('string');
      expect(typeof sp.statement).toBe('string');
      expect(Array.isArray(sp.quotes)).toBe(true);
      expect(typeof sp.cognitiveLevel).toBe('string');
    }
  });

  it('原文素材的 page 传给模型（只作顺序提示，不作输出依据）', () => {
    const sp = toSourcePoint(segmentsToMaterials([makeSeg()])[0]!);
    expect(sp.page).toBe(5);
  });
});

describe('pickRandom：整个知识库随机抽', () => {
  it('抽指定条数', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(pickRandom(items, 3)).toHaveLength(3);
  });

  it('要的比有的多时全给（不重复、不报错）', () => {
    const items = [1, 2, 3];
    const picked = pickRandom(items, 10);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });

  it('不改动原数组', () => {
    const items = [1, 2, 3, 4, 5];
    const before = [...items];
    pickRandom(items, 2);
    expect(items).toEqual(before);
  });

  it('抽出来的都是原数组里的元素', () => {
    const items = ['a', 'b', 'c', 'd'];
    for (const x of pickRandom(items, 2)) expect(items).toContain(x);
  });

  it('0 条时不报错', () => {
    expect(pickRandom([1, 2, 3], 0)).toEqual([]);
  });
});