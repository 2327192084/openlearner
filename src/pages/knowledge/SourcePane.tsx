import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { Badge } from '@/components/states.tsx';
import type { KnowledgePoint, Source, SourceSegment } from '@/core/model.ts';
import { SliceText } from './SliceText.tsx';
import type { SliceRange } from './SliceText.tsx';

/**
 * 校对界面左栏：原文 + 命中处高亮。
 *
 * 三条要求落在这里：
 *  1. 显示的是**该资料某一段的完整正文**（不是摘录、不是摘要）——
 *     校对的前提是能用眼睛比对整段文字。
 *  2. 高亮用 charStart/charEnd 精确切分（见 SliceText），
 *     偏移相对 `SourceSegment.text`，与 anchors 同一套坐标。
 *  3. 只高亮**本段**的锚点：别的页上的锚点在这里画不出来，
 *     硬画会得到一条从头到尾的假高亮。
 *
 * 为什么「当前选中」的高亮单独区分：一页上可能同时命中好几条知识点，
 * 用户点了「看原文」后要能一眼找回是哪一条，否则满屏同色高亮等于没有高亮。
 */

export function SourcePane({
  source,
  segments,
  currentIndex,
  onNavigate,
  points,
  activePoint,
  articleRef,
}: {
  source: Source;
  segments: SourceSegment[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  /** 这份资料的全部知识点，用于在本段上画出所有命中的高亮 */
  points: KnowledgePoint[];
  /** 当前选中的知识点（右侧点击卡片或在卡片里点「看原文」） */
  activePoint: KnowledgePoint | null;
  /** 把正文容器交回父组件，用于「用选中的文字」取选区 */
  articleRef: RefObject<HTMLDivElement | null>;
}) {
  const segment = segments[currentIndex];
  const activeMarkRef = useRef<HTMLElement | null>(null);

  /** 所有落在本段上的锚点范围 */
  const allRanges: SliceRange[] = useMemo(() => {
    if (!segment) return [];
    const out: SliceRange[] = [];
    for (const point of points) {
      for (const anchor of point.anchors) {
        if (anchor.page !== segment.page) continue;
        if (anchor.charStart === undefined || anchor.charEnd === undefined) continue;
        out.push({ charStart: anchor.charStart, charEnd: anchor.charEnd });
      }
    }
    return out;
  }, [points, segment]);

  /**
   * 当前选中知识点在本段的高亮。
   * 取全部锚点里落在本段的第一条 —— 一条知识点可能引了多处原文，
   * 落在别段的那几处不该在这里画。
   */
  const activeRange: SliceRange | null = useMemo(() => {
    if (!segment || !activePoint) return null;
    for (const anchor of activePoint.anchors) {
      if (anchor.page !== segment.page) continue;
      if (anchor.charStart === undefined || anchor.charEnd === undefined) continue;
      return { charStart: anchor.charStart, charEnd: anchor.charEnd };
    }
    return null;
  }, [activePoint, segment]);

  // 切换知识点或翻页后，把当前高亮滚进视野。
  // 用 scrollIntoView 而不是算 offsetTop：正文容器与外层滚动容器都可能变，
  // 算偏移容易差一截（P1 阅读器踩过这个坑）。
  useEffect(() => {
    if (!activeRange) return;
    const el = activeMarkRef.current;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeRange, currentIndex, activePoint?.id]);

  if (!segment) {
    return (
      <div className="card kp-pane">
        <div className="card__body">
          <div className="page__muted">这份资料没有可显示的正文段落。</div>
        </div>
      </div>
    );
  }

  const hitCount = allRanges.length;

  return (
    <div className="card kp-pane">
      <div className="kp-pane__head">
        <div className="kp-pane__head-info">
          <strong>
            第 {segment.page} 页
            {segments.length > 1 ? (
              <span className="page__muted"> / 共 {segments.length} 段</span>
            ) : null}
          </strong>
          {segment.chapter ? <Badge tone="neutral">{segment.chapter}</Badge> : null}
          <span className="page__muted">{segment.charCount} 字</span>
          {hitCount > 0 ? (
            <Badge tone="info">本段有 {hitCount} 处知识点锚点</Badge>
          ) : null}
        </div>

        <div className="page__row" style={{ flex: 'none' }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onNavigate(currentIndex - 1)}
            disabled={currentIndex <= 0}
            title="上一页"
          >
            ← 上一页
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onNavigate(currentIndex + 1)}
            disabled={currentIndex >= segments.length - 1}
            title="下一页"
          >
            下一页 →
          </button>
        </div>
      </div>

      {/* 段选择：切到任意一页，不依赖上一页/下一页点很多次 */}
      <div className="kp-pane__jump">
        <label className="page__muted" htmlFor="kp-segment-select">
          跳到
        </label>
        <select
          id="kp-segment-select"
          className="select select--sm"
          value={currentIndex}
          onChange={(e) => onNavigate(Number(e.target.value))}
        >
          {segments.map((seg, i) => (
            <option key={seg.id} value={i}>
              第 {seg.page} 段{seg.chapter ? ` · ${seg.chapter}` : ''}
            </option>
          ))}
        </select>
        <span className="page__muted">
          原文来自「{source.title}」，与资料库阅读器是同一份正文。
        </span>
      </div>

      <div
        className="kp-pane__body"
        ref={articleRef}
        tabIndex={0}
        aria-label={`第 ${segment.page} 段原文`}
      >
        <SliceText
          text={segment.text}
          ranges={allRanges}
          activeRange={activeRange}
          activeRef={(el) => {
            activeMarkRef.current = el;
          }}
        />
      </div>

      {segment.text.trim() === '' ? (
        <div className="kp-pane__empty">
          这一段没有文字（可能是扫描件的一页）。没有文字就无法校对位置。
        </div>
      ) : null}
    </div>
  );
}
