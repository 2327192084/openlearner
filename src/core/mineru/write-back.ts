/**
 * 把 MinerU 的转换结果写回一份资料。
 *
 * ## 用户要的是什么
 *
 * 「整理知识点时检测到无文字层的 PDF 或图片，就用 MinerU 转换，
 *  并且转换的文档要与原文件对应的转换页数一一相对，方便对照是否有错误。」
 *
 * 拆开是三件事：
 *  1. 检测：`needsConversion()` 判断要不要转
 *  2. 转换：MinerU 出 middle_json
 *  3. 一一对应：**每一页占一个段，页号与原书一致**，空页也留着
 *
 * 第 3 条是重点。如果第 5 页是整页插图被跳过，第 6 页的段会变成 index=5,
 * page=5 —— 之后所有页错位，用户拿着「第 12 页」去看原书第 12 页会发现对不上。
 * 所以这里**绝不跳过空页**：给空页留一个空文本段，页码严格等于原书页码。
 *
 * ## 为什么写回 sourceSegments 而不是另存一个文档
 *
 * 我们的定位模型是 `{sourceId, page, charStart, charEnd}`，charStart/charEnd 是
 * **页内偏移**。只要文字按页写回，页码映射天然 1:1，不需要「转换页 → 原页」对照表，
 * 也不用碰 PDF 原始字节（避开 pdfjs detach ArrayBuffer 的坑）。
 * 这样「点回原文」在转换后依然成立，而且高亮位置正确。
 */

import type { Source } from '../model.ts';
import type { SourceService } from '../sources.ts';
import type { MinerUResult, MinerUPage } from './markdown.ts';
import { needsConversion } from './convert.ts';

/** 转换后写回的段（与 SourceService.writeSegments 的入参对齐） */
export interface ConvertedSegment {
  page: number;
  chapter: string | null;
  text: string;
  /**
   * 这一页是「补位」出来的空页，不是真实解析结果（2026-11-11）。
   *
   * 分片解析 3-4 页时会产出整个 36 页的结构，其中 34 页是补位。
   * 合并写回时**必须跳过**它们，否则会把已有的正文覆盖成空。
   */
  placeholder?: boolean;
}

/** 转换一份资料的完整结果，供界面如实汇报 */
export interface ConversionReport {
  sourceId: string;
  sourceTitle: string;
  /** MinerU 认为的页数 */
  pageCount: number;
  /** 真正有文字的页数 */
  pagesWithText: number;
  /** 空页页码（整页插图/扉页），供用户对照 */
  emptyPages: number[];
  /** 实际用的 tier */
  tier: string;
  /** 解析模式：ocr 表示真的走了 OCR */
  /** 生产者版本 */
  producer: string;
  /** 写回后的段数（合并模式下是**库里总共**的段数） */
  segmentCount: number;
  /**
   * 这次实际写入/覆盖了几页（2026-11-11）。
   *
   * 与 `segmentCount` 分开是必须的：分片解析时这次写 13 页、
   * 库里可能总共 36 段。只报一个数会让用户以为整本都被重写了。
   */
  writtenPageCount?: number;
}

/**
 * 把 MinerU 结果规整成「与原文逐页对应」的段数组。
 *
 * 纯函数，不碰存储 —— 单测可以直接喂样本，不需要装 MinerU。
 *
 * 规则：
 *  - 长度严格等于 `result.pageCount`
 *  - 第 N 个元素的 `page === N+1`
 *  - 空页保留为空 text（不是跳过）
 *  - 章节标题从块里取（MinerU 会给 paragraph_title），取不到就是 null
 */
export function toSegments(result: MinerUResult): ConvertedSegment[] {
  return result.pages.map((p: MinerUPage, i) => ({
    /*
     * 页码用 MinerU 自带的 `p.page`，**不是** i+1（2026-11-11 改）。
     *
     * 为什么：分片解析（`--pages 3-15`）时，MinerU 输出的 Markdown 里
     * 分页标记是 `<!-- page 3 of 15 -->`、`<!-- page 4 of 15 -->`……
     * 即 **真实页号**。若这里用 i+1，第 3 页会被写成第 1 页 ——
     * 用户点「第 3 页」看到的是第 3 页内容，但库里标着第 1 页，
     * 而知识点锚点全按页号存，会整批错位。
     *
     * 旧实现用 i+1 是**因为在完整解析下两者恰好相等**（页从 1 开始连续），
     * 所以这个差异一直没暴露出来。分片解析才把它变成真 bug。
     *
     * 兜底：`p.page` 缺失或不是正数时退回 i+1，不产生 0 / NaN 页号。
     */
    page: typeof p.page === 'number' && p.page >= 1 ? p.page : i + 1,
    // 章节标题：这一页若以标题块开头，用它做 chapter；否则 null。
    // 不猜 —— 猜错会让目录跳转指错地方。
    chapter: p.chapter ?? null,
    text: p.text,
    /* 补位空页要标出来，合并时跳过（见 ConvertedSegment.placeholder） */
    ...(p.placeholder ? { placeholder: true } : {}),
  }));
}

/**
 * 章节标题已由 markdown.ts 判断好（只有页首是标题时才算），
 * 这一层直接用，不再二次猜测 —— 猜错会让目录跳转指错地方。
 */

