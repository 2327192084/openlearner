/**
 * 树状学习地图的**布局计算**（2026-11-22，树状地图第 4 步）。
 *
 * ## 为什么布局要单独成一个纯函数文件
 *
 * 树要画 SVG 分叉连线（一个章连多个小节，CSS 的 border/伪元素画不出分叉）。
 * 连线的坐标必须和卡片的实际位置**严丝合缝** —— 差 2px 就看起来像断线。
 *
 * 有两种做法：
 *
 * | 做法 | 问题 |
 * |---|---|
 * | 渲染后用 `getBoundingClientRect()` 量 | 首帧连线错位（DOM 还没布局完）、窗口缩放要重算、jsdom 里量不到（测不了） |
 * | **先算好固定几何，组件照抄** | 没有这些问题 |
 *
 * 这里选后者（方案 5.2 节明确要的：「布局是算出来的不是测出来的，
 * 所以不依赖 getBoundingClientRect 也能准」）。
 *
 * 代价是：**CSS 里的尺寸必须与这里的常量一致**。所以组件不用 CSS 定
 * 卡片的宽高，而是把这里的 `w`/`h` 用 inline style 套上去 ——
 * 这样"两处各写一遍"的风险只剩 padding 之类不影响外框的属性。
 *
 * ## 为什么是「从左到右」而不是「从上到下」
 *
 * 方案写的是「纵向树……层级从左到右展开」。按真实资料算一下就知道
 * 为什么不能从上到下：442 页教材约 8 章 × 3–5 小节 ≈ 30 个小节，
 * 从上到下一行要排 30 个叶子节点，横向必然要滚，而「树」的意义
 * 就是一眼看出层级。
 *
 * 从左到右时三列分别是：资料根 → 章（竖着排）→ 小节（竖着排）。
 * 8 章竖排只占 8 × (68+14) ≈ 656px，一屏放得下；展开的小节
 * 贴在它父章的右侧，正好是用户说的「只专注于该节点和节点后延伸出的小节点」。
 *
 * ## 折叠时根节点的位置**不随展开变化**
 *
 * 根节点总是垂直居中于**章那一列**，不居中于"整个图"。
 * 这样点开/收起某一章时根节点不动 —— 视线不会被拽走。
 * 如果按整图居中，展开一个靠下、小节很多的章时根节点会突然下移。
 *
 * ## 纯函数
 *
 * 不碰 DOM、不碰 React。入参是结构，出参是坐标。所有分支都能单测。
 */

/** 布局常量（组件照抄，CSS 不得另定宽高） */
export const TREE_METRICS = {
  /** 根节点（资料） */
  rootW: 148,
  rootH: 60,
  /** 章节点 */
  chapterW: 208,
  chapterH: 68,
  /** 小节节点（比章窄不了多少：小节标题往往更长，如「1.1 连续时间和离散时间信号」） */
  sectionW: 224,
  sectionH: 54,
  /** 列间距 —— 连线的弯曲空间 */
  colGap: 56,
  /** 章与章的竖直间距 */
  chapterGap: 14,
  /**
   * 小节与小节的竖直间距。
   *
   * 比 `chapterGap` 小：小节是同级的兄弟，视觉上更紧凑才看得出
   * 「这些是同一章的组成部分」，而不是和章平级的另一堆东西。
   */
  sectionGap: 10,
} as const;

