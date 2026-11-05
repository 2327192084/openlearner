import { describe, expect, it } from 'vitest';
import type { KnowledgePoint } from '../model.ts';
import { applyAiOutline } from './ai-outline.ts';
import {
  ModelOutlineBackend,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  parseOutlinePages,
} from './outline-backend.ts';

/**
 * AI 大纲的测试。
 *
 * 这组测试守的是本轮改动最容易出错的地方：**AI 改写了要点文字，
 * 角标还必须指回那条知识点当初被定位到的真实页码**。
 *
 * 出错的形态很隐蔽：页面上有一句漂亮的讲解，旁边挂着一个 [3]，
 * 点过去却在第 7 页找不到这段话。所有自动验收都会通过
 * （文字有、角标有、页数对），只有人真的点一下才发现。
 */

/** 造一条已定位的知识点 */
function located(id: string, statement: string, page: number): KnowledgePoint {
  return {
    id,
    statement,
    quotes: [`原文片段 ${id}`],
    cognitiveLevel: 'understand',
    tags: [],
    chapter: '第一章',
    sourceId: 'src_1',
    // 知识点来自资料（不是联网检索来的）
    origin: 'material',
    anchors: [{ sourceId: 'src_1', page, charStart: 0, charEnd: 10, chapter: '第一章' }],
    anchorStatus: 'located',
    backendId: null,
    approved: true,
    createdAt: '',
    updatedAt: '',
  } as KnowledgePoint;
}

/** 造一条未定位的知识点 */
function unlocated(id: string, statement: string): KnowledgePoint {
  return {
    ...located(id, statement, 1),
    anchors: [],
    anchorStatus: 'unlocated',
  } as KnowledgePoint;
}

