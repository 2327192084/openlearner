/**
 * DeepSeek OCR 的 runner 包装（2026-11-15）。
 *
 * 这个 runner 的价值是**伪装成 MinerU**：
 * `ConvertPanel` 只认 `{ pageCount, pages[], tier, producer }`，
 * 所以云 OCR 接进来时界面一行都不用改。
 */

import { describe, expect, it } from 'vitest';
import { createDeepSeekOcrRunner } from './ocr-runner.ts';

const okResponse = (pages: { index: number; text: string }[]) =>
  ({ ok: true, status: 200, json: async () => ({ pages }) }) as unknown as Response;

describe('伪装成 MinerU runner', () => {
  it('available 为 true（给了 Key 就能跑）', () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
    });
    expect(r.available).toBe(true);
  });

  it('★ 返回的形状能被现有写回链路直接吃（pageCount/pages/tier/producer）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1, 2, 3]),
      fetchImpl: (async () =>
        okResponse([
          { index: 0, text: '第一页' },
          { index: 1, text: '第二页' },
        ])) as unknown as typeof globalThis.fetch,
    });

    const result = await r.run({ filePath: '/tmp/书.pdf', exePath: '', outDir: '' });
    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.page).toBe(1);
    expect(result.pages[0]?.text).toBe('第一页');
  });

  it('★ tier/producer 标明来源（界面能区分本地解析还是云 OCR）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });
    const result = await r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' });
    expect(result.tier).toBe('deepseek-ocr');
    expect(result.producer).toContain('DeepSeek OCR');
  });

  it('★ figures 恒为空（官方 OCR 不出图，不编造）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });
    const result = await r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' });
    expect(result.pages[0]?.figures).toEqual([]);
  });

  it('★ chapter 恒为 null（不猜章节结构）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });
    const result = await r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' });
    expect(result.pages[0]?.chapter).toBeNull();
  });
});

describe('进度回调', () => {
  it('至少报三个阶段（上传 / 识别 / 完成）', async () => {
    const phases: string[] = [];
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });

    await r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' }, (p) => phases.push(p.phase));

    expect(phases.length).toBeGreaterThanOrEqual(3);
    /*
     * 实现里的顺序是：读取文件 → 上传 → 识别完成。
     * 断言要贴着实现（而不是我最初想象的顺序）—— 但**必须**保证
     * 「上传」与「完成」都在，中间有过程提示。
     */
    expect(phases.join(' ')).toContain('上传');
    expect(phases.join(' ')).toContain('识别');
    expect(phases[phases.length - 1]).toContain('完成');
  });
});

describe('失败路径', () => {
  it('★ 出错时抛异常并带上可读原因（由 ConvertPanel 显示）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () =>
        ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch,
    });

    await expect(r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' })).rejects.toThrow(/15/);
  });

  it('没 Key 时也抛（而不是静默返回空结果）', async () => {
    const r = createDeepSeekOcrRunner({
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });
    await expect(r.run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' })).rejects.toThrow(/API Key/);
  });
});

describe('文件名', () => {
  it('★ 从路径取文件名传给服务（官方要求带扩展名，它据此判断解析方式）', async () => {
    let sentName = '';
    const r = createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        const file = form.get('file');
        if (file instanceof Blob && 'name' in file) sentName = String((file as File).name);
        return okResponse([{ index: 0, text: 'x' }]);
      }) as unknown as typeof globalThis.fetch,
    });

    await r.run({ filePath: 'E:\\资料\\高等数学.pdf', exePath: '', outDir: '' });
    expect(sentName).toBe('高等数学.pdf');
  });
});

/**
 * 页范围：云 OCR 只能整份上传（2026-11-16 新增）。
 *
 * ## 这一组钉的是一个「静默忽略」
 *
 * `request.pages` 原先在这个 runner 里**一次都没被读过**：
 * 用户在界面上选「解析 1-50 页」，云 OCR 照样把整份 442 页传上去，
 * 然后撞上网关的 413。用户会以为「分批没用，这功能坏的」，
 * 而真相是分批的请求根本没生效。
 *
 * **静默忽略比报错更糟** —— 它让用户以为自己在上传量上有控制权。
 * 所以现在的行为是：明确要求了页范围 → 直接说做不到，并给出替代做法。
 *
 * 反向验证：把 `run` 里那段拦页范围的代码删掉，这两条会挂。
 */
describe('页范围：做不到就说做不到，不静默忽略', () => {
  const mk = (readCalls: { n: number }) =>
    createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => {
        readCalls.n += 1;
        return new Uint8Array([1, 2, 3]);
      },
      fetchImpl: (async () => okResponse([{ index: 0, text: 'x' }])) as unknown as typeof globalThis.fetch,
    });

  it('★ 指定了页范围 → 报错说清做不到，且**不读文件、不发请求**', async () => {
    const calls = { n: 0 };
    const r = mk(calls);

    await expect(
      r.run({ filePath: '/tmp/书.pdf', exePath: '', outDir: '', pages: '1-50' }),
    ).rejects.toThrow(/只能整份上传/);

    /* 关键：连文件都不该读 —— 读了就说明它准备整份传上去 */
    expect(calls.n).toBe(0);
  });

  it('★ 报错里要指出替代做法（本机 MinerU 支持按页）', async () => {
    const r = mk({ n: 0 });
    await expect(
      r.run({ filePath: '/tmp/书.pdf', exePath: '', outDir: '', pages: '3-15' }),
    ).rejects.toThrow(/MinerU/);
  });

  it('pages 为 "all"（完整解析）→ 正常上传，不拦', async () => {
    const r = mk({ n: 0 });
    const result = await r.run({ filePath: '/tmp/书.pdf', exePath: '', outDir: '', pages: 'all' });
    expect(result.pageCount).toBe(1);
  });

  it('不传 pages → 正常上传（默认整份）', async () => {
    const r = mk({ n: 0 });
    const result = await r.run({ filePath: '/tmp/书.pdf', exePath: '', outDir: '' });
    expect(result.pageCount).toBe(1);
  });
});

/**
 * 诊断可读性：出错时抛的 Error 要带 `trouble`（2026-11-16 新增）。
 *
 * ## 为什么这条重要
 *
 * ConvertPanel 靠 `err.trouble` 选提示语。不标的话会落到 default，
 * 说「再试一次；如果一直失败，看看 **MinerU 那边的日志**」——
 * 可用户走的是云 OCR，本机可能根本没装 MinerU。
 * 让人去找一个不存在的东西，比不给提示更糟。
 */
describe('失败时的 trouble 标记', () => {
  const mkFail = () =>
    createDeepSeekOcrRunner({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      readFile: async () => new Uint8Array([1]),
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 402,
          text: async () => '',
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof globalThis.fetch,
    });

  it('★ 云 OCR 失败 → err.trouble === "cloud-ocr"（界面据此选提示）', async () => {
    try {
      await mkFail().run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '' });
      throw new Error('应该抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error & { trouble?: string }).trouble).toBe('cloud-ocr');
    }
  });

  it('★ 拦页范围时也带 trouble（否则会落到「看 MinerU 日志」）', async () => {
    try {
      await mkFail().run({ filePath: '/tmp/a.pdf', exePath: '', outDir: '', pages: '1-10' });
      throw new Error('应该抛错');
    } catch (e) {
      expect((e as Error & { trouble?: string }).trouble).toBe('cloud-ocr');
    }
  });
});
