/**
 * 桌面端专用：把模型请求交给 Electron 主进程转发。
 *
 * ## 为什么需要这一层
 *
 * 打包后的桌面应用从 `file://` 加载页面。这种 origin 下浏览器对 fetch
 * 执行标准跨源检查（请求带 `Origin: null`，先发 OPTIONS 预检），
 * 只有放行了任意 origin 的服务商能用 —— 实测 DeepSeek 放行，
 * 而智谱、通义、硅基流动、火山方舟、多数自建中转站都不放行。
 *
 * 也就是说：**同一份代码在浏览器里能用，装成桌面版会全线 Failed to fetch**。
 * 这会让「多服务商接入」在桌面端形同虚设。
 *
 * Electron 主进程发出的请求没有同源策略，所以交给它转发即可。
 * 主进程侧有严格的白名单校验（见 `electron/main.cjs` 的 registerChatProxy）：
 * 只允许 POST /chat/completions，只允许 https（本机地址可用 http），
 * 拒绝内网地址，有超时与响应体上限。
 *
 * ## 为什么不干脆所有环境都走代理
 *
 * 浏览器里没有主进程。所以这里返回的是「能拿到桥就走桥、拿不到就用原生 fetch」
 * 的适配器 —— 调用方（chat-client）不需要知道自己跑在哪里。
 *
 * ## 为什么做成 fetch 形状而不是另写一个客户端
 *
 * `chatCompletion()` 已经通过 `fetchImpl` 支持注入，把这一层做成
 * `typeof fetch` 就能零改动接进去。同时错误分类、Key 脱敏、超时逻辑
 * 仍然只有 chat-client 那一份，不会出现「网页端和桌面端提示不一样」。
 */

/** preload 暴露的桥（`window.openleaner`）里我们用到的那一小部分 */
interface ChatBridge {
  chat?: (request: {
    url: string;
    apiKey: string;
    body: string;
    timeoutMs?: number;
  }) => Promise<
    | { ok: true; status: number; text: string }
    | { ok: false; kind: string; message: string }
  >;
}

/**
 * 主进程代理的「失败」不是网络失败，而是一个结构化的拒绝。
 *
 * 这里故意抛一个普通 Error（不是 ApiError）：chat-client 的 catch 分支
 * 会把它当网络错误处理，但消息里已经是我们写好的中文原因，
 * 会原样出现在提示里，不会变成无意义的 `Failed to fetch`。
 */
function proxyFailure(kind: string, message: string): Error {
  // kind 只用于排查，不直接展示；展示用 message
  return new Error(`${message}（${kind}）`);
}

/** 当前环境是否真的能走主进程代理 */
export function hasChatBridge(bridge: ChatBridge | undefined | null): boolean {
  return typeof bridge?.chat === 'function';
}

/**
 * 从 `fetch(url, init)` 的参数里还原出主进程需要的东西。
 *
 * `signal` 的剩余时间无法直接读出，所以超时交给主进程自己的 120s 兜底，
 * 这里只在「调用方已经取消」时提前放弃。
 */
export function createElectronChatFetch(bridge: ChatBridge): typeof fetch {
  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (init?.signal?.aborted) {
      throw new DOMException('请求已取消', 'AbortError');
    }

    const headers = new Headers(init?.headers ?? {});
    const authorization = headers.get('Authorization') ?? '';
    const apiKey = authorization.replace(/^Bearer\s+/i, '');
    const body = typeof init?.body === 'string' ? init.body : '';

    const result = await bridge.chat!({ url, apiKey, body });

    if (!result.ok) {
      throw proxyFailure(result.kind, result.message);
    }

    /**
     * 造一个 Response 交回给调用方。
     *
     * `status` 原样交回（401/404/429 等由 chat-client 统一分类），
     * 这样桌面端和网页端的错误提示是同一套，不会两边不一样。
     */
    return new Response(result.text, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return proxyFetch as typeof fetch;
}

/**
 * 选一个可用的 fetch 实现。
 *
 * - 桌面端（有桥）：走主进程代理，绕开 CORS
 * - 浏览器/测试：用原生 fetch（服务商自己放行跨域才行）
 *
 * 注意：这个函数只在**真正发起调用**时才该被使用。单元测试注入自己的
 * fetchImpl 时不要经过它，否则会绕过测试桩。
 */
export function resolveChatFetch(bridge?: ChatBridge | null): typeof fetch {
  if (hasChatBridge(bridge)) {
    return createElectronChatFetch(bridge as ChatBridge);
  }
  return fetch;
}

/** 从全局取桥。放在函数里是为了让这个模块能在 Node 测试环境里被 import */
export function readChatBridge(): ChatBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = (window as unknown as { openleaner?: ChatBridge }).openleaner;
  return api?.chat ? api : undefined;
}
