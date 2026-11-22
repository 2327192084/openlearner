/**
 * 「模型自带的联网搜索」—— 不依赖搜索 API Key 的那条路（2026-11-22 下午）。
 *
 * ## 为什么需要它
 *
 * 用户原话：
 * > 要是没有联网搜索 api 可以调用模型本身的搜索功能。
 *
 * 现在的情况：规划路线想「联网查这门课的常规章节结构」时，
 * 只能走 Tavily（`web-search.ts`），而它需要单独的搜索 API Key。
 * 用户实测**没配这个 Key**（`settings.webSearchKey` 为空），
 * 于是那条路整条不可用 —— 界面只能写「这次没有联网」。
 *
 * 但用户的后端模型**自己就能联网**（多数国内厂商都有「联网搜索」开关）。
 * 所以应该能借它的手搜，而不是非要用户再买一个搜索服务。
 *
 * ## ⚠️ 核心难题：各家的参数名不统一
 *
 * `provider` 是个**自由字符串**，用户能填任意 OpenAI 兼容端点
 * （预设的 7 家 + 自定义中转站 + 私有部署 + 学校网关）。
 * 所以**绝不能**写成 `if (provider === 'zhipu') {...}` ——
 * 加一家就要改代码，而「自定义」那栏永远覆盖不到。
 *
 * 已知的事实是：这类「联网开关」远没有一个统一标准。
 * 主流的几种写法互不兼容，写错了服务端会直接 400/422
 * （而不是忽略掉），所以**不能一股脑全塞进去**。
 *
 * ## 采用的策略：能力探测 + 逐级降级
 *
 * 1. 先问一次「你能联网吗」—— 用一个极小的探测请求，逐个试候选写法，
 *    哪个不报错就记住哪个（内存缓存，同一后端只探一次）
 * 2. 探测结果决定真正的请求怎么拼
 * 3. 全部写法都失败 → **如实降级为「不联网」**，绝不假装搜过
 *
 * 「如实降级」这一条最重要：用户看到「已联网查过」就会当作依据，
 * 而实际上模型只是凭记忆编 —— 那是这个项目反复记的同一类错误
 * （「断言全绿不算交付」「假成功后端」都是同一个毛病）。
 *
 * ## 纯逻辑在哪
 *
 * 候选写法的清单、探测结果的判定、缓存键，都在这里，不碰网络。
 * 实际的 HTTP 调用由调用方注入（测试里换假 fetch，不真发请求）。
 */

