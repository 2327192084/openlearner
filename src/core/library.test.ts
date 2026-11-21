import { describe, expect, it, beforeEach } from 'vitest';
import { LibraryService, LibraryError, backupFileName, validateBackup } from './library.ts';
import { MemoryStorage } from './storage/memory-storage.ts';
import { DEFAULT_SETTINGS, LIBRARY_SCHEMA_VERSION } from './model.ts';

/**
 * 学习库用例测试。
 *
 * 覆盖计划书 P0「算做完」里的两条：
 *  - 能建一个空学习库，重启后还在
 *  - 学习库能导出成文件、能从文件恢复
 *
 * 「重启」在这里用「新建一个 service 但复用同一份存储」来模拟——
 * 内存适配器的数据活过 service 实例，正好对应真实场景里 IndexedDB 活得比页面久。
 */

function freshService(): { service: LibraryService; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { service: new LibraryService(storage), storage };
}

/**
 * 顶层共享的 fixture：所有用例都在同一个「刚建好的空存储」上起跑。
 * 放在顶层而不是某个 describe 里，是因为后面的 describe 分组也要用它，
 * 而 describe 内声明的变量对兄弟 describe 不可见。
 */
let service: LibraryService;
let storage: MemoryStorage;

beforeEach(() => {
  ({ service, storage } = freshService());
});

