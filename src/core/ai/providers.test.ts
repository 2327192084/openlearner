import { describe, expect, it } from 'vitest';
import { ApiError, chatCompletion, hintFor } from './chat-client.ts';
import { ModelBackend } from './deepseek-backend.ts';
import type { OrganizeInputSegment } from '../knowledge/backend-types.ts';

/**
 * 多服务商接入层测试。
 *
 * 与 `ai.test.ts` 的分工：那边验「DeepSeek 一条链路对不对」，
 * 这边专门验「换成别家会不会崩」。全部用注入的假 fetch，不花钱、不发真请求。
 */

/** 记录最后一次请求，便于断言「发出去的东西对不对」 */
function captureFetch(reply: string, status = 200) {
  const seen: { url: string; body: any; headers: Record<string, string> } = {
    url: '',
    body: null,
    headers: {},
  };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(reply, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, seen };
}

function okReply(content: string) {
  return JSON.stringify({
    model: 'whatever',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

const BASE_OPTS = {
  apiKey: 'sk-test-key-1234567890',
  model: 'some-model',
  systemPrompt: 'sys',
  userPrompt: 'usr',
};

describe('请求发往正确的服务商', () => {
  it('地址末尾的斜杠不会拼出双斜杠', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({
      ...BASE_OPTS,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com///',
      fetchImpl: impl,
    });
    expect(seen.url).toBe('https://api.deepseek.com/chat/completions');
    expect(seen.url).not.toContain('//chat');
  });

  it('用户粘了完整端点也不会变成 /chat/completions/chat/completions', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({
      ...BASE_OPTS,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
      fetchImpl: impl,
    });
    expect(seen.url).toBe('https://api.moonshot.cn/v1/chat/completions');
  });

  it('不传 baseUrl 时按服务商预设兜底，而不是一律发去 DeepSeek', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({ ...BASE_OPTS, provider: 'zhipu', fetchImpl: impl });
    expect(seen.url).toContain('open.bigmodel.cn');
    expect(seen.url).not.toContain('deepseek');
  });

  it('完全认不出的 provider 退回 DeepSeek 地址（最保守的兜底）', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({ ...BASE_OPTS, provider: 'who-knows', fetchImpl: impl });
    expect(seen.url).toContain('api.deepseek.com');
  });

  it('凭据放在 Authorization: Bearer 里', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({ ...BASE_OPTS, provider: 'openai', fetchImpl: impl });
    expect(seen.headers.Authorization).toBe(`Bearer ${BASE_OPTS.apiKey}`);
  });
});

describe('JSON 模式按服务商能力决定', () => {
  it('支持的服务商会带上 response_format', async () => {
    const { impl, seen } = captureFetch(okReply('{}'));
    await chatCompletion({ ...BASE_OPTS, provider: 'deepseek', jsonMode: true, fetchImpl: impl });
    expect(seen.body.response_format).toEqual({ type: 'json_object' });
  });

  it('不请求 JSON 模式时绝不带 response_format', async () => {
    const { impl, seen } = captureFetch(okReply('hi'));
    await chatCompletion({ ...BASE_OPTS, provider: 'deepseek', fetchImpl: impl });
    expect(seen.body.response_format).toBeUndefined();
  });
});

describe('响应解析容错', () => {
  it('标准的 message.content 字符串', async () => {
    const { impl } = captureFetch(okReply('你好'));
    const result = await chatCompletion({ ...BASE_OPTS, provider: 'deepseek', fetchImpl: impl });
    expect(result.content).toBe('你好');
  });

  it('内容是多段数组（部分兼容服务这样返回）', async () => {
    const reply = JSON.stringify({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: '前半段' },
              { type: 'text', text: '后半段' },
            ],
          },
        },
      ],
    });
    const { impl } = captureFetch(reply);
    const result = await chatCompletion({ ...BASE_OPTS, provider: 'zhipu', fetchImpl: impl });
    expect(result.content).toBe('前半段后半段');
  });

  it('老式 choices[0].text 形状', async () => {
    const reply = JSON.stringify({ choices: [{ text: '老接口的答案' }] });
    const { impl } = captureFetch(reply);
    const result = await chatCompletion({ ...BASE_OPTS, provider: 'custom', fetchImpl: impl });
    expect(result.content).toBe('老接口的答案');
  });

  it('返回 200 但正文里带 error（个别兼容实现这么干）', async () => {
    const reply = JSON.stringify({ error: { message: 'quota exceeded' } });
    const { impl } = captureFetch(reply);
    await expect(
      chatCompletion({ ...BASE_OPTS, provider: 'custom', fetchImpl: impl }),
    ).rejects.toThrow();
  });
});

