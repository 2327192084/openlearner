/**
 * 规划路线时**预搜外部资源**（2026-11-22，方案第 7 步最后一块）。
 *
 * ## 用户的原始决定与这次的前提变化
 *
 * 方案第一节里用户选了「外部资源：规划时搜好并存下来」，
 * 预搜粒度选了**小节级（约 30 次检索）**（2026-11-22 11:56 确认）。
 *
 * 但那时的假设是「用 Tavily 搜索 API」。后来用户说：
 *
 * > 要是没有联网搜索 api 可以调用模型本身的搜索功能。
 *
 * 成本模型因此变了：
 *
 * | 方式 | 一次检索的成本 |
 * |---|---|
 * | Tavily | 一次 HTTP 调用，很便宜 |
 * | **模型自带搜索** | **一次完整模型调用**（输入 + 输出都计费） |
 *
 * 30 次模型调用不是"几次搜索"，是 30 次对话 —— 既慢又明显花钱。
 *
 * ## 所以这里做成「按章预搜」（默认）
 *
 * 442 页教材 8 章 → **8 次**，而不是 30 次。方案第十一节本来也建议章级：
 *
 * > 建议：只预搜到章级（8 次），小节级留给用户点「+ 找资料」现搜。
 * > 理由：章级资源本来就更适合（网课通常按章组织），且额度可控。
 *
 * 现在有了成本理由，这条建议从"也可以"变成"该这么做"。
 * **小节级仍然可选**（`granularity: 'section'`），但界面要如实提示代价。
 *
 * ## 失败不阻塞建图
 *
 * 预搜是增强项。搜不到就只是那一章没有资源 —— 界面上如实说，
 * 用户还能在小节详情里点「+ 添加资源」自己补。
 *
 * ## 纯逻辑
 *
 * 提示词构造、结果解析、去重、搜索词生成都在这里，不碰网络。
 */

import type { ChapterNode } from '@/v2/core/source-tree.ts';

/** 预搜粒度 */
export type PresearchGranularity = 'chapter' | 'section';

/** 一条预搜到的资源（还未落库） */
export interface PresearchedResource {
  title: string;
  url: string;
  /** 挂在哪一章（章号） */
  chapterNumber: number;
  /** 挂在哪一小节；null = 章级 */
  sectionId: string | null;
  /** AI 为什么认为这条适合这一章（给用户看） */
  why: string;
}

/**
 * 生成一次预搜的查询词。
 *
 * ## 为什么要带章名而不是只带科目
 *
 * 「信号与系统 章节目录」搜到的是整本书的目录；
 * 「信号与系统 第2章 连续时间系统的时域分析 网课」才能搜到那一章的资料。
 *
 * ## 为什么加「网课 讲解」而不是只给标题
 *
 * 用户要的是**能看的资源**（网课、文档、讲解视频），不是论文或题库。
 * 查询词里带这几个字能显著改善结果类型。
 */
export function buildChapterQuery(input: {
  subject: string;
  edition: string;
  chapterNumber: number;
  chapterTitle: string;
}): string {
  const parts: string[] = [input.subject.trim()];
  if (input.edition.trim().length > 0) parts.push(input.edition.trim());
  if (input.chapterNumber > 0) parts.push(`第${input.chapterNumber}章`);
  /*
   * 章标题常常自带「第2章」前缀，去掉避免查询词里出现两次。
   */
  const cleanTitle = input.chapterTitle
    .replace(/^第?\s*\d+\s*[章节讲篇部]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanTitle.length > 0) parts.push(cleanTitle);
  parts.push('网课 讲解 资料');
  return parts.join(' ');
}

/** 一小节的查询词（小节级预搜时才用） */
export function buildSectionQuery(input: {
  subject: string;
  edition: string;
  chapterNumber: number;
  sectionTitle: string;
}): string {
  const parts: string[] = [input.subject.trim()];
  if (input.edition.trim().length > 0) parts.push(input.edition.trim());
  const cleanTitle = input.sectionTitle.replace(/\s+/g, ' ').trim();
  if (cleanTitle.length > 0) parts.push(cleanTitle);
  parts.push('网课 讲解');
  return parts.join(' ');
}

/**
 * 构造「让模型联网找这一章的资料」的提示词。
 *
 * ## 为什么要求它给 URL
 *
 * 用户点资源是要**打开**的。没有 URL 的"资源"只是个名字，点不开 ——
 * 那比没有更糟（用户以为有了）。
 *
 * ## 为什么只要 3 条
 *
 * 一章给 3 条够用：第 1 条通常最好，2~3 条是备选。给 10 条用户也不会都看，
 * 反而让列表变成噪音。
 */
