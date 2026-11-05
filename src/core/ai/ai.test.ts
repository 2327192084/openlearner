import { describe, expect, it } from 'vitest';
import { ApiError, chatCompletion, redactSecrets } from './deepseek-client.ts';
import { DeepSeekBackend, parsePointsJson, testConnection } from './deepseek-backend.ts';
import { buildSystemPrompt, buildUserPrompt } from './prompts.ts';
import type { OrganizeInputSegment } from '../knowledge/backend-types.ts';

/**
 * AI 接入层测试。
 *
 * 核心原则：**不真发请求、不花钱**。
 * 全部通过注入 fetchImpl 来模拟服务端响应，
 * 所以这套测试可以随便跑，不会消耗额度。
 *
 * 真实调用只能靠人工点一次「测试连接」验证，
 * 这一点在验收报告里如实说明。
 */

/** 造一个假的 fetch，按脚本返回 */
function mockFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: string },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init ?? {});
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function okResponse(content: string, usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) {
  return JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content } }],
    usage,
  });
}

const SEGMENTS: OrganizeInputSegment[] = [
  {
    segmentId: 's1',
    page: 1,
    chapter: '第一章',
    text: '线性表是由 n 个数据元素构成的有限序列，n 称为表长。顺序表用连续存储单元。',
  },
];

describe('redactSecrets：凭据绝不泄露到日志或界面', () => {
  it('把具体 key 从文本里抹掉', () => {
    const key = 'sk-abcdef1234567890abcdef';
    expect(redactSecrets(`使用 ${key} 调用失败`, key)).not.toContain(key);
  });

  it('抹掉 Bearer 头', () => {
    expect(redactSecrets('Authorization: Bearer sk-xyz123456789')).not.toContain('sk-xyz123456789');
  });

  it('抹掉任何 sk- 开头的长串（即使调用方没传 key）', () => {
    expect(redactSecrets('error with sk-abcdefgh12345678')).toContain('sk-***');
  });

  it('普通文本不受影响', () => {
    expect(redactSecrets('网络超时')).toBe('网络超时');
  });
});

describe('chatCompletion：请求构造与响应解析', () => {
  it('正确构造请求（URL、头、body）', async () => {
    let captured: { url: string; init: RequestInit } | null = null;

    await chatCompletion({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      systemPrompt: 'sys',
      userPrompt: 'user',
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { body: okResponse('{"ok":true}') };
      }),
    });

    expect(captured!.url).toBe('https://api.deepseek.com/chat/completions');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');

    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toBe('user');
    expect(body.stream).toBe(false);
  });

  it('jsonMode 会带 response_format', async () => {
    let body: Record<string, unknown> = {};
    await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      fetchImpl: mockFetch((_u, init) => {
        body = JSON.parse(String(init.body));
        return { body: okResponse('{}') };
      }),
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('解析出 content 与 usage', async () => {
    const result = await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: mockFetch(() => ({ body: okResponse('你好') })),
    });

    expect(result.content).toBe('你好');
    expect(result.usage?.totalTokens).toBe(150);
    expect(result.model).toBe('deepseek-chat');
  });

  it('没有 usage 时返回 null 而不是崩掉', async () => {
    const result = await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: mockFetch(() =>
        // 有些兼容服务不返回 usage
        ({ body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }),
      ),
    });
    expect(result.usage).toBeNull();
  });

  it('空 Key 直接报错，不发请求', async () => {
    let called = false;
    const error = await chatCompletion({
      apiKey: '   ',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: mockFetch(() => {
        called = true;
        return { body: okResponse('x') };
      }),
    }).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid-key');
    expect(called).toBe(false);
  });
});

