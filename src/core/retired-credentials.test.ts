import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LibraryService, sanitizeSettingsForExport } from './library.ts';
import type { AppSettings } from './model.ts';

/**
 * 已下线凭据的清洗（2026-11-09）。
 *
 * ## 背景
 *
 * 墨墨生词本功能在 2026-11-09 被删除，`settings.maimemoToken` 字段也从
 * `AppSettings` 里拿掉了。但**删类型不等于删数据**：
 *
 *  - 用户库里那条 settings 记录物理上还带着 token（已实测确认，
 *    IndexedDB 里是 UTF-16LE 存的，普通 grep 扫不到）
 *  - `getSettings` 用 `...rest` 展开，会把它原样带进内存对象
 *  - 随后 `exportBackup` 会把它写进备份文件
 *
 * 所以「删了功能」不等于「凭据不再外泄」，必须真的抹掉。
 *
 * 这里守住两件事：
 *  1. `init()` 会把库里残留的字段真正删掉并回写
 *  2. `sanitizeSettingsForExport` 仍然剔除该字段（旧备份导入再导出的路径）
 */

describe('已下线凭据的清理', () => {
  it('init() 把库里的 maimemoToken 真正删掉并回写', async () => {
    const storage = new MemoryStorage();
    await storage.init();
    /* 模拟旧库：settings 记录里带着功能已删除的凭据字段 */
    await storage.put('settings', {
      id: 'app',
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'legacy-secret-token',
      maimemoNotepadId: 'np-legacy',
    } as never);

    const library = new LibraryService(storage);
    await library.init();

    const row = (await storage.get('settings', 'app')) as unknown as Record<string, unknown>;
    expect(row.maimemoToken).toBeUndefined();
    expect(row.maimemoNotepadId).toBeUndefined();
    /* 其余字段一个都不能丢 —— 清理不能顺手把设置清了 */
    expect(row.locale).toBe('zh-CN');
    expect(row.onboarded).toBe(true);
    expect(row.id).toBe('app');
  });

  it('getSettings 不会把残留字段带出来（即使库还没来得及清）', async () => {
    /*
     * 这条守的是时序：init() 与界面首次读设置有先后不确定性。
     * 只要 getSettings 会展开，就必须自己挡住这个字段。
     */
    const storage = new MemoryStorage();
    await storage.init();
    await storage.put('settings', {
      id: 'app',
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'legacy-secret-token',
    } as never);

    const library = new LibraryService(storage);
    const s = (await library.getSettings()) as unknown as Record<string, unknown>;
    expect(s.maimemoToken).toBeUndefined();
  });

  it('没有该字段时 init() 不写库（不做无意义的写）', async () => {
    const storage = new MemoryStorage();
    await storage.init();
    await storage.put('settings', {
      id: 'app',
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: false,
      gradingRules: { strictness: 'standard', perKind: {} },
    } as never);

    const before = await storage.get('settings', 'app');
    const library = new LibraryService(storage);
    await library.init();
    const after = await storage.get('settings', 'app');

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe('导出仍然剔除历史凭据', () => {
  it('旧备份里的 token 不会被导出（导入再导出的路径）', async () => {
    const settings = {
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'legacy-secret-token',
    } as unknown as AppSettings;

    const out = sanitizeSettingsForExport(settings) as unknown as Record<string, unknown>;
    expect(out.maimemoToken).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('legacy-secret-token');
    /* 非凭据字段照旧 */
    expect(out.locale).toBe('zh-CN');
  });

  it('端到端：存了残留 token 的库，导出文件里没有它', async () => {
    const storage = new MemoryStorage();
    const library = new LibraryService(storage);
    await library.create('测试库');
    /* 绕过 saveSettings 直接写入，模拟旧库残留 */
    await storage.put('settings', {
      id: 'app',
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'legacy-secret-token',
    } as never);

    const backup = await library.exportBackup();
    expect(JSON.stringify(backup)).not.toContain('legacy-secret-token');
  });
});
