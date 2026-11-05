import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlideDeck, SlideOutlinePage, SlideOverlay } from '@/core/model.ts';
import type { RenderSlide } from '@/core/slides/render-plan.ts';
import { SLIDE_SIZE } from '@/core/slides/render-plan.ts';
import {
  defaultBox,
  moveBox,
  pxToRatio,
  resizeBox,
  type RatioBox,
  type ResizeHandle,
} from '@/core/slides/overlay-geometry.ts';
import { useServices } from '@/app/services-context.ts';
import { MAX_SLIDE_IMAGE_BYTES, SlideImageTooLargeError } from '@/core/slides/service.ts';
import { Badge, Notice } from '@/components/states.tsx';
import { describeError, hintFrom } from './types.ts';

/**
 * 拖拽编辑器：在预览的某一页上自由摆放图片与文本框。
 *
 * ## 为什么做成叠在预览之上的一层
 *
 * 「所见即所得」在这里不是好看，是**唯一能保证不骗人的做法**：
 * 如果另开一个编辑器画面，用户摆完再回来看预览，两套坐标系统
 * 一定会有一点对不上，而这点偏差在导出成 pptx 后才暴露。
 *
 * 所以编辑层直接量出预览那张卡片的真实像素尺寸，把指针位移
 * 换算成比例（0~1），写回数据层。预览与导出拿的是同一份比例，
 * 于是「拖到哪、导出就在哪」是构造上成立的，不是调出来的。
 *
 * ## 为什么每次拖完才落库
 *
 * 拖动过程中只更新本地状态（每帧写一次 IndexedDB 会很卡），
 * 松手时提交一次。这是拖拽交互的常规做法。
 */

export interface OverlayEditorProps {
  deck: SlideDeck;
  /** 当前正在编辑的页；null 表示没选页，显示提示 */
  pageId: string | null;
  /** 这一页的渲染计划（用来定位卡片） */
  slide: RenderSlide | null;
  /** 写回路由 */
  onDeck: (deck: SlideDeck) => void;
}

