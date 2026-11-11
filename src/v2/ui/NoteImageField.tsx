/**
 * 备注附图（2026-11-11）。
 *
 * ## 用户需求
 *
 * 「你试试能不能将图也添加进备注的功能做出来，实在困难可以不做这个功能。」
 *
 * 能做，而且不需要动存储 —— `TextMark.image` 是个可选字段，
 * 旧数据读出来是 undefined，不触发迁移。
 *
 * ## 为什么单独一个文件
 *
 * `ReaderSidePanel.tsx` 已 540 行、`ReaderPage.tsx` 1700 行。
 * 交接文档硬约束 5：新增 UI 一律独立文件，宿主里只插一行引用。
 *
 * ## 三条设计决定
 *
 * 1. **用 FileReader 转 data URI，不走后端上传。**
 *    这是纯本地桌面应用，没有任何服务器；图片必须与备注存在同一个
 *    IndexedDB 记录里，才能保证「删备注 = 删图」，不会留下孤儿文件。
 *
 * 2. **超限就明确拒绝，不静默压缩。**
 *    压缩会改变用户给的图（字变糊、公式看不清），而且用户不知道
 *    发生了什么。宁可说「这张太大（1.2MB），请裁一下或换一张」。
 *
 * 3. **同时支持选择文件与粘贴。**
 *    用户说「把图添加进备注」，最常见的来源其实是**截图后直接粘贴**，
 *    而不是去文件管理器找文件。所以 textarea 上挂 paste 处理。
 *
 * 大小上限见 `MAX_NOTE_IMAGE_BYTES`（model.ts）。
 */

import { useCallback, useRef, useState } from 'react';
import type { NotemarkImage } from '@/core/model.ts';
import { MAX_NOTE_IMAGE_BYTES } from '@/core/model.ts';

export interface NoteImageFieldProps {
  /** 当前已选的图（可为 undefined） */
  value: NotemarkImage | null;
  /** 选好 / 清除时回调 */
  onChange: (image: NotemarkImage | null) => void;
}

/** 人类可读的体积 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 把一个 File 读成 NotemarkImage。
 *
 * 用 `createImageBitmap` 而不是 `new Image()` + onload：
 * 前者在 Electron/Chromium 里更可靠，也能直接拿到宽高。
 */
async function fileToNoteImageImpl(file: File): Promise<NotemarkImage> {
  const buf = await file.arrayBuffer();
  const byteSize = buf.byteLength;
  if (byteSize > MAX_NOTE_IMAGE_BYTES) {
    throw new Error(`这张图 ${humanSize(byteSize)}，超过上限 ${humanSize(MAX_NOTE_IMAGE_BYTES)}。请裁小一点再试。`);
  }

  /* 显式校验是图片，而不是只信扩展名 */
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close?.();

  /* FileReader 转 data URI */
  const dataUri = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取这张图失败。'));
    fr.readAsDataURL(file);
  });

  return { dataUri, byteSize, width, height };
}

/**
 * 把文件读成备注附图。
 *
 * 导出是因为**粘贴**路径（ReaderSidePanel 的 onPaste）也要走同一套
 * 大小与格式校验。两条路径各写一份，迟早会出现「选文件能过、粘贴不能过」。
 */
export async function fileToNoteImage(file: File): Promise<NotemarkImage> {
  return fileToNoteImageImpl(file);
}

export function NoteImageField({ value, onChange }: NoteImageFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const accept = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setError('只能添加图片文件（png / jpg / gif / webp）。');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const img = await fileToNoteImage(file);
        onChange(img);
      } catch (e) {
        setError(e instanceof Error ? e.message : '添加图片失败。');
      } finally {
        setBusy(false);
        /* 清掉 input 的 value，否则选同一张图不会再触发 change */
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [onChange],
  );

  return (
    <div className="rside__img">
      {value ? (
        <div className="rside__img-preview">
          <img src={value.dataUri} alt="备注附图" />
          <div className="rside__img-meta">
            <span>
              {value.width}×{value.height} · {humanSize(value.byteSize)}
            </span>
            <button
              type="button"
              className="rside__mini"
              onClick={() => {
                onChange(null);
                setError(null);
              }}
            >
              移除图片
            </button>
          </div>
        </div>
      ) : (
        <div className="rside__img-empty">
          <button
            type="button"
            className="rside__mini"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? '正在读取…' : '＋ 添加图片'}
          </button>
          <span className="rside__img-tip">
            也可以直接截图粘贴到上面的输入框（上限 {humanSize(MAX_NOTE_IMAGE_BYTES)}）
          </span>
        </div>
      )}

      {/*
        隐藏的 file input。
        accept 只列常见位图格式：SVG 故意不放行 ——
        它可以内嵌脚本，而我们是直接 <img src={dataUri}> 渲染。
      */}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => void accept(e.target.files?.[0])}
      />

      {error ? <p className="rside__img-error">{error}</p> : null}
    </div>
  );
}

/**
 * 从粘贴事件里取出图片文件。
 *
 * 供 textarea 的 onPaste 调用 —— 用户截图后直接 Ctrl+V 是
 * 「把图加进备注」最顺手的路径。
 */
export function imageFromPaste(e: React.ClipboardEvent): File | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      return it.getAsFile();
    }
  }
  return null;
}
