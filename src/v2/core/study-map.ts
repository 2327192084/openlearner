/**
 * 学习地图：把题库按「资料 → 章节」摊开，每格给出掌握度、到期数、错题数。
 *
 * ## 为什么要单独一个聚合层（不是三个页面各算一遍）
 *
 * 学习库首页、学习地图、错题页都要回答「我哪块弱」，而它们如果各自算，
 * 三个界面上的数字迟早会对不上。项目已经踩过这个坑：
 * 概览说「已学 10 张」而列表只有 3 张 —— 因为两处用了不同的范围。
 *
 * 所以参照 StudyHub 的做法（`lib/coverage.js` / `lib/mastery.js` 的注释里反复
 * 强调「the backend and the browser read ONE function, so the numbers on every
 * screen are the same numbers」），这里只暴露一个 `buildStudyMap()`，
 * 三处界面都读它的输出。
 *
 * 来源：https://github.com/EricWang1358/dsh-web-studyhub
 *   - `ui/study-map/map-model.js`（`mergeProgress` / `dotLevel`：把若干节点的进度
 *     合成一个，掌握度按题数加权）
 *   - `lib/mastery.js`（五档掌握度与「连续答对」的思路）
 *
 * ## 为什么不需要让 AI 给题目打标签
 *
 * 分类信息本来就在数据里：
 *   `Question.knowledgePointId` → `KnowledgePoint.chapter`  （章节名）
 *   `Question.anchors[].sourceId` / `.chapter`              （出处与章节）
 * 所以「按书、按章」归类是纯聚合，**不新增存储、不改出题链路、不要迁移**。
 * 只有当一道题既没有知识点、锚点里也没有章节时，才落到「未归类」——
 * 如实显示，不猜。
 *
 * ## 纯函数
 *
 * 不碰 I/O：入参就是内存里的数组，出参就是结构。所有分支都能单测。
 */

import type { SourceLocation } from '@/core/model.ts';

/** 参与聚合的最小卡片形状（只取需要的字段，便于测试构造） */
export interface MapCard {
  id: string;
  sourceId: string;
  prompt: string;
  anchors: SourceLocation[];
}

/** 参与聚合的最小知识点形状 */
export interface MapPoint {
  id: string;
  chapter: string | null;
  sourceId: string | null;
}

/** 一张卡的进度（来自 reviewRecords 派生的状态） */
export interface MapProgress {
  /** 0–1 掌握度 */
  mastery: number;
  /** 今天是否到期 */
  due: boolean;
  /** 是否已经学过（有过复习记录） */
  learned: boolean;
  /** 最近一次是否答错 */
  wrong: boolean;
}

export const NO_CHAPTER = '未归类';

/**
 * 一道题属于哪一章。
 *
 * 优先级（写清楚是因为顺序会影响结果）：
 *   1. 知识点上的 chapter —— 整理知识点时由模型划的章，最贴近「这是一本教材的第几章」
 *   2. 锚点里的 chapter —— 按章节切分的资料（docx）自带
 *   3. 锚点的页码 —— 按页切分的 PDF 没有章名，退化成「第 N 页」
 *   4. 未归类
 *
 * 为什么页码要退化成「第 N 页」而不是硬塞进「未归类」：
 * 一份 36 页的教材如果全归到「未归类」，学习地图就只剩一行，等于没做。
 * 页码虽然粗，但至少能回答「我第 13–24 页从来没做对过」。
 */
export function chapterOf(card: MapCard, pointByQuestion: ReadonlyMap<string, MapPoint>): string {
  const point = pointOf(card, pointByQuestion);
  if (point?.chapter) return point.chapter;

  for (const a of card.anchors) {
    if (a.chapter) return a.chapter;
  }

  const pages = card.anchors
    .map((a) => a.page)
    .filter((p): p is number => typeof p === 'number' && p > 0);
  if (pages.length > 0) {
    const min = Math.min(...pages);
    return `第 ${min} 页`;
  }

  return NO_CHAPTER;
}

/**
 * 一道题对应的知识点。
 *
 * 卡片本身不存 `knowledgePointId`（`cards-loader.ts` 的 `questionToCard` 没带这个字段，
 * 因为它只服务做题），所以这里用「题 id → 知识点」的外部映射，
 * 由调用方从 `questions` 分区建一次。
 */
function pointOf(card: MapCard, pointByQuestion: ReadonlyMap<string, MapPoint>): MapPoint | null {
  return pointByQuestion.get(card.id) ?? null;
}

/**
 * 一张卡属于哪一份资料。
 *
 * ## 为什么要回退到 anchors（2026-11-07 用真实库查出来的）
 *
 * 卡片上的 `sourceId` 来自**题组的** `sourceId`（见 `cards-loader.ts`：
 * `deckSource.get(q.deckId)`）。但题组的 `sourceId` 可以是 `null` ——
 * 整库随机抽素材出的题组、以及手工建的题组都没有归属资料。
 *
 * 实测用户库：24 道题里有 8 道属于一个 `sourceId = null` 的已发布题组，
 * 但**这些题的 `anchors[].sourceId` 是有值的**（就是「信号与系统」那本书）。
 * 只看题组的 sourceId，这 8 道题就会被归进「随机或手工题库」，
 * 学习地图上于是凭空多出一份不存在的资料。
 *
 * 所以顺序是：卡片自身 sourceId → 知识点所属资料 → 第一个有值的锚点。
 * 三者都没有才算真的「无归属」。
 */
