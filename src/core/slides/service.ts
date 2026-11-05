import { newId, nowIso } from '../id.ts';
import type {
  KnowledgePoint,
  SlideCitation,
  SlideDeck,
  SlideFigure,
  SlideOutlinePage,
  Source,
} from '../model.ts';
import type { StorageAdapter } from '../storage/types.ts';
import type { UsageService } from '../usage.ts';
import { ApiError } from '../ai/chat-client.ts';
import { SLIDE_LIMITS, chunkBullets, normalizeBulletText } from './limits.ts';
import { buildCoverPage, buildOutline } from './outline.ts';
import { applyAiOutline } from './ai-outline.ts';
import type { OutlineBackend, OutlineInputPoint } from './backend-types.ts';
import { buildRenderPlan, planStats, type RenderSlide } from './render-plan.ts';
import { buildFileName, exportToPptx } from './pptx-export.ts';

/**
 * 学习 PPT 服务：建 PPT、生成大纲、编辑大纲、导出。
 *
 * ## 两段式流程（和 P3 的草稿→发布同构）
 *
 * 1. 选知识点 → 生成**大纲**（status='outline'），用户改标题、调顺序、删页、加页
 * 2. 确认后再导出 .pptx
 *
 * 为什么中间要停一次：直接出 pptx 的话，学生要等下载完、用 PowerPoint 打开、
 * 翻一遍才发现「第一章被切成了 3 页、第二章只有 1 条」。
 * 大纲是纯文本，改起来是秒级的，导出是要下载文件的。
 * 让人在便宜的环节改，别在贵的环节返工。
 */

export interface CreateDeckInput {
  title?: string;
  sourceId: string;
  /** 要写进 PPT 的知识点，需调用方按原文顺序传 */
  points: KnowledgePoint[];
  courseId?: string | null;
  /** 其他资料的标题（sourceId → title），跨资料引用时用 */
  sourceTitles?: Map<string, string>;
  /**
   * AI 大纲后端。
   *
   * 不传时退回确定性算法（`buildOutline`）。这条回退路径**不是**给
   * 「离线也能用」准备的 —— 产品定位是必须接 AI。它只在模型请求失败时
   * 兜底，并把 `usedAi=false` 如实报给界面，让用户知道这次没用上模型，
   * 而不是让他以为看到的是 AI 产出的东西。
   */
  backend?: OutlineBackend;
  /** 生成语言，默认 zh */
  language?: 'zh' | 'en';
  /** 取消信号（用户在生成中途点了停止） */
  signal?: AbortSignal;
}

export interface CreateDeckResult {
  deck: SlideDeck;
  /** 有多少条要点因为知识点没定位而没有角标 */
  bulletsWithoutCitation: number;
  /** 有多少条知识点因为正文为空被跳过 */
  skippedPoints: number;
  /** 这次大纲是否真的由 AI 生成 */
  usedAi: boolean;
  /**
   * 回退原因。`usedAi=false` 且有值时为失败详情，
   * 界面要如实显示「这次没用上 AI」，不能静默降级。
   */
  aiFailure?: string;
  /** 实际 token 用量（AI 生成时有值） */
  tokens: number | null;
}

export interface ExportOutcome {
  recordId: string;
  fileName: string;
  byteSize: number;
  slideCount: number;
  buffer: Uint8Array;
}

