/**
 * DeepSeek OCR 作为 MinerU 之外的另一条解析路（2026-11-15，用户要求）。
 *
 * ## 用户原话
 *
 * > 「最近 deepseek 公开了功能 api，其中有 ocr 识别的功能，
 * >  能不能把调用 ocr 识别作为除了本地模型解析 pdf 的另一方式」
 *
 * ## 官方文档核过（不是照报道抄）
 *
 * `POST https://api.deepseek.com/v1/tools/ocr`
 * 依据 https://api-docs.deepseek.com/zh-cn/guides/ocr
 *
 * | 项 | 事实 |
 * |---|---|
 * | 请求 | `multipart/form-data`，两个必填字段：`file`（带文件名）、`purpose` |
 * | purpose | `text_recognition`（无图 Word/PPT 直接提文字，其它逐页识别）/ `rich_layout_recognition`（全部逐页识别） |
 * | 响应 | 一个 JSON：`{ id, object:'ocr.result', purpose, page_count, pages:[{index,text,finish_reason}], usage }` |
 * | 页码 | `pages[].index` **从 0 开始** |
 * | 限制 | 100 MiB / 1000 页 / 180 秒总时长（含上传与识别） |
 * | 计费 | 每 1000 页 1.5 元，按成功页数计 |
 * | 限速 | 每账号最多 15 个并发识别，超出 429 |
 * | 超时后 | 识别仍会继续跑、照常计费（客户端断开不取消） |
 *
 * ## ⚠️ 与 MinerU 的关键落差：不出插图
 *
 * 官方文档明说「OCR API 识别…中的文字，按页返回识别结果」，
 * 响应里**只有 text**，没有任何图片字段。而 MinerU 会切图、给位置、
 * 写回 `SegmentFigure`。
 *
 * 所以这条路**不能替换** MinerU，只能并列：
 * 文字够清楚、不需要插图时用它（快、便宜、不用装本地环境）；
 * 需要图文对照时仍用 MinerU。
 *
 * 界面必须如实标出这个代价 —— 否则用户选完发现「图都没了」，
 * 会以为功能坏了。
 *
 * ## 为什么先分片
 *
 * 用户选了「分片上传」。除了避免 180 秒超时（442 页那本几乎必然超），
 * 分片还能：
 *  - 看到进度（每片完成就有反馈，而不是干等两分钟）
 *  - 单片失败只丢那一片，不用整本重来
 *  - 与现有「分片解析 + 合并写回」链路天然对齐（`writeSegments(mode:'merge')`）
 *
 * ## 特殊标记
 *
 * 逐页识别的文本里保留 `<｜ref｜>…<｜/ref｜><｜box｜>[[x1,y1,x2,y2]]<｜/box｜>`
 * 这类标记与坐标（原点左上、按页面宽高归一化到 0–1000）。
 * 我们**不剥掉它们**：坐标以后可以用来做「点文字跳到图片区域」，
 * 而且剥掉是不可逆的。但正文显示时会让观感变差 ——
 * 所以 `stripOcrMarks` 单独提供，由调用方决定何时用。
 */

/** 一次分片识别的输入 */
export interface OcrRequest {
  /** 文件字节 */
  bytes: Uint8Array;
  /** 文件名（官方要求带文件名；扩展名会影响它的解析方式判断） */
  fileName: string;
  /**
   * 识别模式。
   *
   * - `text_recognition`：无图 Word/PPT 直接提文字，其它逐页识别
   * - `rich_layout_recognition`：所有文件都逐页识别（保留版面标记）
   *
   * 默认用 `rich_layout_recognition`：我们要的就是逐页正文，
   * 且带坐标的输出版面信息更全（`text_recognition` 对 PDF 也是逐页，
   * 但显式指定 rich_layout 更符合「我要每页的正文」这个意图）。
   */
  purpose?: 'text_recognition' | 'rich_layout_recognition';
  apiKey: string;
  baseUrl: string;
  /** 注入用（单测不碰网络） */
  fetchImpl?: typeof globalThis.fetch;
  /** 覆盖默认超时 */
  timeoutMs?: number;
}

/** 一页的识别结果 */
export interface OcrPage {
  /** 页码，**从 1 开始**（官方是 0 基，这里转换过） */
  page: number;
  /** 该页的模型原始输出（含坐标标记） */
  text: string;
  /** 输出是否被截断（官方 `finish_reason === 'length'`） */
  truncated: boolean;
}

export type OcrResult =
  | { ok: true; pages: OcrPage[]; pageCount: number }
  | { ok: false; reason: string; retryable: boolean };

/**
 * 默认超时。
 *
 * 官方总时长上限是 180 秒（含上传）。这里给 200 秒：
 * 比官方宽一点，让「服务端先超时」而不是我们先放弃 ——
 * 我们先断的话，识别仍在跑、照样计费，用户却什么也没拿到。
 */