/**
 * 统计报告里那几个如实数字。
 *
 * ⚠️ 补位空页不算「这次转出来的空页」（2026-11-11）。
 * 分片解析 3-4 页时会补出 32 个占位页，如果把它们计入 emptyPages，
 * 界面会显示「已转好 4 / 36 页，空页 32 个」——看着像解析失败。
 * 那些页不是「解析了但没文字」，而是「这次压根没解析」。
 */
export function summarize(
  source: Source,
  result: MinerUResult,
  segments: readonly ConvertedSegment[],
): ConversionReport {
  /* 真实产出的页（补位的不算） */
  const real = segments.filter((s) => !s.placeholder);
  const emptyPages = real.filter((s) => s.text.trim() === '').map((s) => s.page);
  return {
    sourceId: source.id,
    sourceTitle: source.title,
    pageCount: result.pageCount,
    pagesWithText: real.length - emptyPages.length,
    emptyPages,
    tier: result.tier,
    producer: result.producer,
    segmentCount: segments.length,
    /* 这次真实处理的页数（分片时小于 segmentCount） */
    writtenPageCount: real.length,
  };
}

/**
 * 转换并写回一份资料。
 *
 * 调用前提：调用方已确认 `needsConversion(source.textStatus, source.kind)` 为 true，
 * 并且拿到了可用的 runner（桌面版）。这里只做「转换 → 写回」。
 *
 * 写回后 `textStatus` 置为 `ready`，因为此时文字已经真的在库里了。
 * 但如果**一页都没识别出文字**，不置 ready —— 那说明转换没成功，
 * 谎称 ready 会让用户以为有正文可查，实际是空的。
 */
export async function convertAndWriteBack(options: {
  source: Source;
  sourceService: SourceService;
  result: MinerUResult;
}): Promise<ConversionReport> {
  const { source, sourceService, result } = options;

  const segments = toSegments(result);
  const report = summarize(source, result, segments);

  if (report.pagesWithText === 0) {
    throw new Error(
      `MinerU 转换「${source.title}」后一页文字都没有。可能是这份文件确实是整本插图，` +
        `也可能是转换没成功 —— 请到 MinerU 那边确认，或换一份文件试试。`,
    );
  }

  /*
   * 写回。注意 textStatus 用 'ready'：
   * 此时 sourceSegments 里已经是真实文字，搜索、出题、点回原文都能用了。
   *
   * ## merge 而不是 replace（2026-11-11 用户要求）
   *
   * 分片解析（`--pages 3-15`）只产出这一段。用 replace 会把用户
   * 之前解析好的其他页全删掉 —— 那样「先解析 3-15、再解析 16-30」
   * 就永远凑不齐整本。
   *
   * 用 merge 后：新写的页覆盖同页旧内容，没写到的页原样保留。
   * MinerU 的段落是一页一段（见 mineru/markdown.ts），按 page 合并是准的。
   * 完整解析下 merge 与 replace 结果相同（覆盖了每一页），所以统一用 merge
   * 也不需要分支。
   */
  /*
   * 写回前按资料的真实页数裁一遍（2026-11-11 实测 bug 的第二道防线）。
   *
   * ## 这一步防的是什么
   *
   * 实测：用户在一份 **只有 2 页的 docx** 上填了「解析 3-4 页」，
   * MinerU 照解析（它不知道这份资料本来几页），输出里写的是 `page 3 of 36`
   * —— 于是 `parseMarkdown` 补出 36 个页对象，写回后那份资料变成 36 段：
   * 前两页被清空，3-4 页塞进了别的文件的内容。
   *
   * 前端现在会拦（`validatePageRange`），但那是界面层，绕过它的路径
   * （脚本、旧版本、以后的别的入口）不该能把库写坏。
   * 所以这一层也要挡。
   *
   * ## 为什么是「裁剪」而不是「报错」
   *
   * 完整解析时页数一致，裁不到东西；分片时超出的部分本来就不该存在。
   * 直接丢掉超出的页比抛错更合适 —— 正文已经拿到了，没必要因为
   * 多出来几页空白而整单丢弃。
   */
  const maxPage = source.pageCount ?? null;
  const clamped =
    maxPage !== null ? segments.filter((s) => s.page >= 1 && s.page <= maxPage) : segments;

  const written = await sourceService.writeSegments(source.id, clamped, 'ready', 'merge');
  if (!written) {
    throw new Error(`「${source.title}」在转换过程中被删掉了，结果没有写回。`);
  }

  /*
   * 如实汇报两个数字（2026-11-11）。
   *
   * 分片解析时它们不同：这次写了 2 页，库里可能总共已有 2 段。
   * 只报一个数会让用户以为整本都被重写了。
   */
  return {
    ...report,
    /** 库里现在总共有几段（合并后） */
    segmentCount: written.segments.length,
    /**
     * 这次实际写入/覆盖了几页。
     *
     * ⚠️ 必须排除补位页（2026-11-11 实测）：`segments` 里有 48 个补位空页，
     * 直接用 `segments.length` 会报出「这次写入 36 页」——
     * 而实际只解析了 2 页，用户看到这个数字会以为整本被重写了。
     */
    writtenPageCount: segments.filter((s) => !s.placeholder).length,
  };
}

export { needsConversion };
