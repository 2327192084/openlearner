import { ApiError, chatCompletion, redactSecrets } from '../ai/chat-client.ts';
import { findPreset } from '../ai/presets.ts';
import type { BackendView } from '../backends.ts';
import { OcrError } from './types.ts';
import type {
  VisionBackend,
  VisionBackendOptions,
  VisionPageInput,
  VisionPageResult,
} from './types.ts';

/**
 * 用视觉大模型识别一页扫描件。
 *
 * ## 为什么走 chatCompletion 而不是自己拼请求
 *
 * 图片是按 OpenAI 多模态形状发的（`content: [{type:'text'}, {type:'image_url'}]`），
 * 那套形状、鉴权头、错误分类、超时、凭据清洗都已在 chat-client 里做过了。
 * 这里再拼一遍只会多出一份会走样的副本 —— 尤其 `redactSecrets`，
 * 漏掉它的后果是把用户的 Key 打进错误消息。
 *
 * ## 提示词为什么这么写
 *
 * OCR 的结果会写进 `sourceSegments`，成为「点回原文」的引用底本。
 * 所以宁可少识别，也不能编：
 *
 *  - 明确要求「只输出图片里看得到的文字」，堵住模型按上下文补全的倾向；
 *  - 明确「看不清就原样保留成 [?]」，比让它猜一个更像样的字安全 ——
 *    引用文本错了，后续定位和出题都会跟着错，而且很难被发现；
 *  - 不要求它输出 Markdown：公式在这类模型里常被改写成 LaTeX，
 *    而我们的正文是给学生逐字对照原文用的，改写成 LaTeX 就再也对不上了。
 */

/** 系统提示词：定死「不编」这条底线 */
const SYSTEM_PROMPT = [
  'You are an OCR engine for study material pages.',
  'Transcribe ONLY the text that is visibly present in the image.',
  'Never complete, guess, summarize, or explain. Do not add headings or commentary.',
  'If a character is genuinely illegible, keep it as [?] instead of guessing.',
  'If the page contains no readable text (a full-page figure, for example), output nothing.',
  'Preserve the reading order and paragraph breaks of the original page.',
].join(' ');

/**
 * 用户提示词。
 *
 * 带上页码与资料名：教材名常常提示领域术语（「数据结构」里 `Queue`
 * 更可能是队列而不是排队），而页码让模型知道这是连续文档中的一页，
 * 不必在页首补一个标题。
 */
function buildUserPrompt(input: VisionPageInput): string {
  return [
    `This is page ${input.pageNo} of "${input.sourceTitle}".`,
    'Transcribe its text as plain text.',
  ].join(' ');
}

/**
 * 从已配置的后端里挑出「能看图」的那几个。
 *
 * ## 这个函数存在的理由
 *
 * 设置页有「看图识公式」勾选框，而在此之前 **core 里一次都没读过它** ——
 * 勾上之后扫描件依然无法处理，也没有任何提示。假开关比没有开关更糟。
 *
 * 现在这个勾选框是唯一入口：只有勾了 `visionFormula` 的后端才会被
 * 当作 OCR 候选。没勾的后端即使模型本身是多模态的也不会出现，
 * 因为用户可能明确不想让它乱花钱。
 *
 * `kind === 'agent-app'` 的排除与整理链路一致：那条路当前走不通
 * （新建表单已经不再提供这个选项，见提交 2705d37）。
 */
export function pickVisionBackends(backends: readonly BackendView[]): BackendView[] {
  return backends.filter(
    (b) =>
      b.kind === 'direct-api' &&
      b.capabilities.visionFormula &&
      b.hasCredential &&
      b.status === 'ready',
  );
}

/**
 * 视觉后端实现：任何 OpenAI 兼容的多模态模型。
 *
 * 与 `ModelBackend` 同样是「一层适配多家」：换服务商不改代码，
 * 只改设置页里填的地址与模型名。
 */
