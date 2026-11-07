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
  /** 写回后的段数 */
  segmentCount: number;
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
    page: i + 1,
    // 章节标题：这一页若以标题块开头，用它做 chapter；否则 null。
    // 不猜 —— 猜错会让目录跳转指错地方。
    chapter: p.chapter ?? null,
    text: p.text,
  }));
}

/**
 * 章节标题已由 markdown.ts 判断好（只有页首是标题时才算），
 * 这一层直接用，不再二次猜测 —— 猜错会让目录跳转指错地方。
 */

/** 统计报告里那几个如实数字 */
export function summarize(
  source: Source,
  result: MinerUResult,
  segments: readonly ConvertedSegment[],
): ConversionReport {
  const emptyPages = segments.filter((s) => s.text.trim() === '').map((s) => s.page);
  return {
    sourceId: source.id,
    sourceTitle: source.title,
    pageCount: result.pageCount,
    pagesWithText: segments.length - emptyPages.length,
    emptyPages,
    tier: result.tier,
    producer: result.producer,
    segmentCount: segments.length,
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
   */
  const written = await sourceService.writeSegments(source.id, segments, 'ready');
  if (!written) {
    throw new Error(`「${source.title}」在转换过程中被删掉了，结果没有写回。`);
  }

  return { ...report, segmentCount: written.segments.length };
}

export { needsConversion };
