/**
 * 任务运行记录（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「任务栏没有记录文档解析的任务，把这个加上去。
 *   同时任务栏也做分类，未完成；进行中；已完成三种。」
 *
 * ## 为什么放在这里而不是继续塞进 KnowledgeService
 *
 * `generationRuns` 这张表原先只由整理知识点（KnowledgeService）写，
 * 出题那条路后来补了 kind='questions'，但**文档解析从来没写过**。
 * 而解析是本项目最耗时的一件事（442 页扫描件要几十分钟），
 * 用户切走去看别的、回来忘了还在跑，或者失败了不知道 ——
 * 任务页正是该显示它的地方。
 *
 * 与其把这个职责塞进 KnowledgeService（它管的是知识点），
 * 不如抽一个只管「运行记录」的小服务：谁跑任务谁调它。
 *
 * ## 复用 generationRuns 分区，不新建
 *
 * 新增分区要动迁移四件套（STORES / BACKUP_STORES / StoreRecordMap /
 * StoreName），而 `kind` 是可选的，旧数据读不到就当 'organize'。
 * 加一个 'parse' 是纯增量，不触发任何迁移。
 *
 * ## status 与「三种分类」的对应
 *
 * 表里的 status 有四个值（running / completed / stopped / failed），
 * 但用户要的是三栏。映射规则：
 *
 * | status | 归到哪一栏 | 理由 |
 * |---|---|---|
 * | running | 进行中 | 正在跑 |
 * | completed | 已完成 | 跑完了 |
 * | stopped | **未完成** | 用户中途停的，任务没做完 —— 归「未完成」才符合直觉 |
 * | failed | **未完成** | 失败了就是没做成 |
 *
 * 这个映射是产品判断，不是技术必然。写在这里是为了让下一个人知道
 * 为什么 stopped 不算「已完成」：它没产出完整结果。
 */

import type { GenerationRun } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';

/** 一次解析运行的输入 */
export interface ParseRunInput {
  sourceId: string;
  /** 归属资料标题，列表里直接显示（资料删了也还看得懂） */
  sourceTitle: string;
  /** 页码范围，null 表示整份 */
  pageRange: { from: number; to: number } | null;
  /** 用的哪个引擎：本地 MinerU / 云端 OCR */
  engine: 'local' | 'deepseek';
}

/** 任务页用的三种分类（用户要求的） */
export type TaskBucket = 'todo' | 'running' | 'done';

/**
 * 把一个 status 归到三栏之一。
 *
 * 单独抽成函数是为了能被单测直接钉住 —— 「停掉的算不算完成」
 * 这种事一旦改错，任务页就会骗人。
 */
export function bucketOf(status: GenerationRun['status']): TaskBucket {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'stopped':
    case 'failed':
      /*
       * 停在半路 / 失败了 —— 两者都**没拿到完整结果**，
       * 归「未完成」。用户在这里能一眼看到「哪些活儿没干完」，
       * 那正是这一栏存在的意义。
       */
      return 'todo';
  }
}

/** 一次 AI 组卷运行的输入 */
export interface ComposeRunInput {
  /**
   * 从哪个范围组卷（资料名 / 「全部已发布题目」）。
   *
   * 记成 `sourceId` 字段会误导（组卷的范围可能是跨资料的「全部」），
   * 所以这里借 `sourceId` 存一个**描述性字符串**，
   * 并在注释里说清它不是真的 sourceId。
   *
   * 为什么复用这个字段而不加新字段：`GenerationRun` 已经有
   * `sourceId` 且任务页拿它显示「归属对象」。组卷的「归属」
   * 就是那个范围标签。加新字段要动 model 与所有读的人，
   * 而复用只要注释说清。
   */
  scopeId: string;
  /** 范围标签，任务页直接显示 */
  scopeLabel: string;
  /** 要几道题 */
  wantCount: number;
  /** 备选题总数（让用户看得出「从多少里挑了多少」） */
  poolSize: number;
}

export class TaskRunService {
  constructor(private readonly storage: StorageAdapter) {}

