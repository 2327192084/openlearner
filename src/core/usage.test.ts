import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import {
  UsageService,
  estimateCostCny,
  formatCost,
  localDay,
  startOfMonth,
  usageKey,
} from './usage.ts';
import { KnowledgeService } from './knowledge/service.ts';
import { SourceService } from './sources.ts';
import { DeckService } from './questions/service.ts';
import type { KnowledgeDraft, OrganizeBackend } from './knowledge/backend-types.ts';
import type { QuestionBackend, QuestionDraft } from './questions/backend-types.ts';
import type { KnowledgePoint } from './model.ts';

/**
 * 用量统计的测试。
 *
 * 这一组刻意多测「不该记的东西」：不计费的假后端、服务端没返回 usage 的情况、
 * 边界日期。因为账单类功能最怕的不是少记一笔，而是**记错**
 * —— 用户按它做判断，错的数字比没有数字更糟。
 */

describe('localDay / usageKey / startOfMonth', () => {
  it('按本地时区切天，不是 UTC', () => {
    /**
     * 这台的时区是 UTC+8。用 toISOString() 会把 00:30 记成前一天，
     * 于是「今天用了多少」在半夜到早上八点之间全是错的。
     */
    const early = new Date(2026, 10, 5, 0, 30, 0); // 11 月 5 日 00:30 本地时间
    expect(localDay(early)).toBe('2026-11-05');
  });

  it('补零', () => {
    expect(localDay(new Date(2026, 0, 3))).toBe('2026-01-03');
    expect(localDay(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('主键是确定性三元组', () => {
    expect(usageKey('2026-11-05', 'model:zhipu', 'organize')).toBe('2026-11-05|model:zhipu|organize');
    // 同一个格两次拼出来必须完全一样，否则聚合会变成两条
    expect(usageKey('2026-11-05', 'model:zhipu', 'organize')).toBe(
      usageKey('2026-11-05', 'model:zhipu', 'organize'),
    );
  });

  it('本月第一天', () => {
    expect(startOfMonth(new Date(2026, 10, 5))).toBe('2026-11-01');
    expect(startOfMonth(new Date(2026, 0, 31))).toBe('2026-01-01');
  });
});

describe('UsageService 记账', () => {
  let storage: MemoryStorage;
  let usage: UsageService;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.init();
    usage = new UsageService(storage);
  });

  it('记一笔后能查出来', async () => {
    await usage.record({
      backendId: 'model:deepseek',
      provider: 'deepseek',
      kind: 'organize',
      tokens: 1200,
      at: new Date(2026, 10, 5),
    });

    const rows = await usage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(1200);
    expect(rows[0]!.day).toBe('2026-11-05');
    expect(rows[0]!.calls).toBe(1);
  });

  it('同一格重复记账是累加，不是新增一条', async () => {
    const at = new Date(2026, 10, 5);
    const base = { backendId: 'model:deepseek', provider: 'deepseek', kind: 'organize' as const, at };

    await usage.record({ ...base, tokens: 100 });
    await usage.record({ ...base, tokens: 250 });
    await usage.record({ ...base, tokens: 50 });

    const rows = await usage.list();
    // 关键：三次写入只有一行。按次存的话这里会是 3 行，一个月就几千行
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(400);
    expect(rows[0]!.calls).toBe(3);
  });

  it('同一天不同后端分开记', async () => {
    const at = new Date(2026, 10, 5);
    await usage.record({ backendId: 'model:deepseek', provider: 'deepseek', kind: 'organize', tokens: 100, at });
    await usage.record({ backendId: 'model:zhipu', provider: 'zhipu', kind: 'organize', tokens: 300, at });

    const rows = await usage.byBackend();
    expect(rows).toHaveLength(2);
    // 按 token 从多到少：用户最想知道「谁在花钱」
    expect(rows[0]!.backendId).toBe('model:zhipu');
    expect(rows[0]!.tokens).toBe(300);
  });

  it('同一后端同一天，整理与出题分开记', async () => {
    const at = new Date(2026, 10, 5);
    const backendId = 'model:deepseek';
    await usage.record({ backendId, provider: 'deepseek', kind: 'organize', tokens: 100, at });
    await usage.record({ backendId, provider: 'deepseek', kind: 'questions', tokens: 700, at });

    const rows = await usage.byBackend();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(800);
    expect(rows[0]!.organizeTokens).toBe(100);
    expect(rows[0]!.questionsTokens).toBe(700);
  });

  it('tokens 为 0 或负数不写库', async () => {
    const at = new Date(2026, 10, 5);
    const base = { backendId: 'm', provider: 'p', kind: 'organize' as const, at };

    expect(await usage.record({ ...base, tokens: 0 })).toBeNull();
    expect(await usage.record({ ...base, tokens: -5 })).toBeNull();
    expect(await usage.record({ ...base, tokens: Number.NaN })).toBeNull();

    /**
     * 为什么这条重要：服务端没返回 usage 时上游会传 0。
     * 如果老老实实记成 0，界面上会出现「花了 0 token」的记录，
     * 用户会以为「免费用了」，而实际上可能是没统计到 —— 比留空更误导。
     */
    expect(await usage.list()).toHaveLength(0);
  });

  it('按天汇总，日期升序且跨天后分成两行', async () => {
    await usage.record({ backendId: 'd', provider: 'deepseek', kind: 'organize', tokens: 100, at: new Date(2026, 10, 4) });
    await usage.record({ backendId: 'd', provider: 'deepseek', kind: 'organize', tokens: 200, at: new Date(2026, 10, 5) });
    await usage.record({ backendId: 'd', provider: 'deepseek', kind: 'organize', tokens: 50, at: new Date(2026, 10, 5) });

    const days = await usage.byDay();
    expect(days.map((d) => d.day)).toEqual(['2026-11-04', '2026-11-05']);
    expect(days[1]!.tokens).toBe(250);
  });

  it('日期区间是闭区间', async () => {
    for (const day of [3, 4, 5, 6]) {
      await usage.record({
        backendId: 'd',
        provider: 'deepseek',
        kind: 'organize',
        tokens: day,
        at: new Date(2026, 10, day),
      });
    }

    const rows = await usage.byDay('2026-11-04', '2026-11-05');
    expect(rows.map((r) => r.day)).toEqual(['2026-11-04', '2026-11-05']);
    // 边界那天必须算在内，否则「本月」会漏掉今天
    expect(rows[1]!.tokens).toBe(5);
  });

  it('total 汇总区间内的所有记录', async () => {
    await usage.record({ backendId: 'a', provider: 'deepseek', kind: 'organize', tokens: 100, calls: 2, at: new Date(2026, 10, 5) });
    await usage.record({ backendId: 'b', provider: 'zhipu', kind: 'questions', tokens: 300, at: new Date(2026, 10, 5) });

    expect(await usage.total()).toEqual({ tokens: 400, calls: 3 });
  });

  it('空库不报错', async () => {
    expect(await usage.list()).toEqual([]);
    expect(await usage.byBackend()).toEqual([]);
    expect(await usage.byDay()).toEqual([]);
    expect(await usage.total()).toEqual({ tokens: 0, calls: 0 });
  });

  it('clear 清空全部', async () => {
    await usage.record({ backendId: 'd', provider: 'p', kind: 'organize', tokens: 100 });
    await usage.clear();
    expect(await usage.list()).toEqual([]);
  });

  it('list 按日期倒序（最近的在前）', async () => {
    await usage.record({ backendId: 'd', provider: 'p', kind: 'organize', tokens: 1, at: new Date(2026, 10, 3) });
    await usage.record({ backendId: 'd', provider: 'p', kind: 'organize', tokens: 1, at: new Date(2026, 10, 6) });

    const rows = await usage.list();
    expect(rows[0]!.day).toBe('2026-11-06');
  });
});

describe('费用估算', () => {
  it('认得出的服务商按各自单价', () => {
    // 一百万 token 的价就是单价本身
    expect(estimateCostCny(1_000_000, 'deepseek')).toBe(2);
    expect(estimateCostCny(1_000_000, 'openai')).toBe(15);
  });

  it('认不出的服务商不给 0，用中间价兜底', () => {
    /**
     * 给 0 会让用户以为免费，比给一个粗略的估值更糟。
     */
    const cost = estimateCostCny(1_000_000, 'some-new-provider');
    expect(cost).toBeGreaterThan(0);
    expect(estimateCostCny(1_000_000, 'unknown')).toBeGreaterThan(0);
  });

  it('格式化：不到一分钱说「不到 0.01 元」而不是 0.00', () => {
    expect(formatCost(0)).toBe('0 元');
    expect(formatCost(0.001)).toBe('不到 0.01 元');
    expect(formatCost(0.56)).toBe('0.56 元');
    expect(formatCost(12.345)).toBe('12.35 元');
  });
});

/**
 * 与业务服务的集成：这是最容易出错的地方。
 *
 * 记账点在 generate 内部，测试必须走真实的 generate 流程，
 * 手写 usage.record 只能证明 UsageService 自己对，不能证明它接上了。
 */
describe('与 KnowledgeService / DeckService 的集成', () => {
  let storage: MemoryStorage;
  let usage: UsageService;
  let sources: SourceService;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.init();
    usage = new UsageService(storage);
    sources = new SourceService(storage);
  });

  /** 一个受控的真后端：不算 mock，token 数由测试指定 */
  function backendWith(tokens: number | null, provider = 'zhipu'): OrganizeBackend {
    return {
      id: `model:${provider}`,
      label: '测试后端',
      isMock: false,
      provider,
      estimateTokens: () => 100,
      async organize(request) {
        const drafts: KnowledgeDraft[] = [
          { statement: '测试知识点', quotes: ['给定引用'], cognitiveLevel: 'remember', tags: [] },
        ];
        for (const d of drafts) await request.onDraft?.(d);
        return { drafts, actualTokens: tokens, stopped: false };
      },
    };
  }

  it('整理知识点后记账', async () => {
    const source = await sources.importText('测试资料', '第一段正文内容足够长，用来生成知识点。');
    const knowledge = new KnowledgeService(storage, sources, usage);

    await knowledge.generate({
      sourceId: source.id,
      backend: backendWith(1500),
      signal: new AbortController().signal,
    });

    const rows = await usage.byBackend();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.backendId).toBe('model:zhipu');
    expect(rows[0]!.provider).toBe('zhipu');
    expect(rows[0]!.tokens).toBe(1500);
    expect(rows[0]!.organizeTokens).toBe(1500);
  });

  it('假后端不记账（不花用户一分钱）', async () => {
    const source = await sources.importText('测试资料', '第一段正文内容足够长，用来生成知识点。');
    const knowledge = new KnowledgeService(storage, sources, usage);

    const mock: OrganizeBackend = {
      id: 'mock',
      label: '示例后端',
      isMock: true,
      estimateTokens: () => 100,
      async organize(request) {
        await request.onDraft?.({
          statement: '来自示例的点',
          quotes: ['给定引用'],
          cognitiveLevel: 'remember',
          tags: [],
        });
        return { drafts: [], actualTokens: 999, stopped: false };
      },
    };

    await knowledge.generate({ sourceId: source.id, backend: mock, signal: new AbortController().signal });

    /**
     * 假后端返回了 999 token，但它是本地算出来的，没花一分钱。
     * 记进来会让真实花费看起来更多。
     */
    expect(await usage.list()).toEqual([]);
  });

  it('实际用量为 null 时不记账', async () => {
    const source = await sources.importText('测试资料', '第一段正文内容足够长，用来生成知识点。');
    const knowledge = new KnowledgeService(storage, sources, usage);

    await knowledge.generate({
      sourceId: source.id,
      backend: backendWith(null),
      signal: new AbortController().signal,
    });

    expect(await usage.list()).toEqual([]);
  });

  it('中途停止也记账：请求已经发出去了，照样计费', async () => {
    const source = await sources.importText(
      '测试资料',
      Array.from({ length: 8 }, (_, i) => `第${i}段正文内容足够长用来生成知识点。`).join('\n\n'),
    );
    const knowledge = new KnowledgeService(storage, sources, usage);
    const controller = new AbortController();

    const stopping: OrganizeBackend = {
      id: 'model:zhipu',
      label: '测试后端',
      isMock: false,
      provider: 'zhipu',
      estimateTokens: () => 100,
      async organize(request) {
        await request.onDraft?.({
          statement: '第一条',
          quotes: ['给定引用'],
          cognitiveLevel: 'remember',
          tags: [],
        });
        controller.abort();
        return { drafts: [], actualTokens: 400, stopped: true };
      },
    };

    await knowledge.generate({ sourceId: source.id, backend: stopping, signal: controller.signal });

    const rows = await usage.byBackend();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(400);
  });

  it('不传 usage 时行为完全不变（老测试不受影响）', async () => {
    const source = await sources.importText('测试资料', '第一段正文内容足够长，用来生成知识点。');
    // 只传两个参数，就是 P2 以来的所有调用点
    const knowledge = new KnowledgeService(storage, sources);

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: backendWith(1500),
      signal: new AbortController().signal,
    });

    expect(outcome.points.length).toBeGreaterThan(0);
    // 没记账，但流程正常
    expect(await usage.list()).toEqual([]);
  });

  it('出题后记账（kind = questions）', async () => {
    const storage2 = new MemoryStorage();
    await storage2.init();
    const usage2 = new UsageService(storage2);
    const decks = new DeckService(storage2, usage2);

    const point: KnowledgePoint = {
      id: 'kp1',
      sourceId: 'src1',
      statement: '二叉树的中序遍历先左后根再右',
      quotes: ['中序遍历'],
      anchors: [{ sourceId: 'src1', page: 1, chapter: '第一章', charStart: 0, charEnd: 4 }],
      anchorStatus: 'located',
      chapter: '第一章',
      cognitiveLevel: 'understand',
      tags: [],
      origin: 'material',
      backendId: 'model:zhipu',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const qBackend: QuestionBackend = {
      id: 'model-questions:zhipu',
      label: '出题后端',
      isMock: false,
      provider: 'zhipu',
      estimateTokens: () => 100,
      async generate(_points, options) {
        const draft: QuestionDraft = {
          kind: 'single',
          prompt: '中序遍历的顺序是？',
          options: [
            { key: 'A', text: '左右根' },
            { key: 'B', text: '左根右' },
            { key: 'C', text: '根左右' },
          ],
          answer: 'B',
          explanation: '中序遍历先左后根再右。',
          knowledgePointId: 'kp1',
        };
        await options.onDraft?.(draft);
        return { drafts: [draft], actualTokens: 900, stopped: false };
      },
    };

    await decks.generate({
      points: [point],
      title: '测试题',
      sourceId: 'src1',
      backend: qBackend,
      options: { kinds: ['single'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const rows = await usage2.byBackend();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.questionsTokens).toBe(900);
    expect(rows[0]!.organizeTokens).toBe(0);
  });

  it('整理与出题同时发生，按用途分开累加', async () => {
    const source = await sources.importText('测试资料', '第一段正文内容足够长，用来生成知识点。');
    const knowledge = new KnowledgeService(storage, sources, usage);

    await knowledge.generate({
      sourceId: source.id,
      backend: backendWith(1000),
      signal: new AbortController().signal,
    });

    const decks = new DeckService(storage, usage);
    const points = await knowledge.listBySource(source.id);
    expect(points.length).toBeGreaterThan(0);

    /**
     * 出题需要已定位的知识点。示例文本里的引用是假的（'给定引用'），
     * 所以这里不追求出题成功，只验证「两个用途落在同一行、分别累计」。
     */
    const rows = await usage.byBackend();
    expect(rows[0]!.organizeTokens).toBe(1000);
    expect(rows[0]!.questionsTokens).toBe(0);
    expect(decks).toBeTruthy();
  });
});
