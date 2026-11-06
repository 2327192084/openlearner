import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationService } from '@/core/annotation-service.ts';
import {
  INK_COLORS,
  DEFAULT_INK_WIDTH,
  HIGHLIGHTER_WIDTH,
} from '@/core/annotations.ts';
import type { SourceAnnotation, InkStroke, TextNote } from '@/core/model.ts';
import { newId } from '@/core/id.ts';

/**
 * 页面注释层：画笔 + 文本框。
 *
 * ## 坐标一律用页面比例（0~1）
 *
 * 与 PPT 叠加内容同一条规矩：存像素的话换个窗口宽度、放大缩小、
 * 换个屏幕，注释就整体错位。所有点存成相对页面宽/高的比例，
 * 渲染时再乘回当前显示尺寸。
 *
 * ## 为什么画笔要单独一层 canvas，不用绝对定位的 div
 *
 * 一笔可能有几百个点。用 div/SVG 逐点渲染会在长笔迹时明显卡顿，
 * 而且频繁 setState 会让整棵阅读器重渲染。直接画在 canvas 上，
 * 拖动过程只碰 canvas 像素，React 完全不参与。
 *
 * ## 为什么松手才写库
 *
 * 画笔拖动时每帧都写 IndexedDB 会拖慢笔迹，且会产生大量写放大。
 * 松手（pointerup）时一次性保存整笔，既流畅又只写一次。
 */

type Tool = 'none' | 'pen' | 'highlighter' | 'text';

export interface AnnotationLayerProps {
  sourceId: string;
  page: number;
  /** 页面的显示尺寸（CSS 像素），画笔坐标按它换算成比例 */
  width: number;
  height: number;
  service: AnnotationService;
  /** 保存后通知上层刷新目录标记 */
  onChange?: (annotation: SourceAnnotation | null) => void;
  /** 初始注释（上层已加载好的） */
  initial?: SourceAnnotation | null;
}

