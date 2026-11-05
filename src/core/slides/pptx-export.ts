import PptxGenJS from 'pptxgenjs';
import type { SlideDeck } from '../model.ts';
import {
  buildRenderPlan,
  SLIDE_BOX,
  SLIDE_SIZE,
  type RenderSlide,
} from './render-plan.ts';

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

/** 配色。深色文字 + 一个主色，避免花哨 */
const THEME = {
  text: '1A1A1A',
  muted: '6B7280',
  accent: '1E5FAA',
  citation: '8A6D3B',
  rule: 'D8DEE8',
  bg: 'FFFFFF',
  titleBg: '0F2A4A',
  titleText: 'FFFFFF',
} as const;

/** 字体。中文优先思源/雅黑，回退到系统默认 */
const FONT = 'Microsoft YaHei';

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
 */
export async function exportToPptx(deck: SlideDeck, ordinal = 1): Promise<ExportResult> {
  const plan = buildRenderPlan(deck, deck.title);
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

/** 按版式渲染一页 */
function renderSlide(pptx: PptxGenJS, slide: RenderSlide): void {
  const s = pptx.addSlide();
  s.background = { color: THEME.bg };

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
  }

  // 页脚：资料名 + 页码（封面页不显示，和正规幻灯片一致）
  if (slide.footer || slide.layout !== 'title') {
    if (slide.footer) {
      s.addText(slide.footer, {
        x: SLIDE_BOX.marginX,
        y: SLIDE_BOX.footerTop,
        w: 8,
        h: SLIDE_BOX.footerHeight,
        fontSize: 9,
        color: THEME.muted,
        fontFace: FONT,
        valign: 'middle',
      });
    }
    s.addText(String(slide.pageNumber), {
      x: SLIDE_SIZE.width - SLIDE_BOX.marginX - 1,
      y: SLIDE_BOX.footerTop,
      w: 1,
      h: SLIDE_BOX.footerHeight,
      fontSize: 9,
      color: THEME.muted,
      fontFace: FONT,
      align: 'right',
      valign: 'middle',
    });
  }
}

type PptxSlide = ReturnType<PptxGenJS['addSlide']>;

/** 封面页：深色底 + 大标题 + 副标题 */
function renderTitle(slide: RenderSlide, s: PptxSlide): void {
  s.background = { color: THEME.titleBg };
  s.addText(slide.title, {
    x: 1.1,
    y: 2.5,
    w: SLIDE_SIZE.width - 2.2,
    h: 1.7,
    fontSize: 40,
    bold: true,
    color: THEME.titleText,
    fontFace: FONT,
    valign: 'bottom',
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 1.1,
      y: 4.35,
      w: SLIDE_SIZE.width - 2.2,
      h: 0.7,
      fontSize: 16,
      color: 'A8C0DC',
      fontFace: FONT,
      valign: 'top',
    });
  }
  // 一条细色线作装饰，别多
  s.addShape('rect', {
    x: 1.1,
    y: 4.25,
    w: 1.6,
    h: 0.045,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 },
  });
}

/** 章节过渡页：大号章节名居中偏左 */
function renderSection(slide: RenderSlide, s: PptxSlide): void {
  s.addShape('rect', {
    x: 0,
    y: 0,
    w: 0.14,
    h: SLIDE_SIZE.height,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 },
  });
  s.addText(slide.title, {
    x: 1.1,
    y: 2.9,
    w: SLIDE_SIZE.width - 2.2,
    h: 1.6,
    fontSize: 32,
    bold: true,
    color: THEME.text,
    fontFace: FONT,
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
    color: THEME.text,
    fontFace: FONT,
    valign: 'middle',
  });

  s.addShape('rect', {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop + SLIDE_BOX.titleHeight + 0.05,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: 0.02,
    fill: { color: THEME.rule },
    line: { color: THEME.rule, width: 0 },
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
      { text: b.text, options: { fontSize: 18, color: THEME.text, fontFace: FONT } },
    ];
    if (b.citationIndex !== null) {
      runs.push({
        text: ` [${b.citationIndex}]`,
        options: {
          fontSize: 12,
          color: THEME.citation,
          fontFace: FONT,
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
      color: THEME.text,
      fontFace: FONT,
      valign: 'top',
      // 单条要点内部自动换行，不缩字号：缩了不同页字号不一致，翻页会跳
      fit: 'none',
      wrap: true,
    });
  });
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
    color: THEME.text,
    fontFace: FONT,
    valign: 'middle',
  });

  s.addShape('rect', {
    x: SLIDE_BOX.marginX,
    y: SLIDE_BOX.titleTop + SLIDE_BOX.titleHeight + 0.05,
    w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
    h: 0.02,
    fill: { color: THEME.rule },
    line: { color: THEME.rule, width: 0 },
  });

  if (slide.citationLines.length === 0) {
    s.addText('本次内容没有可列出的原文出处。', {
      x: SLIDE_BOX.marginX,
      y: SLIDE_BOX.bodyTop,
      w: SLIDE_SIZE.width - SLIDE_BOX.marginX * 2,
      h: 0.6,
      fontSize: 14,
      color: THEME.muted,
      fontFace: FONT,
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
      color: THEME.text,
      fontFace: FONT,
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
