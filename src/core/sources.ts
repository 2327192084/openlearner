import { newId, nowIso } from './id.ts';
import type { Course, Source, SourceImageRecord, SourceSegment } from './model.ts';
import type { TrashService } from './trash.ts';
import { kindFromFileName, parseAny, titleFromFileName } from './parsers/index.ts';
import { ImportError, importError } from './parsers/types.ts';
import type { ImportFailureCode } from './parsers/types.ts';
import type { StorageAdapter } from './storage/types.ts';
import type { FigureStorage } from './mineru/images.ts';

/**
 * 资料服务：导入、列表、阅读、搜索、删除。
 *
 * 这一层是 P2 之后所有功能的地基（计划书：「这一层是全项目地基，
 * P2 之后所有功能都吃它的切分与位置信息，这里不准，后面全都歪」）。
 * 所以两条铁律：
 *  1. 位置信息只能来自解析器实测的页码，**任何情况下不猜**；
 *  2. 删除必须级联清理，不留孤儿 segment（否则会永远占着空间还搜得到）。
 */

/** 单次导入的结果 */
export interface ImportOutcome {
  fileName: string;
  ok: boolean;
  source?: Source;
  /** 失败时一定有 code 与 hint —— 界面不允许只显示「失败」 */
  failure?: { code: ImportFailureCode; message: string; hint: string };
}

/** 全文搜索命中的一处位置 */
export interface SearchHit {
  segmentId: string;
  page: number;
  chapter: string | null;
  /** 命中位置在该段文本内的字符偏移（左闭右开） */
  charStart: number;
  charEnd: number;
  /** 用于列表预览的上下文片段（前后各约 30 字） */
  snippet: string;
}

/**
 * 整篇替换分段时，调用方给的一段正文。
 *
 * 刻意**不含 id / index / charCount**：这三项由 writeSegments 推导，
 * 调用方只需说清「这一段的正文是什么、对应哪一页」。
 */
export interface WriteSegmentInput {
  /** 页码，从 1 开始 */
  page: number;
  /** 所属章节，没有则 null */
  chapter?: string | null;
  /** 正文 */
  text: string;
}

/**
 * 保留原始文件字节的大小上限。
 *
 * 超了就不存（fileStored=false），图文页入口在界面上如实关闭。
 * 为什么不设成「无上限」：IndexedDB 存得下，但备份、重建索引、
 * 换机器时的写放大都会变慢，而用户对「点了没反应」的容忍度远低于
 * 「这个功能这份资料用不了，因为文件太大」。
 */
export const MAX_STORED_FILE_BYTES = 60 * 1024 * 1024;

/** 按课程分组的资料 */
export interface CourseGroup {
  course: Course | null;
  sources: Source[];
}

export class SourceService {
  /**
   * @param trash 回收站（2026-11-08）。删除资料时把记录收进去，能还原。
   *   不传则退化成不可恢复的删除 —— 但生产代码里都传，测试也建议传，
   *   否则测不到「还原」这条路径。
   */
  constructor(
    private readonly storage: StorageAdapter,
    private readonly trash?: TrashService,
  ) {}

