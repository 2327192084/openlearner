import type {
  KnowledgeDraft,
  OrganizeBackend,
  OrganizeInputSegment,
  OrganizeRequest,
  OrganizeResult,
} from './backend-types.ts';

/**
 * 假后端：不联网、不花钱、结果可预测。
 *
 * 它不是"测试用的小玩具"，有三个正经用途：
 *
 * 1. **P2 验收**：计划书明确要求「用假后端（固定返回）也能跑通整个流程」。
 * 2. **演示**：P7 要「拔网线、清空所有 Key，仍能完整走通」。
 *    评审不会去配 API Key，假后端是体验模式的基础设施。
 * 3. **回归**：真实模型输出不稳定，假后端让"定位是否准确"这类测试可重复。
 *
 * 实现策略：从真实原文里**摘句子**当知识点，引用就是那句原文。
 * 这样定位器一定能定位成功，且内容与教材确实对得上 ——
 * 不会出现"假数据看起来像真的但其实对不上原文"这种更糟的情况。
 */
export class MockBackend implements OrganizeBackend {
  readonly id = 'mock';
  readonly label = '示例后端（离线，不联网）';
  readonly isMock = true;

  /** 每条知识点之间的人为延迟，让界面上的进度条能被看见 */
  constructor(private readonly delayMs = 120) {}

  estimateTokens(segments: OrganizeInputSegment[]): number {
    // 粗估：中文约 1 字 ≈ 1.6 token（含标点与 JSON 开销）
    const chars = segments.reduce((sum, s) => sum + s.text.length, 0);
    return Math.ceil(chars * 1.6) + 200;
  }

  async organize(request: OrganizeRequest): Promise<OrganizeResult> {
    const drafts: KnowledgeDraft[] = [];
    let stopped = false;

    for (const segment of request.segments) {
      if (request.signal.aborted) {
        stopped = true;
        break;
      }

      for (const draft of this.extractFromSegment(segment)) {
        if (request.signal.aborted) {
          stopped = true;
          break;
        }

        // 模拟网络/推理耗时，让「进度」和「中途停止」是真的可观察的行为
        if (this.delayMs > 0) {
          await sleep(this.delayMs, request.signal);
        }
        if (request.signal.aborted) {
          stopped = true;
          break;
        }

        drafts.push(draft);
        // 必须 await：调用方在这里定位并落库，
        // 只有等它做完，下一轮循环的 aborted 检查才有意义
        await request.onDraft?.(draft);

        // onDraft 内部可能触发了停止，立刻检查
        if (request.signal.aborted) {
          stopped = true;
          break;
        }
      }

      if (stopped) break;
    }

    return {
      drafts,
      // 假后端按已产出的条数估算，让"实际用量"有真实含义
      actualTokens: drafts.length * 120 + 200,
      stopped,
    };
  }

  /**
   * 从一段原文里摘出若干条「知识点」。
   *
   * ## 这里**不做总结**，是刻意的
   *
   * 早期实现是把句子末尾的标点去掉就当 statement，结果界面上看到的是
   * 「第一章 数据结构绪论 数据结构研究的是数据元素之间的关系…」——
   * 和原文一模一样。用户会以为「AI 的总结能力很差」，
   * 实际上是**根本没用上 AI**。
   *
   * 现在的做法：如实表达「这是摘录，不是总结」。
   * statement 明确写成「原文摘录：…」的形式，并且在前面加上
   * 可被识别的水印式标注，让人一眼看出这批结果是示例后端的产物。
   *
   * 为什么不去伪造一个「看起来像总结」的句子：
   * 那会让示例结果和真实 AI 结果难以区分，用户没法判断
   * 「是模型不行」还是「我在用假后端」。诚实地难看，比体面地误导强。
   *
   * ## 它真正的用途
   *
   * 1. 验证「导入 → 定位 → 校对」这条链路通不通（不花钱）
   * 2. P7 体验模式：评审不配 Key 也能看到完整交互
   * 它从来不是一个「凑合能用的总结器」。
   */
  private extractFromSegment(segment: OrganizeInputSegment): KnowledgeDraft[] {
    const sentences = segment.text
      .split(/(?<=[。！？；])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12);

    const drafts: KnowledgeDraft[] = [];

    for (const raw of sentences.slice(0, 4)) {
      const core = raw.replace(/[。！？；]+$/, '');
      if (core.length < 10) continue;

      drafts.push({
        // 明确标注这是摘录而非总结，避免被误认为 AI 的输出质量
        statement: `【原文摘录·未经提炼】${core}`,
        // 引用用原文整句（含标点），确保能在原文里字面命中
        quotes: [raw],
        cognitiveLevel: guessLevel(raw),
        tags: [...(segment.chapter ? [segment.chapter] : []), '示例后端'],
      });
    }

    return drafts;
  }
}

/** 按句子特征猜一个认知层级。只是建议值，用户可以改。 */
function guessLevel(sentence: string): KnowledgeDraft['cognitiveLevel'] {
  if (/(定义|是指|称为|叫做|概念)/.test(sentence)) return 'remember';
  if (/(因为|由于|原因|原理|为什么)/.test(sentence)) return 'understand';
  if (/(步骤|操作|实现|计算|方法)/.test(sentence)) return 'apply';
  if (/(比较|区别|优缺点|分析|适用)/.test(sentence)) return 'analyze';
  return 'understand';
}

/**
 * 可被中断的 sleep。
 *
 * 不用 setTimeout 直接包 Promise：那样停止操作要等到 sleep 结束才生效，
 * 用户点了「停止」却还要等一秒才反应，会以为按钮没作用。
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
