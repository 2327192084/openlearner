/**
 * 「AI 补章节」的纯逻辑（2026-11-21）。
 *
 * ## 为什么需要它
 *
 * 用户库实测：**96% 的知识点没有章节**（高数 46 条里 43 条 `chapter = null`）。
 * 后果有两个，都不轻：
 *
 *  1. 学习地图只能把几乎所有知识点堆进「未归类」一格 —— 那一页最有价值的
 *     分组维度实际上失效了
 *  2. 学习顺序不能按章节排（交接文档 9.3 原本的设想），只能靠 statement 文本
 *
 * 用户 2026-11-21 明确选择「先调 AI 把 105 条补上章节，再排序」。
 *
 * ## ⚠️ 这是**写用户真实数据**的操作
 *
 * 与「排学习顺序」有本质区别：
 *  - 排顺序的产物是**新的**结构化结果，存在它自己那儿，不改动知识点
 *  - 补章节要改 `KnowledgePoint.chapter` —— 那是用户自己的知识库内容
 *
 * 所以本模块只做三件事，**一个字节都不写库**：
 *  1. 构造提示词（模型只知道表述和现有线索，不给它 id）
 *  2. 解析模型返回的「编号 → 章节名」
 *  3. 算出一份**预览差异**（哪条会从 null 变成什么）
 *
 * 真正落库必须由调用方在用户**逐条看过预览并确认**之后单独执行，
 * 而且要带备份（见项目硬约束：动真实库必须明确授权 + 备份 + 证明写对库）。
 *
 * ## 为什么不让它编章节名
 *
 * 模型很容易「为了填满而造几个听起来合理的章节」（如把高数的内容
 * 编成「基础篇 / 进阶篇 / 拓展篇」）。这类名字既不对应用户的教材，
 * 又不能用来排序（排序需要真实的先修关系）。
 *
 * 所以提示词里有两条硬规矩：
 *  - **只从清单里已有的章节名里选**（同一份资料里往往已经有一两个真实章节名）
 *  - 实在判不出来就**留空**，不许编
 *
 * 解析层也照做：模型给出的章节名如果既不在已知集合里、又不是
 * 「显然是同一套命名」的（如「第三章」「第3章」这种归一后相同），一律丢弃。
 */

import type { KnowledgePoint } from '../model.ts';

/** 一条待补章节的知识点 */
export interface ChapterCandidate {
  id: string;
  statement: string;
  /** 现有的章节（null = 要补的） */
  chapter: string | null;
  /** 它来自哪份资料（提示词里用来分组，同一份资料章节命名一致） */
  sourceId: string | null;
}

/** 模型给出的一个建议 */
export interface ChapterSuggestion {
  pointId: string;
  /** 建议的章节名 */
  chapter: string;
  /** 为什么这么判断（给用户看，用于决定要不要采纳） */
  reason: string;
  /**
   * 这个建议是「沿用已有章节名」还是「新起的名字」。
   *
   * 界面必须区分显示：沿用已有的可信度高（同一份资料里已经有这个章节），
   * 新起的需要用户更仔细看 —— 那是模型自己的判断，可能是编的。
   */
  fromExisting: boolean;
}

/** 解析结果的失败原因（调用方据此决定重试或报错） */
export type ParseChapterResult =
  | { ok: true; suggestions: ChapterSuggestion[]; dropped: number }
  | { ok: false; reason: string };

/** 已知章节名的归一化：用于「第三章」与「第3章」判为同一个 */
export function normalizeChapterName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, '')
    /* 中文数字与阿拉伯数字都统一 —— 用户库里两种写法都出现过 */
    .replace(/第([一二三四五六七八九十]+)章/g, (_, cn: string) => `第${cnToNum(cn)}章`)
    .toLowerCase();
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function cnToNum(cn: string): number {
  if (cn.length === 1) return CN_DIGITS[cn] ?? 0;
  /* 十一 / 二十三 这类 */
  if (cn.startsWith('十')) return 10 + (CN_DIGITS[cn.slice(1)] ?? 0);
  const [tens, ones] = cn.split('十');
  return (CN_DIGITS[tens ?? ''] ?? 0) * 10 + (CN_DIGITS[ones ?? ''] ?? 0);
}

/** 单条表述在提示词里最多这么长 */
const STATEMENT_MAX = 60;

