import { describe, expect, it, vi } from 'vitest';
import { LocalTesseractBackend, stripCjkSpaces } from './local-backend.ts';
import { OcrError } from './types.ts';

/**
 * 本地 OCR 的测试。
 *
 * tesseract.js 真跑需要 Web Worker + wasm + 语言包，在 node 单测里起不来。
 * 所以这里注入假 worker，验的是**我们这一层的逻辑**：
 *   - 中文空格收紧
 *   - 空文本不伪装成成功
 *   - 引擎起不来时给出可操作提示，而不是抛原始错误
 *   - 不编造 token
 *   - 中止能被尊重
 *
 * 真实识别质量不在这里验（那是环境问题，且每次结果会有细微差异）。
 * 实测数据记在 local-backend.ts 的注释里。
 */

const fakeWorker = (text: string, confidence = 90) => ({
  recognize: vi.fn(async () => ({ data: { text, confidence } })),
  terminate: vi.fn(async () => undefined),
});

const img = { imageDataUrl: 'data:image/png;base64,AAAA', pageNo: 1, sourceTitle: '测试教材' };

describe('stripCjkSpaces：收紧中文分词的副产物', () => {
  it('删掉汉字之间的空格', () => {
    expect(stripCjkSpaces('第 一 章 数 据 结 构')).toBe('第一章数据结构');
  });

  it('保留英文单词之间的空格', () => {
    expect(stripCjkSpaces('data structure')).toBe('data structure');
  });

  it('保留英文与数字之间的空格', () => {
    expect(stripCjkSpaces('100 MB')).toBe('100 MB');
  });

  it('中英混排：只收紧汉字之间的空格，跨语言边界保留', () => {
    // 「list 的」是英文与中文相邻，保留空格更易读，也能避免把两个词粘死
    expect(stripCjkSpaces('线性 表 linear list 的 定义')).toBe('线性表 linear list 的定义');
  });

  it('中文标点两侧的空格也收掉', () => {
    expect(stripCjkSpaces('操作 。 线性 结构 包括')).toBe('操作。线性结构包括');
  });

  it('不改变原本没有空格的中文', () => {
    const s = '数据结构研究的是数据元素之间的关系';
    expect(stripCjkSpaces(s)).toBe(s);
  });
});

describe('LocalTesseractBackend：遵守 VisionBackend 契约', () => {
  it('标识与用途对得上', () => {
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => fakeWorker('x') });
    expect(b.id).toBe('local:tesseract');
    expect(b.provider).toBe('local');
    expect(b.isMock).toBe(false);
    expect(b.label).toContain('本地');
  });

  it('识别结果会收紧中文空格', async () => {
    const worker = fakeWorker('第 一 章 数 据 结 构 绪 论');
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => worker });
    const r = await b.extractPage(img);
    expect(r.text).toBe('第一章数据结构绪论');
  });

  it('不编造 token：本地识别没有 token 概念，返回 null', async () => {
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => fakeWorker('内容') });
    const r = await b.extractPage(img);
    expect(r.actualTokens).toBeNull();
  });

  it('整页空白时返回空串，而不是报错', async () => {
    // 整页插图的情况：模型没读出字，这不算失败
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => fakeWorker('   \n  ') });
    const r = await b.extractPage(img);
    expect(r.text).toBe('');
  });

  it('worker 只创建一次：逐页复用，不每页重载 wasm', async () => {
    const factory = vi.fn(async () => fakeWorker('内容'));
    const b = new LocalTesseractBackend({ createWorkerImpl: factory });
    await b.extractPage({ ...img, pageNo: 1 });
    await b.extractPage({ ...img, pageNo: 2 });
    await b.extractPage({ ...img, pageNo: 3 });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('LocalTesseractBackend：失败必须说清下一步', () => {
  it('引擎起不来时给可操作提示，不是原始报错', async () => {
    const b = new LocalTesseractBackend({
      createWorkerImpl: async () => {
        throw new Error('WASM not supported');
      },
    });
    const err = await b.extractPage(img).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect((err as OcrError).code).toBe('engine-unavailable');
    expect((err as OcrError).hint).toContain('看图模型');
  });

  it('创建失败后不缓存被拒的 Promise，下次能重试', async () => {
    let attempts = 0;
    const b = new LocalTesseractBackend({
      createWorkerImpl: async () => {
        attempts++;
        if (attempts === 1) throw new Error('第一次失败');
        return fakeWorker('第二次成功');
      },
    });
    await expect(b.extractPage(img)).rejects.toBeInstanceOf(OcrError);
    const r = await b.extractPage(img);
    expect(r.text).toBe('第二次成功');
    expect(attempts).toBe(2);
  });

  it('单页识别抛错时带上页码，方便只重试那一页', async () => {
    const b = new LocalTesseractBackend({
      createWorkerImpl: async () => ({
        recognize: async () => {
          throw new Error('图像解码失败');
        },
        terminate: async () => undefined,
      }),
    });
    const err = await b.extractPage({ ...img, pageNo: 7 }).catch((e: unknown) => e);
    expect((err as OcrError).message).toContain('第 7 页');
    expect((err as OcrError).code).toBe('page-failed');
  });

  it('拒绝非 data URL，避免把裸 base64 送进去', async () => {
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => fakeWorker('x') });
    const err = await b
      .extractPage({ ...img, imageDataUrl: 'AAAA' })
      .catch((e: unknown) => e);
    expect((err as OcrError).code).toBe('bad-image');
  });
});

describe('LocalTesseractBackend：停止与释放', () => {
  it('已中止的信号在开始前就返回，不做无用的识别', async () => {
    const worker = fakeWorker('不该被调用');
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => worker });
    const ac = new AbortController();
    ac.abort();
    const err = await b.extractPage({ ...img, signal: ac.signal }).catch((e: unknown) => e);
    expect((err as OcrError).code).toBe('aborted');
    expect(worker.recognize).not.toHaveBeenCalled();
  });

  it('dispose 会终止 worker，释放 wasm 内存', async () => {
    const worker = fakeWorker('内容');
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => worker });
    await b.extractPage(img);
    await b.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('dispose 后还能重新创建（用户可能再识别一次）', async () => {
    const factory = vi.fn(async () => fakeWorker('内容'));
    const b = new LocalTesseractBackend({ createWorkerImpl: factory });
    await b.extractPage(img);
    await b.dispose();
    await b.extractPage(img);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('没跑过就 dispose 不报错', async () => {
    const b = new LocalTesseractBackend({ createWorkerImpl: async () => fakeWorker('x') });
    await expect(b.dispose()).resolves.toBeUndefined();
  });
});
