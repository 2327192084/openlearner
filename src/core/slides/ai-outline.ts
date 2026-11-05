import { newId } from '../id.ts';
import type {
  KnowledgePoint,
  SlideBullet,
  SlideCitation,
  SlideOutlinePage,
} from '../model.ts';
import { splitLongText } from './limits.ts';
import type { OutlinePageDraft } from './backend-types.ts';

/**
 * 把 AI 返回的大纲草稿变成真正可用的幻灯片。
 *
 * ## 这个文件存在的唯一理由：角标
 *
 * AI 只给了 `fromPointId`，没有给页码（它也不该给 —— 它看不到分页）。
 * 这里负责把 id 查回知识点，再从 `anchors[0]` 继承已经验证过的位置。
 *
 * 三件事必须做对，否则「点回原文」会静默失效：
 *
 *  1. **查不到 id 的要点直接丢掉**。模型偶尔会编一个 id，
 *     或者把 id 抄错一位。留着它 → 要点在页面上，角标为空，
 *     用户点不了却不知道为什么。
 *
 *  2. **未定位的知识点照常生成要点，但不给角标**。
 *     与既有约定一致（见 outline.ts 的注释）：宁可不给角标，
 *     也不给一个点不到位置的假角标。
 *
 *  3. **同一条知识点只占一个角标编号**。模型可能把一条知识点
 *     拆成三条要点，它们共用同一个号 —— 标三个号会让人以为引了三处原文。
 */

export interface AiOutlineInput {
  /** 模型返回的页草稿 */
  pages: OutlinePageDraft[];
  /** 本次参与生成的知识点 */
  points: KnowledgePoint[];
  /** 资料标题，用于资料页与回退 */
  sourceTitle: string;
  /** sourceId → 资料标题 */
  sourceTitles?: Map<string, string>;
  /** PPT 标题（封面用） */
  deckTitle: string;
}

export interface AiOutlineResult {
  pages: SlideOutlinePage[];
  citations: SlideCitation[];
  /** 有多少条要点因为 fromPointId 查不到而丢弃 */
  droppedBullets: number;
  /** 有多少条要点因为知识点未定位而没有角标 */
  bulletsWithoutCitation: number;
}

/**
 * 转换。
 *
 * 封面与资料来源页不在这里生成 —— 它们由 assemble 阶段统一加，
 * 和确定性大纲走同一条路，保证 AI 版和非 AI 版结构一致。
 */
export function applyAiOutline(input: AiOutlineInput): AiOutlineResult {
  const { pages: drafts, points } = input;
  const sourceTitles = input.sourceTitles ?? new Map<string, string>();

  const pointById = new Map(points.map((p) => [p.id, p]));

  const pages: SlideOutlinePage[] = [];
  const citations: SlideCitation[] = [];
  /** 知识点 id → 角标编号，保证同一条只占一个号 */
  const citationByPoint = new Map<string, number>();

  let droppedBullets = 0;
  let bulletsWithoutCitation = 0;

  /** 取某知识点的角标下标；没有可用位置返回 null（不给假角标） */
  const citationFor = (point: KnowledgePoint): number | null => {
    const existing = citationByPoint.get(point.id);
    if (existing !== undefined) return existing;

    if (point.anchorStatus !== 'located') return null;
    const anchor = point.anchors[0];
    if (!anchor) return null;

    const citation: SlideCitation = {
      index: citations.length + 1,
      knowledgePointId: point.id,
      sourceId: anchor.sourceId || point.sourceId || '',
      sourceTitle: sourceTitles.get(anchor.sourceId) ?? input.sourceTitle,
      page: anchor.page ?? null,
      chapter: anchor.chapter ?? point.chapter,
      quote: point.quotes[0] ?? '',
    };
    citations.push(citation);
    citationByPoint.set(point.id, citation.index);
    return citation.index;
  };

  for (const draft of drafts) {
    const bullets: SlideBullet[] = [];

    for (const b of draft.bullets) {
      const point = pointById.get(b.fromPointId);
      /**
       * 查不到知识点 → 丢弃这条要点。
       *
       * 这是唯一诚实的处理方式：模型给了一个我们不认识的 id，
       * 我们无法验证这句话有没有原文支撑。放上去就是一条
       * 「看起来有出处、实际点不回原文」的内容。
       */
      if (!point) {
        droppedBullets += 1;
        continue;
      }

      const citationIndex = citationFor(point);
      if (citationIndex === null) bulletsWithoutCitation += 1;

      // 长要点仍按标点拆开（不截断），拆出的多条共用同一角标
      for (const text of splitLongText(b.text)) {
        bullets.push({
          id: newId('sb'),
          text,
          citationIndex,
        });
      }
    }

    // 拆完之后可能一条都不剩（理论上不会，但防一手）
    if (bullets.length === 0) continue;

    pages.push({
      id: newId('sp'),
      layout: 'bullets',
      title: draft.title?.trim() || '本页要点',
      subtitle: draft.subtitle?.trim() || null,
      bullets,
      figure: null,
    });
  }

  return { pages, citations, droppedBullets, bulletsWithoutCitation };
}
