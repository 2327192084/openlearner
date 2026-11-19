/**
 * 提示阶梯（2026-11-19）。
 *
 * ## 它解决什么
 *
 * 现在的做题只有两态：会 / 不会。用户盯着题目不会做时，唯一的出路是
 * 「直接看答案」—— 那等于放弃思考，什么也学不到。
 *
 * 提示阶梯给中间那几档：先给方向，还不够就拆成小问题，再不够点出关键条件，
 * 实在不行给个相似的小例子。用户可以在任何一档停下来自己想。
 *
 * 来源：LogiNote v1.1.3 的 `REVIEW_TUTOR_PROMPT`「提示阶梯」一节 ——
 * 「依次使用：方向提示 → 拆成更小问题 → 关键条件或中间步骤 → 相似例子的最小讲解」。
 *
 * ## 最要紧的一条：用了强提示就不算真会
 *
 * LogiNote 原文：「强提示后必须保持同一目标，换一种问法要求学生无提示重答；
 * 未完成重答前不要推进到新知识点。」
 *
 * 翻译到我们这个流程：**用了 3–4 级提示才答对的题，不能算「真会」**。
 *
 * 为什么这条比提示本身更重要：
 * 间隔复习的调度依据是「你这次答得怎么样」。如果看了强提示才答对也记成
 * 「答对」，它会推进间隔、往「很熟」走 —— 而用户其实还不会。提示于是变成
 * 安慰剂，让调度器系统性地误判。
 *
 * 所以这里不只要生成提示，还要给出一份**「这次算不算真会」的判定**，
 * 由界面与调度共同使用。
 *
 * ## 本模块只做纯逻辑
 *
 * 提示的分级定义、提示词构造、响应解析、以及「算不算真会」的判定。
 * 不碰网络与存储。
 */

/** 提示级别。0 = 没要提示 */
export type HintLevel = 0 | 1 | 2 | 3 | 4;

/** 一级提示的说明 */
export interface HintStep {
  level: Exclude<HintLevel, 0>;
  label: string;
  /** 给模型的要求（不同级给的东西完全不同，不能只改措辞） */
  instruction: string;
  /** 界面上给用户看的后果提示（用到这一级就要提醒他） */
  warning: string | null;
}

/**
 * 四级阶梯。
 *
 * ## 为什么每一级的 instruction 差这么多
 *
 * 提示最容易做错的方式是「同一句话换个说法」—— 那用户点了四级
 * 等于把答案看了四遍。真正的阶梯必须是**信息量递增**的：
 *  1 级只给方向（不涉及本题内容）
 *  2 级给一个更小的问句（引入思考路径，但还不要答案）
 *  3 级点出关键条件（本题要用到的事实）
 *  4 级给相似例子（同构但不同题，可以照着想）
 *
 * 从 1 到 4，模型"泄露"的内容单调增加 —— 这是这个设计的核心约束。
 */
export const HINT_STEPS: readonly HintStep[] = [
  {
    level: 1,
    label: '给个方向',
    instruction:
      '只给一句**方向性**的提示：告诉学生该往哪个角度想（例如"想想这个概念成立的前提"、'
      + '"注意题干里的限定词"）。**不要提到本题的具体内容、不要点出任何选项、不要给答案。**',
    warning: null,
  },
  {
    level: 2,
    label: '拆成小问题',
    instruction:
      '把这道题拆成一个**更小的子问题**让学生先回答，用这个子问题引导他靠近答案。'
      + '子问题要具体、能一句话回答。**仍然不要直接给答案。**',
    warning: null,
  },
  {
    level: 3,
    label: '点出关键条件',
    instruction:
      '直接点出这道题**必须用到的那个关键条件或事实**（例如"题设给的是有限序列"）。'
      + '只给这一个条件，不要顺手把整条推理链讲完，也不要直接说选哪个。',
    warning: '这是强提示：看过之后答对，这题不算真会。',
  },
  {
    level: 4,
    label: '给个相似例子',
    instruction:
      '给一个**同构但不同**的小例子，把同类问题的解法演一遍，让学生能照着例子推本题。'
      + '例子要简单、能自己验算。给完例子仍然不要直接说本题选什么。',
    warning: '这是最强提示：看过之后答对，这题不算真会。',
  },
];

/** 强提示的起始级别（用到这些级就不算真会） */
export const STRONG_HINT_FROM: HintLevel = 3;

/** 提示请求的输入 */
export interface HintInput {
  prompt: string;
  /** 题型（决定选项要不要给模型看） */
  kind: string;
  options: readonly { key: string; text: string }[];
  answer: string;
  explanation: string;
  /** 用户已经选了什么（可能空；有的话模型能针对他的选择给提示） */
  given: string;
  /** 要第几级 */
  level: Exclude<HintLevel, 0>;
  /** 之前已经给过哪几级（避免重复给同样的内容） */
  previousHints?: readonly { level: HintLevel; text: string }[];
}

/** 一条提示 */
export interface HintResult {
  level: Exclude<HintLevel, 0>;
  /** 提示正文 */
  text: string;
}

