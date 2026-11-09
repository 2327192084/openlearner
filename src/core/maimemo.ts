/**
 * 墨墨背单词开放 API 客户端（2026-11-09）。
 *
 * ## 为什么做这个（而不是在应用里做背单词）
 *
 * 调研结论（见对话记录）：墨墨开放 API 提供云词本、词汇查询、学习数据三类能力，
 * 其中**唯一与我们契合**的是「把阅读时遇到的生词送进墨墨的云词本」。
 *
 * 不做的事：
 *  - ❌ 内置背单词 —— 那是墨墨的主场，用户已经在用，重做是浪费
 *  - ❌ 词库管理 —— 同样重复
 *  - ❌ 读它的学习数据做报表 —— 我们的统计页已经够用，而且那要多申请一个权限
 *
 * 做的事：**我们负责找出「这个词你不认识」，墨墨负责它的复习调度。**
 * 这与项目里「错题闪卡导出 Obsidian」是同一套哲学：
 * 本应用挑出要学什么，专业工具管它的复习流。
 *
 * ## API 事实（2026-11-09 实测）
 *
 * - 基地址：`https://open.maimemo.com/open/api/v1/`
 * - 鉴权：`Authorization: Bearer <personal access token>`
 * - token 获取：在墨墨 App 内（open.maimemo.com/open/api/v1/tokens/openapi）
 * - 未授权响应（实测）：
 *     {"errors":[{"code":"common_unauthorized","msg":"Authorization failed","info":""}],
 *      "success":false}
 *   注意 HTTP 状态也是 200，**必须看 body 里的 success/errors**，不能只看状态码。
 * - 云词本查询：`GET notepads` → 返回词本列表，每个有 `id`（`np-` 开头）
 * - 云词本导入：`POST notepads/{id}`，body 形如
 *     { "notepad": { "status": "UNPUBLISHED", "content": "...",
 *                    "title": "...", "brief": "...", "tags": [...] } }
 *   其中 content 是**整段文本**（按行分词的词表），不是逐词 JSON 数组
 *   —— 这一点来自社区实现（EudicSyncToMaiMemo）的实测，不是官方文档明写的。
 *
 * ## 为什么把 HTTP 与解析分开
 *
 * 这个文件里的 JSON 解析、错误归一、词表拼装都是纯函数，单测直接喂样本。
 * 真发请求的部分只有 `MaimemoClient` 的几个方法，靠注入 fetch 就能测。
 */

/** 一次 API 调用的结果。不抛异常 —— 调用方按 ok 分支处理 */
export type MaimemoResult<T> =
  | { ok: true; data: T }
  | { ok: false; /** 机器可读的分类，界面据此给不同提示 */ trouble: MaimemoTrouble; message: string };

/** 失败分类。界面对不同类别给不同建议，不要一句「失败」了事 */
export type MaimemoTrouble =
  /** 没填 token */
  | 'no-token'
  /** token 无效或过期（401 / common_unauthorized）*/
  | 'unauthorized'
  /** 网络不通 / 超时 */
  | 'network'
  /** 接口返回了但我们没看懂 */
  | 'bad-response'
  /** 其它服务端错误 */
  | 'server';

export const MAIMEMO_BASE = 'https://open.maimemo.com/open/api/v1/';

/** 一个云词本（只取我们需要的字段） */
export interface MaimemoNotepad {
  id: string;
  title: string;
  /** 词条数（接口有就给，没有就 null —— 不编造） */
  wordCount: number | null;
}

/**
 * 解析墨墨的错误响应。
 *
 * 关键点：**HTTP 200 也可能是失败**（实测未授权就是 200 + success:false）。
 * 所以判据是 body 里的 `success` 与 `errors`，不是状态码。
 */
export function parseMaimemoError(body: unknown): { trouble: MaimemoTrouble; message: string } | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;

  /* success 显式为 true 才算成功；false/缺失时看有没有 errors */
  const errors = Array.isArray(o.errors) ? o.errors : null;
  if (o.success === true && !errors) return null;
  if (!errors || errors.length === 0) {
    /* success 缺失且没有 errors：按「看不懂」处理，不假装成功 */
    return o.success === true ? null : { trouble: 'bad-response', message: '接口返回里没有 success 标记' };
  }

  const first = errors[0] as Record<string, unknown> | undefined;
  const code = typeof first?.code === 'string' ? first.code : '';
  const msg = typeof first?.msg === 'string' ? first.msg : '接口报错';

  if (code.includes('unauthorized') || code.includes('auth')) {
    return { trouble: 'unauthorized', message: msg };
  }
  return { trouble: 'server', message: msg };
}

