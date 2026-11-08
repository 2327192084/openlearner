import type { KnowledgePoint, QuestionKind } from '../model.ts';

/**
 * 出题后端的抽象。
 *
 * 与整理知识点共用同一套思路（P2 的 `OrganizeBackend`）：
 * 上层不关心背后是 DeepSeek 还是假数据，只认这个接口。
 *
 * ## 与整理知识点最大的不同
 *
 * 出题时我们**把知识点连同它的原文位置一起给模型**，并要求它为每道题
 * 指定「依据哪条知识点」。
 * 题目最终的 `anchors` 由调用方**从知识点继承**，而不是采信模型给的引用。
 *
 * 原因：模型对同一段话两次引用可能不一致（整理时引一次、出题时再引一次），
 * 会出现「知识点说第 3 页、题目说第 5 页」的矛盾。
 * 继承已经验证过的位置，题目的「点回原文」必然准确。
 */

/** 出题请求里的一条知识点（含必要上下文） */
export interface QuestionSourcePoint {
  id: string;
  statement: string;
  /** 原文引用（来自知识点），供模型理解概念的确切表述 */
  quotes: string[];
  cognitiveLevel: KnowledgePoint['cognitiveLevel'];
  chapter: string | null;
  /** 所在页码，仅用于让模型知道前后文顺序，不作为输出依据 */
  page: number | null;
}

/**
 * 出题参数（不含取消信号）。
 *
 * `signal` 刻意**不放在这里**：估算用量不需要取消能力，
 * 而把它塞进来会逼着调用方在估算时也造一个 AbortSignal。
 * 真正需要取消的是 `generate()`，它单独收 signal。
 */
export interface GenerateQuestionsOptions {
  /** 题型组合 */
  kinds: QuestionKind[];
  /** 期望题数 */
  count: number;
  /**
   * 每种题型各出几道。
   *
   * ## 为什么需要它（2026-11-08）
   *
   * 原来只有 `kinds` + `count`，真实后端靠提示词说「每种至少 1 道、尽量平均分配」，
   * 但**模型不遵守时没有任何补救**：勾了判断+问答，结果全出单选，
   * 用户只能重新生成碰运气。mock 后端则是 `kinds[i % kinds.length]` 硬轮转，
   * 6 道 3 种就是 2/2/2 —— 用户无法要「5 道单选 + 1 道问答」。
   *
   * 现在界面可以逐种填数字。有它时：
   *  - `count` 由它求和得出（两者不一致时以它为准）
   *  - 提示词里逐种列出数量（比「尽量平均」明确得多）
   *  - mock 后端按这个配额出题，不再轮转
   *
   * 为 undefined 时退回旧行为（按 kinds 轮转 / 平均分配），
   * 保证旧调用方与旧测试不受影响。
   */
  kindCounts?: Partial<Record<QuestionKind, number>>;
  /** 难度：由认知层级映射，null 表示不限 */
  levels: KnowledgePoint['cognitiveLevel'][] | null;
  /** 出题语言 */
  language: 'zh' | 'en';
}

/**
 * 按 `kindCounts` 展开成「第 i 道该出什么题型」的序列。
 *
 * 为什么单独一个函数：mock 后端要逐道取题型，真实后端的提示词要逐种列数量，
 * 两处都得从同一个配额推导 —— 各自实现一遍迟早对不上。
 *
 * 行为：
 *  - 有 `kindCounts` 且总和 > 0 → 按配额逐段展开（同一题型连续出现，便于阅读）
 *  - 否则 → 退旧行为 `kinds[i % kinds.length]`
 */
export function planKinds(
  kinds: readonly QuestionKind[],
  count: number,
  kindCounts?: Partial<Record<QuestionKind, number>>,
): QuestionKind[] {
  if (kinds.length === 0 || count <= 0) return [];

  const quota = kinds
    .map((k) => ({ kind: k, n: Math.max(0, Math.floor(kindCounts?.[k] ?? 0)) }))
    .filter((x) => x.n > 0);

  const quotaTotal = quota.reduce((n, x) => n + x.n, 0);
  if (quotaTotal > 0) {
    const out: QuestionKind[] = [];
    for (const { kind, n } of quota) {
      for (let i = 0; i < n; i++) out.push(kind);
    }
    return out.slice(0, count);
  }

  // 旧行为：轮流
  return Array.from({ length: count }, (_, i) => kinds[i % kinds.length]!);
}

/** 生成时额外需要的取消信号 */
export interface GenerateQuestionsRuntime {
  signal: AbortSignal;
}

/** 模型返回的一道题草稿 */
export interface QuestionDraft {
  kind: QuestionKind;
  prompt: string;
  /** 选项（单选/多选必填） */
  options: { key: string; text: string }[];
  /** 答案 */
  answer: string;
  explanation: string;
  /**
   * 依据的知识点 id。
   *
   * **这是模型唯一需要指回的字段** —— 位置由我们继承，
   * 它不需要（也不应该）输出页码或原文引用。
   */
  knowledgePointId: string;
}

export interface GenerateQuestionsResult {
  drafts: QuestionDraft[];
  actualTokens: number | null;
  stopped: boolean;
}

/** 出题后端接口 */
export interface QuestionBackend {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;
  /** 服务商标识，用于用量统计。可选，见 OrganizeBackend.provider 的说明 */
  readonly provider?: string;

  /** 估算用量，生成前显示 */
  estimateTokens(points: QuestionSourcePoint[], options: GenerateQuestionsOptions): number;

  /** 执行出题 */
  generate(
    points: QuestionSourcePoint[],
    options: GenerateQuestionsOptions &
      GenerateQuestionsRuntime & {
        /** 逐题产出回调。实现者必须 await 它 */
        onDraft?: (draft: QuestionDraft) => void | Promise<void>;
      },
  ): Promise<GenerateQuestionsResult>;
}
