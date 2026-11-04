/**
 * DeepSeek API 客户端。
 *
 * ## 为什么不直接用 SDK
 *
 * 只需要 `POST /chat/completions` 一个接口。手写 fetch 的好处是：
 *   - 没有额外依赖（打包体积、供应链风险都小）
 *   - 能精确控制超时、重试、错误分类
 *   - 浏览器里直接调用（DeepSeek 跨域已放行，P5 前置调研确认过）
 *
 * ## 安全要点（写在这里因为容易被忽略）
 *
 * 1. **Key 绝不出现在任何日志/错误信息里**。所有抛出的错误都经过
 *    `redactSecrets()` 清洗，防止把 Authorization 头带进 console 或界面。
 * 2. **材料是数据，不是指令**。prompt 里明确声明这一点，
 *    防住「教材里写了一句话让模型忽略之前的指令」这类注入。
 */

/** 调用失败的原因分类。界面上据此给不同的下一步建议。 */
export type ApiErrorCode =
  /** Key 无效或已撤销 */
  | 'invalid-key'
  /** Key 没权限用这个模型 / 账号欠费 */
  | 'forbidden'
  /** 请求太频繁 */
  | 'rate-limited'
  /** 余额不足 */
  | 'insufficient-balance'
  /** 服务端错误 */
  | 'server-error'
  /** 网络不通 / 超时 */
  | 'network'
  /** 请求本身有问题（我们自己的 bug） */
  | 'bad-request'
  /** 被用户取消 */
  | 'aborted'
  | 'unknown';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    /** 给用户看的下一步建议。不允许只显示 message。 */
    readonly hint: string,
    /** HTTP 状态码，便于排查 */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const API_HINTS: Record<ApiErrorCode, string> = {
  'invalid-key': '请到设置页检查 API Key 是否粘贴完整（常见问题是首尾多了空格，或复制时漏了一段）。',
  forbidden: '这把 Key 可能没有该模型的权限，或账号已欠费。请到 DeepSeek 控制台确认账号状态。',
  'rate-limited': '请求太频繁。等十几秒再试；如果经常出现，说明需要降低单次整理的资料量。',
  'insufficient-balance': '账号余额不足。请到 DeepSeek 控制台充值后再试；已生成的内容不会丢。',
  'server-error': '这是服务商那边的临时故障，不是你或软件的问题。稍后重试通常就能成。',
  network: '连不上服务。检查网络是否正常；如果用了代理，确认代理对 api.deepseek.com 生效。',
  'bad-request': '请求格式有问题，这是软件的缺陷。请记下当前操作反馈给我们。',
  aborted: '已按你的要求停止。已经生成的部分已经保存。',
  unknown: '遇到未预期的问题。可以重试；若持续出现，请记下错误信息反馈。',
};

/** 一次对话补全的结果 */
export interface ChatResult {
  /** 模型返回的文本内容 */
  content: string;
  /** 用量：prompt + completion = total */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  /** 实际使用的模型名（服务端可能返回带版本号的） */
  model: string;
}

export interface ChatOptions {
  apiKey: string;
  /** 接口基址，默认 DeepSeek 官方 */
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** 期望返回 JSON（开启 response_format） */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 注入 fetch，便于测试不真发请求 */
  fetchImpl?: typeof fetch;
  /** 超时毫秒，默认 120 秒（整理一份课件可能确实要这么久） */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT = 120_000;

/**
 * 清洗可能泄露凭据的字符串。
 *
 * 所有对外抛出的错误消息都要过这一道：某些 HTTP 库的报错会把
 * 请求头原样带出来，那里面就有 Authorization。
 *
 * 顺序有讲究：**先抹具体 key，再抹通用模式**。
 * 反过来的话，通用模式会把 key 变成 `sk-***`，
 * 之后「用具体 key 去 split」就再也匹配不到了 —— 看起来做了两件事，
 * 实际第二件已经无事可做。现在保留 `sk-***` 这个可识别的痕迹，
 * 是为了让看日志的人知道「这里原本有个 key，已被处理」。
 */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;

  // 1) 先精确抹掉调用方给的那把 key（保留可识别痕迹）
  if (apiKey && apiKey.trim().length > 4) {
    out = out.split(apiKey.trim()).join('sk-***');
  }

  // 2) 再抹掉任何形如 Bearer xxx 的片段
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer sk-***');

  // 3) 最后兜底：任何 sk- 开头的长串（覆盖没传 key 的场景）
  out = out.replace(/\bsk-[A-Za-z0-9._-]{8,}/g, 'sk-***');

