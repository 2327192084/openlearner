import type {
  GenerateQuestionsOptions,
  GenerateQuestionsResult,
  GenerateQuestionsRuntime,
  QuestionBackend,
  QuestionDraft,
  QuestionSourcePoint,
} from './backend-types.ts';
import { planKinds } from './backend-types.ts';

/**
 * 示例出题后端：不联网、不花钱、结果可预测。
 *
 * ## 它做什么、不做什么
 *
 * **做**：从知识点的表述与原文引用里**机械地**构造题目。
 * 例如把「线性表是由 n 个数据元素构成的有限序列」里的关键术语挖空，
 * 变成一道填空题；或者用其他知识点当干扰项拼一道单选题。
 *
 * **不做**：真正的理解、变式、跨概念综合。它不会问你「为什么」，
 * 也不会设计需要推理的题目。
 *
 * ## 为什么仍然值得存在
 *
 * 1. P3 验收要求「用假后端也能跑通整个流程」（沿用 P2 的做法）
 * 2. 离线演示：不配 Key 也能看到刷题界面
 * 3. 让「发布校验」「判分」「错题归集」这些逻辑可以在不花钱的前提下反复测
 *
 * 界面上会明确标「示例后端·非 AI」，不让用户误以为是 AI 出的题。
 */

/** 每道题的人为延迟，让进度可见 */
export class MockQuestionBackend implements QuestionBackend {
  readonly id = 'mock-questions';
  readonly label = '示例出题（离线，不联网）';
  readonly isMock = true;

  constructor(private readonly delayMs = 60) {}

  estimateTokens(points: QuestionSourcePoint[], options: GenerateQuestionsOptions): number {
    // 示例后端不真的调用模型，但仍给出一个可比量级，
    // 这样「预计用量」区域在两种后端下都有内容可显示
    void points;
    return options.count * 150 + 300;
  }

  async generate(
    points: QuestionSourcePoint[],
    options: GenerateQuestionsOptions &
      GenerateQuestionsRuntime & {
        onDraft?: (draft: QuestionDraft) => void | Promise<void>;
      },
  ): Promise<GenerateQuestionsResult> {
    const candidates = pickPoints(points, options);
    const drafts: QuestionDraft[] = [];
    let stopped = false;

    /**
     * 已发出的题干集合，用来防止重复。
     *
     * 早先的实现用 `candidates[i % candidates.length]` 绕圈取知识点，
     * 题数超过知识点数时必然重复 —— 实测 10 条知识点出 20 道题，
     * 后 10 道的题干与前 10 道完全一样，发布校验直接报出 10 条「题干重复」。
     *
     * 现在的处理：
     *   - 每道题在题干里带上知识点序号（第 N 条），保证同一知识点的题也不雷同
     *   - 仍然维护去重集合兜底
     *   - 实在凑不够 count 时**如实少出**，不要为了凑数硬造重复题
     */
    const usedPrompts = new Set<string>();
    let attempts = 0;
    const maxAttempts = options.count * 4;

    /*
     * 预先算出「第 i 道出什么题型」。
     *
     * 有 kindCounts 时按配额逐种展开（同一题型连续出），否则退回旧的轮转。
     * 两处逻辑统一在 planKinds 里 —— 真实后端与这里必须用同一份推导，
     * 否则「界面要求的分布」和「实际出的分布」会对不上。
     */
    const kindPlan = planKinds(options.kinds, options.count, options.kindCounts);

    for (let i = 0; i < options.count && attempts < maxAttempts; i++) {
      if (options.signal.aborted) {
        stopped = true;
        break;
      }

      const pointIndex = i % candidates.length;
      const point = candidates[pointIndex];
      if (!point) break;

      const kind = kindPlan[i] ?? options.kinds[i % options.kinds.length]!;
      attempts += 1;

      // 同一个知识点被用第二次时，用轮次编号区分题干，避免完全雷同
      const round = Math.floor(i / candidates.length);
      const draft = buildDraft(kind, point, candidates, i + round, round);
      if (!draft) continue;

      if (usedPrompts.has(draft.prompt)) continue;
      usedPrompts.add(draft.prompt);

      if (this.delayMs > 0) {
        await sleep(this.delayMs, options.signal);
      }
      if (options.signal.aborted) {
        stopped = true;
        break;
      }

      drafts.push(draft);
      // 必须 await：调用方在回调里落库，停止信号才能在两条之间生效
      await options.onDraft?.(draft);

      if (options.signal.aborted) {
        stopped = true;
        break;
      }
    }

    return {
      drafts,
      actualTokens: drafts.length * 150,
      stopped,
    };
  }
}