describe('错误分类：每种失败都给出能行动的下一步', () => {
  const cases: { status: number; body: string; expect: string; hintPattern: RegExp }[] = [
    { status: 401, body: '{"error":"bad key"}', expect: 'invalid-key', hintPattern: /设置页|API Key/ },
    { status: 403, body: '{"error":"forbidden"}', expect: 'forbidden', hintPattern: /权限|账号/ },
    { status: 402, body: '{"error":"payment required"}', expect: 'insufficient-balance', hintPattern: /余额|充值/ },
    { status: 429, body: '{"error":"rate limit"}', expect: 'rate-limited', hintPattern: /频率|稍后|等/ },
    { status: 500, body: '{"error":"boom"}', expect: 'server-error', hintPattern: /临时|稍后|服务商/ },
    { status: 503, body: '', expect: 'server-error', hintPattern: /临时|稍后/ },
  ];

  for (const c of cases) {
    it(`HTTP ${c.status} → ${c.expect}`, async () => {
      const error = await chatCompletion({
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userPrompt: 'u',
        fetchImpl: mockFetch(() => ({ status: c.status, body: c.body })),
      }).then(() => null, (e: unknown) => e as ApiError);

      expect(error).toBeInstanceOf(ApiError);
      expect(error!.code).toBe(c.expect);
      // hint 必须可操作，不能只说失败
      expect(error!.hint).toMatch(c.hintPattern);
      expect(error!.status).toBe(c.status);
    });
  }

  it('余额不足时即使状态码是 400 也能认出来（body 里有 Insufficient Balance）', async () => {
    const error = await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: mockFetch(() => ({
        status: 400,
        body: '{"error":{"message":"Insufficient Balance"}}',
      })),
    }).then(() => null, (e: unknown) => e as ApiError);

    // 只看状态码会误判成 bad-request，误导用户以为是软件 bug
    expect(error!.code).toBe('insufficient-balance');
  });

  it('网络异常归类为 network', async () => {
    const error = await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: (async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      }) as unknown as typeof fetch,
    }).then(() => null, (e: unknown) => e as ApiError);

    expect(error!.code).toBe('network');
    expect(error!.hint).toMatch(/网络|代理/);
  });

  it('用户取消归类为 aborted，且提示已完成部分会保留', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await chatCompletion({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        // 模拟 fetch 在 signal 已取消时的行为
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response('{}');
      }) as unknown as typeof fetch,
    }).then(() => null, (e: unknown) => e as ApiError);

    expect(error!.code).toBe('aborted');
  });

  it('错误信息里绝不含 API Key', async () => {
    const key = 'sk-secret-key-1234567890abcdef';
    const error = await chatCompletion({
      apiKey: key,
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl: mockFetch(() => ({
        status: 400,
        // 有些服务会把请求头回显在错误里
        body: `{"error":"bad request with Authorization: Bearer ${key}"}`,
      })),
    }).then(() => null, (e: unknown) => e as ApiError);

    expect(error!.message).not.toContain(key);
    // 脱敏后保留可识别的掩码痕迹，让看日志的人知道这里原本有个 key
    expect(error!.message).toContain('sk-***');
  });
});

