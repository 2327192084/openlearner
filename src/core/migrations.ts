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

  /**
   * v3 → v4（P3 引入）
   *
   * Deck 新增：sourceId / backendId / questionCount / blockingIssues / publishedAt
   * Question 彻底重塑：新增 options / knowledgePointId / cognitiveLevel / topic / order，
   *                    并新增 answerRecords 分区
   *
   * 关键判断：v3 时期的 Deck/Question 只是 P0 占位，**从未真正产生过数据**
   * （P3 之前没有任何地方写入这两张表，界面上也是「待接入」）。
   * 所以这里不需要为旧记录做复杂推断 —— 但仍然要保证字段齐全，
   * 否则一旦真有残留数据，导入后读字段就是 undefined。
   *
   * 对已存在的旧题目，一律标为 blocking（缺选项、缺出处、缺层级），
   * 让它们无法通过发布校验 —— 这比伪造默认值让它「看起来能用」安全。
   */
  3: (backup) => {
    const decks = Array.isArray(backup.decks) ? (backup.decks as Record<string, unknown>[]) : [];
    const questions = Array.isArray(backup.questions)
      ? (backup.questions as Record<string, unknown>[])
      : [];

    const migratedDecks = decks.map((d) => ({
      ...d,
      sourceId: d.sourceId ?? null,
      backendId: d.backendId ?? null,
      questionCount: typeof d.questionCount === 'number' ? d.questionCount : 0,
      // 旧草稿的校验状态未知，标成 1 逼用户重跑一次校验再发布
      blockingIssues: typeof d.blockingIssues === 'number' ? d.blockingIssues : 1,
      publishedAt: d.publishedAt ?? null,
    }));

    const migratedQuestions = questions.map((q, i) => ({
      ...q,
      options: Array.isArray(q.options) ? q.options : [],
      knowledgePointId: q.knowledgePointId ?? null,
      cognitiveLevel: typeof q.cognitiveLevel === 'string' ? q.cognitiveLevel : 'understand',
      topic: q.topic ?? null,
      order: typeof q.order === 'number' ? q.order : i,
      updatedAt: q.updatedAt ?? q.createdAt ?? new Date().toISOString(),
    }));

    return {
      ...backup,
      schemaVersion: 4,
      decks: migratedDecks,
      questions: migratedQuestions,
      answerRecords: Array.isArray(backup.answerRecords) ? backup.answerRecords : [],
    };
  },

  /**
   * v4 → v5（P4 引入）
   *
   * SlideDeck 从 5 个字段的占位版重写成完整结构：
   * 新增 pages / citations / exports / courseId / status，
   * 并新增 sourceId 之外的引用表。
   *
   * 关键判断：v4 时期的 slideDecks **从未被写入过**
   * （P4 之前「学习 PPT」页是「待接入」占位，没有任何代码写这张表）。
   * 所以这里不需要推断旧结构 —— 但仍要把字段补齐：
   * 一旦真有残留数据（比如用户从别处导入过备份），读字段才不会是 undefined。
   *
   * 对残留的空壳一律标成 outline + 空页表。
   * 不补一个假封面页：那会让用户看到一份「有 1 页但不记得建过」的 PPT。
   */
  4: (backup) => {
    const decks = Array.isArray(backup.slideDecks)
      ? (backup.slideDecks as Record<string, unknown>[])
      : [];

    const migratedDecks = decks.map((d) => ({
      ...d,
      courseId: d.courseId ?? null,
      sourceId: d.sourceId ?? null,
      status: d.status === 'ready' ? 'ready' : 'outline',
      pages: Array.isArray(d.pages) ? d.pages : [],
      citations: Array.isArray(d.citations) ? d.citations : [],
      exports: Array.isArray(d.exports) ? d.exports : [],
      createdAt: d.createdAt ?? new Date().toISOString(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date().toISOString(),
    }));

    return {
      ...backup,
      schemaVersion: 5,
      slideDecks: migratedDecks,
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