/**
 * 构造补章节的提示词。
 *
 * @param candidates 待补的知识点（`chapter === null` 的那些）
 * @param knownChapters 每份资料里**已有的**章节名（sourceId → 章节名集合）。
 *        这是防编造的关键：让模型从真实存在的名字里选。
 */
export function buildChapterPrompt(
  candidates: readonly ChapterCandidate[],
  knownChapters: ReadonlyMap<string, readonly string[]>,
): { system: string; user: string } {
  const system = [
    '你是一位熟悉教材结构的学科老师。学生从资料里整理出了一批知识点，',
    '但其中一部分没有记录它们属于哪一章。请根据知识点的内容推断章节。',
    '',
    '## 两条硬规矩',
    '',
    '### 1. 优先从已有章节名里选',
    '',
    '下面会给出每份资料里**已经存在**的章节名。如果能判断某个知识点属于其中某一章，',
    '就**原样照抄那个章节名**（不要改字、不要加序号）。',
    '',
    '### 2. 判不出来就留空，绝对不要编',
    '',
    '如果这些知识点来自同一份教材，你会看到它已有的章节是「第1章 函数与极限」这种格式，',
    '那么新推断的章节也应当是这个格式。',
    '',
    '**但如果你确实判断不出来，就不要猜** —— 漏补一条比编一个假章节好得多。',
    '编出来的章节名会让学生以为自己的资料是那样分章的，而那是假的。',
    '',
    '## 输出格式',
    '',
    '只输出一个完整的 JSON 对象，不要解释文字，不要 markdown 围栏：',
    '',
    '{',
    '  "assign": [',
    '    { "n": 3, "chapter": "第2章 导数与微分", "reason": "讲的是导数定义（15 字以内）" }',
    '  ]',
    '}',
    '',
    'n 是知识点的**编号**（不是 id）。判不出来的那条**不要写进 assign**。',
    '不要为了填满而每条都给一个章节。',
  ].join('\n');

  /* 清单按资料分组：同一份资料的章节命名一致，混在一起看模型容易串 */
  const lines: string[] = [];
  const bySource = new Map<string, ChapterCandidate[]>();
  for (const c of candidates) {
    const key = c.sourceId ?? '__none__';
    const arr = bySource.get(key);
    if (arr) arr.push(c);
    else bySource.set(key, [c]);
  }

  let n = 0;
  const indexOf = new Map<string, number>();
  for (const [sourceId, list] of bySource) {
    const known = knownChapters.get(sourceId) ?? [];
    const title = sourceId === '__none__' ? '（来源未知）' : `资料 ${sourceId}`;
    lines.push('');
    lines.push(`## ${title}`);
    if (known.length > 0) {
      lines.push(`这份资料已有的章节：${known.join(' / ')}`);
    } else {
      lines.push('这份资料还没有任何章节名，你可以按内容推断，但格式要统一。');
    }
    lines.push('');
    for (const c of list) {
      n += 1;
      indexOf.set(c.id, n);
      lines.push(`${n}. ${c.statement.trim().slice(0, STATEMENT_MAX)}`);
    }
  }

  const user = [
    `下面有 ${candidates.length} 条知识点需要推断章节。`,
    '格式：编号. 表述。',
    ...lines,
    '',
    '请按上面的规矩给出章节。判不出来的不要写。',
  ].join('\n');

  return { system, user };
}

/**
 * 解析模型返回的章节建议。
 *
 * ## 三层校验（每一层都对应一种实测会遇到的坏结果）
 *
 * 1. **编号**：越界/重复/非整数 → 丢弃（不知道它指哪一条）
 * 2. **章节名不能是空的** → 丢弃（没什么可写的）
 * 3. **章节名必须可信** → 以下是可信的两种，其余丢弃：
 *    a. 归一化后命中该资料**已有**的章节名（`fromExisting = true`）
 *    b. 是「第 N 章 …」这类可识别格式（`fromExisting = false`，界面提示需复核）
 *
 * 第 3 条是本模块与「排顺序」最大的不同：章节名会**写进用户的知识库**，
 * 一个假章节名会污染他的数据，而且以后按章节筛选/排序都会带着这个假章节。
 * 所以宁可少补，不许乱补。
 *
 * 与 `parsePlanOrder` 一样：残缺 JSON 整轮拒绝，不修补。
 */
