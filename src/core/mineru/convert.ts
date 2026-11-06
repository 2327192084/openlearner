/**
 * MinerU 本机转换器适配层。
 *
 * ## 为什么不是「又一个 VisionBackend」
 *
 * 现有的 `VisionBackend` 契约是**逐页**的：渲染一页 → 交给视觉模型 → 拿回一页文字。
 * 那是给「看图模型」设计的，每页一次 HTTP 请求。
 *
 * MinerU 是**整份文件**转换：喂一个 PDF，它自己跑版面检测 + OCR，
 * 一次产出带页码、带 bbox、带块类型的 JSON。逐页调用它等于把整本跑 N 遍，
 * 慢几十倍还会把跨页表格切碎。
 *
 * 所以这一层单独写，只负责一件事：
 * **把 MinerU 的 middle_json 变成「按页的正文」，页码严格 1:1 对应原 PDF。**
 *
 * ## 页码为什么必须 1:1
 *
 * 我们的 anchor 是 `{sourceId, page, charStart, charEnd}`，`charStart/charEnd`
 * 是**页内偏移**。只要文字的页号与原书一致，定位就是天然正确的，不需要
 * 「转换页 → 原页」对照表。用户要求「生成的文档能与原文件逐页对照」，
 * 这一点靠 page_idx 直接映射就成立 —— 前提是**绝不丢页**。
 *
 * 所以：MinerU 返回的每一页都要在结果里占一个位置。空页（整页插图/扉页）
 * 保留为空文本段而不是丢弃 —— 丢掉会让后面所有页错位一格。
 *
 * ## 几个实测到的坑（2026-11-06 本机 MinerU 4.1.7 验证）
 *
 * 1. **`page_idx` 从 0 开始**，我们的 `page` 从 1 开始 → 必须 +1，漏掉会整体错一页。
 * 2. **`mineru parse` 默认只解析前 10 页**（不是全部）。必须显式 `--pages all`，
 *    否则 628 页的教材只转出 10 页，而用户会以为整本转完了。
 * 3. **`mineru parse` 需要常驻 server**；`mineru-kit parse` 不需要，能在纯 CLI 下跑。
 *    我们走 `mineru-kit`。
 * 4. `mineru-kit parse` 默认 tier 是 `standard`（small models + VLM），
 *    首次会下载约 1.2GB 的 VLM 权重。`basic` 只用 ONNX 小模型（约 819MB），
 *    实测同为 OCR 但**空格断词不如 standard 准**（"第一章数据结构绪论" vs
 *    "第一章 数据结构绪论"）。默认用 standard，可在设置里改。
 */

/** 一页的转换结果 */
export interface MinerUPage {
  /** 页码，从 1 开始（已从 MinerU 的 0-based 转换） */
  page: number;
  /** 这一页的正文（已按块顺序拼接） */
  text: string;
  /** 这一页识别出的块数，0 表示整页没有文字（插图/扉页） */
  blockCount: number;
  /** 这一页的主导块类型，用于如实告诉用户这是正文页还是图表页 */
  kinds: string[];
}

/** 一次转换的完整结果 */
export interface MinerUResult {
  /** 原文件的页数（MinerU 认为的物理页数） */
  pageCount: number;
  /** 逐页结果，长度 === pageCount，顺序与页码一致 */
  pages: MinerUPage[];
  /** 实际用的 tier，如实记录（basic / standard / ...） */
  tier: string;
  /** 解析模式：native（原生文字层）/ ocr（走了 OCR）/ txt */
  parseMode: string;
  /** 生产者版本，便于排查「这个结果是哪个版本生成的」 */
  producer: string;
}

/** 转换失败的原因分类 —— 界面据此给出**不同**的下一步 */
export type MinerUTrouble =
  /** 找不到 mineru-kit 可执行文件 */
  | 'not-installed'
  /** 找得到但跑不起来（依赖坏了、Python 环境坏了） */
  | 'broken'
  /** 跑了但报错（文件坏、页数超限等） */
  | 'run-failed'
  /** 跑了但输出读不懂（版本不兼容） */
  | 'bad-output'
  /** 用户取消 */
  | 'aborted';

