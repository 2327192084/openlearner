import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProbes,
  extractAssistantText,
  findCapability,
  judgeProbe,
  probeCacheKey,
  probeSearchCapability,
  readProbe,
  searchViaModel,
  SEARCH_CAPABILITIES,
  writeProbe,
  type SearchHttp,
} from './model-search.ts';

/**
 * 「模型自带联网搜索」（2026-11-22 下午）。
 *
 * ## 这组测试守的核心一件事
 *
 * **探不通就必须如实说「没联网」，绝不能假装搜过。**
 *
 * 用户看到「已联网查过」就会当作依据，而实际上模型只是凭记忆编 ——
 * 这正是这个项目反复记的同一类错误（假成功后端、断言全绿不算交付）。
 *
 * 另一半守的是「不按服务商名字硬编码」：provider 是自由字符串，
 * 用户能填中转站/私有部署。所以能力必须**探**出来，不是查表查出来。
 */

/** 造一个可控的假 HTTP */
function fakeHttp(handler: (body: Record<string, unknown>) => { status: number; text: string }): SearchHttp {
  return async (input) => {
    const body = JSON.parse(input.body) as Record<string, unknown>;
    const r = handler(body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.text };
  };
}

/** 成功响应 */
const OK_BODY = JSON.stringify({
  choices: [{ message: { content: '这门课通常分 8 章：第1章 函数与极限…' } }],
});

const base = {
  provider: 'whatever',
  baseUrl: 'https://example.com/v1',
  model: 'some-model',
  apiKey: 'sk-test',
  chatUrl: 'https://example.com/v1/chat/completions',
};

beforeEach(() => {
  clearProbes();
});

describe('judgeProbe：哪些错误该换写法，哪些该停', () => {
  it('2xx → 接受', () => {
    expect(judgeProbe({ ok: true, status: 200 })).toEqual({ action: 'accept' });
  });

  it('400 → 换下一种写法（参数不认识）', () => {
    const v = judgeProbe({ ok: false, status: 400, body: 'unknown field tools' });
    expect(v.action).toBe('try-next');
  });

  it('422 → 换下一种写法', () => {
    expect(judgeProbe({ ok: false, status: 422 }).action).toBe('try-next');
  });

  it('⚠️ 401/403 → 立刻停（Key 或权限问题，换写法没用）', () => {
    expect(judgeProbe({ ok: false, status: 401 }).action).toBe('stop');
    expect(judgeProbe({ ok: false, status: 403 }).action).toBe('stop');
  });

  it('⚠️ 429 → 立刻停（继续试只会更糟，还白花钱）', () => {
    expect(judgeProbe({ ok: false, status: 429 }).action).toBe('stop');
  });

  it('5xx → 停（不是参数问题）', () => {
    expect(judgeProbe({ ok: false, status: 502 }).action).toBe('stop');
  });

  it('⚠️ 400 但正文说模型不存在 → 停（别把模型名错当成"不支持联网"）', () => {
    const v = judgeProbe({
      ok: false,
      status: 400,
      body: '{"error":{"message":"Model Not Exist"}}',
    });
    expect(v.action).toBe('stop');
    /* 收窄后才能取 reason（ProbeVerdict 是判别联合） */
    expect(v.action === 'stop' ? v.reason : '').toContain('模型名');
  });

  it('400 正文只说参数不认识 → 继续试下一种', () => {
    const v = judgeProbe({ ok: false, status: 400, body: 'unsupported parameter: tools' });
    expect(v.action).toBe('try-next');
  });
});

