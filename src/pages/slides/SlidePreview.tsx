import { useState } from 'react';
import type { SlideCitation, SlideDeck } from '@/core/model.ts';
import { SLIDE_SIZE } from '@/core/slides/render-plan.ts';
import type { RenderSlide } from '@/core/slides/render-plan.ts';
import { SourcePeek } from '../practice/SourcePeek.tsx';

/**
 * 幻灯片预览。
 *
 * 核心约束：**这里不做任何自己的排版计算**。
 * 页面结构、每页放什么、页数全部来自 `getPlan()`（= buildRenderPlan），
 * 预览只负责把 `SLIDE_SIZE` / `SLIDE_BOX` 的英寸坐标按比例画出来。
 *
 * 为什么这点值得写一大段注释：预览用 CSS、导出用 pptxgenjs 绝对坐标，
 * 如果两边各算一套布局，出问题时表现为「预览 12 页、导出 14 页」，
 * 或者预览里一行放得下、导出里被挤成两行。这类偏差人工翻一遍极难发现，
 * 所以规则是：**影响页数/内容的逻辑只有 render-plan 一处，界面只做等比映射**。
 *
 * 换算方式：容器固定 `aspect-ratio: SLIDE_SIZE`，内部所有尺寸与字号都用
 * 容器查询单位 `cqw`（1cqw = 容器宽度的 1%），于是：
 *   英寸 x → (x / SLIDE_SIZE.width) * 100 cqw
 *   磅号 p → 在 PowerPoint 里 1 英寸 = 72 磅，
 *            故 (p / 72) 英寸 → (p / 72 / SLIDE_SIZE.width) * 100 cqw
 * 这样同一个 div 在任何屏幕宽度下都是同一份版式，不会因为容器缩放而错位。
 */

const W = SLIDE_SIZE.width;

/** 英寸 → 容器宽度百分比（用于 left/width/top/height 任意一处） */
function pct(inches: number): string {
  return `${(inches / W) * 100}cqw`;
}

/** 磅 → cqw。字号专用：pt 先除以 72 变英寸，再按画布宽度换算。 */
function fontPt(pt: number): string {
  return `${(pt / 72 / W) * 100}cqw`;
}

/** 导出侧使用的主色（与 pptx-export.ts 的 THEME 保持一致，改一处要两边同步） */
const THEME = {
  text: '#1A1A1A',
  muted: '#6B7280',
  accent: '#1E5FAA',
  citation: '#8A6D3B',
  rule: '#D8DEE8',
  bg: '#FFFFFF',
  titleBg: '#0F2A4A',
  titleText: '#FFFFFF',
  subtitle: '#A8C0DC',
};

/** 与 pptx-export.ts 的 renderBullets 相同的行距常量（英寸） */
const BULLET_ROW_H = 0.86;
const BULLET_TEXT_H = 0.8;
const SOURCES_ROW_H = 0.42;

export interface SlidePreviewProps {
  deck: SlideDeck;
  plan: RenderSlide[];
}