  /**
   * 导入一批文件。
   *
   * 逐份处理，**单份失败不影响其他份** —— 学生一次拖 5 个课件进来，
   * 其中 1 个是扫描件或坏文件时，不该让另外 4 个也白等。
   * 返回逐份的结果，由界面逐条显示。
   */
  async importFiles(
    files: File[],
    opts: {
      courseId?: string | null;
      onProgress?: (done: number, total: number, current: string) => void;
    } = {},
  ): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      opts.onProgress?.(i, files.length, file.name);

      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        const source = await this.importBuffer(file.name, buffer, {
          courseId: opts.courseId ?? null,
          byteSize: file.size,
        });
        outcomes.push({ fileName: file.name, ok: true, source });
      } catch (err) {
        outcomes.push(toFailure(file.name, err));
      }
    }

    opts.onProgress?.(files.length, files.length, '');
    return outcomes;
  }

  /**
   * 从字节导入一份资料（文件名已知）。
   * 与 importFiles 共用，便于测试不依赖浏览器 File。
   */
  async importBuffer(
    fileName: string,
    data: Uint8Array,
    opts: { courseId?: string | null; byteSize?: number; title?: string } = {},
  ): Promise<Source> {
    /**
     * 必须在解析之前把原始字节拷走。
     *
     * pdfjs 的 `getDocument({data})` 会把这个 ArrayBuffer **转移（detach）**走，
     * 解析结束后传入的 `data.byteLength` 变成 0。所以「先解析、后存原始字节」
     * 的顺序下永远只能存到一块空 buffer —— 而 storeOriginalFile 里的
     * `copy.set(data)` 会抛 TypeError 被降级成 fileStored=false，
     * 表现是「任何 PDF 导入后图文页入口都置灰」。
     *
     * 只有 PDF 和图片需要留字节：
     *  - PDF：图文页与 OCR 要拿它重新渲染某一页；
     *  - 图片：本身就是要显示的那张图，不留字节就只剩一条空记录。
     *
     * docx/pptx/md/txt 不留：它们的文字已经切进分段了，
     * 留着整份原文件只是白占配额。
     */
    const kind = kindFromFileName(fileName);
    const original =
      (kind === 'pdf' || kind === 'image') && data.byteLength <= MAX_STORED_FILE_BYTES
        ? new Uint8Array(data)
        : null;

    const parsed = await parseAny(fileName, data);

    const ts = nowIso();
    const sourceId = newId('source');

    // 段与资料必须一起写。半途失败留下「有资料没正文」的记录，
    // 阅读器点开会空白，用户会以为文件坏了。
    const segments: SourceSegment[] = parsed.segments.map((seg) => ({
      id: newId('seg'),
      sourceId,
      index: seg.index,
      page: seg.page,
      chapter: seg.chapter,
      text: seg.text,
      charCount: seg.text.length,
    }));

    const source: Source = {
      id: sourceId,
      title: opts.title?.trim() || parsed.title || titleFromFileName(fileName),
      fileName,
      kind: kindFromFileName(fileName),
      courseId: opts.courseId ?? null,
      pageCount: parsed.pageCount,
      byteSize: opts.byteSize ?? data.byteLength,
      textStatus: parsed.textStatus,
      segmentCount: segments.length,
      fileStored: false,
      createdAt: ts,
      updatedAt: ts,
    };

    // 原始字节只对 PDF 留：图文页要用 pdfjs 重新渲染某一页，
    // 而 docx/pptx/md 的页面布局由 Office/浏览器实时排版，没有「原页」可渲染。
    if (original) await this.storeOriginalFile(source, original);

    // 先写段再写资料：万一中途失败，是「有段没资料」（不可见、可被清理），
    // 而不是「有资料没段」（可见但点开是空的，最糟的用户体验）
    await this.storage.putMany('sourceSegments', segments);
    await this.storage.put('sources', source);

    return source;
  }

  /** 把一段粘贴的文字存成资料 */
  async importText(
    title: string,
    text: string,
    opts: { courseId?: string | null } = {},
  ): Promise<Source> {
    if (!text.trim()) {
      throw importError('empty', '粘贴的内容是空的');
    }

    const data = new TextEncoder().encode(text);
    const safeTitle = title.trim() || '粘贴的资料';

    const parsed = await parseAny(`${safeTitle}.txt`, data);

    const ts = nowIso();
    const sourceId = newId('source');
    const segments: SourceSegment[] = parsed.segments.map((seg) => ({
      id: newId('seg'),
      sourceId,
      index: seg.index,
      page: seg.page,
      chapter: seg.chapter,
      text: seg.text,
      charCount: seg.text.length,
    }));

    const source: Source = {
      id: sourceId,
      title: safeTitle,
      fileName: null,
      kind: 'text',
      courseId: opts.courseId ?? null,
      pageCount: parsed.pageCount,
      byteSize: data.byteLength,
      textStatus: parsed.textStatus,
      segmentCount: segments.length,
      fileStored: false,
      createdAt: ts,
      updatedAt: ts,
    };

    await this.storage.putMany('sourceSegments', segments);
    await this.storage.put('sources', source);

    return source;
  }

  /**
   * 保存原始文件字节（仅 PDF，仅限大小上限内）。
   *
   * 返回是否真的存下了，调用方据此设置 Source.fileStored。
   * 存不下不是错误：图文页用不了而已，不该让整次导入失败。
   */
  private async storeOriginalFile(source: Source, data: Uint8Array): Promise<boolean> {
    if (source.kind !== 'pdf') return false;
    if (data.byteLength > MAX_STORED_FILE_BYTES) return false;
    // 调用方（importBuffer）已经在解析前复制过一份独立 buffer，
    // 这里如果还是 detached/空数组，说明上游逻辑出了问题，别静默写进去
    if (data.byteLength === 0) {
      source.fileStored = false;
      return false;
    }

    try {
      /**
       * 存一份「刚好只包含这段字节」的 ArrayBuffer。
       *
       * 传进来的 Uint8Array 可能只是别人大 buffer 的一个视图（byteOffset 不为 0），
       * 直接存 `data.buffer` 会把整块内存连带存进去 —— 例如从 200MB 的
       * 上传缓冲里切出的 90KB PDF，会把 200MB 塞进 IndexedDB。
       * 所以这里再复制一次，只留视图范围内的字节。
       *
       * `as ArrayBuffer`：`new Uint8Array()` 分配的一定是独立 ArrayBuffer，
       * 不是 SharedArrayBuffer，这里 TS 的 ArrayBufferLike 宽类型需要收窄。
       */
      const exact = new Uint8Array(data);
      await this.storage.put('sourceFiles', {
        id: source.id,
        data: exact.buffer as ArrayBuffer,
        byteSize: exact.byteLength,
        savedAt: nowIso(),
      });
      source.fileStored = true;
      return true;
    } catch (err) {
      /**
       * 配额满之类：降级为「没有原始文件」，导入本身仍然成功。
       *
       * 但**必须留下日志**：早先这里是空 catch，结果是「所有 PDF 都存不下
       * 原始字节、图文页入口永远置灰」，而排查时没有任何线索 —— 花二十分钟
       * 才定位到 pdfjs 转移 buffer。降级可以，无声降级不行。
       */
      console.warn('[sources] 原始文件没有存下，图文页将不可用：', err);
      source.fileStored = false;
      return false;
    }
  }

  /** 取原始字节，没有就返回 null（旧资料、超限文件、非 PDF 都会是 null） */
  async getOriginalFile(sourceId: string): Promise<Uint8Array | null> {
    const rec = await this.storage.get('sourceFiles', sourceId);
    if (!rec) return null;
    return new Uint8Array(rec.data);
  }

  async hasOriginalFile(sourceId: string): Promise<boolean> {
    const rec = await this.storage.get('sourceFiles', sourceId);
    return rec !== null;
  }

  /**
   * 交给取图编排用的**最小存储视图**（只读 + 写图所需的三件事）。
   *
   * 为什么不直接把 storage 设成 public：那等于把整库写权限
   * （包括 secrets 分区）暴露给界面层。这里只放行取图真正用到的
   * `getAll` / `remove` / `putMany`，且调用方只能碰分区名，
   * 不会顺手改到资料本身。
   */
  get figuresStorage(): FigureStorage {
    return this.storage;
  }

  /**
   * 取这份资料正文里的插图（按页 + 位置排好序）。
   *
   * 一次全取再过滤，不做按页索引：一份 36 页教材才 88 张图，
   * 几十毫秒的事。加索引要动库版本，收益要等 628 页的书真的卡了再说。
   */
  async getFigures(sourceId: string): Promise<SourceImageRecord[]> {
    const all = await this.storage.getAll('sourceImages');
    return all
      .filter((r) => r.sourceId === sourceId)
      .sort((a, b) =>
        a.page !== b.page ? a.page - b.page : a.charOffset - b.charOffset,
      );
  }

  /** 取某一页的插图（阅读器翻页时只渲染这一页） */
  async getPageFigures(sourceId: string, page: number): Promise<SourceImageRecord[]> {
    const all = await this.getFigures(sourceId);
    return all.filter((r) => r.page === page);
  }

  /**
   * 存一批插图（覆盖式）。
   *
   * 先清这份资料的旧图再写新的：重转后 block 编号可能变
   * （换了 tier、或 MinerU 版面模型升级），只按 id 覆盖会留下一批
   * charOffset 已经过期的孤儿记录 —— 那些记录会让图片插到错误位置。
   */
  async writeFigures(sourceId: string, figures: SourceImageRecord[]): Promise<void> {
    const old = await this.storage.getAll('sourceImages');
    for (const rec of old) {
      if (rec.sourceId === sourceId) await this.storage.remove('sourceImages', rec.id);
    }
    if (figures.length > 0) await this.storage.putMany('sourceImages', figures);
  }

  async list(): Promise<Source[]> {
    const all = await this.storage.getAll('sources');
    return all.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async get(id: string): Promise<Source | null> {
    return this.storage.get('sources', id);
  }

  /** 取某份资料的全部段，按 index 升序 */
  async getSegments(sourceId: string): Promise<SourceSegment[]> {
    const all = await this.storage.getAll('sourceSegments');
    return all
      .filter((s) => s.sourceId === sourceId)
      .sort((a, b) => a.index - b.index);
  }

  /**
   * 按课程分组。
   *
   * 未归类的资料单独成组（course: null），组名由界面写「未分类」。
   * 空课程（没有任何资料）也保留 —— 用户刚建完课程时应该能看到它，
   * 否则会以为没建成功。这是 P1「按课程分组」的完整语义。
   */
  async listByCourse(): Promise<CourseGroup[]> {
    const [courses, sources] = await Promise.all([
      this.storage.getAll('courses'),
      this.list(),
    ]);

    const byCourse = new Map<string | null, Source[]>();
    for (const course of courses) byCourse.set(course.id, []);
    byCourse.set(null, []);

    for (const source of sources) {
      const key = source.courseId && byCourse.has(source.courseId) ? source.courseId : null;
      byCourse.get(key)!.push(source);
    }

    const groups: CourseGroup[] = [];
    for (const course of courses.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      groups.push({ course, sources: byCourse.get(course.id)! });
    }

    const unclassified = byCourse.get(null)!;
    // 空组只在没有课程时才显示，避免界面上挂一个空的「未分类」
    if (unclassified.length > 0 || courses.length === 0) {
      groups.push({ course: null, sources: unclassified });
    }

    return groups;
  }

  /**
   * 删除资料，并级联清理它的全部段。
   *
   * 顺序是**先删段再删资料**：
   * 反过来的话，如果中途失败，会留下「有段没资料」的孤儿段 ——
   * 它们不会被任何界面显示，却永远占空间、还能被搜索到。
   * 先删段则最坏是「有资料没段」，界面会显示 0 页，用户能再删一次。
   */
  async remove(id: string): Promise<void> {
    const source = await this.storage.get('sources', id);
    const segments = await this.getSegments(id);

    /*
     * 手写注释按 `${sourceId}:${page}` 存，只能扫一遍。
     * 不删会留下孤儿：界面看不到，却占空间、跟着备份走；
     * 更糟的是以后导入一份 id 相同的资料（从备份恢复就会），
     * 那些旧注释会突然冒出来挂在用户没标注过的资料上。
     */
    const annotations = (await this.storage.getAll('sourceAnnotations')).filter(
      (a) => a.sourceId === id,
    );

    /*
     * 插图（2026-11-08）：二进制，删资料必须级联清掉，
     * 否则几十 MB 静默占着配额，界面上完全看不到。
     */
    const figures = (await this.storage.getAll('sourceImages')).filter(
      (f) => f.sourceId === id,
    );

    /*
     * 先收进回收站（2026-11-08），再真删除。
     *
     * 收什么：资料本身 + 正文段 + 注释。
     * 不收什么：原始 PDF 与插图 —— 它们是二进制，几十 MB，
     *   塞进回收站会让库膨胀几倍，而两者都能重新生成
     *   （PDF 用户手里有原文件；插图能从 PDF 重新裁）。
     *   但**如实记进 skipped**，列表里会说清楚还原后缺什么，不静默丢。
     */
    if (this.trash && source) {
      const byteNote =
        source.byteSize > 0 ? `${Math.round(source.byteSize / 1024 / 1024)} MB` : '';
      const skipped: Array<{ what: string; reason: string }> = [];
      if (await this.hasOriginalFile(id)) {
        skipped.push({
          what: `原始文件${byteNote ? `（${byteNote}）` : ''}`,
          reason: '太大，不进回收站。还原后需要重新导入这份文件',
        });
      }
      if (figures.length > 0) {
        skipped.push({
          what: `${figures.length} 张插图`,
          reason: '图片体积大，不进回收站。还原后重新转换一次即可补回',
        });
      }

      await this.trash.moveToTrash(
        [
          {
            kind: 'sources',
            title: source.title,
            summary: `${source.pageCount ?? 0} 页 · ${segments.length} 段`,
            payload: source,
          },
          ...segments.map((s) => ({
            kind: 'sourceSegments' as const,
            title: '',
            summary: '',
            payload: s,
          })),
          ...annotations.map((a) => ({
            kind: 'sourceAnnotations' as const,
            title: '',
            summary: '',
            payload: a,
          })),
        ],
        skipped,
      );
    }

    /*
     * 顺序是**先删段再删资料**：
     * 反过来的话，中途失败会留下「有段没资料」的孤儿段 ——
     * 不会被任何界面显示，却永远占空间、还能被搜索到。
     * 先删段则最坏是「有资料没段」，界面显示 0 页，用户能再删一次。
     */
    for (const seg of segments) {
      await this.storage.remove('sourceSegments', seg.id);
    }
    // 原始字节也要跟着删，否则删掉资料后几十 MB 还占着配额，用户看不到也清不掉
    await this.storage.remove('sourceFiles', id);

    for (const a of annotations) {
      await this.storage.remove('sourceAnnotations', a.id);
    }

    for (const f of figures) {
      await this.storage.remove('sourceImages', f.id);
    }

    await this.storage.remove('sources', id);
  }

  /** 改标题 / 换课程 */
  async update(
    id: string,
    patch: { title?: string; courseId?: string | null },
  ): Promise<Source | null> {
    const existing = await this.storage.get('sources', id);
    if (!existing) return null;

    const next: Source = {
      ...existing,
      title: patch.title?.trim() || existing.title,
      courseId: patch.courseId !== undefined ? patch.courseId : existing.courseId,
      updatedAt: nowIso(),
    };
    await this.storage.put('sources', next);
    return next;
  }

  /**
   * 整篇替换分段（OCR 写回用）。
   *
   * ## 为什么不放在 OcrService 里自己写
   *
   * 分段的几项不变量 —— `id` 怎么来的、`index` 从 1 连续、`charCount`
   * 等于正文长度、资料的 `segmentCount` 跟着变、`updatedAt` 刷新 ——
   * 都由 sources 独占维护。OCR 若绕过这里直接写 `sourceSegments`，
   * 就是同一套规矩的第二个维护点，迟早不一致（而 `segmentCount`
   * 一旦对不上，列表页的「N 段」和点开看到的段数会不一样）。
   *
   * ## 为什么必须先删旧段
   *
   * 扫描件原本是「每页一段、正文为空」。OCR 之后页数可能变（生成更多段），
   * 只 `putMany` 新段会留下旧段里那些空记录，用户点开原文会看到
   * 前几页是空的、后面突然有字。所以删干净再写。
   *
   * 顺序是**先删后写**，和 `remove()` 一致：最坏是「有资料没段」，
   * 界面会显示 0 段、可以重跑一次 OCR；反过来则是脏数据被当成正常。
   */
  async writeSegments(
    sourceId: string,
    segments: readonly WriteSegmentInput[],
    textStatus: Source['textStatus'],
  ): Promise<{ source: Source; segments: SourceSegment[] } | null> {
    const existing = await this.storage.get('sources', sourceId);
    if (!existing) return null;

    const ts = nowIso();

    /**
     * 按数组顺序重新编号，而不是信任调用方给的 index。
     *
     * OCR 是按页顺序产出的，只要顺序对，编号就该由这里决定 ——
     * 让调用方自己填 `index: pageNo` 会在「跳过空白页」时留下空洞。
     */
    const next: SourceSegment[] = segments.map((seg, i) => ({
      id: newId('seg'),
      sourceId,
      index: i + 1,
      page: seg.page,
      chapter: seg.chapter ?? null,
      text: seg.text,
      charCount: seg.text.length,
    }));

    // 先删旧段：只覆盖不删除会留下超出新段数的空段
    const old = await this.getSegments(sourceId);
    for (const seg of old) {
      await this.storage.remove('sourceSegments', seg.id);
    }

    await this.storage.putMany('sourceSegments', next);

    const source: Source = {
      ...existing,
      textStatus,
      segmentCount: next.length,
      updatedAt: ts,
    };
    await this.storage.put('sources', source);

    return { source, segments: next };
  }

  /**
   * 用保留下来的原始文件重建这份资料的分段。
   *
   * ## 为什么需要它
   *
   * 分段可能因为缺陷而少于真实页数（曾出过：628 页的扫描件被 OCR 写成 2 段，
   * 其余 626 页翻不回去）。原始字节还在，就能重新解析还原，
   * 不必让用户删掉重导 —— 重导会丢掉已有知识点与题目的引用。
   *
   * ## 只对有原始文件的资料可用
   *
   * 只有 PDF 与图片会保留原始字节（见 importBuffer 的注释）。
   * docx/pptx/txt 不留，所以它们没法这样重建 —— 返回 ok:false 并说明原因，
   * 而不是假装成功。
   *
   * @returns 重建结果；`rebuilt` 为 false 时带原因
   */
  async rebuildSegments(sourceId: string): Promise<
    | { ok: true; source: Source; segments: SourceSegment[]; pageCount: number }
    | { ok: false; reason: string; hint: string }
  > {
    const existing = await this.storage.get('sources', sourceId);
    if (!existing) {
      return {
        ok: false,
        reason: '这份资料已经不在了',
        hint: '可能已在另一个窗口被删除。刷新页面看看列表里还有没有它。',
      };
    }

    const bytes = await this.getOriginalFile(sourceId);
    if (!bytes || bytes.byteLength === 0) {
      return {
        ok: false,
        reason: `「${existing.title}」没有保留原始文件，无法重建正文`,
        hint:
          '只有 PDF 和图片会保留原始字节。其它格式请重新导入一份 —— ' +
          '重导会换成新资料，已有的知识点与题目需要重新关联。',
      };
    }

    let parsed;
    try {
      parsed = await parseAny(existing.fileName ?? existing.title, bytes);
    } catch (err) {
      return {
        ok: false,
        reason: '重新解析这份文件失败了',
        hint:
          err instanceof ImportError
            ? err.hint
            : '文件可能已损坏。可以删掉这份资料后重新导入。',
      };
    }

    /**
     * 重建用整份替换是**正确**的：这里的目标就是把分段恢复成文件的真实样子。
     * 与 OCR 的局部写回不同 —— 那里必须保页，这里必须还原页。
     */
    const written = parsed.segments.map((s) => ({
      page: s.page,
      chapter: s.chapter,
      text: s.text,
    }));

    const saved = await this.writeSegments(sourceId, written, parsed.textStatus);
    if (!saved) {
      return {
        ok: false,
        reason: '重建过程中资料消失了',
        hint: '请刷新页面确认这份资料还在。',
      };
    }

    // 解析器给的 pageCount 更可信（来源文件本身），一并修正
    const source: Source = {
      ...saved.source,
      pageCount: parsed.pageCount,
      updatedAt: nowIso(),
    };
    await this.storage.put('sources', source);

    return { ok: true, source, segments: saved.segments, pageCount: parsed.pageCount };
  }

  /**
   * 按页合并正文，**不删除未被涉及的页**。
   *
   * 为什么需要它（与 writeSegments 的区别）：
   *
   * `writeSegments` 是整份替换 —— 它会先删光这份资料的所有旧段。
   * 那适合「重新解析整份文件」，但**不适合 OCR 的局部识别**：
   * 用户点「只识别第 1 页」看效果时，628 页的资料会被压成 1 段，
   * 其余 627 页的页码与目录全部消失，再也翻不回去。这是数据损失。
   *
   * 合并规则：
   *  - 传入的页覆盖同页原文（识别结果替换原先的空正文）；
   *  - 未涉及的页**原样保留**（扫描件落地时每页都有一段空正文占位，
   *    所以页码与顺序不会丢）；
   *  - 页码落在已有页之外（理论上不该发生）时补到末尾，不丢数据。
   *
   * @param patch 本次识别出的页（page 从 1 开始）
   * @param textStatus 合并后的状态
   */
  async mergeSegments(
    sourceId: string,
    patch: readonly WriteSegmentInput[],
    textStatus: Source['textStatus'],
  ): Promise<{ source: Source; segments: SourceSegment[] } | null> {
    const existing = await this.storage.get('sources', sourceId);
    if (!existing) return null;

    const old = await this.getSegments(sourceId);
    // 页码 → 旧段（同页只可能有一段，见各解析器的约定）
    const oldByPage = new Map<number, SourceSegment>();
    for (const seg of old) oldByPage.set(seg.page, seg);

    const patchByPage = new Map<number, WriteSegmentInput>();
    for (const p of patch) patchByPage.set(p.page, p);

    // 以旧段的页号集合为骨架，逐页决定用新正文还是旧正文
    const pages = new Set<number>();
    for (const seg of old) pages.add(seg.page);
    for (const p of patch) pages.add(p.page);

    const next: SourceSegment[] = [];
    const sortedPages = [...pages].sort((a, b) => a - b);
    for (const page of sortedPages) {
      const incoming = patchByPage.get(page);
      const prev = oldByPage.get(page);
      if (incoming) {
        next.push({
          id: prev?.id ?? newId('seg'),
          sourceId,
          index: 0, // 下面统一编号
          page,
          chapter: incoming.chapter ?? prev?.chapter ?? null,
          text: incoming.text,
          charCount: incoming.text.length,
        });
      } else if (prev) {
        next.push(prev);
      }
    }

    // 统一重编号：跳过空白页时不留空洞
    const renumbered = next.map((seg, i) => ({ ...seg, index: i + 1 }));

    /**
     * 写回。有变化的段用 put（覆盖同 id），新增段是新 id，
     * 所以不需要先删光 —— 这也正是它与 writeSegments 的关键差别。
     */
    const oldIds = new Set(old.map((s) => s.id));
    const keepIds = new Set(renumbered.filter((s) => oldIds.has(s.id)).map((s) => s.id));
    for (const seg of old) {
      if (!keepIds.has(seg.id)) await this.storage.remove('sourceSegments', seg.id);
    }
    await this.storage.putMany('sourceSegments', renumbered);

    const source: Source = {
      ...existing,
      textStatus,
      segmentCount: renumbered.length,
      updatedAt: nowIso(),
    };
    await this.storage.put('sources', source);

    return { source, segments: renumbered };
  }

  /**
   * 把资料归到某个课程（传 null 表示移到「未分类」）。
   *
   * 单独开一个方法而不是只留 update()：列表页的换课程下拉最常用它，
   * 语义明确、调用处不会因为忘了只看 courseId 而误改标题。
   */
  async setCourse(sourceId: string, courseId: string | null): Promise<Source | null> {
    return this.update(sourceId, { courseId });
  }

  /**
   * 全文搜索。
   *
   * 两条实现要点：
   *
   * 1. **跨行匹配**。PDF 取出的文本里段落是 `\n\n` 分隔的，
   *    而用户搜的是一句连续的话。所以匹配前把换行当空白处理，
   *    但返回的偏移必须映射回**原始文本**的坐标，否则高亮会错位。
   *
   * 2. **大小写不敏感**（英文资料），但保留原文的字符位置。
   */
  async search(sourceId: string, query: string): Promise<SearchHit[]> {
    const needle = query.trim();
    if (!needle) return [];

    const segments = await this.getSegments(sourceId);
    const hits: SearchHit[] = [];

    for (const seg of segments) {
      const occurrences = findAllFolded(seg.text, needle);

      for (const { start, end } of occurrences) {
        hits.push({
          segmentId: seg.id,
          page: seg.page,
          chapter: seg.chapter,
          charStart: start,
          charEnd: end,
          snippet: makeSnippet(seg.text, start, end),
        });
      }
    }

    // 按页码排序，方便用户从上到下翻
    return hits.sort((a, b) => a.page - b.page || a.charStart - b.charStart);
  }
}

