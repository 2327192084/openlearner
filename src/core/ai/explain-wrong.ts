/**
 * 「针对这次答错，专门讲一遍」的纯逻辑（2026-11-19）。
 *
 * ## 它解决什么
 *
 * 做题答错时，现在只有两样东西：
 *  1. 整题 `explanation`（**出题时就写死的**，讲的是「正确答案为什么对」）
 *  2. 逐选项 `option.why`（2026-11-19 刚打通，讲「这个选项为什么错」）
 *
 * 但用户真正卡住的地方往往更具体：「我选 B 是因为我以为条件是对称的 ——
 * 到底哪里想错了？」这是**针对他这次错误**的解释，出题时不可能预写。
 *
 * LogiNote v1.1.3 做的就是这件事（作者视频 04:07）：
 * 「针对你答错的部分补充讲解……你没掌握的部分再讲解一遍」，
 * 而且能调策略（04:27「通过讲故事的方式讲解例题」）。
 *
 * ## 为什么把「用户选了什么」喂给模型
 *
 * 不喂的话，模型只能泛泛重讲一遍整题的解析 —— 那用户已经看过了，
 * 再讲一遍是浪费时间。喂了才知道「他是从哪个岔路走错的」。
 *
 * ## 这个模块只做纯逻辑
 *
 * 提示词构造 + 响应解析，不碰网络与存储（与 `grade-short.ts` 同一套约定）。
 */

import type { Question } from '../model.ts';

/** 讲解的可选策略（用户可点） */
export interface ExplainStyle {
  id: string;
  label: string;
  /** 给模型看的一句话要求 */
  instruction: string;
}

/**
 * 内置策略。
 *
 * 为什么给固定几个而不是一个自由输入框：用户答错时正烦着，
 * 让他现想「我要怎么讲」是额外的认知负担。点一下就换一种讲法最省事。
 * 想要更细的要求可以走自定义输入（`customStyle`）。
 */
export const EXPLAIN_STYLES: readonly ExplainStyle[] = [
  {
    id: 'direct',
    label: '直接讲',
    instruction: '直接讲清我错在哪、正确的理解是什么。不要铺垫。',
  },
  {
    id: 'example',
    label: '举例子',
    instruction: '用一个具体的小例子说明我错在哪、正确做法是什么。例子要简单、能自己验算。',
  },
  {
    id: 'story',
    label: '讲故事',
    instruction: '用一个贴近生活的小故事或类比来讲，把抽象概念落到具体场景上。',
  },
  {
    id: 'stepwise',
    label: '分步骤',
    instruction: '把我的错误拆成几个步骤，指出具体是哪一步开始偏的，然后给出正确的步骤。',
  },
  {
    id: 'compare',
    label: '对比着讲',
    instruction: '把我的错误思路和正确思路并排对比，讲清两者在哪一个判断上分岔。',
  },
];

/** 讲解请求的输入 */
export interface ExplainInput {
  /** 题干 */
  prompt: string;
  /** 题型（决定"选错了"怎么描述） */
  kind: Question['kind'];
  /** 选项（选择题才有；用于回查用户选的那个的文本与 why） */
  options: readonly { key: string; text: string; why?: string }[];
  /** 正确答案（key 或文本） */
  answer: string;
  /** 整题解析（出题时写死的那个） */
  explanation: string;
  /** 用户这次选/写了什么；未答时为空串 */
  given: string;
  /** 讲解策略；不传用 direct */
  styleId?: string;
  /** 用户自定义要求（优先于 styleId 的那句 instruction） */
  customStyle?: string;
}

/** 解析出来的讲解 */
export interface ExplainResult {
  /** 讲解正文（多段 markdown-ish 文本，界面按换行渲染） */
  body: string;
  /** 一句话点出「你错在哪」（用于标题位显示） */
  crux: string;
  /** 模型建议的下一步（可选） */
  nextStep: string | null;
}

