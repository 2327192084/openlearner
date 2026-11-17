/**
 * 把 PPTX 的某一页渲染成图片，供阅读器「看原图」使用（2026-11-17）。
 *
 * ## 为什么单独一个文件
 *
 * `source-page.ts` 的 `renderSourcePage` 只会渲染 PDF（pdfjs 的成果）。
 * PPTX 是 zip 包里的矢量 XML，必须走另一条路：pptx-wasm（Rust→WASM，
 * 浏览器原生渲染到 canvas）。两者对外都返回 `RenderedPage`，阅读器按
 * `source.kind` 选一个调用即可，互不干扰。
 *
 * ## 为什么选 pptx-wasm 而不是 182MB 的 LibreOffice
 *
 * 实测过两条路（见 docs/待办与 .tmp/pptx-render-test）：
 *  - LibreOffice 引擎包能渲染，但单个 exe 就 170MB，安装包会从 96MB 涨到 151MB+；
 *  - pptx-wasm 本体 ~1MB（wasm 737KB），中文实测渲染完美（系统字体回退）。
 * 用户资料全是中文，实测通过后选后者。已知限制：SmartArt / OLE / 3D 斜角 /
 * 动画 / EMF-WMF 不渲染 —— 真遇到时提示用户切回「看文字」，不静默给白图。
 *
 * ## 为什么 wasm 用 `?url` 动态导入
 *
 * 和 pdf.worker 同一个坑：写死路径在 file:// 下会解析到磁盘根目录 404。
 * `?url` 让 Vite 把 wasm 当资源单独产出并给出正确 URL。Node 单测里没有
 * 打包器，所以 `isBrowser()` 为假时直接拒绝渲染（单测只验页码校验与错误分支，
 * 真实渲染由 CDP 端到端验证）。
 */

import { isBrowser } from '../parsers/pdf.ts';
import type { Presentation } from 'pptx-wasm';
import { RenderPageError, type RenderPageOptions, type RenderedPage } from './source-page.ts';

/** wasm 资源 URL 只解析一次，缓存下来 */
let wasmUrlPromise: Promise<string | null> | null = null;

async function getWasmUrl(): Promise<string | null> {
  if (!wasmUrlPromise) {
    wasmUrlPromise = import('pptx-wasm/wasm?url')
      .then((m) => (m as { default?: string }).default ?? null)
      .catch(() => null);
  }
  return wasmUrlPromise;
}

/**
 * 渲染 PPTX 的第 `page` 页（从 1 开始，与 renderSourcePage 一致）。
 */
export async function renderPptxPage(
  fileData: Uint8Array,
  page: number,
  opts: RenderPageOptions = {},
): Promise<RenderedPage> {
  if (!Number.isInteger(page) || page < 1) {
    throw new RenderPageError(`页码无效（${page}）`, '请重新选择要扫描的那一页');
  }
  if (!isBrowser()) {
    throw new RenderPageError('当前环境不能渲染 PPT 页面', '请在桌面应用里打开原图');
  }
  opts.signal?.throwIfAborted();

  const { Presentation } = await import('pptx-wasm');
  const wasm = await getWasmUrl();

  let deck: Presentation | null = null;
  try {
    // 复制一份：避免与调用方共享 buffer（wasm 侧会接管）
    deck = await Presentation.open(new Uint8Array(fileData), wasm ? { wasm } : undefined);
    opts.signal?.throwIfAborted();

    if (page > deck.slideCount) {
      throw new RenderPageError(
        `这份 PPT 只有 ${deck.slideCount} 页，没有第 ${page} 页`,
        '请翻到存在的那一页再看原图',
      );
    }

    const targetWidth = Math.min(Math.max(opts.targetWidth ?? 1100, 320), 3000);
    const { width: slideW, height: slideH } = deck.slideSize;
    const targetHeight = Math.max(1, Math.round((targetWidth * slideH) / slideW));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const drawOpts = { width: targetWidth, height: targetHeight, dpr: 1, fit: 'contain' as const };
    await deck.render(page - 1, canvas, drawOpts);

    // 图片/嵌入字体是异步解码的：首帧可能缺图，资产到齐后再画一次。
    // 用 onAssetsReady + 超时兜底，避免竞态（检查到注册之间资产已到齐）导致永久挂起。
    if (deck.pendingAssetCount() > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const unsubscribe = deck!.onAssetsReady(() => {
            unsubscribe();
            resolve();
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      opts.signal?.throwIfAborted();
      await deck.render(page - 1, canvas, drawOpts);
    }

    return { imageData: canvas.toDataURL('image/png'), width: targetWidth, height: targetHeight };
  } catch (err) {
    if (err instanceof RenderPageError) throw err;
    throw new RenderPageError(
      err instanceof Error ? err.message : 'PPT 这一页渲染失败',
      '这份 PPT 可能用了不支持的内容（SmartArt / 3D / OLE），可以切回「看文字」',
    );
  } finally {
    deck?.destroy();
  }
}
