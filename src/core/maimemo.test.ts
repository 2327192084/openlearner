import { describe, expect, it, vi } from 'vitest';
import {
  buildNotepadContent,
  extractWords,
  MaimemoClient,
  maimemoConfigFromSettings,
  normalizeWord,
  parseMaimemoError,
  parseNotepads,
} from './maimemo.ts';

/**
 * 墨墨 API 客户端的纯逻辑测试（2026-11-09）。
 *
 * 重点：
 *  1. **HTTP 200 也可能是失败**（实测未授权就是 200 + success:false）
 *     —— 只看状态码的客户端会把「token 错了」当成「导入成功」
 *  2. 词表清洗：划一整句时不能把 the/a/is 塞进生词本
 *  3. 各种网络/格式失败都要归类，界面才能给对的建议
 */

describe('parseMaimemoError', () => {
  it('真实未授权响应 → unauthorized（注意 HTTP 是 200）', () => {
    /*
     * 这是 2026-11-09 实测拿到的原样响应：
     *   GET https://open.maimemo.com/open/api/v1/notepads（不带 token）
     *   → {"errors":[{"code":"common_unauthorized","msg":"Authorization failed","info":""}],
     *      "success":false}
     * 状态码是 200。如果客户端只看 res.ok 就会当成成功 —— 那是最糟的结果。
     */
    const r = parseMaimemoError({
      errors: [{ code: 'common_unauthorized', msg: 'Authorization failed', info: '' }],
      success: false,
    });
    expect(r?.trouble).toBe('unauthorized');
    expect(r?.message).toBe('Authorization failed');
  });

  it('success:true 且无 errors → 不是错误', () => {
    expect(parseMaimemoError({ success: true, notepads: [] })).toBeNull();
  });

  it('其它业务错误 → server', () => {
    const r = parseMaimemoError({
      errors: [{ code: 'notepad_not_found', msg: '词本不存在' }],
      success: false,
    });
    expect(r?.trouble).toBe('server');
    expect(r?.message).toBe('词本不存在');
  });

  it('success 缺失又没有 errors → bad-response（不假装成功）', () => {
    expect(parseMaimemoError({ foo: 1 })?.trouble).toBe('bad-response');
  });

  it('非对象输入返回 null', () => {
    expect(parseMaimemoError(null)).toBeNull();
    expect(parseMaimemoError('x')).toBeNull();
  });
});

