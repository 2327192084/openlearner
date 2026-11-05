import type { SourceChunk } from '@/core/slides/source-chunk.ts';

/**
 * 测试用的资料段落构造器。
 *
 * ## 为什么集中到一个文件
 *
 * PPT 的输入端从「知识点」改成「原文段落」之后，9 个测试文件都要
 * 相应改一遍构造数据。如果各写各的 `makeChunk`，会散出七八个
 * 略有差异的版本 —— 以后再加字段（比如段落字符数）就有得改了。
 *
 * 集中一份，改一处即可。
 */

/** 造一段原文 */
export function chunk(
  segmentId: string,
  text: string,
  page = 1,
  chapter: string | null = null,
): SourceChunk {
  return { segmentId, text, page, chapter };
}

/** 造 n 段原文，页码从 1 递增 */
export function chunks(n: number, chapter: string | null = '第一章'): SourceChunk[] {
  return Array.from({ length: n }, (_, i) =>
    chunk(`seg_${i + 1}`, `第 ${i + 1} 段的正文内容，各不相同，便于区分。`, i + 1, chapter),
  );
}

/** 同一章的多段（页码连续），用于测章节分组 */
export function chunksInChapter(
  n: number,
  chapter: string,
  startPage: number,
): SourceChunk[] {
  return Array.from({ length: n }, (_, i) =>
    chunk(`seg_${chapter}_${i + 1}`, `${chapter} 的第 ${i + 1} 段正文。`, startPage + i, chapter),
  );
}