/**
 * 在文本里找所有出现位置，**忽略一切空白**，跨换行也能匹配。
 *
 * 为什么要剔掉空白而不是把它折成空格（第一版做法，实测失败）：
 * 中文没有词间空格，用户搜「句后」要能命中原文的「句\n后」。
 * 折成空格的话搜索串里没有空格，就永远匹配不上。
 * 剔掉空白对英文也是对的：「algo\nrithm」拼回「algorithm」正是想要的效果。
 *
 * 关键实现：构建折叠文本时**同时记录每个折叠字符来自原文的哪个下标**。
 * 命中后把下标映射回原文，返回的偏移可以直接用于高亮切分。
 * 不能用「先删除空白再 indexOf」那种做法 —— 那样偏移是折叠后坐标，
 * 拿去切原文本会越切越偏，高亮错位。
 */
export function findAllFolded(
  text: string,
  query: string,
): { start: number; end: number }[] {
  const chars = [...text];

  // 折叠：去掉空白 + 转小写，并记录每个输出字符的原文下标
  const foldedParts: string[] = [];
  const origOf: number[] = [];

  chars.forEach((ch, idx) => {
    if (/\s/.test(ch)) return;
    const lower = ch.toLowerCase();
    // toLowerCase 可能产出多个字符（如 İ），每个都映射到同一原文下标
    for (const c of lower) {
      foldedParts.push(c);
      origOf.push(idx);
    }
  });

  const foldedText = foldedParts.join('');

  // 查询同样折叠
  const queryParts: string[] = [];
  for (const ch of [...query]) {
    if (/\s/.test(ch)) continue;
    for (const c of ch.toLowerCase()) queryParts.push(c);
  }
  const foldedQuery = queryParts.join('');

  if (!foldedQuery) return [];

  const results: { start: number; end: number }[] = [];
  let from = 0;

  while (from <= foldedText.length - foldedQuery.length) {
    const idx = foldedText.indexOf(foldedQuery, from);
    if (idx === -1) break;

    const firstChar = origOf[idx];
    const lastChar = origOf[idx + foldedQuery.length - 1];
    results.push({ start: firstChar, end: lastChar + 1 });

    // 从下一个折叠字符继续，允许重叠命中（如「aa」在「aaa」里出现两次）
    from = idx + 1;
  }

  return results;
}

