/**
 * 触发浏览器下载。
 *
 * 从设置页（P0 备份导出）挪过来的：P4 导出 .pptx 要用同一份实现，
 * 复制一份会出现「备份能下载、PPT 下载不了」这种一半好一半坏的问题——
 * 那类 bug 排查起来最费时间，因为两处代码看起来一样。
 *
 * Electron 里同样走 Blob + a.click()，会弹系统保存对话框。
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及读到 blob，让出一个宏任务再释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** .pptx 的 MIME。写错也能存盘，但某些系统会用错图标或拒绝打开。 */
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * 把导出结果存成文件。
 *
 * 单独封一层是因为 `ExportOutcome.buffer` 是 `Uint8Array`，
 * 直接 `new Blob([buffer])` 在严格 TS 下会报 BlobPart 类型不兼容
 * （Uint8Array<ArrayBufferLike> 与 ArrayBuffer 的区别），
 * 这里统一处理一次，调用方不用各自去转。
 */
export function downloadPptx(buffer: Uint8Array, fileName: string): void {
  const bytes = new Uint8Array(buffer);
  downloadBlob(new Blob([bytes], { type: PPTX_MIME }), fileName);
}
