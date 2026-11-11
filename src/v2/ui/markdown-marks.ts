/**
 * 在保持 Markdown 结构的前提下，把某个字符区间渲染成 <mark>（2026-11-11）。
 *
 * ## 它修的是什么 bug
 *
 * 用户反馈：「标注的文字与实际显示效果不匹配」，截图里
 * `# 第1章 信号与系统`、`## 1.0 引言` 都带着 `#` 号显示出来。
 *
 * 根因是阅读器有**两条互斥的渲染路径**：
 *  - 没有定位/高亮 → `MarkdownBody`：标题变 <h1>、列表变 <ul>…
 *    **字符数变了**（`# ` 被吃掉、`\n\n` 变成元素边界）
 *  - 有定位/高亮 → 老的「切三段」：`text.slice(0,start)` + `<mark>` +
 *    `slice(end)`，三段各过一个不解析 Markdown 的函数
 *
 * 于是有两个后果：
 *  1. 一旦这条页上有任何锚点或批注，整页退化成「带 # 的纯文本」
 *  2. 高亮位置按 `SourceSegment.text` 的**原始偏移**算，而渲染出来的
 *     文字已经把 `#` 去掉了 —— 偏移与屏幕上的字错开，
 *     表现就是「标注的文字与实际显示不匹配」
 *
 * ## 修法
 *
 * 不再维护两条路径。先把**原始文本**按行切分成块（标题/段落/列表/表格），
 * 每块都记下它在原文里的 `[from, to)` 字符区间；渲染时若高亮区间与某块
 * 相交，就在那一块内部把文字切成「前三段」并套 `<mark>`。
 *
 * 因为切分只发生在**原始字符串**上，每个字符的偏移始终是原文偏移，
 * 高亮不可能错位；而结构（h1/ul/table）照常生成，`#` 也不会漏出来。
 *
 * ## 为什么不在 DOM 上做（比如 Range + CSS Highlight）
 *
 * 正文渲染本来就要按 Markdown 出结构，Range 方案只能画在**已渲染的**
 * 文本节点上，对「这一段的标题级别」一无所知。而且 ReaderPage 已经
 * 用 CSS Custom Highlight 画**用户批注**（`paint-marks.ts`），
 * 那是另一件事（批注不改变结构）。这里处理的是「定位高亮」，
 * 它需要与结构一起决定，所以必须在渲染层做。
 */

/** 一个渲染块：结构类型 + 它在原文里的字符区间 */
export type Block =
  | { kind: 'heading'; level: number; text: string; from: number; to: number }
  | { kind: 'para'; text: string; from: number; to: number }
  | {
      kind: 'list';
      ordered: boolean;
      /**
       * 列表块自身的区间。
       *
       * ⚠️ 必须有：判定「高亮落在哪个块」时要按块的区间求交。
       * 第一版漏了这两个字段，于是 intersect(undefined, undefined, …)
       * 返回 NaN 比较为 false 的怪结果，让「标题里的词」同时命中了
       * 三个块。单测抓住的。
       */
      from: number;
      to: number;
      items: { text: string; from: number; to: number }[];
    }
  | {
      kind: 'table';
      head: string[];
      body: string[][];
      from: number;
      to: number;
    };

/**
 * 把原始正文切成块。
 *
 * 每个块的 `from/to` 是对**原始字符串**的偏移。
 * 这是本模块唯一的难点：`text.slice` 之后就不能再算偏移了，
 * 所以所有偏移都必须在切分时记录。
 */
