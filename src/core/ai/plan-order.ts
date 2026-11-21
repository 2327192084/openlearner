/**
 * 「AI 学习顺序」的纯逻辑（2026-11-21）。
 *
 * ## 用户要的是什么
 *
 * 原话：「学习地图回答我该按什么顺序学、推到哪一步」。
 *
 * 注意这不等于「再摊开一遍掌握度」—— 学习地图已经在做那件事了。
 * 他要的是**一条路线**：先学 A，再学 B，我现在走到第几步。
 *
 * ## 为什么要调 AI，规则做不到吗
 *
 * 「先学极限再学导数」这种排序靠的是**学科知识**（哪个概念是哪一层的前置），
 * 数据里没有这个信息：知识点的 `chapter` 96% 是 null（用户库实测：
 * 高数 46 条里 43 条没有章节），`tags` 也不承载依赖关系。
 * 按认知层级排只能得到「记忆→理解→应用→分析」这一个粗序，
 * 那对用户没有新信息。
 *
 * ## 参考了 LogiNote，但有三处刻意不同
 *
 * 来源：https://github.com/GlimmerElve/LogiNote-Chinese-version-
 *   `src/workflows/planGenerationPrompt.ts` / `planCoreScope.ts`（2026-11-21 读过全文）
 *
 * | | LogiNote | 这里 | 为什么 |
 * |---|---|---|---|
 * | 难度字段 | **没有** difficulty | **有** difficulty 1–5 | 「重难点」是它的结构性缺口；用户问「推到哪一步」时最想知道哪几条最费劲 |
 * | 理由字段 | **刻意砍掉**（省 token） | **必须给** reason + basis | 用户看不懂为什么这么排，就不会照做 —— 理由就是产品价值 |
 * | 排序粒度 | `priority`(3 档) + `dependencyKeys` 依赖图 | 扁平分组 + 块内顺序 | 依赖图要用户先建图，本地数据里没有；按块排能让用户一眼验证 |
 * | 掌握度 | 明确防过「把已有笔记等同于已经掌握」 | **同一立场，且更强** | 难度由模型给、掌握度由本地算，两者在提示词里分开写明 |
 *
 * ## 为什么模型只回编号，不回 uuid
 *
 * 与 `pick-flashcards.ts` 同一条实测经验：让模型抄 `kp_8f3a...` 很容易抄错
 * （uuid 中间几位写错、两条串号）。编号（1、2、3…）抄错的代价小得多，
 * 而且我们能在**解析时校验编号范围**。编号 → 真实 id 的映射留在本地。
 *
 * ## 为什么 order 是本地算的，不让模型写序号
 *
 * 让模型同时写「块顺序」和「条内序号」会多一个出错面：它的块顺序和序号
 * 完全可能互相矛盾（块 2 里写着 order 7、块 3 里写着 order 5）。
 * 改成**数组位置即顺序**：块的数组下标就是块的先后，块内数组下标就是条的先后。
 * 这样 order 天然连续、天然不重复，模型没有机会写错。
 * 我们只在解析后派生出全局序号（1..N）给界面用。
 *
 * ## 为什么残缺的 JSON 直接判失败，不修补
 *
 * 同 LogiNote 的做法：**绝不修补括号、绝不续写残片**。
 * 修补出来的 JSON 可能是「一半的排序被丢掉了但看不出来」，
 * 而排序是个整体 —— 少了几条，剩下的顺序就失去意义。
 * 所以宁可整轮重试（调用方决定重试几次）。
 *
 * ## 这个模块只做纯逻辑
 *
 * 不碰网络、不碰存储、不碰 React —— 便于单测。
 */

import type { KnowledgePoint } from '../model.ts';

/**
 * 参与排序的一条知识点（已经带上本地算出的弱项信号）。
 *
 * 注意 `mastery` 与 `daysSinceReview` 都**由本地计算**，
 * 模型只读不写 —— 见文件头「难度由模型给、掌握度由本地算」。
 */
