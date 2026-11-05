import PptxGenJS from 'pptxgenjs';
import type { SlideDeck, SlideImageRecord } from '../model.ts';
import {
  buildRenderPlan,
  SLIDE_BOX,
  SLIDE_SIZE,
  type RenderSlide,
} from './render-plan.ts';
import { resolveTheme, type SlideTheme } from './theme.ts';

/** 自定义画布名，与 pptxgenjs 内置预设区分开，避免被同名预设覆盖。 */
const LAYOUT_NAME = 'OPENLEARNER_16x9';

/**
 * 导出真实 .pptx。
 *
 * ## 为什么用 pptxgenjs 而不是别的方式
 *
 * 计划书 P4 第 5 条要求「可编辑，不是图片拼贴」。
 * 常见偷懒做法是把每页截图塞进 pptx —— 打开是能看，但一个字都改不了，
 * 学生想加一条自己的笔记只能重做，那就不叫"能拿去复习的幻灯片"。
 *
 * pptxgenjs 直接写 Open XML，产出的是真实文本框、真实段落。
 * 代价是要自己算坐标（它不会自动排版），这也是为什么坐标全部集中在
 * render-plan.ts 里，预览和导出共用同一份。
 */

/** 配色与字体统一来自 theme.ts —— 预览和导出共用同一份，不再各写一套 */

export interface ExportResult {
  /** pptx 二进制 */
  buffer: Uint8Array;
  /** 导出的页数（与预览一致） */
  slideCount: number;
  /** 建议的文件名（含序号，重复导出不覆盖） */
  fileName: string;
}

/**
 * 生成 .pptx 字节。
 *
 * @param deck 待导出的 PPT
 * @param ordinal 导出序号（从 1 开始），用于文件名；避免覆盖之前导出的版本
 * @param options.includeSources 是否追加「资料来源」页，默认 true
 */
export async function exportToPptx(
  deck: SlideDeck,
  ordinal = 1,
  options: {
    includeSources?: boolean;
    /** 叠加内容用到的图片（id → 记录），由调用方读好传进来 */
    images?: Map<string, SlideImageRecord>;
  } = {},
): Promise<ExportResult> {
  const plan = buildRenderPlan(deck, deck.title, options);
  if (plan.length === 0) {
    throw new Error('没有可导出的内容：大纲是空的');
  }

  const pptx = new PptxGenJS();
  /**
   * 画布尺寸必须直接引用 SLIDE_SIZE，不能用 pptxgenjs 的 'LAYOUT_16x9' 预设。
   *
   * 预设名骗人：pptxgenjs 的 LAYOUT_16x9 实际是 10 × 5.625 英寸，
   * 而幻灯片行业标准的「宽屏 16:9」是 13.333 × 7.5 英寸。两者比例相同
   * （都是 16:9），所以**按比例看一切正常**，但绝对坐标全部差 33%：
   * 右下的形状会跑到画布外面，在 Office / WPS 里直接被裁掉。
   *
   * 这个缺陷骗过了我们的单测（解压 zip 找 <a:t> 只证明文字存在），
   * 是拿 python-pptx 独立解析才发现的 —— 见 scripts/inspect-pptx.py。
   */
  pptx.defineLayout({
    name: LAYOUT_NAME,
    width: SLIDE_SIZE.width,
    height: SLIDE_SIZE.height,
  });
  pptx.layout = LAYOUT_NAME;
  pptx.author = 'OpenLeaner';
  pptx.title = deck.title;

  // 主题对这个 deck 全局生效；resolveTheme 对未知 id 退回默认，不抛错
  t = resolveTheme(deck.theme);

  for (const slide of plan) {
    renderSlide(pptx, slide);
  }

  const out = await pptx.write({ outputType: 'uint8array' });
  // pptxgenjs 的 uint8array 返回值在类型上更宽，这里收紧
  const buffer = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);

  return {
    buffer,
    slideCount: plan.length,
    fileName: buildFileName(deck.title, ordinal),
  };
}

/**
 * 当前渲染用的主题。
 *
 * 用模块级变量而不是给 6 个渲染函数都加一个 t 参数：那些函数是
 * 「同一页的不同画法」，主题对它们是全局的，逐层传参会把每个签名
 * 都搞得很难看，而漏传一个的后果正好是「某一页没跟着换主题」。
 *
 * 安全性：exportToPptx 是唯一入口，它在开始时赋值、结束时清空，
 * 且 pptxgenjs 的渲染是同步的，不存在两次导出交错的情况。
 */