/**
 * 构造提示词。
 *
 * ## 为什么把「已经给过什么」也告诉模型
 *
 * 用户点了 1 级觉得不够、再点 2 级时，如果模型又把 1 级那句话换个说法重复一遍，
 * 用户会觉得"点了没用"。把已给的提示带上，明确要求"要比上一次更进一步"。
 */
export function buildHintPrompt(input: HintInput): { system: string; user: string } {
  const step = HINT_STEPS.find((s) => s.level === input.level);
  if (!step) throw new Error(`没有第 ${input.level} 级提示`);

  const system = [
    '你是学习助手，正在给学生**逐级**的提示。学生卡在这道题上了。',
    '',
    '## 最重要的一条',
    '',
    '**不要直接给答案，也不要说「所以选 X」。**',
    '你的任务是把他的思考往前推一步，让他自己走到答案。',
    '如果你把答案说了，他就失去了一次自己想起来的机会 —— 那比不给提示更糟。',
    '',
    '## 这一级的要求',
    '',
    step.instruction,
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 对象，不要 markdown 围栏：',
    '{',
    '  "text": "提示正文（简洁，一两句话；需要举例子时可以稍长）"',
    '}',
  ].join('\n');

  const lines: string[] = [];
  lines.push('## 题目', '', input.prompt, '');

  if (input.options.length > 0) {
    lines.push('## 选项', '');
    for (const o of input.options) {
      lines.push(`- ${o.key}. ${o.text}`);
    }
    lines.push('');
  }

  /*
   * 答案与解析：给模型看，但明确禁止它转述。
   *
   * 为什么还要给：不给的话模型无法判断"关键条件"是哪个、例子该举什么。
   * 给了再要求它别说，比不给让它瞎猜要可靠 —— 这和变式出题那边
   * 「把答案也给它」是同一个判断。
   */
  if (input.answer) {
    lines.push('## 正确答案（**只供你判断方向，绝不要在提示里说出来**）', '', input.answer, '');
  }
  if (input.explanation) {
    lines.push('## 解析（**同样不要在提示里照抄**）', '', input.explanation, '');
  }

  if (input.given) {
    lines.push(
      '## 学生目前的作答',
      '',
      input.given,
      '',
      '如果他已经选了一个错的，提示可以针对"他为什么会这么想"来给 —— 但**别直接说这个选项不对**。',
      '',
    );
  }

  const prev = input.previousHints ?? [];
  if (prev.length > 0) {
    lines.push('## 已经给过的提示（**不要重复，要比这些更进一步**）', '');
    for (const h of prev) {
      lines.push(`- 第 ${h.level} 级：${h.text}`);
    }
    lines.push('');
  }

  lines.push(`现在给第 ${input.level} 级提示，输出 JSON。`);
  return { system, user: lines.join('\n') };
}

/** 解析模型输出 */
export function parseHint(raw: string, level: Exclude<HintLevel, 0>): HintResult {
  const body = extractJson(raw);
  if (!body) throw new Error('模型返回里找不到 JSON，提示没生成成功。');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('模型返回的 JSON 无法解析（可能被截断）。再点一次通常就好。');
  }

  const o = parsed as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  if (!text) throw new Error('模型这次没有给出提示内容。再点一次试试。');

  return { level, text };
}

/**
 * 这次作答算不算「真会」（核心规则）。
 *
 * ## 判定
 *
 * - 答错 → 不算（`false`）
 * - 答对但用过 3–4 级强提示 → **不算**（`true` 但 `assisted` 标出来）
 * - 答对且最多用过 1–2 级弱提示 → 算（弱提示只是"想起来了"，不是"被告诉的"）
 * - 答对且没用提示 → 算
 *
 * ## 为什么弱提示不算「作弊」
 *
 * 1–2 级只给方向与拆题，不透露任何本题事实 —— 学生仍然要自己把知识调出来。
 * 那和"自己想了想"没有本质区别。3 级开始才真正给了答案的一部分。
 *
 * ## 为什么不直接返回 boolean
 *
 * 界面要能说清「这题你答对了，但是看了提示」——
 * 只给一个 false 会让用户以为答错了。所以返回一个带原因的结构。
 */
export function judgeMasteryWithHints(input: {
  correct: boolean;
  maxHintLevel: HintLevel;
}): {
  /** 能否作为「真会」推进间隔 */
  countsAsMastery: boolean;
  /** 是否借助了强提示 */
  assisted: boolean;
  /** 给界面的一句话说明；不需要说明时为 null */
  note: string | null;
} {
  const { correct, maxHintLevel } = input;

  if (!correct) {
    return { countsAsMastery: false, assisted: maxHintLevel > 0, note: null };
  }

  if (maxHintLevel >= STRONG_HINT_FROM) {
    return {
      countsAsMastery: false,
      assisted: true,
      note: '这题答对了，但用了强提示 —— 先不算真会，下次还会再出现。',
    };
  }

  if (maxHintLevel > 0) {
    return {
      countsAsMastery: true,
      assisted: true,
      note: '用了弱提示后自己答对，算掌握。',
    };
  }

  return { countsAsMastery: true, assisted: false, note: null };
}

/** 与 `explain-wrong.ts` 同一套容错（围栏、前后说明文字） */
function extractJson(content: string): string | null {
  const t = content.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) return t.slice(start, end + 1);
  return null;
}