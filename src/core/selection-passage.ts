/**
 * 划选提问：把「用户在原文里选中的一段」变成一条可提问的素材（2026-11-10）。
 *
 * ## 它补的是哪一段
 *
 * 提问式复习三期只做了「知识点随机」一条路。用户最初要的是
 * 「整本书随机 / 某章节 / 某段落 / 知识点」四种范围 —— 前两种靠
 * `segmentsToMaterials()`（整份资料 / 按章节筛），知识点靠
 * `pointsToMaterials()`。缺的正是**某段落**：用户自己划出来的那一段。
 *
 * ## 为什么在阅读器里划选，而不是在出题页做段落选择器
 *
 * 用户的思路原话：「可以让用户跳转到资料原文进行划分选择」。
 * 在出题页摆一个段落列表，用户得先认出「第 47 段大概是那一页中间那块」——
 * 而他刚才在原文里明明已经看着那段话了。所见即所得，少一次猜测。
 *
 * ## 两个从 StudyHub 借来的关键判断
 *
 * 调研方法：`api.github.com/repos/EricWang1358/dsh-web-studyhub/contents/<path>`
 * 取 base64（raw 不通），读 `lib/selection-evidence.js` 与
 * `lib/contexts/generation/selection.js`。
 *
 * 1. **短选区要扩上下文**。StudyHub 的 `selectionEvidenceText()`：
 *    `quote.length >= 12` 时直接用引文，否则取
 *    `text.slice(start-300, end+300)`。理由写在它的注释里 ——
 *    「a short table cell needs its nearby labels as evidence」。
 *    对我们同样成立：用户划中「f(x)」这一个词，模型拿它问不出
 *    「条件 / 区别 / 因果」这类题，判定的时候也没有原文可比对。
 *
 * 2. **同一段要能判重**。StudyHub 的 `passageKey()` 用
 *    `sourceId|start:end` 拼键，注释是「Two selections are the same
 *    passage when they point at the same text of the same material」。
 *    我们用同样的形状，但**只用于界面提示重复**，不做去重删除 ——
 *    用户可能故意就同一段问两次不同的问题。
 *
 * 我们**没有**照搬的部分：StudyHub 把划选做成后台任务（`selection-jobs.js`，
 * 带 job 表、队列、取消、inbox 通知）。那是因为它一次要生成整套题并
 * 走独立评审。我们这里只出一**道**问答题、且是即时问答，走后台任务
 * 反而让用户看不到「它在问我什么」。所以保持同步一轮。
 *
 * ## 本模块只做纯逻辑
 *
 * 不碰 DOM、不发请求、不碰存储。DOM 那一步（把 Range 量成字符偏移）
 * 留在 `ReaderPage`，因为它必须读真实选区。
 */

import type { OralMaterial } from './oral-review.ts';

// ---------------------------------------------------------------------------
// 选区表示
// ---------------------------------------------------------------------------

/**
 * 用户在正文里划中的一段。
 *
 * `start`/`end` 是**段内字符偏移**（相对 `SourceSegment.text`），
 * 与批注的 `TextMarkAnchor` 同一套坐标 —— 两者都靠这组偏移回画高亮，
 * 换一套会出现「标记画得对、提问取错段」。
 */
export interface PassageSelection {
  /** 资料 id */
  sourceId: string;
  /** 页码（= 段序号，见 SourceSegment.page 注释） */
  page: number;
  /** 选中文字（已 trim，逐字） */
  quote: string;
  /** 段内起始偏移；-1 = 没量出来，只能靠 quote 找 */
  start: number;
  /** 段内结束偏移（不含）；-1 = 没量出来 */
  end: number;
  /** 所属章节，用于给用户看的来源说明 */
  chapter: string | null;
}

/**
 * 短于这个长度的选区要扩上下文。
 *
 * 12 是 StudyHub `selectionEvidenceText()` 的门槛，照抄并保留理由：
 * 一两个字的选区（「熵」「f(x)」「图 3」）脱离上下文没有可问的东西。
 * 12 个字以上通常已经是一句完整的话，自己就够当依据。
 */
export const SHORT_QUOTE_CHARS = 12;

/**
 * 短选区向两侧各扩多少字。
 *
 * 300 同样来自 `selectionEvidenceText()`。上限考虑：一段正文通常
 * 几百到一两千字，两侧各 300 一般能覆盖住「这一小节在讲什么」，
 * 又不至于把整页塞给模型（问答一轮的 token 里这是主要开销）。
 */
export const CONTEXT_WINDOW_CHARS = 300;

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

/**
 * 把「选中的文字」定位回段内偏移。
 *
 * ## 为什么必须给提示位置，不能只 indexOf
 *
 * `ReaderPage.handleAddMark` 的注释记着这个坑：同一句话在一页里
 * 出现两次时，`indexOf` 永远给第一个 —— 用户标的是第二处，
 * 高亮却画在第一处，而界面上看着都像对的，极难发现。
 *
 * 所以入参带一个 `hintStart`（调用方用 Range 从容器开头量到选区起点
 * 得到的近似值），先就地验证，不中再在附近搜，最后才退回全段搜。
 *
 * ## 为什么先验证再接受提示值
 *
 * 提示值是「DOM 文本长度」量的，而 `seg.text` 是**规范化后**的正文
 * （PDF 里行尾硬断开的句子已接回整句，见 model.ts 的 SourceSegment 注释）。
 * 两者可能差几个字。就地验证保证偏移一定真的指着那句话，
 * 而不是差几个字符导致取到「那句话 + 半个下句」。
 *
 * @returns `{start, end}`；找不到时 `{start: -1, end: -1}`
 */
