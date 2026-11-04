import { LIBRARY_SCHEMA_VERSION } from './model.ts';
import type { LibraryBackup, Source } from './model.ts';

/**
 * 备份文件版本迁移。
 *
 * 为什么必须有这一层：P0 已经交付、可能已经有人导过 v1 备份。
 * 把 LIBRARY_SCHEMA_VERSION 从 1 提到 2（新增 sourceSegments 与 Source 的两个字段）
 * 之后，如果导入时只认 v2，那些备份就都废了 —— 而用户的资料是他们最不该丢的东西。
 *
 * 原则：**迁移只做加法**。旧备份缺的字段补默认值，不清空、不删记录。
 */

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** 迁移函数表：key 是**源版本**，值为「从该版本升到下一版」的处理 */
type Migration = (backup: Record<string, unknown>) => Record<string, unknown>;

const migrations: Record<number, Migration> = {
  /**
   * v1 → v2
   *
   * v1 里 Source 没有 textStatus / segmentCount，也没有 sourceSegments 分区。
   * 这些资料在 P0 只存了元信息、正文从未落库，所以迁移后它们的状态是
   * 「有记录但无正文」，用 segmentCount = 0 表达，界面据此提示「需要重新导入」。
   *
   * 刻意**不伪造正文**：宁可让用户重导一次，也不能凭空造出能点开的假原文。
   */
  1: (backup) => {
    const sources = Array.isArray(backup.sources) ? (backup.sources as Source[]) : [];

    const migratedSources = sources.map((s) => ({
      ...s,
      // v1 的资料都没有正文，如实标 0，界面会提示重新导入
      textStatus: 'ready' as const,
      segmentCount: 0,
    }));

    return {
      ...backup,
      schemaVersion: 2,
      sources: migratedSources,
      // v1 没有这个分区，补空数组（不要留 undefined，否则 stringify 会丢键）
      sourceSegments: [],
    };
  },

  /**
   * v2 → v3
   *
   * P2 给 KnowledgePoint 加了 anchorStatus / sourceId / backendId，
   * 并新增 generationRuns 分区。
   *
   * 对已有的知识点：按「有没有 anchors」推导 anchorStatus。
   * 这是唯一能从旧数据可靠推出的信息 —— 旧版本没有记录定位状态。
   * 有锚点的算 located，没锚点的算 unlocated（需要人看一眼），
   * 这比默认填 located 安全：把「不知道」当成「已确认」是更糟的错误。
   */
  2: (backup) => {
    const points = Array.isArray(backup.knowledgePoints)
      ? (backup.knowledgePoints as Record<string, unknown>[])
      : [];

    const migratedPoints = points.map((k) => {
      const anchors = Array.isArray(k.anchors) ? k.anchors : [];
      return {
        ...k,
        anchorStatus: anchors.length > 0 ? 'located' : 'unlocated',
        sourceId: k.sourceId ?? null,
        backendId: k.backendId ?? null,
      };
    });

    return {
      ...backup,
      schemaVersion: 3,
      knowledgePoints: migratedPoints,
      generationRuns: Array.isArray(backup.generationRuns) ? backup.generationRuns : [],
    };
  },
};

/**
 * 把任意版本的备份升到当前版本。
 *
 * 不认识的更高版本直接拒绝并提示升级 —— 猜字段语义比报错更危险。
 */
export function migrateBackup(backup: LibraryBackup): LibraryBackup {
  const from = backup.schemaVersion;

  if (from === LIBRARY_SCHEMA_VERSION) return backup;

  if (from > LIBRARY_SCHEMA_VERSION) {
    throw new MigrationError(
      `备份文件来自更新版本的应用（v${from}），当前支持到 v${LIBRARY_SCHEMA_VERSION}`,
      '请升级应用后再导入这份备份',
    );
  }

  if (from < 1) {
    throw new MigrationError(
      `备份文件版本号无效（v${from}）`,
      '文件可能已损坏。请重新导出后再试',
    );
  }

  let current = backup as unknown as Record<string, unknown>;
  let version = from;

  while (version < LIBRARY_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new MigrationError(
        `缺少 v${version} → v${version + 1} 的迁移规则`,
        '这是应用的缺陷，请反馈；你的原学习库未被改动',
      );
    }
    current = step(current);
    version += 1;
  }

  return current as unknown as LibraryBackup;
}
