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
