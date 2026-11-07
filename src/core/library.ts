import { newId, nowIso } from './id.ts';
import { DEFAULT_SETTINGS, LIBRARY_SCHEMA_VERSION } from './model.ts';
import type { AppSettings, LibraryBackup, LibraryMeta } from './model.ts';
import { migrateBackup } from './migrations.ts';
import { normalizeGradingRules } from '../v2/core/grading.ts';
import type { StorageAdapter, StoreSnapshot, BackupStoreName } from './storage/types.ts';
import { BACKUP_STORES } from './storage/types.ts';

const META_ID = 'library';
const SETTINGS_ID = 'app';

/** 导入/建库过程中可以直接给用户看的原因，携带可操作提示 */
export class LibraryError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

/**
 * 学习库用例层。
 *
 * 上层界面只跟这里打交道，不直接碰 StorageAdapter ——
 * 这样 P1 之后换存储（比如把大文件挪到 OPFS/Tauri fs）不需要改界面。
 */
export class LibraryService {
  constructor(private readonly storage: StorageAdapter) {}

  async init(): Promise<void> {
    await this.storage.init();
  }

  /** 读取库元信息；库还不存在时返回 null（用于判断「是否已建库」） */
  async getMeta(): Promise<LibraryMeta | null> {
    return this.storage.get('meta', META_ID);
  }

  /**
   * 建一个新的空学习库。
   *
   * 幂等：已有库时直接返回现有元信息，不覆盖——
   * 用户点「新建」不该意外清空手上的资料。
   */
  async create(name: string): Promise<LibraryMeta> {
    const existing = await this.getMeta();
    if (existing) return existing;

    const ts = nowIso();
    const meta: LibraryMeta = {
      id: META_ID,
      name: name.trim() || '我的学习库',
      createdAt: ts,
      updatedAt: ts,
      schemaVersion: LIBRARY_SCHEMA_VERSION,
    };
    await this.storage.put('meta', meta);
    await this.storage.put('settings', { ...DEFAULT_SETTINGS, id: SETTINGS_ID });
    return meta;
  }

  async rename(name: string): Promise<LibraryMeta> {
    const meta = await this.requireMeta();
    const next: LibraryMeta = { ...meta, name: name.trim() || meta.name, updatedAt: nowIso() };
    await this.storage.put('meta', next);
    return next;
  }

  async getSettings(): Promise<AppSettings> {
    const row = await this.storage.get('settings', SETTINGS_ID);
    if (!row) return { ...DEFAULT_SETTINGS, gradingRules: { ...DEFAULT_SETTINGS.gradingRules, perKind: {} } };
    // settings 分区存的是带 id 的记录（分区统一以 id 为主键），对上层剥掉 id
    const { id: _id, ...rest } = row;
    /*
     * gradingRules 必须过一遍 normalize，不能只靠 `{...DEFAULT, ...rest}`。
     *
     * 原因：旧库里这条记录的 gradingRules 字段**根本不存在**，
     * 展开后得到的是 undefined 而不是默认值（`...rest` 里没有这个键，
     * 但 record 里呈现为 undefined 时同样是 undefined）。
     * 更糟的是「存在但形状不对」（被人手改过备份）：展开会原样带出来，
     * 于是界面上出现一个不存在的宽容度。normalize 两种情况都收敛到默认。
     */
    return {
      ...DEFAULT_SETTINGS,
      ...rest,
      gradingRules: normalizeGradingRules((rest as Partial<AppSettings>).gradingRules),
    };
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await this.storage.put('settings', { ...next, id: SETTINGS_ID });
    return next;
  }

