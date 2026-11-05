import type {
  KnowledgeDraft,
  OrganizeBackend,
  OrganizeInputSegment,
  OrganizeRequest,
  OrganizeResult,
} from '../knowledge/backend-types.ts';
import { ApiError, chatCompletion, redactSecrets } from './deepseek-client.ts';
import type { ChatOptions } from './deepseek-client.ts';
import { buildSystemPrompt, buildUserPrompt } from './prompts.ts';

/**
 * DeepSeek 后端：把资料整理成知识点。
 *
 * 实现 `OrganizeBackend` 契约，因此上层（KnowledgeService）不需要知道
 * 背后是 DeepSeek、别的兼容接口，还是 MockBackend。
 *
 * ## 一个刻意的取舍：一次请求，分段喂料
 *
 * 理想做法是「每段一次请求」，那样进度更细、单次失败影响更小。
 * 但代价是 N 倍的请求次数与固定开销（system prompt 每次都要发）。
 * P5 阶段先用「一次请求处理若干段」，把 N 段合并到一次调用里，
 * 通过 maxCharsPerSegment 控制上下文长度。
 *
 * 真正的逐段流式留给后续 —— 当前目标是先验证「真模型能不能跑通」。
 */

export interface ModelBackendOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * 服务商标识（BackendConfig.provider）。
   *
   * 只影响两件事：是否发 `response_format`、报错文案里写哪家的名字。
   * 真正的调用形状各家一致，所以换服务商不需要换实现 —— 见 presets.ts。
   */
  provider?: string;
  /** 用户给这个后端起的名字，用在进度条与错误提示里 */
  label?: string;
  /** 一次请求最多带多少段（控制上下文长度） */
  segmentsPerRequest?: number;
  language?: 'zh' | 'en';
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 旧名保留，避免一次性改掉所有引用。新代码用 ModelBackendOptions。 */
export type DeepSeekBackendOptions = ModelBackendOptions;

/** 模型返回的原始形状，用于逐字段校验 */
interface RawPoint {
  statement?: unknown;
  quotes?: unknown;
  cognitiveLevel?: unknown;
  tags?: unknown;
}

const VALID_LEVELS = new Set(['remember', 'understand', 'apply', 'analyze']);

/**
 * 模型后端：把资料整理成知识点（任何 OpenAI 兼容服务商）。
 *
 * 实现 `OrganizeBackend` 契约，因此上层（KnowledgeService）不需要知道
 * 背后是 DeepSeek、Kimi、智谱，还是 MockBackend。
 *
 * 类名从 `DeepSeekBackend` 改成 `ModelBackend`：它早就不是 DeepSeek 专用的了，
 * 留旧名会让人以为换服务商要换实现。旧名保留为别名，见文件末尾。
 */
export class ModelBackend implements OrganizeBackend {
  readonly id: string;
  readonly label: string;
  readonly isMock = false;

  private readonly model: string;
  private readonly segmentsPerRequest: number;
  private readonly language: 'zh' | 'en';

  constructor(private readonly options: ModelBackendOptions) {
    this.model = options.model ?? 'deepseek-chat';
    this.segmentsPerRequest = options.segmentsPerRequest ?? 4;
    this.language = options.language ?? 'zh';
    /**
     * id 里带上 provider，这样「同一份资料用两个不同后端整理」的结果
     * 在库里能区分开（P5 第 4 条要求并存对比）。
     */
    const provider = options.provider ?? 'deepseek';
    this.id = `model:${provider}`;
    this.label = options.label ?? '模型 API 直连';
  }

  /**
   * 估算用量。
   *
   * 中文大约 1 字 ≈ 1.6 token（含标点、JSON 结构与 system prompt 开销）。
   * 只是给用户一个量级感，不追求精确 —— 但要比 MockBackend 的估算更保守，
   * 因为真实调用要花钱，宁可高估让人有心理准备。
   */
  estimateTokens(segments: OrganizeInputSegment[]): number {
    const chars = segments.reduce((sum, s) => sum + s.text.length, 0);
    // 1.6 是正文，再给 system prompt（约 600 token）与输出（约 15%）留余量
    return Math.ceil(chars * 1.6) + 600 + Math.ceil(chars * 0.15);
  }

  async organize(request: OrganizeRequest): Promise<OrganizeResult> {
    const drafts: KnowledgeDraft[] = [];
    let totalTokens = 0;
    let stopped = false;

    // 分批，避免一次请求超出上下文
    const batches = chunk(request.segments, this.segmentsPerRequest);

    for (const batch of batches) {
      if (request.signal.aborted) {
        stopped = true;
        break;
      }

      const systemPrompt = buildSystemPrompt(this.language);
      const userPrompt = buildUserPrompt({
        sourceTitle: request.sourceTitle,
        segments: batch,
        language: this.language,
      });

      let result;
      try {
        result = await chatCompletion(this.chatOptions(systemPrompt, userPrompt, request.signal));
      } catch (err) {
        /**
         * 中途失败的处理策略：
         * - 已经产出的部分**保留**（这是 P2 就定下的规则：停止/失败不丢已得结果）
         * - 但**必须让调用方知道这次失败**，不能静默返回半截数据当成成功
         *
         * 做法：如果一条都没产出，抛错；已经有一些了，也抛错但带上已完成的部分。
         * KnowledgeService 会把 run 标记为 failed，同时已落库的知识点保住。
         */
        if (err instanceof ApiError && err.code === 'aborted') {
          stopped = true;
          break;
        }
        throw err;
      }

      if (result.usage) totalTokens += result.usage.totalTokens;

      const parsed = parsePointsJson(result.content, this.options.apiKey);
      if (parsed.length === 0) {
        // 这一批没产出任何东西：不是错误（可能这段确实没可考查内容），继续下一批
        continue;
      }

      for (const draft of parsed) {
        if (request.signal.aborted) {
          stopped = true;
          break;
        }
        drafts.push(draft);
        // 逐条 await：让上层定位并落库，也让「停止」能在条目之间生效
        await request.onDraft?.(draft);
      }

      if (stopped) break;
    }

    return {
      drafts,
      actualTokens: totalTokens > 0 ? totalTokens : null,
      stopped,
    };
  }