  private newId(): string {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 开一条「解析」运行记录，返回 id。
   *
   * 调用方必须在结束时调 `finishParseRun` —— 否则这条会永远停在
   * 「进行中」，任务页上看起来像卡死了。所以这里刻意**不提供**
   * 「只开不关」的便利方法。
   */
  async startParseRun(input: ParseRunInput): Promise<string> {
    const id = this.newId();
    const run: GenerationRun = {
      id,
      kind: 'parse',
      sourceId: input.sourceId,
      pageRange: input.pageRange,
      status: 'running',
      /*
       * 解析不花 token（本地 MinerU 免费；云端 OCR 按页计费）。
       * 两个 token 字段给 null 而不是 0 —— 0 是「花了但没花」，是假数据。
       * 云端的页数记在 producedCount 里（见 finishParseRun）。
       */
      estimatedTokens: null,
      actualTokens: null,
      producedCount: 0,
      unlocatedCount: 0,
      error: null,
      backendId: input.engine === 'deepseek' ? 'deepseek-ocr' : 'mineru-local',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    await this.storage.put('generationRuns', run);
    return id;
  }

  /**
   * 结束一条解析运行。
   *
   * @param pages 成功解析出的页数（失败时给 0）
   * @param error 失败原因；成功时 null
   */
  async finishParseRun(
    id: string,
    outcome: { status: 'completed' | 'stopped' | 'failed'; pages: number; error?: string | null },
  ): Promise<void> {
    const existing = await this.storage.get('generationRuns', id);
    if (!existing) return;
    await this.storage.put('generationRuns', {
      ...existing,
      status: outcome.status,
      producedCount: outcome.pages,
      error: outcome.error ?? null,
      finishedAt: new Date().toISOString(),
    } satisfies GenerationRun);
  }

  /**
   * 开一条「AI 组卷」运行记录（2026-11-17 用户要求）。
   *
   * 用户原话：「这个让 ai 组卷的过程在任务栏目里面也要有记录」。
   *
   * ## 为什么组卷该有记录
   *
   * 它跟解析一样是「要等一会儿、可能失败、花了钱」的动作：
   * 实测一次调用约 3600 token，推理模型要跑 10 秒左右。
   * 用户点完切走再回来，需要知道「那次到底成没成」。
   *
   * ## token 字段这次是真的有数
   *
   * 与解析不同（解析不花 token，给 null），组卷真的花：
   * 结束时要调 `finishComposeRun` 把实际用量填进去。
   * 填不上就留 null —— **不写 0**，0 是「花了但没花」，是假数据。
   */
  async startComposeRun(input: ComposeRunInput): Promise<string> {
    const id = this.newId();
    const run: GenerationRun = {
      id,
      kind: 'compose',
      sourceId: input.scopeId,
      pageRange: null,
      status: 'running',
      estimatedTokens: null,
      actualTokens: null,
      /* 要几道题先记 0 —— 结束时换成实际挑到的数量 */
      producedCount: 0,
      unlocatedCount: 0,
      error: null,
      backendId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    await this.storage.put('generationRuns', run);
    return id;
  }

  /**
   * 结束一条组卷记录。
   *
   * @param picked 实际挑到几道题（失败时 0）
   * @param tokens 实际用量；拿不到就给 null（不写 0）
   */
  async finishComposeRun(
    id: string,
    outcome: {
      status: 'completed' | 'stopped' | 'failed';
      picked: number;
      tokens?: number | null;
      error?: string | null;
    },
  ): Promise<void> {
    const existing = await this.storage.get('generationRuns', id);
    if (!existing) return;
    await this.storage.put('generationRuns', {
      ...existing,
      status: outcome.status,
      producedCount: outcome.picked,
      actualTokens: outcome.tokens ?? null,
      error: outcome.error ?? null,
      finishedAt: new Date().toISOString(),
    } satisfies GenerationRun);
  }

  /**
   * 读全部运行记录，按开始时间**倒序**。
   *
   * 倒序的理由：任务页最上面应该是刚发生的事。升序会让用户
   * 每次都滚到底才能看到刚才那次跑成没成。
   */
  async listRuns(): Promise<GenerationRun[]> {
    const all = await this.storage.getAll('generationRuns');
    return [...all].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }
}