import { newId, nowIso } from '../id.ts';
import type {
  KnowledgePoint,
  SlideCitation,
  SlideDeck,
  SlideFigure,
  SlideImageRecord,
  SlideOutlinePage,
  SlideOverlay,
  Source,
} from '../model.ts';
import type { StorageAdapter } from '../storage/types.ts';
import type { UsageService } from '../usage.ts';
import { ApiError } from '../ai/chat-client.ts';
import { SLIDE_LIMITS, chunkBullets, normalizeBulletText } from './limits.ts';
import { buildCoverPage, buildOutline } from './outline.ts';
import { applyAiOutline } from './ai-outline.ts';
import { resolveTheme } from './theme.ts';
import { assembleTemplate, planTemplate } from './template.ts';
import type { TemplateContentItem } from './template.ts';
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

/**
 * 单张插图的大小上限。
 *
 * 为什么是 8MB 而不是更大：
 *  - 一张 2000px 宽的教材截图 PNG 约 1~3MB，8MB 对正常用途够宽裕；
 *  - 图片是**进备份**的（用户找不回来，必须带走）。50 张 8MB 的图
 *    就是 400MB 的备份文件，而备份是给换机器用的，太大根本传不动；
 *  - IndexedDB 单条记录过大时，某些浏览器会在配额边缘抛 QuotaExceeded，
 *    而且往往发生在写入一批数据的中途，清理起来很麻烦。
 */
export const MAX_SLIDE_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 图片超出上限。
 *
 * 单独一个错误类型，是为了让界面能识别它并给出**可操作**的建议
 * （换图/压缩），而不是把所有失败都说成「保存失败」。
 */
export class SlideImageTooLargeError extends Error {
  readonly hint: string;
  constructor(readonly byteSize: number) {
    const mb = (byteSize / (1024 * 1024)).toFixed(1);
    const limitMb = Math.round(MAX_SLIDE_IMAGE_BYTES / (1024 * 1024));
    super(`这张图片 ${mb} MB，超过了 ${limitMb} MB 的上限`);
    this.name = 'SlideImageTooLargeError';
    this.hint =
      `截图或照片通常不必这么大。可以先压缩到 ${limitMb}MB 以内再插进来；` +
      'Windows 自带的「画图」打开后另存为 PNG 就能小很多，' +
      '或者用微信/QQ 发一次给自己，它也会自动压缩。';
  }
}