/** 一种「请求联网」的参数写法 */
export interface SearchCapability {
  /** 稳定 id，用于缓存与日志（不是给人看的） */
  id: string;
  /** 给人看的名字，出现在错误提示里 */
  label: string;
  /**
   * 把「联网开关」拼进请求体。
   *
   * 拿整个 body 而不是返回补丁对象：有些写法要加**多个**字段
   * （比如 tools + tool_choice），补丁对象表达不了。
   */
  apply: (body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * 候选写法清单。
 *
 * ## 排序理由（先试最可能的，省一次往返）
 *
 * 1. `tools: [{type:'web_search'}]` —— OpenAI 系与多数兼容实现用这个形状。
 *    它对不认的服务是**最容易报错**的（required 字段不对就 400），
 *    所以放第一个试：错了立刻知道。
 * 2. `web_search: {enable: true}` —— 一些国产兼容层用这种扁平开关，
 *    不认时通常被忽略或报 400，试起来便宜。
 * 3. `tools: [{type:'web_search_preview'}]` —— OpenAI 的另一种命名，
 *    少数代理只认这个。
 * 4. `enable_search: true` —— 通义/百炼系风格。
 *
 * ⚠️ 这四条**都是「试出来的」而不是「查文档确认的」**。
 * 各家改参数很频繁，所以这里的设计前提就是「不预设谁支持什么」——
 * 探测成功才算支持。清单顺序可以调，但不该有人硬编码服务商判断。
 */
export const SEARCH_CAPABILITIES: SearchCapability[] = [
  {
    id: 'tools-web-search',
    label: 'tools[type=web_search]',
    apply: (body) => ({
      ...body,
      tools: [{ type: 'web_search' }],
    }),
  },
  {
    id: 'web-search-enable',
    label: 'web_search.enable',
    apply: (body) => ({
      ...body,
      web_search: { enable: true },
    }),
  },
  {
    id: 'tools-web-search-preview',
    label: 'tools[type=web_search_preview]',
    apply: (body) => ({
      ...body,
      tools: [{ type: 'web_search_preview' }],
    }),
  },
  {
    id: 'enable-search',
    label: 'enable_search',
    apply: (body) => ({
      ...body,
      enable_search: true,
    }),
  },
];

/** 按 id 取候选；找不到返回 null */
export function findCapability(id: string): SearchCapability | null {
  return SEARCH_CAPABILITIES.find((c) => c.id === id) ?? null;
}

/**
 * 探测结果。
 *
 * 三态而不是布尔：「没探过」与「探过但都不支持」处置不同 ——
 * 前者该去探，后者该直接降级（不必每次重试）。
 */
export type SearchProbe =
  | { kind: 'unknown' }
  | { kind: 'supported'; capabilityId: string }
  | { kind: 'unsupported'; reason: string };

/**
 * 探测缓存：**按后端**分开记。
 *
 * 键要带上 baseUrl + model：同一个服务商的不同模型支持情况可能不同
 * （便宜的小模型常常不开放联网）。只按 provider 记会把
 * 「A 模型能联网」错用到「B 模型」上。
 */
export function probeCacheKey(input: {
  provider: string;
  baseUrl: string;
  model: string;
}): string {
  return [input.provider, input.baseUrl, input.model].join('|');
}

/**
 * 从一次探测失败里判断「是不是该换下一种写法」。
 *
 * ## 为什么要区分
 *
 * - **参数不认**（400/422/401 之外的 4xx）→ 换下一种写法继续试
 * - **Key 错 / 没权限**（401/403）→ 停止，换写法也没用
 * - **额度用完 / 限流**（429）→ 停止（继续试只会更糟）
 * - **网络不通** → 停止（不是写法问题）
 * - **成功（2xx）** → 就是它了
 */
export type ProbeVerdict =
  | { action: 'accept' }
  | { action: 'try-next'; reason: string }
  | { action: 'stop'; reason: string };

export function judgeProbe(response: {
  ok: boolean;
  status: number;
  /** 服务端返回的错误正文（已截断），用于判断"是不是参数不认识" */
  body?: string;
}): ProbeVerdict {
  if (response.ok) return { action: 'accept' };

  const { status } = response;

  /* Key / 权限：换写法没用 */
  if (status === 401 || status === 403) {
    return { action: 'stop', reason: ' 这个后端不接受这个 Key（或没有联网权限），换写法也没用' };
  }

  /* 额度 / 限流：继续试只会更糟，而且可能白花钱 */
  if (status === 429) {
    return { action: 'stop', reason: ' 这个后端限流或额度用完了，先别试联网' };
  }

  /* 网络层之外的服务端错误：可能是它的锅，停 */
  if (status >= 500) {
    return { action: 'stop', reason: ` 后端返回 ${status}，不像是参数问题` };
  }

  /*
   * 400 / 422 / 404 这一类：最可能是「不认识这个参数」。
   * 但有个陷阱 —— **模型名写错也是 400/404**。
   * 所以要看正文里有没有提到模型。
   */
  const body = (response.body ?? '').toLowerCase();
  if (/model.*(not|no).*(exist|found|support)|invalid.*model|model_not_found/.test(body)) {
    return { action: 'stop', reason: ' 模型名可能写错了（不是联网参数的问题）' };
  }

  return {
    action: 'try-next',
    reason: ` 这个后端不认识这种写法（HTTP ${status}）`,
  };
}

/**
 * 探测结果的缓存（内存）。
 *
 * ## 为什么要缓存
 *
 * 探测要真发请求（花钱）。一次规划探 4 次、每次规划都探，
 * 用户会觉得这软件在偷跑额度。
 *
 * ## 为什么存在模块级 Map 而不是传对象
 *
 * 探测结果与「哪个后端能联网」这个事实绑定，与页面无关。
 * 页面刷新不该忘掉它（否则每次进设置页都重新探一遍）。
 * 进程退出就没了 —— 这是可接受的：重启后探一次的成本很低。
 */
const probeStore = new Map<string, SearchProbe>();

export function readProbe(key: string): SearchProbe {
  return probeStore.get(key) ?? { kind: 'unknown' };
}

export function writeProbe(key: string, value: SearchProbe): void {
  probeStore.set(key, value);
}

/** 清缓存（设置页改了后端配置时用；测试里也用它隔离） */
export function clearProbes(): void {
  probeStore.clear();
}

/* ==========================================================================
 * 带搜索的对话请求
 * ========================================================================== */

/** 调用方注入的 HTTP 能力（测试里换成假实现） */
export interface SearchHttp {
  (input: {
    url: string;
    apiKey: string;
    /** 请求体（已拼好） */
    body: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; text: string }>;
}

export interface SearchProbeOptions {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 拼 URL 的规则与 chat-client 保持一致（baseUrl 去尾 + /chat/completions） */
  chatUrl: string;
  http: SearchHttp;
  signal?: AbortSignal;
  /** 探测用的提示词，故意极短（只为判断参数认不认，不为拿内容） */
  probePrompt?: string;
}

/**
 * 探测这个后端支不支持「自带的联网搜索」。
 *
 * ## 为什么要发**四**次小请求
 *
 * 因为参数名没有统一标准。发一次就断定「不支持」会漏掉别的写法，
 * 而那正是用户会遇到的（他用的是别家）。
 *
 * ## 为什么提示词极短
 *
 * 探测只为判断「参数认不认」，不需要内容。发一句「ping」能让
 * 服务端在参数校验阶段就拒绝 —— 那正是我们要的信号，且最省 token。
 */
export async function probeSearchCapability(
  options: SearchProbeOptions,
): Promise<SearchProbe> {
  const { provider, baseUrl, model, apiKey, chatUrl, http, signal } = options;
  const key = probeCacheKey({ provider, baseUrl, model });

  /* 探过了就复用 */
  const cached = readProbe(key);
  if (cached.kind !== 'unknown') return cached;

  const prompt = options.probePrompt ?? 'ping';

  let lastReason = '';

  for (const cap of SEARCH_CAPABILITIES) {
    if (signal?.aborted) {
      /* 用户取消了：不要把"取消"记成"不支持"，否则下次白降级 */
      return { kind: 'unknown' };
    }

    const body = cap.apply({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 8,
      stream: false,
    });

    let res: { ok: boolean; status: number; text: string } | null = null;
    try {
      res = await http({
        url: chatUrl,
        apiKey,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      /*
       * 网络层失败与写法无关 —— 直接停，记成 unsupported 但要写清原因，
       * 别让用户以为是"这家不支持联网"。
       */
      const reason = e instanceof Error ? e.message : String(e);
      const verdict: SearchProbe = {
        kind: 'unsupported',
        reason: `探测联网时网络失败（${reason}）—— 可能是网络/代理问题，不是不支持联网`,
      };
      writeProbe(key, verdict);
      return verdict;
    }

    const verdict = judgeProbe(res);

    if (verdict.action === 'accept') {
      const ok: SearchProbe = { kind: 'supported', capabilityId: cap.id };
      writeProbe(key, ok);
      return ok;
    }

    if (verdict.action === 'stop') {
      const bad: SearchProbe = { kind: 'unsupported', reason: verdict.reason.trim() };
      writeProbe(key, bad);
      return bad;
    }

    /* try-next：记下原因，继续试下一种 */
    lastReason = verdict.reason.trim();
  }

  const none: SearchProbe = {
    kind: 'unsupported',
    reason:
      (lastReason || '这个后端不认识任何一种联网写法') +
      ' —— 这次不联网，路线按模型自己的学科知识排。',
  };
  writeProbe(key, none);
  return none;
}

/* ==========================================================================
 * 把搜索结果接成 web-search.ts 的形状
 * ========================================================================== */

import type { SearchResult } from './web-search.ts';

/**
 * 用「模型自带的搜索」完成一次检索，产出与 Tavily 那条路**同样的形状**。
 *
 * ## 为什么对齐 SearchResult
 *
 * 调用方（路线规划）不该关心「这次是 Tavily 搜的还是模型搜的」。
 * 两条路产出同一个 `SearchResult`，规划逻辑一行都不用改。
 *
 * ## ⚠️ 模型搜来的东西**没有结构化片段**
 *
 * Tavily 给的是若干条 `{title, snippet}`；模型给的是**一段话**。
 * 所以这里把它整段当成「一条摘要」，并把 `acknowledge` 标出来，
 * 让提示词能说清「这是模型联网后自己总结的，不是原始网页摘录」——
 * 两者可信度不同，不能让模型混为一谈。
 */
export interface ModelSearchOptions extends SearchProbeOptions {
  /** 要让模型去搜的问题 */
  query: string;
}

export interface ModelSearchOutcome {
  result: SearchResult;
  /** 这次到底用的哪种写法（诊断用；unsupported 时为 null） */
  capabilityId: string | null;
}

/**
 * 跑一次「模型自带搜索」的检索。
 *
 * 返回 `searched: false` 的三种情况都要能被调用方如实区分：
 * - 后端不支持任何联网写法
 * - 探测时网络失败
 * - 请求成功但模型没给出有用内容
 */
export async function searchViaModel(
  options: ModelSearchOptions,
): Promise<ModelSearchOutcome> {
  const probe = await probeSearchCapability(options);

  if (probe.kind !== 'supported') {
    return {
      result: {
        searched: false,
        hits: [],
        note:
          probe.kind === 'unsupported'
            ? `没走搜索 API，而且这个后端的自带联网也探不通：${probe.reason}`
            : '没走搜索 API，后端自带联网还没探测过。',
      },
      capabilityId: null,
    };
  }

  const cap = findCapability(probe.capabilityId);
  if (!cap) {
    return {
      result: {
        searched: false,
        hits: [],
        note: '探测记录的联网写法已经不存在了（清单改过），这次不联网。',
      },
      capabilityId: null,
    };
  }

  /*
   * 提示词要明确两件事：
   *  1. 让它真的去搜（有些实现要显式要求才搜）
   *  2. 只回结构与事实，不要长篇大论 —— 这段会被塞进规划提示词
   */
  const systemPrompt =
    '你是检索助手。请联网检索用户的问题，然后用简短要点回答。' +
    '只给事实与结构（例如这门课通常分哪些章、各章讲什么），不要客套话。' +
    '如果检索不到，就直说「没有检索到」。';

  const body = cap.apply({
    model: options.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: options.query },
    ],
    temperature: 0.2,
    stream: false,
  });

  let res: { ok: boolean; status: number; text: string } | null = null;
  try {
    res = await options.http({
      url: options.chatUrl,
      apiKey: options.apiKey,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    return {
      result: {
        searched: false,
        hits: [],
        note: `联网检索请求没发出去：${e instanceof Error ? e.message : String(e)}`,
      },
      capabilityId: null,
    };
  }

  if (!res.ok) {
    return {
      result: {
        searched: false,
        hits: [],
        note: `自带联网检索失败（HTTP ${res.status}）。`,
      },
      capabilityId: null,
    };
  }

  const text = extractAssistantText(res.text);
  if (text.trim().length === 0) {
    return {
      result: { searched: true, hits: [], note: '联网搜过了，但模型没给出内容。' },
      capabilityId: cap.id,
    };
  }

  if (/^(没有检索到|未检索到|无法检索)/.test(text.trim())) {
    return {
      result: { searched: true, hits: [], note: '联网搜过了，但没找到有用结果。' },
      capabilityId: cap.id,
    };
  }

  return {
    result: {
      searched: true,
      hits: [
        {
          title: '模型联网检索的结果（它自己总结的，不是原始网页摘录）',
          snippet: text.slice(0, 1200),
        },
      ],
      note: '',
    },
    capabilityId: cap.id,
  };
}

/**
 * 从 OpenAI 兼容的响应里取正文。
 *
 * 独立成函数是有原因的：**推理模型**（deepseek-reasoner 等）会把
 * 思考放在 `reasoning_content`，正文才是 `content`。取错字段会拿到
 * 一大段思考过程塞进规划提示词。
 */
export function extractAssistantText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    /* 少数实现把 content 做成 [{type:'text',text:'...'}] 数组 */
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('');
    }
    return '';
  } catch {
    return '';
  }
}