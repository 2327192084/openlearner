/**
 * 把「模型自带搜索」接到真实网络与真实后端上（2026-11-22 下午）。
 *
 * ## 为什么与 `model-search.ts` 分开
 *
 * `model-search.ts` 是**纯逻辑**（候选写法、判定、缓存），能单测。
 * 这个文件负责碰真实的东西：读后端凭据、选 fetch、拼 URL。
 * 混在一起会让「探测逻辑」变得不可测（要真发请求）。
 *
 * ## ⚠️ 不按服务商名字判断（用户明确要求）
 *
 * > 后端的服务商，每个用户可能配置的会不一样，你需要解决这个问题
 *
 * 所以这里**没有一处** `if (provider === 'xxx')`。做法：
 *  - URL 用与 `chat-client` 完全相同的规则算（`normalizeBaseUrl` + 预设兜底）
 *  - 能力靠 `probeSearchCapability` 现场探
 *  - 探不出来就如实降级为「未联网」
 *
 * 这样用户填智谱、通义、中转站、学校网关、私有部署，都走同一条代码路径。
 */

import { findPreset, normalizeBaseUrl } from './presets.ts';
import { readChatBridge, resolveChatFetch } from './electron-fetch.ts';
import type { SearchResult } from './web-search.ts';
import {
  searchViaModel,
  type SearchHttp,
  type SearchProbe,
  probeSearchCapability,
  probeCacheKey,
} from './model-search.ts';

/** 默认基址（与 chat-client 保持一致，改一处要同步） */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 一个待搜索的后端（调用方从 BackendConfig 里取） */
export interface SearchBackend {
  provider: string;
  baseUrl?: string;
  model: string;
  apiKey: string;
}

/**
 * 算出 chat/completions 的完整地址。
 *
 * ## 三级兜底与 `chat-client` 一致（顺序不能颠倒）
 *
 * 1. 用户明确填的地址（自定义端点全靠它）
 * 2. 该服务商的预设地址（换了服务商没重填地址时要能救回来）
 * 3. DeepSeek 默认（完全认不出的兜底）
 *
 * 与 `chat-client` 用**同一套函数**（`normalizeBaseUrl` / `findPreset`），
 * 不另写一份 —— 两份规则迟早会漂移，而漂移的表现是
 * 「普通对话能用、联网搜不能用」，极难排查。
 */
export function resolveChatUrl(backend: Pick<SearchBackend, 'provider' | 'baseUrl'>): string {
  const presetBaseUrl = backend.provider ? findPreset(backend.provider)?.baseUrl : undefined;
  const resolved = backend.baseUrl || presetBaseUrl || DEFAULT_BASE_URL;
  const root = normalizeBaseUrl(resolved) || DEFAULT_BASE_URL;
  return `${root}/chat/completions`;
}

/**
 * 用真实 fetch 实现的 `SearchHttp`。
 *
 * 走 `resolveChatFetch`：桌面端会用它去主进程代理（绕开 file:// 的
 * CORS 限制）。**不能直接用原生 fetch** —— 那样桌面版会对多数服务商
 * 直接 Failed to fetch，表现成「这个后端不支持联网」，误导用户。
 */
function realHttp(): SearchHttp {
  const doFetch = resolveChatFetch(readChatBridge());
  return async (input) => {
    const res = await doFetch(input.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: input.body,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  };
}

/**
 * 用这个后端的**自带联网**去搜一句话。
 *
 * 返回与 Tavily 那条路同样的 `SearchResult`，调用方不必区分来源。
 */
export async function searchWithBackend(
  backend: SearchBackend,
  query: string,
  options: { signal?: AbortSignal; http?: SearchHttp } = {},
): Promise<SearchResult> {
  const out = await searchViaModel({
    provider: backend.provider,
    baseUrl: backend.baseUrl ?? '',
    model: backend.model,
    apiKey: backend.apiKey,
    chatUrl: resolveChatUrl(backend),
    query,
    http: options.http ?? realHttp(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return out.result;
}

/**
 * 只探测，不搜索（设置页的「测试能不能联网」按钮用）。
 *
 * 单独暴露是因为：用户可能想先知道这个后端行不行，
 * 而不是等规划跑到一半才发现没联网。
 */
export async function probeBackendSearch(
  backend: SearchBackend,
  options: { signal?: AbortSignal; http?: SearchHttp } = {},
): Promise<SearchProbe> {
  return probeSearchCapability({
    provider: backend.provider,
    baseUrl: backend.baseUrl ?? '',
    model: backend.model,
    apiKey: backend.apiKey,
    chatUrl: resolveChatUrl(backend),
    http: options.http ?? realHttp(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** 给界面看的一句话：这个后端的联网能力现在是什么状态 */
export function describeProbe(probe: SearchProbe): string {
  switch (probe.kind) {
    case 'supported':
      return '这个后端的自带联网可用，规划时可以不配搜索 API。';
    case 'unsupported':
      return `这个后端的自带联网用不了：${probe.reason}`;
    case 'unknown':
      return '还没探测过这个后端的自带联网能力。';
  }
}

/** 缓存键（验证脚本与设置页要用它判断"要不要重新探"） */
export function backendProbeKey(backend: SearchBackend): string {
  return probeCacheKey({
    provider: backend.provider,
    baseUrl: backend.baseUrl ?? '',
    model: backend.model,
  });
}