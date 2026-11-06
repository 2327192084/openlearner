import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AnnotationService } from '@/core/annotation-service.ts';
import { AnnotationLayer } from './AnnotationLayer.tsx';

/**
 * 给任意内容盖一层批注。
 *
 * ## 为什么需要它
 *
 * 批注层原本只挂在 PDF 的页面图上（因为那里有明确的"页面边界"）。
 * 但用户对 Word、Markdown、纯文本资料同样想写字做标记 ——
 * 那些资料没有页面图，内容是流式的文字。
 *
 * 解决办法：把内容本身当成一块"页面"。文字排版有多高，批注画布就多大，
 * 坐标仍然存 0~1 比例。这样：
 *  - 批注跟着内容走（内容变长，画布跟着变高，注释按比例仍在原处）
 *  - 不用为每种格式各写一套批注逻辑
 *
 * ## 为什么不直接在 SourceReader 里写
 *
 * 尺寸测量与重测（窗口缩放、内容变化）这段逻辑是通用的，
 * 抽出来才能保证 PDF 与文字两条路径行为一致 ——
 * 两边各写一套，必然出现"PDF 上注释不漂、文字上漂"这类不一致。
 */
export function AnnotatedBox({
  sourceId,
  page,
  service,
  children,
  onChange,
  /** 是否跟随内容高度（文字资料用）；false 时由子元素自己撑开（PDF 图用） */
  fitContent = true,
}: {
  sourceId: string;
  page: number;
  service: AnnotationService;
  children: ReactNode;
  onChange?: () => void;
  fitContent?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /**
   * 量内容区尺寸。
   *
   * 用 getBoundingClientRect 而不是 offsetWidth：前者是真实渲染尺寸，
   * 在有缩放或 border 时更准（offsetWidth 会取整并含边框）。
   */
  const measure = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      setSize((prev) =>
        // 尺寸没变就不 setState，避免 ResizeObserver 与渲染互相触发
        Math.round(prev.width) === Math.round(r.width) &&
        Math.round(prev.height) === Math.round(r.height)
          ? prev
          : { width: Math.round(r.width), height: Math.round(r.height) },
      );
    }
  }, []);

  useEffect(() => {
    measure();
  }, [measure, children]);

  /**
   * 内容尺寸变化时重测。
   *
   * 文字资料的内容高度取决于字号、窗口宽度、分段数量 ——
   * 不监听的话，用户缩小窗口后文字变高，批注还按旧尺寸算，就会错位。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={boxRef}
      className="annot-box"
      style={fitContent ? undefined : { position: 'relative' }}
    >
      {children}
      {size.width > 0 && size.height > 0 ? (
        <AnnotationLayer
          sourceId={sourceId}
          page={page}
          width={size.width}
          height={size.height}
          service={service}
          onChange={() => onChange?.()}
        />
      ) : null}
    </div>
  );
}
