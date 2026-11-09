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

  /**
   * v5 → v6
   *
   * P4 收尾补两件事，都只做加法：
   *  - Source.fileStored：旧资料的原始字节从来没有存过，一律 false，
   *    界面据此关闭图文页入口。
   *  - SlideOutlinePage.figure：旧大纲的页都没有图，一律 null。
   *
   * 刻意**不为旧资料伪造 fileStored=true**：那会让用户点开图文页才发现
   * 「这份资料没有原始文件」，而提示语只能说「请重新导入」——
   * 一开始就如实标 false，界面直接把入口置灰并写清原因，才是诚实的做法。
   */
  5: (backup) => {
    const sources = Array.isArray(backup.sources) ? (backup.sources as Record<string, unknown>[]) : [];
    const decks = Array.isArray(backup.slideDecks)
      ? (backup.slideDecks as Record<string, unknown>[])
      : [];

    return {
      ...backup,
      schemaVersion: 6,
      sources: sources.map((s) => ({
        ...s,
        // 旧库从没存过原始字节，如实标 false
        fileStored: s.fileStored === true,
      })),
      slideDecks: decks.map((d) => ({
        ...d,
        pages: Array.isArray(d.pages)
          ? (d.pages as Record<string, unknown>[]).map((pg) => ({
              ...pg,
              // 旧页没有配图，补 null（不是空对象：空对象会被当成「有图但数据坏了」）
              figure: pg.figure ?? null,
            }))
          : [],
      })),
    };
  },

  /**
   * v6 → v7
   *
   * v7 新增 usageRecords（用量统计）。旧库没有这个分区的数据，补空数组即可。
   *
   * **刻意不根据现有的 generationRuns 回填**：那张表只有「整理知识点」的用量，
   * 出题的 token 从来没记过，被删资料的任务也没了。拿它回填出来的账单是残缺的，
   * 而残缺的账单比空账单更危险——用户会以为「这就是我花掉的」，实际少了一半。
   * 空账单至少诚实：从这一版开始记，之前的不算。
   */
  6: (backup) => ({
    ...backup,
    schemaVersion: 7,
    usageRecords: [],
  }),

  /**
   * v7 → v8
   *
   * v8 从 `BackendConfig.capabilities` 里摘掉了 `webSearch`（联网检索）。
   *
   * 原因：它从来没有被读取过。OpenAI 兼容接口没有统一的联网检索写法
   * （智谱有 web_search 工具、DeepSeek 没有，各家形状都不一样），
   * 所以设置页那个勾选框点了也不会有任何事发生 —— 假开关比没有开关更糟。
   *
   * 这里**删字段而不是留空值**：留一个 `webSearch: false` 会让下一个人
   * 以为「接上就能用」，于是又照着它做一遍没人读的界面。
   * 删掉才是真正的「摘掉」。
   */
  7: (backup) => {
    const backends = Array.isArray(backup.backends)
      ? (backup.backends as Record<string, unknown>[])
      : [];

    return {
      ...backup,
      schemaVersion: 8,
      backends: backends.map((b) => {
        const caps =
          b.capabilities && typeof b.capabilities === 'object'
            ? { ...(b.capabilities as Record<string, unknown>) }
            : {};
        delete caps.webSearch;
        return { ...b, capabilities: caps };
      }),
    };
  },

  /**
   * v8 → v9
   *
   * v9 两件新东西，都只做加法：
   *  - `slideImages` 分区：用户插入 PPT 的图片。旧库没有，补空数组。
   *  - `SlideDeck.theme`：配色主题 id。旧 PPT 一律按默认主题，
   *    与它们当初导出的样子一致（默认主题就是原本写死的那套配色）。
   *  - `SlideOutlinePage.overlays`：自由摆放的叠加内容。旧页没有，不补字段，
   *    渲染层把 undefined 当「没有叠加内容」，等价于空数组。
   *
   * 刻意**不伪造 theme**：给旧 PPT 标上别的主题，会让人打开一份
   * 自己记得是深蓝的课件发现变成墨绿，而且不知道为什么会变。
   */
  8: (backup) => {
    const decks = Array.isArray(backup.slideDecks)
      ? (backup.slideDecks as Record<string, unknown>[])
      : [];

    return {
      ...backup,
      schemaVersion: 9,
      slideDecks: decks.map((d) => ({
        ...d,
        theme: typeof d.theme === 'string' ? d.theme : 'business-blue',
      })),
      slideImages: [],
    };
  },

  /**
   * v9 → v10
   *
   * PPT 的输入源从「知识点」改成「资料原文」，角标的出处也跟着换了：
   * 旧版 `SlideCitation` 有 `knowledgePointId`，新版是 `segmentId`。
   *
   * 迁移只能做到「不让旧备份打不开」：
   *
   *  - 旧角标确实来自知识点，硬塞一个 segmentId 是**编造**——
   *    那会让人点回原文时落到一段无关的正文上，比没有角标更糟。
   *    所以给空字符串，渲染层会当成「这条出处已失效」而不显示成可点的样子。
   *  - `knowledgePointId` 保留不删：它是旧数据里唯一真实的溯源信息，
   *    删掉就真的什么都查不回来了。
   *
   * 旧 PPT 的正文内容本身不受影响，只是角标不能再点回原文。
   * 如果要完整的出处，用新版重新生成一份 —— 这也是改输入源的必然代价。
   */
  9: (backup) => {
    const decks = Array.isArray(backup.slideDecks)
      ? (backup.slideDecks as Record<string, unknown>[])
      : [];

    return {
      ...backup,
      schemaVersion: 10,
      slideDecks: decks.map((d) => {
        const citations = Array.isArray(d.citations)
          ? (d.citations as Record<string, unknown>[])
          : [];

        return {
          ...d,
          citations: citations.map((c) => ({
            ...c,
            // 旧数据没有 segmentId；空串表示「出处已失效」，不编造
            segmentId: typeof c.segmentId === 'string' ? c.segmentId : '',
          })),
        };
      }),
    };
  },

  /**
   * v10 → v11
   *
   * 新增 `notes`（学习笔记）分区。
   *
   * 只做加法：旧备份没有这个字段，补一个空数组。
   * **绝不造内容** —— 不能因为「笔记区是空的不好看」就塞一条示例进来，
   * 用户会把那当成自己写过的。
   *
   * 为什么不给旧备份里的题目/知识点补空笔记：
   * 笔记是用户主动写的，没有就是没有。补出来只会让「有没有写过笔记」
   * 这个判断永远为真，之后就没法靠它筛选了。
   */
  10: (backup) => ({
    ...backup,
    schemaVersion: 11,
    notes: Array.isArray(backup.notes) ? backup.notes : [],
  }),

  /**
   * v11 → v12
   *
   * 新增 `examAttempts`（模拟考试记录）。
   *
   * 同样只做加法、不造内容：旧备份里没有考试记录，
   * 补空数组即可。**绝不能补一条示例成绩** ——
   * 用户会把它当成自己考过的分数，那比没有更糟。
   */
  11: (backup) => ({
    ...backup,
    schemaVersion: 12,
    examAttempts: Array.isArray(backup.examAttempts) ? backup.examAttempts : [],
  }),

  /**
   * v12 → v13
   *
   * 新增 `todos`（待办）。
   *
   * 只做加法：旧备份补空数组。
   * 同样不造内容 —— 待办是用户自己排的计划，
   * 塞一条示例进去会被当成真的待办，比空着更糟。
   */
  12: (backup) => ({
    ...backup,
    schemaVersion: 13,
    todos: Array.isArray(backup.todos) ? backup.todos : [],
  }),

  /**
   * v13 → v14
   *
   * 新增 `focusSessions`（专注记录 / 番茄钟）。
   *
   * 只做加法：旧备份补空数组。同样不造内容 ——
   * 伪造一条「今天专注了 25 分钟」比空着更糟，用户会以为是真的。
   */
  13: (backup) => ({
    ...backup,
    schemaVersion: 14,
    focusSessions: Array.isArray(backup.focusSessions) ? backup.focusSessions : [],
  }),

  /**
   * v14 → v15
   *
   * 新增 `sourceImages`（正文里的插图，MinerU 转换出来的，2026-11-08）。
   *
   * ⚠️ 这一条与前面几条**性质不同**，别照抄前几条的注释就改：
   * 前面补的都是「用户自己的数据」，而 sourceImages **不进备份**
   * （理由见 storage/types.ts —— 能从原 PDF 按 bbox 重新裁，
   * 几百页的书塞进备份会撑到不可用）。
   *
   * 那为什么还补一个空数组？因为旧备份里**根本没有这个键**，
   * 导入方若按 `backup.sourceImages.length` 遍历会拿到 undefined 而崩。
   * 补空数组是为了让结构完整，不是为了塞数据。
   *
   * 更**不能**在这里造几张图 —— 图是二进制，造不出来；
   * 假装有会让阅读器渲染出一堆破图，比没有更糟。
   */
  14: (backup) => ({
    ...backup,
    schemaVersion: 15,
    sourceImages: Array.isArray(backup.sourceImages) ? backup.sourceImages : [],
  }),

  /**
   * v15 → v16
   *
   * 新增 `trash`（回收站，2026-11-08）。
   *
   * 补空数组：旧备份里没有这个键，用户升级后回收站应该是**空的** ——
   * 因为升级前删掉的东西确实已经没了，不能假装它们还躺在回收站里。
   *
   * 这一条不造任何内容，也不去猜「哪些记录可能被删过」：
   * 那样会把现存数据错误地搬进回收站，等于凭空让用户少东西。
   */
  15: (backup) => ({
    ...backup,
    schemaVersion: 16,
    trash: Array.isArray(backup.trash) ? backup.trash : [],
  }),

  /**
   * v16 → v17
   *
   * 给题目的锚点补 `segmentId`（2026-11-09）。
   *
   * ## 为什么要补
   *
   * 在此之前，题目出处只靠 `sourceId + page + charStart/charEnd` 定位。
   * 而 **page 在一份资料里不唯一**：按章节切分的资料里 `page = index`，
   * 一个章节跨多页时，同一个 page 可能对应多段。定位只能取「第一个 page
   * 匹配的段落」—— 猜错就圈到别的段，而界面上看着都像对的。
   *
   * 实测用户库里 10 道题**全部**没有 segmentId。
   *
   * ## 回填策略：只填能确定的，不猜
   *
   * 对每条锚点，找 `sourceSegments` 里 `sourceId` 与 `page` 都匹配的段落：
   *  - **恰好一条** → 填它的 id（确定无疑）
   *  - **零条或多条** → 留空，不填
   *
   * 多条时为什么不挑第一条：那正是现在行为里的猜测，也正是要修的问题。
   * 迁移里再猜一次等于把错误固化进数据；留空让读取方退回 page 定位，
   * 行为不比现在差，而且不会假装精确。
   *
   * ## 不碰别的东西
   *
   * 不填 `quote`：旧题根本没有「这道题用到了哪句话」的信息。
   * 造一个引文会让「精确高亮」变成假的 —— 宁可它被判成块级。
   */
  16: (backup) => {
    const segments = Array.isArray(backup.sourceSegments)
      ? (backup.sourceSegments as Array<Record<string, unknown>>)
      : [];
    const questions = Array.isArray(backup.questions)
      ? (backup.questions as Array<Record<string, unknown>>)
      : [];

    /* (sourceId::page) → 段落 id 列表。用列表而不是单值，才能发现「不唯一」 */
    const byPage = new Map<string, string[]>();
    for (const s of segments) {
      const sid = typeof s.sourceId === 'string' ? s.sourceId : '';
      const page = typeof s.page === 'number' ? s.page : null;
      const id = typeof s.id === 'string' ? s.id : '';
      if (!sid || !id || page === null) continue;
      const key = sid + '::' + page;
      const arr = byPage.get(key);
      if (arr) arr.push(id);
      else byPage.set(key, [id]);
    }

    const migratedQuestions = questions.map((q) => {
      const anchors = Array.isArray(q.anchors)
        ? (q.anchors as Array<Record<string, unknown>>)
        : [];

      const nextAnchors = anchors.map((a) => {
        /* 已有 segmentId 的原样保留（重复迁移时幂等） */
        if (typeof a.segmentId === 'string' && a.segmentId) return a;

        const sid = typeof a.sourceId === 'string' ? a.sourceId : '';
        const page = typeof a.page === 'number' ? a.page : null;
        if (!sid || page === null) return a;

        const candidates = byPage.get(sid + '::' + page);
        if (!candidates || candidates.length !== 1) return a;

        return { ...a, segmentId: candidates[0] };
      });

      return { ...q, anchors: nextAnchors };
    });

    return {
      ...backup,
      schemaVersion: 17,
      questions: migratedQuestions,
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
