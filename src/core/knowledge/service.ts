import { newId, nowIso } from '../id.ts';
import type { GenerationRun, KnowledgePoint, SourceSegment } from '../model.ts';
import type { SourceService } from '../sources.ts';
import type { StorageAdapter } from '../storage/types.ts';
import type { UsageService } from '../usage.ts';
import type { TrashService } from '../trash.ts';
import type {
  KnowledgeDraft,
  OrganizeBackend,
  OrganizeInputSegment,
} from './backend-types.ts';
import { locateQuotes } from './locator.ts';

/**
 * 手工录入/没有后端来源的条目在分组里用的标识。
 *
 * 用一个不可能与真实 backendId 撞的值：真实 id 由 newId('backend') 生成，
 * 形如 `backend_xxxx`，不会是下面这个字面量。
 */
export const MANUAL_BACKEND_ID = '__manual__';

/**
 * 某份资料里「一个后端产出的一批知识点」的概要。
 *
 * P5 第 4 条要求不同后端的结果并存对比，界面需要一个按后端分组的口径：
 * 光有 `listBySource` 的一长串条目，用户分不清是「软件重复生成了」
 * 还是「两个后端各产了一份」。
 */
export interface KnowledgeBackendSummary {
  backendId: string;
  count: number;
  located: number;
  unlocated: number;
  waived: number;
  /** 这批里最新一条的创建时间，用来在界面上标「最近一次」 */
  lastAt: string;
}


/**
 * 知识点服务：把资料整理成知识点，并保证每条都能指回原文。
 *
 * 职责边界很重要 —— 它**不做**的事：
 *   - 不直接调用任何模型（那是 OrganizeBackend 的事）
 *   - 不信任模型给出的任何位置信息（页码一律由定位器实测）
 * 它只负责编排：准备输入 → 调后端 → 定位 → 落库 → 汇报进度与用量。
 */

/**
 * 生成进度事件，界面据此更新进度条。
 *
 * ## 关于这些字段的语义（容易误用，写清楚）
 *
 * 后端是「逐条产出知识点」的，**不是「逐段推进」的** ——
 * 一段原文可能产出 0 条也可能产出 5 条，所以没有一个诚实的「已处理到第几段」。
 *
 * 早先这里叫 segmentIndex，取值是 `min(produced, segmentTotal)`，
 * 那既不是段进度也不是条进度，只是被 min 夹住的一个变形数字。
 * 拿来显示「已处理 N 段」就是假信息。
 *
 * 现在改成 `produced / estimatedTotal`：
 *   - produced：真实已产出条数（准确）
 *   - estimatedTotal：按每段约 3 条粗估的总条数（**明确是估算**）
 * 两个都是界面能如实说明的东西。段总数单独保留，用于「共 N 段资料」的文案。
 */
export interface GenerateProgress {
  /** 已产出的知识点条数（准确值） */
  produced: number;
  /** 按每段约 3 条粗估的总条数，用于算百分比。**是估算，不是事实** */
  estimatedTotal: number;
  /** 本次涉及的资料段总数（准确值），用于「共 N 段」文案 */
  segmentTotal: number;
  /** 定位失败的条数（实时累计） */
  unlocated: number;
}

export interface GenerateOptions {
  sourceId: string;
  /** 页码范围，null 表示整份 */
  pageRange?: { from: number; to: number } | null;
  backend: OrganizeBackend;
  onProgress?: (p: GenerateProgress) => void;
  /** 用于中途停止 */
  signal: AbortSignal;
}

/** 一次生成的结果 */
export interface GenerateOutcome {
  run: GenerationRun;
  points: KnowledgePoint[];
}