/** 带分类的转换错误。文案必须能让用户知道下一步做什么。 */
export class MinerUError extends Error {
  readonly trouble: MinerUTrouble;
  readonly hint: string;
  constructor(message: string, hint: string, trouble: MinerUTrouble) {
    super(message);
    this.name = 'MinerUError';
    this.trouble = trouble;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// 原始 JSON 的形状（只声明用得到的字段）
// ---------------------------------------------------------------------------

interface RawBlock {
  type?: string;
  index?: number;
  bbox?: number[];
  content?: Array<{ type?: string; content?: string }> | string;
  level?: number;
}

interface RawPage {
  page_idx?: number;
  blocks?: RawBlock[];
}

interface RawMiddleJson {
  metadata?: {
    producer?: { name?: string; version?: string };
    document?: { page_count?: number };
  };
  extensions?: {
    mineru?: { tier?: string; parse_mode?: string };
  };
  pages?: RawPage[];
}

/**
 * 把 MinerU 的 middle_json 解析成按页正文。
 *
 * 纯函数，不碰文件系统 —— 这样可以拿真实样本做单测，不需要每次跑 MinerU。
 */
export function parseMiddleJson(raw: unknown): MinerUResult {
  if (!raw || typeof raw !== 'object') {
    throw new MinerUError(
      'MinerU 返回的结果不是 JSON 对象。',
      '这通常意味着 MinerU 版本与我们的适配层不兼容（我们按 4.x 的 middle_json 格式解析）。请确认安装的是 MinerU 4.x。',
      'bad-output',
    );
  }

  const doc = raw as RawMiddleJson;
  const rawPages = doc.pages;
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new MinerUError(
      'MinerU 的结果里没有 pages 字段或页数为 0。',
      '可能是这份文件 MinerU 解析不出内容。换一份文件试试；如果任何文件都这样，多半是 mineru-kit 版本不对。',
      'bad-output',
    );
  }

  // 按 page_idx 排序后再映射，不依赖 MinerU 输出的数组顺序
  const sorted = [...rawPages].sort((a, b) => (a.page_idx ?? 0) - (b.page_idx ?? 0));

  /*
   * 找出页码的最大值与最小值。
   *
   * 正常情况下是 0..n-1 连续。若 MinerU 因为某种原因跳页，
   * 我们要**按它给的页码建结果**而不是按数组下标 —— 否则第 5 页缺失时，
   * 第 6 页会被当成第 5 页，后面全错位。
   */
  const indices = sorted.map((p) => p.page_idx ?? 0);
  const maxIdx = Math.max(...indices);
  const metaPageCount = doc.metadata?.document?.page_count;

  /*
   * 总页数取三者最大值：
   *  - 原始 metadata 说多少页
   *  - MinerU 实际给出的最大 page_idx + 1
   *  - 给出的页数条目数
   * 取最大是为了「宁可留空页，也不让后面的页前移」。
   */
  const pageCount = Math.max(metaPageCount ?? 0, maxIdx + 1, sorted.length);

  const pages: MinerUPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    const rawPage = sorted.find((p) => (p.page_idx ?? 0) === i);
    if (!rawPage) {
      // 缺失页：占位为空文本，保证后续页号不错位
      pages.push({ page: i + 1, text: '', blockCount: 0, kinds: [] });
      continue;
    }
    const blocks = Array.isArray(rawPage.blocks) ? rawPage.blocks : [];
    const kinds: string[] = [];
    const parts: string[] = [];

    for (const b of blocks) {
      const kind = b.type ?? 'text';
      kinds.push(kind);

      const text = blockToText(b);
      if (text) parts.push(text);
    }

    pages.push({
      page: i + 1,
      text: parts.join('\n\n'),
      blockCount: blocks.length,
      kinds: [...new Set(kinds)],
    });
  }

  return {
    pageCount,
    pages,
    tier: doc.extensions?.mineru?.tier ?? 'unknown',
    parseMode: doc.extensions?.mineru?.parse_mode ?? 'unknown',
    producer: doc.metadata?.producer?.version ?? 'unknown',
  };
}

/**
 * 把 block 转成文本。
 *
 * MinerU 的 block 有两种形状：
 *  - `content` 是数组：`[{type:'text', content:'...'}, ...]`
 *  - `content` 是字符串（某些类型的 block）
 *
 * ⚠️ 只收**纯文本块**。表格块的 content 是 HTML（`<table>...`）、
 * 公式块是 LaTeX —— 把它们塞进 `sourceSegments.text` 会让全文搜索
 * 和字符偏移锚点一起失效（用户搜「线性表」命中不到，高亮切在标签中间）。
 * 这些块的类型仍然记进 `kinds`，界面能如实说「这一页有表格」。
 *
 * 这条规则由测试钉住（`convert.test.ts` 的「表格/公式块不进纯文本正文」）。
 */
function blockToText(block: RawBlock): string {
  const { type, content } = block;

  // 表格 / 公式 / 图片：不转成纯文本
  if (type === 'table' || type === 'equation' || type === 'interline_equation' || type === 'image') {
    return '';
  }

  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const c of content) {
      // 只取纯文本片段；image/table/equation 等保留在 kinds 里
      if (c?.type === 'text' && typeof c.content === 'string' && c.content.trim()) {
        texts.push(c.content.trim());
      }
    }
    return texts.join('\n');
  }

  return '';
}

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
