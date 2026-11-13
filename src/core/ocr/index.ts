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

/*
 * 本地 tesseract 后端已删除（2026-11-13）。
 *
 * 它从 2026-11-06 起就没有任何界面入口调它（`grep -rn "OcrService" src/v2/
 * src/pages/` 零命中），而且当天的交接文档已经记下用户对它的实测结论：
 * 「完全不能用」「不要再试图修/调 tesseract，方向已改成本地部署开源模型」。
 * 随后扫描件改走 MinerU（`src/core/mineru/`），中文识别不再需要自带语言包。
 *
 * 用户 2026-11-13 明确说「中文包不用了，用 mineru 就够」，所以连同
 * `public/tesseract/`（22MB：一个 chi_sim 语言包 + 三份 lstm wasm + worker）
 * 一起移除，让安装包少 22MB，也少一条没人走的错路。
 *
 * 想找回来的话：删除前的完整副本在 `.tmp/tesseract-removal-20261113-104236/`。
 */

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