let t: SlideTheme = resolveTheme(null);

/**
 * 画叠加内容（用户自由摆放的图片 / 文本框）。
 *
 * 坐标在 render-plan 里已经从 0~1 比例换算成英寸，这里直接用，
 * **不再做任何位置计算** —— 预览用的是同一份英寸值，
 * 两边各算一次就会错位。
 */
function renderOverlays(slide: RenderSlide, s: PptxSlide): void {
  for (const ov of slide.overlays) {
    if (ov.kind === 'image') {
      if (!ov.imageData) continue;
      s.addImage({
        data: ov.imageData,
        x: ov.x,
        y: ov.y,
        w: ov.w,
        h: ov.h,
      });
      continue;
    }

    if (!ov.text) continue;
    s.addText(ov.text, {
      x: ov.x,
      y: ov.y,
      w: ov.w,
      h: ov.h,
      fontSize: ov.fontSize,
      color: ov.color ?? t.colors.text,
      fontFace: t.font,
      // 文本框里的换行按用户输入保留，不自动压成一行
      valign: 'top',
    });
  }
}

/** 按版式渲染一页 */
function renderSlide(pptx: PptxGenJS, slide: RenderSlide): void {
  const s = pptx.addSlide();
  s.background = { color: t.colors.bg };

  switch (slide.layout) {
    case 'title':
      renderTitle(slide, s);
      break;
    case 'section':
      renderSection(slide, s);
      break;
    case 'bullets':
      renderBullets(slide, s);
      break;
    case 'sources':
      renderSources(slide, s);
      break;
    case 'figure':
      renderFigure(slide, s);
      break;
  }

  /**
   * 叠加内容画在最后 = 盖在这一页所有内容之上。
   *
   * 顺序很重要：先画版式再画 overlay，用户插入的图才不会被正文压住。
   * 反过来会让人以为「加了图但看不见」，然后反复加。
   */
  renderOverlays(slide, s);

  // 页脚：资料名 + 页码（封面页不显示，和正规幻灯片一致）
  if (slide.footer || slide.layout !== 'title') {
    if (slide.footer) {
      s.addText(slide.footer, {
        x: SLIDE_BOX.marginX,
        y: SLIDE_BOX.footerTop,
        w: 8,
        h: SLIDE_BOX.footerHeight,
        fontSize: 9,
        color: t.colors.muted,
        fontFace: t.font,
        valign: 'middle',
      });
    }
    s.addText(String(slide.pageNumber), {
      x: SLIDE_SIZE.width - SLIDE_BOX.marginX - 1,
      y: SLIDE_BOX.footerTop,
      w: 1,
      h: SLIDE_BOX.footerHeight,
      fontSize: 9,
      color: t.colors.muted,
      fontFace: t.font,
      align: 'right',
      valign: 'middle',
    });
  }
}

type PptxSlide = ReturnType<PptxGenJS['addSlide']>;

/** 封面页：深色底 + 大标题 + 副标题 */
function renderTitle(slide: RenderSlide, s: PptxSlide): void {
  s.background = { color: t.colors.titleBg };
  s.addText(slide.title, {
    x: 1.1,
    y: 2.5,
    w: SLIDE_SIZE.width - 2.2,
    h: 1.7,
    fontSize: 40,
    bold: true,
    color: t.colors.titleText,
    fontFace: t.font,
    valign: 'bottom',
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 1.1,
      y: 4.35,
      w: SLIDE_SIZE.width - 2.2,
      h: 0.7,
      fontSize: 16,
      color: t.colors.subtitle,
      fontFace: t.font,
      valign: 'top',
    });
  }
  // 一条细色线作装饰，别多
  s.addShape('rect', {
    x: 1.1,
    y: 4.25,
    w: 1.6,
    h: 0.045,
    fill: { color: t.colors.accent },
    line: { color: t.colors.accent, width: 0 },
  });
}

/** 章节过渡页：大号章节名居中偏左 */
function renderSection(slide: RenderSlide, s: PptxSlide): void {
  s.addShape('rect', {
    x: 0,
    y: 0,
    w: 0.14,
    h: SLIDE_SIZE.height,
    fill: { color: t.colors.accent },
    line: { color: t.colors.accent, width: 0 },
  });
  s.addText(slide.title, {
    x: 1.1,
    y: 2.9,
    w: SLIDE_SIZE.width - 2.2,
    h: 1.6,
    fontSize: 32,
    bold: true,
    color: t.colors.text,
    fontFace: t.font,
    valign: 'middle',
  });
}

