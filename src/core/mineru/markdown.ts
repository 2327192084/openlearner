/**
 * 解析 `mineru parse` 产出的 Markdown。
 *
 * ## 为什么改用它（而不是 middle_json）
 *
 * 2026-11-07 实测对比：
 *
 * | | `mineru-kit --format middle_json` | `mineru parse -o x.md` |
 * | --- | --- | --- |
 * | 走本地服务 | ❌ 每次自己起进程 | ✅ 常驻服务，模型只加载一次 |
 * | 模型目录 | 自己猜，会撞锁报 `[WinError 5]` | 由 `parse_server.local.mode` 统一管 |
 * | 分页信息 | `page_idx`（0 开始） | `<!-- page N of M -->` 注释 |
 * | 结构 | 块类型 + bbox | 标题层级（`##`）+ 正文 |
 *
 * 我们真正需要的只是「每页一段纯文本」，Markdown 直接够用；
 * 而且它自带的分页标记是**人可读**的，出问题能直接对着文件排查。
 *
 * ## 分页标记长这样
 *
 * ```markdown
 * <!-- page 1 of 3 -->
 *
 * ## 第一章 数据结构绪论
 *
 * 正文第一段……
 * ```
 *
 * ## 铁律：页数必须 1:1
 *
 * 用户要求「转换的文档与原文件的转换页数一一相对，方便对照是否有错误」。
 * 所以：
 *  - 没有分页标记的整段内容**全部算第 1 页**，不猜着切；
 *  - 标记里说有几页就产出几页，缺的页留空占位（跳过会让后面全错位）；
 *  - `page N of M` 里的 M 如果比实际出现的标记多，剩下的补空页。
 */

/** 一页的转换结果 */
export interface MinerUPage {
  /** 页码，从 1 开始 */
  page: number;
  /** 这一页的正文（已去掉 Markdown 标题符号） */
  text: string;
  /** 这一页的标题（`##` 行），没有则 null */
  chapter: string | null;
}

/** 一次转换的完整结果 */
export interface MinerUResult {
  pageCount: number;
  pages: MinerUPage[];
  /** 实际用的 tier，如实记录 */
  tier: string;
  /** 生产者版本 */
  producer: string;
}

/** 分页标记：`<!-- page 1 of 3 -->`，容忍多余空格 */
const PAGE_MARKER = /<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->/gi;

/** Markdown 标题行：`## 标题` */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

/**
 * 把 Markdown 拆成按页正文。
 *
 * @param markdown `mineru parse` 写出的文件内容
 * @param options  tier / producer 等元信息，原样带出来给界面显示
 */
export function parseMarkdown(
  markdown: string,
  options: { tier?: string; producer?: string } = {},
): MinerUResult {
  const text = typeof markdown === 'string' ? markdown : '';
  if (!text.trim()) {
    throw new Error(
      'MinerU 输出的文件是空的。' +
        '可能是这份文件它读不出内容，或转换中途被中断 —— 换一份文件试试能区分是哪一种。',
    );
  }

  // 找出所有分页标记的位置与页号
  const markers: Array<{ start: number; end: number; page: number; total: number }> = [];
  PAGE_MARKER.lastIndex = 0;
  for (let m = PAGE_MARKER.exec(text); m !== null; m = PAGE_MARKER.exec(text)) {
    markers.push({
      start: m.index,
      end: m.index + m[0].length,
      page: Number(m[1]),
      total: Number(m[2]),
    });
  }

  /*
   * 没有任何分页标记：整段算第 1 页。
   *
   * 不猜着按空行切 —— 那会切出与原文页数不符的段，
   * 用户拿页码对照原书就会对不上，而这个错在界面上看不出来。
   */
  if (markers.length === 0) {
    const cleaned = cleanMarkdown(text);
    return {
      pageCount: 1,
      pages: [{ page: 1, text: cleaned.body, chapter: cleaned.chapter }],
      tier: options.tier ?? 'unknown',
      producer: options.producer ?? 'unknown',
    };
  }

  // 标记之前还有内容（有的版本会把前言写在第一个标记前）→ 算第 1 页开头
  const head = text.slice(0, markers[0]!.start);

  // 分页标记声明的总页数（取第一个标记里的 M）
  const declaredTotal = markers[0]!.total;

  /*
   * 总页数取「声明值」与「实际出现的最大页号」的较大者。
   *
   * 为什么取大：宁可多留一个空页，也不让后面的页前移。
   * 少一页会让之后所有页的页码错一位 —— 用户拿「第 12 页」
   * 去看原书第 12 页会发现内容不对，而且几乎不可能自己发现原因。
   */
  const maxPage = Math.max(...markers.map((m) => m.page));
  const pageCount = Math.max(declaredTotal || 0, maxPage, markers.length);

  const pages: MinerUPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNo = i + 1;
    const marker = markers.find((m) => m.page === pageNo);

    if (!marker) {
      // 缺失页：留空占位
      pages.push({ page: pageNo, text: '', chapter: null });
      continue;
    }

    // 这一页的内容：从当前标记结束到下一个标记开始
    const nextMarker = markers.find((m) => m.start > marker.start);
    const sliceEnd = nextMarker ? nextMarker.start : text.length;
    const raw = text.slice(marker.end, sliceEnd);

    // 第 1 页要把标记之前的内容接上
    const body = pageNo === 1 && head.trim() ? head + '\n' + raw : raw;

    const cleaned = cleanMarkdown(body);
    pages.push({ page: pageNo, text: cleaned.body, chapter: cleaned.chapter });
  }

  return {
    pageCount,
    pages,
    tier: options.tier ?? 'unknown',
    producer: options.producer ?? 'unknown',
  };
}

/**
 * 清理一页的 Markdown：去掉图片/HTML 注释/多余空行，抽出标题。
 *
 * 抽标题的规则：**第一行是标题**才算这一页的章节。页中间的标题
 * 属于正文结构，把它当成「本章标题」会让整页归属都错。
 */
function cleanMarkdown(raw: string): { body: string; chapter: string | null } {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  const kept: string[] = [];
  let chapter: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过残留的分页注释
    if (/^<!--\s*page\s+\d+/i.test(trimmed)) continue;
    // 跳过其他 HTML 注释
    if (/^<!--.*-->$/.test(trimmed)) continue;
    // 图片整行丢掉：我们的分段是纯文本，图片链接会污染搜索与锚点
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) continue;

    /*
     * 标题：**保留 Markdown 的 # 号写进正文**。
     *
     * 早先的写法是「抽成 chapter 字段后把标题从正文里删掉」，
     * 结果正文中一个 # 都不剩，阅读器里所有层级被拍平成同样大小的文字。
     * 用户明确要求「MinerU 转换过后的 pdf 也要是 Markdown 形式」，
     * 所以现在两处都留：chapter 供目录跳转，正文里的 `##` 供阅读器渲染层次。
     *
     * 顺带说明为什么 chapter 只用**页首第一行**：
     * 页中间的标题属于正文结构，把它当成「本章标题」会让整页归属都错。
     * 但正文里该怎么显示还是怎么显示，两者互不影响。
     */
    const heading = HEADING.exec(trimmed);
    if (heading) {
      const hashes = heading[1]!;
      const title = heading[2]!.trim();
      if (chapter === null && kept.every((l) => l.trim() === '')) {
        chapter = title; // 只记录，不从正文里删除
      }
      // 原样保留 # 号与文字
      kept.push(`${hashes} ${title}`);
      continue;
    }

    kept.push(line);
  }

  // 合并多余空行，去掉首尾空白
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { body, chapter };
}