  return out;
}

/**
 * 发一次对话补全请求。
 *
 * 统一在这里处理：超时、取消、HTTP 错误分类、JSON 解析。
 * 上层（DeepSeekBackend）不需要关心这些。
 */
export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model,
    systemPrompt,
    userPrompt,
    jsonMode = false,
    temperature = 0.2,
    maxTokens,
    signal,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT,
  } = options;

  if (!apiKey || !apiKey.trim()) {
    throw new ApiError(
      'invalid-key',
      '还没有配置 API Key',
      '请到设置页填写 DeepSeek 的 API Key 后再试。',
    );
  }

  /**
   * 如果调用前就已经被取消，立刻返回，不发请求。
   *
   * 这一条不能省：`addEventListener('abort')` 对**已经发生过**的 abort 事件
   * 不会再触发（事件是一次性的，过去就过去了）。所以走正常流程的话，
   * controller 永远不会被 abort，请求照发 —— 用户明明点了取消，
   * 却还是把钱花了，而且最后拿到的是「服务返回异常」这种莫名其妙的错误。
   */
  if (signal?.aborted) {
    throw new ApiError('aborted', '已取消', API_HINTS.aborted);
  }

  // 自己的超时控制器：既要响应外部 signal，也要有自己的时限
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  const doFetch = fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // DeepSeek 支持 OpenAI 风格的 response_format
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);

    // 区分「用户主动取消」与「超时」—— 这两种情况界面提示完全不同
    if (signal?.aborted) {
      throw new ApiError('aborted', '已取消', API_HINTS.aborted);
    }
    if (controller.signal.aborted) {
      throw new ApiError(
        'network',
        `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`,
        '资料太多或网络太慢。可以减少一次整理的页数，或稍后重试。',
      );
    }

    const raw = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'network',
      `网络请求失败：${redactSecrets(raw, apiKey)}`,
      API_HINTS.network,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  // ---- HTTP 状态分类 ----
  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw classifyHttpError(response.status, bodyText, apiKey);
  }

  // ---- 解析响应 ----
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('server-error', '服务返回的内容不是合法 JSON', API_HINTS['server-error']);
  }

  const parsed = payload as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ApiError(
      'server-error',
      '服务返回里没有内容（choices[0].message.content 为空）',
      API_HINTS['server-error'],
    );
  }

  const usage = parsed.usage
    ? {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      }
    : null;

  return {
    content,
    usage,
    model: parsed.model ?? model,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return '';
  }
}

/**
 * 把 HTTP 错误翻译成用户能行动的原因。
 *
 * 关键：DeepSeek 在 402/429 等情况下会在 body 里给具体原因（余额不足 / 频率限制），
 * 只看状态码会漏掉这些信息。所以同时看 status 和 body 关键词。
 */
function classifyHttpError(status: number, body: string, apiKey: string): ApiError {
  const bodyLower = body.toLowerCase();
  const safeBody = redactSecrets(body, apiKey);

  // 余额不足：DeepSeek 用 402，也有用 400 带 "Insufficient Balance"
  if (/insufficient\s*balance|余额不足|quota/.test(bodyLower)) {
    return new ApiError('insufficient-balance', '账号余额不足', API_HINTS['insufficient-balance'], status);
  }

  if (status === 401) {
    return new ApiError('invalid-key', 'API Key 无效或已过期', API_HINTS['invalid-key'], status);
  }

  if (status === 403) {
    return new ApiError('forbidden', '没有权限使用该模型', API_HINTS.forbidden, status);
  }

  if (status === 402) {
    return new ApiError('insufficient-balance', '账号余额不足', API_HINTS['insufficient-balance'], status);
  }

  if (status === 429) {
    return new ApiError('rate-limited', '请求太频繁，被限流', API_HINTS['rate-limited'], status);
  }

  if (status === 400) {
    return new ApiError(
      'bad-request',
      `请求被拒绝：${safeBody.slice(0, 300)}`,
      API_HINTS['bad-request'],
      status,
    );
  }

  if (status >= 500) {
    return new ApiError(
      'server-error',
      `服务端错误（HTTP ${status}）`,
      API_HINTS['server-error'],
      status,
    );
  }

  return new ApiError(
    'unknown',
    `请求失败（HTTP ${status}）：${safeBody.slice(0, 200)}`,
    API_HINTS.unknown,
    status,
  );
}