export class SlideService {
  /**
   * @param storage 存储层
   * @param usage 用量统计。可选：单元测试里不关心记账时可以不传
   */
  constructor(
    private readonly storage: StorageAdapter,
    private readonly usage?: UsageService,
  ) {}

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  async list(): Promise<SlideDeck[]> {
    const all = await this.storage.getAll('slideDecks');
    return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async get(id: string): Promise<SlideDeck | null> {
    return this.storage.get('slideDecks', id);
  }

  /** 取渲染计划：预览与导出共用，界面直接拿它渲染 */
  async getPlan(id: string): Promise<RenderSlide[]> {
    const deck = await this.get(id);
    if (!deck) return [];
    return buildRenderPlan(deck, deck.title);
  }

  // -------------------------------------------------------------------------
  // 建与生成
  // -------------------------------------------------------------------------

  /**
   * 从知识点生成一份 PPT 的大纲。
   *
   * 不做「先建空 PPT 再往里塞」两步走：用户从知识点页点「生成学习 PPT」时，
   * 期望的是「拿到一份能改的大纲」，而不是「库里多了一个空壳」。
   */
  async createFromPoints(input: CreateDeckInput): Promise<CreateDeckResult> {
    if (input.points.length === 0) {
      throw new Error('没有选中的知识点。请先在「知识点」页生成或勾选一些知识点。');
    }

    const source = input.sourceId ? await this.storage.get('sources', input.sourceId) : null;
    const sourceTitle = source?.title ?? '学习资料';

    const sourceTitles = input.sourceTitles ?? new Map<string, string>();
    if (source && !sourceTitles.has(source.id)) {
      sourceTitles.set(source.id, source.title);
    }

    const deckTitle = (input.title ?? '').trim() || `${sourceTitle} · 学习 PPT`;

    // ── 先试 AI ───────────────────────────────────────────────
    let pages: SlideOutlinePage[] | null = null;
    let citations: SlideCitation[] | null = null;
    let bulletsWithoutCitation = 0;
    let skippedPoints = 0;
    let tokens: number | null = null;
    let aiFailure: string | undefined;
    /** AI 是否真的产出了大纲（决定 usedAi，不能只看有没有传 backend） */
    let aiProduced = false;

    if (input.backend) {
      try {
        const aiResult = await this.generateWithAi(input, {
          deckTitle,
          sourceTitle,
          sourceTitles,
        });
        if (aiResult) {
          pages = aiResult.pages;
          citations = aiResult.citations;
          bulletsWithoutCitation = aiResult.bulletsWithoutCitation;
          tokens = aiResult.tokens;
          skippedPoints = aiResult.droppedBullets;
          aiProduced = true;
        } else {
          aiFailure = '模型返回的大纲是空的（可能内容太少，或返回格式不对）';
        }
      } catch (err) {
        // 用户主动停止不算失败，直接往上抛
        if (err instanceof ApiError && err.code === 'aborted') throw err;
        if (input.signal?.aborted) throw err;
        aiFailure = err instanceof Error ? err.message : String(err);
      }
    }

    /**
     * AI 没成功 → 退回确定性大纲。
     *
     * 这条回退**不是**「离线也能用」的功能：产品定位是必须接 AI。
     * 它存在的理由是「请求失败不该让用户一个字的产出都拿不到」。
     * 调用方会拿到 usedAi=false 与 aiFailure，界面必须如实告知，
     * 不能让人以为看到的是 AI 生成的东西。
     */
    if (!pages) {
      const fallback = buildOutline({
        points: input.points,
        sourceTitle,
        title: input.title,
        sourceTitles,
      });

      if (fallback.pages.length <= 1) {
        throw new Error(
          fallback.skippedPoints > 0
            ? '选中的知识点正文都是空的，无法排成幻灯片。请先检查知识点内容。'
            : '没有可排成幻灯片的内容。请先选中带正文的知识点。',
        );
      }

      pages = fallback.pages;
      citations = fallback.citations;
      bulletsWithoutCitation = fallback.bulletsWithoutCitation;
      skippedPoints = fallback.skippedPoints;
    }

    const ts = nowIso();

    /**
     * 到这里 pages/citations 必然已赋值：
     * 上面两条分支覆盖了「AI 成功」与「回退成功」，
     * 而回退失败会提前 throw。这里的断言只是把这件事告诉类型系统。
     */
    if (!pages || !citations) {
      throw new Error('大纲生成失败：没有得到任何页面。请重试一次。');
    }

    const deck: SlideDeck = {
      id: newId('slide'),
      title: deckTitle,
      courseId: input.courseId ?? source?.courseId ?? null,
      sourceId: input.sourceId || null,
      status: 'outline',
      pages,
      citations,
      exports: [],
      createdAt: ts,
      updatedAt: ts,
    };

    await this.storage.put('slideDecks', deck);

    /**
     * 记账。放在 deck 落库之后，理由同 KnowledgeService / DeckService：
     * 先把用户的数据存好，再记这笔钱。
     *
     * 只在真后端上记 —— 假后端不花钱。`tokens` 为 null 说明服务端没返回
     * usage，那就不记（不猜一个数字出来）。
     */
    if (this.usage && input.backend && !input.backend.isMock && tokens) {
      await this.usage.record({
        backendId: input.backend.id,
        provider: input.backend.provider ?? 'unknown',
        kind: 'slides',
        tokens,
      });
    }

    return {
      deck,
      bulletsWithoutCitation,
      skippedPoints,
      usedAi: aiProduced,
      ...(aiFailure ? { aiFailure } : {}),
      tokens,
    };
  }

  /**
   * 走 AI 生成大纲正文页（不含封面）。
   *
   * 返回 null 表示「AI 没有产出可用内容」，由调用方回退。
   * 抛错表示请求本身失败，同样由调用方回退并记录原因。
   */
  private async generateWithAi(
    input: CreateDeckInput,
    ctx: { deckTitle: string; sourceTitle: string; sourceTitles: Map<string, string> },
  ): Promise<{
    pages: SlideOutlinePage[];
    citations: SlideCitation[];
    bulletsWithoutCitation: number;
    droppedBullets: number;
    tokens: number | null;
  } | null> {
    const backend = input.backend;
    if (!backend) return null;

    /**
     * 只把「有正文」的知识点送给模型。
     *
     * 空 statement 的条目送给模型只会浪费 token，还会让它以为
     * 这里有个需要补全的空位，进而开始编内容。
     */
    const usable = input.points.filter((p) => p.statement?.trim());
    if (usable.length === 0) return null;

    const language = input.language ?? 'zh';

    const aiPoints: OutlineInputPoint[] = usable.map((p) => ({
      id: p.id,
      statement: p.statement,
      quotes: p.quotes,
      chapter: p.chapter,
      page: p.anchors[0]?.page ?? null,
      cognitiveLevel: p.cognitiveLevel,
    }));

    /**
     * 期望页数：按每页最多 5 条要点估，再给一点余量。
     *
     * 上限不是硬要求 —— 提示词里写的是「最多 N 页，内容少就少给」，
     * 因为逼模型凑页数会直接导致它编内容。
     */
    const maxPages = Math.max(1, Math.ceil(usable.length / 5) + 2);

    const result = await backend.generate(aiPoints, {
      title: ctx.deckTitle,
      sourceTitle: ctx.sourceTitle,
      maxPages,
      language,
      signal: input.signal ?? new AbortController().signal,
    });

    if (result.pages.length === 0) return null;

    const applied = applyAiOutline({
      pages: result.pages,
      points: usable,
      sourceTitle: ctx.sourceTitle,
      sourceTitles: ctx.sourceTitles,
      deckTitle: ctx.deckTitle,
    });

    /**
     * AI 一页都没能落地（全部要点都查不到知识点）→ 当作失败回退。
     *
     * 这种情况比返回空更值得警惕：说明模型没按约定的 id 输出，
     * 与其给用户一份空 PPT，不如用确定性大纲兜底并说明原因。
     */
    if (applied.pages.length === 0) return null;

    // 封面统一由这里加，保证 AI 版与回退版结构一致
    const cover = buildCoverPage({
      deckTitle: ctx.deckTitle,
      sourceTitle: ctx.sourceTitle,
      pointCount: usable.length,
    });

    return {
      pages: [cover, ...applied.pages],
      citations: applied.citations,
      bulletsWithoutCitation: applied.bulletsWithoutCitation,
      droppedBullets: applied.droppedBullets,
      tokens: result.actualTokens,
    };
  }

  // -------------------------------------------------------------------------
  // 大纲编辑
  // -------------------------------------------------------------------------

  async updateTitle(id: string, title: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      deck.title = title.trim() || deck.title;
    });
  }

  async updatePageTitle(id: string, pageId: string, title: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (page) page.title = title;
    });
  }

  async updatePageSubtitle(id: string, pageId: string, subtitle: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (page) page.subtitle = subtitle.trim() ? subtitle : null;
    });
  }

  /** 改一条要点的文字。改文字**不动角标**——角标指的是这条要点依据的原文，与措辞无关 */
  async updateBulletText(
    id: string,
    pageId: string,
    bulletId: string,
    text: string,
  ): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      const bullet = page?.bullets.find((b) => b.id === bulletId);
      // 归一空白：带换行的要点在导出时会变成两个段落，压到下一条要点上
      // （详见 limits.ts 的 normalizeBulletText）。这里拦在写库口，
      // 让库里的数据本身就是干净的，不靠渲染时再补救。
      if (bullet) bullet.text = normalizeBulletText(text);
    });
  }

  /** 删一页。封面页不允许删 —— 删了就少一页页码，导出后开头直接是正文 */
  async removePage(id: string, pageId: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) return;
      if (page.layout === 'title') {
        throw new Error('封面页不能删除。如果想换标题，直接改封面页的标题文字。');
      }
      deck.pages = deck.pages.filter((p) => p.id !== pageId);
      this.dropOrphanCitations(deck);
    });
  }

  /** 上一页/下一页：只允许在非封面页之间调 */
  async movePage(id: string, pageId: string, direction: -1 | 1): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const at = deck.pages.findIndex((p) => p.id === pageId);
      if (at < 0) return;

      const target = at + direction;
      if (target < 0 || target >= deck.pages.length) return;

      // 封面固定在第一位，不许被换走
      if (deck.pages[at].layout === 'title' || deck.pages[target].layout === 'title') {
        throw new Error('封面页固定在第一页，不能移动。');
      }

      const [page] = deck.pages.splice(at, 1);
      deck.pages.splice(target, 0, page);
    });
  }

  /** 手动加一页要点页 */
  async addPage(id: string, afterPageId?: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page: SlideOutlinePage = {
        id: newId('sp'),
        layout: 'bullets',
        title: '新的一页',
        subtitle: null,
        bullets: [],
        figure: null,
      };

      const at = afterPageId ? deck.pages.findIndex((p) => p.id === afterPageId) : -1;
      if (at >= 0) {
        deck.pages.splice(at + 1, 0, page);
      } else {
        deck.pages.push(page);
      }
    });
  }

  /**
   * 加一页图文页：把原文某一页贴进 PPT。
   *
   * `figure` 由界面先用 renderSourcePage 渲染好再传进来 ——
   * 服务层不碰画布，也就能在 Node 里跑单测。
   */
  async addFigurePage(
    id: string,
    figure: SlideFigure,
    afterPageId?: string,
  ): Promise<SlideDeck> {
    if (!figure.imageData.startsWith('data:image/')) {
      throw new Error('图片数据无效：需要一个 data URL。请重新选择原文页。');
    }
    if (figure.width <= 0 || figure.height <= 0) {
      throw new Error('图片尺寸无效，无法计算版面。请重新生成图片。');
    }
    // 正常页面截图的比例在 1:3 到 3:1 之间；超出两个数量级说明数据坏了
    const ratio = figure.width / figure.height;
    if (ratio > 20 || ratio < 1 / 20) {
      throw new Error(
        `图片尺寸异常（${figure.width}×${figure.height}），比例不像一页纸。请重新渲染这一页。`,
      );
    }

    return this.mutate(id, (deck) => {
      const page: SlideOutlinePage = {
        id: newId('sp'),
        layout: 'figure',
        // 标题默认取图注去掉书名号的部分，用户可改。
        // 不给空标题：空标题的页面在大纲列表里是一行空白，认不出是哪一页
        title: figure.caption.trim() || `第 ${figure.page} 页`,
        subtitle: null,
        bullets: [],
        figure: { ...figure, caption: normalizeBulletText(figure.caption) },
      };

      const at = afterPageId ? deck.pages.findIndex((p) => p.id === afterPageId) : -1;
      if (at >= 0) {
        deck.pages.splice(at + 1, 0, page);
      } else {
        // 默认插在封面之后：语义上「这一章的配图」应该紧跟封面/章节页，
        // 而不是吊在资料来源页前面
        deck.pages.splice(1, 0, page);
      }
    });
  }

  /** 改图注（图本身不变） */
  async updateFigureCaption(
    id: string,
    pageId: string,
    caption: string,
  ): Promise<SlideDeck> {
    const next = normalizeBulletText(caption);
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) throw new Error('这一页已经不存在了，可能在其他窗口被删除。');
      if (page.layout !== 'figure' || !page.figure) {
        throw new Error('这一页不是图文页，没有图注可改。');
      }
      page.figure = { ...page.figure, caption: next };
    });
  }

  /** 换一张图（同一页换成另一张原文截图） */
  async replaceFigure(id: string, pageId: string, figure: SlideFigure): Promise<SlideDeck> {
    if (!figure.imageData.startsWith('data:image/')) {
      throw new Error('图片数据无效：需要一个 data URL。请重新选择原文页。');
    }
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) throw new Error('这一页已经不存在了，可能在其他窗口被删除。');
      if (page.layout !== 'figure') {
        throw new Error('这一页不是图文页，不能换图。');
      }
      page.figure = { ...figure, caption: normalizeBulletText(figure.caption) };
    });
  }

  /** 手动加一条要点（无角标，用户自己写的内容不该硬安一个出处） */
  async addBullet(id: string, pageId: string, text: string): Promise<SlideDeck> {
    const trimmed = normalizeBulletText(text);
    if (!trimmed) throw new Error('要点内容不能为空。');

    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) throw new Error('这一页已经不存在了，可能在其他窗口被删除。');
      if (page.layout !== 'bullets' && page.layout !== 'figure') {
        throw new Error('只有「要点页」和「图文页」能加要点。');
      }
      page.bullets.push({
        id: newId('sb'),
        text: trimmed,
        citationIndex: null,
      });
    });
  }

  async removeBullet(id: string, pageId: string, bulletId: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) return;
      page.bullets = page.bullets.filter((b) => b.id !== bulletId);
      this.dropOrphanCitations(deck);
    });
  }

  /**
   * 删掉没有任何要点引用的角标，并把编号重排。
   *
   * 必须重排：如果只是删掉中间一个，角标会变成 [1] [3] [4]，
   * 读者会以为这个 PPT 丢了两条引用 —— 而资料页里也确实是缺的。
   * 编号连续才说明「该有的都在」。
   */
  private dropOrphanCitations(deck: SlideDeck): void {
    const used = new Set<number>();
    for (const page of deck.pages) {
      for (const b of page.bullets) {
        if (b.citationIndex !== null) used.add(b.citationIndex);
      }
    }

    const kept = deck.citations.filter((c) => used.has(c.index));
    // 按原编号排序后重编，旧编号 → 新编号的映射要同步写回要点
    kept.sort((a, b) => a.index - b.index);
    const remap = new Map<number, number>();
    kept.forEach((c, i) => {
      remap.set(c.index, i + 1);
      c.index = i + 1;
    });

    for (const page of deck.pages) {
      for (const b of page.bullets) {
        if (b.citationIndex !== null) {
          const next = remap.get(b.citationIndex);
          // 理论上不会缺；真缺了就置空，不给一个指向不存在引用的角标
          b.citationIndex = next ?? null;
        }
      }
    }

    deck.citations = kept;
  }

  // -------------------------------------------------------------------------
  // 确认与导出
  // -------------------------------------------------------------------------

  /**
   * 确认大纲，标为 ready。
   *
   * 只是改状态，不拦人：大纲没写完也可能想先导出一版看看效果。
   * 状态的作用是让列表页能区分「还在改」和「已定稿」。
   */
  async confirm(id: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      deck.status = 'ready';
    });
  }

  /**
   * 导出 .pptx。
   *
   * 导出成功后把记录写进 deck.exports —— 计划书要求「重复导出不覆盖旧版本」，
   * 文件名带版本号解决了文件层面的覆盖；记录解决了「我看不到自己导过几次」。
   */
  async export(id: string): Promise<ExportOutcome> {
    const deck = await this.get(id);
    if (!deck) throw new Error('这份 PPT 已经不存在了，可能在另一个窗口被删除。');

    if (deck.pages.length <= 1) {
      throw new Error('大纲里只有封面页，没有可导出的内容。请先加点内容。');
    }

    // 序号 = 已有导出次数 + 1。第 1 次导出是「第1版」
    const ordinal = deck.exports.length + 1;
    const at = new Date();
    const result = await exportToPptx(deck, ordinal);
    const fileName = normalizeFileName(result.fileName) || buildFileName(deck.title, ordinal, at);

    const recordId = newId('export');
    await this.mutate(id, (d) => {
      d.exports.push({
        id: recordId,
        fileName,
        slideCount: result.slideCount,
        byteSize: result.buffer.byteLength,
        exportedAt: nowIso(),
      });
    });

    return {
      recordId,
      fileName,
      byteSize: result.buffer.byteLength,
      slideCount: result.slideCount,
      buffer: result.buffer,
    };
  }

  /** 统计，界面用来显示「会导出多少页」 */
  async stats(id: string) {
    const deck = await this.get(id);
    if (!deck) return { total: 0, contentPages: 0, sourcePages: 0, bullets: 0, withoutCitation: 0 };
    return planStats(buildRenderPlan(deck, deck.title));
  }

  /** 提示用：这份 PPT 有多少条要点没有出处 */
  async countBulletsWithoutCitation(id: string): Promise<number> {
    const deck = await this.get(id);
    if (!deck) return 0;
    let n = 0;
    for (const page of deck.pages) {
      for (const b of page.bullets) if (b.citationIndex === null) n += 1;
    }
    return n;
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove('slideDecks', id);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 读-改-写，统一盖 updatedAt */
  private async mutate(id: string, fn: (deck: SlideDeck) => void): Promise<SlideDeck> {
    const deck = await this.get(id);
    if (!deck) throw new Error('这份 PPT 已经不存在了，可能在另一个窗口被删除。');
    fn(deck);
    deck.updatedAt = nowIso();
    await this.storage.put('slideDecks', deck);
    return deck;
  }
}

/**
 * 文件名清洗。
 *
 * buildFileName 已经清过一遍，这里再过一遍是防 pptxgenjs 或别处返回的名字：
 * 双保险比让 Windows 报「文件名含非法字符」好，那个错误用户看不懂。
 */
function normalizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * 把资料列表做成 sourceId → title 的查找表。
 *
 * 跨资料生成 PPT 时会用到：知识点可能来自多个资料，
 * 资料页要显示每一条出自哪本书。
 */
export function sourceTitleMap(sources: Source[]): Map<string, string> {
  return new Map(sources.map((s) => [s.id, s.title]));
}

/** 供界面提示用：单页上限，避免界面里散落魔法数字 */
export const SLIDE_PAGE_LIMIT = SLIDE_LIMITS.maxBulletsPerPage;

/** 复用给界面：把要点按页切分（手动加要点超过上限时提示用户拆页） */
export { chunkBullets };

/** 类型再导出，界面只用从这里拿 */
export type { RenderSlide };
