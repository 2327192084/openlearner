import { describe, expect, it, beforeEach } from 'vitest';
import { migrateBackup, MigrationError } from './migrations.ts';
import { LibraryService, validateBackup } from './library.ts';
import { MemoryStorage } from './storage/memory-storage.ts';
import { LIBRARY_SCHEMA_VERSION } from './model.ts';
import type { LibraryBackup } from './model.ts';

/**
 * 备份版本迁移测试。
 *
 * 为什么这件事重要到要单独一组测试：
 * P0 已经交付、可能已经有人导过 v1 备份。P1 把 schemaVersion 提到 2
 * （新增 sourceSegments 分区 + Source 的 textStatus/segmentCount），
 * 如果导入时只认 v2，那些备份就全废了 —— 而用户的资料是他们最不该丢的东西。
 *
 * 迁移的原则也在这里被断言：**只做加法**，不清空、不伪造。
 */

const ts = '2026-11-01T00:00:00.000Z';

/** 构造一份 P0 时期的 v1 备份 */
function makeV1Backup(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    format: 'openleaner-library',
    schemaVersion: 1,
    exportedAt: ts,
    meta: { id: 'library', name: 'P0 时代的库', createdAt: ts, updatedAt: ts, schemaVersion: 1 },
    settings: { locale: 'zh-CN', questionLanguage: 'zh', onboarded: true },
    courses: [{ id: 'course_1', name: '高等数学', color: null, createdAt: ts }],
    // 注意：v1 的 Source 没有 textStatus / segmentCount
    sources: [
      {
        id: 'source_1',
        title: '第一章',
        fileName: 'ch1.pdf',
        kind: 'pdf',
        courseId: 'course_1',
        pageCount: 12,
        byteSize: 102400,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    knowledgePoints: [],
    decks: [],
    questions: [],
    slideDecks: [],
    backends: [],
    ...overrides,
  };
}

describe('migrateBackup：v1 → v2', () => {
  it('版本号升到当前', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);
    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('补出 sourceSegments 分区（空数组，不是 undefined）', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);

    expect(Array.isArray(migrated.sourceSegments)).toBe(true);
    expect(migrated.sourceSegments).toHaveLength(0);

    // 关键：不能是 undefined。JSON.stringify 会把 undefined 的键整个丢掉，
    // 导入方再读就变成"没有这个字段"，下游全要判空
    expect(JSON.parse(JSON.stringify(migrated))).toHaveProperty('sourceSegments');
  });

  it('给旧资料补上 textStatus 与 segmentCount', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);
    const source = migrated.sources[0];

    expect(source.textStatus).toBe('ready');
    // v1 从未把正文落库，所以真实段数就是 0。
    // 编一个非零值会让阅读器点开空白，那比提示重导更糟
    expect(source.segmentCount).toBe(0);
  });

  it('不伪造正文：迁移后没有凭空造出的段', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);
    // 宁可让用户重导一次，也不能造出能点开的假原文
    expect(migrated.sourceSegments).toEqual([]);
  });

  it('原有数据一条不少', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);

    expect(migrated.meta.name).toBe('P0 时代的库');
    expect(migrated.settings.onboarded).toBe(true);
    expect(migrated.courses).toHaveLength(1);
    expect(migrated.sources).toHaveLength(1);
    expect(migrated.sources[0].title).toBe('第一章');
    expect(migrated.sources[0].pageCount).toBe(12);
  });

  it('已是当前版本时原样返回（幂等）', () => {
    const current = {
      ...makeV1Backup(),
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      sourceSegments: [],
    } as unknown as LibraryBackup;

    const result = migrateBackup(current);
    expect(result).toBe(current);
  });

  it('拒绝更高版本，并提示升级而不是猜字段', () => {
    const future = { ...makeV1Backup(), schemaVersion: 99 } as unknown as LibraryBackup;

    expect(() => migrateBackup(future)).toThrow(MigrationError);
    try {
      migrateBackup(future);
    } catch (err) {
      expect((err as MigrationError).hint).toMatch(/升级/);
    }
  });

  it('拒绝无效版本号', () => {
    const invalid = { ...makeV1Backup(), schemaVersion: 0 } as unknown as LibraryBackup;
    expect(() => migrateBackup(invalid)).toThrow(MigrationError);
  });
});

