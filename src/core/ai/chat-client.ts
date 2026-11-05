/**
 * OpenAI 兼容的对话补全客户端。
 *
 * ## 为什么是「OpenAI 兼容」而不是「DeepSeek 专用」
 *
 * 本项目需要支持多家服务商（DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 /
 * 火山方舟 / OpenAI / 各类中转站 / agent 平台的自定义端点）。
 * 这些服务商**都提供** `POST {baseUrl}/chat/completions`，请求体形状一致：
 * `{model, messages, temperature, response_format, stream:false}`。
 *
 * 所以这里有两条路：
 *   A. 为每家写一个适配器   → 加一家就要改代码、加测试、加文档
 *   B. 写一个兼容层 + 预设表 → 加一家只是往上加一行数据（见 presets.ts）
 *
 * 选 B。唯一的差异点（少数服务不认 `response_format`）用 `provider` 查表解决。
 *
 * ## 为什么不直接用 SDK
 *
 * 只需要一个接口。手写 fetch 的好处是：
 *   - 没有额外依赖（打包体积、供应链风险都小）
 *   - 能精确控制超时、重试、错误分类
 *   - 能注入 fetch，测试里不真发请求
 *
 * ## 安全要点（写在这里因为容易被忽略）
 *
 * 1. **Key 绝不出现在任何日志/错误信息里**。所有抛出的错误都经过
 *    `redactSecrets()` 清洗，防止把 Authorization 头带进 console 或界面。
 * 2. **材料是数据，不是指令**。prompt 里明确声明这一点，
 *    防住「教材里写了一句话让模型忽略之前的指令」这类注入。
 */

import { findPreset, normalizeBaseUrl, resolveCompat } from './presets.ts';

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
  /** 网络不通 / 超时 / 跨域被拦 */
  | 'network'
  /** 请求本身有问题（我们自己的 bug，或该服务不认某个字段） */
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

/**
 * 各错误类型的建议文案。
 *
 * 刻意**不写死服务商名**（早先的版本写的是「请到 DeepSeek 控制台确认」，
 * 用户配的是智谱时会按错误的指引去找一个不存在的页面）。
 * 具体服务商名由 `hintFor()` 动态拼进去。
 */
export const API_HINTS: Record<ApiErrorCode, string> = {
  'invalid-key': '请到设置页检查 API Key 是否粘贴完整（常见问题是首尾多了空格，或复制时漏了一段）。',
  forbidden: '这把 Key 可能没有该模型的权限，或账号已欠费。请到服务商控制台确认账号状态。',
  'rate-limited': '请求太频繁。等十几秒再试；如果经常出现，说明需要降低单次整理的资料量。',
  'insufficient-balance': '账号余额不足。请到服务商控制台充值后再试；已生成的内容不会丢。',
  'server-error': '这是服务商那边的临时故障，不是你或软件的问题。稍后重试通常就能成。',
  network:
    '连不上服务。检查三件事：① 网络是否正常；② 接口地址是否填对（应该到 /v1 为止，不要带 /chat/completions）；③ 该服务是否允许浏览器直连（不允许的话用桌面版，或改用中转站）。',
  'bad-request': '请求被服务端拒绝。常见原因：模型名写错、该服务不支持 JSON 模式、或上下文超长。请检查设置页的模型名是否正确。',
  aborted: '已按你的要求停止。已经生成的部分已经保存。',
  unknown: '遇到未预期的问题。可以重试；若持续出现，请记下错误信息反馈。',
};

/**
 * 拼一条带上服务商名的建议。
 *
 * 为什么值得单独做一层：用户配了三四个后端之后，「出错的是哪一个」
 * 比「出了什么错」更容易搞混。把名字写进 hint 里，报错本身就能定位到配置项。
 */
export function hintFor(code: ApiErrorCode, provider?: string): string {
  const base = API_HINTS[code];
  const preset = provider ? findPreset(provider) : null;
  if (!preset) return base;

  switch (code) {
    case 'forbidden':
    case 'insufficient-balance':
      return `${base}（当前后端是「${preset.label}」）`;
    case 'invalid-key': {
      /**
       * 这里必须点名是哪一家。
       *
       * 用户配了三四个后端时，「Key 不对」本身不足以定位问题，
       * 而且不同服务商拿 Key 的入口完全不同 —— 提示里不带名字，
       * 用户会跑去另一家的控制台找。
       */
      const where = preset.keyHint ? `${base}（当前后端是「${preset.label}」）\n${preset.keyHint}` : `${base}（当前后端是「${preset.label}」）`;
      return where;
    }
    case 'rate-limited':
      return `${base}（当前后端是「${preset.label}」）`;
    default:
      return base;
  }
}

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
  /** 接口基址。会被 normalizeBaseUrl 归一（去掉误粘的 /chat/completions 尾巴）。 */
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * 服务商标识（BackendConfig.provider）。
   *
   * 用途有两处：决定发不发 `response_format`、决定报错文案里的服务商名。
   * 不传时按「标准 OpenAI 兼容」处理。
   */
  provider?: string;
  /** 期望返回 JSON（开启 response_format，若该服务支持） */
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
 * 从响应里取出正文。
 *
 * 兼容三种真实见过的形状：
 *   1. `choices[0].message.content` 是字符串 —— 标准 OpenAI 形状
 *   2. `choices[0].message.content` 是数组（多模态服务会返回
 *      `[{type:'text', text:'...'}]`）
 *   3. `choices[0].text` —— 少数服务用补全接口的形状冒充对话接口
 */
