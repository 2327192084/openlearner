/**
 * 「让 AI 挑记忆闪卡」的纯逻辑（2026-11-10）。
 *
 * ## 为什么挑卡用 AI，而不是纯规则
 *
 * 规则能筛的只是「认知层级是 remember」这一层，但真正适合做记忆卡的
 * 是「短、独立、不依赖上下文」的那句话：
 *
 *  - ✅「线性时不变系统同时满足叠加性与时不变性」——单独看能懂，值得背
 *  - ❌「其推导过程见上一节」——离开上下文没有意义
 *  - ❌「本章讨论了三种方法：A、B、C，其中 A 用于…（三千字）」——太长
 *
 * 这个判断规则写不出来，但模型做得不错。所以让 AI 挑，
 * 用户在勾选框里确认 —— 不直接入库。
 *
 * ## 为什么要用户勾选
 *
 * AI 的判断可能不合用户的直觉（他觉得重要的模型没挑，反之亦然）。
 * 全自动入库会让用户面对一堆不想背的卡，还得一条条删。
 *
 * ## 这个模块只做纯逻辑
 *
 * 提示词构造、响应解析、候选筛选都不碰网络与存储 —— 便于单测。
 * 真正发请求的部分在 `pick-flashcards.ts` 的调用方。
 */

import type { KnowledgePoint } from '../model.ts';

/** 一个 AI 挑出来的候选 */
export interface FlashcardCandidate {
  knowledgePointId: string;
  /** 为什么挑它（给用户看，帮助他决定要不要勾） */
  reason: string;
}

/**
 * 构造「挑闪卡」的提示词。
 *
 * ## 为什么把知识点列表编号而不是给 id
 *
 * 让模型原样回传 `kp_8f3a...` 这种 id 很容易抄错（实测模型经常
 * 把 uuid 中间几位写错，或把两条的 id 串了）。编号（1、2、3…）
 * 抄错的代价小得多，而且我们能在**解析时校验编号范围**。
 *
 * 编号 → id 的映射留在本地，模型只回编号。
 */
export function buildPickPrompt(points: readonly KnowledgePoint[], limit: number): {
  system: string;
  user: string;
} {
  const system = [
    '你是学习助手，任务是从一批知识点里挑出**适合做记忆闪卡**的。',
    '',
    '## 什么样的知识点适合做记忆闪卡',
    '',
    '1. **短**：一句话能说完（不超过约 60 字）。太长的论述别人背不下来。',
    '2. **独立**：单独拿出来看能明白，不需要「上一节」「如图 1.2」这种上下文。',
    '3. **可考**：有明确的对错（定义、公式、性质、分类、条件）。',
    '   纯描述性的「本章讨论了…」不适合。',
    '4. **值得背**：是这门课的核心概念，不是边角注释。',
    '',
    '## 不适合的（不要挑）',
    '',
    '- 依赖上下文的指代（「其推导见上节」「如图所示的电路」）',
    '- 过长的论述、例子、证明过程',
    '- 纯粹的组织性文字（「本章分为三部分」）',
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 对象，不要解释文字、不要 markdown 围栏：',
    '',
    '{',
    '  "picks": [',
    '    { "n": 3, "reason": "一句话说明为什么适合背（10 字左右）" }',
    '  ]',
    '}',
    '',
    '`n` 是知识点的**编号**（不是 id）。最多挑 ' + String(limit) + ' 条。',
    '宁少勿滥：只挑真正适合的，不要凑数。',
  ].join('\n');

  const lines = points.map((p, i) => {
    const tags = (p.tags ?? []).join('、');
    const chapter = p.chapter ? `（${p.chapter}）` : '';
    return `${i + 1}. ${p.statement}${chapter}${tags ? ` [${tags}]` : ''}`;
  });

  const user = [
    '下面是这门课的知识点清单，请挑出适合做记忆闪卡的：',
    '',
    ...lines,
  ].join('\n');

  return { system, user };
}

/**
 * 解析模型返回的挑选结果。
 *
 * 容错点（都是实测会遇到的）：
 *  - 带 ```json 围栏
 *  - 前后有说明文字
 *  - `n` 是字符串 "3" 而不是数字
 *  - `n` 越界（模型数错编号）
 *  - 重复的编号
 *
 * **越界与重复一律丢弃**，不猜它想指哪一个 —— 挑错卡让用户背错内容，
 * 比少挑一条严重得多。
 */
export function parsePicks(
  content: string,
  points: readonly KnowledgePoint[],
): FlashcardCandidate[] {
  const json = extractJsonObject(content);
  if (!json) return [];

  const raw = (json as { picks?: unknown }).picks;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<number>();
  const out: FlashcardCandidate[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const nRaw = o.n;
    const n = typeof nRaw === 'number' ? nRaw : typeof nRaw === 'string' ? Number(nRaw) : NaN;
    if (!Number.isInteger(n)) continue;
    /* 编号是 1 基 */
    if (n < 1 || n > points.length) continue;
    if (seen.has(n)) continue;
    seen.add(n);

    const point = points[n - 1];
    if (!point) continue;

    const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 60) : '';
    out.push({ knowledgePointId: point.id, reason });
  }

  return out;
}

/**
 * 从可能不干净的文本里抠出 JSON 对象。
 *
 * 与 `parsePointsJson` 里那套思路一致（模型经常包一层说明文字或围栏），
 * 但这里不共享实现 —— 那边还要处理数组、字段修补等一堆事，
 * 这里只要一个对象。强行复用会让两处都变复杂。
 */
function extractJsonObject(content: string): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;

  let s = content.trim();
  /* 去掉 ```json ... ``` 围栏 */
  const fence = s.indexOf('```');
  if (fence >= 0) {
    const after = s.indexOf('\n', fence);
    const end = s.indexOf('```', after);
    if (after >= 0 && end > after) s = s.slice(after + 1, end).trim();
  }

  /* 从第一个 { 到最后一个 } */
  const start = s.indexOf('{');
  const stop = s.lastIndexOf('}');
  if (start < 0 || stop <= start) return null;

  try {
    const parsed = JSON.parse(s.slice(start, stop + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