describe('v1 备份能真正导入到学习库', () => {
  let service: LibraryService;
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    service = new LibraryService(storage);
    await service.create('目标库');
  });

  it('整条链路：v1 备份 → 导入 → 课程与资料都在', async () => {
    const meta = await service.importBackup(makeV1Backup());

    expect(meta.name).toBe('P0 时代的库');
    // 导入后库结构版本应当是当前版本，不是备份里的旧版本
    expect(meta.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);

    const courses = await storage.getAll('courses');
    expect(courses).toHaveLength(1);
    expect(courses[0].name).toBe('高等数学');

    const sources = await storage.getAll('sources');
    expect(sources).toHaveLength(1);
    expect(sources[0].textStatus).toBe('ready');
    expect(sources[0].segmentCount).toBe(0);
  });

  it('导入 v1 备份后没有残留的孤儿段', async () => {
    await service.importBackup(makeV1Backup());
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);
  });

  it('v2 备份往返不丢数据（导出再导入）', async () => {
    // 先导入 v1
    await service.importBackup(makeV1Backup());

    // 再导出（此时是 v2）
    const exported = await service.exportBackup();
    expect(exported.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(exported).toHaveProperty('sourceSegments');

    // 换个空库导入回来
    const target = new MemoryStorage();
    const targetService = new LibraryService(target);
    await targetService.create('另一个库');
    await targetService.importBackup(JSON.parse(JSON.stringify(exported)));

    const sources = await target.getAll('sources');
    expect(sources).toHaveLength(1);
    expect(sources[0].title).toBe('第一章');
  });
});

describe('validateBackup 与迁移的先后顺序', () => {
  it('不是备份的 JSON 得到的是「不是备份」提示，而不是迁移错误', () => {
    // 顺序反了的话，用户会看到「缺少 v1→v2 迁移规则」这种把人带偏的话
    try {
      validateBackup({ hello: 'world' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as Error).message).toMatch(/不是本应用的学习库备份/);
    }
  });

  it('缺 sourceSegments 的 v2 备份也能导入（补空数组）', async () => {
    const storage = new MemoryStorage();
    const service = new LibraryService(storage);
    await service.create('库');

    const incomplete = {
      ...makeV1Backup(),
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      // 故意不给 sourceSegments
    };

    await expect(service.importBackup(incomplete)).resolves.toBeDefined();
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);
  });
});

/**
 * v2 → v3 迁移（P2 引入）
 *
 * 新增：KnowledgePoint 的 anchorStatus / sourceId / backendId，
 * 以及 generationRuns 分区。
 */
