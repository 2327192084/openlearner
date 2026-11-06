import { beforeEach, describe, expect, it } from 'vitest';
import { SourceService } from './sources.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * rebuildSegments：用保留下来的原始文件重建分段。
 *
 * ## 为什么需要这个能力
 *
 * 真实事故：628 页的扫描件被 OCR 写成 2 段，其余 626 页翻不回去。
 * 原始字节还在，就该能重新解析还原 —— 不该逼用户删掉重导，
 * 重导会丢掉已有知识点与题目对这份资料的引用。
 *
 * 所以这里验的是「能不能从原始文件救回来」，以及「救不了时是否说清原因」。
 */
describe('rebuildSegments：从原始文件重建正文', () => {
  let storage: MemoryStorage;
  let svc: SourceService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new SourceService(storage);
  });

  /** 造一份「页数 5、但只剩 1 段」的坏资料，并保留原始文件 */
  async function seedBroken(withFile: boolean): Promise<string> {
    const ts = new Date().toISOString();
    await storage.put('sources', {
      id: 'src_broken',
      title: '信号与系统',
      fileName: 'book.pdf',
      kind: 'pdf' as const,
      courseId: null,
      pageCount: 5,
      byteSize: 100,
      textStatus: 'ready' as const,
      segmentCount: 1,
      fileStored: withFile,
      createdAt: ts,
      updatedAt: ts,
    });
    await storage.putMany('sourceSegments', [
      {
        id: 'seg_only',
        sourceId: 'src_broken',
        index: 1,
        page: 1,
        chapter: null,
        text: '只剩这一段的正文',
        charCount: 8,
      },
    ]);
    if (withFile) {
      await storage.put('sourceFiles', {
        id: 'src_broken',
        data: new Uint8Array([1, 2, 3]).buffer,
        byteSize: 3,
        savedAt: ts,
      });
    }
    return 'src_broken';
  }

  it('没有原始文件时说清原因，不假装成功', async () => {
    const id = await seedBroken(false);
    const out = await svc.rebuildSegments(id);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      // 必须给出「能不能做、下一步怎么办」，而不是一句失败
      expect(out.reason).toContain('没有保留原始文件');
      expect(out.hint.length).toBeGreaterThan(0);
    }
  });

  it('资料不存在时返回 ok:false，不抛错', async () => {
    const out = await svc.rebuildSegments('不存在');
    expect(out.ok).toBe(false);
  });

  it('有原始文件时会把旧段交给解析器重建（失败也要有提示）', async () => {
    // 这里用的是 3 字节的假 PDF，解析必然失败 —— 验的是「失败路径也说清原因」
    const id = await seedBroken(true);
    const out = await svc.rebuildSegments(id);

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.hint.length).toBeGreaterThan(0);
    }
  });

  it('重建不会破坏 source 记录本身（标题、课程归属都保留）', async () => {
    const id = await seedBroken(true);
    await svc.rebuildSegments(id);

    const after = await storage.get('sources', id);
    expect(after).not.toBeNull();
    expect(after!.title).toBe('信号与系统');
    expect(after!.kind).toBe('pdf');
  });
});
