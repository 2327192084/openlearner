import { describe, expect, it } from 'vitest';
import { listOralScopes, materialsForScope } from './oral-scope-service.ts';
import type { Source, SourceSegment } from './model.ts';
import type { SourceService } from './sources.ts';

/**
 * 用假 SourceService 测：本模块的职责是「范围 → 段落筛选 → 素材池」，
 * 不需要真的 IndexedDB。真实库路径由端到端脚本覆盖。
 */
function fakeService(
  sources: Source[],
  segsBySource: Record<string, SourceSegment[]>,
): SourceService {
  return {
    list: async () => sources,
    get: async (id: string) => sources.find((s) => s.id === id) ?? null,
    getSegments: async (id: string) => segsBySource[id] ?? [],
  } as unknown as SourceService;
}

function src(id: string, title: string): Source {
  return {
    id,
    title,
    fileName: null,
    kind: 'text',
    courseId: null,
    pageCount: null,
    textStatus: 'ready',
    segmentCount: 0,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  } as unknown as Source;
}

function seg(id: string, sourceId: string, page: number, chapter: string | null, text: string): SourceSegment {
  return { id, sourceId, index: page, page, chapter, text, charCount: text.length };
}

/**
 * 够长、能过 80 字门槛的正文。
 *
 * ⚠️ 注意长度：单句 39 字，必须有 3 句（117 字）才稳过门槛。
 * 第一版写成 repeat(2) = 78 字，比门槛少 2 个字，
 * 于是**所有**「该出现的选项」都消失了，9 条断言一起红。
 * 这不是代码错，是测试数据卡在阈值下面 —— 但正是这种边界
 * 让它暴露得很快，比写成 200 字然后永远不测边界要好。
 */
const LONG = '离散时间信号可以表示为一个序列，当序列中只有一个元素不为零时称为单位脉冲序列。'.repeat(3);
/** 太短，会被 segmentsToMaterials 过滤掉 */
const SHORT = '页眉';

describe('materialsForScope', () => {
  const s1 = src('src_1', '信号与系统');
  const s2 = src('src_2', '概率论');
  const segs = {
    src_1: [
      seg('a1', 'src_1', 1, '1.1 信号', LONG),
      seg('a2', 'src_1', 2, '1.1 信号', LONG),
      seg('a3', 'src_1', 3, '1.2 系统', LONG),
      seg('a4', 'src_1', 4, null, LONG),
      seg('a5', 'src_1', 5, '1.1 信号', SHORT),
    ],
    src_2: [seg('b1', 'src_2', 1, '2.1 概率', LONG)],
  };
  const svc = fakeService([s1, s2], segs);

  it('整份资料：取该资料全部合格段落，短段落被过滤', async () => {
    const out = await materialsForScope(svc, { kind: 'source', sourceId: 'src_1', title: '信号与系统' });
    expect(out).toHaveLength(4);
    expect(out.every((m) => m.sourceId === 'src_1')).toBe(true);
    /* page 5 那条 SHORT 不该出现 */
    expect(out.some((m) => m.page === 5)).toBe(false);
  });

  it('整份资料：label 带资料名、章节与页码', async () => {
    const out = await materialsForScope(svc, { kind: 'source', sourceId: 'src_1', title: '信号与系统' });
    const p1 = out.find((m) => m.page === 1)!;
    expect(p1.label).toContain('信号与系统');
    expect(p1.label).toContain('1.1 信号');
    expect(p1.label).toContain('第 1 页');
  });

  it('指定章节：只取该章段落', async () => {
    const out = await materialsForScope(svc, {
      kind: 'chapter',
      sourceId: 'src_1',
      chapter: '1.1 信号',
      title: '信号与系统',
    });
    /* 第 1、2 页合格，第 5 页太短 */
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.page).sort()).toEqual([1, 2]);
  });

  it('指定章节：章名首尾空白不影响匹配', async () => {
    const out = await materialsForScope(svc, {
      kind: 'chapter',
      sourceId: 'src_1',
      chapter: '  1.2 系统  ',
      title: '信号与系统',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.page).toBe(3);
  });

  it('整库随机：跨资料取，label 各自带自己的资料名', async () => {
    const out = await materialsForScope(svc, { kind: 'all' });
    expect(out).toHaveLength(5);
    expect(out.some((m) => m.label.includes('信号与系统'))).toBe(true);
    expect(out.some((m) => m.label.includes('概率论'))).toBe(true);
  });

  it('资料不存在时返回空数组，不抛错', async () => {
    await expect(
      materialsForScope(svc, { kind: 'source', sourceId: 'nope', title: 'x' }),
    ).resolves.toEqual([]);
  });

  it('划选 / 知识点两种范围不走本模块，返回空数组', async () => {
    expect(await materialsForScope(svc, { kind: 'segment', sourceId: 'src_1', segmentId: 'a1', title: 'x' })).toEqual([]);
    expect(await materialsForScope(svc, { kind: 'points', pointIds: ['p1'], title: 'x' })).toEqual([]);
  });

  it('没写章节的段落不进任何章节范围，但进整份资料范围', async () => {
    const chapterOut = await materialsForScope(svc, {
      kind: 'chapter',
      sourceId: 'src_1',
      chapter: '1.1 信号',
      title: '信号与系统',
    });
    expect(chapterOut.some((m) => m.page === 4)).toBe(false);

    const sourceOut = await materialsForScope(svc, { kind: 'source', sourceId: 'src_1', title: '信号与系统' });
    expect(sourceOut.some((m) => m.page === 4)).toBe(true);
  });
});