/** 要点页：标题 + 分隔线 + 要点列表（带角标） */
function renderBullets(slide: RenderSlide, s: PptxSlide): void {
  s.addText(slide.title, {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: SLIDE_BOX.titleHeight,
    fontSize: 26,
    bold: true,
    color: t.colors.text,
    fontFace: t.font,
    valign: 'middle',
  });

  s.addShape('rect', {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop + SLIDE_BOX.titleHeight + 0.05,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: 0.02,
    fill: { color: t.colors.rule },
    line: { color: t.colors.rule, width: 0 },
  });

  /**
   * 角标用富文本 run 实现（一个 addText 里多个 run），而不是单独 addText。
   *
   * 为什么：单独 addText 的话角标是一个独立文本框，字号一改就对不齐基线，
   * 而且用户编辑时删掉正文角标还在，飘在那里。
   * 放在同一个段落里，它是段落的一部分，跟着文字走。
   */
  const rows = slide.bullets.map((b) => {
    const runs: PptxGenJS.TextProps[] = [
      { text: b.text, options: { fontSize: 18, color: t.colors.text, fontFace: t.font } },
    ];
    if (b.citationIndex !== null) {
      runs.push({
        text: ` [${b.citationIndex}]`,
        options: {
          fontSize: 12,
          color: t.colors.citation,
          fontFace: t.font,
          superscript: true,
        },
      });
    }
    return { runs };
  });

  // 多条要点：每条一个段落，用 breakLine 串起来
  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    const props: PptxGenJS.TextProps[] = row.runs.map((r, j) => ({
      ...r,
      options: {
        ...r.options,
        // 每个段落之间换行；最后一条不加
        breakLine: !isLast && j === row.runs.length - 1,
        paraSpaceAfter: isLast ? 0 : 10,
      },
    }));

    s.addText(props, {
      x: SLIDE_BOX.marginX,
      y: SLIDE_BOX.bodyTop + i * 0.86,
      w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
      h: 0.8,
      fontSize: 18,
      color: t.colors.text,
      fontFace: t.font,
      valign: 'top',
      // 单条要点内部自动换行，不缩字号：缩了不同页字号不一致，翻页会跳
      fit: 'none',
      wrap: true,
    });
  });
}

/**
 * 图文页：原文页截图 + 标题 + 图注（+ 可选要点）。
 *
 * 图来自 SlideFigure，已经是 data URL，pptxgenjs 直接写进 ppt/media ——
 * 所以导出的 .pptx 是**自包含**的，发给别人不需要附上 44MB 原 PDF。
 */
