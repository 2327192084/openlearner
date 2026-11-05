import { describe, expect, it } from 'vitest';
import type { BackendView } from '../backends.ts';
import { ModelVisionBackend, normalizeOcrText, pickVisionBackends } from './vision-backend.ts';
import { OcrError } from './types.ts';

/**
 * 视觉后端的测试。
 *
 * 重点在请求体：图片必须真的按 OpenAI 多模态形状发出去。
 * 「界面上有勾选框、代码里也传了参数、但请求体里没有图」是这类功能
 * 最容易出现的失败方式 —— 它不报错，只是默默地什么都没做。
 */

const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** 截一次请求，返回看到的东西 */
function captureFetch(reply: unknown = okReply('识别结果')) {
  const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } = {
    url: '',
    body: {},
    headers: {},
  };
  const impl = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init.body));
    seen.headers = (init.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function okReply(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    model: 'test-vision',
  };
}

describe('ModelVisionBackend：图片真的进了请求体', () => {
  it('按 OpenAI 多模态形状发出 text + image_url', async () => {
    const { impl, seen } = captureFetch();
    const backend = new ModelVisionBackend({
      apiKey: 'sk-test',
      model: 'glm-4v',
      provider: 'zhipu',
      fetchImpl: impl,
    });

    await backend.extractPage({ imageDataUrl: TINY, pageNo: 12, sourceTitle: '数据结构' });

    const content = (seen.body.messages as { content: unknown }[])[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Record<string, unknown>[];

    // 文字块在前：先说清页码与要求，再看图
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(String(blocks[0]!.text)).toContain('12');
    expect(String(blocks[0]!.text)).toContain('数据结构');

    // 图片块：整串 data URL 原样发，不能切掉前缀
    expect(blocks[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: TINY, detail: 'high' },
    });
  });

  it('detail 用 high：小字号公式缩了就认不出来', async () => {
    const { impl, seen } = captureFetch();
    const backend = new ModelVisionBackend({
      apiKey: 'k',
      provider: 'zhipu',
      fetchImpl: impl,
    });

    await backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' });

    const content = (seen.body.messages as { content: Record<string, unknown>[] }[])[1]!.content;
    expect((content[1]!.image_url as { detail: string }).detail).toBe('high');
  });

  it('系统提示词明确要求「不要编」，且是纯字符串', async () => {
    const { impl, seen } = captureFetch();
    const backend = new ModelVisionBackend({
      apiKey: 'k',
      provider: 'zhipu',
      fetchImpl: impl,
    });

    await backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' });

    const system = (seen.body.messages as { role: string; content: unknown }[])[0]!;
    expect(system.role).toBe('system');
    expect(typeof system.content).toBe('string');
    // OCR 结果会成为「点回原文」的引用底本，编出来的字会让定位全错
    expect(String(system.content)).toMatch(/Never complete, guess/i);
  });

  it('温度是 0：照着抄，不需要发挥', async () => {
    const { impl, seen } = captureFetch();
    const backend = new ModelVisionBackend({ apiKey: 'k', provider: 'zhipu', fetchImpl: impl });

    await backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' });
    expect(seen.body.temperature).toBe(0);
  });

  it('返回 token 用量（用量统计要靠它）', async () => {
    const { impl } = captureFetch();
    const backend = new ModelVisionBackend({ apiKey: 'k', provider: 'zhipu', fetchImpl: impl });

    const result = await backend.extractPage({
      imageDataUrl: TINY,
      pageNo: 1,
      sourceTitle: 'x',
    });
    expect(result.actualTokens).toBe(120);
  });

  it('服务端没返回 usage 时是 null，不猜一个数字', async () => {
    const { impl } = captureFetch({
      choices: [{ message: { content: '字' } }],
      model: 'm',
    });
    const backend = new ModelVisionBackend({ apiKey: 'k', provider: 'zhipu', fetchImpl: impl });

    const result = await backend.extractPage({
      imageDataUrl: TINY,
      pageNo: 1,
      sourceTitle: 'x',
    });
    expect(result.actualTokens).toBeNull();
  });

  it('Authorization 头带上了这把 key', async () => {
    const { impl, seen } = captureFetch();
    const backend = new ModelVisionBackend({
      apiKey: 'sk-secret-123456',
      provider: 'zhipu',
      fetchImpl: impl,
    });

    await backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' });
    expect(JSON.stringify(seen.headers)).toContain('sk-secret-123456');
  });
});