export const DEFAULT_OCR_TIMEOUT_MS = 200_000;

/**
 * 解析 OCR 的响应体（纯函数，可单测）。
 *
 * ## 三种返回形态都要处理
 *
 * 1. 正常结果：`{ pages: [...] }`
 * 2. **识别失败但 HTTP 200**：文档明说「识别开始后，状态码已经是 200。
 *    如果识别失败或超时，响应体不是识别结果，而是一个错误对象」——
 *    所以必须检查 `error` 字段，不能只看状态码。
 * 3. 识别过程中服务端发换行符保活：文档说「换行符属于 JSON 的前导空白，
 *    整个响应体可以直接按 JSON 解析」—— 但真实世界里可能有 JSON 前后
 *    的空白，`JSON.parse` 本来就能容忍前导空白，所以直接 parse。
 */
export function parseOcrResponse(body: unknown): OcrResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'OCR 返回的不是 JSON 对象', retryable: false };
  }

  /*
   * 先查 error —— 这是文档点名的坑：识别失败时 HTTP 是 200，
   * 只看状态码会把一个错误对象当成结果，然后 pages 为空、
   * 用户看到「解析成功但 0 页」。
   */
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    const message = typeof e.message === 'string' ? e.message : '识别失败';
    const code = typeof e.code === 'string' ? e.code : '';

    /*
     * 区分「重试有用」与「重试无用」—— 文档给了明确分类：
     *  - 密码保护 / 格式不支持 / 超页数 / 文件过大 / 识别超时 → 重试无用
     *  - 服务繁忙 / 服务内部错误 → 稍后重试
     */
    const retryable =
      /temporarily unavailable|Internal Server Error|try again later/i.test(message) ||
      code === 'gateway_timeout_error';

    return { ok: false, reason: message, retryable };
  }

  const pages = (body as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) {
    return { ok: false, reason: 'OCR 返回里没有 pages 数组', retryable: false };
  }

  const out: OcrPage[] = [];
  for (const raw of pages) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { index?: unknown; text?: unknown; finish_reason?: unknown };
    const idx = typeof p.index === 'number' && Number.isFinite(p.index) ? p.index : out.length;
    out.push({
      /* 官方 0 基 → 我们 1 基。写回链路、阅读器、页码框全都用 1 基。 */
      page: idx + 1,
      text: typeof p.text === 'string' ? p.text : '',
      truncated: p.finish_reason === 'length',
    });
  }

  if (out.length === 0) {
    return { ok: false, reason: 'OCR 没有识别出任何页（文件可能是空的或全是图片）', retryable: false };
  }

  /* 按页码排序：官方是按顺序返回的，但排序不花钱且能防意外 */
  out.sort((a, b) => a.page - b.page);

  return { ok: true, pages: out, pageCount: out.length };
}

/**
 * 拨开 OCR 的版面标记，只留正文。
 *
 * 文档给的例子：`<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>`
 *
 * 剥除规则很保守：
 *  - 全角/半角竖线都认（文档里是 `<｜ref｜>`，实际返回可能混用 `|<|ref|>|`）
 *  - 只删**标记与坐标块**，不动正文一个字
 *  - 剩余空白合并成单个空格，但不吃掉换行（换行是有意义的段落边界）
 *
 * 为什么提供但不默认调用：坐标以后能做「点文字跳到图片区域」，
 * 剥掉不可逆。所以让调用方按用途决定。
 */
export function stripOcrMarks(text: string): string {
  /*
   * 拨掉 OCR 的版面标记，只留正文。
   *
   * 标记形如 <|ref|>标题<|/ref|>[[52, 40, 948, 96]]（官方文档的例子）。
   * 竖线可能是全角 U+FF5C 或半角 |，字符组里两者都收。
   *
   * 正则字面量里直接写斜杠会提前结束字面量，所以成对标记那一条
   * 用字符类包住斜杠，不写转义斜杠（更不容易写错）。
   */
  const PAIRED = /<[｜|][/]?[ 	]*(?:ref|box|[/]ref|[/]box)[｜|]>/gi;
  /* 坐标块：四个数字的 [ [ x1, y1, x2, y2 ] ] */
  const COORDS = /\[\[\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){3}\s*\]\]/g;
  /* 残留的落单标记。只删带尖括号的，避免误伤正文里的普通括号 */
  const LEFTOVER = /<[｜|][^>]{0,20}[｜|]>/g;

  return text
    .replace(PAIRED, '')
    .replace(COORDS, '')
    .replace(LEFTOVER, '')
    /* 行内多余空白压成一个空格，但保留换行 */
    .replace(/[ \t]{2,}/g, ' ')
    /* 每行尾空白 */
    .replace(/[ \t]+$/gm, '')
    /* 三个以上连续换行压成两个（空段落没有意义） */
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 真的调一次。
 *
 * ⚠️ fetch 不能丢 this（硬约束第 6 条）：Electron 里裸调 `fetch(...)`
 * 在旧版会抛 Illegal invocation。这里通过 `call` 绑定。
 */
