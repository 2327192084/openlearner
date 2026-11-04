import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeService } from './service.ts';
import { MockBackend } from './mock-backend.ts';
import { SourceService } from '../sources.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { KnowledgeDraft } from './backend-types.ts';
import type { Source } from '../model.ts';

/**
 * 知识点服务测试。
 *
 * 对应计划书 P2「算做完」：
 *  - 一份真实课件 → 得到一批知识点，抽查任意一条，点「看原文」落到正确页
 *  - 改一条知识点，保存后再打开还在
 *  - 生成到一半停止，已得的结果不丢
 *  - 用假后端（固定返回）也能跑通整个流程
 *  - 指认不到原文位置的条目单独标出来，**不要自动填一个位置上去**
 */

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

let storage: MemoryStorage;
let sources: SourceService;
let knowledge: KnowledgeService;
let source: Source;

beforeEach(async () => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
  knowledge = new KnowledgeService(storage, sources);
  // 用真实的 PDF fixture，走完整的解析链路
  source = await sources.importBuffer('数据结构复习.pdf', fixture('course.pdf'));
});

/** 立即完成的后端，去掉人为延迟让测试跑得快 */
function fastBackend() {
  return new MockBackend(0);
}

describe('用假后端跑通全流程', () => {
  it('能产出知识点，且每条都定位成功', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    expect(outcome.points.length).toBeGreaterThan(0);
    expect(outcome.run.status).toBe('completed');

    // 假后端摘的是原文句子，所以应当全部能定位
    const located = outcome.points.filter((p) => p.anchorStatus === 'located');
    expect(located.length).toBe(outcome.points.length);

    for (const point of outcome.points) {
      expect(point.anchors.length).toBeGreaterThan(0);
      expect(point.sourceId).toBe(source.id);
      expect(point.backendId).toBe('mock');
    }
  });

  it('生成的知识点与原文逐字对得上（抽查「点回原文」）', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const segments = await sources.getSegments(source.id);

    // 抽查前 3 条，逐条验证：按 anchor 切片，结果里必须含它自己的引用
    for (const point of outcome.points.slice(0, 3)) {
      const anchor = point.anchors[0];
      const seg = segments.find((s) => s.page === anchor.page)!;

      expect(seg).toBeDefined();
      const sliced = seg.text.slice(anchor.charStart!, anchor.charEnd!);
      const quote = point.quotes[0];

      // 切片出来的内容必须与引用一致（空白归一后）
      const norm = (s: string) => s.replace(/\s+/g, '');
      expect(norm(sliced)).toBe(norm(quote));
    }
  });

  it('产出的知识点 page 与真实内容所在页一致', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const segments = await sources.getSegments(source.id);
    const norm = (s: string) => s.replace(/\s+/g, '');

    for (const point of outcome.points) {
      const anchor = point.anchors[0];
      const seg = segments.find((s) => s.page === anchor.page)!;

      // 用锚点偏移切片，再与引用做「去空白」比较。
      // 早先这里是拿归一化后的前 10 字去 seg.text 里 includes，
      // 那是错的：归一化把换行换成了空格，原文里没有那个空格，必然失败。
      // 用偏移切片才是真正验证「位置对不对」。
      const sliced = seg.text.slice(anchor.charStart!, anchor.charEnd!);
      expect(norm(sliced)).toBe(norm(point.quotes[0]));
    }
  });

  it('记录预计与实际用量（P2 要求生成前后都显示）', async () => {
    const segments = await sources.getSegments(source.id);
    const backend = fastBackend();

    const estimated = knowledge.estimate(segments, backend);
    expect(estimated).toBeGreaterThan(0);

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: new AbortController().signal,
    });

    expect(outcome.run.estimatedTokens).toBe(estimated);
    expect(outcome.run.actualTokens).toBeGreaterThan(0);
  });
});