export interface PlanPointInput {
  id: string;
  statement: string;
  chapter: string | null;
  cognitiveLevel: KnowledgePoint['cognitiveLevel'];
  /** 本地算的掌握度 0–1；0 = 没练过 */
  mastery: number;
  /** 错过几次（来自复习日志） */
  wrongCount: number;
  /** 距上次复习多少天；null = 从没练过 */
  daysSinceReview: number | null;
}

/** 排好序的一条知识点 */
export interface PlanItem {
  /** 真实知识点 id（由编号映射回来） */
  pointId: string;
  /** 全局序号，1 基。按块顺序 + 块内顺序派生，**不是模型给的** */
  order: number;
  /** 第几块（0 基） */
  blockIndex: number;
  /**
   * 模型判断的难度 1（最容易）– 5（最难）。
   *
   * 缺失或非法时为 `null` —— **如实说「不知道」，不猜一个中间值**。
   * 猜一个 3 会让界面显示一个假的「中等难度」，比不显示更糟。
   */
  difficulty: number | null;
  /** 为什么排在这个位置（给用户看，20 字以内） */
  reason: string;
  /** 凭什么这么判断（如「是第 3 章的前置」） */
  basis: string;
}

/** 一个学习块 */
export interface PlanBlock {
  title: string;
  /** 为什么先学这一块 */
  why: string;
  items: PlanItem[];
}

/** 解析成功的结果 */
export interface PlanOrder {
  blocks: PlanBlock[];
  /**
   * 没被模型排进来的知识点编号（1 基）。
   *
   * 必须如实返回：模型漏掉几条时，界面要写「还有 N 条没排」，
   * 而不是让那几条**悄悄消失**。用户库里 105 条基础知识，
   * 少排几条他看不出来，但「这条路走完还有没学的」他一定感觉得到。
   */
  unplaced: number[];
  /** 被丢弃的条目数（编号越界 / 重复 / 形状不对） */
  dropped: number;
}

/** 解析结果：成功带 plan，失败带原因（调用方据此决定重试或报错） */
export type ParsePlanResult =
  | { ok: true; plan: PlanOrder }
  | { ok: false; reason: string };

/**
 * 建议分成几块。
 *
 * 为什么不是固定 5–8：知识点只有 4 条时逼模型分 5 块，
 * 它只能把一条拆成两块或编块名 —— 两者都是坏结果。
 *
 * 阈值取 6 / 20：低于 6 条时 2–3 块读起来正好；
 * 20 条以上才开始需要 5–8 块的层级（一屏能扫完）。
 */
export function suggestBlockRange(pointCount: number): { min: number; max: number } {
  if (pointCount <= 0) return { min: 1, max: 1 };
  if (pointCount < 6) return { min: 2, max: 3 };
  if (pointCount < 20) return { min: 3, max: 5 };
  return { min: 5, max: 8 };
}

/** 单条表述在提示词里最多这么长 —— 太长的论述会把整份清单撑爆 */
const STATEMENT_MAX = 60;

/**
 * 一条知识点在提示词里的样子。
 *
 * 形如：`12. 极限存在的充分必要条件（第2章｜理解｜没练过）`
 *
 * ## 为什么掌握度写成文字而不写数字
 *
 * `0.03` 这种数字模型会拿去做奇怪的事（比如当成难度）。
 * 写「没练过」「刚起步」「熟练」是**人话**，也在提示词里与难度分开表述，
 * 减少「把掌握度当难度」的诱导。
 *
 * ## 为什么没有章节时干脆不写
 *
 * 写「（无章节）」会占位又没信息；模型看到 `null` 反而可能开始编章节名。
 */
function formatPointLine(p: PlanPointInput, n: number): string {
  const statement = p.statement.trim().slice(0, STATEMENT_MAX);
  const facts: string[] = [];
  if (p.chapter) facts.push(p.chapter);
  facts.push(LEVEL_LABEL[p.cognitiveLevel]);
  facts.push(masteryWord(p));

  const tail = facts.filter((s) => s.length > 0).join('｜');
  return tail ? `${n}. ${statement}（${tail}）` : `${n}. ${statement}`;
}

