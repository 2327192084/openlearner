/**
 * 外部资源（网课/文档链接）的数据模型与校验（2026-11-22，方案第 7 步）。
 *
 * ## 用户确认过的口径（方案第一节表格）
 *
 * | 问题 | 用户选择 |
 * |---|---|
 * | 自建表单 | **只有网址必填**；标题留空自动抓→回退域名；其他可选 |
 * | 自建资源入口 | **阅读器右栏 + 小节详情都留** |
 * | 资料被删 | 资源**跟着删** |
 *
 * ## ⚠️ 坏输入不是理论风险
 *
 * 方案第 7.5 节点名了五种情况，全部来自真实场景：
 * 用户从网页复制来的链接里真的会有 `javascript:`（社工常用），
 * 也会有 `file:///C:/...`（把本机路径发给别人 = 泄露）。
 * 所以校验要**在数据进库之前**做完，且要有测试守着。
 *
 * ## 纯函数
 *
 * 不碰 I/O、不碰 DOM。URL 解析用标准 `URL`（Electron 与 Node 都有）。
 */

/** 一条外部资源 */
export interface SourceResource {
  /** `res_<random>` */
  id: string;
  /** 挂在哪份资料上 */
  sourceId: string;
  /** 标题（用户没填时由 `deriveTitle` 生成） */
  title: string;
  /** 完整网址（已归一，一定带 http/https） */
  url: string;
  /**
   * 来源：
   * - `search`：规划时联网搜来的
   * - `manual`：用户自己加的
   *
   * 与 LogiNote 截图里的「LLM 联网收集 / 人工整理」是同一个区分 ——
   * 用户看到「这条是机器找的」和「这条是我自己存的」，判断依据不同。
   */
  source: 'search' | 'manual';
  /** 什么时候加的（相对时间显示用） */
  addedAt: string;
  /** 用户备注，如「第 3 节看这个视频」 */
  note?: string;
  /**
   * 挂在哪个小节上；null = 资料级（不属于某一节）。
   *
   * ⚠️ 小节被删 / 路线重排时，挂在小节上的资源要**回到资料级**
   * （方案 7.6：不丢）。所以这个字段可为 null，删除时不级联删资源。
   */
  sectionId?: string | null;
}

/** 校验结果 */
export type UrlCheck =
  | { ok: true; url: string; /** 是否自动补了协议头 */ addedScheme: boolean }
  | { ok: false; reason: string };

/**
 * 校验并归一用户输入的网址（方案 7.5）。
 *
 * ## 五种坏输入的处理（逐条对齐方案）
 *
 * | 输入 | 处理 |
 * |---|---|
 * | `javascript:alert(1)` | 拒绝，说明只支持 http/https |
 * | `file:///C:/...` | 拒绝（同上） |
 * | `www.bilibili.com/x` | **自动补 `https://`** |
 * | 完全不是 URL | 拒绝，**保留输入框内容**（调用方负责不清空） |
 * | 重复网址 | 由 `isDuplicateUrl` 判断，单独提示 |
 *
 * ## 为什么先 trim 再判协议
 *
 * 用户从网页复制常带前后空格。不 trim 的话 `" https://x"` 会因为
 * 开头不是 http 而被当成"无协议头"，然后拼成 `https:// https://x` —— 更糟。
 */
export function checkResourceUrl(raw: string): UrlCheck {
  const input = raw.trim();
  if (input.length === 0) {
    return { ok: false, reason: '网址不能为空。' };
  }

  /*
   * 1) 明确危险的协议：直接拒，且**说清为什么**。
   *
   * 不用「不在白名单就拒」的统一文案，是因为用户需要知道
   * "我这个链接错在哪"——`javascript:` 和"忘了写 https"是完全不同的错。
   */
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      const why =
        scheme === 'javascript' || scheme === 'data'
          ? '这种链接是可执行脚本，不是网页，出于安全考虑不允许添加。'
          : scheme === 'file'
            ? '本机文件路径不能被添加 —— 它只在你自己的电脑上有效，别人打开不了，而且会暴露你的目录结构。'
            : `只支持 http / https 网址（你给的是 ${scheme}:）。`;
      return { ok: false, reason: why };
    }
  }

  /* 2) 没有协议头 → 自动补 https（方案明确要求） */
  const hasScheme = schemeMatch !== null;
  const withScheme = hasScheme ? input : `https://${input}`;

  /* 3) 用标准 URL 解析验证（比正则可靠：能认端口、IPv6、中文域名） */
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: '这看起来不是一个网址。检查一下有没有漏字符或多了空格。' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http / https 网址。' };
  }

  /*
   * 4) 主机名必须有点号或有冒号（端口）。
   *
   * `https://abc` 会被 URL 接受（abc 当主机名），但那几乎不可能是
   * 用户想要的网址 —— 多半是打错了。localhost 与 IP 单独放行。
   */
  const host = parsed.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  if (!isLocalhost && !isIp && !host.includes('.')) {
    return { ok: false, reason: `「${host}」不像一个完整域名，检查一下拼写。` };
  }

  return { ok: true, url: parsed.toString(), addedScheme: !hasScheme };
}