export function sourceOf(card: MapCard, pointByQuestion: ReadonlyMap<string, MapPoint>): string {
  if (card.sourceId) return card.sourceId;

  const point = pointOf(card, pointByQuestion);
  if (point?.sourceId) return point.sourceId;

  for (const a of card.anchors) {
    if (a.sourceId) return a.sourceId;
  }
  return '';
}

/** 一个分组的汇总 */
export interface MapGroup {
  /** 稳定 id：资料 id + 章节名 */
  key: string;
  /** 章节名（资料层为资料标题） */
  title: string;
  /** 这一组有多少张卡 */
  total: number;
  /** 学过的 */
  learned: number;
  /** 今天到期 */
  due: number;
  /** 最近一次答错的 */
  wrong: number;
  /** 掌握度 0–1，按题数加权（没有学过的卡按 0 计） */
  mastery: number;
}

/** 一份资料（含它的各章） */
export interface MapSource extends MapGroup {
  sourceId: string;
  chapters: MapGroup[];
}

export interface StudyMap {
  sources: MapSource[];
  /** 全库汇总 */
  all: MapGroup;
}

const EMPTY_GROUP = (key: string, title: string): MapGroup => ({
  key,
  title,
  total: 0,
  learned: 0,
  due: 0,
  wrong: 0,
  mastery: 0,
});

/**
 * 把若干张卡的进度合进一个分组。
 *
 * 掌握度按题数加权，而不是「各组掌握度的平均」——
 * 后者会让只有 1 道题的章节和 20 道题的章节权重相同，
 * 一条没做过的孤立题能把整本书的掌握度拉低一半。
 * StudyHub 的 `mergeProgress` 也是这么做的（`weighted += p.mastery * p.total`）。
 */
function addCard(group: MapGroup, p: MapProgress | undefined): void {
  group.total += 1;
  if (!p) return; // 没进度 = 没学过，掌握度按 0 计，但题数要算上
  if (p.learned) group.learned += 1;
  if (p.due) group.due += 1;
  if (p.wrong) group.wrong += 1;
  // 累计掌握度，最后由题数除 —— 这里借用 mastery 字段暂存总和
  group.mastery += p.mastery;
}

function seal(group: MapGroup): MapGroup {
  group.mastery = group.total > 0 ? group.mastery / group.total : 0;
  return group;
}

export interface BuildOptions {
  /** 资料标题；拿不到时用 sourceId */
  sourceTitleOf?: (sourceId: string) => string | null;
}

/**
 * 建整张学习地图。
 *
 * @param cards      题库里所有卡（已发布题组的题）
 * @param progress   卡片 id → 进度
 * @param pointByQuestion 题目 id → 它依据的知识点
 */
export function buildStudyMap(
  cards: readonly MapCard[],
  progress: ReadonlyMap<string, MapProgress>,
  pointByQuestion: ReadonlyMap<string, MapPoint> = new Map(),
  options: BuildOptions = {},
): StudyMap {
  const bySource = new Map<string, MapSource>();

  for (const card of cards) {
    /*
     * 资料归属要看三层（见 sourceOf 的注释）：
     * 卡片自身 → 知识点 → 锚点。只看第一层会把「题组 sourceId 为空
     * 但锚点有出处」的题误归到「随机或手工题库」。
     */
    const sourceId = sourceOf(card, pointByQuestion) || '__none__';
    let source = bySource.get(sourceId);
    if (!source) {
      const title = options.sourceTitleOf?.(sourceId) ?? null;
      /*
       * 只有三层都取不到才落到这一组：随机题组（整库随机抽素材）和
       * 手工建的题组本来就没有归属资料。这类题不能丢，也不能假装属于
       * 某本书 —— 单独一组，名字说清它是怎么来的。
       */
      const fallback = sourceId === '__none__' ? '随机或手工题库' : sourceId;
      source = {
        ...EMPTY_GROUP(`source:${sourceId}`, title ?? fallback),
        sourceId,
        chapters: [],
      };
      bySource.set(sourceId, source);
    }

    const chapter = chapterOf(card, pointByQuestion);
    let row = source.chapters.find((c) => c.title === chapter);
    if (!row) {
      row = EMPTY_GROUP(`${sourceId}#${chapter}`, chapter);
      source.chapters.push(row);
    }

    const p = progress.get(card.id);
    addCard(source, p);
    addCard(row, p);
  }

  const sources = [...bySource.values()];
  const all = EMPTY_GROUP('all', '全部');

  for (const s of sources) {
    for (const ch of s.chapters) {
      ch.mastery = ch.total > 0 ? ch.mastery / ch.total : 0;
      // 章节排序：弱的排前面（掌握度低的先出现），同掌握度按题多的先
      // —— 这一页要回答「我哪块不行」，所以最差的必须在最上面
    }
    s.chapters.sort((a, b) => {
      if (a.mastery !== b.mastery) return a.mastery - b.mastery;
      return b.total - a.total;
    });
    seal(s);

    all.total += s.total;
    all.learned += s.learned;
    all.due += s.due;
    all.wrong += s.wrong;
    all.mastery += s.mastery * s.total;
  }
  seal(all);

  // 资料排序：同样最弱的排前面
  sources.sort((a, b) => {
    if (a.mastery !== b.mastery) return a.mastery - b.mastery;
    return b.total - a.total;
  });

  return { sources, all };
}

