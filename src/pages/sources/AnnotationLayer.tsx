import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationService } from '@/core/annotation-service.ts';
import { INK_COLORS } from '@/core/annotations.ts';
import {
  PEN_WIDTHS,
  PEN_LABELS,
  SHAPE_LABELS,
  strokeHitByEraser,
  strokeCaughtByLasso,
  shapeCaughtByLasso,
  translateStroke,
  translateShape,
  simplifyStroke,
  strokeBounds,
  shapeBounds,
} from '@/core/annotation-geometry.ts';
import type { Pt } from '@/core/annotation-geometry.ts';
import { drawStroke, drawShape, drawLasso, drawSelectionBox } from './annotation-render.ts';
import type {
  SourceAnnotation,
  InkStroke,
  TextNote,
  ShapeElement,
  ShapeKind,
  PenKind,
} from '@/core/model.ts';
import { newId } from '@/core/id.ts';

/**
 * 页面注释层：五种笔形 + 擦除 + 套索 + 图形 + 文本框。
 *
 * ## 工具语义
 *
 * | 工具 | 按下-拖动-抬起 |
 * |---|---|
 * | 钢笔/马克笔/荧光笔/铅笔/激光 | 画一笔 |
 * | 橡皮 | 划过即擦（按笔宽 + 容差判定命中） |
 * | 套索 | 框选后整体移动或删除 |
 * | 直线/箭头/矩形/椭圆 | 拖出图形 |
 * | 文本框 | 点击新增 |
 *
 * ## 为什么擦除是「划过即擦」而不是「点一下删一笔」
 *
 * 点一下删整笔在长笔迹上很反直觉：用户只想擦掉一个错字，整行却没了。
 * 划过即擦配撤销用起来更像真实橡皮。
 *
 * ## 为什么拖动过程不写库
 *
 * 画笔每帧写 IndexedDB 会拖慢笔迹；套索移动每帧写更糟（一次拖动几十次写）。
 * 松手时一次性提交，流畅且只写一次。
 */

type Tool = 'none' | 'eraser' | 'lasso' | 'text' | ShapeKind;

export interface AnnotationLayerProps {
  sourceId: string;
  page: number;
  width: number;
  height: number;
  service: AnnotationService;
  onChange?: (annotation: SourceAnnotation | null) => void;
  initial?: SourceAnnotation | null;
}

/** 拖拽中的临时预览状态 */
interface Preview {
  liveStroke?: InkStroke;
  liveShape?: ShapeElement;
  lasso?: Pt[];
  selectionBox?: { x1: number; y1: number; x2: number; y2: number };
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
  const [pen, setPen] = useState<PenKind>('pen');
  const [color, setColor] = useState<string>(INK_COLORS[0].value);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** 最近一次套索选中的元素，供「移动 / 删除选中」用 */
  const [selected, setSelected] = useState<{ strokes: InkStroke[]; shapes: ShapeElement[] }>({
    strokes: [],
    shapes: [],
  });

  /**
   * 工具状态也用 ref 存一份，事件里读 ref。
   *
   * 为什么不能只靠闭包里的 `tool`：画布事件是原生 PointerEvent 监听，
   * React 的合成事件绑定在每次 render 上，但连续快速的
   * pointerdown → pointermove → pointerup 之间如果发生了一次重渲染，
   * 后两个事件可能还跑在旧闭包里，读到上一轮的工具值。
   * 实测症状：选「矩形」拖出来却是一条笔迹。
   */
  const toolRef = useRef<Tool>('none');
  const penRef = useRef<PenKind>('pen');
  const colorRef = useRef<string>(INK_COLORS[0].value);

  /**
   * 同步 ref **立即**写入，不放在 useEffect 里。
   *
   * useEffect 是在 render 提交之后才跑的，而 pointerdown → pointerup
   * 可能发生在两次 render 之间：那时 ref 还是旧值，事件处理读到上一轮的
   * 工具，于是「选了矩形却画出笔迹」或「什么都不提交」。
   * 直接赋值没有这个窗口。
   */
  toolRef.current = tool;
  penRef.current = pen;
  colorRef.current = color;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentStroke = useRef<Pt[]>([]);
  const lassoPoints = useRef<Pt[]>([]);
  const dragStart = useRef<Pt | null>(null);
  const noteTimers = useRef<Map<string, number>>(new Map());

