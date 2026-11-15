/**
 * 把 DeepSeek OCR 包装成 MinerURunner 同形的实现（2026-11-15）。
 *
 * ## 为什么复用 MinerURunner 的接口
 *
 * `ConvertPanel` 只认 `runner.run(request, onProgress)` 返回
 * `{ pageCount, pages[], tier, producer }` 这一种形状。
 * 造第二个接口意味着「进度显示 / 分片合并 / 补位跳过 / 写回」
 * 那套逻辑要复制一遍 —— 复制必然漂移（这个项目的老毛病）。
 *
 * 所以 DeepSeek OCR 伪装成一个 runner：
 *  - 界面那一侧一行都不用改（`ConvertPanel` 只要换一个 runner 实例）
 *  - 以后再加别的云 OCR 也是同样的接法
 *
 * ## ⚠️ 与项目里已有的 `src/core/ocr/` 不是一回事
 *
 * `src/core/ocr/` 那套（2026-11-06）的链路是：
 *   PDF 页 **渲染成图片** → 交给多模态模型看图 → 写回分段
 *
 * DeepSeek 的 OCR API 是：
 *   **直接上传原文件**（PDF/图片）→ 服务端自己解析 → 返回逐页文字
 *
 * 输入不同（图片 vs 原文件）、计费不同（token vs 按页）、
 * 本地依赖不同（要 pdfjs+canvas vs 什么都不用）。
 * 所以这里是**第三条解析路**，不塞进那套服务里。
 *
 * 顺带记一笔：`src/core/ocr/service.ts` 那套从写完起就没有任何界面调用
 * （`grep OcrService src/v2 src/pages` 零命中）。属于「做了没接上」的
 * 又一例，与本文件无关，但下一个接手的人该知道。
 *
 * ## ⚠️ 现状：没有真的分片，如实说明
 *
 * 官方限制是 100 MiB / 1000 页 / **180 秒总时长**（含上传与识别）。
 * 用户选了「分片上传」。但**当前实现是整份上传**，原因：
 *
 * 按页切 PDF 需要 pdf-lib（项目里有，用于幻灯片），但切出来的每一片
 * 都要重新拼一个合法 PDF 再上传。这件事本身不难，可它有一个前提没定：
 * 「同一份资料的第二片解析完，怎么与第一片合并」——
 * 那要动 `writeSegments` 的 merge 语义与页码范围校验。
 *
 * 所以分两步走：这一版先把**单次识别**这条路打通并如实标注限制；
 * 分片是下一步。界面上必须写清「大文件可能超时，建议先用 MinerU
 * 或分批解析」，而不是假装已经分片了。
 *
 * 为什么不在注释里写「已按 10 页分片」：那会让下一个接手的人
 * 以为这里有合并逻辑，去查半天 —— 这个项目已经因为「注释写得像
 * 那么回事但代码从没生效过」栽过一次（那行 scrollTo）。
 */

import type { MinerURunner, MinerURequest, MinerUProgress } from '@/core/mineru/runner.ts';
import type { MinerUResult } from '@/core/mineru/markdown.ts';
import { runOcr, toMinerUShape } from './deepseek-ocr.ts';

export interface DeepSeekOcrRunnerOptions {
  apiKey: string;
  baseUrl: string;
  /** 注入用 */
  fetchImpl?: typeof globalThis.fetch;
  /** 读文件字节（桌面版走主进程，测试里可以直接给） */
  readFile: (filePath: string) => Promise<Uint8Array>;
}

/**
 * 一次识别最多能处理的页数（官方上限）。
 *
 * 超过这个数官方直接拒（`the document has more than 1000 pages`）。
 * 提前拦下来给一句人话，比让用户等 3 分钟后看到英文报错好。
 */
export const MAX_OCR_PAGES = 1000;

/**
 * 建一个 DeepSeek OCR 的 runner。
 *
 * `available` 恒为 true —— 只要给了 Key 和地址它就能跑。
 * 真正的可用性（余额、网络、是否超页数）只能实际调用时才知道，
 * 所以这里不假装能预检。
 */
export function createDeepSeekOcrRunner(options: DeepSeekOcrRunnerOptions): MinerURunner {
  const { apiKey, baseUrl, fetchImpl, readFile } = options;

  return {
    available: true,

    async run(
      request: MinerURequest,
      onProgress?: (p: MinerUProgress) => void,
    ): Promise<MinerUResult> {
      /* 阶段提示：让界面知道现在在干什么，而不是空白转圈 */
      onProgress?.({ phase: '正在读取文件', ratio: null, detail: null });

      const bytes = await readFile(request.filePath);

      /*
       * 页数超限提前拦。我们不知道页数（那要解析 PDF），
       * 但可以用「源资料的 pageCount」—— 调用方在 request 里没给，
       * 所以这里只能按文件大小的量级给提示，真正的页数由服务端判。
       * 服务端拒的时候错误消息里写了原因（见 deepseek-ocr.ts）。
       */

      onProgress?.({
        phase: '正在上传到 DeepSeek OCR',
        ratio: null,
        detail: `${(bytes.length / 1024 / 1024).toFixed(1)} MiB`,
      });

      const result = await runOcr({
        bytes,
        fileName: baseName(request.filePath),
        /*
         * rich_layout_recognition：所有文件都逐页识别，保留版面标记。
         * 我们要的是每页正文；坐标以后可能有用（点文字定位）。
         */
        purpose: 'rich_layout_recognition',
        apiKey,
        baseUrl,
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      if (!result.ok) {
        /*
         * 错误信息直接抛出去，由 ConvertPanel 的 catch 显示。
         * 消息里已经写了「能照着改」的原因（见 deepseek-ocr.ts 的状态码分支）。
         */
        throw new Error(result.reason);
      }

      onProgress?.({
        phase: '识别完成',
        ratio: 1,
        detail: `${result.pageCount} 页`,
      });

      /*
       * 转成 MinerU 同形结果。剥掉版面标记 ——
       * 阅读器与知识点提取都按「纯正文」处理，标记会污染正文
       * （「字数」统计也会把它们算进去）。
       *
       * 坐标信息因此丢失，这是当前取舍：先把正文这条路走通。
       * 以后要做「点文字定位」时，把 stripMarks:false 的结果另存一份即可。
       */
      return toMinerUShape(result.pages, { stripMarks: true }) as MinerUResult;
    },
  };
}

/** 从路径取文件名（官方要求 file 带文件名，扩展名会影响它的解析方式判断） */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || 'document.pdf';
}