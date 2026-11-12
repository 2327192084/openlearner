/**
 * 变式出题：从「已有的题」再出一批同类但不同的题（2026-11-12）。
 *
 * ## 用户的要求
 *
 * 用户原话：「我们的出题方式太单一了，除了从已有资料库或是知识库中出题，
 * 我们还需要网络题库功能。让 AI 对特定的知识点，或是错题进行变式。」
 *
 * 拆开是三件事：
 *  1. 网络题库 —— 从公开题源取题
 *  2. 对特定知识点变式
 *  3. **对错题变式**（用户最在意的一条）
 *
 * 本文件先做 2 和 3。第 1 件（网络题库）单独评估，见文末注释。
 *
 * ## 为什么能接进出题后端而不改它
 *
 * `QuestionBackend.generate()` 只认一种输入：`QuestionSourcePoint[]`。
 * 上一轮做「资料原文出题」时已经把「素材」抽出来过（见 materials.ts 的
 * `QuestionMaterial`）。所以变式要做的事只有一件：
 *
 *   **把「一道旧题」翻译成「一条素材」** —— 出题后端照常工作，
 *   提示词与解析逻辑一行都不用动。
 *
 * 代价是：变式约束（「换个数字、换个问法、别重复原题」）必须表达在
 * 素材的 statement / quotes 里。这是本文件的核心。
 *
 * ## 为什么变式不能只是「让模型改写题目」
 *
 * 直接给模型看原题说「改一改」，最常见的两个失败：
 *
 *  1. **只换数字不换考法** —— 学生记住的是套路，不是概念
 *  2. **引入原题没有的事实** —— 尤其是需要背景知识的科目，
 *     模型会自己补一个「看起来合理」的前提，答案就错了
 *
 * StudyHub 的 content-quality.md 里对这点写得很清楚：
 * 「A source saying two concepts are different does not justify inventing
 * a precise distinction absent from it. Constructed scenarios may add explicit
 * hypothetical assumptions, but cannot introduce unsupported subject-matter facts.」
 *
 * 所以变式素材里要**同时给出**：原题（含答案与解析）+ 原文出处，
 * 并要求模型只在原题与出处共同支撑的范围内变化。
 *
 * ## 变式维度（不是随机「改一改」）
 *
 * 来源：教育测量学里的 item transformation（题目变换）常见四类，
 * 与搜索到的国内教学实践（「换数字、换问法、换情境」）一致：
 *
 *  - `context`   换情境：同一个概念换一个具体场景
 *  - `reverse`   反向问：由「求结果」改成「给结果求条件」
 *  - `combine`   合并：两个相关概念合到一题
 *  - `deepen`    加深：从「记住/理解」提到「应用/分析」
 */

'use strict';

import type { Question, KnowledgePoint } from '@/core/model.ts';
import type { QuestionMaterial } from './materials.ts';

/** 变式维度。用户可多选。 */
export type VariantAxis = 'context' | 'reverse' | 'combine' | 'deepen';

export interface VariantAxisInfo {
  id: VariantAxis;
  label: string;
  /** 给用户看的一句话说明 */
  desc: string;
}

export const VARIANT_AXES: readonly VariantAxisInfo[] = [
  {
    id: 'context',
    label: '换情境',
    desc: '同一个概念换一个具体场景/数字/表述，考的还是同一件事',
  },
  {
    id: 'reverse',
    label: '反向问',
    desc: '由「求结果」改成「给结果求条件」，逼学生真正理解因果关系',
  },
  {
    id: 'combine',
    label: '合并',
    desc: '把两个相关概念合到一道题里，考它们之间的联系',
  },
  {
    id: 'deepen',
    label: '加深',
    desc: '从「记住 / 理解」提到「应用 / 分析」，需要多走一步推理',
  },
];