const LEVEL_LABEL: Record<KnowledgePoint['cognitiveLevel'], string> = {
  remember: '记忆',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
};

/**
 * 把掌握度与练习情况说成人话。
 *
 * 档位与 `srs.ts` 的 `masteryLabel` 对齐（0.85 很熟 / 0.6 熟练 / 0.35 有点印象），
 * 免得同一个数字在两个界面上有两种说法。
 */
function masteryWord(p: PlanPointInput): string {
  if (p.daysSinceReview === null || p.mastery <= 0) return '没练过';
  if (p.wrongCount > 0 && p.mastery < 0.85) return `错过${p.wrongCount}次`;
  if (p.mastery >= 0.85) return '很熟';
  if (p.mastery >= 0.6) return '熟练';
  if (p.mastery >= 0.35) return '有点印象';
  return '刚起步';
}

/**
 * 构造「排学习顺序」的提示词。
 *
 * 返回 system + user 两段。system 里的三条硬规矩是本模块最重要的部分
 * （尤其是「难度不是掌握度」那条），改动前请读文件头的对照表。
 */
export function buildPlanPrompt(points: readonly PlanPointInput[]): {
  system: string;
  user: string;
} {
  const range = suggestBlockRange(points.length);

  const system = [
    '你是一位有经验的学科老师，任务是给一个学生排「先学什么、后学什么」的学习顺序。',
    '',
    '## 你要做的事',
    '',
    `把下面的知识点清单归成 ${range.min}–${range.max} 块（一块 = 一个连贯的学习单元，`,
    '比如「极限的基本概念」），块与块之间按该先学哪块排好，块内再按该先学哪条排好。',
    '',
    '## 判断顺序时看什么',
    '',
    '1. **前置依赖**：不懂 A 就学不会 B 的，A 必须排在 B 前面。这是最重要的一条。',
    '2. **由浅入深**：同一块里，认知层级低的（记忆、理解）在前，高的（应用、分析）在后。',
    '3. **薄弱优先**：错过题、练得生疏、很久没碰过的，尽量往前面挪 —— 那是最该补的。',
    '4. **难度梯度**：一块之内尽量从易到难。',
    '',
    '## 三条硬规矩',
    '',
    '### 1. 难度由你判断，掌握度不是你的事',
    '',
    '括号里的「没练过 / 刚起步 / 熟练 / 很熟」是**本地算出来的掌握度**，',
    '意思是「这个学生把这个点练得多熟」。它**不等于**「这个知识点本身难不难」。',
    '',
    '- 学生没练过的点，可能其实很容易；',
    '- 学生练得很熟的点，也可能是全书最难的。',
    '',
    '所以你给的 difficulty 只看**知识点本身**，不要因为「他没练过」就标成 5。',
    '',
    '### 2. 必须给理由',
    '',
    '每一条都要写 reason：为什么排在这个位置（一句话，20 字以内）。',
    '还要写 basis：你凭什么这么判断（例如「是后面所有章节的前置」「认知层级最高」「他错过 3 次」）。',
    '',
    '没有理由的排序对用户没有价值 —— 他看不懂为什么这么排，就不会照着做。',
    '',
    '### 3. 只输出一个完整的 JSON 对象',
    '',
    '不要解释文字，不要 markdown 围栏。',
    'JSON 必须完整 —— 残缺的结果会被整份丢弃重来，所以宁可少写几条，也要把括号写全。',
    '',
    '## 输出格式',
    '',
    '{',
    '  "blocks": [',
    '    {',
    '      "title": "块名（6–12 字，如「极限的基本概念」）",',
    '      "why": "为什么先学这一块（一句话）",',
    '      "items": [',
    '        {',
    '          "n": 12,',
    '          "difficulty": 3,',
    '          "reason": "为什么排在这个位置（20 字以内）",',
    '          "basis": "凭什么这么判断（如「是第 3 章的前置」）"',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    'n 是知识点的**编号**（不是 id）。每个编号最多出现一次，',
    '清单里每一条都要出现在某一块里，不要漏。',
    'difficulty 是 1（最容易）到 5（最难）的整数。',
  ].join('\n');

  const lines = points.map((p, i) => formatPointLine(p, i + 1));

  const user = [
    `下面是这门课的知识点清单（共 ${points.length} 条）。`,
    '格式：编号. 表述（章节｜认知层级｜掌握度）。没有章节的说明原文里没划出章节。',
    '',
    ...lines,
    '',
    `请把它们归成 ${range.min}–${range.max} 块，排出学习顺序。`,
  ].join('\n');

  return { system, user };
}

