/**
 * 桌面端模型代理适配器的测试。
 *
 * 这一层的存在理由（也是测试要守住的边界）：
 * `file://` 下页面发不出跨源请求，多数服务商在桌面版会全线 Failed to fetch。
 * 把请求交给主进程转发就绕开了同源策略。
 *
 * 这里不测主进程本身（那是 .cjs，跑在 Electron 里），
 * 只测渲染进程这一侧「怎么调、怎么把结果变回 Response、失败怎么表达」。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createElectronChatFetch,
  hasChatBridge,
  readChatBridge,
  resolveChatFetch,
} from './electron-fetch.ts';

/** 主进程代理的返回形状（与 preload 声明一致） */
type BridgeResult =
  | { ok: true; status: number; text: string }
  | { ok: false; kind: string; message: string };

/** 造一个记录调用参数的假桥 */
function makeBridge(
  response: BridgeResult = {
    ok: true,
    status: 200,
    text: '{"choices":[{"message":{"content":"ok"}}]}',
  },
) {
  const calls: { url: string; apiKey: string; body: string; timeoutMs?: number }[] = [];
  const bridge = {
    chat: vi.fn(async (request: { url: string; apiKey: string; body: string; timeoutMs?: number }) => {
      calls.push(request);
      return response;
    }),
  };
  return { bridge, calls };
}

const URL_OK = 'https://api.deepseek.com/chat/completions';

describe('hasChatBridge / readChatBridge', () => {
  it('没有桥时判定为不可用（浏览器环境）', () => {
    expect(hasChatBridge(undefined)).toBe(false);
    expect(hasChatBridge(null)).toBe(false);
    expect(hasChatBridge({})).toBe(false);
  });

  it('有 chat 方法才算可用', () => {
    expect(hasChatBridge(makeBridge().bridge)).toBe(true);
  });

  it('Node 测试环境里读不到 window，返回 undefined 而不是抛错', () => {
    expect(readChatBridge()).toBeUndefined();
  });
});

describe('resolveChatFetch', () => {
  it('没有桥时退回原生 fetch（浏览器/测试）', () => {
    expect(resolveChatFetch(undefined)).toBe(fetch);
  });

  it('有桥时返回代理适配器，不是原生 fetch', () => {
    const { bridge } = makeBridge();
    expect(resolveChatFetch(bridge)).not.toBe(fetch);
  });
});

describe('createElectronChatFetch', () => {
  it('把 URL / Key / 请求体原样交给主进程', async () => {
    const { bridge, calls } = makeBridge();
    const proxyFetch = createElectronChatFetch(bridge);

    await proxyFetch(URL_OK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-abc123' },
      body: '{"model":"deepseek-chat"}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_OK);
    // 桥只收裸 Key，`Bearer ` 前缀由主进程加回去 —— 两边各拼一次会出现
    // `Authorization: Bearer Bearer sk-...`，401 且极难查
    expect(calls[0].apiKey).toBe('sk-abc123');
    expect(calls[0].body).toBe('{"model":"deepseek-chat"}');
  });

  it('成功时把响应体和状态码还原成 Response', async () => {
    const { bridge } = makeBridge({ ok: true, status: 200, text: '{"hello":"世界"}' });
    const proxyFetch = createElectronChatFetch(bridge);

    const response = await proxyFetch(URL_OK, { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    // 中文不能被转义成 \\uXXXX —— 模型输出里全是中文，错了就是乱码
    expect(await response.text()).toBe('{"hello":"世界"}');
  });

  it('***** 非 200 状态码必须原样交回，不能被当成成功 *****', async () => {
    // 这是最容易写错的一处：主进程把 401 当成「拿到了响应」而 ok=true 返回，
    // 适配器如果一律造 200 Response，chat-client 就会去解析错误响应体，
    // 最后报「服务返回里没有内容」，用户完全不知道是 Key 失效。
    const { bridge } = makeBridge({
      ok: true,
      status: 401,
      text: '{"error":{"message":"invalid api key"}}',
    });
    const proxyFetch = createElectronChatFetch(bridge);

    const response = await proxyFetch(URL_OK, { method: 'POST', body: '{}' });

    expect(response.status).toBe(401);
    expect(response.ok).toBe(false);
  });

  it('主进程拒绝时抛错，错误信息里带可读原因', async () => {
    const { bridge } = makeBridge({
      ok: false,
      kind: 'forbidden-host',
      message: '不允许访问内网地址（192.168.1.1）',
    });
    const proxyFetch = createElectronChatFetch(bridge);

    await expect(proxyFetch('https://192.168.1.1/chat/completions', { method: 'POST', body: '{}' }))
      .rejects.toThrow(/不允许访问内网地址/);
  });

  it('调用方已取消时不再发请求（避免点了取消还花钱）', async () => {
    const { bridge, calls } = makeBridge();
    const proxyFetch = createElectronChatFetch(bridge);
    const controller = new AbortController();
    controller.abort();

    await expect(
      proxyFetch(URL_OK, { method: 'POST', body: '{}', signal: controller.signal }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it('支持 URL 对象与 Request 形状的入参', async () => {
    const { bridge, calls } = makeBridge();
    const proxyFetch = createElectronChatFetch(bridge);

    await proxyFetch(new URL(URL_OK), { method: 'POST', body: '{}' });
    expect(calls[0].url).toBe(URL_OK);

    await proxyFetch(new Request(URL_OK, { method: 'POST', body: '{}' }));
    expect(calls[1].url).toBe(URL_OK);
  });

  it('没有 Authorization 头时 apiKey 是空串（主进程会拒绝，不会静默乱发）', async () => {
    const { bridge, calls } = makeBridge();
    const proxyFetch = createElectronChatFetch(bridge);

    await proxyFetch(URL_OK, { method: 'POST', body: '{}' });

    expect(calls[0].apiKey).toBe('');
  });
});