/** 按难度筛选；不够就放宽，避免因为筛得太严导致一道题都出不来 */
function pickPoints(
  points: QuestionSourcePoint[],
  options: GenerateQuestionsOptions,
): QuestionSourcePoint[] {
  if (!options.levels || options.levels.length === 0) return points;

  const filtered = points.filter((p) => options.levels!.includes(p.cognitiveLevel));
  return filtered.length > 0 ? filtered : points;
}

/**
 * 从一条知识点构造一道题。
 *
 * 三种构造方式，都是机械规则，不含任何「理解」：
 *
 * 1. **填空**：把表述里的一个术语挖掉，答案是那个术语
 * 2. **单选**：用表述当题干，正确答案是该术语，干扰项从其他知识点借
 * 3. **多选/问答**：用原文引用当题干线索
 */
function buildDraft(
  kind: 'single' | 'multiple' | 'truefalse' | 'blank' | 'essay',
  point: QuestionSourcePoint,
  allPoints: QuestionSourcePoint[],
  index: number,
  /**
   * 变体编号。同一个知识点被重复使用时，用它让题干有区别，
   * 避免「10 条知识点出 20 道题」时后 10 道与前 10 道一模一样。
   * 也用于让同一概念的「换个问法」在示例数据里体现出来。
   */
  variant = 0,
): QuestionDraft | null {
  const statement = point.statement.trim();
  if (statement.length < 8) return null;

  const term = extractTerm(point);
  if (!term) return null;

  if (kind === 'blank') {
    return {
      kind: 'blank',
      prompt: `填空${variantSuffix(variant)}：${statement.replace(term, '______')}`,
      options: [],
      answer: term,
      explanation: `出自知识点「${truncate(statement, 40)}」。原文依据：${truncate(
        point.quotes[0] ?? '',
        60,
      )}`,
      knowledgePointId: point.id,
    };
  }

  if (kind === 'truefalse') {
    /*
     * 判断题：给一句陈述，判对错。
     *
     * 怎么造「错的」那一半：**把关键术语换掉**，而不是编一句假话。
     * 换成另一个知识点里的术语，读起来仍然像教材句子，但事实是错的 ——
     * 这正是真实考试里判断题的样子（似是而非，不是明显荒谬）。
     *
     * 换不出术语时返回 null（宁可这一条不出判断题，也不造一句
     * 「1+1=3」这种一眼假的题 —— 那种题测不出任何东西）。
     */
    /*
     * 找一个「不同的术语」来造错误陈述。
     *
     * 不能只试第一个其他知识点 —— 所有知识点都提取出同一个术语时
     * （在单章、术语高度重复的资料里很常见），那样会一道判断题都出不来。
     * 这里遍历全部候选，取第一个真正不同的。
     */
    let otherTerm: string | null = null;
    for (const p of allPoints) {
      if (p.id === point.id) continue;
      const t = extractTerm(p);
      if (t && t !== term) {
        otherTerm = t;
        break;
      }
    }
    if (!otherTerm) return null;

    /*
     * variant 决定这次出「对的」还是「错的」，让同一个知识点
     * 被重复使用时两种都出现。
     */
    const wantTrue = variant % 2 === 0;
    const shown = wantTrue ? statement : statement.replace(term, otherTerm);

    return {
      kind: 'truefalse',
      prompt: `判断对错${variantSuffix(variant)}：${shown}`,
      options: [
        { key: 'T', text: '对' },
        { key: 'F', text: '错' },
      ],
      answer: wantTrue ? 'T' : 'F',
      explanation: wantTrue
        ? `这句是对的，出自知识点「${truncate(statement, 40)}」。`
        : `这句是错的：原文说的是「${term}」，不是「${otherTerm}」。`,
      knowledgePointId: point.id,
    };
  }

  if (kind === 'single') {
    const options = buildOptions(term, allPoints, point.id, index, statement);
    if (!options) return null;
    const correctKey = options[0].key;
    return {
      kind: 'single',
      prompt: `以下哪一项是「${truncate(statement, 50)}」中的关键概念${variantSuffix(variant)}？`,
      options: shuffle(options, index),
      answer: correctKey,
      explanation: `正确项是「${term}」。其余选项来自其他知识点，与本条无关。`,
      knowledgePointId: point.id,
    };
  }

  if (kind === 'multiple') {
    /**
     * 多选：需要 2 个正确项。
     *
     * 第二个正确项的来源，按优先级：
     *   1. **同一章节**的另一个知识点 —— 语义上最合理（同章概念常一起考）
     *   2. 没有同章的，退而取同一份资料里的另一个知识点
     *
     * 早先只认「同章节」，结果在「每个知识点自成一章」的资料上
     * 多选题一道都出不来，全部退回单选。实测发现的。
     * 放宽到同资料之后，多选才真的会出现。
     */
    const correct = [term];

    const sameChapter = allPoints.find(
      (p) => p.id !== point.id && p.chapter && p.chapter === point.chapter,
    );
    let sibling = sameChapter;
    if (!sibling) {
      sibling = allPoints.find((p) => p.id !== point.id);
    }

    const secondTerm = sibling ? extractTerm(sibling) : null;
    if (secondTerm && secondTerm !== term) correct.push(secondTerm);

    if (correct.length < 2) {
      // 凑不齐两个不同的正确项时退回单选，
      // 不要造一个「答案写着 A,B 但两个选项文字一样」的假多选题
      return buildDraft('single', point, allPoints, index);
    }

    const wrong = allPoints
      .filter((p) => p.id !== point.id && p.id !== sibling?.id)
      .map((p) => extractTerm(p))
      .filter((t): t is string => Boolean(t) && !correct.includes(t!))
      .slice(0, 2);

    if (wrong.length < 1) return buildDraft('single', point, allPoints, index);

    const all = [
      ...correct.map((t) => ({ text: t, ok: true })),
      ...wrong.map((t) => ({ text: t, ok: false })),
    ];
    const withKeys = shuffle(
      all.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text, ok: o.ok })),
      index,
    );
    const answerKeys = withKeys.filter((o) => o.ok).map((o) => o.key).sort();

    return {
      kind: 'multiple',
      prompt: `以下哪些概念与「${truncate(statement, 45)}」直接相关${variantSuffix(variant)}？（多选）`,
      options: withKeys.map(({ key, text }) => ({ key, text })),
      answer: answerKeys.join(','),
      explanation: `正确项：${answerKeys.join('、')}。它们都出自同一条知识点或其所在章节。`,
      knowledgePointId: point.id,
    };
  }

  // essay：用原文引用当题干，答案是要点复述
  const quote = point.quotes[0];
  return {
    kind: 'essay',
    prompt: `请用自己的话说明：${truncate(statement, 60)}${quote ? `\n\n（原文线索：${truncate(quote, 60)}）` : ''}`,
    options: [],
    answer: statement,
    explanation: `参考答案即知识点表述本身。评分时按要点是否覆盖到「${truncate(term, 20)}」等关键词自行判断。`,
    knowledgePointId: point.id,
  };
}

