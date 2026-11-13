/**
 * 从服务商拉取可用模型列表（2026-11-13 深夜，用户要求）。
 *
 * ## 用户原话
 *
 * > 「最后改一下模型后端界面，让用户填入 api 后能选择实际模型。
 * >  例如现在 deepseek 的 api 可以调用两个模型，一个 deepseek v4pro，
 * >  一个 deepseek v4.1flash」
 *
 * 也就是说：模型名不该是一个要用户自己背下来的死值，
 * 而是**填好地址和 Key 之后，从服务商那儿问出来**，再让用户挑。
 *
 * ## 为什么能做：各家都有 OpenAI 兼容的 GET /models
 *
 * DeepSeek、Kimi、智谱、通义、硅基流动等都提供 `GET <base>/models`，
 * 返回 `{ object: 'list', data: [{ id: 'deepseek-chat', ... }, ...] }`。
 * 见 https://api-docs.deepseek.com/zh-cn/api/list-models/
 * 与 https://platform.kimi.com/docs/api/list-models
 *
 * 这个请求不计费、不消耗 token（只是列清单），所以可以随时点。
 *
 * ## 为什么不直接用返回里的顺序
 *
 * 各家返回顺序不同（有的按创建时间、有的按字母），而且**能力字段互不相同**：
 * DeepSeek 给 `context_window` / `max_output_tokens` / `input_modalities`，
 * Kimi 给 `context_length` / `supports_image_in` / `supports_reasoning`，
 * OpenAI 只给 `created` / `owned_by`。
 * 所以这里只依赖两家都保证的那一个字段：`id`（必须），其余全部 optional，
 * 拿到了就显示，拿不到就不显示 —— 不编造。
 *
 * ## 失败要能说清原因
 *
 * 用户最常遇到的三种失败，必须分别给话：
 *  - Key 没填 / 填错 → 401
 *  - 地址不对（多打了 /chat/completions、少了 /v1）→ 404
 *  - 该服务商不支持这个接口 → 404 或 405
 * 笼统地说「拉取失败」等于没说，用户不知道下一步该改什么。
 */

import { normalizeBaseUrl } from './presets.ts';
import { hasChatBridge, createElectronChatFetch, readChatBridge } from './electron-fetch.ts';

/** 拉回来的一个模型 */
export interface DiscoveredModel {
  /** 模型 id（调接口时真正要填的那个），一定有 */
  id: string;
  /** 展示名；没有就用 id */
  label: string;
  /** 上下文窗口（token）；null = 服务商没给 */
  contextWindow: number | null;
  /** 是否支持看图；null = 不知道（不猜） */
  supportsImage: boolean | null;
}

export type DiscoverModelsResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; reason: string };

/** 从 `GET /models` 的响应体里解析出模型列表（纯函数，可单测） */
export function parseModelsResponse(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    /*
     * 没有 id 的条目直接跳过：id 是唯一能拿去调接口的东西，
     * 展示名再好看也没用。宁缺勿造。
     */
    if (!id) continue;

    const label =
      typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;

    /* 三家字段名各不同（见头注释），有哪个用哪个 */
    const ctx =
      numOrNull(o.context_window) ??
      numOrNull(o.context_length) ??
      numOrNull(o.max_context_length);

    const image =
      boolOrNull(o.supports_image_in) ??
      boolOrNull(o.supports_vision) ??
      modalitiesHaveImage(o.input_modalities);

    out.push({ id, label, contextWindow: ctx, supportsImage: image });
  }
  return out;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** DeepSeek 用 `input_modalities: ['text','image']` */
function modalitiesHaveImage(v: unknown): boolean | null {
  if (!Array.isArray(v)) return null;
  return v.some((x) => x === 'image');
}

/** 把上下文窗口说成人话：「128K」而不是「131072」 */
export function formatContext(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M 上下文`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k)}K 上下文`;
  }
  return `${n} 上下文`;
}

export interface FetchModelsOptions {
  apiKey: string;
  baseUrl: string;
  /** 注入用（单测不碰网络） */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * 真的去问一次。
 *
 * ⚠️ fetch 不能丢 this：Electron 里裸调 `fetch(...)` 在旧版会抛
 * 「Illegal invocation」。项目硬约束第 6 条，这里按同一写法处理。
 */
export async function fetchModels(options: FetchModelsOptions): Promise<DiscoverModelsResult> {
  const { apiKey, baseUrl, fetchImpl, timeoutMs = 12000 } = options;

  const key = apiKey.trim();
  if (!key) {
    return { ok: false, reason: '先在下面填入 API Key，才能问服务商有哪些模型。' };
  }

  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return { ok: false, reason: '接口地址是空的。' };
  }

  const url = `${base}/models`;

  /**
   * ⚠️ 必须走与聊天请求**同一条**通路（2026-11-13 深夜）。
   *
   * 桌面版的 AI 请求实际由主进程代发（`window.openleaner.chat`，
   * 见 electron-fetch.ts）。那条路上带了主进程自己的网络设置/代理，
   * 而渲染进程里裸调 fetch 会走另一套 —— 在用户那边表现为
   * 「聊天能用，但这个『拉取模型』一直失败」，而错误还是最笼统的
   * `Failed to fetch`，根本查不出原因。
   *
   * 桥的接口是 { url, apiKey, body } 一次请求-响应，不带 HTTP 方法，
   * 所以 GET 也能走它（chatCompletion 也只用 POST body）。
   */
  const bridge = readChatBridge();
  const call =
    fetchImpl ?? (hasChatBridge(bridge) ? createElectronChatFetch(bridge as never) : globalThis.fetch);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await call(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: 'API Key 没通过验证（401）。检查是不是复制漏了、或者这把 Key 属于另一个平台。',
      };
    }
    if (res.status === 404 || res.status === 405) {
      return {
        ok: false,
        reason: `这个地址没有提供模型列表接口（${res.status}）。检查接口地址：填到 /v1 为止，不要带 /chat/completions。`,
      };
    }
    if (!res.ok) {
      return { ok: false, reason: `服务返回 ${res.status}。稍后再试，或检查接口地址。` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        reason: '返回的不是 JSON —— 这个地址可能不是 API 端点（有的服务商会返回一个网页）。',
      };
    }

    const models = parseModelsResponse(body);
    if (models.length === 0) {
      /*
       * 200 但没有 data：可能是该服务商的列表接口格式不同。
       * 不说「成功但空」——那会让用户以为账号没有模型，
       * 而实际可能只是格式不一样。所以直接说清并让他手填。
       */
      return {
        ok: false,
        reason: '这个地址有响应，但没有返回可识别的模型列表。可以直接手填模型名（下面那个输入框仍然可用）。',
      };
    }

    return { ok: true, models };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, reason: '问服务商超时了（12 秒）。检查网络，或地址是否可达。' };
    }
    /*
     * 网络层错误在这一步最常见的原因就是「国内直连不通」——
     * 与 OpenAI 那条预设提示一致，这里也把话说到。
     */
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `连不上这个地址：${msg}。国内直连通常需要代理。` };
  } finally {
    clearTimeout(timer);
  }
}
