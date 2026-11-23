/**
 * 闪卡文件夹存储服务的单测（2026-11-23 晚）。
 *
 * 与纯逻辑的分工：那边验「规则算得对」，这边验「真的写进了 settings、
 * 下次读还在、删文件夹不删卡」。用 MemoryStorage 跑真 LibraryService。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LibraryService } from './library.ts';
import { FlashcardFolderService } from './flashcard-folder-service.ts';

let lib: LibraryService;
let svc: FlashcardFolderService;

beforeEach(async () => {
  const storage = new MemoryStorage();
  await storage.init();
  lib = new LibraryService(storage);
  svc = new FlashcardFolderService(lib);
});

describe('create', () => {
  it('建得出来、读得回来', async () => {
    const r = await svc.create('高数错题');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.folder.name).toBe('高数错题');
      expect(r.settings.folders).toHaveLength(1);
    }
    const again = await svc.loadAll();
    expect(again.folders.map((f) => f.name)).toEqual(['高数错题']);
  });

  it('重名被挡且不写盘', async () => {
    await svc.create('高数');
    const r = await svc.create('高数');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dup');
    expect((await svc.loadAll()).folders).toHaveLength(1);
  });

  it('空名字被挡', async () => {
    const r = await svc.create('  ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('建多个顺序保留（界面按这个顺序排）', async () => {
    for (const n of ['甲', '乙', '丙']) await svc.create(n);
    expect((await svc.loadAll()).folders.map((f) => f.name)).toEqual(['甲', '乙', '丙']);
  });
});

describe('rename', () => {
  it('改名生效、id 不变、原归属还在', async () => {
    const r = await svc.create('旧名');
    const id = r.ok ? r.folder.id : '';
    await svc.assign(['fc1'], id);

    const re = await svc.rename(id, '新名');
    expect(re.ok).toBe(true);
    const now = await svc.loadAll();
    expect(now.folders[0]).toEqual({ id, name: '新名' });
    expect(now.assigns.fc1).toBe(id);
  });

  it('改成别人的名字被挡', async () => {
    const a = await svc.create('甲');
    await svc.create('乙');
    const r = await svc.rename(a.ok ? a.folder.id : '', '乙');
    expect(r.ok).toBe(false);
  });

  it('改自己的名字（不变）不该被判重名', async () => {
    const a = await svc.create('甲');
    const r = await svc.rename(a.ok ? a.folder.id : '', '甲');
    expect(r.ok).toBe(true);
  });

  it('改不存在的文件夹 → missing', async () => {
    const r = await svc.rename('nope', '随便');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
  });
});

describe('remove：删文件夹不删卡', () => {
  it('文件夹没了、归属清了、卡（的数据）没被碰', async () => {
    const r = await svc.create('要删的');
    const id = r.ok ? r.folder.id : '';
    await svc.assign(['fc1', 'fc2'], id);
    const before = await svc.loadAll();
    expect(Object.keys(before.assigns)).toHaveLength(2);

    const next = await svc.remove(id);
    expect(next.folders).toHaveLength(0);
    expect(next.assigns).toEqual({});
    expect((await svc.loadAll()).assigns).toEqual({});
  });

  it('只清这个文件夹的归属，别的不动', async () => {
    const a = await svc.create('甲');
    const b = await svc.create('乙');
    const ida = a.ok ? a.folder.id : '';
    const idb = b.ok ? b.folder.id : '';
    await svc.assign(['fc1'], ida);
    await svc.assign(['fc2'], idb);

    await svc.remove(ida);
    const now = await svc.loadAll();
    expect(now.assigns).toEqual({ fc2: idb });
  });
});

describe('assign：一张卡只在一个文件夹里', () => {
  it('放进 A；再放进 B → 从 A 消失（覆盖不是追加）', async () => {
    const a = await svc.create('甲');
    const b = await svc.create('乙');
    const ida = a.ok ? a.folder.id : '';
    const idb = b.ok ? b.folder.id : '';

    expect(await svc.assign(['fc1'], ida)).toBe(1);
    expect((await svc.loadAll()).assigns.fc1).toBe(ida);

    expect(await svc.assign(['fc1'], idb)).toBe(1);
    const now = await svc.loadAll();
    expect(now.assigns.fc1).toBe(idb);
    /* 关键：只有一条，不是两条 */
    expect(Object.keys(now.assigns)).toHaveLength(1);
  });

  it('已有归属时放同一文件夹不算改动（返回 0）', async () => {
    const a = await svc.create('甲');
    const id = a.ok ? a.folder.id : '';
    await svc.assign(['fc1'], id);
    expect(await svc.assign(['fc1'], id)).toBe(0);
  });

  it('null = 移出文件夹', async () => {
    const a = await svc.create('甲');
    const id = a.ok ? a.folder.id : '';
    await svc.assign(['fc1'], id);
    expect(await svc.assign(['fc1'], null)).toBe(1);
    expect((await svc.loadAll()).assigns).toEqual({});
  });

  it('目标文件夹不存在 → 不写、返回 0', async () => {
    expect(await svc.assign(['fc1'], 'ghost')).toBe(0);
    expect((await svc.loadAll()).assigns).toEqual({});
  });

  it('批量：只算真的变了的', async () => {
    const a = await svc.create('甲');
    const id = a.ok ? a.folder.id : '';
    await svc.assign(['fc1'], id);
    expect(await svc.assign(['fc1', 'fc2', 'fc3'], id)).toBe(2);
  });
});

describe('prune：剪掉死卡的归属', () => {
  it('删掉的卡不再占归属', async () => {
    const a = await svc.create('甲');
    const id = a.ok ? a.folder.id : '';
    await svc.assign(['fc1', 'fc2'], id);
    expect(await svc.prune(new Set(['fc1']))).toBe(true);
    expect(Object.keys((await svc.loadAll()).assigns)).toEqual(['fc1']);
  });

  it('没变化时返回 false 且不写盘', async () => {
    const a = await svc.create('甲');
    const id = a.ok ? a.folder.id : '';
    await svc.assign(['fc1'], id);
    expect(await svc.prune(new Set(['fc1']))).toBe(false);
  });
});

describe('持久化与防御', () => {
  it('★ 服务重开（新实例）后数据还在 —— 说明真的写进了 settings', async () => {
    await svc.create('高数');
    const fresh = new FlashcardFolderService(lib);
    expect((await fresh.loadAll()).folders.map((f) => f.name)).toEqual(['高数']);
  });

  it('库里的坏数据不让界面崩，退化成空设置', async () => {
    /* 直接写一个坏值进 settings（模拟手改备份） */
    await lib.saveSettings({ flashcardFolders: '坏了' } as never);
    const s = await svc.loadAll();
    expect(s.folders).toEqual([]);
    expect(s.assigns).toEqual({});
  });

  it('不碰别的 settings 字段（同表共存，不能互相覆盖）', async () => {
    await lib.saveSettings({ onboarded: true });
    await svc.create('甲');
    const st = await lib.getSettings();
    expect(st.onboarded).toBe(true);
  });
});