describe('migrateBackup：v2 → v3', () => {
  /** 构造一份 P1 时期的 v2 备份 */
  function makeV2Backup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'openleaner-library',
      schemaVersion: 2,
      exportedAt: ts,
      meta: { id: 'library', name: 'P1 时代的库', createdAt: ts, updatedAt: ts, schemaVersion: 2 },
      settings: { locale: 'zh-CN', questionLanguage: 'zh', onboarded: true },
      courses: [],
      sources: [
        {
          id: 'source_1',
          title: '第一章',
          fileName: 'ch1.pdf',
          kind: 'pdf',
          courseId: null,
          pageCount: 3,
          byteSize: 1024,
          textStatus: 'ready',
          segmentCount: 3,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      sourceSegments: [],
      // v2 的知识点没有 anchorStatus / sourceId / backendId
      knowledgePoints: [
        {
          id: 'kp_1',
          statement: '有锚点的老知识点',
          chapter: '第一章',
          cognitiveLevel: 'remember',
          tags: [],
          anchors: [{ sourceId: 'source_1', page: 1, charStart: 0, charEnd: 10 }],
          quotes: ['某段原文引用'],
          origin: 'material',
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: 'kp_2',
          statement: '没有锚点的老知识点',
          chapter: null,
          cognitiveLevel: 'understand',
          tags: [],
          anchors: [],
          quotes: [],
          origin: 'material',
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      decks: [],
      questions: [],
      slideDecks: [],
      backends: [],
      ...overrides,
    };
  }

  it('版本号升到当前', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);
    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('补出 generationRuns 分区（空数组）', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);
    expect(Array.isArray(migrated.generationRuns)).toBe(true);
    expect(JSON.parse(JSON.stringify(migrated))).toHaveProperty('generationRuns');
  });

  it('有锚点的旧知识点推导为 located', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);
    expect(migrated.knowledgePoints[0].anchorStatus).toBe('located');
  });

  it('没锚点的旧知识点推导为 unlocated（不能默认当成已确认）', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);

    // 把「不知道」当成「已确认」是更糟的错误 —— 界面就不会提醒人去看
    expect(migrated.knowledgePoints[1].anchorStatus).toBe('unlocated');
  });

  it('sourceId 与 backendId 补 null 而不是 undefined', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);
    const kp = migrated.knowledgePoints[0];

    expect(kp.sourceId).toBeNull();
    expect(kp.backendId).toBeNull();
    // undefined 会在 JSON 序列化时被丢掉，导入方再读就变成"没有这个字段"
    const round = JSON.parse(JSON.stringify(migrated));
    expect(round.knowledgePoints[0]).toHaveProperty('sourceId');
  });

  it('原有字段一条不少', () => {
    const migrated = migrateBackup(makeV2Backup() as unknown as LibraryBackup);
    const kp = migrated.knowledgePoints[0];

    expect(kp.statement).toBe('有锚点的老知识点');
    expect(kp.cognitiveLevel).toBe('remember');
    expect(kp.anchors).toHaveLength(1);
    expect(kp.quotes).toEqual(['某段原文引用']);
  });

  it('v1 备份能一路升到当前版本', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);

    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(Array.isArray(migrated.sourceSegments)).toBe(true);
    expect(Array.isArray(migrated.generationRuns)).toBe(true);
    // v1 没有知识点，迁移后仍应为空
    expect(migrated.knowledgePoints).toEqual([]);
  });

  it('v2 备份能真正导入学习库', async () => {
    const storage = new MemoryStorage();
    const service = new LibraryService(storage);
    await service.create('目标');

    const meta = await service.importBackup(makeV2Backup());
    expect(meta.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);

    const points = await storage.getAll('knowledgePoints');
    expect(points).toHaveLength(2);
    expect(points[0].anchorStatus).toBe('located');
    expect(points[1].anchorStatus).toBe('unlocated');
  });
});

/**
 * v4 → v5（P4 学习 PPT）。
 *
 * 这一版的风险点在于：v4 的 slideDecks 表虽然存在，但 P4 之前
 * 「学习 PPT」页是「待接入」占位，没有任何代码往里写过正常数据。
 * 所以迁移要处理的其实是**异常残留** —— 但正因为平时跑不到，
 * 出错时也不会有人发现，才更需要测试盯着。
 */