/**
 * 把 notepads 响应解析成云词本列表。
 *
 * 容错：认不出的条目跳过，不因为一条坏数据让整个列表失败。
 */
export function parseNotepads(body: unknown): MaimemoNotepad[] {
  if (!body || typeof body !== 'object') return [];
  const o = body as Record<string, unknown>;

  /* 接口可能把列表放在 notepads / data / list 任一处；都试一遍 */
  const rawList =
    (Array.isArray(o.notepads) && o.notepads) ||
    (Array.isArray(o.data) && o.data) ||
    (Array.isArray(o.list) && o.list) ||
    [];

  const out: MaimemoNotepad[] = [];
  for (const item of rawList as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const id = typeof n.id === 'string' ? n.id : '';
    if (!id) continue;
    out.push({
      id,
      title: typeof n.title === 'string' ? n.title : '(未命名词本)',
      wordCount: typeof n.wordCount === 'number' ? n.wordCount : null,
    });
  }
  return out;
}

/**
 * 把一批单词拼成云词本的 `content`。
 *
 * ## 为什么是纯文本按行
 *
 * 实测（社区实现 EudicSyncToMaiMemo）：云词本的 content 是**整段文本**，
 * 每行一个词条，墨墨自己解析。不是 JSON 数组。
 *
 * ## 去重与清洗
 *
 * - 去重（同一个词在一篇文章里出现十次只加一次）
 * - 去掉非英文（划词可能划到标点、中文）
 * - 保留连字符与撇号（`well-known`、`don't` 是合法单词）
 * - 统一小写（墨墨的词库按小写索引；`Apple` 与 `apple` 是同一个词）
 */
export function buildNotepadContent(words: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of words) {
    const w = normalizeWord(raw);
    if (!w) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.join('\n');
}

/**
 * 规范化一个候选词。
 *
 * 规则（宁可漏，不要错）：
 *  - 只允许英文字母、连字符、撇号
 *  - 长度 2~40（1 个字母的不是单词；超长的多半是划错了一整段）
 *  - 首尾不能是连字符或撇号
 *  - 统一小写
 */