export class KnowledgeService {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly sources: SourceService,
    /**
     * 用量记账，可选。
     *
     * 可选而不是必填：这个服务在 20 多处测试里被 `new KnowledgeService(storage, sources)` 构造，
     * 为了记账逼所有测试改签名不值得。不传就是把记账关掉，业务行为完全一致。
     */
    private readonly usage?: UsageService,
    /**
     * 回收站（2026-11-08），可选。
     *
     * 与 usage 同理：二十多处测试用两参数构造这个服务，
     * 为了回收站逼所有测试改签名不值得。不传就是删除不可恢复。
     */
    private readonly trash?: TrashService,
  ) {}

  /**
   * 取全部知识点（2026-11-08 加）。
   *
   * 加这个是因为「删除没有归属资料的那组知识点」需要它 ——
   * 知识库页里「已删除的资料」那一组的 sourceId 是 null，
   * 不能按 sourceId 查，只能取全量再筛。
   *
   * 排序与 listBySource 一致（页 + 偏移），这样两个入口看到的顺序相同。
   */
  async listAll(): Promise<KnowledgePoint[]> {
    const all = await this.storage.getAll('knowledgePoints');
    return all.sort((a, b) => {
      const pa = a.anchors[0]?.page ?? Number.MAX_SAFE_INTEGER;
      const pb = b.anchors[0]?.page ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return (a.anchors[0]?.charStart ?? 0) - (b.anchors[0]?.charStart ?? 0);
    });
  }

  /** 取某份资料的全部知识点（按页码+偏移排序，与原文顺序一致） */
  async listBySource(sourceId: string): Promise<KnowledgePoint[]> {
    const all = await this.storage.getAll('knowledgePoints');
    return all
      .filter((k) => k.sourceId === sourceId)
      .sort((a, b) => {
        const pa = a.anchors[0]?.page ?? Number.MAX_SAFE_INTEGER;
        const pb = b.anchors[0]?.page ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        const ca = a.anchors[0]?.charStart ?? 0;
        const cb = b.anchors[0]?.charStart ?? 0;
        return ca - cb;
      });
  }

  /**
   * 按后端拆开列出结果。
   *
   * 计划书 P5 第 4 条要求「同一份资料用不同后端整理的结果能并存对比」，
   * 所以 `listBySource` 返回的是**全部后端合起来**的条目 ——
   * 界面必须能知道哪些条目来自哪个后端，否则两份「线性表是…」混在一列里，
   * 用户只会以为软件重复生成了。
   *
   * 返回顺序按条数从多到少：多数情况下用户想先看产得多的那份。
   *
   * `backendId` 可能是 null（手工录入的条目没有后端），
   * 这类单独归到 MANUAL_BACKEND_ID 一组 —— 混进任何一个后端组里
   * 都会让「这组是模型产出的」这个判断失真。
   */
  async listBackends(sourceId: string): Promise<KnowledgeBackendSummary[]> {
    const points = await this.listBySource(sourceId);
    const map = new Map<string, KnowledgeBackendSummary>();

    for (const p of points) {
      const key = p.backendId ?? MANUAL_BACKEND_ID;
      const item =
        map.get(key) ??
        ({
          backendId: key,
          count: 0,
          located: 0,
          unlocated: 0,
          waived: 0,
          lastAt: p.createdAt,
        } satisfies KnowledgeBackendSummary);
      item.count += 1;
      if (p.anchorStatus === 'located') item.located += 1;
      else if (p.anchorStatus === 'unlocated') item.unlocated += 1;
      else item.waived += 1;
      if (p.createdAt > item.lastAt) item.lastAt = p.createdAt;
      map.set(key, item);
    }

    return [...map.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.backendId.localeCompare(b.backendId);
    });
  }

  /** 取某份资料里某个后端产出的知识点（不传后端 = 全部） */
  async listBySourceAndBackend(
    sourceId: string,
    backendId: string | null = null,
  ): Promise<KnowledgePoint[]> {
    const all = await this.listBySource(sourceId);
    return backendId === null ? all : all.filter((k) => k.backendId === backendId);
  }

  async get(id: string): Promise<KnowledgePoint | null> {
    return this.storage.get('knowledgePoints', id);
  }

  /**
   * 全部生成记录（整理知识点 + 出题），按开始时间倒序。
   *
   * 为什么加这个方法而不是让「任务」页自己连 IndexedDB：
   *  - 页面直连数据库会绕过 StorageAdapter，测试里（MemoryStorage）跑不起来；
   *  - DB 名与版本号会被复制到界面层，将来升级 schema 要改两处；
   *  - 只读查询也该收敛到服务层，和 `latestRun` 放在一起。
   *
   * 只读，不改任何状态。
   */
  /** 取全部运行记录（2026-11-08 加，任务页读它） */
  async listRuns(): Promise<GenerationRun[]> {
    const runs = await this.storage.getAll('generationRuns');
    return runs.sort((a, b) => {
      const ta = new Date(a.startedAt).getTime();
      const tb = new Date(b.startedAt).getTime();
      /* 时间相同（同一毫秒）时保持稳定顺序，避免列表抖动 */
      if (ta === tb) return a.id < b.id ? 1 : -1;
      return tb - ta;
    });
  }

  /**
   * 删除一条运行记录（2026-11-08）。
   *
   * 只删**记录**，不动知识点与题目 —— 用户想清掉一条失败历史时，
   * 不该顺手把他的劳动成果也删了。
   *
   * 进回收站：这类记录本身价值不大，但「误删了想看看当时为什么失败」
   * 是真会发生的，而且记录只有几十字节，存着不亏。
   */
  async removeRun(id: string): Promise<void> {
    const existing = await this.storage.get('generationRuns', id);
    if (!existing) return;
    await this.trash?.moveToTrash([
      {
        kind: 'generationRuns',
        title: existing.kind === 'questions' ? '出题记录' : '整理记录',
        summary:
          existing.status === 'failed'
            ? '失败'
            : existing.status === 'stopped'
              ? '已停止'
              : '完成',
        payload: existing,
      },
    ]);
    await this.storage.remove('generationRuns', id);
  }

  /**
   * 清空全部运行记录（2026-11-08）。
   *
   * 合成**一条**回收站记录：用户清 20 条历史是为了「眼不见」，
   * 不是想把回收站也塞满 20 行。还原时整体回来。
   */
  async clearRuns(): Promise<number> {
    const all = await this.storage.getAll('generationRuns');
    if (all.length === 0) return 0;

    await this.trash?.moveToTrash([
      {
        kind: 'generationRuns',
        title: '全部任务记录',
        summary: `${all.length} 条`,
        payload: all[0],
      },
      ...all.slice(1).map((r) => ({
        kind: 'generationRuns' as const,
        title: '',
        summary: '',
        payload: r,
      })),
    ]);

    for (const r of all) await this.storage.remove('generationRuns', r.id);
    return all.length;
  }

  /**
   * 取某份资料最近一次的生成记录。
   *
   * 界面需要它来显示「上次整理：产出 N 条、其中 M 条待处理、用了 X tokens」。
   * 早先界面只能在内存里记本次 run，**刷新后这行就消失了** ——
   * 用户会以为记录丢了。放进库里才能持久。
   */
  async latestRun(sourceId: string): Promise<GenerationRun | null> {
    const runs = await this.storage.getAll('generationRuns');
    const mine = runs.filter((r) => r.sourceId === sourceId);
    if (mine.length === 0) return null;

    return mine.sort((a, b) => {
      const ta = new Date(a.startedAt).getTime();
      const tb = new Date(b.startedAt).getTime();
      return tb - ta;
    })[0];
  }

  /**
   * 生成前估算用量，供界面显示（P2 要求）。
   *
   * 只依赖段落文本与后端，不需要 Source 元信息 ——
   * 早先版本多收了一个 source 参数但从未使用，去掉免得调用方以为它有用。
   */
  estimate(segments: SourceSegment[], backend: OrganizeBackend): number {
    const input = segments.map(toInputSegment);
    return backend.estimateTokens(input);
  }

  /**
   * 执行一次整理。
   *
   * 关键行为（都对应计划书 P2 的验收项）：
   *  - 逐条落库：中途停止时已产出的部分必须保留
   *  - 定位失败单独标记，不猜位置
   *  - 记录预计/实际用量
   */
  async generate(options: GenerateOptions): Promise<GenerateOutcome> {
    const source = await this.sources.get(options.sourceId);
    if (!source) {
      throw new Error('资料不存在，可能已被删除');
    }

    const allSegments = await this.sources.getSegments(options.sourceId);
    if (allSegments.length === 0) {
      throw new Error('这份资料没有可整理的正文（可能是扫描件）');
    }

    /**
     * 扫描件的段是存在的、但每段文本都是空的（能翻页但读不出字）。
     * 早先只检查 segments.length，扫描件会顺利通过，然后「生成」出 0 条，
     * 静默地什么都没发生 —— 用户会以为功能坏了却看不出原因。
     * 这里额外检查「有没有实质文字」，并给出可操作的说明。
     */
    const hasRealText = allSegments.some((s) => s.text.replace(/\s/g, '').length > 0);
    if (!hasRealText) {
      /**
       * 这里必须按 source.textStatus 分开说，因为两种情况的下一步完全不同：
       *
       *   - 扫描件：文件里本来就没字，用户该换电子版或等 OCR
       *   - 解码失败：文件里**有字**，是我们没读出来，该我们修
       *
       * 早先两种情况共用「这是扫描件，换一份电子版」这句话，
       * 对解码失败的用户是**错误的结论**：他手上的正是完好的电子版教材。
       */
      if (source.textStatus === 'decode-failed') {
        throw new Error(
          '这份资料里确实有文字，但没能解析出来（字体编码表缺失）。不是扫描件，不用换文件——' +
            '请把这份 PDF 反馈给我们，或先用「另存为」的方式重新导出一份再试。',
        );
      }
      throw new Error(
        '这份资料没有文字层（扫描件），无法整理出知识点。可以在资料阅读页用「看图模型」把它识别成文字（按页计费），或换一份电子版。',
      );
    }

    const segments = applyPageRange(allSegments, options.pageRange ?? null);
    if (segments.length === 0) {
      throw new Error('选定的范围内没有内容');
    }

    /**
     * 只清掉「同一个后端」上一次的结果，别动其他后端的。
     *
     * 这是「重新整理」的语义：用户点这个按钮，是想要这个后端给一份新的。
     * 但**换后端不该抹掉前一份** —— P5 第 4 条要求同一份资料用不同后端
     * 整理的结果能并存对比，早先这里调 clearBySource 清全部，
     * A 整理完换个后端整理一次，A 的结果就凭空消失了。
     */
    await this.clearBySourceAndBackend(options.sourceId, options.backend.id);

    const ts = nowIso();
    const runId = newId('run');
    const estimated = this.estimate(segments, options.backend);

    const run: GenerationRun = {
      id: runId,
      sourceId: options.sourceId,
      pageRange: options.pageRange ?? null,
      status: 'running',
      estimatedTokens: estimated,
      actualTokens: null,
      producedCount: 0,
      unlocatedCount: 0,
      error: null,
      backendId: options.backend.id,
      startedAt: ts,
      finishedAt: null,
    };
    await this.storage.put('generationRuns', run);

    this.activeRuns.set(runId, new AbortController());
    // 把外部的停止信号接到我们内部控制器上，便于 stop() 与外部 signal 双通道
    const internal = this.activeRuns.get(runId)!;
    const forwardAbort = () => internal.abort();
    options.signal.addEventListener('abort', forwardAbort, { once: true });

    const points: KnowledgePoint[] = [];
    let unlocatedCount = 0;

    try {
      const input: OrganizeInputSegment[] = segments.map(toInputSegment);

      const result = await options.backend.organize({
        sourceTitle: source.title,
        segments: input,
        signal: internal.signal,
        /**
         * 边产出边定位边落库。
         *
         * 为什么必须在这里做，而不是等 organize() 返回后再统一处理：
         * 后者会让「中途停止」永远无效 —— 用户点停止时后端已把全部条目跑完，
         * 进度条早就到 100%，停止只是马后炮。实测确实如此（状态永远是 completed）。
         *
         * 放在 onDraft 里，停止信号才能在两条之间被真正观察到，
         * 已产出的部分也已经落库（P2 要求「停止后已得结果不丢」）。
         */
        onDraft: async (draft) => {
          const point = this.materialize(draft, segments, options.sourceId, options.backend.id);
          if (point.anchorStatus === 'unlocated') unlocatedCount += 1;

          await this.storage.put('knowledgePoints', point);
          points.push(point);

          options.onProgress?.({
            produced: points.length,
            // 每段约 3 条是经验值（假后端每段 0-4 条，真实模型波动更大）。
            // 只用于算进度条百分比，界面上必须标明是估算。
            estimatedTotal: segments.length * 3,
            segmentTotal: segments.length,
            unlocated: unlocatedCount,
          });
        },
      });

      const finished: GenerationRun = {
        ...run,
        status: result.stopped ? 'stopped' : 'completed',
        actualTokens: result.actualTokens,
        producedCount: points.length,
        unlocatedCount,
        finishedAt: nowIso(),
      };
      await this.storage.put('generationRuns', finished);

      /**
       * 记账。
       *
       * 放在「run 已落库」之后：先把这次任务的结果存好（那是用户的数据），
       * 再记一笔账。反过来如果先记账再写 run，中途崩了会出现
       * 「账上花了钱，但找不到是哪次任务花的」。
       *
       * 只在真后端上记：假后端不花一分钱，记进来会让真实花费看起来更多。
       * 停止（stopped）也记 —— 已经发出去的请求照样计费，只是拿到的产出少了。
       */
      if (this.usage && !options.backend.isMock && result.actualTokens) {
        await this.usage.record({
          backendId: options.backend.id,
          provider: options.backend.provider ?? 'unknown',
          kind: 'organize',
          tokens: result.actualTokens,
        });
      }

      return { run: finished, points };
    } catch (err) {
      const failed: GenerationRun = {
        ...run,
        status: 'failed',
        producedCount: points.length,
        unlocatedCount,
        error: err instanceof Error ? err.message : String(err),
        finishedAt: nowIso(),
      };
      await this.storage.put('generationRuns', failed);
      throw err;
    } finally {
      options.signal.removeEventListener('abort', forwardAbort);
      this.activeRuns.delete(runId);
    }
  }

  /** 中途停止。已产出的知识点保留（P2 验收要求）。 */
  stop(runId: string): void {
    this.activeRuns.get(runId)?.abort();
  }

  /** 清掉某份资料的全部知识点（删除资料时用） */
  async clearBySource(sourceId: string): Promise<void> {
    const all = await this.storage.getAll('knowledgePoints');
    const mine = all.filter((x) => x.sourceId === sourceId);

    /*
     * 收进回收站（2026-11-08）。合成**一条**：
     * 一份资料几十条知识点，每条占一行会让回收站瞬间刷屏，
     * 用户分不清哪些是同一次删除。还原时也是整体回来。
     */
    if (mine.length > 0) {
      const title = await this.sourceTitle(sourceId);
      await this.trash?.moveToTrash([
        {
          kind: 'knowledgePoints',
          title: `${title} 的全部知识点`,
          summary: `${mine.length} 条`,
          payload: mine[0],
        },
        ...mine.slice(1).map((k) => ({
          kind: 'knowledgePoints' as const,
          title: '',
          summary: '',
          payload: k,
        })),
      ]);
    }

    for (const k of mine) {
      await this.storage.remove('knowledgePoints', k.id);
    }
  }

  /** 取资料标题用于回收站显示；取不到给一句可读的替代，不显示裸 id */
  private async sourceTitle(sourceId: string): Promise<string> {
    try {
      const s = await this.sources.get(sourceId);
      return s?.title ?? '（资料已删除）';
    } catch {
      return '（资料已删除）';
    }
  }

  /**
   * 清掉某份资料里**某个后端**产出的知识点。
   *
   * 「重新整理」的正确粒度就在这里。早先 generate() 调的是 clearBySource，
   * 于是用 A 后端整理完再换 B 后端整理一次，A 的结果就被抹掉了 ——
   * P5 第 4 条要求两份并存对比，一换就没了根本无从对比。
   *
   * 只清自己那一份也符合直觉：同一个后端重跑是想要新的，
   * 换后端是想要另一份对照，不该动别人的。
   */
  async clearBySourceAndBackend(sourceId: string, backendId: string): Promise<void> {
    const all = await this.storage.getAll('knowledgePoints');
    for (const k of all.filter((x) => x.sourceId === sourceId && x.backendId === backendId)) {
      await this.storage.remove('knowledgePoints', k.id);
    }
  }

  /** 编辑一条知识点（改表述、改层级、改标签、收藏） */
  async update(
    id: string,
    patch: Partial<
      Pick<KnowledgePoint, 'statement' | 'cognitiveLevel' | 'tags' | 'chapter' | 'favorite'>
    >,
  ): Promise<KnowledgePoint | null> {
    const existing = await this.storage.get('knowledgePoints', id);
    if (!existing) return null;

    const next: KnowledgePoint = {
      ...existing,
      ...patch,
      tags: patch.tags ?? existing.tags,
      updatedAt: nowIso(),
    };
    await this.storage.put('knowledgePoints', next);
    return next;
  }

  /**
   * 切换收藏（2026-11-11）。
   *
   * 单独一个方法而不是让调用方自己拼 patch：收藏是「取反」语义，
   * 界面上连点两下要能回到原状，调用方不该自己维护旧值。
   */
  async toggleFavorite(id: string): Promise<KnowledgePoint | null> {
    const existing = await this.storage.get('knowledgePoints', id);
    if (!existing) return null;
    return this.update(id, { favorite: !existing.favorite });
  }

  /** 列出全部收藏的知识点（2026-11-11，供学习笔记页按资料分类汇总） */
  async listFavorites(): Promise<KnowledgePoint[]> {
    const all = await this.listAll();
    return all.filter((p) => p.favorite === true);
  }

  /**
   * 删除单条知识点（2026-11-08 起会进回收站）。
   *
   * 为什么先读再删：回收站要存整条记录的副本，也要拿到 statement
   * 作为列表里显示的标题。直接 remove 会让用户永远找不回来。
   */
  async remove(id: string): Promise<void> {
    const existing = await this.storage.get('knowledgePoints', id);
    if (!existing) return;

    await this.trash?.moveToTrash([
      {
        kind: 'knowledgePoints',
        title: existing.statement.slice(0, 60),
        summary: `第 ${existing.anchors[0]?.page ?? '?'} 页 · ${existing.cognitiveLevel}`,
        payload: existing,
      },
    ]);

    await this.storage.remove('knowledgePoints', id);
  }

  /**
   * 人工重新指定位置（校对界面用）。
   *
   * 传 quote 时会重新定位；传 located=false 表示人工判定「这条没有出处」，
   * 状态置为 waived（不再提示需要处理）。
   */
  async reanchor(
    id: string,
    options: { quote?: string; waive?: boolean },
  ): Promise<KnowledgePoint | null> {
    const existing = await this.storage.get('knowledgePoints', id);
    if (!existing) return null;

    if (options.waive) {
      const next: KnowledgePoint = {
        ...existing,
        anchorStatus: 'waived',
        updatedAt: nowIso(),
      };
      await this.storage.put('knowledgePoints', next);
      return next;
    }

    const quote = options.quote?.trim();
    if (!quote) return existing;

    const sourceId = existing.sourceId;
    if (!sourceId) return existing;

    const segments = await this.sources.getSegments(sourceId);
    const result = locateQuotes(segments, [quote], sourceId);

    const next: KnowledgePoint = {
      ...existing,
      quotes: [quote],
      anchors: result.anchors,
      anchorStatus: result.located ? 'located' : 'unlocated',
      updatedAt: nowIso(),
    };
    await this.storage.put('knowledgePoints', next);
    return next;
  }

  /**
   * 把一条模型草稿变成可落库的知识点。
   *
   * 这是整个流程里**唯一**决定 anchors 的地方，也是「点回原文」可信的关口：
   * 位置只能来自 locateQuotes 的实测结果，定位不到就留空并标记。
   */
  private materialize(
    draft: KnowledgeDraft,
    segments: SourceSegment[],
    sourceId: string,
    backendId: string,
  ): KnowledgePoint {
    const result = locateQuotes(segments, draft.quotes, sourceId);
    const ts = nowIso();

    // 章节取自命中段，而不是模型说的章节 —— 模型同样不知道真实章节归属
    const hitPage = result.anchors[0]?.page;
    const hitSegment = hitPage !== undefined ? segments.find((s) => s.page === hitPage) : undefined;

    return {
      id: newId('kp'),
      statement: draft.statement.trim(),
      chapter: hitSegment?.chapter ?? null,
      cognitiveLevel: draft.cognitiveLevel,
      tags: draft.tags ?? [],
      anchors: result.anchors,
      // 引用用**原文里真实存在的那一段**（result.matchedQuotes），
      // 而不是模型给的原话。这样界面上展示的引用一定能被找到、被高亮。
      quotes: result.located ? result.matchedQuotes : draft.quotes,
      anchorStatus: result.located ? 'located' : 'unlocated',
      origin: 'material',
      sourceId,
      backendId,
      createdAt: ts,
      updatedAt: ts,
    };
  }
}

function toInputSegment(seg: SourceSegment): OrganizeInputSegment {
  return {
    segmentId: seg.id,
    page: seg.page,
    chapter: seg.chapter,
    text: seg.text,
  };
}

function applyPageRange(
  segments: SourceSegment[],
  range: { from: number; to: number } | null,
): SourceSegment[] {
  if (!range) return segments;
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);
  return segments.filter((s) => s.page >= from && s.page <= to);
}