/**
 * 从网址推出一个能看的标题（方案 7.4：标题留空时的逐级回退）。
 *
 * ## 为什么要回退链而不是直接留空
 *
 * 列表里一条没有标题的链接，用户没法分辨。
 * 回退链：抓到的标题（调用方给）→ **域名** → 完整网址。
 *
 * 这个函数只做后两级；抓到标题那一级需要网络，由调用方做。
 */
export function deriveTitle(url: string, fetchedTitle?: string | null): string {
  const t = (fetchedTitle ?? '').trim();
  if (t.length > 0) return t.slice(0, 120);

  try {
    const u = new URL(url);
    /* 域名去掉 www. 前缀更像"名字" */
    const host = u.hostname.replace(/^www\./, '');
    if (host.length > 0) return host;
  } catch {
    /* 交给下面的完整网址兜底 */
  }
  return url.slice(0, 120);
}

/**
 * 判断是不是重复网址（方案 7.5 最后一条）。
 *
 * ## 比较规则：忽略协议与末尾斜杠
 *
 * `https://b23.tv/x` 与 `http://b23.tv/x/` 对用户来说是同一个东西，
 * 提示"已经在列表里了"才对。严格字符串比较会放进来两条一样的。
 */
export function isDuplicateUrl(url: string, existing: readonly { url: string }[]): boolean {
  const key = normalizeForCompare(url);
  return existing.some((r) => normalizeForCompare(r.url) === key);
}

/** 归一成"用于比较"的形式：去协议、去尾斜杠、小写主机 */
function normalizeForCompare(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.search;
    return `${host}${path}${search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** 生成一条资源（调用方已校验过 URL） */
export function makeResource(input: {
  sourceId: string;
  url: string;
  title?: string | null;
  source: 'search' | 'manual';
  note?: string;
  sectionId?: string | null;
  /** 注入时间便于测试 */
  now?: string;
}): SourceResource {
  const url = input.url;
  return {
    id: 'res_' + Math.random().toString(36).slice(2, 10),
    sourceId: input.sourceId,
    title: deriveTitle(url, input.title ?? null),
    url,
    source: input.source,
    addedAt: input.now ?? new Date().toISOString(),
    ...(input.note && input.note.trim().length > 0 ? { note: input.note.trim().slice(0, 200) } : {}),
    ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
  };
}

/* ==========================================================================
 * 存储归一（坏数据不能崩界面）
 * ========================================================================== */

/**
 * 把库里的 unknown 变成可信的资源表：`sourceId → SourceResource[]`。
 *
 * 与项目其它 store 同一套思路（`source-tree-store` / `source-route-store`）：
 * 这个值来自用户库，可能是手改备份留下的半截对象。
 * **强转会让界面在某个 `.map` 上崩掉**。
 */
export function normalizeResources(raw: unknown): Record<string, SourceResource[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: Record<string, SourceResource[]> = {};

  for (const [sourceId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;

    const items: SourceResource[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;

      const url = typeof o.url === 'string' ? o.url.trim() : '';
      if (url.length === 0) continue;

      /* 坏 URL 的旧数据也要挡住 —— 一个点不开的资源留着只会让用户困惑 */
      const check = checkResourceUrl(url);
      if (!check.ok) continue;

      const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';

      items.push({
        id: typeof o.id === 'string' && o.id.length > 0 ? o.id : 'res_' + Math.random().toString(36).slice(2, 10),
        sourceId: typeof o.sourceId === 'string' && o.sourceId.length > 0 ? o.sourceId : sourceId,
        title: deriveTitle(check.url, title),
        url: check.url,
        source: o.source === 'search' ? 'search' : 'manual',
        addedAt: typeof o.addedAt === 'string' ? o.addedAt : '',
        ...(typeof o.note === 'string' && o.note.trim().length > 0
          ? { note: o.note.trim().slice(0, 200) }
          : {}),
        ...(typeof o.sectionId === 'string' && o.sectionId.length > 0
          ? { sectionId: o.sectionId }
          : { sectionId: null }),
      });
    }

    if (items.length > 0) out[sourceId] = items;
  }

  return out;
}

/* ==========================================================================
 * 相对时间（方案 7.2：列表里显示"3 天前"）
 * ========================================================================== */

/**
 * 把 ISO 时间变成相对描述。
 *
 * ## 为什么自己写而不引库
 *
 * 只需要四种粒度（刚加 / N 小时前 / N 天前 / 日期），
 * 而 `Intl.RelativeTimeFormat` 在 Electron 里可用但输出是
 * 「3天前」还是「3 天前」取决于 locale 数据，不同机器可能不一致 ——
 * 界面文案不一致比"少一个句号"更显眼。
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';

  const ms = now.getTime() - t.getTime();
  /* 未来时间（时钟不同步）当成"刚加的"，不显示"−3 天前" */
  if (ms < 0) return '刚加的';

  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚加的';
  if (min < 60) return `${min} 分钟前`;

  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;

  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;

  /* 更久就给日期，比"127 天前"好读 */
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 从网址取域名（列表里显示「域名 · 来源标注」） */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}