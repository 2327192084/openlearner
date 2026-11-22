import { describe, expect, it } from 'vitest';
import { ResourceService } from './resource-service.ts';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LibraryService } from './library.ts';

/**
 * 外部资源的存储服务（2026-11-22，方案第 7 步）。
 *
 * 这组测试守三条**用户确认过的行为**：
 *  1. 表单只有网址必填，坏输入挡在服务层（不只靠界面）
 *  2. 资料被删 → 资源跟着删
 *  3. 小节被删 / 路线重排 → 挂在小节上的资源**回到资料级，不丢**
 */

/** 造一个跑在内存存储上的 LibraryService */
async function makeLib(): Promise<LibraryService> {
  const storage = new MemoryStorage();
  await storage.init();
  /* LibraryService 只接 storage —— 构造签名是 (storage) */
  return new LibraryService(storage);
}

async function makeService(): Promise<{ svc: ResourceService; lib: LibraryService }> {
  const lib = await makeLib();
  return { svc: new ResourceService(lib), lib };
}

describe('ResourceService.add：校验在服务层也做一遍', () => {
  it('正常网址能加进去', async () => {
    const { svc } = await makeService();
    const r = await svc.add({ sourceId: 'src-1', url: 'https://a.com/x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resource.url).toBe('https://a.com/x');
      expect(r.resource.source).toBe('manual');
    }
  });

  it('⚠️ `javascript:` 被挡（不经过界面表单也挡得住）', async () => {
    /*
     * 界面表单会先校验，但**规划预搜/导入**那条路径不经过表单。
     * 服务层自己挡一遍，两层信任级别不同，不是重复。
     */
    const { svc } = await makeService();
    const r = await svc.add({ sourceId: 's', url: 'javascript:alert(1)' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('可执行脚本');
  });

  it('`file://` 被挡', async () => {
    const { svc } = await makeService();
    const r = await svc.add({ sourceId: 's', url: 'file:///C:/x.docx' });
    expect(r.ok).toBe(false);
  });

  it('重复网址被挡', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/x' });
    const r = await svc.add({ sourceId: 's', url: 'https://a.com/x/' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('已经在列表里');
  });

  it('不同资料可以用同一个网址（去重按资料分开）', async () => {
    const { svc } = await makeService();
    expect((await svc.add({ sourceId: 'a', url: 'https://x.com/1' })).ok).toBe(true);
    expect((await svc.add({ sourceId: 'b', url: 'https://x.com/1' })).ok).toBe(true);
  });

  it('坏输入返回 ok:false 而不是抛错（坏输入是正常用户行为）', async () => {
    const { svc } = await makeService();
    await expect(svc.add({ sourceId: 's', url: '乱写的' })).resolves.toMatchObject({ ok: false });
  });
});

describe('ResourceService.listFor：按资料 / 按小节过滤', () => {
  it('不给 sectionId 时返回这份资料全部', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    await svc.add({ sourceId: 's', url: 'https://a.com/2', sectionId: 'sec-1' });
    expect(await svc.listFor('s')).toHaveLength(2);
  });

  it('给 sectionId 只返回这一节的', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1', sectionId: 'sec-1' });
    await svc.add({ sourceId: 's', url: 'https://a.com/2', sectionId: 'sec-2' });
    const list = await svc.listFor('s', 'sec-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toContain('/1');
  });

  it('sectionId=null 只返回资料级的', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    await svc.add({ sourceId: 's', url: 'https://a.com/2', sectionId: 'sec-1' });
    const list = await svc.listFor('s', null);
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toContain('/1');
  });

  it('没有资源的资料返回空数组（不是 undefined）', async () => {
    const { svc } = await makeService();
    expect(await svc.listFor('nope')).toEqual([]);
  });
});

describe('ResourceService.remove', () => {
  it('删掉一条', async () => {
    const { svc } = await makeService();
    const added = await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const next = await svc.remove('s', added.resource.id);
    expect(next['s']).toBeUndefined();
  });

  it('⚠️ 删空了就把键去掉（别在库里留空数组）', async () => {
    const { svc, lib } = await makeService();
    const added = await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    if (added.ok) await svc.remove('s', added.resource.id);
    const st = await lib.getSettings();
    const raw = (st as unknown as { sourceResources?: Record<string, unknown> }).sourceResources;
    expect(raw?.['s']).toBeUndefined();
  });

  it('删不存在的 id 不崩', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    await expect(svc.remove('s', 'nope')).resolves.toBeDefined();
  });
});

describe('⚠️ reparentOrphans：小节删了资源不能丢（方案 7.6）', () => {
  /**
   * 用户确认：「路线重排 → 挂在小节上的资源回到资料级，不丢」。
   *
   * AI 重排一次，小节 id 全变了。如果按 id 级联删资源，
   * 用户自己粘的链接就没了 —— 那是他手动的劳动成果。
   */
  it('挂在不存在的节上 → 回到资料级（segmentId 变 null）', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1', sectionId: 'sec-gone' });

    const moved = await svc.reparentOrphans('s', new Set(['sec-alive']));
    expect(moved).toBe(1);

    const list = await svc.listFor('s');
    expect(list).toHaveLength(1);
    expect(list[0]!.sectionId).toBeNull();
  });

  it('挂在还存在的节上 → 不动', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1', sectionId: 'sec-alive' });

    const moved = await svc.reparentOrphans('s', new Set(['sec-alive']));
    expect(moved).toBe(0);

    const list = await svc.listFor('s');
    expect(list[0]!.sectionId).toBe('sec-alive');
  });

  it('本来就资料级的资源不受影响', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1' });
    expect(await svc.reparentOrphans('s', new Set())).toBe(0);
  });

  it('返回搬迁条数（界面要如实告知）', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1', sectionId: 'gone-1' });
    await svc.add({ sourceId: 's', url: 'https://a.com/2', sectionId: 'gone-2' });
    await svc.add({ sourceId: 's', url: 'https://a.com/3', sectionId: 'alive' });
    expect(await svc.reparentOrphans('s', new Set(['alive']))).toBe(2);
  });
});

