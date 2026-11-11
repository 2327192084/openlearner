/**
 * 正文里绘制用户批注（高亮 / 下划线 / 删除线）（2026-11-09）。
 *
 * ## 为什么用 CSS Custom Highlight API
 *
 * 第一版打算照搬 v1 的 `TextMarkLayer`：在正文上方绝对定位一层小方块，
 * 用 `Range.getClientRects()` 量位置。那个方案能用，但有两个负担：
 *  1. 要自己处理滚动同步、窗口缩放重算、翻页重建矩形
 *  2. 一层绝对定位 div 会盖在正文上，选字、点击都被它挡
 *
 * 而 `CSS.highlights`（CSS Custom Highlight API，Chrome 105+、
 * Electron 22+ 内置）正是为这个场景设计的：**不动一个 DOM 节点**，
 * 由浏览器自己根据 Range 画样式，滚动缩放全自动。
 *
 * 项目要求「渲染出来的文字与原文逐字一致」（锚点按字符偏移算），
 * 这个方案连一个字符都不插入 DOM，天然满足。
 *
 * ## 降级
 *
 * 不支持时静默跳过绘制，但**侧栏列表仍然完整**（数据在库里，
 * 只是不画在正文上）。不报错、不假装成功。
 *
 * ## 为什么按 Range 而不是按字符拼接
 *
 * 正文里有公式（MathText）、插图切分（renderWithFigures）、Markdown 结构。
 * 字符偏移落在这些结构里时，拼字符串会错位。用 Range 直接在
 * 文本节点上定位，绕开所有结构问题。
 *
 * ## 2026-11-11 修正：锚点给的是**原文偏移**，不是 DOM 偏移
 *
 * 上一版直接拿 `resolveTextAnchor` 返回的偏移（相对 `seg.text`，原文坐标）
 * 去 **渲染后 DOM 的文本节点**上累计字符数。两边长度并不相同：
 *
 *  - 标题的 `## ` 被吃掉（第 1 页 4 个标题少 12 字）
 *  - `$v_{s}$` 经 KaTeX 变成 `vs`（第 1 页 7 个公式）
 *  - 插图把正文切成多段，每段各自有基准偏移
 *
 * 实测第 1 页：原文 1048 字，`.reader-md` 的 DOM 文本 606 字，差 442 字。
 * 于是标注画出来整体后移 —— 「高亮盖在了错的那几个字上」，
 * 而库里存的锚点其实**完全正确**（只读审计 64/64 条逐字吻合）。
 *
 * 现在改用 `dom-text-map.ts` 的 `rawRangeToRanges`：渲染时每个片段
 * 都带 `data-raw`，换算按片段自带的坐标做，不再假设 DOM 文本长度
 * 等于原文长度。
 *
 * 对照：知识点定位高亮走 `MarkdownBodyMarked` 的 `marks` 属性，
 * 直接在原始字符串上 slice，所以一直准 —— 用户也说
 * 「知识库的定位显示的原文高亮部分并没有偏移」，问题只在自己的标注这条路。
 */

import type { SourceSegment, TextMark } from '@/core/model.ts';
import { resolveTextAnchor } from '@/core/text-anchor.ts';
import { rawRangeToRanges } from './dom-text-map.ts';

/** CSS Custom Highlight 注册名 → 样式（样式在 CSS 里用 ::highlight() 定义） */
const HIGHLIGHT_NAMES: Record<string, string> = {
  highlight: 'leaner-mark-highlight',
  underline: 'leaner-mark-underline',
  strikethrough: 'leaner-mark-strike',
};

interface HighlightRegistry {
  set: (name: string, h: unknown) => void;
  delete: (name: string) => void;
}

function registry(): HighlightRegistry | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  if (!g.CSS || !g.CSS.highlights || typeof g.Highlight !== 'function') return null;
  return g.CSS.highlights;
}

/**
 * 把「原文区间」映射成 DOM Range（2026-11-11 改）。
 *
 * 旧实现（`rangesForSpan`）遍历容器里的文本节点、**累计 DOM 字符数**，
 * 把原文偏移当成 DOM 偏移用 —— 这就是标注画偏的根因
 * （第 1 页差 442 字，详见文件头）。
 *
 * 现在交给 `dom-text-map.ts`：渲染时每片段都写了 `data-raw`，
 * 换算按片段自带坐标做，公式整块吸附。
 *
 * 为什么不用 `window.getSelection()` 那套：它依赖用户当前选区，
 * 而这里要还原的是**存下来的历史标记**，两者无关。
 */
function rangesForSpan(
  container: HTMLElement,
  span: { start: number; end: number },
): Range[] {
  return rawRangeToRanges(container, span.start, span.end);
}

/**
 * 绘制这一页的所有标记。
 *
 * 调用时机：正文渲染完成、标记数据变化、翻页。
 * 每次都先清掉上一次注册的名字，避免残留（同名 set 会覆盖，但
 * 页面里可能有别的资料/页留下的名字）。
 */
export function paintTextMarks(
  container: HTMLElement | null,
  segment: SourceSegment | null,
  marks: readonly TextMark[],
): { painted: number; stale: number } {
  const reg = registry();
  if (!reg) return { painted: 0, stale: 0 };

  /* 先全清，避免上一次的残留 */
  for (const name of Object.values(HIGHLIGHT_NAMES)) reg.delete(name);

  if (!container || !segment || marks.length === 0) return { painted: 0, stale: 0 };

  /* 按种类分组：一个 Highlight 名字对应一组 Range */
  const byKind = new Map<string, Range[]>();
  let stale = 0;

  for (const mark of marks) {
    /*
     * 用与批注一致的锚点还原逻辑：
     *  - 偏移先命中（O(1)）
     *  - 对不上就靠 exact 引文 + prefix/suffix 校验后搜回来
     *  - 都对不上 → 记为 stale，**不画错位置**
     */
    const res = resolveTextAnchor(segment.text, mark.anchor);
    if (!res.ok) {
      stale += 1;
      continue;
    }

    const name = HIGHLIGHT_NAMES[mark.kind];
    if (!name) continue;

    const ranges = rangesForSpan(container, { start: res.start, end: res.end });
    if (ranges.length === 0) {
      stale += 1;
      continue;
    }

    const arr = byKind.get(name) ?? [];
    arr.push(...ranges);
    byKind.set(name, arr);
  }

  const g = globalThis as unknown as { Highlight: new (...r: Range[]) => unknown };
  let painted = 0;
  for (const [name, ranges] of byKind) {
    if (ranges.length === 0) continue;
    reg.set(name, new g.Highlight(...ranges));
    painted += 1;
  }

  return { painted, stale };
}

/** 清掉所有已注册的高亮（离开阅读器时调用） */
export function clearTextMarks(): void {
  const reg = registry();
  if (!reg) return;
  for (const name of Object.values(HIGHLIGHT_NAMES)) reg.delete(name);
}
