import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { FlashcardService, backOf, draftFromPoint, sourceKindOf } from './flashcards.ts';
import type { Flashcard, KnowledgePoint } from './model.ts';

/**
 * 记忆闪卡服务（2026-11-14 按用户反馈重写）。
 *
 * ## 用户反馈原话
 *
 * > 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 * >  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 * >  不会因错题或是知识点的消失而消失。」
 *
 * 所以这组测试的重点从「引用的知识点还在不在」变成了
 * **「来源删了，卡片一个字都不许变」**。
 */

const point = (over: Partial<KnowledgePoint> = {}): KnowledgePoint =>
  ({
    id: 'kp1',
    sourceId: 's1',
    statement: '导数的定义',
    chapter: '第2章',
    ...over,
  }) as unknown as KnowledgePoint;

let storage: MemoryStorage;
let svc: FlashcardService;

beforeEach(() => {
  storage = new MemoryStorage();
  svc = new FlashcardService(storage);
});

describe('建卡：内容被抄进来，不是引用', () => {
  it('从知识点建卡时，正面就是那一刻的表述', async () => {
    const card = await svc.add(draftFromPoint(point()));
    expect(card?.frontText).toBe('导数的定义');
    expect(card?.sourceKind).toBe('point');
    expect(card?.sourceId2).toBe('kp1');
  });

  it('★ 知识点被删之后，卡片内容一个字都不变', async () => {
    await svc.add(draftFromPoint(point()));
    /* 模拟知识点被删（存储里没了） */
    await storage.remove('knowledgePoints', 'kp1');

    const views = await svc.listWithLabels();
    expect(views).toHaveLength(1);
    /* 正面照旧 —— 这是「独立」的核心 */
    expect(views[0]?.front).toBe('导数的定义');
    /* 而且**没有**任何「来源已删」的状态字段了 */
    expect(views[0]).not.toHaveProperty('stale');
  });

  it('用户自己写的卡（没有来源）也是合法的', async () => {
    const card = await svc.add({
      frontText: '自己记的一句话',
      backText: '自己的答案',
      origin: 'user',
    });
    expect(card?.frontText).toBe('自己记的一句话');
    expect(card?.backText).toBe('自己的答案');
    expect(card?.sourceKind).toBe('manual');
    expect(card?.sourceId2).toBeNull();
  });

  it('正面空白的卡被拒绝（翻开来是白的，用户会以为坏了）', async () => {
    expect(await svc.add({ frontText: '   ', origin: 'user' })).toBeNull();
  });

  it('正面相同的卡不重复建（那是真的重复）', async () => {
    await svc.add({ frontText: '同一句话', origin: 'user' });
    const second = await svc.add({ frontText: '同一句话', origin: 'user' });
    expect(second).toBeNull();
    expect(await svc.list()).toHaveLength(1);
  });

  it('★ 同一个知识点可以做成两张角度不同的卡（不再按知识点去重）', async () => {
    await svc.add(draftFromPoint(point()));
    const second = await svc.add({
      frontText: '导数的几何意义是什么？',
      backText: '切线斜率',
      sourceKind: 'point',
      sourceId2: 'kp1',
      origin: 'user',
    });
    expect(second).not.toBeNull();
    expect(await svc.list()).toHaveLength(2);
  });

  it('批量建卡时各自判重', async () => {
    const out = await svc.addMany([
      { frontText: 'A', origin: 'user' },
      { frontText: 'A', origin: 'user' },
      { frontText: 'B', origin: 'user' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('背面取值：backText → backNote（旧卡兼容）', () => {
  it('有新字段就用新字段', () => {
    const c = { frontText: 'x', backText: '新', backNote: '旧' } as unknown as Flashcard;
    expect(backOf(c)).toBe('新');
  });

  it('旧卡没有 backText 时回落到 backNote', () => {
    const c = { frontText: 'x', backText: undefined, backNote: '旧笔记' } as unknown as Flashcard;
    expect(backOf(c)).toBe('旧笔记');
  });

  it('两个都没有 → null（界面据此不显示背面那一行）', () => {
    const c = { frontText: 'x', backText: null, backNote: null } as unknown as Flashcard;
    expect(backOf(c)).toBeNull();
  });

  it('空字符串当没有', () => {
    const c = { frontText: 'x', backText: '   ', backNote: '' } as unknown as Flashcard;
    expect(backOf(c)).toBeNull();
  });
});

describe('来源类型推断（旧卡没有 sourceKind）', () => {
  it('有 knowledgePointId → point', () => {
    expect(sourceKindOf({ knowledgePointId: 'kp1' } as unknown as Flashcard)).toBe('point');
  });

  it('没有 → manual', () => {
    expect(sourceKindOf({} as unknown as Flashcard)).toBe('manual');
  });

  it('显式写了就听写了的', () => {
    expect(sourceKindOf({ sourceKind: 'wrong' } as unknown as Flashcard)).toBe('wrong');
  });
});

describe('改内容', () => {
  it('正面背面都能改', async () => {
    const card = await svc.add({ frontText: '旧正面', backText: '旧背面', origin: 'user' });
    const next = await svc.update(card!.id, { frontText: '新正面', backText: '新背面' });
    expect(next?.frontText).toBe('新正面');
    expect(next?.backText).toBe('新背面');
  });

  it('只改一面时另一面不动', async () => {
    const card = await svc.add({ frontText: '正面', backText: '背面', origin: 'user' });
    const next = await svc.update(card!.id, { backText: '改了背面' });
    expect(next?.frontText).toBe('正面');
    expect(next?.backText).toBe('改了背面');
  });

  it('不许把正面改成空', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user' });
    expect(await svc.update(card!.id, { frontText: '  ' })).toBeNull();
  });

  it('改不存在的卡返回 null', async () => {
    expect(await svc.update('nope', { frontText: 'x' })).toBeNull();
  });

  /*
   * 改归属（2026-11-24，用户要求「写完闪卡后再决定闪卡归属
   * 知识点类、错题类还是记忆类」）。
   */
  it('能改归属：记忆 → 知识点', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user', sourceKind: 'manual' });
    expect(sourceKindOf(card!)).toBe('manual');
    const next = await svc.update(card!.id, { sourceKind: 'point' });
    expect(sourceKindOf(next!)).toBe('point');
  });

  it('能改归属：记忆 → 错题', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user', sourceKind: 'manual' });
    const next = await svc.update(card!.id, { sourceKind: 'wrong' });
    expect(sourceKindOf(next!)).toBe('wrong');
  });

  it('不传 sourceKind 时归属不动（只改正面不该顺手改类）', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user', sourceKind: 'wrong' });
    const next = await svc.update(card!.id, { frontText: '改正面' });
    expect(sourceKindOf(next!)).toBe('wrong');
    expect(next?.frontText).toBe('改正面');
  });

  /*
   * ★ 关系断言：改归属**不能**动 sourceId2。
   *
   * sourceId2 是"这张卡原来是从哪抄来的"的线索。跟着 sourceKind 一起改，
   * 就会出现「卡片标成知识点、点进去却指向一道错题」——
   * 界面上说的一件事、数据里存的另一件事。
   */
  it('★ 改归属不动 sourceId2（来源线索仍是原来那个）', async () => {
    const card = await svc.add({
      frontText: '正面',
      origin: 'user',
      sourceKind: 'point',
      sourceId2: 'kp_original',
      knowledgePointId: 'kp_original',
    });
    expect(card?.sourceId2).toBe('kp_original');
    /* 数据层里 memory 仍叫 manual；界面上的 'memory' 由 sourceKindOfGroup 映射 */
    const next = await svc.update(card!.id, { sourceKind: 'manual' });
    expect(next?.sourceId2).toBe('kp_original');
    expect(next?.knowledgePointId).toBe('kp_original');
  });

  it('★ 改归属后卡片总数不变（update 不是写一张新卡）', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user' });
    const before = (await svc.list()).length;
    await svc.update(card!.id, { sourceKind: 'wrong' });
    expect((await svc.list()).length).toBe(before);
  });

  it('改过之后 updatedAt 变新，createdAt 不变', async () => {
    const card = await svc.add({ frontText: '正面', origin: 'user' });
    await new Promise((r) => setTimeout(r, 5));
    const next = await svc.update(card!.id, { frontText: '改了' });
    expect(next?.createdAt).toBe(card!.createdAt);
    expect(next!.updatedAt >= card!.updatedAt).toBe(true);
  });
});

describe('删除', () => {
  it('删掉就没了', async () => {
    const card = await svc.add({ frontText: '要删的', origin: 'user' });
    expect(await svc.remove(card!.id)).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  it('删不存在的返回 false', async () => {
    expect(await svc.remove('nope')).toBe(false);
  });

  it('删卡不影响知识点（卡片独立，删它不该动来源）', async () => {
    await storage.put('knowledgePoints', point());
    const card = await svc.add(draftFromPoint(point()));
    await svc.remove(card!.id);
    expect(await storage.get('knowledgePoints', 'kp1')).not.toBeNull();
  });
});

describe('按知识点查/删（知识点那一侧的操作）', () => {  it('hasForPoint 能认出从该知识点建的卡', async () => {
    await svc.add(draftFromPoint(point()));
    expect(await svc.hasForPoint('kp1')).toBe(true);
    expect(await svc.hasForPoint('kp2')).toBe(false);
  });

  it('removeForPoint 删掉该知识点的所有卡（可能多张）', async () => {
    await svc.add(draftFromPoint(point()));
    await svc.add({
      frontText: '第二张',
      sourceKind: 'point',
      sourceId2: 'kp1',
      origin: 'user',
    });
    expect(await svc.removeForPoint('kp1')).toBe(2);
    expect(await svc.list()).toHaveLength(0);
  });
});

describe('列表', () => {
  it('新建的排在前面', async () => {
    const a = await svc.add({ frontText: '早的', origin: 'user' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.add({ frontText: '晚的', origin: 'user' });
    const list = await svc.list();
    expect(list[0]?.id).toBe(b!.id);
    expect(list[1]?.id).toBe(a!.id);
  });

  it('来源标签由调用方注入（拿不到就是 null，不是错误）', async () => {
    await svc.add(draftFromPoint(point()));
    const withLabel = await svc.listWithLabels(() => '信号与系统 · 第2章');
    expect(withLabel[0]?.sourceLabel).toBe('信号与系统 · 第2章');

    const noLabel = await svc.listWithLabels(() => null);
    expect(noLabel[0]?.sourceLabel).toBeNull();
  });

  it('不传标签函数也能用（界面不需要来源时省一次查询）', async () => {
    await svc.add({ frontText: 'x', origin: 'user' });
    const views = await svc.listWithLabels();
    expect(views[0]?.sourceLabel).toBeNull();
  });
});

/**
 * 批量删（2026-11-23 晚新增）。
 *
 * 用户要求「每个资源右边加一个总的删除闪卡按钮」，所以有了 `removeMany`。
 * 与单卡 `remove` 的区别：**批量删进回收站**（误伤面积大，必须能还原）。
 * 进回收站那部分在 trash-wiring.test.ts 里验；这里验计数与不误伤。
 */
describe('removeMany：批量删（整组 / 整个文件夹）', () => {
  it('删指定的几张', async () => {
    const a = await svc.add({ frontText: 'a', origin: 'user' });
    const b = await svc.add({ frontText: 'b', origin: 'user' });
    const c = await svc.add({ frontText: 'c', origin: 'user' });
    expect(await svc.removeMany([a!.id, c!.id])).toBe(2);
    const left = await svc.list();
    expect(left.map((x) => x.id)).toEqual([b!.id]);
  });

  it('传空数组返回 0（别在上面白跑一次 getAll）', async () => {
    expect(await svc.removeMany([])).toBe(0);
  });

  it('id 有已经不存在的，只数真删掉的', async () => {
    const a = await svc.add({ frontText: 'a', origin: 'user' });
    expect(await svc.removeMany([a!.id, 'ghost1', 'ghost2'])).toBe(1);
    expect(await svc.list()).toHaveLength(0);
  });

  it('全都不存在 → 0，且不抛', async () => {
    expect(await svc.removeMany(['x', 'y'])).toBe(0);
  });

  it('重复 id 不重复计数、也不重复删', async () => {
    const a = await svc.add({ frontText: 'a', origin: 'user' });
    expect(await svc.removeMany([a!.id, a!.id, a!.id])).toBe(1);
    expect(await svc.list()).toHaveLength(0);
  });

  it('★ 没被点到的卡一张都不能少（关系断言：删前 = 删后 + 返回数）', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await svc.add({ frontText: `卡${i}`, origin: 'user' });
      ids.push(c!.id);
    }
    const before = (await svc.list()).length;
    const n = await svc.removeMany([ids[1], ids[4]]);
    const after = (await svc.list()).length;
    expect(before).toBe(6);
    expect(n).toBe(2);
    expect(before - n).toBe(after);
  });

  it('删卡不影响知识点（与单卡删同一条规则）', async () => {
    await storage.put('knowledgePoints', point());
    const card = await svc.add(draftFromPoint(point()));
    await svc.removeMany([card!.id]);
    expect(await storage.get('knowledgePoints', 'kp1')).not.toBeNull();
  });
});