export function SlidePreview({ deck, plan }: SlidePreviewProps) {
  // 点角标时展开的那条出处；用 citation index 而不是位置，重排后仍然指得对
  const [peek, setPeek] = useState<SlideCitation | null>(null);

  if (plan.length === 0) {
    return (
      <div className="notice notice--warning">
        <div className="notice__title">还没有可预览的内容</div>
        <div className="notice__body">这份大纲是空的，先在上面加一页再回来看。</div>
      </div>
    );
  }

  /** 角标编号 → 引用。找不到时角标只画文字不响应点击，并在页脚提示。 */
  const citationByIndex = new Map<number, SlideCitation>();
  for (const c of deck.citations) citationByIndex.set(c.index, c);

  const missing = plan.reduce((n, slide) => {
    for (const b of slide.bullets) {
      if (b.citationIndex !== null && !citationByIndex.has(b.citationIndex)) n += 1;
    }
    return n;
  }, 0);

  return (
    <div className="sl-preview">
      <div className="sl-preview__meta">
        <span>
          共 <strong>{plan.length}</strong> 页（含 {(plan.filter((s) => s.layout === 'sources')).length} 页自动生成的资料来源页）
        </span>
        <span className="page__muted">这里看到的就是导出后的样子</span>
      </div>

      {missing > 0 ? (
        <div className="notice notice--danger">
          <div className="notice__title">有 {missing} 个角标在引用表里找不到对应记录</div>
          <div className="notice__body">
            这些角标暂时点不开。通常是数据被外部改过；改一下这一页的要点文字会触发重新整理，或者重新生成一份大纲。
          </div>
        </div>
      ) : null}

      <div className="sl-preview__list">
        {plan.map((slide) => (
          <figure className="sl-preview__item" key={`${slide.pageNumber}-${slide.layout}-${slide.title}`}>
            <div className="sl-card" data-slide-preview data-page-number={slide.pageNumber}>
              <SlideFace slide={slide} citationByIndex={citationByIndex} onCitation={setPeek} />
            </div>
            <figcaption className="sl-preview__caption">
              第 {slide.pageNumber} 页 · {layoutName(slide.layout)}
            </figcaption>
          </figure>
        ))}
      </div>

      {peek ? <CitationPeek citation={peek} onClose={() => setPeek(null)} /> : null}
    </div>
  );
}

function layoutName(layout: RenderSlide['layout']): string {
  if (layout === 'title') return '封面';
  if (layout === 'section') return '章节';
  if (layout === 'bullets') return '要点';
  return '资料来源';
}