/**
 * 解析模型返回的排序结果。
 *
 * ## 拒绝 vs 容错的分界（这条线很重要）
 *
 * **整轮拒绝**（返回 ok:false，调用方重试）：
 *  - JSON 不完整（括号不配对、被截断）
 *  - 顶层不是对象、没有 blocks 数组
 *  - blocks 里一条有效条目都没有
 *
 * **单条丢弃**（计入 dropped，其余照用）：
 *  - n 不是整数 / 越界 / 重复出现
 *  - item 不是对象
 *
 * 前者是「整份结果不可信」，后者是「某几条抄错了」。
 * 混为一谈的话，要么因为一条错字丢掉整轮好结果，
 * 要么拿一份残缺的排序当真。
 *
 * ## difficulty 非法时保留条目、置 null
 *
 * 与「编号越界就丢弃」不同：编号错了**不知道它指哪条**，只能丢；
 * 难度错了条目本身还是对的，只是难度未知 —— 丢掉它反而损失顺序信息。
 * 所以置 null，界面显示「难度未知」，不猜。
 */
export function parsePlanOrder(content: string, points: readonly PlanPointInput[]): ParsePlanResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }
  if (points.length === 0) {
    return { ok: false, reason: '没有可排序的知识点。' };
  }

  const parsed = extractCompleteJsonObject(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const rawBlocks = (parsed.value as { blocks?: unknown }).blocks;
  if (!Array.isArray(rawBlocks)) {
    return { ok: false, reason: '返回的 JSON 里没有 blocks 数组。' };
  }

  const seen = new Set<number>();
  const unplaced = new Set<number>();
  const blocks: PlanBlock[] = [];
  let dropped = 0;
  let order = 0;

  for (const rawBlock of rawBlocks) {
    if (!rawBlock || typeof rawBlock !== 'object') {
      dropped += 1;
      continue;
    }
    const b = rawBlock as Record<string, unknown>;
    const rawItems = b.items;
    if (!Array.isArray(rawItems)) {
      dropped += 1;
      continue;
    }

    const blockIndex = blocks.length;
    const items: PlanItem[] = [];

    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== 'object') {
        dropped += 1;
        continue;
      }
      const o = rawItem as Record<string, unknown>;

      const n = toInteger(o.n);
      if (n === null) {
        dropped += 1;
        continue;
      }
      /* 编号越界 = 不知道它指哪一条，只能丢 */
      if (n < 1 || n > points.length) {
        dropped += 1;
        continue;
      }
      /* 重复 = 已经排过，保留第一次出现的位置（先出现的顺序更靠前） */
      if (seen.has(n)) {
        dropped += 1;
        continue;
      }
      const point = points[n - 1];
      if (!point) {
        dropped += 1;
        continue;
      }

      seen.add(n);
      order += 1;
      items.push({
        pointId: point.id,
        order,
        blockIndex,
        difficulty: toDifficulty(o.difficulty),
        reason: toShortText(o.reason, 60),
        basis: toShortText(o.basis, 80),
      });
    }

    /* 一条有效条目都没有的块不留 —— 空块在界面上是一行没内容的标题 */
    if (items.length === 0) continue;

    blocks.push({
      title: toShortText(b.title, 24) || `第 ${blockIndex + 1} 块`,
      why: toShortText(b.why, 80),
      items,
    });
  }

  if (blocks.length === 0) {
    return { ok: false, reason: '返回的排序里没有任何一条有效知识点。' };
  }

  /*
   * 重新编号：空块被丢掉之后，blockIndex 会出现空洞（0, 2, 3…）。
   * 不重排的话界面按 blockIndex 分组会出现「第 2 块不见了」。
   * order 不受影响（它只递增），但为了让「全局序号 == 路径上的序号」
   * 这条不变式成立，这里连 order 一起重排。
   */
  let seq = 0;
  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi]!;
    for (const item of block.items) {
      item.blockIndex = bi;
      seq += 1;
      item.order = seq;
    }
  }

  for (let n = 1; n <= points.length; n += 1) {
    if (!seen.has(n)) unplaced.add(n);
  }

  return {
    ok: true,
    plan: { blocks, unplaced: [...unplaced].sort((a, b) => a - b), dropped },
  };
}

