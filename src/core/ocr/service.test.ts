import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { SourceService } from '../sources.ts';
import type { Source } from '../model.ts';
import { OcrService, checkOcrReadiness } from './service.ts';
import { OcrError } from './types.ts';
import type { VisionBackend, VisionPageInput, VisionPageResult } from './types.ts';

/**
 * OCR 核心层的测试。
 *
 * 这组测试守的是本轮最要紧的一件事：设置页的「看图识公式」勾选框
 * 必须真的驱动一条能跑的链路，而不是一个点了没事发生的假开关。
 *
 * 渲染与视觉后端都注入假实现 —— 真的渲染要 pdfjs + canvas，
 * 真的识别要花钱。而这条链路上最容易错的部分（逐页失败要不要继续、
 * 中途停止保不保留、识别不出来时状态怎么标）恰恰都不需要真模型。
 */

/** 造一份「扫描件」资料：有原始文件、但没有正文 */
async function seedScannedPdf(
  sources: SourceService,
  opts: { pageCount?: number; fileStored?: boolean; kind?: Source['kind'] } = {},
): Promise<Source> {
  const storage = (sources as unknown as { storage: MemoryStorage }).storage;
  const pageCount = opts.pageCount ?? 3;
  const ts = new Date().toISOString();

  const source: Source = {
    id: 'source_scan',
    title: '数据结构（扫描版）',
    fileName: '数据结构扫描.pdf',
    kind: opts.kind ?? 'pdf',
    courseId: null,
    pageCount,
    byteSize: 1024,
    textStatus: 'no-text-layer',
    segmentCount: pageCount,
    fileStored: opts.fileStored ?? true,
    createdAt: ts,
    updatedAt: ts,
  };
  await storage.put('sources', source);

  // 扫描件导入后是「每页一段、正文为空」
  await storage.putMany(
    'sourceSegments',
    Array.from({ length: pageCount }, (_, i) => ({
      id: `seg_old_${i + 1}`,
      sourceId: source.id,
      index: i + 1,
      page: i + 1,
      chapter: null,
      text: '',
      charCount: 0,
    })),
  );

  await storage.put('sourceFiles', {
    id: source.id,
    data: new Uint8Array([1, 2, 3, 4]).buffer,
    byteSize: 4,
    savedAt: ts,
  });

  return source;
}

/** 假视觉后端：按页码返回固定文本，可注入失败与延迟 */
function fakeVision(
  opts: {
    text?: (pageNo: number) => string;
    failOn?: number[];
    tokensPerPage?: number;
    /** 每页调用前检查这个信号 */
    onCall?: (input: VisionPageInput) => void;
  } = {},
): VisionBackend & { calls: number[] } {
  const calls: number[] = [];
  const failOn = new Set(opts.failOn ?? []);

  return {
    id: 'vision:test',
    label: '测试视觉后端',
    isMock: true,
    provider: 'test',
    calls,
    async extractPage(input: VisionPageInput): Promise<VisionPageResult> {
      calls.push(input.pageNo);
      opts.onCall?.(input);
      if (failOn.has(input.pageNo)) {
        throw new OcrError(
          `第 ${input.pageNo} 页识别失败`,
          '这一页可以单独重试。',
          'ocr-failed',
        );
      }
      return {
        text: opts.text ? opts.text(input.pageNo) : `第 ${input.pageNo} 页的正文`,
        actualTokens: opts.tokensPerPage ?? 10,
      };
    },
  };
}

/** 假渲染：返回一个合法的 data URL */
const fakeRender = vi.fn(async (_data: Uint8Array, page: number) => ({
  imageData: `data:image/png;base64,PAGE${page}`,
  width: 1400,
  height: 2000,
}));

