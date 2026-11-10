/**
 * 提问式复习（2026-11-10）。
 *
 * ## 它是什么
 *
 * 用户的口语化表述：
 *  > 用户可以选择资料库中的资料（整本书随机 / 某章节 / 某段落）或知识库里
 *  > 偏记忆或偏理解的知识点进行提问。用户根据自己的理解或记忆回答，
 *  > 把回答输入给 AI 判断是「记忆错误」还是「理解偏差」。
 *  > 记忆错误就输出原知识点完整内容；理解偏差要在原文基础上讲解。
 *
 * 这是三种复习方式里**唯一需要模型判断用户答案**的：
 *  - 今日复习：客观题自动判分 + 自评
 *  - 记忆闪卡：不判，只翻看
 *  - 提问式复习：**开放回答 → 模型判断**
 *
 * ## 为什么判定必须引用原文
 *
 * 「记忆错误 vs 理解偏差」这个分类在技术上很不稳定 —— 同一段错误回答，
 * 模型可能这次判记错、下次判理解偏。这是模型能力的边界，靠 prompt
 * 调不到 100%。
 *
 * 应对办法不是「想办法让判定更准」，而是**让它把依据摆出来**：
 * 输出里强制包含 `quotedFromSource`，界面把那段原文高亮。
 * 即使分类错了，用户也能看到它凭什么这么判，而不是一个黑箱结论。
 *
 * 这也顺带让「保存完整原文 / 精简」两个选项有了意义：
 * 完整版就是它引用的那段原文。
 *
 * ## 本模块只做纯逻辑
 *
 * 提问范围构造、提示词、响应解析、本地兜底。不发请求、不碰存储。
 */

import type { KnowledgePoint, SourceSegment } from './model.ts';

// ---------------------------------------------------------------------------
// 提问范围
// ---------------------------------------------------------------------------

/** 提问从哪里取内容 */
export type OralScope =
  /** 整份资料（随机抽段落） */
  | { kind: 'source'; sourceId: string; title: string }
  /** 指定章节（抽该章段落） */
  | { kind: 'chapter'; sourceId: string; chapter: string; title: string }
  /** 用户在原文里划选的一段 */
  | { kind: 'segment'; sourceId: string; segmentId: string; title: string }
  /** 指定知识点（可多选） */
  | { kind: 'points'; pointIds: string[]; title: string }
  /** 整库随机（跨资料） */
  | { kind: 'all' };

/** 一条可提问的素材（范围 → 素材，供模型生成问题） */
export interface OralMaterial {
  /** 稳定 id（段落 id 或知识点 id），用于回查原文 */
  id: string;
  /** 给用户看的来源说明，如「第 9 页 · 1.2 离散时间信号」 */
  label: string;
  /** 原文正文（模型据此提问，也是判定的依据） */
  text: string;
  /** 出处：资料 + 页码 + 字符偏移（判定后跳回原文用） */
  sourceId: string;
  page: number | null;
  chapter: string | null;
  /** 知识点 id（如果素材来自知识点） */
  pointId: string | null;
}

/**
 * 把段落转成提问素材。
 *
 * 与出题的 `segmentsToMaterials` 思路一致，但**不做 maxChars 截断**：
 * 提问需要完整上下文才能问出有意义的问题、也才能判断用户答得对不对。
 * 截断会让模型问出「根据上文…」然后上文被裁掉的情况。
 *
 * 太短的段落（页眉、孤行）跳过 —— 它们提不出值得回答的问题。
 */
export function segmentsToMaterials(
  segments: readonly SourceSegment[],
  sourceTitle: string,
): OralMaterial[] {
  return segments
    .filter((s) => s.text.trim().length >= 80)
    .map((s) => ({
      id: s.id,
      label: `${sourceTitle}${s.chapter ? ` · ${s.chapter}` : ''}${s.page ? ` · 第 ${s.page} 页` : ''}`,
      text: s.text.trim(),
      sourceId: s.sourceId,
      page: s.page,
      chapter: s.chapter,
      pointId: null,
    }));
}

/**
 * 知识点转素材。
 *
 * 优先用 `quotes`（逐字原文）而不是 `statement`（提炼后的一句话）：
 * 判定「理解偏差」需要看原文的完整表述，只有一句提炼语无法判断
 * 用户是不是理解偏了。没有 quotes 时退回 statement —— 总比没有好。
 */