export function AnnotationLayer({
  sourceId,
  page,
  width,
  height,
  service,
  onChange,
  initial,
}: AnnotationLayerProps) {
  const [annotation, setAnnotation] = useState<SourceAnnotation | null>(initial ?? null);
  const [tool, setTool] = useState<Tool>('none');
  const [color, setColor] = useState<string>(INK_COLORS[0].value);
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 当前正在画的这一笔（松手时提交） */
  const currentStroke = useRef<{ x: number; y: number }[]>([]);
  /** 文本框输入的防抖 timer，按 note id 记 */
  const noteTimers = useRef<Map<string, number>>(new Map());
  /** 画布上已提交的笔迹快照，用于撤销时重绘 */
  const committed = useRef(0);

  // 页码或资料变了：重新载入这一页的注释
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const got = await service.get(sourceId, page);
      if (cancelled) return;
      setAnnotation(got);
      committed.current = got?.strokes.length ?? 0;
      redraw(got);
    })();
    return () => {
      cancelled = true;
    };
    // redraw 是稳定引用（useCallback 无依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, page, service]);

  /** 把已保存的笔迹重绘到 canvas 上 */
  const redraw = useCallback(
    (ann: SourceAnnotation | null, extra?: InkStroke) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const strokes = [...(ann?.strokes ?? [])];
      if (extra) strokes.push(extra);
      for (const s of strokes) drawStroke(ctx, s, canvas.width, canvas.height);
    },
    [],
  );

  // 尺寸变化时重绘（窗口缩放、zoom 改变）
  useEffect(() => {
    redraw(annotation);
  }, [width, height, annotation, redraw]);

  /** 指针位置转成页面比例 */
  const toRatio = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0,
      y: rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool !== 'pen' && tool !== 'highlighter') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing(true);
    currentStroke.current = [toRatio(e)];
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || (tool !== 'pen' && tool !== 'highlighter')) return;
    const p = toRatio(e);
    currentStroke.current.push(p);
    // 只重画「已提交 + 当前这一笔」，拖动过程不写库
    const live: InkStroke = {
      points: currentStroke.current,
      color,
      width: tool === 'highlighter' ? HIGHLIGHTER_WIDTH : DEFAULT_INK_WIDTH,
      ...(tool === 'highlighter' ? { highlighter: true } : {}),
    };
    redraw(annotation, live);
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    setDrawing(false);
    const points = currentStroke.current;
    currentStroke.current = [];
    // 点一下没动不算一笔（避免留下看不见的杂点）
    if (points.length < 2) {
      redraw(annotation);
      return;
    }

    const stroke: InkStroke = {
      points,
      color,
      width: tool === 'highlighter' ? HIGHLIGHTER_WIDTH : DEFAULT_INK_WIDTH,
      ...(tool === 'highlighter' ? { highlighter: true } : {}),
    };

    setSaving(true);
    try {
      const saved = await service.addStroke(sourceId, page, stroke);
      setAnnotation(saved);
      committed.current = saved?.strokes.length ?? 0;
      redraw(saved);
      onChange?.(saved);
    } finally {
      setSaving(false);
    }
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  /** 撤销最后一笔 */
  const undo = async () => {
    setSaving(true);
    try {
      const saved = await service.undoLastStroke(sourceId, page);
      setAnnotation(saved);
      redraw(saved);
      onChange?.(saved);
    } finally {
      setSaving(false);
    }
  };

  /** 加一个文本框到页面中央 */
  const addText = async () => {
    const note: TextNote = {
      id: newId('note'),
      text: '',
      x: 0.3,
      y: 0.45,
      w: 0.4,
      h: 0.08,
      fontSize: 0.022,
      color: '#111827',
      background: '#fffbeb',
    };
    setSaving(true);
    try {
      const saved = await service.addText(sourceId, page, note);
      setAnnotation(saved);
      onChange?.(saved);
    } finally {
      setSaving(false);
    }
  };

  const updateNote = async (id: string, patch: Partial<Omit<TextNote, 'id'>>) => {
    const saved = await service.updateText(sourceId, page, id, patch);
    setAnnotation(saved);
    onChange?.(saved);
  };

  const removeNote = async (id: string) => {
    const saved = await service.removeText(sourceId, page, id);
    setAnnotation(saved);
    onChange?.(saved);
  };

  const clearAll = async () => {
    await service.clearPage(sourceId, page);
    setAnnotation(null);
    redraw(null);
    onChange?.(null);
  };

  const strokeCount = annotation?.strokes.length ?? 0;
  const textCount = annotation?.texts.length ?? 0;

  return (
    <div className="annot">
      {/* 工具栏 */}
      <div className="annot__bar">
        <span className="annot__group">
          <button
            type="button"
            className={`btn btn--sm${tool === 'pen' ? ' btn--primary' : ''}`}
            onClick={() => setTool(tool === 'pen' ? 'none' : 'pen')}
            title="画笔：在页面上写字做标记"
          >
            画笔
          </button>
          <button
            type="button"
            className={`btn btn--sm${tool === 'highlighter' ? ' btn--primary' : ''}`}
            onClick={() => setTool(tool === 'highlighter' ? 'none' : 'highlighter')}
            title="荧光笔：半透明划重点"
          >
            荧光笔
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void addText()}>
            + 文本框
          </button>
        </span>

        <span className="annot__group">
          {INK_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`annot__swatch${color === c.value ? ' annot__swatch--on' : ''}`}
              style={{ background: c.value }}
              onClick={() => setColor(c.value)}
              title={c.label}
              aria-label={`${c.label}色`}
            />
          ))}
        </span>

        <span className="annot__group">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void undo()}
            disabled={strokeCount === 0 || saving}
            title="撤销最后一笔"
          >
            撤销
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void clearAll()}
            disabled={strokeCount === 0 && textCount === 0}
            title="清空这一页的全部注释"
          >
            清空本页
          </button>
        </span>

        {saving ? <span className="page__muted">保存中…</span> : null}
        {!saving && (strokeCount > 0 || textCount > 0) ? (
          <span className="page__muted">
            已存 {strokeCount} 笔{textCount > 0 ? ` · ${textCount} 个文本框` : ''}
          </span>
        ) : null}
      </div>

      {/*
        画布铺满页面。
        只有选中画笔类工具时才接收指针事件 —— 否则用户想点页面上的
        文字/链接会被画布挡住（pointer-events: none 时点击穿透）。
      */}
      <canvas
        ref={canvasRef}
        className="annot__canvas"
        width={Math.max(1, Math.round(width))}
        height={Math.max(1, Math.round(height))}
        style={{
          pointerEvents: tool === 'pen' || tool === 'highlighter' ? 'auto' : 'none',
          cursor: tool === 'pen' || tool === 'highlighter' ? 'crosshair' : 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => void onPointerUp(e)}
        onPointerCancel={() => {
          setDrawing(false);
          currentStroke.current = [];
          redraw(annotation);
        }}
      />

      {/* 文本框：可编辑，失焦时保存 */}
      {annotation?.texts.map((t) => (
        <div
          key={t.id}
          className="annot__note"
          style={{
            left: `${t.x * 100}%`,
            top: `${t.y * 100}%`,
            width: `${t.w * 100}%`,
            height: `${t.h * 100}%`,
            fontSize: `${Math.max(11, t.fontSize * height)}px`,
            color: t.color,
            background: t.background ?? 'transparent',
          }}
        >
          <textarea
            className="annot__note-input"
            defaultValue={t.text}
            placeholder="输入注释…"
            /*
              边输边存（防抖 600ms）。
              只靠 onBlur 会丢内容：用户输完直接翻页/关窗口，输入框
              从没失去焦点，内容就永远不落库。这类「看起来存了其实没存」
              比没做这个功能更糟。
            */
            onChange={(e) => {
              const v = e.target.value;
              if (noteTimers.current.has(t.id)) {
                window.clearTimeout(noteTimers.current.get(t.id));
              }
              noteTimers.current.set(
                t.id,
                window.setTimeout(() => {
                  noteTimers.current.delete(t.id);
                  void updateNote(t.id, { text: v });
                }, 600),
              );
            }}
            onBlur={(e) => {
              const v = e.target.value;
              const timer = noteTimers.current.get(t.id);
              if (timer) {
                window.clearTimeout(timer);
                noteTimers.current.delete(t.id);
              }
              if (v !== t.text) void updateNote(t.id, { text: v });
            }}
          />
          <button
            type="button"
            className="annot__note-del"
            onClick={() => void removeNote(t.id)}
            title="删除这个文本框"
            aria-label="删除文本框"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** 把一笔画到 canvas 上 */
function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  w: number,
  h: number,
): void {
  const pts = stroke.points;
  if (pts.length === 0) return;

  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.globalAlpha = stroke.highlighter ? 0.35 : 1;
  ctx.lineWidth = Math.max(1, stroke.width * w);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  // 按当前画布尺寸把比例坐标还原成像素
  ctx.moveTo(pts[0]!.x * w, pts[0]!.y * h);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x * w, pts[i]!.y * h);
  }
  ctx.stroke();
  ctx.restore();
}