describe('migrateBackup：v4 → v5', () => {
  /** 构造一份 P3 时期的 v4 备份 */
  function makeV4Backup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'openleaner-library',
      schemaVersion: 4,
      exportedAt: ts,
      meta: { id: 'library', name: 'P3 时代的库', createdAt: ts, updatedAt: ts, schemaVersion: 4 },
      settings: { locale: 'zh-CN', questionLanguage: 'zh', onboarded: true },
      courses: [],
      sources: [],
      sourceSegments: [],
      knowledgePoints: [],
      generationRuns: [],
      decks: [],
      questions: [],
      answerRecords: [],
      // v4 的 SlideDeck 只有 P0 占位的 5 个字段
      slideDecks: [
        {
          id: 'slide_1',
          title: 'P0 时代残留的空壳',
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      backends: [],
      ...overrides,
    };
  }

  it('版本号升到当前', () => {
    const migrated = migrateBackup(makeV4Backup() as unknown as LibraryBackup);
    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('空壳 SlideDeck 补齐全部字段', () => {
    const migrated = migrateBackup(makeV4Backup() as unknown as LibraryBackup);
    const deck = migrated.slideDecks[0];

    expect(deck.courseId).toBeNull();
    expect(deck.sourceId).toBeNull();
    expect(deck.status).toBe('outline');
    expect(deck.pages).toEqual([]);
    expect(deck.citations).toEqual([]);
    expect(deck.exports).toEqual([]);
    expect(deck.createdAt).toBe(ts);
    expect(deck.updatedAt).toBe(ts);
  });

  it('不补假封面页（不能让用户看到「有 1 页但不记得建过」的 PPT）', () => {
    const migrated = migrateBackup(makeV4Backup() as unknown as LibraryBackup);

    // 补一页封面看起来"更完整"，但那是一页用户从没见过、也从没要过的内容。
    // 它还会让「页数」这个概念失真：0 页的草稿本应显示为未完成。
    expect(migrated.slideDecks[0].pages).toHaveLength(0);
  });

  it('全部字段都真的存在（不是 undefined，JSON 往返后也在）', () => {
    const migrated = migrateBackup(makeV4Backup() as unknown as LibraryBackup);
    const round = JSON.parse(JSON.stringify(migrated)) as Record<string, unknown>;
    const deck = (round.slideDecks as Record<string, unknown>[])[0];

    for (const key of ['courseId', 'sourceId', 'status', 'pages', 'citations', 'exports']) {
      expect(deck).toHaveProperty(key);
    }
  });

  it('已有数据不被覆盖（已经是 ready 的仍然是 ready）', () => {
    const migrated = migrateBackup(
      makeV4Backup({
        slideDecks: [
          {
            id: 'slide_1',
            title: '手改过的',
            status: 'ready',
            pages: [{ id: 'p1', layout: 'title', title: 'T', subtitle: null, bullets: [] }],
            citations: [],
            exports: [{ id: 'e1', fileName: 'a.pptx', slideCount: 1, byteSize: 100, exportedAt: ts }],
            createdAt: ts,
            updatedAt: ts,
          },
        ],
      }) as unknown as LibraryBackup,
    );

    const deck = migrated.slideDecks[0];
    expect(deck.status).toBe('ready');
    expect(deck.pages).toHaveLength(1);
    expect(deck.exports).toHaveLength(1);
  });

  it('slideDecks 不是数组时退化为空数组，不抛错', () => {
    const migrated = migrateBackup(
      makeV4Backup({ slideDecks: null }) as unknown as LibraryBackup,
    );
    expect(migrated.slideDecks).toEqual([]);
  });

  it('v1 备份能一路升到 v5', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);

    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(Array.isArray(migrated.sourceSegments)).toBe(true);
    expect(Array.isArray(migrated.generationRuns)).toBe(true);
    expect(Array.isArray(migrated.answerRecords)).toBe(true);
    expect(Array.isArray(migrated.slideDecks)).toBe(true);
  });

  it('v4 备份能真正导入学习库', async () => {
    const storage = new MemoryStorage();
    const service = new LibraryService(storage);
    await service.create('目标');

    const meta = await service.importBackup(makeV4Backup());
    expect(meta.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);

    const decks = await storage.getAll('slideDecks');
    expect(decks).toHaveLength(1);
    expect(decks[0].status).toBe('outline');
    expect(decks[0].pages).toEqual([]);
  });
});

/**
 * v5 → v6（P4 图文页）。
 *
 * 这一版加了两个字段：Source.fileStored 与 SlideOutlinePage.figure。
 * 风险不在「字段缺失会崩」，而在**补了不该补的值**：
 *   - 给旧资料伪造 fileStored=true，界面会亮出「插入原文页」按钮，
 *     点下去才发现根本没存字节 —— 用户会认为软件在骗人
 *   - 给旧页补一个空的 figure 对象，会被当成「有图但图坏了」，
 *     预览位置出现一个空框
 * 所以下面两条断言盯的都是「没伪造」。
 */
