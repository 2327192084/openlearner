import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { FlashcardService } from './flashcards.ts';
import type { KnowledgePoint } from './model.ts';

/**
 * 记忆闪卡（2026-11-10）。
 *
 * 这组测试守三件事：
 *  1. 引用知识点、不复制内容（知识点改名后闪卡能标出「过期」）
 *  2. 同一知识点不重复建卡
 *  3. 删知识点时闪卡跟着删，并如实报告删了几张
 */

function point(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp1',
    statement: '线性时不变系统的定义',
    chapter: '第1章',
    cognitiveLevel: 'remember',
    tags: ['1.1 系统'],
    anchors: [],
    quotes: ['同时满足叠加性与时不变性的系统'],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: 'src1',
    backendId: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...over,
  } as KnowledgePoint;
}

async function setup(): Promise<{ storage: MemoryStorage; svc: FlashcardService }> {
  const storage = new MemoryStorage();
  await storage.init();
  return { storage, svc: new FlashcardService(storage) };
}

describe('建卡', () => {
  it('从知识点建卡，frontText 取 statement', async () => {
    const { svc } = await setup();
    const p = point();
    const card = await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);

    expect(card).not.toBeNull();
    expect(card!.frontText).toBe('线性时不变系统的定义');
    expect(card!.sourceId).toBe('src1');
    expect(card!.origin).toBe('user');
  });

  it('可以指定 frontText 覆盖默认值', async () => {
    const { svc } = await setup();
    const p = point();
    const card = await svc.add(
      { knowledgePointId: p.id, frontText: '自己写的正面', origin: 'user' },
      [p],
    );
    expect(card!.frontText).toBe('自己写的正面');
  });

  it('同一知识点不重复建卡', async () => {
    /*
     * 用户可能先手动加过某条，又让 AI 挑了一遍 ——
     * 不该出现两张一模一样的卡。
     */
    const { svc } = await setup();
    const p = point();
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);
    const second = await svc.add({ knowledgePointId: p.id, origin: 'ai' }, [p]);
    expect(second).toBeNull();
    expect(await svc.list()).toHaveLength(1);
  });

  it('批量建卡时自动跳过已存在的', async () => {
    const { svc } = await setup();
    const a = point({ id: 'a', statement: 'A 点' });
    const b = point({ id: 'b', statement: 'B 点' });
    const c = point({ id: 'c', statement: 'C 点' });

    await svc.add({ knowledgePointId: 'a', origin: 'user' }, [a, b, c]);
    const created = await svc.addMany(
      [
        { knowledgePointId: 'a', origin: 'ai' },
        { knowledgePointId: 'b', origin: 'ai' },
        { knowledgePointId: 'c', origin: 'ai' },
      ],
      [a, b, c],
    );
    expect(created).toHaveLength(2);
    expect(created.map((x) => x.knowledgePointId).sort()).toEqual(['b', 'c']);
  });

  it('知识点不存在时不建卡（不造悬空引用）', async () => {
    const { svc } = await setup();
    const card = await svc.add({ knowledgePointId: '不存在', origin: 'ai' }, []);
    expect(card).toBeNull();
  });

  it('statement 为空时不建卡（没有正面的卡没意义）', async () => {
    const { svc } = await setup();
    const p = point({ statement: '   ' });
    const card = await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);
    expect(card).toBeNull();
  });
});

describe('过期标记', () => {
  it('知识点还在且表述未变 → 不过期', async () => {
    const { storage, svc } = await setup();
    const p = point();
    await storage.put('knowledgePoints', p);
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);

    const views = await svc.listWithPoints();
    expect(views[0]!.stale).toBe(false);
    expect(views[0]!.point).not.toBeNull();
  });

  it('知识点被删 → 标过期，但 frontText 仍能显示', async () => {
    /*
     * 这是「冗余存 frontText」的意义所在：
     * 翻开一张卡不该是空白，而是「这句话 + 原知识点已删除」。
     */
    const { storage, svc } = await setup();
    const p = point();
    await storage.put('knowledgePoints', p);
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);

    await storage.remove('knowledgePoints', p.id);

    const views = await svc.listWithPoints();
    expect(views[0]!.stale).toBe(true);
    expect(views[0]!.point).toBeNull();
    expect(views[0]!.card.frontText).toBe('线性时不变系统的定义');
  });

  it('知识点表述改了 → 标过期（用户可能在背旧说法）', async () => {
    const { storage, svc } = await setup();
    const p = point();
    await storage.put('knowledgePoints', p);
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);

    await storage.put('knowledgePoints', { ...p, statement: '改过的表述' });

    const views = await svc.listWithPoints();
    expect(views[0]!.stale).toBe(true);
    /* 闪卡上仍是建卡时那句话 —— 不跟着变，这样才看得出差异 */
    expect(views[0]!.card.frontText).toBe('线性时不变系统的定义');
  });
});

describe('删除', () => {
  it('删单张', async () => {
    const { svc } = await setup();
    const p = point();
    const card = await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);
    expect(await svc.remove(card!.id)).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  it('删不存在的返回 false（不抛错）', async () => {
    const { svc } = await setup();
    expect(await svc.remove('nope')).toBe(false);
  });

  it('删知识点时连带删闪卡，并报告删了几张', async () => {
    /*
     * 报告张数很重要：删知识点时静默带走几张闪卡，
     * 用户会觉得东西莫名少了。
     */
    const { svc } = await setup();
    const a = point({ id: 'a' });
    const b = point({ id: 'b' });
    await svc.addMany([
      { knowledgePointId: 'a', origin: 'user' },
      { knowledgePointId: 'b', origin: 'user' },
    ], [a, b]);

    const removed = await svc.removeForPoint('a');
    expect(removed).toBe(1);
    expect(await svc.list()).toHaveLength(1);
  });

  it('删没有闪卡的知识点返回 0', async () => {
    const { svc } = await setup();
    expect(await svc.removeForPoint('不存在')).toBe(0);
  });
});

describe('其它', () => {
  it('hasForPoint 判断是否已加过', async () => {
    const { svc } = await setup();
    const p = point();
    expect(await svc.hasForPoint(p.id)).toBe(false);
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);
    expect(await svc.hasForPoint(p.id)).toBe(true);
  });

  it('setBackNote 能加也清掉备注', async () => {
    const { svc } = await setup();
    const card = await svc.add({ knowledgePointId: 'kp1', origin: 'user' }, [point()]);
    const withNote = await svc.setBackNote(card!.id, '记住这条');
    expect(withNote!.backNote).toBe('记住这条');

    const cleared = await svc.setBackNote(card!.id, '   ');
    expect(cleared!.backNote).toBeNull();
  });

  it('listBySource 按资料筛', async () => {
    const { svc } = await setup();
    await svc.addMany(
      [
        { knowledgePointId: 'a', origin: 'user' },
        { knowledgePointId: 'b', origin: 'user' },
      ],
      [point({ id: 'a', sourceId: 's1' }), point({ id: 'b', sourceId: 's2' })],
    );
    expect(await svc.listBySource('s1')).toHaveLength(1);
  });

  it('按创建时间倒序（新加的在前）', async () => {
    const { storage, svc } = await setup();
    const p = point();
    await storage.put('flashcards', {
      id: 'fc_old', knowledgePointId: 'x', frontText: 'old', backNote: null,
      origin: 'user', sourceId: null, createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    await svc.add({ knowledgePointId: p.id, origin: 'user' }, [p]);

    const list = await svc.list();
    expect(list[0]!.frontText).toBe('线性时不变系统的定义');
  });
});
