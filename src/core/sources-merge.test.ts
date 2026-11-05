import { beforeEach, describe, expect, it } from 'vitest';
import { SourceService } from './sources.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * mergeSegments：OCR 局部识别的写回。
 *
 * ## 这些用例锁的是一个真实的数据损失 bug
 *
 * 用户点「只识别第 1 页」看效果时，早先走的是 `writeSegments`（整份替换）。
 * 628 页的扫描件在识别 1 页后只剩 1 段 —— 其余 627 页的页码与目录全没了，
 * 用户再也翻不回去，而且界面上只显示「识别完成」，看不出出过问题。
 *
 * 所以这里每一条都在验同一件事：**没被识别的页必须原样保留**。
 */
describe('mergeSegments：按页合并，不删未涉及的页', () => {
  let storage: MemoryStorage;
  let svc: SourceService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new SourceService(storage);
  });

  /** 造一份 628 页的扫描件：每页一段空正文（真实导入就是这样） */
  async function seedScanned(pageCount: number): Promise<string> {
    const ts = new Date().toISOString();
    await storage.put('sources', {
      id: 'src_scan',
      title: '信号与系统',
      fileName: 'a.pdf',
      kind: 'pdf' as const,
      courseId: null,
      pageCount,
      byteSize: 10,
      textStatus: 'no-text-layer' as const,
      segmentCount: pageCount,
      fileStored: true,
      createdAt: ts,
      updatedAt: ts,
    });
    await storage.putMany(
      'sourceSegments',
      Array.from({ length: pageCount }, (_, i) => ({
        id: `old_${i + 1}`,
        sourceId: 'src_scan',
        index: i + 1,
        page: i + 1,
        chapter: null,
        text: '',
        charCount: 0,
      })),
    );
    return 'src_scan';
  }

  it('只识别 1 页时，其余页必须原样保留（这是那个 bug）', async () => {
    const id = await seedScanned(628);

    const out = await svc.mergeSegments(id, [{ page: 1, text: '封面上的字' }], 'ready');

    expect(out).not.toBeNull();
    // 关键：仍然是 628 段，不是 1 段
    expect(out!.segments).toHaveLength(628);
    expect(out!.segments[0]!.text).toBe('封面上的字');
    // 第 2 页起还是原来的空段，页码没变
    expect(out!.segments[1]!.page).toBe(2);
    expect(out!.segments[627]!.page).toBe(628);
  });

  it('识别成功的页替换原正文，页码与顺序不动', async () => {
    const id = await seedScanned(5);

    const out = await svc.mergeSegments(
      id,
      [
        { page: 2, text: '第二页的字' },
        { page: 4, text: '第四页的字' },
      ],
      'ready',
    );

    const segs = out!.segments;
    expect(segs).toHaveLength(5);
    expect(segs.map((s) => s.page)).toEqual([1, 2, 3, 4, 5]);
    expect(segs[1]!.text).toBe('第二页的字');
    expect(segs[3]!.text).toBe('第四页的字');
    // 没识别的那几页仍是空正文
    expect(segs[0]!.text).toBe('');
    expect(segs[2]!.text).toBe('');
    // 重编号连续，不留空洞
    expect(segs.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('已识别过的页再识别一次，覆盖而不是追加', async () => {
    const id = await seedScanned(3);
    await svc.mergeSegments(id, [{ page: 1, text: '第一次' }], 'ready');
    const out = await svc.mergeSegments(id, [{ page: 1, text: '第二次' }], 'ready');

    expect(out!.segments).toHaveLength(3);
    expect(out!.segments[0]!.text).toBe('第二次');
  });

  it('保留原段 id：同一页再识别不会产生新段', async () => {
    const id = await seedScanned(2);
    const first = await svc.mergeSegments(id, [{ page: 1, text: '甲' }], 'ready');
    const idBefore = first!.segments[0]!.id;

    const second = await svc.mergeSegments(id, [{ page: 1, text: '乙' }], 'ready');
    expect(second!.segments[0]!.id).toBe(idBefore);
  });

  it('segmentCount 与状态一起更新', async () => {
    const id = await seedScanned(10);
    const out = await svc.mergeSegments(id, [{ page: 3, text: '有字了' }], 'ready');

    expect(out!.source.segmentCount).toBe(10);
    expect(out!.source.textStatus).toBe('ready');
  });

  it('资料不存在时返回 null，不抛错', async () => {
    const out = await svc.mergeSegments('不存在', [{ page: 1, text: 'x' }], 'ready');
    expect(out).toBeNull();
  });

  it('识别结果里出现超出现有页号时补到末尾，不丢数据', async () => {
    const id = await seedScanned(2);
    const out = await svc.mergeSegments(id, [{ page: 9, text: '补的页' }], 'ready');

    const segs = out!.segments;
    expect(segs).toHaveLength(3); // 原有 2 页 + 补的 1 页
    expect(segs[segs.length - 1]!.page).toBe(9);
    expect(segs[segs.length - 1]!.text).toBe('补的页');
  });
});