describe('LibraryService', () => {
  it('新建学习库后能读到元信息', async () => {
    const meta = await service.create('数据结构复习');
    expect(meta.name).toBe('数据结构复习');
    expect(meta.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(meta.id).toBe('library');
    expect(await service.getMeta()).toEqual(meta);
  });

  it('未建库时 getMeta 返回 null，而不是抛错', async () => {
    // 空库是合法状态：应用要能启动并引导用户建库，不能一开机就报错
    expect(await service.getMeta()).toBeNull();
  });

  it('重复建库不会覆盖已有库（防止误清空）', async () => {
    const first = await service.create('第一份');
    const second = await service.create('第二份');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('第一份');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('库名留空时回落到默认名，而不是存一个空字符串', async () => {
    const meta = await service.create('   ');
    expect(meta.name).toBe('我的学习库');
  });

  it('重命名会更新 updatedAt 与名称', async () => {
    const created = await service.create('旧名字');
    // 时间戳精度到毫秒，同一次执行内可能相同，只断言被真的改写过
    const renamed = await service.rename('新名字');
    expect(renamed.name).toBe('新名字');
    expect(renamed.createdAt).toBe(created.createdAt);
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
  });

  it('重命名成空字符串时保留原名', async () => {
    await service.create('保留我');
    const renamed = await service.rename('  ');
    expect(renamed.name).toBe('保留我');
  });

  it('设置读写带默认值兜底', async () => {
    await service.create('库');
    const defaults = await service.getSettings();
    expect(defaults).toEqual(DEFAULT_SETTINGS);

    const saved = await service.saveSettings({ questionLanguage: 'en' });
    expect(saved.questionLanguage).toBe('en');
    expect(saved.locale).toBe('zh-CN');
    // 再次读取要能读到改动——这条是「重启后还在」的最小验证
    expect((await service.getSettings()).questionLanguage).toBe('en');
  });
});

describe('学习库「重启后还在」', () => {
  it('新 service 实例复用同一存储时仍读得到数据', async () => {
    const storage = new MemoryStorage();
    const first = new LibraryService(storage);
    await first.create('跨重启的库');
    await first.saveSettings({ onboarded: true });

    // 模拟应用重启：换一个 service，存储不变
    const second = new LibraryService(storage);
    const meta = await second.getMeta();
    expect(meta?.name).toBe('跨重启的库');
    expect((await second.getSettings()).onboarded).toBe(true);
  });
});

describe('备份导出与恢复', () => {
  it('导出的备份带格式标记与版本号', async () => {
    await service.create('备份测试');
    const backup = await service.exportBackup();

    expect(backup.format).toBe('openleaner-library');
    expect(backup.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(backup.meta.name).toBe('备份测试');
    // 新库各分区都应是空数组，而不是 undefined——
    // undefined 会让 JSON.stringify 直接丢掉这些字段，导入方拿不到键
    expect(backup.courses).toEqual([]);
    expect(backup.sources).toEqual([]);
    expect(backup.knowledgePoints).toEqual([]);
    expect(backup.decks).toEqual([]);
    expect(backup.questions).toEqual([]);
    expect(backup.slideDecks).toEqual([]);
    expect(backup.backends).toEqual([]);
  });

  it('导出的 JSON 不含 secrets 分区（凭据不进备份）', async () => {
    await service.create('含凭据的库');
    // 直接往存储里塞一条凭据，模拟用户已保存 Key
    await storage.put('secrets', {
      id: 'secret_1',
      backendId: 'backend_1',
      value: 'sk-super-secret-value-123456',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const json = JSON.stringify(await service.exportBackup());
    expect(json).not.toContain('sk-super-secret-value-123456');
    expect(json).not.toContain('secrets');
  });

  /**
   * 搜索 API Key 是凭据，不能进备份（2026-11-21 深夜）。
   *
   * ## 为什么这条必须单独测
   *
   * 模型 Key 存在 `secrets` 分区、靠「不在 BACKUP_STORES 里」就自动不进备份。
   * 但搜索 Key 为了少开一张表存进了 `settings` —— 而 settings 是**会**进备份的
   * （`exportBackup` 里 `settings: sanitizeSettingsForExport(settings)`）。
   *
   * 所以它必须靠 `sanitizeSettingsForExport` 里显式 `delete` 才安全。
   * 漏了这一行的后果：用户导出备份发给别人，搜索 Key 跟着出去，
   * 而他自己完全不会意识到备份文件里有凭据。
   */
  it('导出的 JSON 不含搜索 API Key（settings 里的凭据要显式抹掉）', async () => {
    await service.create('含搜索 Key 的库');
    await service.saveSettings({
      webSearchKey: 'tvly-sk-should-never-leak-987654',
    } as never);

    const json = JSON.stringify(await service.exportBackup());
    expect(json).not.toContain('tvly-sk-should-never-leak-987654');
    expect(json).not.toContain('webSearchKey');
  });

  it('搜索 Key 在库里仍然读得到（抹掉的只是导出副本）', async () => {
    /*
     * 这条是上一条的反向守护：证明「抹掉」只发生在导出路径，
     * 没有把库里的值也弄丢 —— 那会让用户的联网检索莫名其妙失效。
     */
    await service.create('含搜索 Key 的库');
    await service.saveSettings({ webSearchKey: 'tvly-sk-keep-me' } as never);

    const s = await service.getSettings();
    expect((s as unknown as { webSearchKey?: string }).webSearchKey).toBe('tvly-sk-keep-me');
  });

  it('导出再导入能完整还原库名与记录', async () => {
    await service.create('可还原的库');
    await storage.put('courses', {
      id: 'course_1',
      name: '高等数学',
      color: '#2f5fd0',
      createdAt: new Date().toISOString(),
    });

    const backup = await service.exportBackup();
    // 序列化再反序列化，模拟真的写文件、读文件
    const roundTripped: unknown = JSON.parse(JSON.stringify(backup));

    // 换一个空库做导入目标
    const target = freshService();
    const restored = await target.service.importBackup(roundTripped);

    expect(restored.name).toBe('可还原的库');
    const courses = await target.storage.getAll('courses');
    expect(courses).toHaveLength(1);
    expect(courses[0].name).toBe('高等数学');
  });

  it('导入是整库替换，不是合并', async () => {
    const source = freshService();
    await source.service.create('来源库');
    await source.storage.put('courses', {
      id: 'from_backup',
      name: '来源课程',
      color: null,
      createdAt: new Date().toISOString(),
    });
    const backup = await source.service.exportBackup();

    const target = freshService();
    await target.service.create('目标库');
    await target.storage.put('courses', {
      id: 'existing',
      name: '目标已有课程',
      color: null,
      createdAt: new Date().toISOString(),
    });

    await target.service.importBackup(JSON.parse(JSON.stringify(backup)));

    const courses = await target.storage.getAll('courses');
    expect(courses).toHaveLength(1);
    expect(courses[0].id).toBe('from_backup');
    expect(courses.some((c) => c.id === 'existing')).toBe(false);
  });

  it('导入会清掉旧凭据，避免把旧 Key 用到新库', async () => {
    await service.create('A 库');
    await storage.put('secrets', {
      id: 'secret_old',
      backendId: 'backend_old',
      value: 'sk-old-key-000000',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const backup = await service.exportBackup();

    await service.importBackup(JSON.parse(JSON.stringify(backup)));
    expect(await storage.getAll('secrets')).toHaveLength(0);
  });

  it('空库也能导出（用户刚建库就想备份）', async () => {
    await service.create('空库');
    const backup = await service.exportBackup();
    expect(backup.meta.name).toBe('空库');
    expect(() => validateBackup(backup)).not.toThrow();
  });

  /**
   * 恢复备份不能丢掉「白名单之外」的 settings 字段（2026-11-21 修）。
   *
   * ## 这条测试为什么存在
   *
   * `importBackup` 原来是逐字段白名单（locale / questionLanguage /
   * onboarded / gradingRules）。后加的 `homeWidgets` 与
   * `dailyQuoteEndpoint` 不在里面 —— 用户换机器恢复备份后这两项
   * **静默丢失**，而备份文件里明明存着。实测（导出→导入往返）：
   *
   *   homeWidgets        → undefined
   *   dailyQuoteEndpoint → undefined
   *
   * 修复前这两条断言都会红，所以它们确实在验东西
   * （反向验证过：把白名单改回去，两条都失败）。
   */
  it('恢复备份时保留自定义首页小组件（不在旧白名单里）', async () => {
    await service.create('源库');
    const widgets = [
      { id: 'w_1', kind: 'quote', title: '座右铭', body: '天行健，君子以自强不息' },
      { id: 'w_2', kind: 'focus', title: '', body: '' },
    ];
    await service.saveSettings({ homeWidgets: widgets });

    const backup = await service.exportBackup();
    /* 备份文件里确实有 —— 否则下面验的是「本来就没存」 */
    expect(JSON.stringify(backup)).toContain('天行健');

    const target = freshService();
    await target.service.importBackup(JSON.parse(JSON.stringify(backup)));

    const restored = await target.service.getSettings();
    expect(restored.homeWidgets).toEqual(widgets);
  });

  it('恢复备份时保留自定义每日一句端点（不在旧白名单里）', async () => {
    await service.create('源库');
    await service.saveSettings({ dailyQuoteEndpoint: 'https://example.com/quote.json' });

    const backup = await service.exportBackup();
    const target = freshService();
    await target.service.importBackup(JSON.parse(JSON.stringify(backup)));

    const restored = await target.service.getSettings();
    expect(restored.dailyQuoteEndpoint).toBe('https://example.com/quote.json');
  });

  it('恢复备份时凭据类字段仍被清掉（展开 settings 不能把旧凭据带回来）', async () => {
    /*
     * 「整体展开 settings」的一个副作用风险：旧备份文件里可能还带着
     * 已下线功能的凭据（maimemoToken）。直接展开会把它重新写进库。
     * 所以展开前必须先 sanitize。
     */
    await service.create('源库');
    const backup = await service.exportBackup();
    /* 手工把一个旧凭据塞进备份的 settings（模拟旧版本导出的文件） */
    const dirty = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    (dirty.settings as Record<string, unknown>).maimemoToken = 'old-secret-token-123';

    const target = freshService();
    await target.service.importBackup(dirty);

    const row = await target.storage.get('settings', 'app');
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain('old-secret-token-123');
  });

  it('旧备份缺 settings 字段时用默认值补齐，不因此导入失败', async () => {
    await service.create('源库');
    const backup = await service.exportBackup();
    const noSettings = JSON.parse(JSON.stringify(backup)) as Record<string, unknown>;
    delete noSettings.settings;

    const target = freshService();
    await target.service.importBackup(noSettings);

    const restored = await target.service.getSettings();
    expect(restored.locale).toBe('zh-CN');
    expect(restored.onboarded).toBe(false);
    expect(restored.gradingRules.strictness).toBe('standard');
  });

  it('未建库时导出给出可操作提示，而不是空指针', async () => {
    await expect(service.exportBackup()).rejects.toThrow(LibraryError);
    await expect(service.exportBackup()).rejects.toThrow(/还没有学习库/);
  });
});

describe('validateBackup —— 坏文件必须说清原因', () => {
  it('拒绝 null', () => {
    expect(() => validateBackup(null)).toThrow(/内容为空/);
  });

  it('拒绝非对象', () => {
    expect(() => validateBackup('not a backup')).toThrow(LibraryError);
    expect(() => validateBackup(42)).toThrow(LibraryError);
  });

  it('拒绝别的 JSON 文件，并说明该选哪种文件', () => {
    try {
      validateBackup({ format: 'something-else' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).hint).toMatch(/导出学习库/);
    }
  });

  it('拒绝缺少版本号的文件', () => {
    expect(() => validateBackup({ format: 'openleaner-library' })).toThrow(/版本/);
  });

  it('拒绝来自更高版本的备份，并提示升级', () => {
    try {
      validateBackup({ format: 'openleaner-library', schemaVersion: 99, meta: { id: 'library' } });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as LibraryError).hint).toMatch(/升级/);
    }
  });

  it('缺失的分区补成空数组，而不是让调用方处理 undefined', () => {
    const result = validateBackup({
      format: 'openleaner-library',
      schemaVersion: 1,
      meta: { id: 'library', name: 'x' },
    });
    expect(result.courses).toEqual([]);
    expect(result.backends).toEqual([]);
  });
});

/**
 * 导出→导入必须一个分区都不少。
 *
 * 这条用「真实导出、真实导入、再读回存储」来测，
 * 而不是断言导出对象上有哪些键——因为丢数据的其实是
 * validateBackup() 重建对象那一步：键在导出时有，进到库里就没了。
 */
describe('备份必须整库往返，不能悄悄少分区', () => {
  it('导出后再导入，六个容易漏的分区都还在', async () => {
    await service.create('往返库');

    const now = new Date().toISOString();
    await storage.put('sourceSegments', {
      id: 'seg_1',
      sourceId: 'src_1',
      index: 0,
      page: 1,
      chapter: null,
      text: '这是正文，恢复后还得能点回原文',
      charCount: 16,
    });
    await storage.put('sourceAnnotations', {
      id: 'anno_1',
      sourceId: 'src_1',
      page: 3,
      strokes: [],
      texts: [],
      createdAt: now,
      updatedAt: now,
    });
    await storage.put('reviewRecords', {
      id: 'card_1',
      cardId: 'card_1',
      kind: 'question',
      state: {
        ease: 2.5,
        intervalDays: 6,
        streak: 3,
        reviewCount: 4,
        lapseCount: 1,
        dueAt: '2026-12-01',
      },
      firstSeenAt: now,
      updatedAt: now,
    });
    await storage.put('reviewLogs', {
      id: 'log_1',
      cardId: 'card_1',
      kind: 'question',
      grade: 'good',
      day: '2026-11-06',
      prevIntervalDays: 1,
      newIntervalDays: 6,
      at: now,
    });
    await storage.put('slideImages', {
      id: 'img_1',
      imageData: 'data:image/png;base64,iVBORw0KGgo=',
      width: 800,
      height: 600,
      byteSize: 12,
      createdAt: now,
    });
    await storage.put('usageRecords', {
      id: '2026-11-06|backend_1|questions',
      day: '2026-11-06',
      backendId: 'backend_1',
      provider: 'deepseek',
      kind: 'questions',
      tokens: 1234,
      calls: 2,
      lastAt: now,
    });

    const backup = await service.exportBackup();
    // 导出对象上确实带着这些字段（这一步一直是通的）
    expect(backup.sourceSegments).toHaveLength(1);
    expect(backup.slideImages).toHaveLength(1);
    expect(backup.usageRecords).toHaveLength(1);

    // 关键：走一遍真实的序列化 + 导入，再看存储里还剩什么
    const target = freshService();
    await target.service.importBackup(JSON.parse(JSON.stringify(backup)));

    expect(await target.storage.getAll('sourceSegments')).toHaveLength(1);
    expect(await target.storage.getAll('sourceAnnotations')).toHaveLength(1);
    expect(await target.storage.getAll('reviewRecords')).toHaveLength(1);
    expect(await target.storage.getAll('reviewLogs')).toHaveLength(1);
    expect(await target.storage.getAll('slideImages')).toHaveLength(1);
    expect(await target.storage.getAll('usageRecords')).toHaveLength(1);

    // 抽查内容本身，避免「有条数但内容被清空」
    const segs = await target.storage.getAll('sourceSegments');
    expect(segs[0].text).toContain('点回原文');
    const usage = await target.storage.getAll('usageRecords');
    expect(usage[0].tokens).toBe(1234);
  });

  it('旧备份里没有这些字段时按空数组补，不因此导入失败', async () => {
    // 2026-11-06 之前的备份缺 reviewRecords / reviewLogs 等字段，
    // 导入这种备份必须照常成功，只是这些分区为空。
    const legacy = {
      format: 'openleaner-library',
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      meta: { id: 'library', name: '老库', createdAt: '', updatedAt: '', schemaVersion: 10 },
      settings: { locale: 'zh-CN', questionLanguage: 'zh', onboarded: false },
      courses: [],
      sources: [],
      knowledgePoints: [],
      generationRuns: [],
      decks: [],
      questions: [],
      answerRecords: [],
      slideDecks: [],
      backends: [],
    };
    const parsed = validateBackup(legacy);
    expect(parsed.sourceSegments).toEqual([]);
    expect(parsed.sourceAnnotations).toEqual([]);
    expect(parsed.reviewRecords).toEqual([]);
    expect(parsed.reviewLogs).toEqual([]);
    expect(parsed.slideImages).toEqual([]);
    expect(parsed.usageRecords).toEqual([]);
  });
});

describe('backupFileName', () => {
  it('文件名带日期且是 .json', async () => {
    const meta = await service.create('我的库');
    const name = backupFileName(meta);
    expect(name).toMatch(/^我的库-\d{8}\.openleaner\.json$/);
  });

  it('库名里的非法文件名字符被替换，不会生成无法保存的文件名', async () => {
    const meta = await service.create('a/b:c*d?e"f<g>h|i');
    const name = backupFileName(meta);
    expect(name).not.toMatch(/[/:*?"<>|]/);
  });
});