export function splitBlocks(raw: string): Block[] {
  const out: Block[] = [];
  const lines: { text: string; start: number }[] = [];

  /* 先按行切开，同时记下每行在原文里的起始偏移 */
  let offset = 0;
  for (const line of raw.split('\n')) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1; /* +1 是那个 \n */
  }

  let buf: { text: string; start: number }[] = [];

  const flushPara = () => {
    if (buf.length === 0) return;
    const from = buf[0]!.start;
    const last = buf[buf.length - 1]!;
    const to = last.start + last.text.length;
    /* 段落保留内部换行（中文正文里软换行是有意义的） */
    const text = raw.slice(from, to);
    if (text.trim()) out.push({ kind: 'para', text, from, to });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const { text: line, start } = lines[i]!;
    const trimmed = line.trim();

    /* 空行结束段落 */
    if (trimmed === '') {
      flushPara();
      continue;
    }

    /* ---- 标题 ---- */
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      const title = heading[2]!;
      /*
       * 标题的偏移只覆盖**去掉 # 之后**的文字。
       * 用户不会给 `#` 号本身做标注；而且 # 是语法不是内容。
       */
      const titleStart = start + (line.length - line.trimStart().length) + heading[1]!.length + 1;
      out.push({
        kind: 'heading',
        level,
        text: title,
        from: titleStart,
        to: titleStart + title.length,
      });
      continue;
    }

    /* ---- 表格：连续的 | 行 ---- */
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushPara();
      const rows: string[][] = [];
      let j = i;
      const tableFrom = start;
      let tableTo = start + line.length;
      while (j < lines.length) {
        const l = lines[j]!.text.trim();
        if (!l.startsWith('|') || !l.endsWith('|')) break;
        if (!/^\|[\s:-]+\|/.test(l)) {
          rows.push(
            l
              .slice(1, -1)
              .split('|')
              .map((c) => c.trim().replace(/\\\|/g, '|')),
          );
        }
        tableTo = lines[j]!.start + lines[j]!.text.length;
        j++;
      }
      i = j - 1;
      if (rows.length > 0) {
        const [head, ...body] = rows;
        /*
         * 表格的高亮：整块当一个单元。
         * 按单元格算偏移在这个渲染器里收益太低（单元格文字短、
         * 而且用户几乎不会给表格里的半句话做标注），
         * 整块命中就整块标黄 —— 至少位置是对的，不会错到别的段落。
         */
        out.push({
          kind: 'table',
          head: head ?? [],
          body,
          from: tableFrom,
          to: tableTo,
        });
      }
      continue;
    }

    /* ---- 列表：连续同类项 ---- */
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const items: { text: string; from: number; to: number }[] = [];
      let j = i;
      let listFrom = start;
      while (j < lines.length) {
        const l = lines[j]!.text;
        const lt = l.trim();
        const b = /^([-*+])\s+(.*)$/.exec(lt);
        const n = /^(\d+)[.)]\s+(.*)$/.exec(lt);
        const m = ordered ? n : b;
        if (!m) break;
        /* 列表项的文字偏移：跳过缩进 + 标记 + 空格 */
        const indent = l.length - l.trimStart().length;
        const markerLen = ordered ? n![1]!.length + 1 : 1;
        const itemStart = lines[j]!.start + indent + markerLen + 1;
        const itemText = m[2]!;
        items.push({ text: itemText, from: itemStart, to: itemStart + itemText.length });
        j++;
      }
      i = j - 1;
      if (items.length > 0) {
        const lastLine = lines[Math.min(j - 1, lines.length - 1)]!;
        out.push({
          kind: 'list',
          ordered,
          from: listFrom,
          to: lastLine.start + lastLine.text.length,
          items,
        });
      } else {
        /* 理论上到不了这里；保险起见当普通段落 */
        buf.push({ text: line, start });
      }
      continue;
    }

    buf.push({ text: line, start });
  }

  flushPara();
  return out;
}

/**
 * 把一个字符串按 `[start, end)` 切成三段，供调用方分别渲染。
 *
 * 返回的 `before/hit/after` 都是**相对该字符串**的，
 * 调用方已经把它换算过了。区间不相交时 `hit` 为空串。
 */
export function sliceForMark(
  text: string,
  start: number,
  end: number,
): { before: string; hit: string; after: string } {
  const from = Math.max(0, Math.min(text.length, start));
  const to = Math.max(from, Math.min(text.length, end));
  return {
    before: text.slice(0, from),
    hit: text.slice(from, to),
    after: text.slice(to),
  };
}

/**
 * 高亮区间 `[hlFrom, hlTo)` 与块区间 `[blkFrom, blkTo)` 求交，
 * 返回**相对块起点**的偏移；不相交返回 null。
 */
export function intersect(
  blkFrom: number,
  blkTo: number,
  hlFrom: number,
  hlTo: number,
): { start: number; end: number } | null {
  const start = Math.max(blkFrom, hlFrom);
  const end = Math.min(blkTo, hlTo);
  if (end <= start) return null;
  return { start: start - blkFrom, end: end - blkFrom };
}