describe('probeSearchCapability：探测与缓存', () => {
  it('第一种写法就成功 → supported，且只发了一次请求', async () => {
    let calls = 0;
    const http = fakeHttp(() => {
      calls += 1;
      return { status: 200, text: OK_BODY };
    });
    const r = await probeSearchCapability({ ...base, http });
    expect(r).toEqual({ kind: 'supported', capabilityId: SEARCH_CAPABILITIES[0]!.id });
    expect(calls).toBe(1);
  });

  it('⚠️ 前面的写法都 400、最后一种成 → 记住最后那种', async () => {
    const http = fakeHttp((body) => {
      /* 只认 enable_search */
      if (body['enable_search'] === true) return { status: 200, text: OK_BODY };
      return { status: 400, text: 'unknown param' };
    });
    const r = await probeSearchCapability({ ...base, http });
    expect(r.kind).toBe('supported');
    if (r.kind === 'supported') {
      expect(findCapability(r.capabilityId)?.id).toBe('enable-search');
    }
  });

  it('⚠️ 全部写法都被拒 → unsupported（不是"假装成功"）', async () => {
    const http = fakeHttp(() => ({ status: 400, text: 'unknown param' }));
    const r = await probeSearchCapability({ ...base, http });
    expect(r.kind).toBe('unsupported');
    if (r.kind === 'unsupported') {
      expect(r.reason).toContain('不联网');
    }
  });

  it('401 时立刻停，不把四种写法都试一遍（省请求）', async () => {
    let calls = 0;
    const http = fakeHttp(() => {
      calls += 1;
      return { status: 401, text: 'bad key' };
    });
    const r = await probeSearchCapability({ ...base, http });
    expect(r.kind).toBe('unsupported');
    expect(calls).toBe(1);
  });

  it('⚠️ 网络异常 → unsupported 但要说清「是网络问题，不是不支持联网」', async () => {
    const http: SearchHttp = async () => {
      throw new Error('Failed to fetch');
    };
    const r = await probeSearchCapability({ ...base, http });
    expect(r.kind).toBe('unsupported');
    if (r.kind === 'unsupported') {
      expect(r.reason).toContain('网络');
      expect(r.reason).toContain('不是不支持联网');
    }
  });

  it('探过一次就缓存，第二次不再发请求', async () => {
    let calls = 0;
    const http = fakeHttp(() => {
      calls += 1;
      return { status: 200, text: OK_BODY };
    });
    await probeSearchCapability({ ...base, http });
    await probeSearchCapability({ ...base, http });
    expect(calls).toBe(1);
  });

  it('⚠️ 缓存按「后端 + 模型」区分：换个模型要重新探', async () => {
    /*
     * 同一个服务商的便宜小模型常常不开放联网。
     * 只按 provider 缓存，会把「A 能联网」错用到 B 上。
     */
    const key1 = probeCacheKey({ provider: 'p', baseUrl: 'u', model: 'm1' });
    const key2 = probeCacheKey({ provider: 'p', baseUrl: 'u', model: 'm2' });
    expect(key1).not.toBe(key2);
  });

  it('⚠️ 用户取消() → 不记成 unsupported（否则下次白降级）', async () => {
    const ac = new AbortController();
    ac.abort();
    const http = fakeHttp(() => ({ status: 200, text: OK_BODY }));
    const r = await probeSearchCapability({ ...base, http, signal: ac.signal });
    expect(r.kind).toBe('unknown');
    /* 缓存里也不该有"不支持"的记录 */
    expect(readProbe(probeCacheKey(base)).kind).toBe('unknown');
  });

  it('探测请求本身是极短的（max_tokens 很小）', async () => {
    let seen: Record<string, unknown> = {};
    const http = fakeHttp((body) => {
      seen = body;
      return { status: 200, text: OK_BODY };
    });
    await probeSearchCapability({ ...base, http });
    expect(seen['max_tokens']).toBeLessThanOrEqual(16);
  });
});