function extractContent(parsed: {
  choices?: {
    message?: { content?: unknown };
    text?: unknown;
  }[];
}): string | null {
  const choice = parsed.choices?.[0];
  if (!choice) return null;

  const raw = choice.message?.content;
  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join('');
  }

  if (typeof choice.text === 'string') return choice.text;
  return null;
}

/**
 * 发一次对话补全请求。
 *
 * 统一在这里处理：超时、取消、HTTP 错误分类、JSON 解析。
 * 上层（ModelBackend）不需要关心这些。
 */
export async function chatCompletion(options: ChatOptions): Promise<ChatResult> {
  const {
    apiKey,
    baseUrl,
    model,
    systemPrompt,
    userPrompt,
    provider,
    jsonMode = false,
    temperature = 0.2,
    maxTokens,
    signal,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT,
  } = options;

  /**
   * 地址的三级兜底，顺序不能颠倒：
   *   1. 用户明确填的地址（最高优先级，自定义端点全靠它）
   *   2. 该服务商的预设地址（换了服务商但没重填地址时，这里必须能救回来）
   *   3. DeepSeek 的默认地址（完全认不出的兜底）
   *
   * 早先这里写的是 `baseUrl = DEFAULT_BASE_URL`（解构默认值），
   * 结果是只要调用方没传 baseUrl，不管 provider 是智谱还是通义，
   * 全部发去 DeepSeek —— 报错还是「模型不存在」，用户根本想不到是地址的问题。
   */
  const presetBaseUrl = provider ? findPreset(provider)?.baseUrl : undefined;
  const resolvedBaseUrl = baseUrl || presetBaseUrl || DEFAULT_BASE_URL;

  if (!apiKey || !apiKey.trim()) {
    throw new ApiError('invalid-key', '还没有配置 API Key', hintFor('invalid-key', provider));
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
    throw new ApiError('aborted', '已取消', hintFor('aborted', provider));
  }

  // 自己的超时控制器：既要响应外部 signal，也要有自己的时限
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  const doFetch = fetchImpl ?? fetch;
  const root = normalizeBaseUrl(resolvedBaseUrl) || DEFAULT_BASE_URL;
  const url = `${root}/chat/completions`;

  // 该服务是否认 response_format
  const compat = resolveCompat(provider ?? '');
  const sendJsonMode = jsonMode && compat.jsonMode;

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
        ...(sendJsonMode ? { response_format: { type: 'json_object' } } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);

    // 区分「用户主动取消」与「超时」—— 这两种情况界面提示完全不同
    if (signal?.aborted) {
      throw new ApiError('aborted', '已取消', hintFor('aborted', provider));
    }
    if (controller.signal.aborted) {
      throw new ApiError(
        'network',
        `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`,
        '服务长时间没有响应。可以减少一次整理的页数，或稍后重试。',
      );
    }

    const raw = err instanceof Error ? err.message : String(err);

    /**
     * 浏览器/Electron 渲染进程里的跨源失败，fetch 只给一句 `Failed to fetch`，
     * 看不出是「网线断了」「服务商不放行跨域」还是「地址写错」。
     * 这种情况用户最容易怪软件，所以给一条明确的排查顺序。
     */
    const isOpaqueNetworkFailure = /failed to fetch|networkerror|load failed/i.test(raw);
    throw new ApiError(
      'network',
      isOpaqueNetworkFailure
        ? `连不上 ${root}（浏览器未给出具体原因）`
        : `网络请求失败：${redactSecrets(raw, apiKey)}`,
      isOpaqueNetworkFailure
        ? `三种可能，按顺序排查：① 接口地址是否正确（${root}）；② 该服务是否允许从本应用直连（部分服务商只对自家域名放行跨域，这时改用桌面版或中转站）；③ 网络/代理是否可达。`
        : hintFor('network', provider),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  // ---- HTTP 状态分类 ----
  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw classifyHttpError(response.status, bodyText, apiKey, provider);
  }

  // ---- 解析响应 ----
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      'server-error',
      '服务返回的内容不是合法 JSON（可能是接口地址指向了一个网页）',
      `请检查设置页的接口地址是否是该服务的 API 根地址。当前用的是 ${root}。`,
    );
  }

  const parsed = payload as {
    model?: string;
    choices?: { message?: { content?: unknown }; text?: unknown }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
  };

  /**
   * 有些兼容服务在 HTTP 200 里返回错误对象。
   * 不看这一层的话，用户会得到「服务返回里没有内容」这种无从下手的信息。
   */
  if (parsed.error?.message) {
    throw new ApiError(
      'server-error',
      `服务返回错误：${redactSecrets(parsed.error.message, apiKey)}`,
      hintFor('server-error', provider),
    );
  }

  const content = extractContent(parsed);
  if (typeof content !== 'string') {
    throw new ApiError(
      'server-error',
      '服务返回里没有内容（choices[0].message.content 为空）',
      hintFor('server-error', provider),
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
 * 关键：服务商会在 body 里给具体原因（余额不足 / 频率限制 / 模型不存在），
 * 只看状态码会漏掉这些信息。所以同时看 status 和 body 关键词。
 */
function classifyHttpError(
  status: number,
  body: string,
  apiKey: string,
  provider?: string,
): ApiError {
  const bodyLower = body.toLowerCase();
  const safeBody = redactSecrets(body, apiKey);

  // 余额不足：DeepSeek 用 402，也有用 400 带 "Insufficient Balance"
  if (/insufficient\s*balance|余额不足|quota exceeded|exceeded your current quota/.test(bodyLower)) {
    return new ApiError(
      'insufficient-balance',
      '账号余额不足',
      hintFor('insufficient-balance', provider),
      status,
    );
  }

  /**
   * 模型名不存在。
   *
   * 这条单列出来，因为它是多服务商场景下最高频的配置错误：
   * 用户换了服务商但忘了改模型名（deepseek-chat 发给智谱必然 404/400）。
   * 归到 bad-request 里给的提示太泛，用户会去怀疑网络。
   */
  if (/model.*(not\s*(exist|found)|不存在)|invalid\s*model|unknown\s*model/i.test(bodyLower)) {
    const preset = provider ? findPreset(provider) : null;
    return new ApiError(
      'bad-request',
      `模型名可能不对：${safeBody.slice(0, 300)}`,
      preset && preset.models.length > 0
        ? `「${preset.label}」可用的模型有：${preset.models.join(' / ')}。请到设置页核对模型名是否逐字符一致。`
        : '请到设置页核对模型名。注意：不同服务商的模型名不能混用（把 deepseek-chat 发给别家会报错）。',
      status,
    );
  }

  // 上下文超长
  if (/context.*(length|window)|too many tokens|maximum.*tokens|超出.*长度/i.test(bodyLower)) {
    return new ApiError(
      'bad-request',
      `内容超出该模型的上下文长度：${safeBody.slice(0, 200)}`,
      '一次整理的资料太多了。可以缩小页码范围，或改用长上下文模型（如 moonshot-v1-128k）。',
      status,
    );
  }

  if (status === 401) {
    return new ApiError('invalid-key', 'API Key 无效或已过期', hintFor('invalid-key', provider), status);
  }

  if (status === 403) {
    return new ApiError('forbidden', '没有权限使用该模型', hintFor('forbidden', provider), status);
  }

  if (status === 402) {
    return new ApiError(
      'insufficient-balance',
      '账号余额不足',
      hintFor('insufficient-balance', provider),
      status,
    );
  }

  if (status === 429) {
    return new ApiError('rate-limited', '请求太频繁，被限流', hintFor('rate-limited', provider), status);
  }

  if (status === 400 || status === 422) {
    return new ApiError(
      'bad-request',
      `请求被拒绝：${safeBody.slice(0, 300)}`,
      hintFor('bad-request', provider),
      status,
    );
  }

  /**
   * 404 在多服务商场景下几乎总是地址拼错：
   * 少了 /v1、多了 /v1、或者把完整端点粘进了基址。
   */
  if (status === 404) {
    return new ApiError(
      'bad-request',
      '接口地址可能不对（404）',
      '请检查设置页的接口地址。多数服务要填到 /v1 为止（例如 https://api.moonshot.cn/v1），且不要带 /chat/completions。',
      status,
    );
  }

  if (status >= 500) {
    return new ApiError(
      'server-error',
      `服务端错误（HTTP ${status}）`,
      hintFor('server-error', provider),
      status,
    );
  }

  return new ApiError(
    'unknown',
    `请求失败（HTTP ${status}）：${safeBody.slice(0, 200)}`,
    hintFor('unknown', provider),
    status,
  );
}