export function parseChapterSuggestions(
  content: string,
  candidates: readonly ChapterCandidate[],
  knownChapters: ReadonlyMap<string, readonly string[]>,
): ParseChapterResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: '没有需要补章节的知识点。' };
  }

  const parsed = extractCompleteJsonObject(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const rawList = (parsed.value as { assign?: unknown }).assign;
  if (!Array.isArray(rawList)) {
    return { ok: false, reason: '返回的 JSON 里没有 assign 数组。' };
  }

  /* 每份资料已有的章节按归一化建索引，便于判定「是否沿用」 */
  const knownBySource = new Map<string, Map<string, string>>();
  for (const [sourceId, names] of knownChapters) {
    const m = new Map<string, string>();
    for (const name of names) {
      const k = normalizeChapterName(name);
      if (k) m.set(k, name);
    }
    knownBySource.set(sourceId, m);
  }

  const byId = new Map<string, ChapterCandidate>();
  for (const c of candidates) byId.set(c.id, c);
  /* 编号是全局递增的，解析时按候选清单原顺序还原 */
  const ordered = [...candidates];

  const seenN = new Set<number>();
  const seenPointId = new Set<string>();
  const suggestions: ChapterSuggestion[] = [];
  let dropped = 0;

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') {
      dropped += 1;
      continue;
    }
    const o = raw as Record<string, unknown>;

    const n = toInteger(o.n);
    if (n === null || n < 1 || n > ordered.length) {
      dropped += 1;
      continue;
    }
    if (seenN.has(n)) {
      dropped += 1;
      continue;
    }
    const cand = ordered[n - 1];
    if (!cand) {
      dropped += 1;
      continue;
    }
    /* 同一条被用不同编号提了两次：只认第一次 */
    if (seenPointId.has(cand.id)) {
      dropped += 1;
      continue;
    }

    const rawChapter = typeof o.chapter === 'string' ? o.chapter.trim() : '';
    if (rawChapter.length === 0) {
      dropped += 1;
      continue;
    }
    const chapter = rawChapter.slice(0, 40);

    /*
     * 可信性判定。这一层是关键：写进用户库的章节名必须站得住。
     */
    const knownMap = knownBySource.get(cand.sourceId ?? '__none__');
    const normalized = normalizeChapterName(chapter);
    const hit = knownMap?.get(normalized);

    let fromExisting = false;
    let finalChapter: string;

    if (hit) {
      /* 沿用已有章节名：用库里那个原始写法，不要模型改过的版本 */
      fromExisting = true;
      finalChapter = hit;
    } else if (looksLikeChapterName(chapter)) {
      /* 格式可识别（如「第3章 …」）但库里还没有 —— 不算编造，但需用户复核 */
      fromExisting = false;
      finalChapter = chapter;
    } else {
      /*
       * 既不是已有章节名，也不是可识别格式 —— 当作模型编的，丢弃。
       * 例：它给出「基础篇」「重点内容」这种自造分组名。
       */
      dropped += 1;
      continue;
    }

    seenN.add(n);
    seenPointId.add(cand.id);
    suggestions.push({
      pointId: cand.id,
      chapter: finalChapter,
      reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 60) : '',
      fromExisting,
    });
  }

  if (suggestions.length === 0 && dropped === 0) {
    /*
     * 一条都没给：这**不是失败** —— 提示词明确允许「判不出来就留空」。
     * 但要让调用方知道「模型认为这批都不需要补」，界面应如实说。
     */
    return { ok: true, suggestions: [], dropped: 0 };
  }

  return { ok: true, suggestions, dropped };
}

/**
 * 章节名是否像一章的名字。
 *
 * 只认几种常见的教材写法：
 *  - 「第3章 …」「第三章 …」
 *  - 「3. …」「3.1 …」
 *  - 「Chapter 3 …」
 *  - 「模块三」「单元 2」
 *
 * 为什么定这么窄：宽一点（比如「长度 2–40 就算」）会让
 * 「基础篇」「核心概念」这类自造分组名混进来，而那些正是要挡的。
 */
function looksLikeChapterName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/^第[0-9一二三四五六七八九十百]+[章节讲部篇]/.test(t)) return true;
  if (/^[0-9]+(\.[0-9]+)*[\s.、:：]/.test(t)) return true;
  if (/^chapter\s*[0-9]+/i.test(t)) return true;
  if (/^(模块|单元|专题|讲)\s*[0-9一二三四五六七八九十]+/.test(t)) return true;
  return false;
}