/** 一个盒子的位置（左上角 + 宽高） */
export interface TreeBox {
  /** 稳定 key，组件用它把盒子对回数据 */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一条连线 */
export interface TreeEdge {
  /** 稳定 key */
  key: string;
  /** 起点盒子 key */
  from: string;
  /** 终点盒子 key */
  to: string;
  /**
   * SVG path 的 `d`（三次贝塞尔）。
   *
   * 用 C 而不是 Q：三次贝塞尔两端切线水平，从卡片右缘出发、
   * 到卡片左缘入射时都是水平切线，接在卡片边上不会有个小尖角。
   */
  d: string;
  /** 两类连线的含义不同，样式也不同（根→章更重，章→小节更轻） */
  kind: 'root-chapter' | 'chapter-section';
}

/** 布局结果 */
export interface TreeLayout {
  /** SVG viewBox 的宽（含展开的小节列） */
  width: number;
  /** SVG viewBox 的高（取两列的最大值） */
  height: number;
  root: TreeBox;
  /** 章节点，顺序 = 传入顺序（= 路线的学习顺序，不是资料里的顺序） */
  chapters: TreeBox[];
  /** 小节节点；只有展开那一章的有 */
  sections: TreeBox[];
  edges: TreeEdge[];
}

/** 布局入参里对「章」的最小需求 */
export interface LayoutChapter {
  /**
   * 这一章有几个小节。
   *
   * 折叠时也要知道它 —— 布局要根据它决定展开后那一列有多高，
   * 而且界面要在折叠状态下显示「3/5 小节完成」。
   */
  sectionCount: number;
}

export interface TreeLayoutInput {
  /** 章（按学习顺序） */
  chapters: readonly LayoutChapter[];
  /**
   * 哪一章展开（**索引**，0 起）；`null` = 全部折叠。
   *
   * 用索引而不是 key：树重排时索引必然能用，key 可能对不上。
   * 越界（>= chapters.length）按「没展开」处理，不抛错 ——
   * 界面在重规划后残留旧索引时不该白屏。
   */
  expanded: number | null;
}

/** 章节点的 key */
export function chapterKey(i: number): string {
  return `ch-${i}`;
}

/** 小节节点的 key（带父章索引，避免不同章的同号小节撞 key） */
export function sectionKey(i: number, j: number): string {
  return `sec-${i}-${j}`;
}

/** 根节点 key */
export const ROOT_KEY = 'root';

/** 三次贝塞尔：两端切线水平（cx 取中点，最平滑且不会折返） */
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const cx = Math.round((x1 + x2) / 2);
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

/**
 * 算出一整棵树的坐标。
 *
 * 三种退化都安全：0 章 → 只有根节点；1 章 → 根与它竖直对齐；
 * 展开的章小节很多 → 上下夹住不让坐标为负。
 */
export function layoutTree(input: TreeLayoutInput): TreeLayout {
  const m = TREE_METRICS;
  const chapters = input.chapters;

  /* 展开索引越界 → 当作没展开（不抛错，见 TreeLayoutInput 注释） */
  const expandedIdx =
    input.expanded !== null && input.expanded >= 0 && input.expanded < chapters.length
      ? input.expanded
      : null;

  /* ---------- 列 x ---------- */
  const rootX = 0;
  const chapterX = m.rootW + m.colGap;
  const sectionX = chapterX + m.chapterW + m.colGap;
  const hasSections = expandedIdx !== null && (chapters[expandedIdx]?.sectionCount ?? 0) > 0;

  /* ---------- 章：从上到下等距 ---------- */
  const chapterBoxes: TreeBox[] = chapters.map((_, i) => ({
    key: chapterKey(i),
    x: chapterX,
    y: i * (m.chapterH + m.chapterGap),
    w: m.chapterW,
    h: m.chapterH,
  }));

  const chapterStackH =
    chapters.length === 0
      ? 0
      : chapters.length * m.chapterH + (chapters.length - 1) * m.chapterGap;

  /* ---------- 根：垂直居中于**章那一列**（不随展开移动） ---------- */
  const rootBox: TreeBox = {
    key: ROOT_KEY,
    x: rootX,
    y: Math.max(0, Math.round((chapterStackH - m.rootH) / 2)),
    w: m.rootW,
    h: m.rootH,
  };

  /* ---------- 小节：竖直居中于父章的中心 ---------- */
  const sectionBoxes: TreeBox[] = [];
  if (hasSections && expandedIdx !== null) {
    const parent = chapterBoxes[expandedIdx];
    const n = chapters[expandedIdx]?.sectionCount ?? 0;
    const stackH = n * m.sectionH + (n - 1) * m.sectionGap;
    const parentCenterY = (parent?.y ?? 0) + m.chapterH / 2;
    /*
     * 居中之后可能顶上越界（第一章节多时），整体下移到 0 起。
     * 不下移的话 SVG 上半截是负坐标，viewBox 会把它裁掉。
     */
    const top = Math.max(0, Math.round(parentCenterY - stackH / 2));

    for (let j = 0; j < n; j += 1) {
      sectionBoxes.push({
        key: sectionKey(expandedIdx, j),
        x: sectionX,
        y: top + j * (m.sectionH + m.sectionGap),
        w: m.sectionW,
        h: m.sectionH,
      });
    }
  }

  /* ---------- 连线 ---------- */
  const edges: TreeEdge[] = [];

  /* 根 → 每一章（全部折叠时也要画，那是树的骨架） */
  for (const ch of chapterBoxes) {
    edges.push({
      key: `e-${ROOT_KEY}-${ch.key}`,
      from: ROOT_KEY,
      to: ch.key,
      kind: 'root-chapter',
      d: bezierPath(rootBox.x + rootBox.w, rootBox.y + rootBox.h / 2, ch.x, ch.y + ch.h / 2),
    });
  }

  /* 章 → 它的每个小节（**同一个起点** = 分叉，不是链） */
  if (expandedIdx !== null && sectionBoxes.length > 0) {
    const parent = chapterBoxes[expandedIdx];
    if (parent) {
      const x1 = parent.x + parent.w;
      const y1 = parent.y + parent.h / 2;
      for (const sec of sectionBoxes) {
        edges.push({
          key: `e-${parent.key}-${sec.key}`,
          from: parent.key,
          to: sec.key,
          kind: 'chapter-section',
          d: bezierPath(x1, y1, sec.x, sec.y + sec.h / 2),
        });
      }
    }
  }

  /* ---------- 整图尺寸 ---------- */
  const width = hasSections ? sectionX + m.sectionW : chapterX + m.chapterW;

  let height = Math.max(m.rootH, chapterStackH);
  if (sectionBoxes.length > 0) {
    const last = sectionBoxes[sectionBoxes.length - 1];
    if (last) height = Math.max(height, last.y + last.h);
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
    root: rootBox,
    chapters: chapterBoxes,
    sections: sectionBoxes,
    edges,
  };
}

/**
 * 一条连线大概有多长（px，直线距离）。
 *
 * 只用于排序/诊断，不参与渲染。留着是因为验证脚本要判断
 * 「连线是不是从卡片边缘出发的」时需要一个与 d 无关的独立量。
 */
export function edgeSpan(a: TreeBox, b: TreeBox): number {
  const ax = a.x + a.w;
  const ay = a.y + a.h / 2;
  const bx = b.x;
  const by = b.y + b.h / 2;
  return Math.round(Math.hypot(bx - ax, by - ay));
}

/**
 * 给一组盒子中「竖着排」的那一列算出总高。
 *
 * 组件不需要它，但测试与验证脚本要用它判断
 * 「这一列有没有重叠」。放在这里而不是测试文件里，
 * 是因为验证脚本（.cjs）引用不到测试文件。
 */
export function columnSpan(boxes: readonly TreeBox[]): number {
  if (boxes.length === 0) return 0;
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (!first || !last) return 0;
  return last.y + last.h - first.y;
}