  /** 各分区条数，给界面显示「库里有东西没有」与备份摘要用 */
  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const store of BACKUP_STORES) {
      out[store] = (await this.storage.getAll(store)).length;
    }
    return out;
  }

  /**
   * 导出整个学习库为备份对象。
   *
   * 刻意不含 secrets：P5 验收要求凭据不出现在导出文件里。
   * 这里不是「导出时过滤掉」，而是 secrets 根本不在 snapshot 里。
   */
  async exportBackup(): Promise<LibraryBackup> {
    const meta = await this.requireMeta();
    const settings = await this.getSettings();
    const snapshot = await this.storage.readAll();

    // 分区清单同样以 BACKUP_STORES 为准（见 validateBackup 里的说明）。
    // 这样「导出有、导入丢」这类漂移从结构上就不可能发生。
    return {
      format: 'openleaner-library',
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      exportedAt: nowIso(),
      meta,
      settings,
      ...(Object.fromEntries(
        BACKUP_STORES.map((store) => [store, snapshot[store]]),
      ) as Record<BackupStoreName, unknown[]>),
    } as LibraryBackup;
  }

  /**
   * 从备份对象恢复到学习库。
   *
   * 原子：走 replaceAll，中途失败整库回滚（见 IndexedDbStorage.replaceAll）。
   * 校验失败时抛 LibraryError 并带可操作提示，而不是笼统「导入失败」。
   */
  async importBackup(raw: unknown): Promise<LibraryMeta> {
    // 校验在前（能给出可操作的提示），迁移在后（处理旧版本备份）。
    // 顺序不能反：对一个根本不是备份的 JSON 跑迁移，只会得到无意义的
    // 「缺少 v1→v2 迁移规则」这类提示，把用户带偏。
    const validated = validateBackup(raw);
    const backup = migrateBackup(validated);

    const snapshot = {} as StoreSnapshot;
    for (const store of BACKUP_STORES) {
      snapshot[store] = (backup[store] ?? []) as never;
    }

    await this.storage.replaceAll(snapshot);

    // 备份里的 meta/settings 落在分区外，需要单独落库
    const meta: LibraryMeta = {
      ...backup.meta,
      id: META_ID,
      updatedAt: nowIso(),
      schemaVersion: LIBRARY_SCHEMA_VERSION,
    };
    await this.storage.put('meta', meta);
    // 备份里的 settings 是纯设置（不含 id），落库时补上分区主键；
    // 未知字段不保留，避免旧版本残留字段污染当前结构。
    await this.storage.put('settings', {
      locale: backup.settings?.locale ?? DEFAULT_SETTINGS.locale,
      questionLanguage: backup.settings?.questionLanguage ?? DEFAULT_SETTINGS.questionLanguage,
      onboarded: backup.settings?.onboarded ?? DEFAULT_SETTINGS.onboarded,
      /*
       * 评分规则要显式带上，不能只列前三个字段。
       *
       * 这里原来是「逐字段白名单」，漏一个新字段的后果是：
       * 用户恢复备份后自定义评分悄悄退回默认，而备份文件里明明存着 ——
       * 属于「数据在、但没生效」的那类最难发现的问题。
       * 用 normalize 兜底：旧备份没有这个字段时得到默认值，不会变成 undefined。
       */
      gradingRules: normalizeGradingRules(backup.settings?.gradingRules),
      id: SETTINGS_ID,
    });

    return meta;
  }

  /** 清空整个学习库（含凭据）。仅在用户明确要求时调用。 */
  async reset(): Promise<void> {
    const snapshot = {} as StoreSnapshot;
    for (const store of BACKUP_STORES) snapshot[store] = [] as never;
    await this.storage.replaceAll(snapshot);
    await this.storage.clear('meta');
    await this.storage.clear('settings');
  }

  private async requireMeta(): Promise<LibraryMeta> {
    const meta = await this.getMeta();
    if (!meta) {
      throw new LibraryError('还没有学习库', '请先在设置页创建一个学习库');
    }
    return meta;
  }
}

/**
 * 备份文件校验。
 *
 * 检查的是「这确实是我们导出的文件」与「版本我们读得懂」，
 * 而不是逐字段严格校验——字段校验交给迁移与使用处，
 * 否则以后加字段就得回头改这里。
 */
export function validateBackup(raw: unknown): LibraryBackup {
  if (typeof raw !== 'object' || raw === null) {
    throw new LibraryError('备份文件内容为空或不是有效文件', '请选择本应用导出的 .json 备份文件');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.format !== 'openleaner-library') {
    throw new LibraryError(
      '这不是本应用的学习库备份文件',
      '请选择由「导出学习库」生成的文件；其他 JSON 文件无法识别',
    );
  }

  const version = obj.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new LibraryError('备份文件缺少版本信息', '文件可能已损坏，请换一份备份重试');
  }
  if (version > LIBRARY_SCHEMA_VERSION) {
    throw new LibraryError(
      `备份文件来自更新版本的应用（v${version}），当前支持到 v${LIBRARY_SCHEMA_VERSION}`,
      '请升级应用后再导入这份备份',
    );
  }

  if (typeof obj.meta !== 'object' || obj.meta === null) {
    throw new LibraryError('备份文件缺少学习库信息', '文件可能不完整，请重新导出后再试');
  }

  return {
    format: 'openleaner-library',
    schemaVersion: version,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : nowIso(),
    meta: obj.meta as LibraryMeta,
    settings: (obj.settings as AppSettings) ?? DEFAULT_SETTINGS,
    // 逐个分区从对象里搬过来，而不是在这里再抄一份清单。
    // 抄清单就会漂：2026-11-06 之前这里漏了 sourceSegments / sourceAnnotations /
    // reviewRecords / reviewLogs / slideImages / usageRecords 六个分区，
    // 于是「恢复备份」会把正文、批注、复习进度、PPT 图片、用量统计全部清空，
    // 而且因为 replaceAll 是整库替换，用户也不会收到任何提示。
    // 现在以 BACKUP_STORES 为唯一清单：以后加分区只需改那一处。
    ...(Object.fromEntries(
      BACKUP_STORES.map((store) => [store, asArray(obj[store])]),
    ) as Record<BackupStoreName, unknown[]>),
  } as LibraryBackup;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 备份文件名：带日期，便于用户区分多份备份 */
export function backupFileName(meta: LibraryMeta): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  const safe = meta.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '学习库';
  return `${safe}-${stamp}.openleaner.json`;
}

export { newId };