describe('定位失败：单独标出，绝不猜位置', () => {
  it('模型给了原文里没有的引用时，标为 unlocated 且 anchors 为空', async () => {
    const backend = {
      id: 'bad',
      label: '故意给错引用的后端',
      isMock: true,
      estimateTokens: () => 100,
      // 契约要求：逐条 await onDraft，让它定位并落库
      organize: async (req: {
        onDraft?: (d: KnowledgeDraft) => void | Promise<void>;
      }) => {
        const draft = {
          statement: '一条找不到出处的知识点',
          quotes: ['这句话在教材里根本不存在啊'],
          cognitiveLevel: 'understand' as const,
          tags: [],
        };
        await req.onDraft?.(draft);
        return { drafts: [draft], actualTokens: 100, stopped: false };
      },
    };

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: new AbortController().signal,
    });

    const point = outcome.points[0];
    expect(point.anchorStatus).toBe('unlocated');
    // 核心断言：不能自动填一个位置上去
    expect(point.anchors).toEqual([]);
    expect(outcome.run.unlocatedCount).toBe(1);
  });

  it('定位失败的条目不阻断其他条目', async () => {
    const backend = {
      id: 'mixed',
      label: '好坏混合',
      isMock: true,
      estimateTokens: () => 100,
      organize: async (req: {
        onDraft?: (d: KnowledgeDraft) => void | Promise<void>;
      }) => {
        const drafts = [
          {
            statement: '好的这条',
            quotes: ['数据结构研究的是数据元素之间的关系'],
            cognitiveLevel: 'remember' as const,
            tags: [],
          },
          {
            statement: '坏的这条',
            quotes: ['完全不存在的内容在这里'],
            cognitiveLevel: 'remember' as const,
            tags: [],
          },
        ];
        for (const d of drafts) await req.onDraft?.(d);
        return { drafts, actualTokens: 100, stopped: false };
      },
    };

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: new AbortController().signal,
    });

    expect(outcome.points).toHaveLength(2);
    expect(outcome.points[0].anchorStatus).toBe('located');
    expect(outcome.points[1].anchorStatus).toBe('unlocated');
  });
});

describe('中途停止：已产出的结果不丢', () => {
  it('停止后保留已生成的条目，状态标为 stopped', async () => {
    const controller = new AbortController();
    // 用带延迟的后端，才有机会在中间停下
    const backend = new MockBackend(30);

    const promise = knowledge.generate({
      sourceId: source.id,
      backend,
      signal: controller.signal,
      onProgress: (p) => {
        // 产出到第 2 条就喊停
        if (p.produced >= 2) controller.abort();
      },
    });

    const outcome = await promise;

    expect(outcome.run.status).toBe('stopped');
    // 关键：停止之前产出的必须还在库里
    const stored = await knowledge.listBySource(source.id);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBe(outcome.points.length);
  });

  it('停止后已落库的知识点仍然可读、可定位', async () => {
    const controller = new AbortController();
    const backend = new MockBackend(20);

    await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.produced >= 1) controller.abort();
      },
    });

    const stored = await knowledge.listBySource(source.id);
    expect(stored.length).toBeGreaterThan(0);
    // 已产出的条目定位信息必须完整，不能是半截
    for (const kp of stored) {
      if (kp.anchorStatus === 'located') {
        expect(kp.anchors.length).toBeGreaterThan(0);
        expect(kp.anchors[0].page).toBeGreaterThan(0);
        expect(kp.anchors[0].charStart).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('编辑与持久化', () => {
  it('改一条知识点，重新读取后还在（P2 验收项）', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const target = outcome.points[0];
    const updated = await knowledge.update(target.id, {
      statement: '人工修改后的表述',
      cognitiveLevel: 'apply',
      tags: ['重点'],
    });

    expect(updated!.statement).toBe('人工修改后的表述');
    expect(updated!.cognitiveLevel).toBe('apply');
    expect(updated!.tags).toEqual(['重点']);

    // 模拟"关掉再打开"：换一个 service 实例读同一份存储
    const fresh = new KnowledgeService(storage, sources);
    const reread = await fresh.get(target.id);
    expect(reread!.statement).toBe('人工修改后的表述');
    expect(reread!.cognitiveLevel).toBe('apply');
    // 位置信息不能被编辑搞丢
    expect(reread!.anchors).toEqual(target.anchors);
  });

  it('删除一条知识点', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const target = outcome.points[0];
    await knowledge.remove(target.id);

    expect(await knowledge.get(target.id)).toBeNull();
    const rest = await knowledge.listBySource(source.id);
    expect(rest).toHaveLength(outcome.points.length - 1);
  });

  it('重新生成会替换旧结果，不会堆叠重复条目', async () => {
    const first = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const second = await knowledge.generate({
      sourceId: source.id,
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    const stored = await knowledge.listBySource(source.id);
    // 条数与第二次生成一致，说明旧的被清掉了
    expect(stored).toHaveLength(second.points.length);
    expect(stored.map((s) => s.id)).not.toContain(first.points[0].id);
  });
});

describe('人工重新指定位置（校对界面）', () => {
  it('给一条定位失败的条目补上能命中的引用，状态转为 located', async () => {
    const backend = {
      id: 'bad',
      label: 'bad',
      isMock: true,
      estimateTokens: () => 100,
      organize: async (req: {
        onDraft?: (d: KnowledgeDraft) => void | Promise<void>;
      }) => {
        const draft = {
          statement: '待人工修',
          quotes: ['不存在的引用内容'],
          cognitiveLevel: 'understand' as const,
          tags: [],
        };
        await req.onDraft?.(draft);
        return { drafts: [draft], actualTokens: 100, stopped: false };
      },
    };

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: new AbortController().signal,
    });
    const point = outcome.points[0];
    expect(point.anchorStatus).toBe('unlocated');

    // 人工改成一段真实存在的原文
    const fixed = await knowledge.reanchor(point.id, {
      quote: '数据结构研究的是数据元素之间的关系',
    });

    expect(fixed!.anchorStatus).toBe('located');
    expect(fixed!.anchors[0].page).toBe(1);
  });

  it('人工判定「这条没有出处」后不再算作待处理', async () => {
    const backend = {
      id: 'bad',
      label: 'bad',
      isMock: true,
      estimateTokens: () => 100,
      organize: async (req: {
        onDraft?: (d: KnowledgeDraft) => void | Promise<void>;
      }) => {
        const draft = {
          statement: '总结性的话，没有具体出处',
          quotes: ['不存在'],
          cognitiveLevel: 'understand' as const,
          tags: [],
        };
        await req.onDraft?.(draft);
        return { drafts: [draft], actualTokens: 100, stopped: false };
      },
    };

    const outcome = await knowledge.generate({
      sourceId: source.id,
      backend,
      signal: new AbortController().signal,
    });

    const waived = await knowledge.reanchor(outcome.points[0].id, { waive: true });
    expect(waived!.anchorStatus).toBe('waived');
  });
});

