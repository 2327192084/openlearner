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
 * 官方限制写在文档上的是 100 MiB / 1000 页 / **180 秒总时长**。
 * 但 2026-11-16 实测发现**还有一层文档没写的限制**：DeepSeek 前面的
 * openresty 网关有自己的请求体上限，比 100 MiB 低得多 ——
 * 一份 55.07 MiB 的真实 PDF 就被它以 `HTTP 413 + HTML` 拒了
 * （响应头 `server: openresty`，耗时 18.5 秒 = 传完才拒）。
 * 应用层的 413 会返回 JSON `{error:{...}}`，网关层返回的是 HTML，
 * 两者在 `deepseek-ocr.ts` 的 413 分支里已经分开处理。
 *
 * 用户之前选了「分片上传」，但**当前实现是整份上传**。
 *
 * ## 为什么这一版仍然不做分片
 *
 * 按页切 PDF 需要一个能重写 PDF 的库。**注意：原来这里写着
 * 「pdf-lib（项目里有，用于幻灯片）」，那是错的 —— 2026-11-16 核实：
 * `pdf-lib` 既不在 `package.json` 里，也没装进 `node_modules`。**
 * 所以「切页」这件事本身还没有工具，得先引入依赖。
 *
 * 引入之后还有第二个没定的问题：「同一份资料的第二片解析完，
 * 怎么与第一片合并」—— 那要动 `writeSegments` 的 merge 语义与
 * 页码范围校验。
 *
 * 所以分两步走：这一版先把**单次识别**这条路打通并如实标注限制；
 * 分片是下一步。
 *
 * ## 选了分片怎么办（2026-11-16 新增）
 *
 * `request.pages` 原先是**完全不读**的 —— 用户在界面上选「解析 1-50 页」，
 * 云 OCR 照样把整份 442 页传上去，然后撞上网关的 413。
 * 用户以为「分批就能过」，实际一点用都没有。
 *
 * 现在：检测到用户明确要求了页码范围时，**直接报错说清楚**，
 * 不要静默忽略。说清楚比假装能做有用得多。
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

      /*
       * 用户明确要求了页范围 → 云 OCR 做不到，如实拒绝（2026-11-16）。
       *
       * ## 为什么必须拦，不能静默忽略
       *
       * 原先 `request.pages` 在这个 runner 里**一次都没被读过**。
       * 用户在界面上选「解析 1-50 页」，云 OCR 照样把整份 442 页传上去 —
       * 然后撞上网关的 413。用户会得出错误结论：「分批没用，这功能坏的」。
       *
       * 静默忽略比报错更糟：它让用户以为自己在控制上传量。
       * 所以要明说「云 OCR 目前只能整份上传」，并指出替代做法。
       *
       * `pages === 'all'` 是「完整解析」，那正是我们能做的，放行。
       */
      if (request.pages && request.pages !== 'all') {
        const err = new Error(
          `云 OCR 目前只能整份上传，做不到「只解析第 ${request.pages} 页」。` +
            '要么改成「完整解析」整份走云 OCR（大文件可能被服务端网关拒收），' +
            '要么改用本机 MinerU —— 它支持按页范围解析。',
        ) as Error & { trouble?: string };
        err.trouble = 'cloud-ocr';
        throw err;
      }

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
         *
         * `trouble: 'cloud-ocr'`（2026-11-16）：ConvertPanel 靠这个字段
         * 选提示语。不标的话会落到 default，说「看看 MinerU 那边的日志」——
         * 可用户走的是云 OCR，本机可能根本没装 MinerU。
         */
        const err = new Error(result.reason) as Error & { trouble?: string };
        err.trouble = 'cloud-ocr';
        throw err;
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