/** 数字或数字字符串 → 整数；其余一律 null（不猜） */
function toInteger(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * 难度归一：只认 1–5 的整数。
 *
 * 越界不夹到边界值 —— 夹值等于替模型编了一个它没说过的判断。
 * 返回 null 让界面如实写「难度未知」。
 */
function toDifficulty(v: unknown): number | null {
  const n = toInteger(v);
  if (n === null) return null;
  if (n < 1 || n > 5) return null;
  return n;
}

/** 截断到 max 个字符的干净字符串；非字符串 → 空串 */
function toShortText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

/**
 * 从可能不干净的文本里抠出一个**括号完整配对**的 JSON 对象。
 *
 * 与 `pick-flashcards.ts` 里那个私有实现的差别：这里是**严格版**。
 * 那个版本从第一个 `{` 取到最后一个 `}` 后交给 JSON.parse，靠 parse 报错；
 * 这个版本先自己扫一遍括号深度（跳过字符串内部的括号与转义），
 * 深度没归零就直接判失败 —— 因为被截断的 JSON 交给某些宽松解析器
 * 可能「看起来能解析」，而半份排序比报错更难发现。
 *
 * 允许前后有说明文字与 markdown 围栏（模型经常包一层），
 * 但**不允许**修补：缺括号、缺引号、尾逗号一律整轮失败。
 */
function extractCompleteJsonObject(
  content: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let s = content.trim();

  /* 去掉 ```json ... ``` 围栏（只处理成对出现的那个） */
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
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
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

/**
 * 把解析结果的块压平成一个有序的「路径」。
 *
 * 界面要回答「推到哪一步」，就需要一条线性的顺序。
 * 这个函数把它摊开，并允许调用方传入「哪些已经学过」来算进度 ——
 * **进度是本地算的，不看模型脸色**。
 */
export function flattenPlan(plan: PlanOrder): PlanItem[] {
  const out: PlanItem[] = [];
  for (const b of plan.blocks) {
    for (const it of b.items) out.push(it);
  }
  return out;
}

/**
 * 路径走到第几步。
 *
 * @param plan     解析好的排序
 * @param isLearned 某个 pointId 是否已经学过（本地掌握度 > 0 或有过复习记录）
 *
 * 返回：
 *  - `learnedCount` 已学过的条数
 *  - `total`        路径总条数
 *  - `nextPointId`  下一该学的（第一条第 unlearned 的）；全学完为 null
 *  - `nextOrder`    下一条的全局序号；全学完为 null
 *
 * 为什么「推到哪一步」要按条算而不是按块算：
 * 用户心里的进度是「这几条我会了」，不是「第 2 块整块会了」。
 * 按块算会出现「块里 8 条会了 7 条，进度仍是 0/3 块」的失真。
 */
export function planProgress(
  plan: PlanOrder,
  isLearned: (pointId: string) => boolean,
): {
  learnedCount: number;
  total: number;
  nextPointId: string | null;
  nextOrder: number | null;
} {
  const flat = flattenPlan(plan);
  let learnedCount = 0;
  let next: PlanItem | null = null;

  for (const it of flat) {
    if (isLearned(it.pointId)) {
      learnedCount += 1;
    } else if (!next) {
      next = it;
    }
  }

  return {
    learnedCount,
    total: flat.length,
    nextPointId: next?.pointId ?? null,
    nextOrder: next?.order ?? null,
  };
}