/**
 * 从知识点里挖一个「术语」当答案。
 *
 * ## 这里踩过一个很隐蔽的坑
 *
 * 早先的策略是「取最长的连续中文片段」。在真实教材上没问题
 * （「线性表是由 n 个数据元素构成的有限序列」→ 取到「线性表」）。
 * 但遇到一批**结构雷同**的表述时（比如测试数据里的
 * 「第1条知识点的概念表述内容」「第2条…」），
 * 最长片段全都是同一段「条知识点的概念表述内容」——
 *
 * 后果不只是「术语提得不好」：干扰项要求 != correctTerm，
 * 于是所有候选都被过滤掉，单选题与多选题**全军覆没**，
 * 20 道题只出到 10 道，题型只剩填空和问答。
 * 这个现象是实测发现的，不是推演出来的。
 *
 * ## 现在的策略
 *
 * 1. 优先「X 是/指/称为」结构里的 X —— 最像术语
 * 2. 否则取**带编号前缀的整段**（如「第3条…」），
 *    因为这类表述的区分度恰恰在编号上
 * 3. 再否则取最长的中文片段，但排除停用词开头
 */
function extractTerm(point: QuestionSourcePoint): string | null {
  const statement = point.statement;

  // 1) 「X 是/指/称为 Y」
  const defMatch = /^([\u4e00-\u9fa5A-Za-z0-9]{2,12})(?:是|指|称为|叫做)/.exec(statement);
  if (defMatch) return defMatch[1];

  // 2) 带编号前缀的表述：编号本身就是最有区分度的部分
  const numbered = /^[第\d一二三四五六七八九十]+[条章节项]?[\u4e00-\u9fa5A-Za-z0-9]{1,10}/.exec(statement);
  if (numbered) {
    return numbered[0].slice(0, 12);
  }

  // 3) 最长中文片段，去掉停用词开头
  const chunks = statement.match(/[\u4e00-\u9fa5]{3,12}/g) ?? [];
  const usable = chunks.filter(
    (c) => !/^(它是|这个|那个|我们|可以|如果|因为|所以|但是|而且|以及|进行|通过)/.test(c),
  );
  if (usable.length > 0) {
    return usable.sort((a, b) => b.length - a.length)[0];
  }

  return null;
}