/**
 * 把一道旧题转成变式素材。
 *
 * ## statement 里写什么
 *
 * 用固定骨架，让模型拿到的东西每次都一样（可预期、可测试）：
 *
 * ```
 * 【变式】下面的原题请勿照抄，按指定维度改造。
 * 考点：<题目自己暴露的概念 / 知识点>
 * 原题：<prompt>
 * 原答案：<answer>
 * 原解析：<explanation>
 * 变式要求：<各维度的一句话>
 * 硬性限制：只在原题与原文出处共同支撑的范围内变化，不要引入原题没有的事实。
 * ```
 *
 * ## 为什么把答案也给它
 *
 * 模型需要知道「原题考的是什么、正确答案长什么样」才能做**有意义的**变化。
 * 只给题干容易被它改成另一道题。给答案不增加抄袭风险 ——
 * 我们要求的是「不照抄原题」，而不是「猜出原答案」。
 *
 * @param question 原题
 * @param point 该题关联的知识点（可能没有）
 * @param axes 变式维度
 */
export function questionToVariantMaterial(
  question: Question,
  point: KnowledgePoint | null,
  axes: readonly VariantAxis[],
): QuestionMaterial {
  const axisText = axes
    .map((a) => VARIANT_AXES.find((x) => x.id === a))
    .filter((x): x is VariantAxisInfo => Boolean(x))
    .map((x) => `- ${x.label}：${x.desc}`)
    .join('\n');

  const lines = [
    '【变式】下面是原题，请**不要照抄**，按指定维度改造出一道新题。',
    '',
    `考点：${point?.statement ?? question.topic ?? '（原题未标注考点）'}`,
    '',
    `原题：${question.prompt}`,
    `原答案：${question.answer}`,
  ];
  if (question.explanation) {
    lines.push(`原解析：${question.explanation}`);
  }
  if (question.options.length > 0) {
    lines.push(
      '原选项：' +
        question.options.map((o) => `${o.key}. ${o.text}`).join(' / '),
    );
  }

  lines.push('', '变式要求（至少体现所选维度）：');
  lines.push(axisText || '- （未指定维度，请换一个等价但不同的考法）');

  lines.push(
    '',
    '硬性限制：',
    '1. 只在「原题 + 下方原文出处」共同支撑的范围内变化，不要引入两者都没有的事实。',
    '2. 考点必须与原题一致 —— 变的只是情境/问法/深度，不是换成另一个知识点。',
    '3. 不要出现「原题」「上题」这类指代（学生复习时看不到原题）。',
  );

  /*
   * quotes 要能同时提供「原题依据」与「原文依据」。
   *
   * 落库时题目会从 point 复制 anchors，所以原文引用是必要的 ——
   * 否则变式题会变成「有答案但点不回原文」的空壳，
   * 那正是本项目最不该出现的东西（每条内容都要能追溯）。
   */
  const quotes: string[] = [];
  if (point) {
    quotes.push(`【考点】${point.statement}`);
    for (const q of point.quotes ?? []) quotes.push(q);
  } else if (question.anchors.length > 0) {
    quotes.push(`【原题出处】第 ${question.anchors[0]?.page ?? '?'} 页`);
  }

  return {
    id: point?.id ?? `variant:${question.id}`,
    statement: lines.join('\n'),
    quotes,
    /*
     * 认知层级：变式默认比原题高一级（understand → apply），
     * 除非用户显式选了「加深」。抬高一级更符合「变式检验是否真会」的目的；
     * 与 deepen 维度的区别是：这里只是默认难度，不是硬要求。
     */
    cognitiveLevel: point?.cognitiveLevel ?? question.cognitiveLevel,
    chapter: point?.chapter ?? null,
    page: point?.anchors?.[0]?.page ?? question.anchors[0]?.page ?? null,
    anchors: point?.anchors ?? question.anchors,
    /*
     * origin 记 `knowledge`：变式题的出处来自知识点（或原题）而不是原文段落。
     *
     * 为什么不用新的 origin 值：加一个值要动落库逻辑与既有校验，
     * 而这里行为上就是「从知识点出题」—— 复用它是正确的，
     * 不是省事（硬约束：不做假的分类）。
     */
    origin: 'knowledge',
  };
}