export async function runOcr(request: OcrRequest): Promise<OcrResult> {
  const {
    bytes,
    fileName,
    purpose = 'rich_layout_recognition',
    apiKey,
    baseUrl,
    fetchImpl,
    timeoutMs = DEFAULT_OCR_TIMEOUT_MS,
  } = request;

  const key = apiKey.trim();
  if (!key) return { ok: false, reason: '还没有配置 API Key', retryable: false };
  if (bytes.length === 0) return { ok: false, reason: '文件是空的', retryable: false };

  /* 官方上限 100 MiB。提前拦，省一次白传。 */
  const MAX_BYTES = 100 * 1024 * 1024;
  if (bytes.length > MAX_BYTES) {
    return {
      ok: false,
      reason: `文件超过 100 MiB（${(bytes.length / 1024 / 1024).toFixed(1)} MiB），请先拆分`,
      retryable: false,
    };
  }

  /*
   * 去掉地址末尾的斜杠。
   *
   * 用 split/join 而不是正则：这条语句已经被正则字面量的斜杠坑过两次
   * （字面量内的斜杠在多层转义后变成注释符，直接编译失败）。
   * 这里根本不需要正则能力。
   */
  let base = baseUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = `${base}/v1/tools/ocr`;

  const form = new FormData();
  /*
   * 官方要求 `file` 带文件名。两个坑叠在一起：
   *
   * 1. 用 Blob 而不是 File：Node 侧（单测 / 主进程）没有 File 构造器，
   *    Blob + 第三个参数才是跨环境都能带文件名的写法。
   * 2. `Uint8Array` 的 buffer 类型是 `ArrayBufferLike`，TS 5.7 之后
   *    不能直接当 BlobPart（可能是 SharedArrayBuffer）。复制一份
   *    到新的 ArrayBuffer 再包 —— 多一次拷贝，换来类型正确。
   */
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  form.append('file', new Blob([copy.buffer as ArrayBuffer]), fileName);
  form.append('purpose', purpose);

  const call = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await call(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });

    /*
     * 上传阶段的错误用状态码区分（官方文档给了表）。
     * 这里逐条给**能照着改**的话，而不是把状态码原样抛给用户。
     */
    if (res.status === 400) {
      const body = await safeJson(res);
      const msg = errorMessageOf(body) ?? '文件或 purpose 不合法，或文件无法处理';
      return { ok: false, reason: msg, retryable: false };
    }
    if (res.status === 402) return { ok: false, reason: '账户余额不足', retryable: false };
    if (res.status === 413) {
      /*
       * 413 有两种来源，**必须分清**（2026-11-16 实测发现）：
       *
       * 1. **应用层**（官方文档写的那个）：文件超过 100 MiB。
       *    会返回 JSON `{error:{message:'file is too large: max 100 MiB'}}`。
       *
       * 2. **openresty 网关**：它前面那层反代的请求体上限，比 100 MiB 低。
       *    返回的是 **HTML** 错误页（`<title>413 Request Entity Too Large</title>`
       *    + `server: openresty`），**根本没有 JSON**。
       *
       * ## 为什么这条必须改
       *
       * 原来这里直接写死「文件超过 100 MiB，请先拆分」，**完全不读响应体**。
       * 用户实测：55.07 MiB 的 PDF 被拒，屏幕上却显示「超过 100 MiB」——
       * 用户看着自己 55 MB 的文件，只会认为程序坏了。
       * 实测证据（2026-11-16）：
       *   - 1 KiB → HTTP 401 JSON（链路正常）
       *   - 55.07 MiB → HTTP 413 **HTML/openresty**，耗时 18.5 秒
       *     （= 整个文件传完才被网关拒）
       * 也就是说服务端从没说过「100 MiB」，那句话是程序自己编的。
       *
       * 现在：先读响应体判断是哪一种；网关那种如实说「网关不收这么大的请求」，
       * 并把**实际发出的体积**写出来 —— 那是用户唯一能据此行动的信息。
       */
      const text = await safeText(res);
      const body = parseMaybeJson(text);
      const serverMsg = errorMessageOf(body);

      /* 应用层的 413：有 JSON error，照它的原话说 */
      if (serverMsg) {
        return { ok: false, reason: serverMsg, retryable: false };
      }

      const sentMiB = (bytes.length / 1024 / 1024).toFixed(1);

      /*
       * 网关层的 413（HTML / 空体 / 无 error 字段）。
       *
       * 措辞要点：
       *  - 不要说「超过 100 MiB」—— 那是另一层的限制，会误导
       *  - 要写出**实际发了多大**，用户才知道「我这文件到底哪里不对」
       *  - 要说明这是「服务端前置网关」的限制，不是软件算错
       *  - 给出可行动的做法：换本地 MinerU（它能处理大扫描件）
       */
      return {
        ok: false,
        reason:
          `服务端拒收了这次上传：请求体 ${sentMiB} MiB 超过它前置网关的上限` +
          `（这是 DeepSeek 网关的限制，比官方文档写的 100 MiB 更低，不是软件算错了）。` +
          `这份文件走不了云 OCR，改用本机 MinerU 解析这份资料。`,
        retryable: false,
      };
    }
    if (res.status === 408) {
      return { ok: false, reason: '上传太慢（中途停顿超过 30 秒），换个网络再试', retryable: true };
    }
    if (res.status === 429) {
      return {
        ok: false,
        reason: '同时进行的识别太多（每账号上限 15 个），等一会儿再试',
        retryable: true,
      };
    }
    if (res.status === 503) {
      return { ok: false, reason: '服务繁忙，稍后重试', retryable: true };
    }
    if (res.status === 504) {
      return {
        ok: false,
        reason: '上传与提交超过总时长（180 秒），请分片更小一点',
        retryable: true,
      };
    }
    if (res.status === 500) {
      return { ok: false, reason: '文件上传或提交识别失败，稍后重试', retryable: true };
    }
    if (!res.ok) {
      return { ok: false, reason: `服务返回 ${res.status}`, retryable: res.status >= 500 };
    }

    /* 200 也可能是错误对象（文档点名）—— 所以必须读 body 再判 */
    const body = await safeJson(res);
    return parseOcrResponse(body);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, reason: '识别超时（200 秒）。分片小一点再试。', retryable: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    /*
     * 网络层失败最常见的两个原因：没网、国内直连要代理。
     * 与 list-models 那边同样的措辞，免得用户以为是代码坏了。
     */
    return { ok: false, reason: `连不上 OCR 服务：${msg}`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** 读 JSON，失败返回 null（不抛） */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 读纯文本，失败返回空串（不抛）。
 *
 * 为什么不能只用 safeJson：413 在**网关层**返回的是 HTML
 * （`<title>413 Request Entity Too Large</title>` + `server: openresty`），
 * 不是 JSON。用 safeJson 读会得到 null，于是「有没有服务端原话」
 * 这个判断永远为假 —— 正是 2026-11-16 那次误报的机制。
 */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * 把一段文本当 JSON 解析；不是 JSON 就返回 null（不抛）。
 *
 * 与 `safeJson` 的区别：那个直接读 Response 的 body（只能读一次），
 * 这个作用于**已经读出来的字符串**。413 分支要先拿文本判断是 HTML
 * 还是 JSON，不可能再让 Response 读第二次。
 */
function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (!t || t[0] !== '{') return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 从错误体里取 message（两种形状都认） */
function errorMessageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const e = (body as { error?: unknown }).error;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  return null;
}