export function buildPresearchPrompt(input: {
  subject: string;
  chapterNumber: number;
  chapterTitle: string;
  /** 这一章的正文摘录，帮模型判断内容 */
  excerpt: string;
  /** 要几条 */
  limit?: number;
}): { system: string; user: string } {
  const limit = input.limit ?? 3;

  const system = [
    '你是助教，正在为一门课的一章**联网找学习资料**。',
    '',
    '## 硬规矩',
    '',
    '### 1. 只给真实存在的网址',
    '',
    '每条必须带完整 URL（以 http:// 或 https:// 开头）。',
    '**不许编造网址**，不许给"搜索这个词试试"这种建议 ——',
    '我们要的是能直接点开的链接。',
    '',
    '### 2. 优先这些类型',
    '',
    '- 公开网课（B站/中国大学MOOC/学堂在线等的课程页面）',
    '- 公开的讲义、课件、笔记（.pdf 或网页）',
    '- 权威百科/教程页面',
    '',
    '**不要**给：盗版书下载、需要登录才能看的、题库站点、',
    '与这一章内容无关的页面。',
    '',
    '### 3. 找不到就少给或不给',
    '',
    '`items` 可以是空数组。**宁可给 1 条真的，也不要凑 3 条假的。**',
    '',
    '### 4. 说清为什么适合这一章',
    '',
    '每条给一句 `why`（20 字内），说明它讲的是这一章的什么内容。',
    '',
    '## 输出格式',
    '',
    '只输出一个完整 JSON 对象，不要解释文字，不要 markdown 围栏。',
    '',
    '{',
    '  "items": [',
    '    {',
    '      "title": "资源标题（用页面自己的标题）",',
    '      "url": "https://…",',
    '      "why": "为什么适合这一章"',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const user = [
    `学科：${input.subject}`,
    `章节：${input.chapterNumber > 0 ? `第${input.chapterNumber}章 ` : ''}${input.chapterTitle}`,
    input.excerpt.trim().length > 0
      ? `\n这一章的正文摘录（用来判断它讲什么）：\n${input.excerpt.trim().slice(0, 400)}`
      : '',
    '',
    `请联网找最多 ${limit} 条适合这一章的学习资料。找不到就给空数组。`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { system, user };
}

/** 解析结果 */
export type ParsePresearchResult =
  | { ok: true; items: { title: string; url: string; why: string }[]; dropped: number }
  | { ok: false; reason: string };

/**
 * 解析模型给的资源列表。
 *
 * ## 校验（每条都对应一种真实的坏输出）
 *
 * 1. **URL 必须是 http/https** —— 模型偶尔给 `file://` 或纯文字
 * 2. **标题不能为空** —— 空标题在列表里没法辨认
 * 3. **重复 URL 只留第一条** —— 同一资源给两遍没意义
 * 4. **整份 JSON 残缺就拒绝** —— 不修补括号
 */
export function parsePresearchItems(content: string): ParsePresearchResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }

  const json = extractJsonObject(content);
  if (!json.ok) return { ok: false, reason: json.reason };

  const raw = (json.value as { items?: unknown }).items;
  if (!Array.isArray(raw)) {
    return { ok: false, reason: '返回的 JSON 里没有 items 数组。' };
  }

  const items: { title: string; url: string; why: string }[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const it of raw) {
    if (!it || typeof it !== 'object') {
      dropped += 1;
      continue;
    }
    const o = it as Record<string, unknown>;

    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';

    /* 只认 http/https：其余协议（file/js/data）一律不要 */
    if (!/^https?:\/\//i.test(url)) {
      dropped += 1;
      continue;
    }
    if (title.length === 0) {
      dropped += 1;
      continue;
    }

    /* 重复 URL：规范化后比对（去尾斜杠、小写主机） */
    const key = normalizeUrlKey(url);
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);

    items.push({
      title,
      url,
      why: typeof o.why === 'string' ? o.why.trim().slice(0, 60) : '',
    });
  }

  return { ok: true, items, dropped };
}

/** URL 归一（用于去重） */
function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return (
      u.hostname.toLowerCase().replace(/^www\./, '') +
      u.pathname.replace(/\/+$/, '') +
      u.search
    );
  } catch {
    return url.toLowerCase();
  }
}