export function normalizeWord(raw: string): string {
  if (typeof raw !== 'string') return '';
  const w = raw.trim().toLowerCase();
  if (w.length < 2 || w.length > 40) return '';
  if (!/^[a-z][a-z'’-]*[a-z]$/.test(w)) return '';
  /* 全是连字符/撇号的已排除；再挡一下连续 3 个以上的撇号之类的怪串 */
  if (/['’-]{2,}/.test(w)) return '';
  /* 统一各种撇号为一个标准单引号，方便去重 */
  return w.replace(/[’']/g, "'");
}

/**
 * 从一段选中文字里抽候选单词。
 *
 * 为什么需要：用户在阅读器里划的可能是一整句（「the quick brown fox」），
 * 也可能只是一个词。逐词切开、过滤掉 the/a/is 这类高频虚词，
 * 剩下的才是值得进生词本的。
 */
export function extractWords(text: string): string[] {
  if (typeof text !== 'string') return [];
  /* 按非字母切开，撇号与连字符保留在词内 */
  const parts = text.split(/[^A-Za-z'’-]+/);
  const out: string[] = [];
  for (const p of parts) {
    const w = normalizeWord(p);
    if (!w) continue;
    if (STOP_WORDS.has(w)) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

/**
 * 高频虚词表。
 *
 * 为什么要有：划一整句时，「the / a / is / of」这些进生词本毫无意义，
 * 只会把词本撑大、让真正要背的词被淹掉。
 *
 * 只收最常见的约 120 个。不够精确没关系 —— 用户划单个词时不受影响，
 * 划整句时多滤掉几个比漏掉几个好。
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
  'this', 'that', 'these', 'those', 'there', 'here', 'where', 'when', 'why', 'how',
  'what', 'which', 'who', 'whom', 'whose',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'without', 'about',
  'into', 'onto', 'upon', 'over', 'under', 'between', 'among', 'through',
  'not', 'no', 'nor', 'none', 'nothing', 'nobody', 'never',
  'all', 'any', 'some', 'both', 'each', 'every', 'few', 'many', 'much', 'more',
  'most', 'other', 'another', 'such', 'same', 'own', 'very', 'too', 'also', 'just',
  'only', 'even', 'still', 'yet', 'again', 'once', 'ever', 'always', 'often',
  'up', 'down', 'out', 'off', 'away', 'back', 'forth', 'about',
  'one', 'two', 'three', 'first', 'second', 'last', 'next',
  'because', 'while', 'during', 'before', 'after', 'since', 'until', 'unless',
  'although', 'though', 'however', 'therefore', 'thus', 'hence',
]);

/** 客户端配置 */
export interface MaimemoConfig {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 超时毫秒，默认 10 秒 */
  timeoutMs?: number;
}

/**
 * 墨墨 API 客户端。
 *
 * 只做我们要用的两件事：列云词本、往某个词本导入词条。
 * 其它接口（释义/例句/助记）不做 —— 用不上，多接一个就多一处会坏的。
 */
export class MaimemoClient {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: MaimemoConfig) {
    this.token = (config.token ?? '').trim();
    this.base = (config.baseUrl ?? MAIMEMO_BASE).replace(/\/+$/, '') + '/';
    this.fetchImpl = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : (undefined as never));
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  get hasToken(): boolean {
    return this.token.length > 0;
  }

  /** 底层请求。统一处理超时、网络异常、HTTP 状态与 body 里的 success */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<MaimemoResult<T>> {
    if (!this.hasToken) {
      return {
        ok: false,
        trouble: 'no-token',
        message: '还没有填墨墨的 access token。到「设置 → 墨墨生词本」里填一个。',
      };
    }
    if (!this.fetchImpl) {
      return { ok: false, trouble: 'network', message: '当前环境没有网络请求能力。' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.base + path, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      /* 解析 body：哪怕 HTTP 200 也可能是业务失败，必须看 body */
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        return {
          ok: false,
          trouble: 'bad-response',
          message: `接口返回的不是 JSON（HTTP ${res.status}）。`,
        };
      }

      /* 401 直接归类成 unauthorized，不用看 body */
      if (res.status === 401) {
        return {
          ok: false,
          trouble: 'unauthorized',
          message: 'token 无效或已过期。到墨墨 App 里重新生成一个。',
        };
      }

      const err = parseMaimemoError(parsed);
      if (err) return { ok: false, ...err };

      if (!res.ok) {
        return { ok: false, trouble: 'server', message: `接口返回 HTTP ${res.status}。` };
      }

      return { ok: true, data: parsed as T };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        trouble: 'network',
        message: msg.includes('abort') ? '请求超时。检查网络后重试。' : msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 列出云词本（用来让用户选一个目标词本） */
  async listNotepads(): Promise<MaimemoResult<MaimemoNotepad[]>> {
    const r = await this.request<unknown>('GET', 'notepads');
    if (!r.ok) return r;
    return { ok: true, data: parseNotepads(r.data) };
  }

  /**
   * 把一批词导入某个云词本。
   *
   * @param notepadId 目标词本 id（`np-` 开头，从 listNotepads 拿）
   * @param words     单词列表；内部会清洗去重
   */
  async importWords(options: {
    notepadId: string;
    words: readonly string[];
    title?: string;
    brief?: string;
  }): Promise<MaimemoResult<{ imported: number; content: string }>> {
    const content = buildNotepadContent(options.words);
    if (!content) {
      return {
        ok: false,
        trouble: 'bad-response',
        message: '没有可导入的英文单词。划选英文单词或句子再试。',
      };
    }

    /*
     * body 形状来自社区实测（不是官方文档明写）：
     *   { notepad: { status, content, title, brief, tags } }
     * status 用 UNPUBLISHED —— 生词本是给自己用的，没必要公开。
     *
     * 用 POST 而不是 PUT/PATCH：社区实现用的是 POST，
     * 且它对已有词本是「整段替换 content」的语义。
     * 这意味着重复导入会覆盖上一次的内容 —— 所以调用方要先把
     * 已有内容一起传进来（见 UI 层的说明）。
     */
    const r = await this.request<unknown>('POST', `notepads/${encodeURIComponent(options.notepadId)}`, {
      notepad: {
        status: 'UNPUBLISHED',
        content,
        title: options.title ?? 'OpenLeaner 生词',
        brief: options.brief ?? '从 OpenLeaner 阅读器收集的生词',
        tags: ['OpenLeaner'],
      },
    });

    if (!r.ok) return r;
    return { ok: true, data: { imported: content.split('\n').length, content } };
  }
}

/** 从 settings 里取墨墨配置。字段缺失返回空 token（等于未配置） */
export function maimemoConfigFromSettings(settings: unknown): { token: string; notepadId: string } {
  const o = (settings ?? {}) as Record<string, unknown>;
  return {
    token: typeof o.maimemoToken === 'string' ? o.maimemoToken : '',
    notepadId: typeof o.maimemoNotepadId === 'string' ? o.maimemoNotepadId : '',
  };
}