function renderFigure(slide: RenderSlide, s: PptxSlide): void {
  s.addText(slide.title, {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: SLIDE_BOX.titleHeight,
    fontSize: 26,
    bold: true,
    color: t.colors.text,
    fontFace: t.font,
    valign: 'middle',
  });

  s.addShape('rect', {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop + SLIDE_BOX.titleHeight + 0.05,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: 0.02,
    fill: { color: t.colors.rule },
    line: { color: t.colors.rule, width: 0 },
  });

  if (slide.figure && slide.figureBox) {
    const box = slide.figureBox;
    s.addImage({
      data: slide.figure.imageData,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // 图片左上角贴住计算好的框，不用 sizing：框本身就是按比例算出来的，
      // 再用 contain 会二次缩放，最终尺寸和预览对不上
    });

    // 细边框：白底页面贴在白底幻灯片上，没有边界会像「飘着的文字」
    s.addShape('rect', {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      fill: { type: 'none' },
      line: { color: t.colors.rule, width: 0.75 },
    });
  }

  // 图注放图片正下方；图片和图注之间留 0.12 英寸
  if (slide.figureCaption) {
    const captionY = slide.figureBox
      ? slide.figureBox.y + slide.figureBox.h + 0.12
      : SLIDE_BOX.bodyTop;

    // 图注可能被挤到页脚区（图片很高时），夹一下避免压住页码
    const maxY = SLIDE_BOX.footerTop - 0.45;
    const y = Math.min(captionY, maxY);

    // 图注左边界对齐图片。按整页宽度居中时，图片只占左侧 62%，
    // 图注会落在图片右边大半个页面之外，读者不知道它在说明谁。
    //
    // 但宽度不能等于图片宽度：竖版 A4 的图片只有 3.2 英寸宽，
    // 一句「《数据结构》第 12 页 · 二叉树的遍历」会被拆成两行。
    // 所以取「图片宽度」与「最小可读宽度」的较大者，并用右边界夹住。
    const captionX = slide.figureBox ? slide.figureBox.x : SLIDE_BOX.marginX;
    const available = SLIDE_SIZE.width - SLIDE_BOX.marginX - captionX;
    const MIN_CAPTION_WIDTH = 5.5;
    const captionW = slide.figureBox
      ? Math.min(available, Math.max(slide.figureBox.w, MIN_CAPTION_WIDTH))
      : SLIDE_SIZE.width - SLIDE_BOX.marginX * 2;

    s.addText(slide.figureCaption, {
      x: captionX,
      y,
      w: captionW,
      h: 0.4,
      fontSize: 11,
      color: t.colors.muted,
      fontFace: t.font,
      align: 'center',
      valign: 'top',
      wrap: true,
    });
  }

  // 右侧要点（可选）：图文页也允许带几条说明，复用要点页的角标逻辑
  if (slide.bullets.length > 0) {
    const colX = SLIDE_BOX.marginX + (SLIDE_SIZE.width - SLIDE_BOX.marginX * 2) * 0.66;
    const colW = SLIDE_SIZE.width - SLIDE_BOX.marginX - colX;

    slide.bullets.forEach((b, i) => {
      const runs: PptxGenJS.TextProps[] = [
        { text: b.text, options: { fontSize: 14, color: t.colors.text, fontFace: t.font } },
      ];
      if (b.citationIndex !== null) {
        runs.push({
          text: ` [${b.citationIndex}]`,
          options: {
            fontSize: 10,
            color: t.colors.citation,
            fontFace: t.font,
            superscript: true,
          },
        });
      }

      s.addText(runs, {
        x: colX,
        y: SLIDE_BOX.bodyTop + i * 0.9,
        w: colW,
        h: 0.85,
        fontSize: 14,
        color: t.colors.text,
        fontFace: t.font,
        valign: 'top',
        fit: 'none',
        wrap: true,
      });
    });
  }
}

/** 资料来源页：编号 → 文档名 + 页码 + 片段 */
function renderSources(slide: RenderSlide, s: PptxSlide): void {
  s.addText(slide.title, {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: SLIDE_BOX.titleHeight,
    fontSize: 26,
    bold: true,
    color: t.colors.text,
    fontFace: t.font,
    valign: 'middle',
  });

  s.addShape('rect', {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop + SLIDE_BOX.titleHeight + 0.05,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: 0.02,
    fill: { color: t.colors.rule },
    line: { color: t.colors.rule, width: 0 },
  });

  if (slide.citationLines.length === 0) {
    s.addText('本次内容没有可列出的原文出处。', {
      x: SLIDE_BOX.marginX,
      y: SLIDE_BOX.bodyTop,
      w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
      h: 0.6,
      fontSize: 14,
      color: t.colors.muted,
      fontFace: t.font,
    });
    return;
  }

  slide.citationLines.forEach((line, i) => {
    s.addText(line, {
      x: SLIDE_BOX.marginX,
      y: SLIDE_BOX.bodyTop + i * 0.42,
      w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
      h: 0.4,
      fontSize: 12,
      color: t.colors.text,
      fontFace: t.font,
      valign: 'middle',
      wrap: false,
    });
  });
}

/**
 * 文件名：`标题-20261105-1032-第2版.pptx`
 *
 * 为什么要带时间到分钟 + 版本号：
 * 计划书 P4 要求「重复导出不覆盖旧版本」。只带日期的话同一天导出两次就覆盖了；
 * 只有时间的话用户分不清哪个是改过的。两个都带，谁都不会弄丢。
 */
export function buildFileName(title: string, ordinal: number, at: Date = new Date()): string {
  const t = title.trim();
  const safeTitle =
    // 文件名里不能有这些字符，Windows 上直接报错
    (t.length > 0 ? t : '学习PPT').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;

  return `${safeTitle}-${stamp}-第${ordinal}版.pptx`;
}
