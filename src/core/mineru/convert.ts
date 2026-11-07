/**
 * 「这份资料要不要走 MinerU 转换」的判断。
 *
 * 这一条判断留在独立文件里，因为它同时被界面（整理知识点页）与
 * 转换流程两边用到，放哪边都会让另一边反向依赖。
 *
 * ## 历史说明（2026-11-07）
 *
 * 这个文件原来还包含 `parseMiddleJson` —— 解析 `mineru-kit --format middle_json`
 * 的输出。那条路线已废弃，原因见 `markdown.ts` 顶部注释
 * （mineru-kit 不走本地服务、会撞模型锁）。
 * 现在只解析 `mineru parse` 产出的 Markdown，见 `markdown.ts`。
 */

/**
 * 判断一份资料是否需要走 MinerU 转换。
 *
 * 三种情况需要：
 *  - `no-text-layer`：扫描件，文字在图片里（用户最常遇到的）
 *  - `decode-failed`：文件里有字但我们取不出来 —— **这是我们的问题**，
 *    不该让用户去换电子版，用 MinerU 再试一次是合理的补救
 *  - 图片资料：本身就是一张图
 *
 * `ready` 不需要：已经有文字层，转换是白费时间。
 */
export function needsConversion(textStatus: string, kind: string): boolean {
  if (textStatus === 'no-text-layer' || textStatus === 'decode-failed') return true;
  if (kind === 'image') return true;
  return false;
}
