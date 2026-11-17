/**
 * 从资料标题推断文件扩展名（2026-11-17）。
 *
 * ## 为什么需要
 *
 * 原件字节存在库里时**没有文件名**（IndexedDB 里只存 `{ id, data, byteSize }`）。
 * 但导出文件、交给 MinerU 都必须带正确的扩展名：
 *  - 用户双击导出的文件，扩展名错就打不开
 *  - MinerU 按扩展名分派解析器（白名单校验，见 electron/mineru.cjs）
 *
 * 标题通常带着原名，例如：
 *   信号与系统（第二版）第1章 信号与系统 正文（不含习题）   ← 没扩展名
 *   高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )    ← 没扩展名
 * 所以取不到时要按 `kind` 兜底。
 *
 * ## 为什么单独一个文件
 *
 * 这个逻辑原先在两处各写了一遍（ConvertPanel 拼临时文件、这里导出），
 * 两处必须一致 —— 不一致的表现是「交给 MinerU 能用、导出却打不开」，
 * 或者反过来。本项目的老毛病就是同逻辑写两遍然后漂移，所以抽出来。
 */

import type { Source } from '@/core/model.ts';

/** 允许的扩展名（与 electron/main.cjs 的白名单保持一致；pptx 为「看原图」新增） */
const KNOWN = /\.(pdf|pptx|png|jpe?g|webp|bmp|gif|tiff?)$/i;

/**
 * 取扩展名（带点，小写）。
 *
 * @returns 形如 `.pdf` / `.png`。永远返回一个可用的值，不返回空串 ——
 *          宁可给个合理猜测，也不要让导出/解析卡在「没有扩展名」上。
 */
export function extOf(source: Pick<Source, 'title' | 'kind'>): string {
  const m = KNOWN.exec(source.title.trim());
  if (m) {
    const raw = m[1]!.toLowerCase();
    /* jpeg → jpg（Windows 上两者都认，但用 jpg 更常见） */
    return `.${raw === 'jpeg' ? 'jpg' : raw}`;
  }
  if (source.kind === 'pdf') return '.pdf';
  if (source.kind === 'image') return '.png';
  if (source.kind === 'pptx') return '.pptx';
  /*
   * docx / md / txt：这些不留原件（正文已切进分段），
   * 所以理论上走不到这里。真走到了给 .txt 也比空串安全。
   */
  return '.txt';
}