/**
 * 把插图吸附到「最近的段落边界」（2026-11-11）。
 *
 * ## 它修的 bug
 *
 * 用户两次报「标注显示还没修好」。实测诊断（scripts/diag-mark-offset.cjs）
 * 找到真因：`splitByFigures` 按 `charOffset` 把正文切成多片，
 * 而 charOffset 常落在**句子中间**。比如：
 *
 *   "# 第1章 信号与系统\n\n## 1.0 引言\n\n在前面绪论中已经提到，信号…"
 *                                ↑ 图插在这里，切出 "统\n\n## 1.0 引言…"
 *
 * 每一片都从句子中间开始，而 `MarkdownBodyMarked` 对每片独立跑
 * `splitBlocks` —— 它看到的第一行是 "统"，不是标题。
 * 偏移量在两个坐标系间错开，高亮就跑到别处去了。
 *
 * ## 修法：图只放在块边界上
 *
 * 渲染前先算出所有「块边界」（段落之间、标题前后），把每个图的
 * charOffset **移到最近的边界**。这样：
 *  - 每个文本切片都是完整的 Markdown 块，splitBlocks 能正确识别
 *  - 偏移仍以整段原文为准（只是图的插入位置微调了几个字）
 *  - 图不会跑到句子中间 —— 那本来也不是人希望看到的位置
 *
 * ## 为什么可以安全地挪动图的位置
 *
 * `charOffset` 是「这张图大致在这儿」的近似值（MinerU 按阅读顺序给的），
 * 不是像素级对齐。挪到段落边界既不改变图文对应关系，
 * 也不会让读者觉得「图放错了地方」—— 反而更整齐。
 *
 * ⚠️ 绝不能反过来改 `SourceSegment.text`：那会让库里 95 个知识点的
 * charStart/charEnd 全部平移（见 model.ts 的 SourceImageRecord 注释）。
 */

import type { SourceImageRecord } from '@/core/model.ts';
import { splitBlocks } from './markdown-marks.ts';

/**
 * 算出一段文本里所有「适合插图」的位置。
 *
 * 取每块的起点与终点 —— 图可以放在段落前或段落后，
 * 但不能放在段落中间。
 */
export function blockBoundaries(text: string): number[] {
  const out = new Set<number>([0, text.length]);
  for (const b of splitBlocks(text)) {
    if (b.kind === 'list') {
      out.add(b.from);
      out.add(b.to);
      /* 列表项之间也允许插图 */
      for (const it of b.items) out.add(it.from);
    } else if (b.kind === 'heading') {
      /*
       * 标题要用**行首**，不是 b.from。
       *
       * `splitBlocks` 把标题的 from 定在「去掉 # 之后的文字」上
       * （那是给高亮用的：用户不会给 # 号本身做标注）。
       * 但插图要插在**整行前面** —— 插到 "# " 与文字之间会把标题劈成两半。
       * 单测（snap-figures.test.ts「包含标题与段落的起点」）抓到的就是这个。
       *
       * 做法：从 b.from 往回找最近的换行符，+1 就是行首。
       */
      const prevNewline = text.lastIndexOf('\n', b.from - 1);
      out.add(prevNewline < 0 ? 0 : prevNewline + 1);
      out.add(b.to);
    } else {
      out.add(b.from);
      out.add(b.to);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 把每个图的 charOffset 吸附到最近的块边界。
 *
 * @returns 新的 { 图, 吸附后的偏移 } 数组；顺序与原数组一致
 */
export function snapFiguresToBlocks(
  text: string,
  figures: readonly SourceImageRecord[],
): { figure: SourceImageRecord; offset: number }[] {
  if (figures.length === 0) return [];
  const bounds = blockBoundaries(text);

  const nearest = (target: number): number => {
    let best = bounds[0]!;
    let bestDist = Math.abs(target - best);
    for (const b of bounds) {
      const d = Math.abs(target - b);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  };

  /*
   * 多个图吸附到同一边界时，**不挪位置**，而是共用同一个偏移。
   *
   * 第一版想把它们依次往后挪 1 个字符以免重叠 —— 但那会破坏块结构
   * （偏移 1 个字等于落回句子中间，正是要修的问题）。
   * 正确做法是让它们共用边界，由渲染层按顺序连着插入。
   */
  const sorted = figures
    .map((f, i) => ({ f, i, at: Math.max(0, Math.min(text.length, f.charOffset)) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);

  return sorted.map((item) => ({ figure: item.f, offset: nearest(item.at) }));
}