export function pointsToMaterials(points: readonly KnowledgePoint[]): OralMaterial[] {
  return points
    .filter((p) => p.statement.trim().length > 0)
    .map((p) => ({
      id: p.id,
      label: p.chapter ? `${p.chapter}` : '未归章',
      text: (p.quotes.length > 0 ? p.quotes.join('\n\n') : p.statement).trim(),
      sourceId: p.sourceId ?? '',
      page: p.anchors[0]?.page ?? null,
      chapter: p.chapter,
      pointId: p.id,
    }));
}

/**
 * 从一堆素材里随机抽一条。
 *
 * 为什么需要随机：整本书随机提问时，每次都问第一节的第一个知识点
 * 就没意义了。用可注入的 random 便于测试（否则测试不可复现）。
 */
export function pickMaterial(
  materials: readonly OralMaterial[],
  random: () => number = Math.random,
): OralMaterial | null {
  if (materials.length === 0) return null;
  const i = Math.floor(random() * materials.length);
  /* 浮点边界：random() 恰好返回 1 时 i 会越界 */
  return materials[Math.min(i, materials.length - 1)] ?? null;
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/** 生成问题与判定共用同一个 system（模型看到一致的规则） */
export function buildOralSystemPrompt(): string {
  return [
    '你是学习助手，任务是就一段学习材料向学生提问，并判断他的回答。',
    '',
    '## 提问的要求',
    '',
    '1. 问**一个**具体问题，不要一次问多个。',
    '2. 问题要能从那材料里找到明确答案（不是开放讨论）。',
    '3. 优先问**核心概念**：定义、条件、区别、因果、分类。',
    '4. 不要问「这段讲了什么」这种概括题 —— 那测不出具体记忆。',
    '',
    '## 判断回答的要求',
    '',
    '把学生的回答归成三类之一：',
    '',
    '- `correct`：内容正确（表述不同但意思对也算对）。',
    '- `memory`：**记忆错误** —— 想起来了但记错了事实（数字、名称、条件写反）。',
    '- `understanding`：**理解偏差** —— 记得字面，但对含义、因果、适用范围理解错了。',
    '',
    '这两类的区别：记忆错误是「记岔了」，理解偏差是「想错了」。',
    '如果两者都占，判 `understanding`（理解错更根本）。',
    '',
    '## 必须给依据',
    '',
    '判定为 `memory` 或 `understanding` 时，**必须**从材料里逐字摘一段',
    '作为依据填进 `quotedFromSource`。不要改写、不要概括 —— 逐字复制。',
    '材料里找不到能支撑判定的原文时，判 `correct` 并说明理由。',
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 对象，不要解释文字、不要 markdown 围栏：',
    '',
    '{',
    '  "verdict": "correct | memory | understanding",',
    '  "quotedFromSource": "逐字摘自材料的依据（correct 时可空）",',
    '  "explanation": "针对学生这次回答的说明（不超过 120 字）",',
    '  "correction": "正确的说法（memory 时是完整原知识点；understanding 时指出想错在哪）"',
    '}',
  ].join('\n');
}

/**
 * 构造「生成问题」的用户提示词。
 *
 * 只让模型出问题，不让它同时判定 —— 判定时用户还没回答。
 * 两件事分开两次调用，提示词各自更短更聚焦。
 */
export function buildAskPrompt(material: OralMaterial): string {
  return [
    '## 材料',
    '',
    material.text,
    '',
    '## 任务',
    '',
    '就上面这段材料出一个问题。只输出问题本身，不要编号、不要「问题：」前缀、',
    '不要附加答案或提示。',
  ].join('\n');
}

/**
 * 构造「判定回答」的用户提示词。
 *
 * 把材料、问题、用户的回答一起给模型 —— 三者缺一不可：
 * 没有材料就没有判定依据，没有回答就无从判起。
 */
export function buildJudgePrompt(
  material: OralMaterial,
  question: string,
  answer: string,
): string {
  return [
    '## 材料（判定依据）',
    '',
    material.text,
    '',
    '## 问题',
    '',
    question,
    '',
    '## 学生的回答',
    '',
    answer.trim() || '（学生没有作答）',
    '',
    '## 任务',
    '',
    '判断这个回答属于 correct / memory / understanding 中的哪一类，按要求输出 JSON。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

export type OralVerdict = 'correct' | 'memory' | 'understanding';

/** 一次判定的结果 */
export interface OralJudgement {
  verdict: OralVerdict;
  /**
   * 逐字摘自材料的依据。
   *
   * `correct` 时可能为空；`memory` / `understanding` 时空值意味着
   * **模型没按格式给依据** —— 界面要如实提示「它没给出原文依据」，
   * 而不是假装有。
   */
  quotedFromSource: string;
  /** 针对这次回答的说明 */
  explanation: string;
  /** 正确的说法 */
  correction: string;
  /**
   * 引文是否在材料里**真的能找到**。
   *
   * 这是本模块最重要的一条校验：模型经常把引文改几个字（或整段编）。
   * 找不到就说明它的依据不可靠，界面必须标出来。
   */
  quoteVerified: boolean;
}

/**
 * 解析判定结果。
 *
 * 容错：围栏、前后说明文字、verdict 大小写。
 * **不猜**：verdict 认不出就退回 'understanding' 并附说明 ——
 * 那是「最需要讲解」的一类，宁可按更严格的处理。
 */
export function parseJudgement(content: string, material: OralMaterial): OralJudgement {
  const obj = extractJsonObject(content);
  if (!obj) {
    return {
      verdict: 'understanding',
      quotedFromSource: '',
      explanation: '模型没有返回可解析的结果。',
      correction: '',
      quoteVerified: false,
    };
  }

  const rawVerdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  const verdict: OralVerdict =
    rawVerdict === 'correct' || rawVerdict === 'memory' || rawVerdict === 'understanding'
      ? rawVerdict
      : 'understanding';

  const quote = typeof obj.quotedFromSource === 'string' ? obj.quotedFromSource.trim() : '';
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim().slice(0, 300) : '';
  const correction = typeof obj.correction === 'string' ? obj.correction.trim().slice(0, 600) : '';

  return {
    verdict,
    quotedFromSource: quote,
    explanation,
    correction,
    quoteVerified: quote.length > 0 && quotesMatch(quote, material.text),
  };
}

/**
 * 判断引文是否真的出现在材料里。
 *
 * 宽松到「忽略空白与全半角差异」—— 模型复制中文时经常把空格、
 * 换行、逗号搞成不同形式，那不是编造。但**字的顺序与内容必须一致**。
 *
 * 不宽松到「模糊匹配」：那会让编造的引文也通过校验，
 * 而我们做这一步校验的全部意义就是抓住编造。
 */
export function quotesMatch(quote: string, text: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '')
      .toLowerCase();
  if (!quote.trim()) return false;
  return norm(text).includes(norm(quote));
}

/** 从可能不干净的文本里抠出 JSON 对象 */
function extractJsonObject(content: string): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;
  let s = content.trim();

  const fence = s.indexOf('```');
  if (fence >= 0) {
    const after = s.indexOf('\n', fence);
    const end = s.indexOf('```', after);
    if (after >= 0 && end > after) s = s.slice(after + 1, end).trim();
  }

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

// ---------------------------------------------------------------------------
// 保存形式
// ---------------------------------------------------------------------------

/**
 * 一轮提问式复习的记录。
 *
 * 用户答完可以选择「保存」——存完整原文还是精简。
 * **默认不保存**（用户拍板：让用户自行选择；系统设置里可开自动保存）。
 */
export interface OralRecord {
  id: string;
  /** 提问来源的说明，如「第 9 页 · 1.2 离散时间信号」 */
  scopeLabel: string;
  question: string;
  answer: string;
  judgement: OralJudgement;
  /**
   * 保存形式。
   *
   * - `full`：完整原文（judgement 引用的那段材料全文）
   * - `brief`：只留问题 + 用户答错的关键点 + 一句纠正
   */
  savedAs: 'full' | 'brief';
  /** 完整原文（savedAs==='full' 时才有值） */
  fullText: string | null;
  createdAt: string;
}

/**
 * 把一条判定压成「精简」形式。
 *
 * 精简该留什么：问题是引子、用户的错误是「我错在哪」、
 * 纠正是「应该怎么记」。原文那几百字反而是噪音 ——
 * 用户回头翻的时候不想再读一遍材料。
 */
export function toBrief(judgement: OralJudgement): {
  explanation: string;
  correction: string;
} {
  return {
    explanation: judgement.explanation.slice(0, 120),
    correction: judgement.correction.slice(0, 200),
  };
}