/** 生成预览片段：命中词前后各 30 字，换行压成空格 */
function makeSnippet(text: string, start: number, end: number, radius = 30): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);

  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();

  return `${prefix}${body}${suffix}`;
}

/** 把任意异常转成「有原因、有下一步」的失败对象 */
function toFailure(fileName: string, err: unknown): ImportOutcome {
  if (err instanceof ImportError) {
    return {
      fileName,
      ok: false,
      failure: { code: err.code, message: err.message, hint: err.hint },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    fileName,
    ok: false,
    failure: {
      code: 'unknown',
      message: `「${fileName}」导入失败：${message}`,
      hint: '可以换一份文件试试；若持续出现，请记下文件名反馈。',
    },
  };
}

// ---------------------------------------------------------------------------
// 课程
// ---------------------------------------------------------------------------

export class CourseService {
  constructor(private readonly storage: StorageAdapter) {}

  async list(): Promise<Course[]> {
    const all = await this.storage.getAll('courses');
    return all.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  async create(name: string, color: string | null = null): Promise<Course> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('课程名不能为空');

    const course: Course = {
      id: newId('course'),
      name: trimmed,
      color,
      createdAt: nowIso(),
    };
    await this.storage.put('courses', course);
    return course;
  }

  /**
   * 删除课程。
   *
   * 刻意**不删资料**：资料是用户辛苦导入的内容，
   * 删一个课程名不该把它们一起带走。只把 courseId 置空（回到未分类）。
   * 界面上会明确告知这一点。
   */
  async remove(id: string): Promise<number> {
    const sources = await this.storage.getAll('sources');
    const affected = sources.filter((s) => s.courseId === id);

    for (const source of affected) {
      await this.storage.put('sources', {
        ...source,
        courseId: null,
        updatedAt: nowIso(),
      });
    }

    await this.storage.remove('courses', id);
    return affected.length;
  }

  async rename(id: string, name: string): Promise<Course | null> {
    const existing = await this.storage.get('courses', id);
    if (!existing) return null;
    const next = { ...existing, name: name.trim() || existing.name };
    await this.storage.put('courses', next);
    return next;
  }
}
