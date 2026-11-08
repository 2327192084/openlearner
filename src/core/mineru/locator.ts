/**
 * MinerU 图片定位符（locator）的解析与配对。
 *
 * ## 背景：一句话说清 B 是什么
 *
 * MinerU 转 PDF 时，正文里的插图会被换成一行定位符：
 *
 * ```markdown
 * ![Image block](doc:87731df/tier:standard/page:1/block:7)
 *
 * 图1.1 含有电压源 $v_{s}$ 和电容器
 * ```
 *
 * 我们以前**把这一行整行丢掉**（见 markdown.ts 的 cleanMarkdown），
 * 所以阅读器里插图位置只剩下一句图注，图本身没了。
 *
 * ## ⚠️ 为什么图片不写进 SourceSegment.text
 *
 * 这是本轮最重要的设计约束，先说清楚再改代码。
 *
 * `KnowledgePoint.charStart/charEnd` 是**相对 SourceSegment.text 的字符偏移**
 * （见 model.ts 的注释）。库里已经有 95 个知识点按当前 text 算好了偏移。
 * 一旦往 text 里插入图片占位符（哪怕一个字符），它后面所有字符的偏移都会平移，
 * 95 个知识点的高亮与「点回原文」会**集体错位** —— 而且错得不明显，
 * 只是高亮偏了几个字，用户很难判断是数据坏了还是自己记错了。
 *
 * 所以：**text 字节保持不变**，图片单独存一张表（sourceImages），
 * 用「在这段文本的第几个字符处」记录位置，渲染时再插回去。
 *
 * 这个锚点是 `charOffset`，含义与 charStart 一致（段内偏移）。
 *
 * ## 定位符格式（实测 2026-11-08，MinerU 4.1.7）
 *
 *     doc:<sha256 前 7 位>/tier:<tier>/page:<页码>/block:<块号>
 *
 * 三个必须知道的事实（都实测过，不是猜的）：
 *
 * 1. **block 是 1 基**，对应解析结果 JSON 里 `block.index + 1`。
 *    证据：`mineru/doclib/services/content_read_svc.py` 的 `_find_block_by_no`
 *    写的就是 `target_index = block_no - 1`。
 * 2. **page 是 1 基**，与原书页码一致。
 * 3. **tier 必须原样带回**：`mineru read` 找不到该 tier 的解析缓存就报
 *    `Requested parsed content is not cached.` 实测 flash/basic/standard
 *    三个 tier 对同一 block 都能出图（图内容相同），所以存哪个 tier 都行，
 *    但**必须存实际用的那个**，不能默认 basic。
 *
 * ## 关于 doc: 里的 sha256 前缀
 *
 * 只有前 7 位，够 MinerU 自己定位（它按 short_id 查 doclib.db）。
 * 我们把它原样存下来，用于「同一份资料重转后判断是不是同一份」——
 * **不要**用它当主键，它不是完整哈希。
 */

/** 一个已解析的图片定位符 */
export interface ImageLocator {
  /** MinerU 文档短 id（sha256 前 7 位），原样保留 */
  doc: string;
  /** 解析档位。取图时必须原样带回，否则会报「缓存不存在」 */
  tier: string;
  /** 页码，1 基，与原书一致 */
  page: number;
  /** 块号，1 基。等于解析 JSON 里的 block.index + 1 */
  block: number;
  /** 原始定位符串（不含 `doc:` 前缀，即 read 命令要的完整值） */
  raw: string;
}

/**
 * 块类型标签 → 我们的内部类型。
 *
 * MinerU 在 Markdown 里用 alt 文本区分类型（见 content_read_svc.py 的
 * `_VISUAL_BLOCK_LABELS`）：Image block / Table block / Chart block / Formula block。
 *
 * 为什么要把 chart 和 image 分开存：后续如果要做「公式图片转 LaTeX」
 * 或「表格另存」，得能按类型筛。现在渲染方式一样，但存的时候不合并。
 */
