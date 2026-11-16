/**
 * DeepSeek OCR 的单测（2026-11-15）。
 *
 * 用户要求：「把调用 ocr 识别作为除了本地模型解析 pdf 的另一方式」。
 *
 * 这里钉的全是**官方文档里点名的坑**，不是凑数：
 *  - 识别失败时 HTTP 仍是 200（只看状态码会把错误当结果）
 *  - `pages[].index` 从 0 开始，而全项目用 1 基
 *  - 「重试有用」和「重试无用」要分开（文档给了明确分类）
 *  - 100 MiB 上限要提前拦
 */

import { describe, expect, it } from 'vitest';
import {
  parseOcrResponse,
  runOcr,
  stripOcrMarks,
  toMinerUShape,
} from './deepseek-ocr.ts';

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('parseOcrResponse：正常结果', () => {
  const body = {
    id: 'ocr-1',
    object: 'ocr.result',
    purpose: 'text_recognition',
    page_count: 2,
    pages: [
      { index: 0, text: '第一页正文', finish_reason: 'stop' },
      { index: 1, text: '第二页正文', finish_reason: 'stop' },
    ],
  };

  it('★ 官方 index 是 0 基，转成 1 基（全项目都用 1 基）', () => {
    const r = parseOcrResponse(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pages[0]?.page).toBe(1);
      expect(r.pages[1]?.page).toBe(2);
    }
  });

  it('正文原样带出', () => {
    const r = parseOcrResponse(body);
    if (r.ok) expect(r.pages[0]?.text).toBe('第一页正文');
  });

  it('pageCount 等于页数', () => {
    const r = parseOcrResponse(body);
    if (r.ok) expect(r.pageCount).toBe(2);
  });

  it('finish_reason=length 标成 truncated（该页文本不完整）', () => {
    const r = parseOcrResponse({
      pages: [
        { index: 0, text: 'a', finish_reason: 'stop' },
        { index: 1, text: 'b', finish_reason: 'length' },
      ],
    });
    if (r.ok) {
      expect(r.pages[0]?.truncated).toBe(false);
      expect(r.pages[1]?.truncated).toBe(true);
    }
  });

  it('页按页码排序（防服务端乱序）', () => {
    const r = parseOcrResponse({
      pages: [
        { index: 2, text: 'c' },
        { index: 0, text: 'a' },
        { index: 1, text: 'b' },
      ],
    });
    if (r.ok) expect(r.pages.map((p) => p.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('★ 识别失败但 HTTP 200（文档点名的坑）', () => {
  it('有 error 字段就当失败，不能把错误对象当结果', () => {
    const r = parseOcrResponse({
      error: {
        message: 'OCR did not finish in time',
        type: 'gateway_timeout_error',
        code: 'gateway_timeout_error',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('did not finish in time');
  });

  it('超时类错误标成「可重试」', () => {
    const r = parseOcrResponse({ error: { message: 'OCR did not finish in time', code: 'gateway_timeout_error' } });
    if (!r.ok) expect(r.retryable).toBe(true);
  });

  it('★ 密码保护 / 格式不支持 → 重试无用（要用户改文件）', () => {
    for (const msg of [
      'The file is password-protected and cannot be processed. Remove the password and upload it again.',
      'Failed to recognize the file: the file could not be parsed or its format is not supported',
      'Failed to recognize the file: the image could not be decoded',
      'Failed to recognize the file: the document has more than 1000 pages',
      'file is too large: max 100 MiB',
    ]) {
      const r = parseOcrResponse({ error: { message: msg } });
      expect(r.ok, msg).toBe(false);
      if (!r.ok) expect(r.retryable, msg).toBe(false);
    }
  });

  it('★ 服务繁忙 / 内部错误 → 稍后重试有用', () => {
    for (const msg of [
      'The OCR service is temporarily unavailable. Please try again later.',
      'Internal Server Error',
    ]) {
      const r = parseOcrResponse({ error: { message: msg } });
      if (!r.ok) expect(r.retryable, msg).toBe(true);
    }
  });
});

describe('parseOcrResponse：乱形状不崩', () => {
  it('不是对象', () => {
    for (const b of [null, undefined, 42, 'x', []]) {
      expect(parseOcrResponse(b).ok, String(b)).toBe(false);
    }
  });

  it('没有 pages', () => {
    const r = parseOcrResponse({ id: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('pages');
  });

  it('pages 是空数组 → 明确说没识别出内容', () => {
    const r = parseOcrResponse({ pages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('没有识别出');
  });

  it('pages 里混着垃圾项也不崩', () => {
    const r = parseOcrResponse({ pages: [null, 42, { index: 0, text: 'ok' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages).toHaveLength(1);
  });

  it('缺 index 时按出现顺序兜底（不丢页）', () => {
    const r = parseOcrResponse({ pages: [{ text: 'a' }, { text: 'b' }] });
    if (r.ok) expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
  });
});

describe('stripOcrMarks：剥版面标记但不动正文', () => {
  it('★ 文档给的例子能剥干净', () => {
    const raw = '<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>';
    expect(stripOcrMarks(raw)).toBe('标题');
  });

  it('半角竖线的变体也认', () => {
    expect(stripOcrMarks('<|ref|>标题<|/ref|>')).toBe('标题');
  });

  it('★ 正文一个字都不动', () => {
    const raw = '<｜ref｜>导数的定义是差商的极限<｜/ref｜>';
    expect(stripOcrMarks(raw)).toContain('导数的定义是差商的极限');
  });

  it('保留换行（段落边界有意义）', () => {
    const raw = '第一段\n\n第二段';
    expect(stripOcrMarks(raw)).toContain('\n');
  });

  it('三个以上连续换行压成两个', () => {
    expect(stripOcrMarks('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('行内多余空格压成一个', () => {
    expect(stripOcrMarks('a    b')).toBe('a b');
  });

  it('没有标记的纯文本原样返回', () => {
    expect(stripOcrMarks('普通正文，没有任何标记。')).toBe('普通正文，没有任何标记。');
  });
});

describe('toMinerUShape：转成现有写回链路认的形状', () => {
  const pages = [
    { page: 1, text: '第一页', truncated: false },
    { page: 2, text: '第二页', truncated: false },
  ];

  it('pageCount 与 pages 对齐', () => {
    const r = toMinerUShape(pages);
    expect(r.pageCount).toBe(2);
    expect(r.pages).toHaveLength(2);
  });

  it('★ figures 恒为空数组（OCR 不出图，不编造）', () => {
    const r = toMinerUShape(pages);
    expect(r.pages[0]?.figures).toEqual([]);
  });

  it('★ chapter 恒为 null（OCR 不给章节结构，不猜）', () => {
    const r = toMinerUShape(pages);
    expect(r.pages[0]?.chapter).toBeNull();
  });

  it('★ tier/producer 写明来源（界面能区分本地解析还是云 OCR）', () => {
    const r = toMinerUShape(pages);
    expect(r.tier).toBe('deepseek-ocr');
    expect(r.producer).toContain('DeepSeek OCR');
  });

  it('默认剥标记', () => {
    const r = toMinerUShape([{ page: 1, text: '<｜ref｜>标题<｜/ref｜>', truncated: false }]);
    expect(r.pages[0]?.text).toBe('标题');
  });

  it('可以要求保留标记（坐标以后有用）', () => {
    const r = toMinerUShape([{ page: 1, text: '<｜ref｜>标题<｜/ref｜>', truncated: false }], {
      stripMarks: false,
    });
    expect(r.pages[0]?.text).toContain('ref');
  });
});

describe('runOcr：真实调用路径', () => {
  it('没 Key 不发请求', async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return ok({ pages: [] });
    }) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'x.pdf',
      apiKey: '  ',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('空文件不发请求', async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return ok({ pages: [] });
    }) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('★ 超过 100 MiB 提前拦下（不白传）', async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return ok({ pages: [] });
    }) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      /* 只造一个长度标记，不真分配 100MB */
      bytes: { length: 101 * 1024 * 1024 } as unknown as Uint8Array,
      fileName: 'big.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('100 MiB');
    expect(called).toBe(false);
  });

  it('★ 拼的是 /v1/tools/ocr（不是 /chat/completions）', async () => {
    let seen = '';
    const fake = (async (url: string) => {
      seen = String(url);
      return ok({ pages: [{ index: 0, text: 'ok' }] });
    }) as unknown as typeof globalThis.fetch;

    await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(seen).toBe('https://api.deepseek.com/v1/tools/ocr');
  });

  it('baseUrl 带尾斜杠也能拼对', async () => {
    let seen = '';
    const fake = (async (url: string) => {
      seen = String(url);
      return ok({ pages: [{ index: 0, text: 'ok' }] });
    }) as unknown as typeof globalThis.fetch;

    await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com/',
      fetchImpl: fake,
    });
    expect(seen).toBe('https://api.deepseek.com/v1/tools/ocr');
  });

  it('★ 429 → 说明并发上限，标可重试', async () => {
    const fake = (async () =>
      ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('15');
      expect(r.retryable).toBe(true);
    }
  });

  it('★ 402 → 余额不足（不可重试）', async () => {
    const fake = (async () =>
      ({ ok: false, status: 402, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('余额');
      expect(r.retryable).toBe(false);
    }
  });

  it('★ 504 → 提示分片更小（这是分片方案的关键提示）', async () => {
    const fake = (async () =>
      ({ ok: false, status: 504, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    if (!r.ok) expect(r.reason).toContain('分片');
  });

  it('连不上 → 提到网络', async () => {
    const fake = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('连不上');
  });

  it('走通了会把 pages 转成 1 基返回', async () => {
    const fake = (async () =>
      ok({
        pages: [
          { index: 0, text: 'a', finish_reason: 'stop' },
          { index: 1, text: 'b', finish_reason: 'stop' },
        ],
      })) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      bytes: new Uint8Array([1]),
      fileName: 'x.pdf',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: fake,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
  });
});

/**
 * 413 的两种来源（2026-11-16 实测后新增）。
 *
 * ## 这一组钉的是一个真实误报
 *
 * 用户实测：55.07 MiB 的 PDF 被云 OCR 拒了，界面上却写「文件超过 100 MiB」。
 * 用户看着自己 55 MB 的文件，只会认为程序坏了。
 *
 * 真因（有实测证据）：
 *  - 1 KiB → HTTP 401 JSON（链路正常，认证在大小检查之前）
 *  - 55.07 MiB → HTTP 413 **HTML**，响应头 `server: openresty`，耗时 18.5 秒
 *    （= 整个文件传完才被网关拒）
 *  - 响应体是 `openresty` 的错误页，**不是 JSON**
 *
 * 也就是说服务端从没说过「100 MiB」，那句话是代码自己写死的：
 * 原实现 `if (res.status === 413) return 文件超过 100 MiB` —— **不读响应体**。
 *
 * 所以这里要分开验：
 *  - 应用层的 413（JSON error）→ 照服务端原话说
 *  - 网关层的 413（HTML）→ 说清是网关体积上限 + **写出实际发送的 MiB**
 *
 * ⚠️ 否定断言：新文案里**不许**再出现「超过 100 MiB」这种断言式说法
 * （网关的限制比 100 MiB 低，写死 100 就是在骗人）。
 */
describe('413：要分清网关层与应用层（2026-11-16 误报修复）', () => {
  /** 造一个只有 text() 的 Response —— 网关返回 HTML 时就是这样 */
  const htmlRes = (status: number, html: string) =>
    ({
      ok: false,
      status,
      text: async () => html,
      json: async () => {
        throw new SyntaxError('not json');
      },
    }) as unknown as Response;

  /** 应用层错误：JSON 体 */
  const jsonRes = (status: number, body: unknown) =>
    ({
      ok: false,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as unknown as Response;

  const GATEWAY_HTML =
    '<html>\n<head><title>413 Request Entity Too Large</title></head>\n' +
    '<body>\n<center><h1>413 Request Entity Too Large</h1></center>\n' +
    '<hr><center>openresty</center>\n</body>\n</html>\n';

  const base = {
    fileName: 'a.pdf',
    apiKey: 'sk-x',
    baseUrl: 'https://api.deepseek.com',
  };

  it('★ 网关返回 HTML 413 → 说「网关上限」，不说「超过 100 MiB」', async () => {
    const fake = (async () => htmlRes(413, GATEWAY_HTML)) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      ...base,
      /* 55.07 MiB：用户那份高等数学的实际体积 */
      bytes: new Uint8Array(Math.round(55.07 * 1024 * 1024)),
      fetchImpl: fake,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      /* 这是关键的否定断言：不能再说是 100 MiB 超了 */
      expect(r.reason).not.toContain('超过 100 MiB');
      /* 但要写出实际发了多大 —— 那是用户唯一能据以行动的数字 */
      expect(r.reason).toContain('55.1 MiB');
      /* 而且要指出是「网关」这一层，不是软件算错 */
      expect(r.reason).toContain('网关');
      expect(r.retryable).toBe(false);
    }
  });

  it('★ 应用层 JSON 413 → 照服务端原话说，不自己编', async () => {
    const fake = (async () =>
      jsonRes(413, { error: { message: 'file is too large: max 100 MiB' } })) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      ...base,
      bytes: new Uint8Array([1]),
      fetchImpl: fake,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      /* 服务端说了什么就显示什么 */
      expect(r.reason).toBe('file is too large: max 100 MiB');
    }
  });

  it('网关 413 里带 JSON 但没 error 字段 → 仍按网关处理', async () => {
    const fake = (async () =>
      jsonRes(413, { something: 'else' })) as unknown as typeof globalThis.fetch;

    const r = await runOcr({
      ...base,
      bytes: new Uint8Array(Math.round(2 * 1024 * 1024)),
      fetchImpl: fake,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('网关');
      expect(r.reason).toContain('2.0 MiB');
    }
  });
});