export function OverlayEditor({ deck, pageId, slide, onDeck }: OverlayEditorProps) {
  const { slides } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [selectedOverlay, setSelectedOverlay] = useState<string | null>(null);

  /** 拖拽中的临时框（还没落库），拖完写回 */
  const [drag, setDrag] = useState<
    { overlayId: string; box: RatioBox } | { overlayId: string; box: RatioBox } | null
  >(null);

  const page = deck.pages.find((p) => p.id === pageId) ?? null;
  const overlays = page?.overlays ?? [];

  /** 一张图的显示比例（宽/高），插入时用来定初始大小 */
  const overlaysRef = useRef<SlideOverlay[]>(overlays);
  useEffect(() => {
    overlaysRef.current = overlays;
  }, [overlays]);

  const run = useCallback(
    async (fn: () => Promise<SlideDeck>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await fn();
        onDeck(next);
      } catch (err) {
        /**
         * 图片超限单独处理：它自带 hint（怎么压缩），
         * 用通用文案会把这个最需要具体指引的失败说成「保存失败」。
         */
        if (err instanceof SlideImageTooLargeError) {
          setError({ message: err.message, hint: err.hint });
        } else {
          setError({
            message: describeError(err),
            hint: hintFrom(err, '这次操作没保存成功。刷新页面确认一下内容还在不在，然后重试。'),
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, onDeck],
  );

  // ── 插入图片 ────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);

  const insertImage = async (file: File) => {
    if (!pageId) return;

    /**
     * 先按文件大小拦一道。
     *
     * 用户选了一张 40MB 的图时，读成 data URL 本身就要几百毫秒、
     * 占几十 MB 内存；等写库时才拒绝，会有明显的卡顿再报错，
     * 而且那段 base64 已经在内存里了。先拦，连读都不读。
     */
    if (file.size > MAX_SLIDE_IMAGE_BYTES) {
      setError({
        message: `这个文件 ${(file.size / (1024 * 1024)).toFixed(1)} MB，超过了 ${
          MAX_SLIDE_IMAGE_BYTES / (1024 * 1024)
        } MB 的上限`,
        hint:
          '截图或照片通常不必这么大。可以先压缩再插进来；' +
          'Windows 自带的「画图」打开后另存为 PNG 就能小很多。',
      });
      return;
    }

    const image = await readImageFile(file);
    await run(async () => {
      const imageId = await slides.addImage({
        imageData: image.dataUrl,
        width: image.width,
        height: image.height,
      });
      // 按原图比例定初始大小，避免一插入就是被压扁的
      const aspect = image.height / image.width;
      const box = defaultBox(aspect);
      return slides.addOverlay(deck.id, pageId, {
        kind: 'image',
        imageId,
        ...box,
      });
    });
  };

  // ── 加文本框 ────────────────────────────────────────────────
  const addTextBox = () => {
    if (!pageId) return;
    const count = overlays.filter((o) => o.kind === 'text').length + 1;
    void run(async () =>
      slides.addOverlay(deck.id, pageId, {
        kind: 'text',
        text: `批注 ${count}`,
        ...defaultBox(0.3),
        fontSize: 18,
      }),
    );
  };

  // ── 键盘：方向键微调、Delete 删除 ───────────────────────────
  useEffect(() => {
    if (!selectedOverlay || !pageId) return;

    const onKey = (ev: KeyboardEvent) => {
      // 用户在输入框里打字时不要抢键
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const ov = overlaysRef.current.find((o) => o.id === selectedOverlay);
      if (!ov) return;

      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        setSelectedOverlay(null);
        void run(async () => slides.removeOverlay(deck.id, pageId, ov.id));
        return;
      }

      const step = ev.shiftKey ? 0.02 : 0.005;
      const map: Record<string, { dx: number; dy: number }> = {
        ArrowLeft: { dx: -step, dy: 0 },
        ArrowRight: { dx: step, dy: 0 },
        ArrowUp: { dx: 0, dy: -step },
        ArrowDown: { dx: 0, dy: step },
      };
      const move = map[ev.key];
      if (!move) return;

      ev.preventDefault();
      const next = moveBox(ov, move);
      void run(async () =>
        slides.updateOverlay(deck.id, pageId, ov.id, { x: next.x, y: next.y }),
      );
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedOverlay, pageId, deck.id, slides, run]);

  if (!pageId || !page) {
    return (
      <Notice tone="warning" title="还没有选页">
        下面的大纲里点一页，就能在它上面插图片、加批注。
      </Notice>
    );
  }

  return (
    <div className="page__stack">
      <div className="page__row">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          插入图片
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={addTextBox} disabled={busy}>
          加文本框
        </button>
        {selectedOverlay ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSelectedOverlay(null);
              void run(async () => slides.removeOverlay(deck.id, pageId, selectedOverlay));
            }}
            disabled={busy}
          >
            删掉选中的
          </button>
        ) : null}
        <Badge tone="neutral">{overlays.length} 块</Badge>
      </div>

      <div className="field__hint">
        {overlays.length === 0
          ? '这一页还没有叠加内容。插入图片或加一个文本框，然后直接在下面的预览里拖动它。'
          : '在预览里拖动可以移动，拖角上的小方块可以改大小。选中后方向键微调、Delete 删除。'}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          // 清空 value：否则连续选同一个文件不会触发 change
          ev.target.value = '';
          if (file) void insertImage(file);
        }}
      />

      {error ? (
        <Notice tone="danger" title="这次操作没有保存">
          {error.message}
          <br />
          <strong>下一步：</strong>
          {error.hint}
        </Notice>
      ) : null}

      {/*
        编辑层。

        它是绝对定位盖在预览卡片上的，尺寸完全由卡片决定 ——
        这里不自己算任何像素，只负责把指针事件换算成比例。
      */}
      {slide ? (
        <OverlayStage
          page={page}
          slide={slide}
          selected={selectedOverlay}
          onSelect={setSelectedOverlay}
          dragBox={drag?.box ?? null}
          draggingId={drag?.overlayId ?? null}
          onDragStart={(overlayId, box) => setDrag({ overlayId, box })}
          onDragMove={(box) => setDrag((d) => (d ? { ...d, box } : d))}
          onDragEnd={(overlayId, box) => {
            setDrag(null);
            void run(async () =>
              slides.updateOverlay(deck.id, pageId, overlayId, {
                x: box.x,
                y: box.y,
                w: box.w,
                h: box.h,
              }),
            );
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 叠在预览上的交互层。
 *
 * 这一层不画内容（内容由 SlidePreview 画），只画**选中框与把手**，
 * 并处理指针事件。分开的好处：预览那层保持纯展示，
 * 不会因为加了编辑逻辑而让「预览 = 导出」的对应关系变复杂。
 */
function OverlayStage({
  page,
  slide,
  selected,
  onSelect,
  dragBox,
  draggingId,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  page: SlideOutlinePage;
  slide: RenderSlide;
  selected: string | null;
  onSelect: (id: string | null) => void;
  dragBox: RatioBox | null;
  draggingId: string | null;
  onDragStart: (overlayId: string, box: RatioBox) => void;
  onDragMove: (box: RatioBox) => void;
  onDragEnd: (overlayId: string, box: RatioBox) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  /** 当前这次拖拽的状态；用 ref 而不是 state，避免每帧触发重渲染链 */
  const session = useRef<{
    overlayId: string;
    mode: 'move' | ResizeHandle;
    startBox: RatioBox;
    startPoint: { dx: number; dy: number };
    rect: DOMRect;
  } | null>(null);

  const overlays = page.overlays ?? [];

  /** 指针位置换算成比例 */
  const pointerRatio = (ev: PointerEvent | React.PointerEvent): { dx: number; dy: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { dx: 0, dy: 0 };
    return {
      dx: pxToRatio(ev.clientX - rect.left, rect.width),
      dy: pxToRatio(ev.clientY - rect.top, rect.height),
    };
  };

  const begin = (
    ev: React.PointerEvent,
    overlayId: string,
    mode: 'move' | ResizeHandle,
    box: RatioBox,
  ) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;

    onSelect(overlayId);
    onDragStart(overlayId, box);
    session.current = {
      overlayId,
      mode,
      startBox: box,
      startPoint: pointerRatio(ev),
      rect,
    };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const s = session.current;
    if (!s) return;

    const now = pointerRatio(ev);
    const delta = { dx: now.dx - s.startPoint.dx, dy: now.dy - s.startPoint.dy };

    const box =
      s.mode === 'move'
        ? moveBox(s.startBox, delta)
        : resizeBox(s.startBox, s.mode, delta);

    onDragMove(box);
  };

  const finish = (ev: React.PointerEvent) => {
    const s = session.current;
    if (!s) return;
    session.current = null;

    const now = pointerRatio(ev);
    const delta = { dx: now.dx - s.startPoint.dx, dy: now.dy - s.startPoint.dy };
    const box =
      s.mode === 'move'
        ? moveBox(s.startBox, delta)
        : resizeBox(s.startBox, s.mode, delta);

    onDragEnd(s.overlayId, box);
  };

  return (
    <div
      ref={stageRef}
      className="sl-stage"
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      // 点空白处取消选中
      onPointerDown={() => onSelect(null)}
      style={{ aspectRatio: `${SLIDE_SIZE.width} / ${SLIDE_SIZE.height}` }}
    >
      {overlays.map((ov, index) => {
        const planned = slide.overlays.find((o) => o.id === ov.id);
        // 生效的框：拖拽中的临时框优先
        const box = draggingId === ov.id && dragBox ? dragBox : ov;
        const isSelected = selected === ov.id;

        return (
          <div
            key={ov.id}
            className={`sl-stage__item${isSelected ? ' sl-stage__item--selected' : ''}`}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
              zIndex: 10 + index,
            }}
            onPointerDown={(ev) => begin(ev, ov.id, 'move', box)}
          >
            {isSelected ? (
              <>
                {(['nw', 'ne', 'sw', 'se'] as ResizeHandle[]).map((h) => (
                  <span
                    key={h}
                    className={`sl-stage__handle sl-stage__handle--${h}`}
                    onPointerDown={(ev) => begin(ev, ov.id, h, box)}
                  />
                ))}
                {planned ? null : (
                  <span className="sl-stage__warn" title="这块内容取不到图片，导出时会跳过">
                    !
                  </span>
                )}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 读本地图片文件成 data URL + 尺寸 */
async function readImageFile(
  file: File,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读不了这个文件，可能它不是图片或已被移动'));
    reader.readAsDataURL(file);
  });

  // 宽高必须真的读出来：按原比例摆放，否则图会被拉扁
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('这张图片打不开，可能格式不被支持'));
    img.src = dataUrl;
  });

  return { dataUrl, ...size };
}