export function locateSelection(
  pageText: string,
  quote: string,
  hintStart: number,
): { start: number; end: number } {
  const exact = quote.trim();
  if (!exact || !pageText) return { start: -1, end: -1 };

  const hint = Number.isFinite(hintStart) ? Math.max(0, Math.floor(hintStart)) : -1;

  /* 1. 提示位置正中靶心 —— 最常见的情况，直接采信 */
  if (hint >= 0 && pageText.slice(hint, hint + exact.length) === exact) {
    return { start: hint, end: hint + exact.length };
  }

  /*
   * 2. 取**离提示位置最近**的那一处。
   *
   * ## 为什么不是「从 hint-40 往后找第一个」
   *
   * 第一版就是那么写的，被单测抓住：提示值偏后 6 个字时，「往后找第一个」
   * 会一路回溯到**更早的另一处**相同文字。同一段里有两句一样的话时
   * （教材里复述定义很常见），这等于稳定地选错一处。
   *
   * 最近优先才是「用户看着这里选的」的正确翻译：提示值来自真实选区的
   * Range 测量，误差是个位数；两处相同文字再近也隔着一整句。
   *
   * ## 为什么收集全部出现位置而不是滑窗
   *
   * 一段正文里同一句话出现不了几次，全收的成本可以忽略；
   * 而滑窗搜索的边界条件（第一次出现在 hint 之前、第二次在之后）
   * 正是上面那个 bug 的来源。简单枚举不会有边界。
   */
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = pageText.indexOf(exact); i >= 0; i = pageText.indexOf(exact, i + 1)) {
    if (hint < 0) return { start: i, end: i + exact.length };
    const dist = Math.abs(i - hint);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best >= 0) return { start: best, end: best + exact.length };

  /*
   * 4. 没找到。
   *
   * 不猜 0。handleAddMark 里 `start < 0 → 0` 是为了「至少留个 exact 兜底」，
   * 但提问不同：偏移错了会把**别的段落**当依据发给模型，
   * 模型据此判定就等于拿错答案改用户。宁可让调用方按 quote 搜。
   */
  return { start: -1, end: -1 };
}

// ---------------------------------------------------------------------------
// 转成提问素材
// ---------------------------------------------------------------------------

/**
 * 取「真正发给模型看的那段文字」。
 *
 * 长选区直接用引文；短选区向两侧扩，并**如实告诉用户**扩了
 * （返回的 `expanded` 用于界面提示），而不是悄悄多塞几百字。
 *
 * 扩的时候带上省略号：模型看到「…」才知道这段是从中间截出来的，
 * 不会误以为正文从这里开始。
 */
export function evidenceText(
  pageText: string,
  quote: string,
  start: number,
  end: number,
): { text: string; expanded: boolean } {
  const exact = quote.trim();
  if (!exact) return { text: '', expanded: false };

  /*
   * 偏移不可用（没量出来）时只能用引文本身。
   *
   * 这里**不**试图用 indexOf 重新定位再扩 —— 那等于在没把握的
   * 起点上再猜一次，而扩错的上下文比没有上下文更糟（模型会
   * 拿隔壁段落的内容当依据）。
   */
  if (start < 0 || end < 0 || end <= start) {
    return { text: exact, expanded: false };
  }

  if (exact.length >= SHORT_QUOTE_CHARS) {
    return { text: exact, expanded: false };
  }

  const from = Math.max(0, start - CONTEXT_WINDOW_CHARS);
  const to = Math.min(pageText.length, end + CONTEXT_WINDOW_CHARS);
  const head = from > 0 ? '…' : '';
  const tail = to < pageText.length ? '…' : '';

  return { text: `${head}${pageText.slice(from, to).trim()}${tail}`, expanded: true };
}

/**
 * 选区 → 提问素材。
 *
 * `sourceTitle` 用于给用户看「这段从哪来」。`label` 的拼法与
 * `segmentsToMaterials()` 保持一致（资料 · 章节 · 页码），
 * 免得同一份资料在不同入口显示成两种样子。
 *
 * @param pageText 该段完整正文（用于短选区扩上下文）
 */
export function passageToMaterial(
  selection: PassageSelection,
  pageText: string,
  sourceTitle: string,
): OralMaterial {
  const { text } = evidenceText(pageText, selection.quote, selection.start, selection.end);

  const label = [
    sourceTitle,
    selection.chapter?.trim() || null,
    selection.page > 0 ? `第 ${selection.page} 页` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' · ');

  return {
    /*
     * id 用 `passage:` 前缀 + 坐标。
     *
     * 不与段落 id 复用：素材 id 会在「换一题」与保存记录里当身份用，
     * 同一个段落的「整段提问」和「划选提问」是两次不同的提问，
     * 混用同一个 id 会让记录看起来像重复。
     */
    id: `passage:${selection.sourceId}:${selection.page}:${selection.start}:${selection.end}`,
    label: label || `第 ${selection.page} 页 · 划线片段`,
    text,
    sourceId: selection.sourceId,
    page: selection.page > 0 ? selection.page : null,
    chapter: selection.chapter,
    /* 划选来自正文，不是知识点 */
    pointId: null,
  };
}

/**
 * 「同一段」的判重键。
 *
 * 形状照抄 StudyHub `passageKey()`（`sourceId|start:end`），
 * 偏移不可用时退回引文本身。
 *
 * 用途仅限界面提示「这段你刚问过」—— 不做静默去重：
 * 用户可能就想对同一段再问一次换个角度。
 */
export function passageKey(selection: PassageSelection): string {
  const pos =
    selection.start >= 0 && selection.end >= 0
      ? `${selection.start}:${selection.end}`
      : selection.quote.trim();
  return `${selection.sourceId}|${selection.page}|${pos}`;
}