describe('ModelVisionBackend：失败必须给得出下一步', () => {
  it('没有 key 时提前拦住，不发请求', async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const backend = new ModelVisionBackend({ apiKey: '   ', provider: 'zhipu', fetchImpl: impl });

    await expect(
      backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' }),
    ).rejects.toBeInstanceOf(OcrError);
    expect(called).toBe(false);
  });

  it('图片不是 data URL 时提前拦住（裸 base64 会被服务端含糊地拒绝）', async () => {
    const seen = { called: false };
    const impl = (async () => {
      seen.called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const backend = new ModelVisionBackend({ apiKey: 'k', provider: 'zhipu', fetchImpl: impl });

    await expect(
      backend.extractPage({ imageDataUrl: 'iVBORw0KGgo=', pageNo: 1, sourceTitle: 'x' }),
    ).rejects.toThrow(/不是 data URL/);
    expect(seen.called).toBe(false);
  });

  it('后端不支持看图时，提示指向「模型名可能不是多模态的」', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { message: 'model does not support image input' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const backend = new ModelVisionBackend({
      apiKey: 'k',
      model: 'deepseek-chat',
      provider: 'deepseek',
      fetchImpl: impl,
    });

    await expect(
      backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' }),
    ).rejects.toMatchObject({ hint: expect.stringMatching(/多模态|glm-4v|gpt-4o/) });
  });

  it('错误消息里不出现明文 key', async () => {
    const key = 'sk-verysecret-abcdef123456';
    const impl = (async () =>
      new Response(
        JSON.stringify({ error: { message: `bad request for key ${key}` } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const backend = new ModelVisionBackend({ apiKey: key, provider: 'zhipu', fetchImpl: impl });

    let message = '';
    try {
      await backend.extractPage({ imageDataUrl: TINY, pageNo: 1, sourceTitle: 'x' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(key);
  });
});

describe('normalizeOcrText：只做不改变内容的整理', () => {
  it('去掉模型包上的代码围栏', () => {
    expect(normalizeOcrText('```\n线性表\n```')).toBe('线性表');
    expect(normalizeOcrText('```text\n线性表\n```')).toBe('线性表');
  });

  it('统一换行并去掉首尾空白', () => {
    expect(normalizeOcrText('\r\n  第一段\r\n第二段  \r\n')).toBe('第一段\n第二段');
  });

  it('不改写正文内容（公式不能被改成 LaTeX）', () => {
    const raw = '设 f(x) = ∑(a_i) ，其中 i = 1…n';
    expect(normalizeOcrText(raw)).toBe(raw);
  });

  it('保留段落之间的空行', () => {
    expect(normalizeOcrText('第一段\n\n第二段')).toBe('第一段\n\n第二段');
  });
});

describe('pickVisionBackends：勾选框是唯一入口', () => {
  const make = (over: Partial<BackendView> = {}): BackendView =>
    ({
      id: 'b1',
      label: '智谱',
      kind: 'direct-api',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4v',
      capabilities: { textOrganize: true, visionFormula: true },
      status: 'ready',
      isDefault: false,
      createdAt: '',
      updatedAt: '',
      hasCredential: true,
      credentialHint: 'sk-***abc',
      ...over,
    }) as BackendView;

  it('勾了「看图识公式」且配置完整时才被选中', () => {
    expect(pickVisionBackends([make()])).toHaveLength(1);
  });

  it('没勾勾选框就不出现（用户可能不想让它乱花钱）', () => {
    expect(pickVisionBackends([make({ capabilities: { textOrganize: true, visionFormula: false } })])).toHaveLength(0);
  });

  it('没有凭据或状态不是 ready 时排除', () => {
    expect(pickVisionBackends([make({ hasCredential: false })])).toHaveLength(0);
    expect(pickVisionBackends([make({ status: 'unconfigured' })])).toHaveLength(0);
  });

  it('agent-app 类型排除（那条路当前走不通）', () => {
    expect(pickVisionBackends([make({ kind: 'agent-app' })])).toHaveLength(0);
  });
});
