/**
 * OCR / 看图识公式核心层。
 *
 * 这条链路对应设置页那个「看图识公式」勾选框：
 *
 *   勾选框（BackendConfig.capabilities.visionFormula）
 *     → pickVisionBackends() 挑出可用后端
 *     → ModelVisionBackend 发多模态请求
 *     → OcrService 逐页渲染 → 识别 → writeSegments 写回
 *     → 资料有了文本，搜索 / 整理知识点 / 出题才能用
 *
 * 在此之前这三件套都不存在，那个勾选框点了不会有任何事发生。
 */
export { OcrService, checkOcrReadiness } from './service.ts';
export type { OcrPrecheck, OcrRunOptions, OcrServiceOptions, RenderPageFn } from './service.ts';

export { ModelVisionBackend, normalizeOcrText, pickVisionBackends } from './vision-backend.ts';

export { LocalTesseractBackend, stripCjkSpaces } from './local-backend.ts';
export type { LocalOcrOptions } from './local-backend.ts';

export { OcrError } from './types.ts';
export type {
  OcrPageFailure,
  OcrProgress,
  OcrResult,
  VisionBackend,
  VisionBackendOptions,
  VisionPageInput,
  VisionPageResult,
} from './types.ts';
