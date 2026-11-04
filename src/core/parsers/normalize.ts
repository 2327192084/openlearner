/**
 * 文本规范化 —— 决定「原文」长什么样的地方。
 *
 * 这里的每条规则都不是凭空想的，是对着真实 PDF 的取词结果定的
 * （见 scripts/make-fixtures.cjs 生成的样本与 .scratch/probe-gaps.mjs 的实测）。
 *
 * 实测发现两件必须处理的事：
 *
 * 1. **PDF 会在行尾硬断句**。同一段话的第二行是独立的海拔基线，
 *    取出来是「…线性结构包括线性表、栈、队列、串；非线性」+「结构包括树与图。」
 *    中间没有连接符。如果不接回去，全文搜索整句永远搜不到。
 *
 * 2. **段内折行与段落间距不同**。实测 y 间距：
 *    段内折行 23.25，段落之间 32.25 / 37.5。
 *    所以不能一律「一行就是一段」，否则段数会虚高几倍、
 *    每段都被切碎，后面出题与 PPT 引用都会拿到半句话。
 *
 * 于是分两步：先按行距把行分组成块（layout 层），再在块内做拼接（本文件）。
 */

/** 一行文本及其位置信息 */
export interface TextLine {
  text: string;
  /** 该行左端 x，用于缩进判断（段首缩进提示新段落） */
  x: number;
  /** 基线 y，越大越靠上 */
  y: number;
  /** 行高 */
  height: number;
}

/** 一个逻辑块（≈一个段落或一个标题） */
export interface TextBlock {
  text: string;
  /** 块内第一行的 y，用于排序 */
  y: number;
  /** 块内最大行高，用于判断是否标题 */
  height: number;
  /** 组成这个块的行数 */
  lineCount: number;
}

/**
 * 把一个字符是否属于「可在行尾断开的中文」。
 *
 * 用于判断两行之间要不要补连接：中文断行处直接拼接即可，
 * 英文断行处原文可能有个空格，直接拼会粘成一个词。
 */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // 中日韩标点
    (code >= 0xff00 && code <= 0xffef) // 全角
  );
}

/**
 * 把行分组成逻辑块。
 *
 * 判据是 **间距 / 行高 的比值**，不是绝对像素，也不是间距中位数。
 *
 * 为什么不用间距中位数（第一版做法，实测失败）：一份讲义里段内折行通常只有
 * 少数几处、段落分隔反而更多，中位数会被段落间距污染成「段落间距」，
 * 于是阈值算成 1.5 × 段落间距，所有段落都被并成一块。
 * 实测样本里 5 行全被合成 1 段，就是这个原因。
 *
 * 为什么用行高归一化：行高反映字号，字号的倍数反映排版意图。
 * 实测样本 h=12：
 *   段内折行 23.25 → 1.94 倍行高
 *   段落之间 32.25 → 2.69 倍
 *   标题到正文 37.5 → 2.34 倍（标题 h=16）
 * 取 2.2 作阈值，三处判断全部正确，且换字号/换模板依然成立。
 */
export function groupLinesIntoBlocks(lines: TextLine[]): TextBlock[] {
  if (lines.length === 0) return [];

  // 按 y 从上到下（y 越大越靠上）
  const sorted = [...lines].sort((a, b) => b.y - a.y);

  /** 间距超过行高的这个倍数，判为新段落 */
  const PARAGRAPH_GAP_RATIO = 2.2;

  const blocks: TextBlock[] = [];
  let current: TextLine[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const line = sorted[i];
    const gap = prev.y - line.y;

    // 用两行里较大的行高做基准，避免标题行被误判
    const unit = Math.max(prev.height || 12, line.height || 12);
    const bigGap = gap > unit * PARAGRAPH_GAP_RATIO;

    // 附带条件：本行明显右缩进（中文段首空两格）也是换段信号。
    // 只在上一行看起来是"满行"时才信这个信号，否则长句折行会被切碎。
    const indentThreshold = unit * 1.2;
    const indented = line.x - prev.x > indentThreshold;

    if (bigGap || indented) {
      blocks.push(mergeLines(current));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(mergeLines(current));

  return blocks.filter((b) => b.text.trim().length > 0);
}

/**
 * 把一组行拼成一个块。
 *
 * 关键：中文断行处**不加空格**，英文断行处**加一个空格**。
 * 直接 `join('')` 会把英文单词粘起来（"algo" + "rithm" → "algor ithm" 之外的问题），
 * 直接 `join(' ')` 会在中文正文里塞满空格，让「搜整句」失败。
 */
function mergeLines(lines: TextLine[]): TextBlock {
  let text = '';
  for (const line of lines) {
    const piece = line.text.trim();
    if (!piece) continue;

    if (text === '') {
      text = piece;
      continue;
    }

    const prevChar = text[text.length - 1];
    const nextChar = piece[0];
    // 两侧都是中日韩字符/标点 → 直接拼；否则补空格
    const needsSpace = !(isCjk(prevChar) || isCjk(nextChar));
    text += needsSpace ? ` ${piece}` : piece;
  }

  return {
    text,
    y: Math.max(...lines.map((l) => l.y)),
    height: Math.max(...lines.map((l) => l.height)),
    lineCount: lines.length,
  };
}

/**
 * 把块拼成最终正文。
 * 段落之间用 `\n\n` 分隔，这样：
 *  - 阅读器能按段落渲染
 *  - 全文搜索可以用「去换行后的整页文本」匹配，不因分段而漏
 */
export function blocksToText(blocks: TextBlock[]): string {
  return blocks
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 清洗纯文本（粘贴、TXT、MD 代码块外内容）。
 *
 * 只做三件保守的事，不重排段落 —— 用户粘贴什么就是什么，
 * 我们不该替他改写原文：
 *  1. 统一换行符
 *  2. 去掉行尾空白（会让搜索与高亮偏移出错）
 *  3. 连续 3 个以上空行压成 2 个（视觉噪声，不影响内容）
 */
export function normalizePlainText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 判断一段文本是不是「基本没内容」。
 *
 * 用于扫描件判定：pdfjs 对扫描件返回空字符串。
 * 阈值取 20 个非空白字符 —— 有些扫描件页面会有页眉页脚（页码、书名），
 * 只有那几个字不算「有文本层」。
 */
export function looksLikeNoText(text: string): boolean {
  const meaningful = text.replace(/\s/g, '');
  return meaningful.length < 20;
}