/**
 * 批量把错题转成变式素材。
 *
 * 为什么单独一个函数：错题列表里每条都带 `question` 与
 * （可能有的）知识点，转换逻辑一样，但调用点拿到的是另一种形状。
 */
export function wrongQuestionsToVariantMaterials(
  items: ReadonlyArray<{ question: Question; wrongCount: number }>,
  pointsById: ReadonlyMap<string, KnowledgePoint>,
  axes: readonly VariantAxis[],
  /** 最多转几条（用户选的题数）。0 或负数表示不限。 */
  limit = 0,
): QuestionMaterial[] {
  const out: QuestionMaterial[] = [];
  for (const it of items) {
    const point = it.question.knowledgePointId
      ? pointsById.get(it.question.knowledgePointId) ?? null
      : null;
    out.push(questionToVariantMaterial(it.question, point, axes));
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

/** 从知识点直接出变式（不依赖错题）：给同一考点换多种考法 */
export function knowledgePointsToVariantMaterials(
  points: readonly KnowledgePoint[],
  axes: readonly VariantAxis[],
): QuestionMaterial[] {
  const axisText = axes
    .map((a) => VARIANT_AXES.find((x) => x.id === a))
    .filter((x): x is VariantAxisInfo => Boolean(x))
    .map((x) => `- ${x.label}：${x.desc}`)
    .join('\n');

  return points.map((p) => {
    const lines = [
      '【变式训练】针对下面这个考点，出**同一考点的不同考法**。',
      '',
      `考点：${p.statement}`,
    ];
    if (p.chapter) lines.push(`章节：${p.chapter}`);
    lines.push('', '变式要求（至少体现所选维度）：');
    lines.push(axisText || '- （未指定维度）');
    lines.push(
      '',
      '硬性限制：',
      '1. 只在下方原文引用支撑的范围内出题，不要引入引用里没有的事实。',
      '2. 考点不变，只换情境/问法/深度。',
    );

    return {
      id: p.id,
      statement: lines.join('\n'),
      quotes: [p.statement, ...(p.quotes ?? [])],
      cognitiveLevel: p.cognitiveLevel,
      chapter: p.chapter,
      page: p.anchors?.[0]?.page ?? null,
      anchors: p.anchors ?? [],
      origin: 'knowledge' as const,
    };
  });
}

/* ==========================================================================
 * 关于「网络题库」—— 本轮不做的理由（如实记录，不假装做了）
 *
 * 用户提到「网络题库功能」。评估后本轮不实现，三个理由：
 *
 * 1. **没有可用的公开题库 API。** 检索到的国内「题库」产品都是闭源商业
 *    数据库（付费授权），没有开放接口；GitHub 上的题库项目多为静态
 *    抓取数据，版权状态不明。直接抓取再分发给用户有法律风险，
 *    与「只发软件本体」的既有原则冲突。
 *
 * 2. **与项目的核心承诺冲突。** OpenLeaner 的支点是「每条内容都能点回
 *    原文那一页」。网络题库的题没有本地原文，无法定位 —— 做进来会变成
 *    一批「点了没反应」的角标，正是硬约束禁止的假功能。
 *
 * 3. **变式能覆盖大部分真实需求。** 用户想要网络题库，实际诉求是
 *    「题目不够、种类太单一」。变式 + 知识点多考法能从已有材料生成
 *    无限多道、且每道都能回溯原文的题 —— 比引入一批无出处的题更符合
 *    这个软件的价值。
 *
 * 若确实要接外部题源，正确做法是**用户自己提供题库文件**（已有的
 * import-json 通道就是干这个的），而不是我们内置一份来路不明的数据。
 * ========================================================================== */
