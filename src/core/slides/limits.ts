/**
 * 幻灯片的排版约束。
 *
 * 这些数字不是随手定的，是从「一页 16:9、要点 18pt、中文一行约 22 字」倒推出来的：
 *   - 正文区高度约 4.2 英寸，18pt 行高约 0.34 英寸 → 12 行；
 *   - 每条要点按平均 2 行算 → 一页最多 5 条（留 2 行余量给标点和角标）。
 *
 * 超限时的处理是**拆页**而不是截断 —— 计划书 P4 第 6 条明确要求
 * 「内容超长时合理分页，不截断、不溢出」。截断会丢内容，
 * 而丢内容比多一页糟糕得多：学生以为这页就是全部。
 */
export const SLIDE_LIMITS = {
  /** 每页要点条数上限 */
  maxBulletsPerPage: 5,
  /**
   * 单条要点字符上限。
   *
   * 超过就按标点拆成多条要点，而不是缩字号。
   * 缩字号会让不同页的字号不一致，翻页时视觉跳；
   * 而拆成两条要点在语义上仍然成立（本来就是两句话）。
   */
  maxBulletChars: 88,
  /** 封面的主标题字符上限，超出换行 */
  maxTitleChars: 40,
  /** 章节过渡页标题字符上限 */
  maxSectionTitleChars: 36,
  /** 资料来源页每页最多列多少条，超出继续分页 */
  maxCitationsPerPage: 12,
  /** 资料页里每条引用显示的原文片段长度，够核对即可，不宜占满版面 */
  quotePreviewChars: 34,
} as const;

/**
 * 把文本里的换行与连续空白压成单个空格。
 *
 * ## 为什么必须有这一步（不是洁癖，是导出会叠字）
 *
 * pptxgenjs 把文本里的换行符编成**独立段落**（XML 里是多个 `<a:p>`，
 * 而不是 `<a:br/>`）。要点文本框高度固定 0.8 英寸、行距 0.86 英寸，
 * 一条要点的文字变成两段后，第二段就压到下一条要点的位置上 ——
 * 导出的 PPT 在 Office / WPS 里是**两行字叠在一起**。
 *
 * 这个缺陷所有自动验收都测不出来（文字确实都在，角标也在，
 * 页数也对），只有把 pptx 真的渲染成图片用眼睛看才发现。
 *
 * 换行的来源很实际：mock 后端按句切分原文，而 PDF 抽出的段落文本里
 * 带着章节标题行的换行；用户自己从 PDF 复制粘贴一段话也会带换行。
 *
 * **只折叠空白，一个字都不删**（截断会丢内容，这是另一件事）。
 */
export function normalizeBulletText(text: string): string {
  // \s 覆盖换行、制表符、全角空格 U+3000、不换行空格 U+00A0
  return text.replace(/\s+/g, ' ').trim();
}

/** 触发拆句的标点，按「越靠后越适合断」排序 */
const SENTENCE_BREAKS = ['。', '；', ';', '！', '!', '？', '?', '，', ',', '、'] as const;

/**
 * 按标点把长文本拆成若干段，每段不超过 limit。
 *
 * 为什么不用 `slice(0, limit)`：那样会把句子从中间切断，
 * 「功率放大器的非线性失真」被切成「功率放大器的非线」和「性失真」，
 * 两条都读不通。宁可某段短一点，也要断在标点上。
 *
 * 实在找不到标点（比如英文长句或公式），才退回硬切 ——
 * 但硬切时保留原字符，不丢内容。
 */
export function splitLongText(text: string, limit: number = SLIDE_LIMITS.maxBulletChars): string[] {
  // 先归一空白：换行会在导出时变成新段落，压到下一条要点上（详见 normalizeBulletText）
  const trimmed = normalizeBulletText(text);
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;

  while (rest.length > limit) {
    // 在 limit 之前找最后一个标点，作为断点
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const mark of SENTENCE_BREAKS) {
      const at = window.lastIndexOf(mark);
      // 断点太靠前（不到一半）会拆出一堆碎片，不值得
      if (at >= Math.floor(limit * 0.5) && at > cut) cut = at;
    }

    if (cut < 0) {
      // 没有合适标点：硬切，但不去掉字符
      parts.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    } else {
      // 标点归前一段，读起来完整
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
  }

  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 把一组要点按每页上限切分成多页。
 *
 * 返回二维数组：外层是页，内层是该页的要点。
 * 空输入返回空数组（不生成空白页）。
 */
export function chunkBullets<T>(items: T[], perPage: number = SLIDE_LIMITS.maxBulletsPerPage): T[][] {
  if (items.length === 0) return [];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

/**
 * 续页标题。
 *
 * 不写「（续2）」这种累加形式：三页以上时「（续2）(续3)」难读。
 * 用「标题 · 2/3」的形式，一眼知道在这组里看到第几页、还剩几页。
 */
export function continuationTitle(title: string, index: number, total: number): string {
  if (total <= 1) return title;
  return `${title} · ${index + 1}/${total}`;
}

/** 超长标题折行（用于封面/章节页的视觉控制，不改语义） */
export function foldTitle(title: string, limit: number): string {
  const t = title.trim();
  if (t.length <= limit) return t;
  // 标题折行优先断在冒号/破折号处，其次空格
  const breaks = ['：', ':', '——', '—', '·', ' '];
  for (const mark of breaks) {
    const at = t.indexOf(mark);
    if (at > 0 && at <= limit) {
      return `${t.slice(0, at + mark.length).trim()}\n${t.slice(at + mark.length).trim()}`;
    }
  }
  // 没有合适的断点：按长度硬折。
  // 硬折不丢字；"不折让它溢出页面"才会让标题跑到幻灯片外面 ——
  // 那在导出的 pptx 里是彻底看不见的，用户只会觉得标题丢了。
  return `${t.slice(0, limit).trim()}\n${t.slice(limit).trim()}`;
}
