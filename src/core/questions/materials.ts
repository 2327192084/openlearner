import type { KnowledgePoint, SourceSegment } from '../model.ts';
import type { QuestionSourcePoint } from '../questions/backend-types.ts';

/**
 * 出题素材：把两种来源统一成同一种「可出题的东西」。
 *
 * ## 两种来源（2026-11-07 用户要求）
 *
 * 用户原话：
 *  > 出题功能可以再改进一下，多加一个从知识库出题的功能。
 *  > 可以是整个知识库随机抽出知识点出题，也可以是指定一个文件的知识点出题。
 *  > 然后原先的从资料出题功能，应该让 ai 从 pdf 解析后的资料原文里出题，
 *  > 不再从原先资料的知识点出题。
 *
 * 所以：
 *  - **知识库出题**：素材是「知识点」（已有链路，走 KnowledgePoint）
 *  - **从资料原文出题**：素材是「正文段落」（新链路，走 SourceSegment）
 *
 * ## 为什么必须统一
 *
 * 出题后端只认 `QuestionSourcePoint`（id + statement + quotes + 层级 + 章节 + 页）。
 * 两条来源各自映射到它，后端与提示词一行都不用改。
 *
 * ## 为什么出处仍然可信
 *
 * 出题的 anchors 一律由**素材自己带**，模型说的位置一概不采信：
 *  - 知识点：用它的 `anchors`（整理时就实测定位过）
 *  - 原文段落：用它自己的 `page` + 整段范围（段落是解析器切出来的，页码必然准）
 *
 * 这就是「点回原文」不会骗人的原因 —— 位置从来不是模型给的。
 */

/** 一条可出题素材（两种来源归一后的形状） */
export interface QuestionMaterial {
  /** 稳定 id，会作为 knowledgePointId 传给模型并在落库时回查 */
  id: string;
  /** 给模型看的「这条讲什么」 */
  statement: string;
  /** 原文引用，模型据此理解确切表述 */
  quotes: string[];
  cognitiveLevel: KnowledgePoint['cognitiveLevel'];
  chapter: string | null;
  page: number | null;
  /** 出处锚点。题目落库时直接从它复制，不看模型输出 */
  anchors: NonNullable<KnowledgePoint['anchors']>;
}

/**
 * 知识点 → 素材。
 *
 * 只用**已定位**的知识点：没定位的出不了「点回原文」的题。
 */
export function pointsToMaterials(points: readonly KnowledgePoint[]): QuestionMaterial[] {
  return points
    .filter((p) => p.anchorStatus === 'located' && p.anchors.length > 0)
    .map((p) => ({
      id: p.id,
      statement: p.statement,
      quotes: p.quotes,
      cognitiveLevel: p.cognitiveLevel,
      chapter: p.chapter,
      page: p.anchors[0]?.page ?? null,
      anchors: p.anchors.map((a) => ({ ...a })),
    }));
}

/**
 * 从资料正文段落造素材 —— 「从原文出题」的核心。
 *
 * ## 与「从知识点出题」的区别
 *
 * 知识点是**已经浓缩过**的一句话，模型只能围着那一句出题，
 * 所以出的题永远跳不出既有知识点的范围。
 * 直接从原文段落出题，模型能看到完整论述，题目更贴近原文语境。
 *
 * ## 一段 = 一条素材
 *
 * 为什么不做更细的切分：段落是解析器按页/按章切出来的，
 * 页码与字符偏移天然准确。再往下切就要自己算偏移，
 * 算错一个字符，「点回原文」就圈错句子 —— 而这个错在界面上看不出来。
 *
 * ## statement 用什么
 *
 * 用段落开头的一小截作「这条讲什么」的提示（模型需要个抓手），
 * 同时把**整段**放进 quotes，让模型有完整上下文。
 * 不截断 quotes：出题质量比省那点 token 重要。
 */
export function segmentsToMaterials(
  segments: readonly SourceSegment[],
  options: { maxChars?: number } = {},
): QuestionMaterial[] {
  const maxChars = options.maxChars ?? 1200;

  return segments
    // 太短的段落（页眉、孤行）出不了题；纯空白也跳过
    .filter((s) => s.text.trim().length >= 30)
    .map((s) => {
      const text = s.text.trim();
      const head = text.slice(0, 60).replace(/\s+/g, ' ');
      return {
        // 用段落 id 作素材 id —— 落库时能回查到这一段的页码
        id: s.id,
        statement: head.length < text.length ? `${head}…` : head,
        quotes: [text.slice(0, maxChars)],
        /*
         * 认知层级给 understand。
         *
         * 原文段落没有「难度」概念，而层级只影响出题时的措辞倾向。
         * 统一给 understand 比随机猜一个更诚实 —— 猜出来的 analyze
         * 会让模型硬出分析题，反而脱离原文难度。
         */
        cognitiveLevel: 'understand' as const,
        chapter: s.chapter,
        page: s.page,
        /*
         * 整段作为锚点范围。
         *
         * charStart=0 / charEnd=段落长度，指的是「这一页（这一段）的全文」。
         * 阅读器定位时会把整段高亮 —— 对「从原文出的题」来说，
         * 让用户看到完整上下文比圈住某个短语更有用。
         */
        anchors: [
          {
            sourceId: s.sourceId,
            page: s.page,
            charStart: 0,
            charEnd: text.length,
            ...(s.chapter ? { chapter: s.chapter } : {}),
          },
        ],
      };
    });
}

/** 素材 → 出题后端认识的形状 */
export function toSourcePoint(m: QuestionMaterial): QuestionSourcePoint {
  return {
    id: m.id,
    statement: m.statement,
    quotes: m.quotes,
    cognitiveLevel: m.cognitiveLevel,
    chapter: m.chapter,
    page: m.page,
  };
}

/**
 * 随机抽若干条素材 —— 「整个知识库随机抽出知识点出题」用。
 *
 * 为什么用 Fisher–Yates 而不是 `sort(() => Math.random() - 0.5)`：
 * 后者是常见的错误写法，分布并不均匀（引擎的排序实现会影响结果），
 * 会让某些知识点被抽中的概率明显偏高。
 */
export function pickRandom<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length) return [...items];
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, Math.max(0, count));
}