  private chatOptions(system: string, user: string, signal: AbortSignal): ChatOptions {
    return {
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      model: this.model,
      provider: this.options.provider,
      systemPrompt: system,
      userPrompt: user,
      jsonMode: true,
      // 整理任务需要稳定可复现，温度压低
      temperature: 0.2,
      signal,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    };
  }
}

/** 旧名别名。新代码请用 ModelBackend。 */
export { ModelBackend as DeepSeekBackend };

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/**
 * 解析模型返回的 JSON。
 *
 * 需要处理的现实情况（都会真的发生）：
 *   1. 模型在 JSON 外面套了 ```json 围栏
 *   2. 前面加了一句「好的，这是整理结果：」
 *   3. 字段名大小写不一致、类型不对（quotes 是字符串而不是数组）
 *   4. 认知层级给了非法值
 *
 * 策略：**尽力解析，严格校验**。能修的修，修不了的单条丢弃，
 * 绝不让一条坏数据把整批结果带崩。
 */
export function parsePointsJson(content: string, apiKey?: string): KnowledgeDraft[] {
  const jsonText = extractJson(content);
  if (!jsonText) {
    throw new ApiError(
      'server-error',
      `模型返回的内容里找不到 JSON。原始内容开头：${redactSecrets(content.slice(0, 200), apiKey)}`,
      '模型输出格式不符合要求。重试一次通常能好；如果反复出现，说明提示词需要调整。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'server-error',
      `模型返回的 JSON 无法解析：${msg}`,
      '模型输出被截断或格式损坏。重试；若反复出现，可减少一次整理的页数。',
    );
  }

  const root = parsed as { points?: unknown };
  const rawPoints = Array.isArray(root.points) ? root.points : [];

  const drafts: KnowledgeDraft[] = [];
  for (const raw of rawPoints) {
    const draft = normalizePoint(raw);
    if (draft) drafts.push(draft);
  }

  return drafts;
}

/** 从可能带围栏/前后缀的文本里抠出 JSON 对象 */
function extractJson(content: string): string | null {
  const text = content.trim();

  // 1) 直接是 JSON
  if (text.startsWith('{') && text.endsWith('}')) return text;

  // 2) ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  // 3) 前后有说明文字：取第一个 { 到最后一个 } 之间
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return null;
}

/**
 * 把一条原始数据规范成 KnowledgeDraft。
 *
 * 返回 null 表示这条不可用（缺字段、类型全错）。
 * 单条丢弃而不是整批失败：10 条里有 1 条格式不对，
 * 不该让另外 9 条也白花钱。
 */
function normalizePoint(raw: unknown): KnowledgeDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as RawPoint;

  const statement = typeof p.statement === 'string' ? p.statement.trim() : '';
  if (!statement) return null;

  // quotes：可能是数组，也可能被写成单个字符串
  const quotesRaw = Array.isArray(p.quotes)
    ? p.quotes
    : typeof p.quotes === 'string'
      ? [p.quotes]
      : [];
  const quotes = quotesRaw
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  // 没有引用的知识点无法定位，直接丢弃 —— 留着也只会变成「待处理」
  if (quotes.length === 0) return null;

  const levelRaw = typeof p.cognitiveLevel === 'string' ? p.cognitiveLevel.toLowerCase() : '';
  const cognitiveLevel = VALID_LEVELS.has(levelRaw)
    ? (levelRaw as KnowledgeDraft['cognitiveLevel'])
    : 'understand'; // 非法值给个安全的默认，不丢这条

  const tags = Array.isArray(p.tags)
    ? p.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
    : [];

  return { statement, quotes, cognitiveLevel, tags };
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// 连通性测试
// ---------------------------------------------------------------------------

export interface ConnectionTestResult {
  ok: boolean;
  /** 成功时的模型名 */
  model?: string;
  /** 成功时的往返耗时毫秒 */
  latencyMs?: number;
  /** 失败时的分类与提示 */
  failure?: { code: string; message: string; hint: string };
}

/**
 * 测试一个后端配置是否真的能用。
 *
 * 为什么要单独做一个「测试连接」按钮，而不是让用户直接去整理时才发现：
 * 计划书 P5 的验收条目之一是「界面在调用前就告知可用性，
 * 不做『点了才发现不能用』」。这里发一个最小请求，
 * 用最少的钱换一个确定的答案。
 */
export async function testConnection(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** 服务商标识，用于错误文案与 JSON 模式兼容性判断 */
  provider?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ConnectionTestResult> {
  const started = Date.now();

  try {
    const result = await chatCompletion({
      apiKey: options.apiKey,
      model: options.model ?? 'deepseek-chat',
      provider: options.provider,
      systemPrompt: 'You are a connectivity probe. Reply with JSON only: {"ok": true}',
      userPrompt: 'ping',
      jsonMode: true,
      temperature: 0,
      // 测试连接不需要长超时，30 秒没回来说明有问题
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    return {
      ok: true,
      model: result.model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        failure: { code: err.code, message: err.message, hint: err.hint },
      };
    }
    return {
      ok: false,
      failure: {
        code: 'unknown',
        message: redactSecrets(err instanceof Error ? err.message : String(err), options.apiKey),
        hint: '遇到未预期的问题。检查接口地址是否写对（默认 https://api.deepseek.com）。',
      },
    };
  }
}