/** 把答案键归一（多选用逗号分隔） */
export function answerKeysOf(answer: string): string[] {
  return answer
    .split(/[,，\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * 用户选错的那些选项（只对选择题有意义）。
 *
 * 多选题里用户可能选了 2 个、对 1 个错 1 个 —— 错的那个才是要讲的。
 */
export function wrongPicksOf(
  options: readonly { key: string }[],
  answer: string,
  given: string,
): string[] {
  const correct = new Set(answerKeysOf(answer));
  const valid = new Set(options.map((o) => o.key.toUpperCase()));
  return answerKeysOf(given).filter((k) => valid.has(k) && !correct.has(k));
}

/**
 * 构造提示词。
 *
 * ## 关键：把「你选了 B，B 的问题是 X」明确写进去
 *
 * 只说「他答错了」的话，模型会倾向于重讲整题 —— 而用户已经读过解析了。
 * 明确指出分岔点，讲解才会落在真正需要的地方。
 */
export function buildExplainPrompt(input: ExplainInput): { system: string; user: string } {
  const style =
    EXPLAIN_STYLES.find((s) => s.id === input.styleId)?.instruction ??
    EXPLAIN_STYLES[0].instruction;

  const system = [
    '你是学习助手，任务是**针对学生这一次的具体错误**讲清楚，而不是把整题重新讲一遍。',
    '',
    '## 最重要的原则',
    '',
    '1. **只讲他真正卡住的那一点。** 他已经看过整题解析了，重复讲一遍是浪费他的时间。',
    '2. **指出他从哪一步开始想错的。** 不要只说「错了，应该选 A」，要说出错在哪个判断上。',
    '3. **不要引入题目与原文之外的事实。** 你讲解所依据的知识必须在题干、选项、解析里有依据；',
    '   确实需要补充背景时，明确说「补充一点」并让它尽量短。',
    '4. 讲解要**能自己验证**：给数字就给能算的、给例子就给能代进去的。',
    '',
    '## 讲解方式',
    '',
    style,
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 对象，不要 markdown 围栏、不要前后解释：',
    '{',
    '  "crux": "一句话点出他错在哪（不超过 40 字）",',
    '  "body": "讲解正文，可以分多段，用 \\\\n\\\\n 分隔",',
    '  "nextStep": "建议他接下来做什么（一句话，可选，没有就空字符串）"',
    '}',
  ].join('\n');

  const lines: string[] = [];
  lines.push('## 题干', '', input.prompt, '');

  /* 选择题：把用户选的那个、以及它为什么错，明确摆出来 */
  if (input.options.length > 0) {
    const wrong = wrongPicksOf(input.options, input.answer, input.given);
    const correctKeys = new Set(answerKeysOf(input.answer));

    lines.push('## 选项', '');
    for (const o of input.options) {
      const isCorrect = correctKeys.has(o.key.toUpperCase());
      const isPicked = answerKeysOf(input.given).includes(o.key.toUpperCase());
      const tag = [isCorrect ? '【正确答案】' : '', isPicked ? '【学生选了这个】' : '']
        .filter(Boolean)
        .join('');
      lines.push(`- ${o.key}. ${o.text}${tag ? ' ' + tag : ''}`);
      if (o.why) lines.push(`  这个选项的说明：${o.why}`);
    }
    lines.push('');

    if (wrong.length > 0) {
      lines.push(
        '## 学生错在哪',
        '',
        `他选了 ${wrong.join('、')}，这是错的。`,
        `正确答案是 ${input.answer}。`,
        '请重点讲清：他为什么会选这个 —— 这个选项对应的是哪一种误解，',
        '以及正确的判断应该怎么做。',
        '',
      );
    } else if (input.given) {
      /* 选了但选对了、或选了多个里全对：不当作错误讲解 */
      lines.push(
        '## 说明',
        '',
        `学生选了 ${input.given}，与正确答案一致。`,
        '如果他是想要更深入的理解，请围绕这道题的关键概念讲，而不是纠正错误。',
        '',
      );
    } else {
      lines.push('## 说明', '', '学生没有作答。请讲清这道题的关键点与常见误解。', '');
    }
  } else {
    /* 填空 / 问答 / 计算：没有选项，讲他的作答与参考答案的差距 */
    lines.push('## 参考答案', '', input.answer || '（未给出）', '');
    if (input.given) {
      lines.push(
        '## 学生的作答',
        '',
        input.given,
        '',
        '请对照参考答案，指出他的作答里**哪个要点缺了或错了**，而不是笼统说「不完整」。',
        '',
      );
    } else {
      lines.push('## 说明', '', '学生没有作答。请讲清这道题的解法关键与常见误解。', '');
    }
  }

  if (input.explanation) {
    lines.push('## 原题解析（学生已经看过，不要照抄）', '', input.explanation, '');
  }

  if (input.customStyle && input.customStyle.trim()) {
    lines.push('## 学生的额外要求', '', input.customStyle.trim(), '');
  }

  lines.push('现在输出 JSON。');
  return { system, user: lines.join('\n') };
}

/** 解析模型输出 */
export function parseExplain(raw: string): ExplainResult {
  const body = extractJson(raw);
  if (!body) throw new Error('模型返回里找不到 JSON，讲解没生成成功。');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('模型返回的 JSON 无法解析（可能被截断）。再点一次通常就好。');
  }

  const o = parsed as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const content = text(o.body);
  if (!content) throw new Error('模型这次没有给出讲解内容。再点一次，或换个讲解方式。');

  const next = text(o.nextStep);
  return {
    crux: text(o.crux),
    body: content,
    nextStep: next || null,
  };
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 与出题后端的 `extractJson` 同一套容错（围栏、前后说明文字），
 * 但这里是独立的纯函数，不依赖那个模块。
 */
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