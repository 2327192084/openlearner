import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchDailyQuote, parseRemoteQuote, __resetQuoteCacheForTest } from './daily-quote.ts';
import { DAILY_QUOTES, pickDailyQuote } from './home-widgets.ts';

/**
 * 每日一句的远程获取与兜底（2026-11-08，用户要求联网）。
 *
 * 重点守「断网/接口坏掉时首页不能空」—— 这是引入网络依赖的
 * 唯一不能妥协的地方。所有失败路径都必须回到本地语料。
 */

const EP = 'https://example.com/quote.json';
const DAY = new Date('2026-11-08T10:00:00');

/*
 * 缓存是模块级的内存状态（为了让「没有 localStorage 的环境」也能缓存），
 * 所以每个用例前必须清掉 —— 否则前一个用例成功拿到的远程句子
 * 会让后一个「应当失败兜底」的用例直接命中缓存，测不到失败路径。
 * 这是我自己写测试时踩到的：5 个失败路径用例全红，而代码是对的。
 */
beforeEach(() => {
  __resetQuoteCacheForTest();
});

/** 造一个假的 fetch */
function fakeFetch(impl: () => Promise<Response> | Response) {
  return vi.fn(async () => impl()) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('parseRemoteQuote', () => {
  it('认 {text, author}', () => {
    expect(parseRemoteQuote({ text: '句子', author: '某人' })).toEqual({
      text: '句子',
      author: '某人',
    });
  });

  it('认 {quote} / {content} / {sentence}', () => {
    expect(parseRemoteQuote({ quote: 'A' })?.text).toBe('A');
    expect(parseRemoteQuote({ content: 'B' })?.text).toBe('B');
    expect(parseRemoteQuote({ sentence: 'C' })?.text).toBe('C');
  });

  it('认数组（取第一个字符串）', () => {
    expect(parseRemoteQuote(['句子甲', '句子乙'])?.text).toBe('句子甲');
  });

  it('认不出返回 null（不抛）', () => {
    expect(parseRemoteQuote(null)).toBeNull();
    expect(parseRemoteQuote({})).toBeNull();
    expect(parseRemoteQuote({ foo: 'bar' })).toBeNull();
    expect(parseRemoteQuote(42)).toBeNull();
    expect(parseRemoteQuote('字符串')).toBeNull();
  });

  it('空字符串算认不出', () => {
    expect(parseRemoteQuote({ text: '   ' })).toBeNull();
  });

  it('author 缺失给 null，不产生 undefined', () => {
    const r = parseRemoteQuote({ text: 'x' });
    expect(r?.author).toBeNull();
  });
});

describe('fetchDailyQuote：没配端点走纯本地', () => {
  it('返回本地语料，不碰网络', async () => {
    const f = fakeFetch(() => jsonResponse({ text: '不该被调用' }));
    const r = await fetchDailyQuote({ endpoint: '', fetchImpl: f, now: DAY });
    expect(r.source).toBe('local');
    expect(DAILY_QUOTES).toContain(r.text);
    expect(f).not.toHaveBeenCalled();
  });

  it('endpoint 传 null 也一样', async () => {
    const r = await fetchDailyQuote({ endpoint: null, now: DAY });
    expect(r.source).toBe('local');
  });
});

describe('fetchDailyQuote：远程成功', () => {
  it('拿到远程句子，标 source=remote', async () => {
    const f = fakeFetch(() => jsonResponse({ text: '远程句子', author: '出处' }));
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.source).toBe('remote');
    expect(r.text).toBe('远程句子');
    expect(r.author).toBe('出处');
  });
});

describe('fetchDailyQuote：所有失败都要兜底（首页不能空）', () => {
  it('非 2xx → 本地兜底，带原因', async () => {
    const f = fakeFetch(() => jsonResponse({}, false, 503));
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.source).toBe('local');
    expect(DAILY_QUOTES).toContain(r.text);
    expect(r.fallbackReason).toContain('503');
  });

  it('网络异常 → 本地兜底', async () => {
    const f = fakeFetch(() => Promise.reject(new Error('network down')));
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.source).toBe('local');
    expect(DAILY_QUOTES).toContain(r.text);
  });

  it('返回格式认不出 → 本地兜底', async () => {
    const f = fakeFetch(() => jsonResponse({ foo: 1 }));
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.source).toBe('local');
    expect(r.fallbackReason).toContain('没有可用的句子');
  });

  it('json 解析炸了 → 本地兜底', async () => {
    const f = fakeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('bad json');
          },
        }) as unknown as Response,
    );
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.source).toBe('local');
  });
});

describe('缓存', () => {
  it('同一天同一端点只请求一次', async () => {
    const calls: string[] = [];
    const f = vi.fn(async () => {
      calls.push('x');
      return jsonResponse({ text: '缓存测试' });
    }) as unknown as typeof fetch;

    const r1 = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    const r2 = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });

    expect(r1.text).toBe('缓存测试');
    expect(r2.text).toBe('缓存测试');
    // 第二次命中缓存，不再请求
    expect(calls).toHaveLength(1);
  });

  it('换端点不走旧缓存', async () => {
    const f = vi.fn(async () => jsonResponse({ text: '端点2' })) as unknown as typeof fetch;
    await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    const r = await fetchDailyQuote({
      endpoint: 'https://example.com/other.json',
      fetchImpl: f,
      now: DAY,
    });
    expect(r.source).toBe('remote');
    expect(r.text).toBe('端点2');
  });
});

describe('本地兜底与 pickDailyQuote 一致', () => {
  it('兜底时用的就是当天那句内置文案', async () => {
    const f = fakeFetch(() => Promise.reject(new Error('x')));
    const r = await fetchDailyQuote({ endpoint: EP, fetchImpl: f, now: DAY });
    expect(r.text).toBe(pickDailyQuote('2026-11-08'));
  });
});