export type FigureKind = 'image' | 'chart' | 'table' | 'formula';

const LABEL_TO_KIND: Record<string, FigureKind> = {
  'Image block': 'image',
  'Chart block': 'chart',
  'Table block': 'table',
  'Formula block': 'formula',
};

/** 把 alt 文本映射成内部类型。认不出来一律当 image（不丢数据优先） */
export function kindOfLabel(label: string): FigureKind {
  return LABEL_TO_KIND[label.trim()] ?? 'image';
}

/**
 * 定位符本体正则。
 *
 * 分段写、逐段校验，而不是一个巨型正则 —— 巨型正则出问题时
 * 只能整条重写，分段的可以指出到底哪一段没匹配上。
 */
const LOCATOR_RE = /^doc:([0-9a-f]{7,64})\/tier:([a-z]+)\/page:(\d+)\/block:(\d+)$/;

/**
 * 解析一个定位符。格式不对返回 null（**不抛异常**）。
 *
 * 为什么返回 null 而不是抛：调用方在遍历整篇 Markdown，一处格式异常
 * 不该让整份资料转换失败 —— 丢掉那一张图，其余照常。
 */
export function parseLocator(raw: string): ImageLocator | null {
  const m = LOCATOR_RE.exec(raw.trim());
  if (!m) return null;

  const page = Number(m[3]);
  const block = Number(m[4]);
  // 页码/块号都是 1 基，0 或负数说明格式坏了
  if (!Number.isInteger(page) || page < 1) return null;
  if (!Number.isInteger(block) || block < 1) return null;

  return { doc: m[1]!, tier: m[2]!, page, block, raw: raw.trim() };
}

/**
 * 拼回 `mineru read` 需要的定位符串（含 `doc:` 前缀）。
 *
 * 单独写这一个函数是因为 `read` 命令要的是完整串，
 * 而我们内部存的是拆开的字段 —— 手拼容易漏前缀，实测漏了会报
 * `invalid locator`，那个错误信息不会提示你少了 `doc:`。
 */
export function formatLocator(loc: Pick<ImageLocator, 'doc' | 'tier' | 'page' | 'block'>): string {
  return `doc:${loc.doc}/tier:${loc.tier}/page:${loc.page}/block:${loc.block}`;
}

/**
 * Markdown 里一整行的图片引用。
 *
 * 只认「整行只有一个图片」的情况。为什么：
 *  - 实测这份教材的 88 个定位符**全部单独成行**（夹在文字里的 0 个）
 *  - MinerU 输出本来就是块级结构，图不会和正文挤在一行
 *  - 逐行判断比全文找 `![...](...)` 安全：正文里真出现 `![` 也不会误伤
 *
 * 如果以后遇到行内图片，这里会漏掉（图片不显示），但**不会**把正文搞坏 ——
 * 宁可少一张图，也不要往 text 里插错东西。
 */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

/** 一行图片引用的解析结果 */
export interface ParsedImageLine {
  /** 块类型（由 alt 文本判定） */
  kind: FigureKind;
  /** 原始 alt 文本，存下来备查 */
  label: string;
  /** 解析出的定位符；非 doc: 形式（比如外链）时为 null */
  locator: ImageLocator | null;
}

/**
 * 判断一行（已 trim）是不是图片引用行；是则返回解析结果，否则 null。
 *
 * 外链图片（`![x](https://...)`）也会被认出来，但 locator 为 null ——
 * 调用方据此决定「这条路我们取不了图」，而不是当成格式错误丢掉。
 */
export function parseImageLine(line: string): ParsedImageLine | null {
  const m = IMAGE_LINE_RE.exec(line.trim());
  if (!m) return null;

  const label = m[1] ?? '';
  const target = m[2] ?? '';
  return {
    kind: kindOfLabel(label),
    label,
    locator: target.startsWith('doc:') ? parseLocator(target) : null,
  };
}