describe('页码范围', () => {
  it('只整理指定页范围的内容', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      pageRange: { from: 2, to: 2 },
      backend: fastBackend(),
      signal: new AbortController().signal,
    });

    expect(outcome.points.length).toBeGreaterThan(0);
    // 所有命中都应当落在第 2 页
    for (const kp of outcome.points) {
      if (kp.anchorStatus === 'located') {
        expect(kp.anchors[0].page).toBe(2);
      }
    }
  });

  it('范围写反了也能正常工作（自动纠正起止）', async () => {
    const outcome = await knowledge.generate({
      sourceId: source.id,
      pageRange: { from: 3, to: 1 },
      backend: fastBackend(),
      signal: new AbortController().signal,
    });
    expect(outcome.points.length).toBeGreaterThan(0);
  });
});

describe('异常处理', () => {
  it('资料不存在时给出明确提示', async () => {
    await expect(
      knowledge.generate({
        sourceId: '不存在',
        backend: fastBackend(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/资料不存在/);
  });

  it('扫描件没有正文时说明原因', async () => {
    const scanned = await sources.importBuffer('扫描件.pdf', fixture('scanned.pdf'));

    await expect(
      knowledge.generate({
        sourceId: scanned.id,
        backend: fastBackend(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/没有文字层/);
  });

  it('后端抛错时记录失败状态并保留已产出', async () => {
    let calls = 0;
    const backend = {
      id: 'flaky',
      label: 'flaky',
      isMock: true,
      estimateTokens: () => 100,
      organize: async (req: {
        onDraft?: (d: KnowledgeDraft) => void | Promise<void>;
      }): Promise<never> => {
        calls += 1;
        void req;
        throw new Error('模拟网络错误');
      },
    };

    await expect(
      knowledge.generate({
        sourceId: source.id,
        backend,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/模拟网络错误/);

    // 失败也要留下记录，便于用户知道"这次为什么没成"
    const runs = await storage.getAll('generationRuns');
    const failed = runs.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toMatch(/模拟网络错误/);
  });
});