/**
 * data URL 的实际字节数。
 *
 * 不能直接用 `input.imageData.length`：那是 base64 **字符**数，
 * 比真实字节多约 33%。拿字符数当字节数会把上限算松 1/3，
 * 也可能让「刚好卡在边界」的图被误判成超限。
 *
 * 算法：去掉 `data:...;base64,` 前缀，剩下的 base64 字符数 × 3/4，
 * 再减去末尾填充（'=' 的个数）。
 */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;

  const payload = dataUrl.slice(comma + 1);
  if (payload.length === 0) return 0;

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

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
  /**
   * 生成语言，默认 zh
   */
  language?: 'zh' | 'en';
  /**
   * 用户对这份 PPT 的额外要求（自由输入）。
   *
   * **有值时走自由模式**：由模型决定页面结构。
   * **没值时走固定模板**：结构由 template.ts 定死（封面 → 章节页 → 要点页 → 总结页），
   * 模型只写每条知识点的文字和总结。这样「什么都不填」时得到的是
   * 稳定可预期的版式，而不是每次跑出来都不一样的东西。
   */
  instruction?: string;
  /** 取消信号（用户在生成中途点了停止） */
  signal?: AbortSignal;
  /** 配色主题 id（见 theme.ts）。不传用默认主题 */
  theme?: string;
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
  /**
   * 这次用的哪种结构模式。
   *
   * `template` = 用户没写要求，走了固定版式（可预期）；
   * `free` = 用户写了要求，模型自己组织结构。
   * 界面据此告诉用户「你看到的是默认版式还是按你要求定制的」。
   */
  mode: 'template' | 'free';
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
    return buildRenderPlan(deck, deck.title, { images: await this.imagesOf(deck) });
  }

  /**
   * 收集这份 PPT 用到的图片。
   *
   * 只读被 overlay 引用到的那些，不是把整个 slideImages 分区全拉出来 ——
   * 库里可能存着几百张图，而这一份 PPT 只用了两张。
   */
  private async imagesOf(deck: SlideDeck): Promise<Map<string, SlideImageRecord>> {
    const map = new Map<string, SlideImageRecord>();
    for (const id of collectImageIds(deck)) {
      const img = await this.storage.get('slideImages', id);
      if (img) map.set(id, img);
    }
    return map;
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

    /**
     * 模式判定：用户没写要求 → 固定模板（可预期）；写了 → 自由模式（按你说的做）。
     *
     * 这个分叉是这一版的核心决定。用户不填任何东西时，最不该发生的事
     * 是「每次跑出来的页数和结构都不一样」—— 那让人无法预期，也无法复用。
     */
    const instruction = (input.instruction ?? '').trim();
    const mode: 'template' | 'free' = instruction ? 'free' : 'template';

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
        const aiResult =
          mode === 'template'
            ? await this.generateWithTemplate(input, {
                deckTitle,
                sourceTitle,
                sourceTitles,
              })
            : await this.generateWithAi(input, {
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
          aiFailure = '模型返回的内容是空的（可能内容太少，或返回格式不对）';
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
      // 未知 id 退回默认：宁可配色退化，也不让整份 PPT 建不出来
      theme: resolveTheme(input.theme).id,
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
      mode,
      ...(aiFailure ? { aiFailure } : {}),
      tokens,
    };
  }

  /**
   * 走固定模板：结构由 template.ts 定死，模型只写内容。
   *
   * 返回 null 表示「没产出可用内容」，由调用方回退。
   */
  private async generateWithTemplate(
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

    const usable = input.points.filter((p) => p.statement?.trim());
    if (usable.length === 0) return null;

    const language = input.language ?? 'zh';
    const aiPoints = usable.map((p) => toAiPoint(p));

    /**
     * 后端没实现 generateForTemplate 时退回自由模式。
     *
     * 这不是理想的降级（版式会变得不可预期），但比什么都不产出强；
     * 而且 ModelOutlineBackend 已经实现了它，正常路径不会走到这里。
     */
    if (!backend.generateForTemplate) {
      return this.generateWithAi(input, ctx);
    }

    const plan = planTemplate(usable);

    const result = await backend.generateForTemplate(aiPoints, {
      title: ctx.deckTitle,
      sourceTitle: ctx.sourceTitle,
      maxPages: Math.max(1, Math.ceil(usable.length / 5) + 2),
      language,
      signal: input.signal ?? new AbortController().signal,
    });

    if (result.items.length === 0) return null;

    // 角标：与自由模式同一套规则，位置从知识点 anchors 继承
    const { citations, citationOf, bulletsWithoutCitation } = buildCitations(
      usable,
      ctx.sourceTitle,
      ctx.sourceTitles,
    );

    const content = new Map<string, TemplateContentItem>();
    let droppedBullets = 0;
    const knownIds = new Set(usable.map((p) => p.id));

    for (const item of result.items) {
      if (!knownIds.has(item.fromPointId)) {
        droppedBullets += 1;
        continue;
      }
      content.set(item.fromPointId, item);
    }

    if (content.size === 0) return null;

    const pages = assembleTemplate({
      plan,
      content,
      summary: result.summary,
      deckTitle: ctx.deckTitle,
      sourceTitle: ctx.sourceTitle,
      citationOf,
    });

    if (pages.length <= 1) return null;

    // 统计「有内容但没有角标」的条数（用于界面如实告知）
    let withoutCitation = 0;
    for (const page of pages) {
      for (const b of page.bullets) {
        if (b.citationIndex === null) withoutCitation += 1;
      }
    }

    return {
      pages,
      citations,
      bulletsWithoutCitation: withoutCitation || bulletsWithoutCitation,
      droppedBullets,
      tokens: result.actualTokens,
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

  /**
   * 换配色主题。
   *
   * 刻意**不动内容**：换的是渲染时取的那套色值，页面结构、要点、
   * 角标全部原样保留。所以这个操作可以随便点，不会弄丢已写好的东西。
   *
   * 未知 id 退回默认而不是抛错：用户从别处粘一个 id 过来、
   * 或者备份来自装了更多主题的版本，都不该让这份 PPT 打不开。
   */
  async setTheme(id: string, themeId: string): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      deck.theme = resolveTheme(themeId).id;
    });
  }

  // -------------------------------------------------------------------------
  // 叠加内容（自由摆放的图片 / 文本框）
  // -------------------------------------------------------------------------

  /**
   * 保存一张图片并返回它的 id。
   *
   * 图片单独存 `slideImages` 分区，页面里只留 id。同一张图被多页引用时
   * 只存一份 —— 内嵌进 deck 会让记录成倍变大，IndexedDB 单条有大小风险。
   *
   * ## 为什么在这里拦大小
   *
   * 拦在写入口而不是拦在界面：界面有好几个入口（拖拽编辑器、以后的
   * 粘贴、批量导入），每个都写一遍判断迟早漏一个，而漏掉的那个
   * 会直接把几十 MB 塞进 IndexedDB。写入之后才发现要清理，
   * 还要处理「已经进库了但删不干净」的麻烦。
   *
   * 超限时抛错而不是静默缩小：静默压缩会让用户以为原图存进去了，
   * 导出后才发现糊了。宁可当场拒绝并说明怎么处理。
   */
  async addImage(input: {
    imageData: string;
    width: number;
    height: number;
  }): Promise<string> {
    const byteSize = estimateDataUrlBytes(input.imageData);

    if (byteSize > MAX_SLIDE_IMAGE_BYTES) {
      throw new SlideImageTooLargeError(byteSize);
    }

    const id = newId('img');
    await this.storage.put('slideImages', {
      id,
      imageData: input.imageData,
      width: input.width,
      height: input.height,
      byteSize,
      createdAt: nowIso(),
    });
    return id;
  }

  /** 取一张图片；不存在时返回 null（渲染层据此跳过，不画坏图） */
  async getImage(id: string): Promise<SlideImageRecord | null> {
    return this.storage.get('slideImages', id);
  }

  /**
   * 往某一页加一块叠加内容。
   *
   * 坐标一律 0~1 比例，不是像素 —— 见 model.ts 里 SlideOverlay 的注释。
   */
  async addOverlay(
    id: string,
    pageId: string,
    overlay: Omit<SlideOverlay, 'id' | 'z'> & { z?: number },
  ): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page) return;
      const list = page.overlays ?? (page.overlays = []);
      list.push({
        ...overlay,
        id: newId('ov'),
        // 不指定就放到最上层：用户刚加的东西应该在看得见的地方
        z: overlay.z ?? list.length,
      });
    });
  }

  /** 移动/缩放一块叠加内容 */
  async updateOverlay(
    id: string,
    pageId: string,
    overlayId: string,
    patch: Partial<Pick<SlideOverlay, 'x' | 'y' | 'w' | 'h' | 'z' | 'text' | 'fontSize' | 'color'>>,
  ): Promise<SlideDeck> {
    return this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      const ov = page?.overlays?.find((o) => o.id === overlayId);
      if (!ov) return;
      Object.assign(ov, patch);
    });
  }

  /** 删掉一块叠加内容 */
  /**
   * 删掉一块叠加内容。
   *
   * 如果删的是图片、且这张图不再被任何页引用，就把它从 `slideImages`
   * 里也删掉 —— 否则用户反复「插入 → 删掉」，库里会堆一串没人引用的图，
   * 而且它们还会跟着进备份。
   *
   * 顺序：先改 deck（落库），再删图。反过来的话中途失败会留下
   * 「页面上还有这块、图却没了」，那是可见的空框。
   */
  async removeOverlay(id: string, pageId: string, overlayId: string): Promise<SlideDeck> {
    const target = (await this.get(id))?.pages
      .find((p) => p.id === pageId)
      ?.overlays?.find((o) => o.id === overlayId);

    const next = await this.mutate(id, (deck) => {
      const page = deck.pages.find((p) => p.id === pageId);
      if (!page?.overlays) return;
      page.overlays = page.overlays.filter((o) => o.id !== overlayId);
    });

    // deck 已落库，现在安全地清理不再被引用的图
    if (target?.kind === 'image' && target.imageId) {
      if (!collectImageIds(next).has(target.imageId)) {
        await this.storage.remove('slideImages', target.imageId);
      }
    }

    return next;
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
   *
   * @param options.includeSources 是否追加「资料来源」页，默认 true
   */
  async export(id: string, options: { includeSources?: boolean } = {}): Promise<ExportOutcome> {
    const deck = await this.get(id);
    if (!deck) throw new Error('这份 PPT 已经不存在了，可能在另一个窗口被删除。');

    if (deck.pages.length <= 1) {
      throw new Error('大纲里只有封面页，没有可导出的内容。请先加点内容。');
    }

    // 序号 = 已有导出次数 + 1。第 1 次导出是「第1版」
    const ordinal = deck.exports.length + 1;
    const at = new Date();
    /**
     * 图片必须在导出时读好传进去。
     *
     * 不传的话叠加的图片会被静默跳过（render-plan 取不到图就跳过该项），
     * 结果就是「预览里有图、导出的文件里没有」—— 又是一个只有
     * 真打开文件才发现的缺陷。
     */
    const result = await exportToPptx(deck, ordinal, {
      ...options,
      images: await this.imagesOf(deck),
    });
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

  /**
   * 删除整份 PPT，并清理它引用的图片。
   *
   * ## 为什么必须一起清理
   *
   * 图片单独存在 `slideImages` 里，delete 掉 deck 之后那些图就成了
   * 没人引用的孤儿：界面上再也看不到它们，却永远占着空间，
   * 而且**还会跟着进备份**——用户的备份文件会因为这个越变越大，
   * 而他找不到原因（PPT 已经删了）。
   *
   * 顺序是**先删 deck 再删图**：反过来的话，中途失败会留下
   * 「deck 还在、图没了」，那是可见的坏数据（页面上的图变成空框）。
   * 先删 deck 则最坏是「deck 没了、图还在」，用户看不见，下次清理还能扫到。
   */
  async remove(id: string): Promise<void> {
    const deck = await this.get(id);
    await this.storage.remove('slideDecks', id);

    if (!deck) return;
    for (const imageId of collectImageIds(deck)) {
      await this.storage.remove('slideImages', imageId);
    }
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
 * 收集一份 PPT 引用到的全部图片 id。
 *
 * 抽成函数是因为删除 PPT、删单块 overlay 都要用它，
 * 两处各写一遍「遍历 pages → overlays → imageId」迟早漏一处。
 */
export function collectImageIds(deck: SlideDeck): Set<string> {
  const ids = new Set<string>();
  for (const page of deck.pages) {
    for (const ov of page.overlays ?? []) {
      if (ov.kind === 'image' && ov.imageId) ids.add(ov.imageId);
    }
  }
  return ids;
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

/**
 * 把知识点转成送给模型的形状。
 *
 * 两种生成模式（固定模板 / 自由）共用，保证送给模型的信息一致 ——
 * 否则两条路径产出的内容风格会不一样，用户换模式时会觉得像两个功能。
 */
function toAiPoint(p: KnowledgePoint): OutlineInputPoint {
  return {
    id: p.id,
    statement: p.statement,
    quotes: p.quotes,
    chapter: p.chapter,
    page: p.anchors[0]?.page ?? null,
    cognitiveLevel: p.cognitiveLevel,
  };
}

/**
 * 建角标表，并返回「知识点 → 角标编号」的查询函数。
 *
 * 这是整个 PPT 功能最要紧的一段：位置只从知识点已验证的 anchors 继承，
 * 绝不在这里推算。两种生成模式共用它，避免各写一份而走样。
 */
function buildCitations(
  points: KnowledgePoint[],
  sourceTitle: string,
  sourceTitles: Map<string, string>,
): {
  citations: SlideCitation[];
  citationOf: (point: KnowledgePoint) => number | null;
  bulletsWithoutCitation: number;
} {
  const citations: SlideCitation[] = [];
  const byPoint = new Map<string, number>();
  let bulletsWithoutCitation = 0;

  const citationOf = (point: KnowledgePoint): number | null => {
    const existing = byPoint.get(point.id);
    if (existing !== undefined) return existing;

    // 定位失败/被豁免 → 不建角标（不给假角标）
    if (point.anchorStatus !== 'located') {
      bulletsWithoutCitation += 1;
      return null;
    }
    const anchor = point.anchors[0];
    if (!anchor) {
      bulletsWithoutCitation += 1;
      return null;
    }

    const citation: SlideCitation = {
      index: citations.length + 1,
      knowledgePointId: point.id,
      sourceId: anchor.sourceId || point.sourceId || '',
      sourceTitle: sourceTitles.get(anchor.sourceId) ?? sourceTitle,
      page: anchor.page ?? null,
      chapter: anchor.chapter ?? point.chapter,
      quote: point.quotes[0] ?? '',
    };
    citations.push(citation);
    byPoint.set(point.id, citation.index);
    return citation.index;
  };

  // 预先为所有知识点建号，顺序按传入顺序（= 原文页码顺序）
  for (const p of points) citationOf(p);

  return { citations, citationOf, bulletsWithoutCitation };
}
