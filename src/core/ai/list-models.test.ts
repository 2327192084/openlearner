/**
 * 「拉取可用模型」的单测（2026-11-13 深夜）。
 *
 * 用户要求：「让用户填入 api 后能选择实际模型」。
 *
 * 这里不碰网络（注入 fetchImpl），只钉三件事：
 *  - 各家返回格式不同，但都只保证 `id`，其余字段缺了不能崩、不能编
 *  - 三种常见失败（401 / 404 / 连不上）要给出**不同**的下一步建议
 *  - 空 Key 不发请求
 */

import { describe, expect, it } from 'vitest';
import {
  fetchModels,
  formatContext,
  parseModelsResponse,
  type DiscoveredModel,
} from './list-models.ts';

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('parseModelsResponse：只认 id，其余可选', () => {
  it('标准 OpenAI 形状', () => {
    const r = parseModelsResponse({
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
      ],
    });
    expect(r.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    /* 没给上下文就别编 */
    expect(r[0]?.contextWindow).toBeNull();
    expect(r[0]?.supportsImage).toBeNull();
  });

  it('DeepSeek 的长字段（context_window + input_modalities）', () => {
    const r = parseModelsResponse({
      data: [
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          context_window: 131072,
          max_output_tokens: 8192,
          input_modalities: ['text', 'image'],
        },
      ],
    });
    expect(r[0]?.label).toBe('DeepSeek V4 Pro');
    expect(r[0]?.contextWindow).toBe(131072);
    expect(r[0]?.supportsImage).toBe(true);
  });

  it('Kimi 的字段名（context_length + supports_image_in）', () => {
    const r = parseModelsResponse({
      data: [{ id: 'kimi-k3.1-pro', context_length: 262144, supports_image_in: false }],
    });
    expect(r[0]?.contextWindow).toBe(262144);
    expect(r[0]?.supportsImage).toBe(false);
  });

  it('没有 name 时用 id 当展示名（不显示空白项）', () => {
    const r = parseModelsResponse({ data: [{ id: 'glm-4-flash' }] });
    expect(r[0]?.label).toBe('glm-4-flash');
  });

  it('没有 id 的条目被丢掉（id 是唯一能拿去调接口的东西）', () => {
    const r = parseModelsResponse({
      data: [{ name: '只有名字' }, { id: 'good-one' }, null, 42, {}],
    });
    expect(r.map((m) => m.id)).toEqual(['good-one']);
  });

  it('返回体乱七八糟时不抛错，返回空数组', () => {
    for (const body of [null, undefined, 42, 'str', [], { data: 'nope' }, {}]) {
      expect(parseModelsResponse(body)).toEqual([]);
    }
  });

  it('id 前后的空格被去掉', () => {
    const r = parseModelsResponse({ data: [{ id: '  deepseek-chat  ' }] });
    expect(r[0]?.id).toBe('deepseek-chat');
  });

  it('上下文为 0 或负数当作「没有」', () => {
    const r = parseModelsResponse({ data: [{ id: 'x', context_window: 0 }] });
    expect(r[0]?.contextWindow).toBeNull();
  });
});

describe('formatContext：说人话', () => {
  it('千级说 K，百万级说 M', () => {
    expect(formatContext(131072)).toBe('131K 上下文');
    expect(formatContext(262144)).toBe('262K 上下文');
    expect(formatContext(1_000_000)).toBe('1M 上下文');
    expect(formatContext(1_500_000)).toBe('1.5M 上下文');
  });

  it('null → 不显示', () => {
    expect(formatContext(null)).toBeNull();
  });

  it('小的原样给', () => {
    expect(formatContext(512)).toBe('512 上下文');
  });
});

describe('fetchModels：三种失败要说清下一步', () => {
  it('Key 为空时不发请求', async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return ok({ data: [] });
    }) as unknown as typeof globalThis.fetch;

    const r = await fetchModels({ apiKey: '   ', baseUrl: 'https://x.y', fetchImpl: fake });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
    if (!r.ok) expect(r.reason).toContain('API Key');
  });

  it('401 → 说的是 Key 的问题', async () => {
    const fake = (async () =>
      ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://x.y', fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('401');
  });

  it('404 → 说的是地址的问题（不是 Key）', async () => {
    const fake = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://x.y', fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('404');
      expect(r.reason).toContain('/chat/completions');
    }
  });

  it('返回网页而不是 JSON → 说清可能不是 API 端点', async () => {
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://x.y', fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('JSON');
  });

  it('200 但没有可识别的模型 → 提示可以手填（不谎称「你没有模型」）', async () => {
    const fake = (async () => ok({ hello: 'world' })) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://x.y', fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('手填');
  });

  it('连不上 → 提到可能需要代理', async () => {
    const fake = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1', fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('代理');
  });

  it('成功时用归一化后的地址拼 /models', async () => {
    let seen = '';
    const fake = (async (url: string) => {
      seen = String(url);
      return ok({ data: [{ id: 'm1' }] });
    }) as unknown as typeof globalThis.fetch;

    /*
     * 用户把整段 /chat/completions 粘进来是高频错误
     * （presets.ts 里 normalizeBaseUrl 的注释列了四种真实输入）。
     * 这里验证它被吃掉，不会拼成 .../chat/completions/models。
     */
    const r = await fetchModels({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com/v1/chat/completions',
      fetchImpl: fake,
    });
    expect(seen).toBe('https://api.deepseek.com/v1/models');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.models).toHaveLength(1);
  });

  it('成功时把完整信息带回来', async () => {
    const fake = (async () =>
      ok({
        data: [
          { id: 'deepseek-v4-pro', name: 'V4 Pro', context_window: 131072 },
          { id: 'deepseek-v4.1-flash', name: 'V4.1 Flash', context_window: 65536 },
        ],
      })) as unknown as typeof globalThis.fetch;
    const r = await fetchModels({ apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com', fetchImpl: fake });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ids = r.models.map((m: DiscoveredModel) => m.id);
      expect(ids).toEqual(['deepseek-v4-pro', 'deepseek-v4.1-flash']);
    }
  });
});
