import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LibraryService, sanitizeSettingsForExport } from './library.ts';
import type { AppSettings } from './model.ts';

/**
 * 导出备份时必须剔除凭据（2026-11-09）。
 *
 * ## 为什么这组测试非有不可
 *
 * `settings` 是整块进备份文件的。2026-11-09 起里面多了 `maimemoToken` ——
 * 墨墨的 access token，能读改用户的云词本。
 * 一个凭据跟着备份文件跑到别的机器上，是不可接受的事故。
 *
 * 这类 bug 的特点是：**功能完全正常，直到有人真的把备份发给别人**。
 * 所以只能靠测试守住，不能靠「记得」。
 */

describe('sanitizeSettingsForExport', () => {
  it('剔除 maimemoToken', () => {
    const settings = {
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'secret-token-abc123',
      maimemoNotepadId: 'np-1',
    } as unknown as AppSettings;

    const out = sanitizeSettingsForExport(settings) as unknown as Record<string, unknown>;
    expect(out.maimemoToken).toBeUndefined();
  });

  it('保留非凭据字段（词本 id 不是凭据，可以跟着备份走）', () => {
    const settings = {
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'secret',
      maimemoNotepadId: 'np-1',
    } as unknown as AppSettings;

    const out = sanitizeSettingsForExport(settings) as unknown as Record<string, unknown>;
    expect(out.maimemoNotepadId).toBe('np-1');
    expect(out.locale).toBe('zh-CN');
    expect(out.onboarded).toBe(true);
  });

  it('不修改传入对象（纯函数）', () => {
    /*
     * 这条很重要：如果就地删，调用方手里的 settings 会被悄悄改掉，
     * 后续再保存设置时 token 就丢了 —— 一个隐形数据丢失。
     */
    const settings = {
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: true,
      gradingRules: { strictness: 'standard', perKind: {} },
      maimemoToken: 'secret',
    } as unknown as AppSettings;

    sanitizeSettingsForExport(settings);
    expect((settings as unknown as Record<string, unknown>).maimemoToken).toBe('secret');
  });

  it('没有该字段时不报错', () => {
    const settings = {
      locale: 'zh-CN',
      questionLanguage: 'zh',
      onboarded: false,
      gradingRules: { strictness: 'standard', perKind: {} },
    } as unknown as AppSettings;
    expect(() => sanitizeSettingsForExport(settings)).not.toThrow();
  });
});

describe('exportBackup 真的不含凭据', () => {
  it('存了 token 的库，导出结果里没有 token', async () => {
    /*
     * 端到端：走真实的 exportBackup，而不是只测那个纯函数。
     * 因为「函数写对了但没接上」是很常见的一种错。
     */
    const storage = new MemoryStorage();
    const library = new LibraryService(storage);
    await library.create('测试库');

    await library.saveSettings({
      maimemoToken: 'super-secret-token',
      maimemoNotepadId: 'np-1',
    } as Partial<AppSettings>);

    // 先确认 token 确实存进去了（否则这条测试就是空转）
    const saved = await library.getSettings();
    expect((saved as unknown as Record<string, unknown>).maimemoToken).toBe('super-secret-token');

    const backup = await library.exportBackup();
    const exported = backup.settings as unknown as Record<string, unknown>;

    expect(exported.maimemoToken).toBeUndefined();
    // 序列化之后也不能出现（防止某个嵌套层漏了）
    expect(JSON.stringify(backup)).not.toContain('super-secret-token');
    // 非凭据字段照旧在
    expect(exported.maimemoNotepadId).toBe('np-1');
  });
});
