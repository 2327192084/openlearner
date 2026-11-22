import { beforeEach, describe, expect, it } from 'vitest';
import {
  backendProbeKey,
  describeProbe,
  probeBackendSearch,
  resolveChatUrl,
  searchWithBackend,
  type SearchBackend,
} from './model-search-io.ts';
import { clearProbes } from './model-search.ts';
import type { SearchHttp } from './model-search.ts';

/**
 * 模型自带搜索的 IO 层（2026-11-22 下午）。
 *
 * ## 这组测试守的最重要一条
 *
 * **URL 解析必须与 `chat-client` 完全一致。**
 *
 * 如果这里自己写一份规则，迟早漂移，而漂移的表现是
 * 「普通对话能用、联网搜不能用」—— 用户完全无从判断。
 *
 * 所以测的是「同一个输入进来，两边算出的地址一样」。
 *
 * 另一半守「不按服务商名字硬编码」：任意 provider（含中转站、
 * 空字符串、乱写的名字）都要能算出合理地址并走同一条探测路径。
 */

const okBody = JSON.stringify({ choices: [{ message: { content: '第1章 函数' } }] });

function fakeHttp(handler: (body: Record<string, unknown>) => { status: number; text: string }): SearchHttp {
  return async (input) => {
    const body = JSON.parse(input.body) as Record<string, unknown>;
    const r = handler(body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.text };
  };
}

function backend(over: Partial<SearchBackend> = {}): SearchBackend {
  return {
    provider: 'deepseek',
    baseUrl: '',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    ...over,
  };
}

beforeEach(() => {
  clearProbes();
});

describe('resolveChatUrl：与 chat-client 同一套规则', () => {
  it('用户填了地址 → 用它（优先于预设）', () => {
    expect(resolveChatUrl({ provider: 'deepseek', baseUrl: 'https://my.gateway/v1' })).toBe(
      'https://my.gateway/v1/chat/completions',
    );
  });

  it('用户没填 → 用该服务商的预设地址', () => {
    expect(resolveChatUrl({ provider: 'moonshot' })).toBe(
      'https://api.moonshot.cn/v1/chat/completions',
    );
  });

  it('⚠️ 完全认不出的 provider 且没填地址 → DeepSeek 兜底（不是报错）', () => {
    expect(resolveChatUrl({ provider: 'some-unknown-thing' })).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('⚠️ provider 是空字符串也不崩（旧数据可能没有 provider）', () => {
    expect(resolveChatUrl({ provider: '' })).toBe('https://api.deepseek.com/chat/completions');
  });

  it('地址末尾带了 /chat/completions 会被去掉再拼（不出现两个）', () => {
    const url = resolveChatUrl({
      provider: 'custom',
      baseUrl: 'https://x.com/v1/chat/completions',
    });
    expect(url).toBe('https://x.com/v1/chat/completions');
    expect(url.match(/chat\/completions/g)?.length).toBe(1);
  });

  it('地址末尾的斜杠不会导致双斜杠', () => {
    const url = resolveChatUrl({ provider: 'custom', baseUrl: 'https://x.com/v1/' });
    expect(url).toBe('https://x.com/v1/chat/completions');
    expect(url).not.toContain('//chat');
  });

  it('中转站那种只填域名也能work（自动补默认路径）', () => {
    const url = resolveChatUrl({ provider: 'custom', baseUrl: 'https://relay.example.com' });
    expect(url).toContain('relay.example.com');
    expect(url.endsWith('/chat/completions')).toBe(true);
  });
});

describe('probeBackendSearch：任意服务商走同一条路', () => {
  it('任意 provider 名都能探（证明没有按名字分流）', async () => {
    for (const p of ['deepseek', 'zhipu', 'whatever-user-typed', '', 'custom']) {
      clearProbes();
      const http = fakeHttp(() => ({ status: 200, text: okBody }));
      const r = await probeBackendSearch(backend({ provider: p }), { http });
      expect(r.kind).toBe('supported');
    }
  });

  it('探测结果会被缓存（第二次不再发请求）', async () => {
    let calls = 0;
    const http = fakeHttp(() => {
      calls += 1;
      return { status: 200, text: okBody };
    });
    const b = backend();
    await probeBackendSearch(b, { http });
    await probeBackendSearch(b, { http });
    expect(calls).toBe(1);
  });

  it('backendProbeKey 能区分不同后端', () => {
    const a = backendProbeKey(backend({ model: 'm1' }));
    const b = backendProbeKey(backend({ model: 'm2' }));
    const c = backendProbeKey(backend({ provider: 'zhipu' }));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('searchWithBackend：返回 SearchResult 形状', () => {
  it('成功 → searched true，一条 hit', async () => {
    const http = fakeHttp(() => ({ status: 200, text: okBody }));
    const r = await searchWithBackend(backend(), '高等数学有哪些章', { http });
    expect(r.searched).toBe(true);
    expect(r.hits).toHaveLength(1);
  });

  it('⚠️ 不支持 → searched false（调用方据此显示"这次没联网"）', async () => {
    const http = fakeHttp(() => ({ status: 400, text: 'unknown' }));
    const r = await searchWithBackend(backend(), 'q', { http });
    expect(r.searched).toBe(false);
    expect(r.note.length).toBeGreaterThan(0);
  });

  it('用的是 resolveChatUrl 算的地址（不是硬编码）', async () => {
    let seenUrl = '';
    const http: SearchHttp = async (input) => {
      seenUrl = input.url;
      return { ok: true, status: 200, text: okBody };
    };
    await searchWithBackend(
      backend({ provider: 'custom', baseUrl: 'https://my.proxy/v1' }),
      'q',
      { http },
    );
    expect(seenUrl).toBe('https://my.proxy/v1/chat/completions');
  });
});

describe('describeProbe：给用户的话', () => {
  it('三种状态各有说法', () => {
    expect(describeProbe({ kind: 'supported', capabilityId: 'x' })).toContain('可用');
    expect(describeProbe({ kind: 'unsupported', reason: '不支持' })).toContain('用不了');
    expect(describeProbe({ kind: 'unknown' })).toContain('还没探测');
  });
});