describe('parseNotepads', () => {
  it('解析 notepads 字段', () => {
    const list = parseNotepads({
      success: true,
      notepads: [{ id: 'np-abc', title: '我的生词', wordCount: 12 }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('np-abc');
    expect(list[0]!.wordCount).toBe(12);
  });

  it('也认 data / list 字段（接口形状不确定时容错）', () => {
    expect(parseNotepads({ data: [{ id: 'np-1' }] })).toHaveLength(1);
    expect(parseNotepads({ list: [{ id: 'np-2' }] })).toHaveLength(1);
  });

  it('缺 id 的条目跳过，不让一条坏数据毁掉整个列表', () => {
    const list = parseNotepads({
      notepads: [{ id: 'np-ok', title: 'A' }, { title: '没有 id' }, null, 'x'],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('np-ok');
  });

  it('缺标题给可读默认值，不是 undefined', () => {
    expect(parseNotepads({ notepads: [{ id: 'np-1' }] })[0]!.title).toBe('(未命名词本)');
  });

  it('缺 wordCount 给 null（不知道 ≠ 0）', () => {
    expect(parseNotepads({ notepads: [{ id: 'np-1' }] })[0]!.wordCount).toBeNull();
  });

  it('坏输入返回空数组', () => {
    expect(parseNotepads(null)).toEqual([]);
    expect(parseNotepads({})).toEqual([]);
  });
});

describe('normalizeWord', () => {
  it('统一小写', () => {
    expect(normalizeWord('Apple')).toBe('apple');
  });

  it('保留连字符与撇号（合法单词）', () => {
    expect(normalizeWord('well-known')).toBe('well-known');
    expect(normalizeWord("don't")).toBe("don't");
    /* 各种异体撇号统一成一个 */
    expect(normalizeWord('don’t')).toBe("don't");
  });

  it('去掉首尾空白', () => {
    expect(normalizeWord('  word  ')).toBe('word');
  });

  it('太短的拒绝（1 个字母不是单词）', () => {
    expect(normalizeWord('a')).toBe('');
    expect(normalizeWord('I')).toBe('');
  });

  it('太长的拒绝（多半是划错了一整段）', () => {
    expect(normalizeWord('a'.repeat(41))).toBe('');
  });

  it('含非英文字母的拒绝（中文、数字、标点）', () => {
    expect(normalizeWord('信号')).toBe('');
    expect(normalizeWord('abc123')).toBe('');
    expect(normalizeWord('hello!')).toBe('');
  });

  it('首尾是连字符/撇号的拒绝', () => {
    expect(normalizeWord('-word')).toBe('');
    expect(normalizeWord("'word")).toBe('');
    expect(normalizeWord('word-')).toBe('');
  });

  it('连续撇号/连字符的怪串拒绝', () => {
    expect(normalizeWord("a''b")).toBe('');
    expect(normalizeWord('a--b')).toBe('');
  });
});

describe('extractWords', () => {
  it('从一句话里抽出实词，滤掉虚词', () => {
    /*
     * 这是核心场景：用户划了一整句，
     * the / a / is 这些进生词本毫无意义，只会把词本淹掉。
     */
    const words = extractWords('The quick brown fox is a very lazy animal.');
    expect(words).toContain('quick');
    expect(words).toContain('brown');
    expect(words).toContain('fox');
    expect(words).toContain('lazy');
    expect(words).toContain('animal');
    /* 虚词都被滤掉 */
    expect(words).not.toContain('the');
    expect(words).not.toContain('is');
    expect(words).not.toContain('a');
    expect(words).not.toContain('very');
  });

  it('去重（同一句里重复的词只算一次）', () => {
    expect(extractWords('apple apple apple')).toEqual(['apple']);
  });

  it('单个词也能正确抽出', () => {
    expect(extractWords('ubiquitous')).toEqual(['ubiquitous']);
  });

  it('混入中文/数字的部分被跳过，英文照抽', () => {
    const words = extractWords('这是 signal 信号 123 processing 处理');
    expect(words).toEqual(['signal', 'processing']);
  });

  it('空输入返回空数组', () => {
    expect(extractWords('')).toEqual([]);
    expect(extractWords('   ')).toEqual([]);
    expect(extractWords('123 456')).toEqual([]);
  });

  it('全是虚词时返回空（不硬凑）', () => {
    expect(extractWords('the a is of to')).toEqual([]);
  });
});

describe('buildNotepadContent', () => {
  it('每行一个词，去重保序', () => {
    const c = buildNotepadContent(['apple', 'banana', 'apple', 'cherry']);
    expect(c).toBe('apple\nbanana\ncherry');
  });

  it('清洗后再去重（Apple 与 apple 是同一个词）', () => {
    expect(buildNotepadContent(['Apple', 'apple', 'APPLE'])).toBe('apple');
  });

  it('非法词被丢掉，不影响其它词', () => {
    expect(buildNotepadContent(['信号', 'apple', '123', 'banana'])).toBe('apple\nbanana');
  });

  it('全都非法时返回空串（调用方据此报错，不静默发空请求）', () => {
    expect(buildNotepadContent(['信号', '123', 'a'])).toBe('');
  });

  it('空数组返回空串', () => {
    expect(buildNotepadContent([])).toBe('');
  });
});

describe('MaimemoClient', () => {
  function jsonOk(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it('没有 token 时直接返回 no-token，不发请求', async () => {
    const f = vi.fn();
    const c = new MaimemoClient({ token: '', fetchImpl: f as unknown as typeof fetch });
    const r = await c.listNotepads();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trouble).toBe('no-token');
    expect(f).not.toHaveBeenCalled();
  });

  it('列词本成功', async () => {
    const f = vi.fn(async () =>
      jsonOk({ success: true, notepads: [{ id: 'np-1', title: '生词', wordCount: 3 }] }),
    ) as unknown as typeof fetch;
    const c = new MaimemoClient({ token: 't', fetchImpl: f });
    const r = await c.listNotepads();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data[0]!.id).toBe('np-1');
  });

  it('HTTP 200 但 success:false → 归类成 unauthorized，不当成功', async () => {
    /*
     * 这条是整个客户端最重要的一条测试。
     * 只看 res.ok 的实现会在这里返回成功，然后用户以为导入成功了，
     * 打开墨墨发现什么都没有。
     */
    const f = vi.fn(async () =>
      jsonOk({
        errors: [{ code: 'common_unauthorized', msg: 'Authorization failed', info: '' }],
        success: false,
      }),
    ) as unknown as typeof fetch;
    const c = new MaimemoClient({ token: 'bad', fetchImpl: f });
    const r = await c.listNotepads();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trouble).toBe('unauthorized');
  });

  it('HTTP 401 → unauthorized', async () => {
    const f = vi.fn(async () => jsonOk({}, 401)) as unknown as typeof fetch;
    const c = new MaimemoClient({ token: 't', fetchImpl: f });
    const r = await c.listNotepads();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trouble).toBe('unauthorized');
  });

  it('网络异常 → network', async () => {
    const f = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const c = new MaimemoClient({ token: 't', fetchImpl: f });
    const r = await c.listNotepads();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trouble).toBe('network');
  });

  it('返回非 JSON → bad-response', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const c = new MaimemoClient({ token: 't', fetchImpl: f });
    const r = await c.listNotepads();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trouble).toBe('bad-response');
  });

  it('导入词条：没有有效单词时不发请求', async () => {
    const f = vi.fn();
    const c = new MaimemoClient({ token: 't', fetchImpl: f as unknown as typeof fetch });
    const r = await c.importWords({ notepadId: 'np-1', words: ['信号', '123'] });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('导入词条：拼出 content 并统计条数', async () => {
    let sentBody = '';
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body ?? '');
      return jsonOk({ success: true });
    }) as unknown as typeof fetch;

    const c = new MaimemoClient({ token: 't', fetchImpl: f });
    const r = await c.importWords({ notepadId: 'np-1', words: ['apple', 'banana', 'apple'] });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.imported).toBe(2);

    const body = JSON.parse(sentBody);
    expect(body.notepad.content).toBe('apple\nbanana');
    expect(body.notepad.status).toBe('UNPUBLISHED');
  });

  it('导入带上 Authorization 头', async () => {
    let auth = '';
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      auth = headers.Authorization ?? '';
      return jsonOk({ success: true });
    }) as unknown as typeof fetch;

    const c = new MaimemoClient({ token: 'my-token', fetchImpl: f });
    await c.importWords({ notepadId: 'np-1', words: ['apple'] });
    expect(auth).toBe('Bearer my-token');
  });
});

describe('maimemoConfigFromSettings', () => {
  it('读出 token 与词本 id', () => {
    const r = maimemoConfigFromSettings({ maimemoToken: 't', maimemoNotepadId: 'np-1' });
    expect(r).toEqual({ token: 't', notepadId: 'np-1' });
  });

  it('缺失字段给空串（等于未配置，不是 undefined）', () => {
    expect(maimemoConfigFromSettings(null)).toEqual({ token: '', notepadId: '' });
    expect(maimemoConfigFromSettings({})).toEqual({ token: '', notepadId: '' });
  });

  it('类型不对时给空串，不抛', () => {
    expect(maimemoConfigFromSettings({ maimemoToken: 42 }).token).toBe('');
  });
});