describe('⚠️ pruneForMissingSources：资料删了资源跟着删', () => {
  it('指向不存在资料的资源被清掉，并返回清掉的条数', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 'alive', url: 'https://a.com/1' });
    await svc.add({ sourceId: 'deleted', url: 'https://b.com/2' });

    const removed = await svc.pruneForMissingSources(new Set(['alive']));
    expect(removed).toBe(1);

    expect(await svc.listFor('deleted')).toEqual([]);
    expect(await svc.listFor('alive')).toHaveLength(1);
  });

  it('全部资料都还在时什么都不动', async () => {
    const { svc } = await makeService();
    await svc.add({ sourceId: 'a', url: 'https://a.com/1' });
    expect(await svc.pruneForMissingSources(new Set(['a']))).toBe(0);
  });

  it('没有资源时返回 0，不崩', async () => {
    const { svc } = await makeService();
    expect(await svc.pruneForMissingSources(new Set())).toBe(0);
  });
});

describe('持久化：写进去读得出来（刷新页面/重启不丢）', () => {
  it('新开一个 service 读同一个库，资源还在', async () => {
    const { svc, lib } = await makeService();
    await svc.add({ sourceId: 's', url: 'https://a.com/1', sectionId: 'sec-1' });

    /* 同一份 storage 换一个 service 实例读 */
    const svc2 = new ResourceService(lib);
    const list = await svc2.listFor('s');
    expect(list).toHaveLength(1);
    expect(list[0]!.sectionId).toBe('sec-1');
  });

  it('坏数据（库里被手改过）读出来不崩', async () => {
    const { lib } = await makeService();
    await lib.saveSettings({
      sourceResources: { s: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.com' }] },
    } as never);

    const svc = new ResourceService(lib);
    const list = await svc.listFor('s');
    /* 坏的那条被归一化丢掉，好的留下 */
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toContain('ok.com');
  });
});