describe('错误分类：换成别家后仍然能给出可操作提示', () => {
  it('401 → invalid-key，提示去该服务商的控制台', async () => {
    const { impl } = captureFetch(JSON.stringify({ error: { message: 'invalid api key' } }), 401);
    await expect(
      chatCompletion({ ...BASE_OPTS, provider: 'moonshot', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'invalid-key' });
  });

  it('模型名不存在时能被单独识别（换服务商最容易踩的一条）', async () => {
    const body = JSON.stringify({
      error: { message: 'The model `deepseek-chat` does not exist for this account' },
    });
    const { impl } = captureFetch(body, 400);
    const err = await chatCompletion({ ...BASE_OPTS, provider: 'zhipu', fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad-request');
    // 提示里要能说清「是这个模型名的问题」，否则用户只看到 400 无从下手
    expect(`${err.message} ${err.hint}`).toMatch(/模型/);
  });

  it('上下文超长能被单独识别', async () => {
    const body = JSON.stringify({
      error: { message: 'maximum context length is 8192 tokens' },
    });
    const { impl } = captureFetch(body, 400);
    const err = await chatCompletion({ ...BASE_OPTS, provider: 'custom', fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(`${err.message} ${err.hint}`).toMatch(/长度|分段|缩短/);
  });

  it('404 提示检查地址是否填到 /v1（不带 /chat/completions）', async () => {
    const { impl } = captureFetch('Not Found', 404);
    const err = await chatCompletion({ ...BASE_OPTS, provider: 'custom', fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err.hint).toMatch(/地址|v1/);
  });

  it('连不上时不说「请检查网络」这种废话，给出三步具体排查', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await chatCompletion({ ...BASE_OPTS, provider: 'custom', fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err.code).toBe('network');
    expect(err.hint.length).toBeGreaterThan(10);
  });

  it('提示里绝不会出现完整 key', async () => {
    const key = 'sk-super-secret-key-abcdef123456';
    const { impl } = captureFetch(JSON.stringify({ error: { message: `bad key ${key}` } }), 401);
    const err = await chatCompletion({ ...BASE_OPTS, apiKey: key, provider: 'openai', fetchImpl: impl }).catch(
      (e) => e,
    );
    expect(err.message).not.toContain(key);
    expect(err.hint).not.toContain(key);
  });
});

describe('hintFor：错误提示跟着服务商走', () => {
  it('配了智谱就不该让用户去 DeepSeek 控制台找 Key', () => {
    const text = hintFor('invalid-key', 'zhipu');
    expect(text).not.toContain('DeepSeek');
    expect(text).toMatch(/智谱/);
  });

  it('没指定服务商时给通用提示，不点名', () => {
    const text = hintFor('invalid-key');
    expect(text).not.toContain('DeepSeek');
  });
});

describe('ModelBackend：id 带上服务商，多种后端的结果能分开', () => {
  it('默认 provider 时 id 是 model:deepseek（旧行为不变）', () => {
    expect(new ModelBackend({ apiKey: 'k' }).id).toBe('model:deepseek');
  });

  it('换了服务商 id 跟着变（同一份资料用两家整理，结果在库里能区分）', () => {
    expect(new ModelBackend({ apiKey: 'k', provider: 'zhipu' }).id).toBe('model:zhipu');
    expect(new ModelBackend({ apiKey: 'k', provider: 'moonshot' }).id).toBe('model:moonshot');
  });

  it('label 可以用配置里用户起的名字覆盖', () => {
    expect(new ModelBackend({ apiKey: 'k', label: '我的便宜通道' }).label).toBe('我的便宜通道');
  });

  it('两个不同服务商的后端实例不相等（下拉框不会串）', () => {
    const a = new ModelBackend({ apiKey: 'k', provider: 'zhipu' });
    const b = new ModelBackend({ apiKey: 'k', provider: 'moonshot' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('ModelBackend 端到端（假 fetch）：换服务商后请求体仍然正确', () => {
  const SEGMENTS: OrganizeInputSegment[] = [
    {
      segmentId: 's1',
      page: 1,
      chapter: '第一章',
      text: '线性表是由 n 个数据元素构成的有限序列，n 称为表长。',
    },
  ];

  it('provider 会一路透传到请求地址', async () => {
    const { impl, seen } = captureFetch(
      okReply(JSON.stringify({ points: [{ statement: '线性表是有限序列', quotes: ['线性表是'] , level: 'remember' }] })),
    );
    const backend = new ModelBackend({
      apiKey: 'k',
      provider: 'dashscope',
      model: 'qwen-plus',
      fetchImpl: impl,
    });
    await backend.organize({
      segments: SEGMENTS,
      sourceTitle: '数据结构',
      signal: new AbortController().signal,
      onDraft: async () => {},
    });
    expect(seen.url).toContain('dashscope.aliyuncs.com');
    expect(seen.body.model).toBe('qwen-plus');
  });
});

/**
 * 多模态（看图）请求体。
 *
 * 这组测试守的是一件很容易「看起来做了、实际没做」的事：
 * 界面上有「看图识公式」的能力勾选，就必须真的把图发出去。
 * 早先这个能力只是个勾选框，core 里一次都没读过 —— 用户勾上之后
 * 扫描件依然无法处理，而且没有任何报错。
 */
describe('多模态：图片要真的被发出去', () => {
  const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  it('不传图片时 content 是纯字符串（兼容面最大）', async () => {
    const { impl, seen } = captureFetch(okReply('好的'));
    await chatCompletion({ ...BASE_OPTS, fetchImpl: impl });

    const content = seen.body.messages[1].content;
    expect(typeof content).toBe('string');
    expect(content).toBe('usr');
  });

  it('***** 传了图片就必须进请求体，不能只存在参数里 *****', async () => {
    const { impl, seen } = captureFetch(okReply('好的'));
    await chatCompletion({ ...BASE_OPTS, fetchImpl: impl, images: [{ dataUrl: TINY }] });

    const content = seen.body.messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    // 文字块在前：先说清楚要模型干什么，再看图
    expect(content[0]).toMatchObject({ type: 'text', text: 'usr' });
    expect(content[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: TINY },
    });
  });

  it('多张图片按顺序全部发出', async () => {
    const { impl, seen } = captureFetch(okReply('好的'));
    await chatCompletion({
      ...BASE_OPTS,
      fetchImpl: impl,
      images: [{ dataUrl: TINY }, { dataUrl: TINY, detail: 'high' }],
    });

    const content = seen.body.messages[1].content;
    expect(content).toHaveLength(3);
    // 第二张带了 detail，必须透传 —— high 是让模型不要把图缩小，
    // 小字号公式缩了就认不出来
    expect(content[2].image_url).toMatchObject({ url: TINY, detail: 'high' });
    // 第一张没指定 detail 时不该凭空塞一个
    expect(content[1].image_url).not.toHaveProperty('detail');
  });

  it('系统提示词始终是字符串（不跟着变数组）', async () => {
    const { impl, seen } = captureFetch(okReply('好的'));
    await chatCompletion({ ...BASE_OPTS, fetchImpl: impl, images: [{ dataUrl: TINY }] });

    expect(typeof seen.body.messages[0].content).toBe('string');
  });
});