describe('parsePointsJson：模型的真实输出往往不干净', () => {
  it('标准 JSON 能解析', () => {
    const drafts = parsePointsJson(
      JSON.stringify({
        points: [
          {
            statement: '线性表的定义',
            quotes: ['线性表是由 n 个数据元素构成的有限序列'],
            cognitiveLevel: 'remember',
            tags: ['线性表'],
          },
        ],
      }),
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].statement).toBe('线性表的定义');
    expect(drafts[0].cognitiveLevel).toBe('remember');
  });

  it('带 ```json 围栏也能解析', () => {
    const content = '```json\n{"points":[{"statement":"A","quotes":["原文引用内容在此"]}]}\n```';
    expect(parsePointsJson(content)).toHaveLength(1);
  });

  it('前后有说明文字也能解析', () => {
    const content = '好的，这是整理结果：\n{"points":[{"statement":"A","quotes":["原文引用内容"]}]}\n希望有帮助。';
    expect(parsePointsJson(content)).toHaveLength(1);
  });

  it('quotes 被写成字符串而不是数组时也能修', () => {
    const drafts = parsePointsJson(
      '{"points":[{"statement":"A","quotes":"原文引用内容在此处"}]}',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].quotes).toEqual(['原文引用内容在此处']);
  });

  it('非法认知层级回退为 understand，不丢弃这条', () => {
    const drafts = parsePointsJson(
      '{"points":[{"statement":"A","quotes":["引用"],"cognitiveLevel":"莫名其妙"}]}',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].cognitiveLevel).toBe('understand');
  });

  it('没有 quotes 的条目被丢弃（留着也只会变成待处理）', () => {
    const drafts = parsePointsJson(
      '{"points":[{"statement":"有概念但没引用"},{"statement":"B","quotes":["有引用"]}]}',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].statement).toBe('B');
  });

  it('单条坏数据不影响其他条', () => {
    const drafts = parsePointsJson(
      JSON.stringify({
        points: [
          { statement: '', quotes: ['x'] }, // 缺 statement
          null, // 完全不是对象
          { statement: '好的', quotes: ['引用原文'] },
          { statement: '缺引用' },
        ],
      }),
    );
    // 只有一条合格
    expect(drafts).toHaveLength(1);
    expect(drafts[0].statement).toBe('好的');
  });

  it('完全找不到 JSON 时抛出可读的错误', () => {
    const error = (() => {
      try {
        parsePointsJson('抱歉，我无法完成这个任务。');
        return null;
      } catch (e) {
        return e as ApiError;
      }
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect(error!.message).toContain('找不到 JSON');
  });

  it('JSON 被截断时报错并建议减少页数', () => {
    const error = (() => {
      try {
        parsePointsJson('{"points":[{"statement":"未完成的');
        return null;
      } catch (e) {
        return e as ApiError;
      }
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect(error!.hint).toMatch(/减少|重试/);
  });
});

describe('DeepSeekBackend：遵守 OrganizeBackend 契约', () => {
  it('标为非 mock，id 里带服务商（同资料不同后端的结果要能区分）', () => {
    const backend = new DeepSeekBackend({ apiKey: 'k' });
    expect(backend.isMock).toBe(false);
    // 默认服务商是 deepseek；id 前缀 model: 让「模型后端」与 mock 一眼可分
    expect(backend.id).toBe('model:deepseek');

    const zhipu = new DeepSeekBackend({ apiKey: 'k', provider: 'zhipu' });
    expect(zhipu.id).toBe('model:zhipu');
    expect(zhipu.id).not.toBe(backend.id);
  });

  it('逐条 await onDraft（停止才能生效、落库才不会丢）', async () => {
    const backend = new DeepSeekBackend({
      apiKey: 'k',
      fetchImpl: mockFetch(() => ({
        body: okResponse(
          JSON.stringify({
            points: [
              { statement: 'A', quotes: ['引用一'], cognitiveLevel: 'remember' },
              { statement: 'B', quotes: ['引用二'], cognitiveLevel: 'understand' },
            ],
          }),
        ),
      })),
    });

    const seen: string[] = [];
    const result = await backend.organize({
      sourceTitle: '测试',
      segments: SEGMENTS,
      signal: new AbortController().signal,
      onDraft: async (d) => {
        seen.push(d.statement);
      },
    });

    expect(seen).toEqual(['A', 'B']);
    expect(result.drafts).toHaveLength(2);
  });

  it('累计多批次的用量', async () => {
    const backend = new DeepSeekBackend({
      apiKey: 'k',
      segmentsPerRequest: 1,
      fetchImpl: mockFetch(() => ({
        body: okResponse(
          JSON.stringify({ points: [{ statement: 'A', quotes: ['引用'] }] }),
          { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        ),
      })),
    });

    const twoSegments: OrganizeInputSegment[] = [
      SEGMENTS[0],
      { segmentId: 's2', page: 2, chapter: null, text: '第二段的正文内容在这里。' },
    ];

    const result = await backend.organize({
      sourceTitle: '测试',
      segments: twoSegments,
      signal: new AbortController().signal,
    });

    // 两批各 150
    expect(result.actualTokens).toBe(300);
  });

  it('中途取消时保留已产出并标记 stopped', async () => {
    const controller = new AbortController();
    const backend = new DeepSeekBackend({
      apiKey: 'k',
      fetchImpl: mockFetch(() => ({
        body: okResponse(
          JSON.stringify({
            points: [
              { statement: 'A', quotes: ['引用一'] },
              { statement: 'B', quotes: ['引用二'] },
            ],
          }),
        ),
      })),
    });

    const result = await backend.organize({
      sourceTitle: '测试',
      segments: SEGMENTS,
      signal: controller.signal,
      onDraft: async () => {
        controller.abort();
      },
    });

    expect(result.stopped).toBe(true);
    // 第一条已经产出并回调过
    expect(result.drafts.length).toBeGreaterThanOrEqual(1);
    expect(result.drafts.length).toBeLessThan(2);
  });

  it('估算用量包含 system prompt 与输出的余量', () => {
    const backend = new DeepSeekBackend({ apiKey: 'k' });
    const estimate = backend.estimateTokens(SEGMENTS);
    const chars = SEGMENTS[0].text.length;

    // 应当明显大于纯正文字数，因为包含 system prompt
    expect(estimate).toBeGreaterThan(chars * 1.6);
    expect(estimate).toBeGreaterThan(600);
  });

  it('服务端错误会抛给调用方，不静默返回空', async () => {
    const backend = new DeepSeekBackend({
      apiKey: 'k',
      fetchImpl: mockFetch(() => ({ status: 500, body: '{}' })),
    });

    await expect(
      backend.organize({
        sourceTitle: '测试',
        segments: SEGMENTS,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('testConnection：最小代价换确定答案', () => {
  it('成功时返回模型名与耗时', async () => {
    const result = await testConnection({
      apiKey: 'k',
      fetchImpl: mockFetch(() => ({ body: okResponse('{"ok":true}') })),
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('deepseek-chat');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('失败时返回分类与提示，而不是抛异常', async () => {
    const result = await testConnection({
      apiKey: 'bad',
      fetchImpl: mockFetch(() => ({ status: 401, body: '{"error":"bad key"}' })),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('invalid-key');
    expect(result.failure?.hint).toBeTruthy();
  });

  it('超时也算失败并给出网络类提示', async () => {
    const result = await testConnection({
      apiKey: 'k',
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new Error('timed out');
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('network');
  });
});

describe('提示词：几条硬规则必须在场', () => {
  const system = buildSystemPrompt('zh');

  it('声明材料是数据不是指令（防注入）', () => {
    expect(system).toMatch(/数据.*不是指令|不是指令/);
  });

  it('要求 quotes 逐字复制，不能改写', () => {
    expect(system).toMatch(/逐字/);
    expect(system).toMatch(/不能改写/);
  });

  it('明确禁止输出页码（位置由我们定位）', () => {
    expect(system).toMatch(/不要输出页码/);
  });

  it('规定 quotes 只能来自同一段材料', () => {
    expect(system).toMatch(/同一段材料/);
  });

  it('给出 JSON 输出结构', () => {
    expect(system).toContain('"points"');
    expect(system).toContain('"statement"');
    expect(system).toContain('"quotes"');
  });

  it('用户消息里材料被编号且用分隔标记包住', () => {
    const user = buildUserPrompt({ sourceTitle: '数据结构', segments: SEGMENTS });

    expect(user).toContain('S1');
    expect(user).toContain('MATERIALS 开始');
    expect(user).toContain('MATERIALS 结束');
    expect(user).toContain('线性表是由 n 个数据元素');
  });

  it('超长段会被截断并明确标注', () => {
    const long = '甲'.repeat(10000);
    const user = buildUserPrompt({
      sourceTitle: 't',
      segments: [{ segmentId: 's1', page: 1, chapter: null, text: long }],
      maxCharsPerSegment: 100,
    });

    expect(user).toContain('省略');
    expect(user.length).toBeLessThan(long.length);
  });

  it('英文模式下 system 提示词也是英文', () => {
    const en = buildSystemPrompt('en');
    // system 里要求模型用英文输出，且不再有中文规则文字
    expect(en).toContain('English');
    expect(en).toContain('points');
    expect(en).not.toContain('逐字');
  });

  it('英文模式下 user 提示词也是英文', () => {
    const user = buildUserPrompt({
      sourceTitle: 'Data Structures',
      segments: SEGMENTS,
      language: 'en',
    });

    expect(user).toContain('MATERIALS START');
    expect(user).toContain('verbatim');
    expect(user).not.toContain('再次提醒');
  });
});
