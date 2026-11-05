import type { SourceChunk } from './source-chunk.ts';

/**
 * PPT 大纲后端的抽象层。
 *
 * ## 输入端：资料原文，不是知识点
 *
 * 早先 PPT 从**已经整理好的知识点**出发，等于对知识点做二次加工。
 * 现在改成直接吃资料原文（可按页码范围取材），与知识点那一栏
 * 用同一套取材方式。
 *
 * ## 角标怎么保住（这是整个设计的关键）
 *
 * 项目主线是「每条内容都能点回原文」，靠的是：
 *   要点 → `citationIndex` → `SlideCitation` → `segmentId` → 段落页码
 *
 * 如果让模型自由改写要点文字、又让它自己给引用，这条链就断了：
 * 模型写的句子不再逐字出自原文，角标却还指着那一页，用户点回原文
 * 找不到这句话 —— **看起来正确、实际错误**，比不做更糟。
 *
 * 所以沿用出题那条已经验证过的做法：
 *
 *   **模型只负责「说什么」，并指回它依据的段落 id；
 *     页码由我们从那一页的段落继承。**
 *
 * 比原来从知识点继承更可靠：不再要求知识点定位成功，
 * 只要段落有页码（几乎总有），角标就一定成立。
 */

/**
 * 送给模型的一段资料。
 *
 * 就是 `SourceChunk`，这里再导出一次是让后端实现不必跨文件找类型。
 */
export type OutlineInputChunk = SourceChunk;

/**
 * 送给模型的一段资料（带段内序号，便于模型引用）。
 */
export interface OutlineInputPoint {
  /** 段 id。模型输出的 fromPointId 必须是其中之一 */
  id: string;
  /** 这一段所在的页码，仅供模型理解先后顺序，**不作为输出依据** */
  page: number | null;
  chapter: string | null;
  /** 正文 */
  text: string;
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
  /** 要点文字（AI 提炼过的，但仍须忠于所引段落） */
  text: string;
  /**
   * 依据的段落 id。
   *
   * 模型唯一需要指回的字段。页码由调用方继承，模型不输出页码。
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
