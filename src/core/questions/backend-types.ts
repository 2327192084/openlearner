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
  /** 难度：由认知层级映射，null 表示不限 */
  levels: KnowledgePoint['cognitiveLevel'][] | null;
  /** 出题语言 */
  language: 'zh' | 'en';
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