/**
 * 把 OCR 的分片结果转成 MinerU 同形的结果，让现有写回链路不用改。
 *
 * 为什么复用 `MinerUResult` 的形状而不是新造一个：
 * `writeSegments` / `mergeSegments` / 进度显示 / 补位跳过逻辑全都按这个
 * 形状写好了。造第二个形状意味着那套逻辑要复制一遍 —— 复制必然漂移。
 *
 * `tier` 写 `'deepseek-ocr'`、`producer` 也写明来源：
 * 界面与日志据此能区分「这批正文是本地解析的还是云 OCR 的」。
 */
export function toMinerUShape(
  pages: readonly OcrPage[],
  options: { stripMarks?: boolean } = {},
): {
  pageCount: number;
  pages: { page: number; text: string; chapter: null; figures: never[] }[];
  tier: string;
  producer: string;
} {
  const strip = options.stripMarks !== false;

  return {
    pageCount: pages.length,
    pages: pages.map((p) => ({
      page: p.page,
      text: strip ? stripOcrMarks(p.text) : p.text,
      /*
       * 章节：OCR 不给章节结构（MinerU 会从 `##` 标题推）。
       * 这里如实给 null，不猜 —— 猜错的章节会让「按章分组」全乱。
       */
      chapter: null,
      /* 官方 OCR 不出图，所以恒为空数组（不编造） */
      figures: [],
    })),
    tier: 'deepseek-ocr',
    producer: 'DeepSeek OCR (/v1/tools/ocr)',
  };
}
