import { newId, nowIso } from '../id.ts';
import type { GenerationRun, KnowledgePoint, SourceSegment } from '../model.ts';
import type { SourceService } from '../sources.ts';
import type { StorageAdapter } from '../storage/types.ts';
import type {
  KnowledgeDraft,
  OrganizeBackend,
  OrganizeInputSegment,
} from './backend-types.ts';
import { locateQuotes } from './locator.ts';

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
  ) {}

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

  async get(id: string): Promise<KnowledgePoint | null> {
    return this.storage.get('knowledgePoints', id);
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
      throw new Error(
        '这份资料没有文字层（扫描件），无法整理出知识点。可以先换一份电子版，或等 P6 的看图识别功能。',
      );
    }

    const segments = applyPageRange(allSegments, options.pageRange ?? null);
    if (segments.length === 0) {
      throw new Error('选定的范围内没有内容');
    }

    // 前一次生成的结果先清掉，避免重复条目堆在一起。
    // 这是「重新整理」的语义：用户点这个按钮就是想要一份新的。
    await this.clearBySource(options.sourceId);

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

  /** 清掉某份资料的全部知识点（重新整理 / 删除资料时用） */
  async clearBySource(sourceId: string): Promise<void> {
    const all = await this.storage.getAll('knowledgePoints');
    for (const k of all.filter((x) => x.sourceId === sourceId)) {
      await this.storage.remove('knowledgePoints', k.id);
    }
  }

  /** 编辑一条知识点（改表述、改层级、改标签） */
  async update(
    id: string,
    patch: Partial<Pick<KnowledgePoint, 'statement' | 'cognitiveLevel' | 'tags' | 'chapter'>>,
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

  async remove(id: string): Promise<void> {
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