/** 抠 JSON 对象（模型有时加 ```json 围栏或前后带话） */
function extractJsonObject(
  content: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const body = fence ? (fence[1] ?? '') : text;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, reason: '返回里找不到 JSON 对象（可能被截断了）。' };
  }
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: '返回的 JSON 不完整（可能被截断了）。' };
  }
}

/* ==========================================================================
 * 调度：决定搜哪些章 / 哪些节
 * ========================================================================== */

/** 一次预搜要做的任务 */
export interface PresearchTask {
  /** 章号 */
  chapterNumber: number;
  /** 章标题 */
  chapterTitle: string;
  /** 小节 id（章级预搜时为 null） */
  sectionId: string | null;
  /** 小节标题（章级时为 null） */
  sectionTitle: string | null;
  /** 这次要发的查询词 */
  query: string;
}

/**
 * 排出这次要发哪些预搜请求。
 *
 * ## 为什么单独抽出来（而不是在循环里现拼）
 *
 * 「要发多少次请求」是**用户会关心的成本**。抽成纯函数后，
 * 界面可以先算出"N 次请求"给用户看，再决定要不要跑。
 *
 * ## 章级 vs 小节级
 *
 * 章级：每章一次。小节级：每节一次（30 小节 = 30 次）。
 * 两者都只对**有正文的**章/节发（空的搜了也白搜）。
 */
export function planPresearchTasks(input: {
  subject: string;
  edition: string;
  chapters: readonly ChapterNode[];
  segmentsById: ReadonlyMap<string, string>;
  granularity: PresearchGranularity;
  /** 最多做几次（防止超大资料一次发几十个请求） */
  maxTasks?: number;
}): PresearchTask[] {
  const {
    subject,
    edition,
    chapters,
    segmentsById,
    granularity,
    maxTasks = 12,
  } = input;

  const tasks: PresearchTask[] = [];

  for (const ch of chapters) {
    if (tasks.length >= maxTasks) break;

    if (granularity === 'chapter') {
      /*
       * 章级：这一章有没有正文可依据。
       *
       * 没有正文的章照样搜（用章标题），但**不占**额外判断 ——
       * 章标题本身就是最好的查询词。
       */
      tasks.push({
        chapterNumber: ch.number,
        chapterTitle: ch.title,
        sectionId: null,
        sectionTitle: null,
        query: buildChapterQuery({
          subject,
          edition,
          chapterNumber: ch.number,
          chapterTitle: ch.title,
        }),
      });
      continue;
    }

    /* 小节级：逐节搜，但只搜有正文的节 */
    for (const sec of ch.sections) {
      if (tasks.length >= maxTasks) break;
      const hasText = sec.segmentIds.some((id) => (segmentsById.get(id) ?? '').length > 0);
      if (!hasText) continue;
      tasks.push({
        chapterNumber: ch.number,
        chapterTitle: ch.title,
        sectionId: sec.id,
        sectionTitle: sec.title,
        query: buildSectionQuery({
          subject,
          edition,
          chapterNumber: ch.number,
          sectionTitle: sec.title,
        }),
      });
    }
  }

  return tasks;
}

/**
 * 把「模型给的资源清单」摊成可落库的资源。
 *
 * ## ⚠️ 为什么不用 `web-search.ts` 的 SearchResult
 *
 * 那两条搜索路的产出**都不能直接当资源**：
 *
 * | 路 | 产出 | 能不能当资源 |
 * |---|---|---|
 * | Tavily | `{title, snippet}`，**没有 URL**（客户端刻意剥掉了） | ❌ |
 * | 模型自带搜索 | 一段总结，**更没有 URL** | ❌ |
 *
 * 而资源必须能点开 —— 没有 URL 的"资源"是个点不动的名字，
 * 比没有更糟（用户以为有了）。
 *
 * 所以预搜走**第三条路**：让模型联网后**直接给带 URL 的清单**
 *（`buildPresearchPrompt` 明确要求"不许编造网址"），
 * 用 `parsePresearchItems` 校验（只认 http/https）。
 *
 * 这个函数就是那条路的落库适配。
 */
export function toPresearchedResources(
  task: PresearchTask,
  items: readonly { title: string; url: string; why: string }[],
): PresearchedResource[] {
  return items.slice(0, 3).map((it) => ({
    title: it.title,
    url: it.url,
    chapterNumber: task.chapterNumber,
    sectionId: task.sectionId,
    why: it.why,
  }));
}