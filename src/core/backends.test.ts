import { describe, expect, it, beforeEach } from 'vitest';
import { BackendService, DEFAULT_BACKEND_DRAFT, maskCredential } from './backends.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 后端配置服务的测试。
 *
 * 重点不是「表单能存」，而是两条会在参赛材料里被拿放大镜看的约束：
 *  1. 凭据不进导出快照（P5 验收项）
 *  2. 可用状态由配置推导，不是用户手填（P5「调用前就告知」）
 */

let service: BackendService;
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  service = new BackendService(storage);
});

const draft = (patch: Partial<typeof DEFAULT_BACKEND_DRAFT> = {}) => ({
  ...DEFAULT_BACKEND_DRAFT,
  ...patch,
});

describe('保存后端配置', () => {
  it('首次保存后成为默认后端', async () => {
    const view = await service.save(draft());
    expect(view.isDefault).toBe(true);
  });

  it('第二个后端不会抢默认位', async () => {
    const first = await service.save(draft({ label: 'DeepSeek' }));
    await service.save(draft({ label: '备用' }));
    expect((await service.get(first.id))?.isDefault).toBe(true);
  });

  it('未填凭据时状态是 unconfigured', async () => {
    const view = await service.save(draft());
    expect(view.status).toBe('unconfigured');
    expect(view.hasCredential).toBe(false);
  });

  it('填了凭据后状态变 ready', async () => {
    const view = await service.save(draft(), { credential: 'sk-test-1234567890' });
    expect(view.status).toBe('ready');
    expect(view.hasCredential).toBe(true);
  });

  it('agent 应用类型即使有凭据也需要登录', async () => {
    const view = await service.save(draft({ kind: 'agent-app' }), {
      credential: 'some-token-value-here',
    });
    // P5 要求状态如实反映，不能因为「填了个值」就说可用
    expect(view.status).toBe('needs-login');
  });

  it('编辑时不传凭据则保留原凭据', async () => {
    const created = await service.save(draft({ label: '原名' }), { credential: 'sk-keep-12345678' });
    const updated = await service.save(draft({ label: '改名后' }), { id: created.id });

    expect(updated.label).toBe('改名后');
    expect(updated.hasCredential).toBe(true);
    expect(await service.readCredential(created.id)).toBe('sk-keep-12345678');
  });

  it('编辑时传空字符串会清除凭据，状态回落', async () => {
    const created = await service.save(draft(), { credential: 'sk-to-be-removed-9999' });
    const updated = await service.save(draft(), { id: created.id, credential: '' });

    expect(updated.hasCredential).toBe(false);
    expect(updated.status).toBe('unconfigured');
    expect(await service.readCredential(created.id)).toBeNull();
  });

  it('创建时间在编辑时保持不变', async () => {
    const created = await service.save(draft());
    const updated = await service.save(draft({ label: '改了' }), { id: created.id });
    expect(updated.createdAt).toBe(created.createdAt);
  });
});

describe('凭据安全', () => {
  it('list() 不返回凭据明文', async () => {
    await service.save(draft(), { credential: 'sk-should-never-leak-abcdef' });
    const list = await service.list();

    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('sk-should-never-leak-abcdef');
  });

  it('list() 返回脱敏尾号，让用户确认存的是哪一把', async () => {
    await service.save(draft(), { credential: 'sk-should-never-leak-abcdef' });
    const list = await service.list();
    expect(list[0].credentialHint).toBe('••••cdef');
  });

  it('凭据存在独立分区，不在 backends 记录里', async () => {
    await service.save(draft(), { credential: 'sk-isolated-value-7777' });

    const backends = await storage.getAll('backends');
    expect(JSON.stringify(backends)).not.toContain('sk-isolated-value-7777');

    const secrets = await storage.getAll('secrets');
    expect(secrets).toHaveLength(1);
    expect(secrets[0].value).toBe('sk-isolated-value-7777');
  });

  it('删除后端会连带删除凭据，不留孤儿数据', async () => {
    const created = await service.save(draft(), { credential: 'sk-orphan-check-1234' });
    await service.remove(created.id);

    expect(await storage.getAll('secrets')).toHaveLength(0);
    expect(await storage.getAll('backends')).toHaveLength(0);
  });

  it('删除默认后端后，剩下的第一个补位为默认', async () => {
    const first = await service.save(draft({ label: '第一个' }));
    const second = await service.save(draft({ label: '第二个' }));

    await service.remove(first.id);
    expect((await service.get(second.id))?.isDefault).toBe(true);
  });
});

describe('默认后端切换', () => {
  it('setDefault 保证只有一个默认', async () => {
    const a = await service.save(draft({ label: 'A' }));
    const b = await service.save(draft({ label: 'B' }));

    await service.setDefault(b.id);
    const list = await service.list();
    const defaults = list.filter((x) => x.isDefault);

    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.id);
    expect((await service.get(a.id))?.isDefault).toBe(false);
  });

  it('列表把默认后端排在最前', async () => {
    const a = await service.save(draft({ label: 'A' }));
    await service.save(draft({ label: 'Z' }));
    await service.setDefault(a.id);

    expect((await service.list())[0].id).toBe(a.id);
  });
});

describe('maskCredential', () => {
  it('长凭据保留尾 4 位', () => {
    expect(maskCredential('sk-abcdefghijklmnop')).toBe('••••mnop');
  });

  it('短凭据完全遮蔽，不露任何位', () => {
    // 短 Key 露 4 位可能就漏掉大半，宁可什么都不显示
    expect(maskCredential('short')).toBe('••••');
    expect(maskCredential('12345678901')).toBe('••••');
  });

  it('刚好 12 位开始露尾号', () => {
    expect(maskCredential('123456789012')).toBe('••••9012');
  });
});