describe('applyAiOutline：角标必须指回真实页码', () => {
  it('AI 改写过的要点，角标仍指向该知识点的真实页码', () => {
    const points = [located('k1', '线性表是有限序列', 3)];

    const result = applyAiOutline({
      pages: [
        {
          title: '线性表入门',
          subtitle: null,
          // 文字被 AI 改写过了，不再是原文
          bullets: [{ text: '线性表本质上是一个有限序列', fromPointId: 'k1' }],
        },
      ],
      points,
      sourceTitle: '数据结构',
      deckTitle: '数据结构 · 复习',
    });

    expect(result.pages).toHaveLength(1);
    const bullet = result.pages[0]!.bullets[0]!;
    expect(bullet.text).toBe('线性表本质上是一个有限序列');
    // 关键：角标不是 null，且指向第 3 页
    expect(bullet.citationIndex).toBe(1);
    expect(result.citations[0]!.page).toBe(3);
    expect(result.citations[0]!.knowledgePointId).toBe('k1');
  });

  it('页码从知识点 anchors 原样继承，不重新推算', () => {
    const points = [located('k1', '甲', 42)];
    const result = applyAiOutline({
      pages: [{ title: '页', subtitle: null, bullets: [{ text: '乙', fromPointId: 'k1' }] }],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    // 42 这个数字只存在于 anchors 里，没有任何其他来源能"算"出来
    expect(result.citations[0]!.page).toBe(42);
  });

  it('同一条知识点被拆成多条要点，共用一个角标编号', () => {
    const points = [located('k1', '甲', 5)];
    const result = applyAiOutline({
      pages: [
        {
          title: '页',
          subtitle: null,
          bullets: [
            { text: '要点一', fromPointId: 'k1' },
            { text: '要点二', fromPointId: 'k1' },
            { text: '要点三', fromPointId: 'k1' },
          ],
        },
      ],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    const bullets = result.pages[0]!.bullets;
    expect(bullets).toHaveLength(3);
    // 标三个号会让人以为引了三处原文
    expect(new Set(bullets.map((b) => b.citationIndex)).size).toBe(1);
    expect(result.citations).toHaveLength(1);
  });

  it('多条知识点各自独立编号', () => {
    const points = [located('k1', '甲', 1), located('k2', '乙', 2), located('k3', '丙', 3)];
    const result = applyAiOutline({
      pages: [
        {
          title: '页',
          subtitle: null,
          bullets: [
            { text: 'a', fromPointId: 'k2' },
            { text: 'b', fromPointId: 'k1' },
            { text: 'c', fromPointId: 'k3' },
          ],
        },
      ],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    // 编号按出现顺序，从 1 开始连续
    const indexes = result.pages[0]!.bullets.map((b) => b.citationIndex);
    expect(indexes).toEqual([1, 2, 3]);
    expect(result.citations.map((c) => c.knowledgePointId)).toEqual(['k2', 'k1', 'k3']);
  });

  it('未定位的知识点：要点保留，但不给假角标', () => {
    const points = [unlocated('k1', '甲')];
    const result = applyAiOutline({
      pages: [{ title: '页', subtitle: null, bullets: [{ text: '要点', fromPointId: 'k1' }] }],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    const bullet = result.pages[0]!.bullets[0]!;
    expect(bullet.text).toBe('要点');
    expect(bullet.citationIndex).toBeNull();
    expect(result.citations).toHaveLength(0);
    expect(result.bulletsWithoutCitation).toBe(1);
  });

  it('模型编了一个不存在的 id：那条要点被丢弃并计数', () => {
    const points = [located('k1', '甲', 1)];
    const result = applyAiOutline({
      pages: [
        {
          title: '页',
          subtitle: null,
          bullets: [
            { text: '真的', fromPointId: 'k1' },
            { text: '编的', fromPointId: 'k999' },
          ],
        },
      ],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    expect(result.pages[0]!.bullets).toHaveLength(1);
    expect(result.pages[0]!.bullets[0]!.text).toBe('真的');
    expect(result.droppedBullets).toBe(1);
  });

  it('一页里全部要点都查不到 id 时整页丢弃', () => {
    const points = [located('k1', '甲', 1)];
    const result = applyAiOutline({
      pages: [
        { title: '坏页', subtitle: null, bullets: [{ text: 'x', fromPointId: 'nope' }] },
        { title: '好页', subtitle: null, bullets: [{ text: 'y', fromPointId: 'k1' }] },
      ],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.title).toBe('好页');
  });

  it('AI 给的页标题被保留（不再出现「未分章」「（续）」）', () => {
    const points = [located('k1', '甲', 1)];
    const result = applyAiOutline({
      pages: [{ title: '线性表的定义与特点', subtitle: '本节要点', bullets: [{ text: 'x', fromPointId: 'k1' }] }],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    expect(result.pages[0]!.title).toBe('线性表的定义与特点');
    expect(result.pages[0]!.subtitle).toBe('本节要点');
  });

  it('AI 没给标题时用兜底文案，不留空字符串', () => {
    const points = [located('k1', '甲', 1)];
    const result = applyAiOutline({
      pages: [{ title: null, subtitle: null, bullets: [{ text: 'x', fromPointId: 'k1' }] }],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    expect(result.pages[0]!.title).toBe('本页要点');
    expect(result.pages[0]!.subtitle).toBeNull();
  });

  it('超长要点仍按标点拆开，拆出的多条共用角标', () => {
    const points = [located('k1', '甲', 1)];
    const long = '这是第一句话，' + '内容'.repeat(60) + '。这是第二句话，' + '内容'.repeat(60) + '。';
    const result = applyAiOutline({
      pages: [{ title: '页', subtitle: null, bullets: [{ text: long, fromPointId: 'k1' }] }],
      points,
      sourceTitle: 'S',
      deckTitle: 'D',
    });

    const bullets = result.pages[0]!.bullets;
    expect(bullets.length).toBeGreaterThan(1);
    expect(new Set(bullets.map((b) => b.citationIndex)).size).toBe(1);
  });
});

describe('parseOutlinePages：模型返回的清洗', () => {
  it('正常 JSON 能解析', () => {
    const pages = parseOutlinePages(
      JSON.stringify({
        pages: [
          { title: '页一', bullets: [{ text: '要点', fromPointId: 'k1' }] },
        ],
      }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.bullets[0]!.fromPointId).toBe('k1');
  });

  it('带代码围栏也能解析', () => {
    const pages = parseOutlinePages(
      '```json\n{"pages":[{"title":"T","bullets":[{"text":"x","fromPointId":"k1"}]}]}\n```',
    );
    expect(pages).toHaveLength(1);
  });

  it('前后有废话时抠出 JSON', () => {
    const pages = parseOutlinePages(
      '好的，下面是结果：\n{"pages":[{"title":"T","bullets":[{"text":"x","fromPointId":"k1"}]}]}\n希望有帮助。',
    );
    expect(pages).toHaveLength(1);
  });

  it('没有 fromPointId 的要点被丢弃（否则点不回原文）', () => {
    const pages = parseOutlinePages(
      JSON.stringify({
        pages: [{ title: 'T', bullets: [{ text: '有出处', fromPointId: 'k1' }, { text: '没出处' }] }],
      }),
    );
    expect(pages[0]!.bullets).toHaveLength(1);
    expect(pages[0]!.bullets[0]!.text).toBe('有出处');
  });

  it('没有 text 的要点被丢弃', () => {
    const pages = parseOutlinePages(
      JSON.stringify({ pages: [{ title: 'T', bullets: [{ fromPointId: 'k1' }] }] }),
    );
    // 整页没有有效要点 → 整页丢掉
    expect(pages).toHaveLength(0);
  });

  it('空标题变成 null 而不是空字符串', () => {
    const pages = parseOutlinePages(
      JSON.stringify({
        pages: [{ title: '   ', bullets: [{ text: 'x', fromPointId: 'k1' }] }],
      }),
    );
    expect(pages[0]!.title).toBeNull();
  });

  it('单页要点超过 5 条时截断', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => ({ text: `b${i}`, fromPointId: 'k1' }));
    const pages = parseOutlinePages(JSON.stringify({ pages: [{ title: 'T', bullets }] }));
    expect(pages[0]!.bullets).toHaveLength(5);
  });

  it('不是 JSON 时返回空数组而不是抛错', () => {
    expect(parseOutlinePages('模型今天不想干活')).toEqual([]);
  });

  it('pages 不是数组时返回空数组', () => {
    expect(parseOutlinePages('{"pages": "nope"}')).toEqual([]);
  });
});

describe('ModelOutlineBackend：请求形状', () => {
  function captureFetch(reply: unknown) {
    const seen: { body: Record<string, unknown> } = { body: {} };
    const impl = (async (_url: string, init: RequestInit) => {
      seen.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, seen };
  }

  const points = [
    {
      id: 'k1',
      statement: '线性表是有限序列',
      quotes: ['原文'],
      chapter: '第一章',
      page: 3,
      cognitiveLevel: 'understand' as const,
    },
  ];

  it('开启 JSON 模式且温度低', async () => {
    const { impl, seen } = captureFetch({
      choices: [{ message: { content: '{"pages":[]}' } }],
    });
    const backend = new ModelOutlineBackend({ apiKey: 'k', provider: 'deepseek', fetchImpl: impl });

    await backend.generate(points, {
      title: 'T',
      sourceTitle: 'S',
      maxPages: 5,
      language: 'zh',
      signal: new AbortController().signal,
    });

    expect(seen.body.response_format).toMatchObject({ type: 'json_object' });
    expect(seen.body.temperature).toBe(0.3);
  });

  it('系统提示词里明确要求不要输出页码', () => {
    const system = buildOutlineSystemPrompt('zh');
    // 位置由程序负责，模型给页码只会造成「知识点说第 3 页、PPT 说第 5 页」
    expect(system).toMatch(/绝对不要输出页码/);
  });

  it('用户提示词里带上知识点 id 与格式说明', () => {
    const prompt = buildOutlineUserPrompt(points, {
      title: 'T',
      sourceTitle: 'S',
      maxPages: 5,
      language: 'zh',
    });
    expect(prompt).toContain('fromPointId');
    expect(prompt).toContain('k1');
  });

  it('返回 token 用量', async () => {
    const { impl } = captureFetch({
      choices: [{ message: { content: '{"pages":[]}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const backend = new ModelOutlineBackend({ apiKey: 'k', provider: 'deepseek', fetchImpl: impl });

    const result = await backend.generate(points, {
      title: 'T',
      sourceTitle: 'S',
      maxPages: 5,
      language: 'zh',
      signal: new AbortController().signal,
    });

    expect(result.actualTokens).toBe(150);
  });

  it('估算用量随知识点数量增长', () => {
    const backend = new ModelOutlineBackend({ apiKey: 'k', provider: 'deepseek' });
    const opts = { title: 'T', sourceTitle: 'S', maxPages: 5, language: 'zh' as const };

    const one = backend.estimateTokens(points, opts);
    const many = backend.estimateTokens([...points, ...points, ...points], opts);
    expect(many).toBeGreaterThan(one);
  });
});