/** 一张幻灯片。尺寸全部由 SLIDE_SIZE / SLIDE_BOX 换算而来。 */
function SlideFace({
  slide,
  citationByIndex,
  onCitation,
}: {
  slide: RenderSlide;
  citationByIndex: Map<number, SlideCitation>;
  onCitation: (c: SlideCitation) => void;
}) {
  if (slide.layout === 'title') {
    return (
      <div className="sl-card__face sl-card__face--title" style={{ background: THEME.titleBg }}>
        <div
          className="sl-card__title-text"
          style={{
            left: pct(1.1),
            top: pct(2.5),
            width: pct(SLIDE_SIZE.width - 2.2),
            height: pct(1.7),
            fontSize: fontPt(40),
            color: THEME.titleText,
            justifyContent: 'flex-end',
          }}
        >
          {slide.title}
        </div>
        {/* 装饰线：导出里是 y=4.25 的矩形，这里同样画一条 */}
        <div
          style={{
            position: 'absolute',
            left: pct(1.1),
            top: pct(4.25),
            width: pct(1.6),
            height: pct(0.045),
            background: THEME.accent,
          }}
        />
        {slide.subtitle ? (
          <div
            style={{
              position: 'absolute',
              left: pct(1.1),
              top: pct(4.35),
              width: pct(SLIDE_SIZE.width - 2.2),
              height: pct(0.7),
              fontSize: fontPt(16),
              color: THEME.subtitle,
            }}
          >
            {slide.subtitle}
          </div>
        ) : null}
      </div>
    );
  }

  if (slide.layout === 'section') {
    return (
      <div className="sl-card__face">
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: pct(0.14),
            height: '100%',
            background: THEME.accent,
          }}
        />
        <div
          className="sl-card__title-text"
          style={{
            left: pct(1.1),
            top: pct(2.9),
            width: pct(SLIDE_SIZE.width - 2.2),
            height: pct(1.6),
            fontSize: fontPt(32),
            color: THEME.text,
            justifyContent: 'center',
          }}
        >
          {slide.title}
        </div>
      </div>
    );
  }

  const isSources = slide.layout === 'sources';
  const rowHeightInch = isSources ? SOURCES_ROW_H : BULLET_ROW_H;

  return (
    <div className="sl-card__face">
      <div
        className="sl-card__title-text"
        style={{
          left: pct(0.85),
          top: pct(0.55),
          width: pct(SLIDE_SIZE.width - 0.85 * 2),
          height: pct(0.95),
          fontSize: fontPt(26),
          color: THEME.text,
          justifyContent: 'center',
        }}
      >
        {slide.title}
      </div>

      {/* 分隔线：导出里 y = titleTop + titleHeight + 0.05 */}
      <div
        style={{
          position: 'absolute',
          left: pct(0.85),
          top: pct(0.55 + 0.95 + 0.05),
          width: pct(SLIDE_SIZE.width - 0.85 * 2),
          height: pct(0.02),
          background: THEME.rule,
        }}
      />

      {isSources ? (
        slide.citationLines.length === 0 ? (
          <div
            style={{
              position: 'absolute',
              left: pct(0.85),
              top: pct(1.75),
              fontSize: fontPt(14),
              color: THEME.muted,
            }}
          >
            本次内容没有可列出的原文出处。
          </div>
        ) : (
          slide.citationLines.map((line, i) => (
            <div
              key={line}
              className="sl-card__source-line"
              style={{
                left: pct(0.85),
                top: pct(1.75 + i * rowHeightInch),
                width: pct(SLIDE_SIZE.width - 0.85 * 2),
                height: pct(0.4),
                fontSize: fontPt(12),
                color: THEME.text,
              }}
            >
              {line}
            </div>
          ))
        )
      ) : (
        slide.bullets.map((bullet, i) => {
          const citation = bullet.citationIndex === null ? null : citationByIndex.get(bullet.citationIndex) ?? null;
          return (
            <div
              key={`${bullet.text}-${i}`}
              className="sl-card__bullet"
              style={{
                left: pct(0.85),
                top: pct(1.75 + i * rowHeightInch),
                width: pct(SLIDE_SIZE.width - 0.85 * 2),
                height: pct(BULLET_TEXT_H),
                fontSize: fontPt(18),
                color: THEME.text,
              }}
            >
              <span>{bullet.text}</span>
              {bullet.citationIndex !== null ? (
                citation ? (
                  <button
                    type="button"
                    className="sl-card__cite"
                    style={{ fontSize: fontPt(12), color: THEME.citation }}
                    onClick={() => onCitation(citation)}
                    title={`查看出处：《${citation.sourceTitle}》`}
                  >
                    [{bullet.citationIndex}]
                  </button>
                ) : (
                  <span className="sl-card__cite sl-card__cite--missing" style={{ fontSize: fontPt(12) }}>
                    [{bullet.citationIndex}]
                  </span>
                )
              ) : null}
            </div>
          );
        })
      )}

      {/* 页脚：导出侧条件是 `slide.footer || layout !== 'title'`。
          这里已经排除了 title 版式，所以条件恒真，直接渲染即可。 */}
      {(
        <>
          <div
            style={{
              position: 'absolute',
              left: pct(0.85),
              top: pct(6.75),
              width: pct(8),
              height: pct(0.4),
              fontSize: fontPt(9),
              color: THEME.muted,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {slide.footer}
          </div>
          <div
            style={{
              position: 'absolute',
              left: pct(SLIDE_SIZE.width - 0.85 - 1),
              top: pct(6.75),
              width: pct(1),
              height: pct(0.4),
              fontSize: fontPt(9),
              color: THEME.muted,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            {slide.pageNumber}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 点角标后的出处面板。
 *
 * 复用练习页（P3）的 SourcePeek：它就是项目里唯一「跳到原文」的成熟实现，
 * 定段 → 按字符偏移切片 → 高亮，找不到段落时明确说找不到而不是退回第一页。
 * 这里不另写一套，否则两处的「找不到原文」行为会不一致。
 */
function CitationPeek({ citation, onClose }: { citation: SlideCitation; onClose: () => void }) {
  return (
    <div className="sl-peek-wrap">
      <SourcePeek
        sourceId={citation.sourceId}
        anchor={{
          sourceId: citation.sourceId,
          ...(citation.page !== null ? { page: citation.page } : {}),
          ...(citation.chapter !== null ? { chapter: citation.chapter } : {}),
        }}
        onClose={onClose}
      />
      <div className="sl-peek-wrap__note">
        角标 [{citation.index}] 指向《{citation.sourceTitle}》
        {citation.page !== null ? ` 第 ${citation.page} 页` : ''}
        {citation.chapter ? `「${citation.chapter}」` : ''}
        。这条知识点只记了页码与引用片段，没有字符偏移，所以原文里高亮的是整页开头一段。
      </div>
    </div>
  );
}