describe('migrateBackup：v5 → v6', () => {
  /** 构造一份 P4 早期（已能导出 PPT，但还没有图文页）的 v5 备份 */
  function makeV5Backup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      format: 'openleaner-library',
      schemaVersion: 5,
      exportedAt: ts,
      meta: { id: 'library', name: 'P4 早期的库', createdAt: ts, updatedAt: ts, schemaVersion: 5 },
      settings: { locale: 'zh-CN', questionLanguage: 'zh', onboarded: true },
      courses: [],
      sources: [
        {
          id: 'src_1',
          title: '数据结构',
          fileName: 'ds.pdf',
          kind: 'pdf',
          courseId: null,
          pageCount: 50,
          byteSize: 1024,
          textStatus: 'ready',
          segmentCount: 50,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      sourceSegments: [],
      knowledgePoints: [],
      generationRuns: [],
      decks: [],
      questions: [],
      answerRecords: [],
      slideDecks: [
        {
          id: 'slide_1',
          title: '数据结构复习',
          courseId: null,
          sourceId: 'src_1',
          status: 'ready',
          pages: [
            { id: 'sp1', layout: 'title', title: '数据结构复习', subtitle: null, bullets: [] },
            {
              id: 'sp2',
              layout: 'bullets',
              title: '第一章',
              subtitle: null,
              bullets: [{ id: 'sb1', text: '要点', citationIndex: null }],
            },
          ],
          citations: [],
          exports: [],
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      backends: [],
      ...overrides,
    };
  }

  it('版本号升到当前', () => {
    const migrated = migrateBackup(makeV5Backup() as unknown as LibraryBackup);
    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  });

  it('旧资料标 fileStored=false（没存过字节，不能对外声称能插原文页）', () => {
    const migrated = migrateBackup(makeV5Backup() as unknown as LibraryBackup);
    expect(migrated.sources[0].fileStored).toBe(false);
  });

  it('已经标了 fileStored=true 的保留（不同应用版本之间不要互相覆盖）', () => {
    const backup = makeV5Backup({
      sources: [
        {
          id: 'src_1',
          title: '数据结构',
          fileName: 'ds.pdf',
          kind: 'pdf',
          courseId: null,
          pageCount: 50,
          byteSize: 1024,
          textStatus: 'ready',
          segmentCount: 50,
          fileStored: true,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    });
    const migrated = migrateBackup(backup as unknown as LibraryBackup);
    expect(migrated.sources[0].fileStored).toBe(true);
  });

  it('旧页面补 figure=null，不补空对象', () => {
    const migrated = migrateBackup(makeV5Backup() as unknown as LibraryBackup);
    const pages = migrated.slideDecks[0].pages;

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.figure).toBeNull();
    }
  });

  it('原有的页内容与角度不被迁移破坏', () => {
    const migrated = migrateBackup(makeV5Backup() as unknown as LibraryBackup);
    const pages = migrated.slideDecks[0].pages;

    expect(pages[0].layout).toBe('title');
    expect(pages[1].bullets).toHaveLength(1);
    expect(pages[1].bullets[0].text).toBe('要点');
  });

  it('slideDecks 非数组时退化为空数组而不是抛错', () => {
    const migrated = migrateBackup(makeV5Backup({ slideDecks: null }) as unknown as LibraryBackup);
    expect(migrated.slideDecks).toEqual([]);
  });

  it('v5 备份能真正导入学习库', async () => {
    const storage = new MemoryStorage();
    const service = new LibraryService(storage);
    await service.create('目标');

    const meta = await service.importBackup(makeV5Backup());
    expect(meta.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);

    const decks = await storage.getAll('slideDecks');
    expect(decks).toHaveLength(1);
    expect(decks[0].pages).toHaveLength(2);
    expect(decks[0].pages[1].figure).toBeNull();

    const sources = await storage.getAll('sources');
    expect(sources[0].fileStored).toBe(false);
  });

  it('v1 备份能一路升到 v6，且资料不会被伪造 fileStored', () => {
    const migrated = migrateBackup(makeV1Backup() as unknown as LibraryBackup);

    expect(migrated.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    for (const s of migrated.sources) {
      expect(s.fileStored).toBe(false);
    }
  });
});