describe('OcrService：逐页渲染 → 识别 → 写回', () => {
  let sources: SourceService;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    sources = new SourceService(storage);
    await seedScannedPdf(sources);
    fakeRender.mockClear();
  });

  it('把扫描件的空分段换成识别出的正文，并把 textStatus 置为 ready', async () => {
    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');
    expect(result).not.toBeNull();

    // 状态从「扫描件」变成「正常」—— 现在真的能搜索、能整理了
    expect(result!.source.textStatus).toBe('ready');
    expect(result!.source.segmentCount).toBe(3);
    expect(result!.succeeded).toBe(3);
    expect(result!.failures).toEqual([]);

    const segments = await sources.getSegments('source_scan');
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.text)).toEqual([
      '第 1 页的正文',
      '第 2 页的正文',
      '第 3 页的正文',
    ]);
    // 页码必须对得上，否则「点回原文」会跳到错的页
    expect(segments.map((s) => s.page)).toEqual([1, 2, 3]);
    expect(segments.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('每一页都先渲染再识别，图片真的交给了后端', async () => {
    const seen: string[] = [];
    const vision = fakeVision({
      onCall: (input) => {
        seen.push(input.imageDataUrl);
      },
    });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await service.run('source_scan');

    expect(fakeRender).toHaveBeenCalledTimes(3);
    // 后端收到的必须是我们渲染出来的那张图，而不是空字符串/裸 base64
    expect(seen).toEqual([
      'data:image/png;base64,PAGE1',
      'data:image/png;base64,PAGE2',
      'data:image/png;base64,PAGE3',
    ]);
  });

  it('写回时删掉旧的空分段，不留「前几页是空的」脏数据', async () => {
    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await service.run('source_scan');

    const storage = (sources as unknown as { storage: MemoryStorage }).storage;
    const all = await storage.getAll('sourceSegments');
    // 只剩新的 3 段，旧 seg_old_* 一条都不该留下
    expect(all).toHaveLength(3);
    expect(all.some((s) => s.id.startsWith('seg_old_'))).toBe(false);
  });

  it('charCount 等于正文长度（详情页的字数依赖它）', async () => {
    const vision = fakeVision({ text: (p) => `第${p}页ABC` });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await service.run('source_scan');

    const segments = await sources.getSegments('source_scan');
    for (const seg of segments) {
      expect(seg.charCount).toBe(seg.text.length);
    }
  });

  it('累计 token 如实汇总，不是按页数乱猜', async () => {
    const vision = fakeVision({ tokensPerPage: 37 });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');
    expect(result!.tokens).toBe(111);
  });

  it('后端没返回 usage 时不计入 token（不猜）', async () => {
    const vision = fakeVision();
    // 覆盖成 null
    vision.extractPage = async () => ({ text: '字', actualTokens: null });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');
    expect(result!.tokens).toBe(0);
  });
});

describe('OcrService：失败与中断', () => {
  let sources: SourceService;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    sources = new SourceService(storage);
    await seedScannedPdf(sources, { pageCount: 4 });
    fakeRender.mockClear();
  });

  it('单页失败不放弃整本，其余页照常识别并写回', async () => {
    const vision = fakeVision({ failOn: [2] });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan');

    expect(result!.succeeded).toBe(3);
    expect(result!.failures).toHaveLength(1);
    expect(result!.failures[0]!.pageNo).toBe(2);
    // 失败必须带 hint，不能只说「失败」
    expect(result!.failures[0]!.hint).toBeTruthy();

    /**
     * 有失败页时不再整份替换，而是按页合并 —— 失败那页（第 2 页）的原有
     * 分段会保留，页码仍是完整的 1..4。
     *
     * 早先这里断言 `[1, 3, 4]`（失败页被删掉）。那在「整篇替换」语义下成立，
     * 但正是这种语义造成了 628 页被写成 2 段的事故：一旦有页没识别出来，
     * 那些页就永久消失，用户再也翻不回去。留一个空段远好于删掉一页。
     */
    const segments = await sources.getSegments('source_scan');
    expect(segments.map((s) => s.page)).toEqual([1, 2, 3, 4]);
    expect(segments[1]!.text).toBe(''); // 失败页不编造内容
    expect(segments[0]!.text).toContain('第 1 页');
    expect(segments[2]!.text).toContain('第 3 页');
  });

  it('渲染失败也按单页处理，不影响其他页', async () => {
    const vision = fakeVision();
    const flakyRender = vi.fn(async (_d: Uint8Array, page: number) => {
      if (page === 3) throw new Error('canvas 崩了');
      return { imageData: `data:image/png;base64,P${page}`, width: 10, height: 10 };
    });
    const service = new OcrService({ sources, vision, renderPage: flakyRender });

    const result = await service.run('source_scan');
    expect(result!.failures.map((f) => f.pageNo)).toEqual([3]);
    expect(result!.succeeded).toBe(3);
  });

  it('中途停止：已识别的页保留，未跑的不再花钱', async () => {
    const controller = new AbortController();
    const vision = fakeVision({
      onCall: (input) => {
        // 第 2 页调完后就停止
        if (input.pageNo === 2) controller.abort();
      },
    });
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan', { signal: controller.signal });

    expect(result!.stopped).toBe(true);
    expect(vision.calls).toEqual([1, 2]);

    /**
     * ⚠️ 这条断言原本是 `toHaveLength(2)` / `[1, 2]` —— **那正是本次事故的成因**。
     *
     * 原语义：中途停止就把已识别的两页写成全部，其余页删除。
     * 现实中用户点「识别整篇」，跑到第 2 页停了，628 页的资料于是只剩 2 段，
     * 另外 626 页永远翻不回去。界面上还显示「识别完成」，用户毫不知情。
     *
     * 现在的语义：停止时只把已识别的页合并回去，其余页保留原样。
     * 用户既能看已识别的部分，也能继续翻原文、稍后再识别剩下的页。
     */
    const segments = await sources.getSegments('source_scan');
    expect(segments.map((s) => s.page)).toEqual([1, 2, 3, 4]);
    expect(segments[0]!.text).toContain('第 1 页');
    expect(segments[1]!.text).toContain('第 2 页');
    // 没跑的第 3/4 页仍是原空段
    expect(segments[2]!.text).toBe('');
    expect(segments[3]!.text).toBe('');
  });

  it('一页都没识别出来时保留原状态并报错，不假装成功', async () => {
    const failing = fakeVision({ failOn: [1, 2, 3, 4] });
    const service = new OcrService({ sources, vision: failing, renderPage: fakeRender });

    await expect(service.run('source_scan')).rejects.toBeInstanceOf(OcrError);

    // 状态没被改成 ready —— 否则界面会显示「正常」而正文是空的
    const source = await sources.get('source_scan');
    expect(source!.textStatus).toBe('no-text-layer');
  });

  it('整本都是空白页时也报错，不写成 ready', async () => {
    const blank = fakeVision({ text: () => '   ' });
    const service = new OcrService({ sources, vision: blank, renderPage: fakeRender });

    await expect(service.run('source_scan')).rejects.toThrow(/没有识别出任何文字/);
    const source = await sources.get('source_scan');
    expect(source!.textStatus).toBe('no-text-layer');
  });

  it('空白页不写空段，也不算失败', async () => {
    const mixed = fakeVision({ text: (p) => (p === 2 ? '' : `第${p}页`) });
    const service = new OcrService({ sources, vision: mixed, renderPage: fakeRender });

    const result = await service.run('source_scan');
    expect(result!.succeeded).toBe(3);
    expect(result!.failures).toEqual([]);
    expect(result!.segments.map((s) => s.page)).toEqual([1, 3, 4]);
  });
});