/**
 * 拼一道单选题的选项：1 个正确 + 若干干扰。
 *
 * ## 这里踩过一个坑，值得记下来
 *
 * 早先干扰项只从「其他知识点的术语」里借，且要求凑满 3 个。
 * 结果在知识点术语雷同的资料上（比如一堆「第1条…」「第2条…」），
 * 提取出来的术语全是「第1」「第2」，互相重复，
 * 凑不出 3 个不同干扰项 → 单选题全军覆没，
 * 20 道题只出了 10 道，而且题型只剩填空和问答。
 *
 * 现在的做法：
 *   1. 干扰项来源扩展：其他知识点的术语 + 本知识点的其他片段
 *   2. 不足 3 个时**用 2 个也出题**（选项 3 个的单选题依然成立）
 *   3. 实在少于 2 个才放弃（那是数据太单薄，不该硬造）
 */
function buildOptions(
  correctTerm: string,
  allPoints: QuestionSourcePoint[],
  excludeId: string,
  seed: number,
  statement = '',
): { key: string; text: string }[] | null {
  const others = allPoints.filter((p) => p.id !== excludeId);

  // 来源一：其他知识点的术语
  const fromOthers = others
    .map((p) => extractTerm(p))
    .filter((t): t is string => Boolean(t) && t !== correctTerm);

  // 来源二：其他知识点的表述片段（当术语重复时提供更多变化）
  const fromStatements = others
    .map((p) => firstChunk(p.statement))
    .filter((t): t is string => Boolean(t) && t !== correctTerm);

  // 来源三：本知识点表述里的其他片段（最后兜底）
  const fromSelf = chunksOf(statement).filter((t) => t !== correctTerm);

  const pool = [...new Set([...fromOthers, ...fromStatements, ...fromSelf])]
    .filter((t) => t.length >= 2 && t !== correctTerm)
    .slice(0, 3);

  // 至少要有 2 个干扰项，否则选项总数不足 3 个，题目区分度太低
  if (pool.length < 2) return null;

  const all = [correctTerm, ...pool];
  return shuffle(
    all.map((text, i) => ({ key: String.fromCharCode(65 + i), text })),
    seed,
  );
}

/** 取表述里第一段连续中文（≥2 字）当候选干扰项 */
function firstChunk(statement: string): string | null {
  const m = /[一-龥]{2,12}/.exec(statement);
  return m ? m[0] : null;
}

/** 把表述切成若干连续中文片段 */
function chunksOf(statement: string): string[] {
  return statement.match(/[一-龥]{2,10}/g) ?? [];
}

/** 确定性洗牌：同一个 seed 结果一致，便于测试复现 */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed + 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 变体后缀。
 *
 * 第一轮（variant 0）不加后缀，题干保持干净；
 * 后续轮次加上「（变式N）」，让同一知识点的第二次出题在题干上就能区分。
 * 用户看到的是「换个问法」，不是无聊的重复。
 */
function variantSuffix(variant: number): string {
  return variant > 0 ? `（变式${variant + 1}）` : '';
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 可被中断的 sleep：点了停止要立刻响应，不能等这次 sleep 走完 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