export class ModelVisionBackend implements VisionBackend {
  readonly id: string;
  readonly label: string;
  readonly isMock = false;
  /** 服务商标识，用量统计按它汇总 */
  readonly provider: string;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: VisionBackendOptions) {
    this.apiKey = options.apiKey;
    this.provider = options.provider ?? 'custom';
    this.model = options.model ?? findPreset(this.provider)?.defaultModel ?? 'gpt-4o-mini';
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.id = `vision:${this.provider}:${this.model}`;
    this.label = options.label ?? findPreset(this.provider)?.label ?? '视觉模型';
  }

  async extractPage(input: VisionPageInput): Promise<VisionPageResult> {
    if (!this.apiKey.trim()) {
      throw new OcrError(
        '这个后端还没有 API Key，无法识别图片',
        '请到设置页给这个后端填一把 Key，然后回来重试。',
        'invalid-key',
      );
    }

    if (!input.imageDataUrl.startsWith('data:image/')) {
      /**
       * 提前拦住，而不是把裸 base64 发出去。
       *
       * 服务端收到裸 base64 时不会明确报「格式不对」，而是返回
       * 一句像是图片坏了的话，排查会绕很远。
       */
      throw new OcrError(
        '页面图片的格式不对（不是 data URL）',
        '这是渲染环节的问题，不是你操作错了。请重试一次；若持续出现请反馈。',
        'bad-image',
      );
    }

    try {
      const result = await chatCompletion({
        apiKey: this.apiKey,
        model: this.model,
        provider: this.provider,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(input),
        images: [{ dataUrl: input.imageDataUrl, detail: 'high' }],
        // 识别只要照着抄，温度越低越稳
        temperature: 0,
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      return {
        text: normalizeOcrText(result.content),
        actualTokens: result.usage?.totalTokens ?? null,
      };
    } catch (err) {
      throw toOcrError(err, this.apiKey, this.provider);
    }
  }
}

/**
 * 规范化识别结果。
 *
 * 只做三件不改变内容的事：去掉模型偶尔包上的代码围栏、
 * 统一换行、去掉首尾空白。**不做**任何「看起来更整齐」的重写 ——
 * 这段文本要能逐字对回原页，改动越多越对不上。
 */
export function normalizeOcrText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');

  // 模型有时会把整段结果包进 ``` 或 ```text 里
  const fenced = text.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced?.[1] !== undefined) text = fenced[1];

  return text.trim();
}

/**
 * 把底层错误翻译成带可操作提示的 OcrError。
 *
 * 用户看到的不该是「Request failed with status code 400」——
 * 计划书从 P1 起就要求失败必须给出「下一步能做什么」。
 */
function toOcrError(err: unknown, apiKey: string, provider: string): OcrError {
  const preset = findPreset(provider);
  const who = preset?.label ?? '当前后端';

  if (err instanceof ApiError) {
    if (err.code === 'aborted') {
      return new OcrError('已停止识别', '已经识别完的页会保留，可以稍后继续剩下的页。', 'aborted');
    }
    /**
     * 多模态不被支持是这条链路上最常见、也最容易被误读的失败。
     * 用户会以为「我的扫描件坏了」，实际是这把后端根本看不了图。
     *
     * 这类失败在 OpenAI 兼容服务上通常报 400/422（chat-client 归类为
     * `bad-request`），少数报 403（模型无权使用 → `forbidden`）。
     * 两种都要指向「模型是不是多模态的」，否则用户只会看到
     * 「请求被服务端拒绝」然后去猜自己的 PDF 出了什么问题。
     */
    if (err.code === 'bad-request' || err.code === 'server-error' || err.code === 'forbidden') {
      return new OcrError(
        `识别失败：${redactSecrets(err.message, apiKey)}`,
        `${who} 可能不支持看图，或填的模型不是多模态模型。` +
          '请到设置页确认模型名（例如智谱 glm-4v、通义 qwen-vl-max、OpenAI gpt-4o），再试一次。',
        'vision-unsupported',
      );
    }
    return new OcrError(
      `识别失败：${redactSecrets(err.message, apiKey)}`,
      err.hint,
      err.code,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return new OcrError(
    `识别失败：${redactSecrets(message, apiKey)}`,
    '请稍后重试；若持续失败，可先在设置页用「测试连接」确认这把 Key 还能用。',
    'ocr-failed',
  );
}