describe('OcrService：只识别指定页', () => {
  it('可以只跑第 2 页（先看效果再决定要不要跑整本）', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { pageCount: 5 });

    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    const result = await service.run('source_scan', { pages: [2] });
    expect(vision.calls).toEqual([2]);
    /**
     * 局部识别按页合并：**其余页必须保留**。
     *
     * 早先这里断言 `toHaveLength(1)` —— 那正是 bug 本身：
     * 5 页资料只识别第 2 页就只剩 1 段，另外 4 页再也翻不到。
     * 现实里 628 页的扫描件识别 1 页后只剩 1 页，用户以为资料被毁了。
     *
     * 现在的语义：识别到的那页替换正文，其余页原样保留。
     */
    expect(result!.segments).toHaveLength(5);
    expect(result!.segments[1]!.page).toBe(2);
    expect(result!.segments[1]!.text).toContain('第 2 页');
    expect(result!.segments.map((s) => s.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it('页码去重并升序，越界页被丢掉', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { pageCount: 3 });

    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await service.run('source_scan', { pages: [3, 1, 3, 99] });
    expect(vision.calls).toEqual([1, 3]);
  });
});

describe('OcrService：前置检查（花钱之前先拦住）', () => {
  it('非 PDF 不给走这条路', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { kind: 'docx' });

    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await expect(service.run('source_scan')).rejects.toThrow(/不是 PDF/);
    expect(vision.calls).toEqual([]);
  });

  it('原始文件不在本机时明确说「要重新导入」，而不是白跑一遍', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { fileStored: false });

    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await expect(service.run('source_scan')).rejects.toThrow(/原始文件不在本机/);
    expect(vision.calls).toEqual([]);
  });

  it('记录说存了但字节读不出来时也拦住', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { fileStored: true });
    await storage.remove('sourceFiles', 'source_scan');

    const vision = fakeVision();
    const service = new OcrService({ sources, vision, renderPage: fakeRender });

    await expect(service.run('source_scan')).rejects.toThrow(/读不出来/);
  });

  it('资料不存在时返回 null，不抛错', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    const service = new OcrService({
      sources,
      vision: fakeVision(),
      renderPage: fakeRender,
    });

    expect(await service.run('nope')).toBeNull();
  });

  it('checkOcrReadiness 每一项失败都给得出 hint', () => {
    const base: Source = {
      id: 's',
      title: '资料',
      fileName: 'a.pdf',
      kind: 'pdf',
      courseId: null,
      pageCount: 3,
      byteSize: 1,
      textStatus: 'no-text-layer',
      segmentCount: 3,
      fileStored: true,
      createdAt: '',
      updatedAt: '',
    };

    const noBackend = checkOcrReadiness(base, null);
    expect(noBackend.ok).toBe(false);
    expect(noBackend.hint).toBeTruthy();

    const ok = checkOcrReadiness(base, { provider: 'zhipu' });
    expect(ok.ok).toBe(true);
  });
});

describe('OcrService：进度回调', () => {
  it('逐页上报，最后 done 等于总页数', async () => {
    const storage = new MemoryStorage();
    const sources = new SourceService(storage);
    await seedScannedPdf(sources, { pageCount: 3 });

    const progress: number[] = [];
    const service = new OcrService({
      sources,
      vision: fakeVision(),
      renderPage: fakeRender,
      onProgress: (p) => progress.push(p.done),
    });

    await service.run('source_scan');

    // 第一页之前先报一次 0，界面才能立刻画出进度条
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(3);
  });
});