  // 载入这一页的注释
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const got = await service.get(sourceId, page);
      if (cancelled) return;
      setAnnotation(got);
      setPreview(null);
      setSelected({ strokes: [], shapes: [] });
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, page, service]);

  /** 把所有内容画到 canvas 上 */
  const redraw = useCallback((ann: SourceAnnotation | null, pv: Preview | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const s of ann?.strokes ?? []) drawStroke(ctx, s, w, h);
    for (const s of ann?.shapes ?? []) drawShape(ctx, s, w, h);

    if (pv?.liveStroke) {
      drawStroke(ctx, pv.liveStroke, w, h, pv.liveStroke.kind === 'laser');
    }
    if (pv?.liveShape) drawShape(ctx, pv.liveShape, w, h);
    if (pv?.lasso && pv.lasso.length > 1) drawLasso(ctx, pv.lasso, w, h);
    if (pv?.selectionBox) drawSelectionBox(ctx, pv.selectionBox, w, h);
  }, []);

  useEffect(() => {
    redraw(annotation, preview);
  }, [width, height, annotation, preview, redraw]);

  // 切页时清掉临时状态
  useEffect(() => {
    setPreview(null);
    lassoPoints.current = [];
    dragStart.current = null;
  }, [page, sourceId]);

  const toRatio = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0,
      y: rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0,
    };
  };

  const commit = async (next: {
    strokes: InkStroke[];
    texts: TextNote[];
    /** 可选：老记录里没有这个字段，读出来是 undefined */
    shapes?: ShapeElement[];
  }) => {
    setSaving(true);
    try {
      const saved = await service.replacePage(sourceId, page, {
        strokes: next.strokes,
        texts: next.texts,
        shapes: next.shapes ?? [],
      });
      setAnnotation(saved);
      onChange?.(saved);
    } finally {
      setSaving(false);
    }
  };

  /** 擦除：命中即整笔删除 */
  const eraseAt = async (p: Pt) => {
    const ann = annotation;
    if (!ann) return;
    const kept = ann.strokes.filter((s) => !strokeHitByEraser(p, s, 0.006));
    if (kept.length === ann.strokes.length) return; // 没擦到，不写库
    await commit({ ...ann, strokes: kept });
  };

  const onPointerDown = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRatio(e);
    /**
     * setPointerCapture 必须包 try/catch。
     *
     * 合成事件（自动化测试、部分触控板驱动）里 pointerId 可能不对应
     * 任何活跃指针，此时它会抛 NotFoundError —— 而这个异常会让整个
     * onPointerDown 中断，后面的分支一行都不执行。
     * 表现是「按下没反应」，但 pointerup 照常触发，非常难查。
     */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败不影响绘制，只是指针移出画布后收不到事件 */
    }

    /**
     * 先清掉上一种工具可能留下的残留状态。
     *
     * 不清的话：上一次画笔没收干净（比如指针移出画布导致 pointerup 没触发），
     * currentStroke 里还留着点，于是切成矩形工具后再按下去，
     * onPointerUp 会先命中「收笔」分支，把图形当成笔迹提交 ——
     * 表现为「选了矩形画出来却是一条线」。
     */
    currentStroke.current = [];
    lassoPoints.current = [];
    dragStart.current = null;

    const t = toolRef.current;
    if (t === 'eraser') {
      await eraseAt(p);
      return;
    }
    if (t === 'lasso') {
      lassoPoints.current = [p];
      setPreview({ lasso: [p] });
      return;
    }
    if (isShapeTool(t)) {
      dragStart.current = p;
      setPreview({ liveShape: makeShape(t, p, p, colorRef.current) });
      return;
    }
    // 其余一律当画笔
    currentStroke.current = [p];
    setPreview({ liveStroke: makeStroke([p], penRef.current, colorRef.current) });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRatio(e);

    const t = toolRef.current;
    if (currentStroke.current.length > 0) {
      currentStroke.current.push(p);
      setPreview({ liveStroke: makeStroke(currentStroke.current, penRef.current, colorRef.current) });
      return;
    }
    if (t === 'eraser' && e.buttons === 1) {
      void eraseAt(p);
      return;
    }
    if (lassoPoints.current.length > 0) {
      lassoPoints.current.push(p);
      setPreview({ lasso: [...lassoPoints.current] });
      return;
    }
    if (dragStart.current && isShapeTool(t)) {
      setPreview({ liveShape: makeShape(t, dragStart.current, p, colorRef.current) });
    }
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toRatio(e);
    const ann = annotation ?? emptyAnnotation();

    const t = toolRef.current;

    // 收笔
    if (currentStroke.current.length > 0) {
      /**
       * 简化容差要比默认值小得多。
       *
       * 默认 1e-4 会把一条 30 点的手绘线压成首尾 2 个点 ——
       * 那条线的压感、抖动、弯曲全没了，看起来像一根被拉直的棍子。
       * 用 1e-5 保留弯曲，同时仍然去掉大量近乎共线的采样点。
       */
      const pts = simplifyStroke(currentStroke.current, 1e-5);
      currentStroke.current = [];
      setPreview(null);
      if (pts.length >= 1) {
        await commit({
          ...ann,
          strokes: [...ann.strokes, makeStroke(pts, penRef.current, colorRef.current)],
        });
      }
      return;
    }

    // 套索判定
    if (lassoPoints.current.length > 2) {
      const poly = lassoPoints.current;
      lassoPoints.current = [];
      const selStrokes = ann.strokes.filter((s) => strokeCaughtByLasso(s, poly));
      const selShapes = (ann.shapes ?? []).filter((s) => shapeCaughtByLasso(s, poly));

      if (selStrokes.length === 0 && selShapes.length === 0) {
        setPreview(null);
        setSelected({ strokes: [], shapes: [] });
        return;
      }

      const boxes = [
        ...selStrokes.map(strokeBounds).filter((b): b is NonNullable<typeof b> => b !== null),
        ...selShapes.map(shapeBounds),
      ];
      const box = boxes.reduce(
        (acc, b) => ({
          x1: Math.min(acc.x1, b.x1),
          y1: Math.min(acc.y1, b.y1),
          x2: Math.max(acc.x2, b.x2),
          y2: Math.max(acc.y2, b.y2),
        }),
        { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
      );
      setSelected({ strokes: selStrokes, shapes: selShapes });
      setPreview({ selectionBox: box });
      return;
    }

    // 图形收笔
    if (dragStart.current && isShapeTool(t)) {
      const start = dragStart.current;
      dragStart.current = null;
      setPreview(null);
      if (Math.hypot(p.x - start.x, p.y - start.y) < 0.008) return; // 太小当误触
      await commit({
        ...ann,
        shapes: [...(ann.shapes ?? []), makeShape(t, start, p, colorRef.current)],
      });
    }
  };

  /** 删除套索选中的元素 */
  const deleteSelected = async () => {
    const ann = annotation;
    if (!ann) return;
    const kept = ann.strokes.filter((s) => !selected.strokes.includes(s));
    const keptShapes = (ann.shapes ?? []).filter((s) => !selected.shapes.includes(s));
    if (kept.length === ann.strokes.length && keptShapes.length === (ann.shapes ?? []).length) {
      return;
    }
    await commit({ ...ann, strokes: kept, shapes: keptShapes });
    setSelected({ strokes: [], shapes: [] });
    setPreview(null);
  };

  /** 把选中的元素整体平移 */
  const moveSelected = async (dx: number, dy: number) => {
    const ann = annotation;
    if (!ann || (selected.strokes.length === 0 && selected.shapes.length === 0)) return;
    await commit({
      ...ann,
      strokes: ann.strokes.map((s) => (selected.strokes.includes(s) ? translateStroke(s, dx, dy) : s)),
      shapes: (ann.shapes ?? []).map((s) =>
        selected.shapes.includes(s) ? translateShape(s, dx, dy) : s,
      ),
    });
    setSelected({ strokes: [], shapes: [] });
    setPreview(null);
  };

  const undo = async () => {
    const ann = annotation;
    if (!ann) return;
    if (ann.strokes.length > 0) {
      await commit({ ...ann, strokes: ann.strokes.slice(0, -1) });
    } else if ((ann.shapes ?? []).length > 0) {
      await commit({ ...ann, shapes: (ann.shapes ?? []).slice(0, -1) });
    }
  };

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
    const ann = annotation ?? emptyAnnotation();
    await commit({ ...ann, texts: [...ann.texts, note] });
  };

  const updateNote = async (id: string, patch: Partial<Omit<TextNote, 'id'>>) => {
    const ann = annotation ?? emptyAnnotation();
    await commit({
      ...ann,
      texts: ann.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  };

  const removeNote = async (id: string) => {
    const ann = annotation ?? emptyAnnotation();
    await commit({ ...ann, texts: ann.texts.filter((t) => t.id !== id) });
  };

  const clearAll = async () => {
    await service.clearPage(sourceId, page);
    setAnnotation(null);
    setPreview(null);
    setSelected({ strokes: [], shapes: [] });
    onChange?.(null);
  };

  const strokeCount = annotation?.strokes.length ?? 0;
  const shapeCount = (annotation?.shapes ?? []).length;
  const textCount = annotation?.texts.length ?? 0;
  const hasAnything = strokeCount + shapeCount + textCount > 0;
  const hasSelection = selected.strokes.length + selected.shapes.length > 0;

  return (
    <div className="annot">
      <div className="annot__bar">
        {/* 笔形 */}
        <span className="annot__group">
          {(Object.keys(PEN_LABELS) as PenKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`btn btn--sm${tool === 'none' && pen === k ? ' btn--primary' : ''}`}
              onClick={() => {
                setPen(k);
                setTool('none');
              }}
              title={`${PEN_LABELS[k]}：直接拖动即可书写`}
            >
              {PEN_LABELS[k]}
            </button>
          ))}
        </span>

        {/* 图形 */}
        <span className="annot__group">
          {(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`btn btn--sm${tool === k ? ' btn--primary' : ''}`}
              onClick={() => setTool(tool === k ? 'none' : k)}
              title={`画${SHAPE_LABELS[k]}：拖出范围`}
            >
              {SHAPE_LABELS[k]}
            </button>
          ))}
        </span>

        {/* 工具 */}
        <span className="annot__group">
          <button
            type="button"
            className={`btn btn--sm${tool === 'eraser' ? ' btn--primary' : ''}`}
            onClick={() => setTool(tool === 'eraser' ? 'none' : 'eraser')}
            title="橡皮：划过即擦掉笔迹"
          >
            橡皮
          </button>
          <button
            type="button"
            className={`btn btn--sm${tool === 'lasso' ? ' btn--primary' : ''}`}
            onClick={() => setTool(tool === 'lasso' ? 'none' : 'lasso')}
            title="套索：框选后可整体移动或删除"
          >
            套索
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void addText()}>
            + 文本
          </button>
        </span>

        {/* 颜色 */}
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
          {hasSelection ? (
            <>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void moveSelected(-0.02, 0)}
                title="选中内容左移"
              >
                ← 移
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void moveSelected(0.02, 0)}
                title="选中内容右移"
              >
                移 →
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void deleteSelected()}
                title="删除选中的内容"
              >
                删除选中
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void undo()}
            disabled={!hasAnything || saving}
            title="撤销最后一个元素"
          >
            撤销
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void clearAll()}
            disabled={!hasAnything}
            title="清空这一页的全部注释"
          >
            清空本页
          </button>
        </span>

        {saving ? <span className="page__muted">保存中…</span> : null}
        {!saving && hasAnything ? (
          <span className="page__muted">
            已存 {strokeCount} 笔
            {shapeCount > 0 ? ` · ${shapeCount} 图` : ''}
            {textCount > 0 ? ` · ${textCount} 文本` : ''}
          </span>
        ) : null}
      </div>

      <canvas
        ref={canvasRef}
        className="annot__canvas"
        width={Math.max(1, Math.round(width))}
        height={Math.max(1, Math.round(height))}
        style={{ touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={(e) => void onPointerDown(e)}
        onPointerMove={(e) => void onPointerMove(e)}
        onPointerUp={(e) => void onPointerUp(e)}
        onPointerCancel={() => {
          currentStroke.current = [];
          lassoPoints.current = [];
          dragStart.current = null;
          setPreview(null);
        }}
      />

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
            onChange={(e) => {
              const v = e.target.value;
              const prev = noteTimers.current.get(t.id);
              if (prev) window.clearTimeout(prev);
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
              const prev = noteTimers.current.get(t.id);
              if (prev) {
                window.clearTimeout(prev);
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

function isShapeTool(t: Tool): t is ShapeKind {
  return t === 'line' || t === 'arrow' || t === 'rect' || t === 'ellipse';
}

function makeStroke(points: Pt[], pen: PenKind, color: string): InkStroke {
  return { points, color, width: PEN_WIDTHS[pen], kind: pen };
}

function makeShape(kind: ShapeKind, a: Pt, b: Pt, color: string): ShapeElement {
  return {
    id: newId('shape'),
    kind,
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    color,
    width: 0.003,
    fill: null,
  };
}

function emptyAnnotation(): SourceAnnotation {
  return {
    id: '',
    sourceId: '',
    page: 0,
    strokes: [],
    texts: [],
    shapes: [],
    createdAt: '',
    updatedAt: '',
  };
}
