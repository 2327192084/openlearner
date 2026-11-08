/**
 * 每日一句：远程获取 + 本地兜底（2026-11-08，用户要求联网）。
 *
 * ## 设计取舍：为什么一定要有本地兜底
 *
 * 用户同意联网，并说「后续可能有拓展功能」。但这个应用是**离线优先**的
 * （KaTeX 字体打进包、MinerU 本地跑）。如果每日一句变成纯远程：
 *  - 断网 → 首页右侧空一块，正好在最显眼的位置
 *  - 接口挂了/限流 → 同上，而且用户不知道是「今天没句子」还是「坏了」
 *
 * 所以策略是：**远程优先、本地兜底、失败静默**。
 * 拉到就用远程的，拉不到就用内置语料 —— 用户永远能看到一句，
 * 但界面上会如实标注来源（远程显示出处，本地不标）。
 *
 * ## 为什么不用第三方公共 API
 *
 * 考察过 quotable.io 这类免费接口：无 SLA、随时限流、内容不可控
 * （可能返回不适合学习场景的句子）。而每日一句是首页的「气质」，
 * 不该由别人的服务决定。
 *
 * 这里默认走一个**可配置的 JSON 端点**（用户自己的或以后接的），
 * 没配就纯本地。这样：
 *  - 现在零依赖就能用
 *  - 以后要接真接口，只改 settings 里的 URL，不用改代码
 *
 * ## 缓存
 *
 * 同一天只请求一次（按本地日期缓存到 localStorage）。
 * 不缓存的话每次切回首页都会请求一次，既费流量也容易被限流。
 */

import { DAILY_QUOTES, pickDailyQuote, todayLocalYmd } from './home-widgets.ts';

/** 远程返回的形状。宽松校验：只要能取到 text 就行 */
export interface RemoteQuote {
  text: string;
  /** 出处（作者/书名），可空 */
  author?: string | null;
}

/** 一次拉取的结果 */
export interface DailyQuoteResult {
  text: string;
  author: string | null;
  /** 来源：远程拿到 / 本地兜底 */
  source: 'remote' | 'local';
  /** 远程失败时的原因（本地兜底时给出，界面可选择是否显示） */
  fallbackReason?: string;
}

const CACHE_KEY = 'openleaner.dailyQuote.v1';
const TIMEOUT_MS = 4000;

/** 缓存结构：同一天同一端点只存一条 */
interface CacheEntry {
  day: string;
  endpoint: string;
  quote: RemoteQuote;
}

/** 给测试用：清掉内存缓存，保证用例之间互不影响 */
export function __resetQuoteCacheForTest(): void {
  memCache = null;
}

/**
 * 从远程 JSON 里解析出一句。
 *
 * 容错优先：认不出就返回 null（调用方回落到本地），不抛异常。
 * 为什么这么宽松：我们不知道用户会配什么端点，
 * 但**绝不能因为格式不合预期就让首页空掉**。
 *
 * 支持的形状（按顺序尝试）：
 *   { text, author } / { quote, author } / { content } / ["句子"]
 */
export function parseRemoteQuote(json: unknown): RemoteQuote | null {
  if (!json) return null;

  // 数组：取第一个字符串
  if (Array.isArray(json)) {
    const first = json.find((x) => typeof x === 'string');
    return typeof first === 'string' && first.trim() ? { text: first.trim() } : null;
  }

  if (typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;

  const textCandidates = [o.text, o.quote, o.content, o.sentence, o.hitokoto];
  const text = textCandidates.find((x) => typeof x === 'string' && x.trim());
  if (typeof text !== 'string') return null;

  const authorCandidates = [o.author, o.from, o.source, o.who];
  const author = authorCandidates.find((x) => typeof x === 'string' && x.trim());

  return {
    text: text.trim(),
    author: typeof author === 'string' ? author.trim() : null,
  };
}

/**
 * 内存缓存。
 *
 * 为什么不只靠 localStorage（2026-11-08 被测试抓出来的）：
 * 测试环境与非浏览器环境里没有 localStorage，`readCache` 会静默失败，
 * 于是同一天同一端点被请求两次 —— 真实使用里就是「每次切回首页都发一次请求」。
 *
 * 所以两层：内存（本次会话内一定生效）+ localStorage（跨会话）。
 */
let memCache: CacheEntry | null = null;

/** 读缓存（同一天 + 同一端点才算命中） */
function readCache(day: string, endpoint: string): RemoteQuote | null {
  if (memCache && memCache.day === day && memCache.endpoint === endpoint) {
    return memCache.quote ?? null;
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.day !== day || entry.endpoint !== endpoint) return null;
    return entry.quote ?? null;
  } catch {
    return null;
  }
}

function writeCache(day: string, endpoint: string, quote: RemoteQuote): void {
  const entry: CacheEntry = { day, endpoint, quote };
  memCache = entry;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* 存不下就只留内存那份，不影响显示 */
  }
}

/**
 * 取今天的句子。
 *
 * @param endpoint 远程端点；空/不传则纯本地
 * @param fetchImpl 注入用（测试）
 * @param now 注入用（测试固定日期）
 */
export async function fetchDailyQuote(options: {
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
  now?: Date;
} = {}): Promise<DailyQuoteResult> {
  const endpoint = (options.endpoint ?? '').trim();
  const now = options.now ?? new Date();
  const day = todayLocalYmd(now);

  /* 没配端点：纯本地，一句废话都不多说 */
  if (!endpoint) {
    return { text: pickDailyQuote(day), author: null, source: 'local' };
  }

  const cached = readCache(day, endpoint);
  if (cached) {
    return { text: cached.text, author: cached.author ?? null, source: 'remote' };
  }

  const doFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!doFetch) {
    return {
      text: pickDailyQuote(day),
      author: null,
      source: 'local',
      fallbackReason: '当前环境没有网络请求能力',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        text: pickDailyQuote(day),
        author: null,
        source: 'local',
        fallbackReason: `接口返回 ${res.status}`,
      };
    }
    const parsed = parseRemoteQuote(await res.json());
    if (!parsed) {
      return {
        text: pickDailyQuote(day),
        author: null,
        source: 'local',
        fallbackReason: '接口返回的内容里没有可用的句子',
      };
    }
    writeCache(day, endpoint, parsed);
    return { text: parsed.text, author: parsed.author ?? null, source: 'remote' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: pickDailyQuote(day),
      author: null,
      source: 'local',
      fallbackReason: msg.includes('abort') ? '请求超时' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 给设置页说明用：内置语料有多少条 */
export const LOCAL_QUOTE_COUNT = DAILY_QUOTES.length;