describe('listOralScopes', () => {
  const s1 = src('src_1', '信号与系统');
  const s2 = src('src_2', '概率论');
  const svc = fakeService([s1, s2], {
    src_1: [
      seg('a1', 'src_1', 1, '1.1 信号', LONG),
      seg('a2', 'src_1', 2, '1.2 系统', LONG),
    ],
    src_2: [seg('b1', 'src_2', 1, '2.1 概率', LONG)],
  });

  it('包含「整库随机」，且排第一', async () => {
    const out = await listOralScopes(svc, [s1, s2]);
    expect(out[0]!.scope.kind).toBe('all');
  });

  it('整库随机的 count 等于各资料素材数之和', async () => {
    const out = await listOralScopes(svc, [s1, s2]);
    const all = out.find((o) => o.id === 'all')!;
    expect(all.count).toBe(3);
  });

  it('每份资料给一个「整本」选项', async () => {
    const out = await listOralScopes(svc, [s1, s2]);
    expect(out.some((o) => o.id === 'source:src_1')).toBe(true);
    expect(out.some((o) => o.id === 'source:src_2')).toBe(true);
  });

  it('章节按资料分组列出，label 带资料名避免同名章混淆', async () => {
    const out = await listOralScopes(svc, [s1, s2]);
    const ch = out.find((o) => o.id === 'chapter:src_1:1.1 信号')!;
    expect(ch.label).toContain('信号与系统');
    expect(ch.label).toContain('1.1 信号');
    expect(ch.scope).toMatchObject({ kind: 'chapter', sourceId: 'src_1', chapter: '1.1 信号' });
  });

  it('素材为 0 的章节不出现（不做假开关）', async () => {
    const onlyShort = fakeService([src('src_3', '空章资料')], {
      src_3: [seg('c1', 'src_3', 1, '3.1 只有页眉', SHORT)],
    });
    const out = await listOralScopes(onlyShort, [src('src_3', '空章资料')]);
    expect(out.every((o) => !o.id.includes('3.1 只有页眉'))).toBe(true);
  });

  it('整份资料全是短段落时不给「整本」选项', async () => {
    const onlyShort = fakeService([src('src_4', '短资料')], {
      src_4: [seg('d1', 'src_4', 1, null, SHORT)],
    });
    const out = await listOralScopes(onlyShort, [src('src_4', '短资料')]);
    expect(out.some((o) => o.id === 'source:src_4')).toBe(false);
    /* 整库随机的 count 相应为 0（界面据此禁用或隐藏） */
    expect(out.find((o) => o.id === 'all')!.count).toBe(0);
  });

  it('没有资料时只返回「整库随机」且 count 为 0', async () => {
    const empty = fakeService([], {});
    const out = await listOralScopes(empty, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.scope.kind).toBe('all');
    expect(out[0]!.count).toBe(0);
  });
});
