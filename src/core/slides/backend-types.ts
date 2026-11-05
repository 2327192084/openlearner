import type { KnowledgePoint } from '../model.ts';

/**
 * PPT 大纲后端的抽象层。
 *
 * ## 为什么要有这一层
 *
 * 计划书把「生成学习 PPT」定为 AI 功能，但落地时大纲是**纯确定性算法**：
 * 把知识点的 statement 原样搬进要点、超长按标点硬切、页标题取章节名
 * （没有章节就叫「未分章」、第二页叫「XX（续）」）。
 *
 * 那不是「用 AI 做 PPT」，只是「把知识点排版成幻灯片」。
 * 用户接好 API 之后，期望的是模型真的消化过这些内容。
 *
 * ## 角标怎么保住（这是整个设计的关键）
 *
 * 项目主线是「每条内容都能点回原文」，靠的是一条链：
 * 要点 → `citationIndex` → `SlideCitation` → 知识点 `anchors` → 页码。
 *
 * 如果让模型自由改写要点文字、又让它自己给引用，这条链就断了：
 * 模型写的句子不再逐字出自原文，角标却还指着那一页，
 * 用户点回原文找不到这句话 —— **看起来正确、实际错误**，比不做更糟。
 *
 * 所以沿用出题那条已经验证过的做法（见 questions/backend-types.ts）：
 *
 *   **模型只负责「说什么」，并指回它依据的知识点 id；
 *     位置由我们继承那条知识点已验证的 anchors。**
 *
 * 具体地：
 *   - 模型输出每条要点时带 `fromPointId`；
 *   - 我们用这个 id 查知识点，把 `anchors[0]` 变成角标；
 *   - 模型绝不输出页码 —— 它看不到分页，只会编。
 *
 * 这样要点文字可以是 AI 提炼过的（读起来像讲解），
 * 而角标仍精确指向那条知识点当初被定位到的真实页码。
 */

/** 送给模型的一条知识点 */
export interface OutlineInputPoint {
  id: string;
  /** 知识点表述（已由整理阶段定位到原文） */
  statement: string;
  /** 支撑它的原文引用，帮模型理解概念的准确表述 */
  quotes: string[];
  chapter: string | null;
  /** 页码，仅供模型理解先后顺序，**不作为输出依据** */
  page: number | null;
  cognitiveLevel: KnowledgePoint['cognitiveLevel'];
}

/** 生成大纲的参数 */
export interface GenerateOutlineOptions {
  /** 这份 PPT 的标题 */
  title: string;
  /** 资料标题 */
  sourceTitle: string;
  /** 期望的要点页数上限。模型可少给，不许多给 */
  maxPages: number;
  language: 'zh' | 'en';
  /**
   * 用户对这份 PPT 的额外要求（自由输入）。
   *
   * 有值时走**自由模式**：由模型决定页面结构。
   * 没值时走**固定模板**：结构由 template.ts 定死，模型只写内容。
   * 这个区别是刻意的 —— 用户没提要求时应该得到稳定可预期的版式，
   * 提了要求才让模型放开手脚。
   */
  instruction?: string;
}

/**
 * 一条知识点的成稿内容（固定模板模式下，模型为每条知识点写一段）。
 */
export interface TemplateItemDraft {
  fromPointId: string;
  /** 这组要点的标题；null 表示用章节名 */
  title: string | null;
  /** 要点正文 */
  bullet: string;
}

/** 固定模板模式的结果 */
export interface GenerateTemplateResult {
  items: TemplateItemDraft[];
  /** 总结页；模型没给则为 null */
  summary: { title: string; bullets: string[] } | null;
  actualTokens: number | null;
}

/** 模型返回的一条要点草稿 */
export interface OutlineBulletDraft {
  /** 要点文字（AI 提炼过的，但仍须忠于所引知识点） */
  text: string;
  /**
   * 依据的知识点 id。
   *
   * 模型唯一需要指回的字段。位置由调用方继承，模型不输出页码。
   */
  fromPointId: string;
}

/** 模型返回的一页草稿 */
export interface OutlinePageDraft {
  /** 页标题（AI 起的小标题，代替「未分章」「XX（续）」）。章节过渡页可为 null */
  title: string | null;
  subtitle: string | null;
  bullets: OutlineBulletDraft[];
}

/** 生成结果 */
export interface GenerateOutlineResult {
  pages: OutlinePageDraft[];
  /** 实际用量（token）。服务端没返回时为 null，**不猜** */
  actualTokens: number | null;
}

/** 大纲后端接口 */
export interface OutlineBackend {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;
  /** 服务商标识，用于用量统计 */
  readonly provider?: string;

  /** 估算用量，生成前显示给用户看 */
  estimateTokens(points: OutlineInputPoint[], options: GenerateOutlineOptions): number;

  /** 生成大纲（自由模式：模型自己组织结构） */
  generate(
    points: OutlineInputPoint[],
    options: GenerateOutlineOptions & { signal: AbortSignal },
  ): Promise<GenerateOutlineResult>;

  /**
   * 按知识点逐条写内容（固定模板模式）。
   *
   * 与 generate 的区别：这里模型**不决定结构**，只负责
   * 「每条知识点写成什么话」和「整份 PPT 的总结是什么」。
   * 页面结构由 template.ts 定死，所以版式可预期。
   *
   * 可选：不实现时调用方退回 generate。
   */
  generateForTemplate?(
    points: OutlineInputPoint[],
    options: GenerateOutlineOptions & { signal: AbortSignal },
  ): Promise<GenerateTemplateResult>;
}