describe('searchViaModel：如实降级', () => {
  it('后端支持 → searched: true，并把结果包成一条 hit', async () => {
    const http = fakeHttp(() => ({ status: 200, text: OK_BODY }));
    const out = await searchViaModel({ ...base, http, query: '高等数学 常见章节结构' });
    expect(out.result.searched).toBe(true);
    expect(out.result.hits).toHaveLength(1);
    expect(out.result.hits[0]!.snippet).toContain('第1章');
    expect(out.capabilityId).not.toBeNull();
  });

  it('⚠️ 后端不支持 → searched: false，note 说清原因（绝不假装搜过）', async () => {
    const http = fakeHttp(() => ({ status: 400, text: 'unknown param' }));
    const out = await searchViaModel({ ...base, http, query: 'q' });
    expect(out.result.searched).toBe(false);
    expect(out.result.hits).toEqual([]);
    expect(out.result.note).toContain('探不通');
  });

  it('模型说「没有检索到」→ searched: true 但 hits 空（搜过但没结果）', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: '没有检索到相关内容' } }] }),
    }));
    const out = await searchViaModel({ ...base, http, query: 'q' });
    expect(out.result.searched).toBe(true);
    expect(out.result.hits).toEqual([]);
    expect(out.result.note).toContain('没找到');
  });

  it('响应里没有 content → searched: true 但如实说没内容', async () => {
    const http = fakeHttp(() => ({ status: 200, text: JSON.stringify({ choices: [] }) }));
    const out = await searchViaModel({ ...base, http, query: 'q' });
    expect(out.result.searched).toBe(true);
    expect(out.result.hits).toEqual([]);
    expect(out.result.note).toContain('没给出内容');
  });

  it('检索请求返回 500 → searched: false（不能当成搜到了）', async () => {
    let n = 0;
    const http = fakeHttp(() => {
      n += 1;
      /* 第一次探测成功，第二次检索失败 */
      return n === 1 ? { status: 200, text: OK_BODY } : { status: 500, text: 'boom' };
    });
    const out = await searchViaModel({ ...base, http, query: 'q' });
    expect(out.result.searched).toBe(false);
    expect(out.result.note).toContain('HTTP 500');
  });

  it('结果标题如实标明「模型自己总结的，不是原始网页摘录」', async () => {
    const http = fakeHttp(() => ({ status: 200, text: OK_BODY }));
    const out = await searchViaModel({ ...base, http, query: 'q' });
    expect(out.result.hits[0]!.title).toContain('模型联网检索');
    expect(out.result.hits[0]!.title).toContain('不是原始网页摘录');
  });
});

describe('extractAssistantText：别把思考当正文', () => {
  it('取 message.content', () => {
    expect(
      extractAssistantText(JSON.stringify({ choices: [{ message: { content: '正文' } }] })),
    ).toBe('正文');
  });

  it('⚠️ 推理模型的 reasoning_content 不会被当成正文', () => {
    const raw = JSON.stringify({
      choices: [{ message: { reasoning_content: '我在想…', content: '真正的答案' } }],
    });
    expect(extractAssistantText(raw)).toBe('真正的答案');
  });

  it('content 是数组时拼起来', () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }],
    });
    expect(extractAssistantText(raw)).toBe('甲乙');
  });

  it('坏 JSON → 空串，不抛', () => {
    expect(extractAssistantText('not json')).toBe('');
    expect(extractAssistantText('')).toBe('');
  });

  it('没有 choices → 空串', () => {
    expect(extractAssistantText(JSON.stringify({}))).toBe('');
  });
});

describe('候选写法清单', () => {
  it('每条 id 唯一', () => {
    const ids = SEARCH_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⚠️ 没有任何一条按服务商名字判断（必须通用）', () => {
    /*
     * 用户明确要求：服务商因用户而异，不能写死。
     * 判据：apply 的结果不因 provider 变化（apply 根本不接受 provider）。
     */
    for (const cap of SEARCH_CAPABILITIES) {
      expect(cap.apply.length).toBe(1); // 只接受 body 一个参数
    }
  });

  it('每条都能真的往 body 里加东西', () => {
    for (const cap of SEARCH_CAPABILITIES) {
      const before = { model: 'm' };
      const after = cap.apply(before);
      expect(Object.keys(after).length).toBeGreaterThan(Object.keys(before).length);
    }
  });

  it('不影响原有字段', () => {
    for (const cap of SEARCH_CAPABILITIES) {
      const after = cap.apply({ model: 'm', stream: false });
      expect(after['model']).toBe('m');
      expect(after['stream']).toBe(false);
    }
  });
});

describe('writeProbe / readProbe', () => {
  it('写进去能读出来', () => {
    writeProbe('k', { kind: 'supported', capabilityId: 'x' });
    expect(readProbe('k')).toEqual({ kind: 'supported', capabilityId: 'x' });
  });

  it('没写过的键返回 unknown', () => {
    expect(readProbe('nope')).toEqual({ kind: 'unknown' });
  });
});