/**
 * 掌握度的文字档位。
 *
 * 为什么需要 `learned` 而不只是看数字：
 * `mastery()` 在 `intervalDays = 1` 时算出 `intervalScore = 0`，
 * 一道刚做过一次、对了 1/1 的题掌握度可能是 0.03 —— 数字上贴着 0。
 * 如果只按数字分档，界面会写「没学过」，而旁边同时写着「1/1 道练过」，
 * 于是同一行里出现两句互相矛盾的话（项目踩过一次：
 * 「两种矛盾提示同时出现」）。所以练过但分很低的情况单独一档。
 *
 * 为什么还要看 `wrong`：
 * 截图里发现「2/2 道练过 · 2 道错着」显示成「还生疏」—— 太轻了。
 * 全错和「练过一点但还没熟」不是一回事，前者是明确的薄弱信号。
 * 有错题时优先说「易错」。
 *
 * 数值档位本身与 `srs.ts` 的 `masteryLabel` 保持一致，
 * 免得同一个数字在两页上有两个说法。
 */
export function mapLabel(mastery: number, learned = false, wrong = false): string {
  if (mastery >= 0.85) return '很熟';
  if (mastery >= 0.6) return '熟练';
  if (mastery >= 0.35) return '有点印象';
  if (mastery > 0) return '刚起步';
  if (wrong) return '易错';
  return learned ? '还生疏' : '没学过';
}

/**
 * 最该补的章节：掌握度最低、且确实练过一点的章节。
 *
 * 为什么要求「练过一点」：一道从没做过的题掌握度天然是 0，
 * 如果直接取最小值，永远是「还没开始的那一章」——
 * 那用户看到的就是「你最弱的是你还没学过的那章」，等于废话。
 *
 * ## 为什么要看样本量，而不是只看掌握度
 *
 * 只看掌握度的话，**只做过 1 道且做错的章节**（掌握度 0）会赢过
 * 做过 8 道、对了 2 道的章节（掌握度可能 0.4）—— 但前者根本说明不了
 * 「这块弱」，只说明「这块刚开始」。1 道题没有统计意义。
 *
 * 做法：**先要求最低样本量**，不够分的章节不进候选（除非全库都不够）。
 * 为什么不写成 `(1 - mastery) × 练过比例` 的连续加权：
 * 那样会得出反直觉的结果 —— 一个「共 1 道、练了 1 道」的章节
 * 覆盖率是 1/1 = 1，权重反而最高，恰恰把最不可信的样本排在第一位。
 * 门槛式更直白，也更好向用户解释「凭什么说这里最弱」。
 *
 * 最低样本取 2：1 道题的章节不足以支撑一句结论；2 道起才开始有意义。
 * 这是启发式，不是统计结论 —— 所以界面上的措辞是「最该补」而不是
 * 「你最弱的是」，留出被用户推翻的余地。
 */
const MIN_SAMPLE = 2;

export function weakestChapter(map: StudyMap): { source: MapSource; chapter: MapGroup } | null {
  /** 按「缺口 × 掌握度」挑：缺口越大、掌握越低越该补 */
  const pick = (allowSmall: boolean) => {
    let best: { source: MapSource; chapter: MapGroup } | null = null;
    for (const s of map.sources) {
      for (const ch of s.chapters) {
        if (ch.learned === 0) continue;
        if (!allowSmall && ch.total < MIN_SAMPLE) continue;
        if (
          best === null ||
          // 掌握度更低 → 更该补
          ch.mastery < best.chapter.mastery ||
          // 同样低 → 题目多的那一章，样本更足，结论更站得住
          (ch.mastery === best.chapter.mastery && ch.total > best.chapter.total)
        ) {
          best = { source: s, chapter: ch };
        }
      }
    }
    return best;
  };

  // 先只在样本够的章节里找；全库都没有够样本的，才放宽
  const strong = pick(false);
  if (strong) return strong;
  const weak = pick(true);
  if (weak) return weak;

  // 全都没练过：给出题最多的那一章（至少告诉用户从哪开始）
  let best: { source: MapSource; chapter: MapGroup } | null = null;
  for (const s of map.sources) {
    for (const ch of s.chapters) {
      if (!best || ch.total > best.chapter.total) best = { source: s, chapter: ch };
    }
  }
  return best;
}
