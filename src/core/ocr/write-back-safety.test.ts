import { beforeEach, describe, expect, it } from 'vitest';
import { OcrService } from './service.ts';
import type { VisionBackend, VisionPageInput, VisionPageResult } from './types.ts';
import { SourceService } from '../sources.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';

/**
 * OCR 中途停止 / 有失败页时，**绝不能**整份替换分段。
 *
 * ## 这些用例锁的是一个真实的数据损失事故
 *
 * 用户点「识别整篇」→ `options.pages` 为 undefined → 旧代码用
 * `!options.pages` 判定「这是整篇」→ 走 `writeSegments`（整份替换）→
 * 但实际只跑完 2 页就停了 → 628 段的资料被删成 2 段，
 * 其余 626 页再也翻不回去，界面上还显示「识别完成」。
 *
 * 关键错误：**「请求了整篇」不等于「跑完了整篇」**。
 * 判断依据必须是实际完成情况（覆盖全部页 + 无失败 + 未停止）。
 */

function fakeVision(opts: {
  failOn?: number[];
  onCall?: (input: VisionPageInput) => void;
  text?: (pageNo: number) => string;
} = {}): VisionBackend & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: 'fake',
    label: '假后端',
    isMock: true,
    provider: 'fake',
    calls,
    async extractPage(input: VisionPageInput): Promise<VisionPageResult> {
      calls.push(input.pageNo);
      opts.onCall?.(input);
      if (opts.failOn?.includes(input.pageNo)) throw new Error(`第 ${input.pageNo} 页失败`);
      return {
        text: opts.text ? opts.text(input.pageNo) : `第 ${input.pageNo} 页的正文内容在这里`,
        actualTokens: 10,
      };
    },
  };
}

function fakeRender(_data: Uint8Array, page: number) {
  return Promise.resolve({ imageData: `data:image/png;base64,P${page}`, width: 100, height: 100 });
}

const fakePdf = new Uint8Array(2048);
fakePdf.set(new TextEncoder().encode('%PDF-1.7'));

async function seedScanned(storage: MemoryStorage, pageCount: number) {
  const ts = new Date().toISOString();
  await storage.put('sources', {
    id: 'source_scan',
    title: '扫描教材',
    fileName: 'book.pdf',
    kind: 'pdf' as const,
    courseId: null,
    pageCount,
    byteSize: fakePdf.byteLength,
    textStatus: 'no-text-layer' as const,
    segmentCount: pageCount,
    fileStored: true,
    createdAt: ts,
    updatedAt: ts,
  });
  await storage.putMany(
    'sourceSegments',
    Array.from({ length: pageCount }, (_, i) => ({
      id: `seg_old_${i + 1}`,
      sourceId: 'source_scan',
      index: i + 1,
      page: i + 1,
      chapter: null,
      text: '',
      charCount: 0,
    })),
  );
  await storage.put('sourceFiles', {
    id: 'source_scan',
    data: fakePdf.buffer,
    byteSize: fakePdf.byteLength,
    savedAt: ts,
  });
}

describe('OCR 写回：只有真的跑完全部页才允许整份替换', () => {
  let storage: MemoryStorage;
  let sources: SourceService;

  beforeEach(async () => {
    storage = new MemoryStorage();
    sources = new SourceService(storage);
    await seedScanned(storage, 20);
  });

  it('点「识别整篇」但中途停止：其余页必须保留（628→2 那个事故）', async () => {
    const controller = new AbortController();
    const vision = fakeVision({
      onCall: (input) => {
        // 只跑完第 2 页就停
        if (input.pageNo === 2) controller.abort();
      },
    });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    // 注意：不传 pages —— 这正是「识别整篇」的调用方式
    const result = await service.run('source_scan', { signal: controller.signal });

    expect(result!.stopped).toBe(true);
    // 关键断言：仍然是 20 段，不是 2 段
    expect(result!.segments).toHaveLength(20);
    expect(result!.segments.map((s) => s.page)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // 前两页有正文，其余仍是空段
    expect(result!.segments[0]!.text).toContain('第 1 页');
    expect(result!.segments[1]!.text).toContain('第 2 页');
    expect(result!.segments[2]!.text).toBe('');
  });

  it('有失败页时也不整份替换：未识别的页要留着', async () => {
    const vision = fakeVision({ failOn: [3] });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');

    expect(result!.failures).toHaveLength(1);
    // 19 页识别成功 + 失败那页保留原空段 = 20
    expect(result!.segments).toHaveLength(20);
    expect(result!.segments[2]!.text).toBe('');
  });

  it('真的跑完全部页且无失败：才整份替换，清掉旧的空段', async () => {
    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');

    expect(result!.stopped).toBe(false);
    expect(result!.failures).toHaveLength(0);
    // 替换后是全新 id（旧 seg_old_* 已被清掉）
    const all = await storage.getAll('sourceSegments');
    expect(all.some((s) => s.id.startsWith('seg_old_'))).toBe(false);
    expect(result!.segments).toHaveLength(20);
  });

  it('局部识别（只跑 3 页）不整份替换', async () => {
    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan', { pages: [1, 2, 3] });

    expect(result!.segments).toHaveLength(20);
    expect(result!.segments[0]!.text).toContain('第 1 页');
    expect(result!.segments[5]!.text).toBe('');
  });
});