/** 数字或数字字符串 → 整数；其余 null（不猜） */
function toInteger(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * 一份「补章节」的预览：用户确认之前看到的全部内容。
 *
 * 界面必须能逐条勾选：AI 的判断可能不合他的直觉，
 * 全自动写库会让他面对一堆错章节还得一条条改。
 */
export interface ChapterPreview {
  /** 会被改动的条目（含原值与新值，便于并排显示） */
  changes: {
    pointId: string;
    statement: string;
    from: null;
    to: string;
    reason: string;
    fromExisting: boolean;
  }[];
  /** 模型没给建议的条数（保持 null 不动） */
  untouched: number;
  /** 被丢弃的条数（编号错 / 章节名不可信） */
  dropped: number;
}

/**
 * 把解析结果整理成一份可给用户看的预览。
 *
 * 注意 `from` 恒为 `null`：本模块**只补空章节**。
 * 已经有章节的知识点不参与（不覆盖用户已经写好的判断）——
 * 这条限制写在类型里，调用方就没法误用。
 */
export function buildChapterPreview(
  candidates: readonly ChapterCandidate[],
  suggestions: readonly ChapterSuggestion[],
  dropped = 0,
): ChapterPreview {
  const byId = new Map<string, ChapterCandidate>();
  for (const c of candidates) byId.set(c.id, c);

  const changes: ChapterPreview['changes'] = [];
  const touched = new Set<string>();

  for (const s of suggestions) {
    const c = byId.get(s.pointId);
    if (!c) continue;
    /* 只补空的，已有章节一律不动 */
    if (c.chapter !== null) continue;
    touched.add(s.pointId);
    changes.push({
      pointId: s.pointId,
      statement: c.statement,
      from: null,
      to: s.chapter,
      reason: s.reason,
      fromExisting: s.fromExisting,
    });
  }

  return {
    changes,
    untouched: candidates.length - touched.size,
    dropped,
  };
}

/** 从一批知识点里挑出「需要补章节」的候选 */
export function toChapterCandidates(points: readonly KnowledgePoint[]): ChapterCandidate[] {
  const out: ChapterCandidate[] = [];
  for (const p of points) {
    /* 只收空的 —— 已经有章节的不动，那是用户/上次整理的结果 */
    if (p.chapter !== null && p.chapter.trim().length > 0) continue;
    out.push({
      id: p.id,
      statement: p.statement,
      chapter: null,
      sourceId: p.sourceId,
    });
  }
  return out;
}

/**
 * 收集每份资料里**已有的**章节名（去重、保序）。
 *
 * 这是防编造的关键输入：模型能看到「同一份资料里已经有什么章节」，
 * 就能照着格式推断，而不是自己发明一套。
 */
export function collectKnownChapters(
  points: readonly KnowledgePoint[],
): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();

  for (const p of points) {
    const ch = p.chapter?.trim();
    if (!ch) continue;
    const key = p.sourceId ?? '__none__';
    const norm = normalizeChapterName(ch);
    let s = seen.get(key);
    if (!s) {
      s = new Set<string>();
      seen.set(key, s);
    }
    if (s.has(norm)) continue;
    s.add(norm);
    const arr = bySource.get(key);
    if (arr) arr.push(ch);
    else bySource.set(key, [ch]);
  }

  return bySource;
}

/**
 * 从可能不干净的文本里抠出一个**括号完整配对**的 JSON 对象。
 *
 * 与 `plan-order.ts` 里那份同源（那边是私有实现，这边也是私有实现 ——
 * 抽公共工具会让两边都要加参数，反而更绕；两处各二十行，读起来更直接）。
 * 严格版：括号深度没归零直接判失败，绝不修补。
 */
function extractCompleteJsonObject(
  content: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let s = content.trim();

  const fence = s.indexOf('```');
  if (fence >= 0) {
    const after = s.indexOf('\n', fence);
    const end = s.indexOf('```', after + 1);
    if (after >= 0 && end > after) s = s.slice(after + 1, end).trim();
  }

  const start = s.indexOf('{');
  if (start < 0) return { ok: false, reason: '返回的内容里没有 JSON 对象。' };

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return { ok: false, reason: '返回的 JSON 括号不配对。' };
    }
  }

  if (end < 0) {
    return { ok: false, reason: '返回的 JSON 不完整（可能被截断），已丢弃。' };
  }

  let value: unknown;
  try {
    value = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: false, reason: '返回的 JSON 解析失败，已丢弃。' };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: '返回的 JSON 顶层不是对象。' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
