/**
 * 科目推断 + 解析完整性闸门（2026-11-21 深夜）。
 *
 * ## 用户的技术思路（原话）
 *
 * > 对有目录的资料，依据目录内容分析出所学科目，自主分析配合网上检索
 * > 规划学习路线。对于没有目录的资料，可以询问用户资料涉及的科目
 * > 再结合自主判断，判断出资料有关科目然后规划方法和上述一样。
 * > （没有目录的资料要注意边界，规划的路线不能超出现有资料内容范围。）
 *
 * 用户另外确认了两点：
 * - 科目推断出来后**先告知用户、确认后才规划**
 * - 资料只解析了一部分时**挡住，先提示补解析**
 *
 * ## 为什么科目推断要单独一层
 *
 * 「这是高等数学（同济第7版）」这个判断决定了后面检索什么、
 * 路线该排哪些章。猜错的代价是整条路线作废。
 *
 * 而且——**这个判断不需要 AI**：书名与目录里通常直接写着科目。
 * 用 AI 去猜一个能从标题字符串读出来的东西，既慢又贵还更容易错。
 * 只有从标题/目录读不出来时，才让用户说（用户确认的那个交互）。
 *
 * ## 完整性闸门为什么也放这里
 *
 * 它和科目推断用的是同一份输入（资料元信息 + 段落统计），
 * 而且都发生在「规划之前」。放一起，调用方一次调用就能知道
 * 「能不能规划」。
 */

import type { Source, SourceSegment } from '@/core/model.ts';
import type { SourceOutline } from './source-outline.ts';

/** 用户库/常见教材里的科目词表（按优先级，越具体越前） */
const SUBJECT_PATTERNS: { id: string; name: string; re: RegExp }[] = [
  /* 数学类 —— 先认具体分支，否则「高等数学」会被「数学」吃掉 */
  { id: 'advanced-math', name: '高等数学', re: /高等数学|高数|微积分|calculus/i },
  { id: 'linear-algebra', name: '线性代数', re: /线性代数|线代|linear\s*algebra/i },
  { id: 'probability', name: '概率论与数理统计', re: /概率论|数理统计|概率统计|probability/i },
  { id: 'discrete-math', name: '离散数学', re: /离散数学|discrete\s*math/i },
  { id: 'complex-analysis', name: '复变函数', re: /复变函数|complex\s*analysis/i },
  /* 工程类 */
  { id: 'signals-systems', name: '信号与系统', re: /信号与系统|signals?\s*(and|&)\s*systems?/i },
  { id: 'circuits', name: '电路分析', re: /电路分析|电路原理|circuit\s*analysis/i },
  { id: 'digital-logic', name: '数字逻辑', re: /数字逻辑|数字电路|digital\s*logic/i },
  { id: 'data-structures', name: '数据结构', re: /数据结构|data\s*structures?/i },
  { id: 'operating-systems', name: '操作系统', re: /操作系统|operating\s*systems?/i },
  { id: 'computer-networks', name: '计算机网络', re: /计算机网络|computer\s*networks?/i },
  { id: 'database', name: '数据库', re: /数据库|database/i },
  { id: 'safety-monitoring', name: '安全监测与控制', re: /安全监测|安全检测|安全生产/i },
  /* 理科 */
  { id: 'college-physics', name: '大学物理', re: /大学物理|普通物理|college\s*physics/i },
  { id: 'chemistry', name: '化学', re: /有机化学|无机化学|物理化学|分析化学|chemistry/i },
  /* 语言/其它 */
  { id: 'english', name: '大学英语', re: /大学英语|英语|english/i },
  { id: 'politics', name: '思想政治', re: /马克思主义|思想政治|毛泽东|近代史/i },
];

/** 一个推定的科目 */
export interface SubjectGuess {
  /** 稳定 id（推断不出时为空串） */
  id: string;
  /** 显示名 */
  name: string;
  /**
   * 置信度：
   * - `title`：书名/文件名里直接写着（最可信）
   * - `toc`：从目录条目里看出来的
   * - `content`：从正文关键词看出来的（弱，至少要命中多次）
   * - `none`：推不出，必须问用户
   */
  source: 'title' | 'toc' | 'content' | 'none';
  /** 具体是哪段文字让我们这么判断的（给用户看，便于他判断对不对） */
  evidence: string;
  /**
   * 推测的教材版本/出版社等附加信息（可为空）。
   *
   * 例：同济大学数学系编《高等数学》第七版 → 「同济·第七版」。
   * 有这个信息，检索能更准（不同版本的章节划分不同）。
   */
  edition: string;
}

/**
 * 从标题与目录推断科目。
 *
 * ## 为什么优先看标题
 *
 * 「高等数学 第7版 上 -- 同济大学数学系编」这种标题里，
 * 科目、版本、编者全都有 —— 没有任何猜测成分。
 * 目录只在标题看不出科目时才有价值（标题常是「课程知识点一」这种泛名）。
 */
export function guessSubject(
  source: Pick<Source, 'title' | 'fileName'>,
  outline: SourceOutline,
  segments: readonly SourceSegment[] = [],
): SubjectGuess {
  /* ---------- 1. 标题 / 文件名 ---------- */
  const titleText = [source.title, source.fileName ?? ''].join(' ');
  for (const pat of SUBJECT_PATTERNS) {
    const m = pat.re.exec(titleText);
    if (m) {
      return {
        id: pat.id,
        name: pat.name,
        source: 'title',
        evidence: `标题里写着「${m[0]}」`,
        edition: guessEdition(titleText),
      };
    }
  }

  /* ---------- 2. 目录条目 ---------- */
  if (outline.entries.length > 0) {
    const tocText = outline.entries.join(' ');
    for (const pat of SUBJECT_PATTERNS) {
      const m = pat.re.exec(tocText);
      if (m) {
        return {
          id: pat.id,
          name: pat.name,
          source: 'toc',
          evidence: `目录里有「${m[0]}」`,
          edition: guessEdition(titleText),
        };
      }
    }
  }

  /* ---------- 3. 正文关键词（要够多次，命中一次不算） ---------- */
  /*
   * 阈值取 3：教材正文里偶然提到一次「微积分」不代表这门课是微积分
   * （信号与系统里也会提到微积分）。但同一科目词出现 3 次以上，
   * 基本可以认为这就是这门课。
   */
  const bodyText = segments.map((s) => s.text).join('\n').slice(0, 60000);
  let best: { pat: (typeof SUBJECT_PATTERNS)[number]; count: number; hit: string } | null = null;
  for (const pat of SUBJECT_PATTERNS) {
    const g = new RegExp(pat.re.source, 'gi');
    let count = 0;
    let hit = '';
    let m: RegExpExecArray | null;
    while ((m = g.exec(bodyText)) !== null) {
      count += 1;
      if (!hit) hit = m[0];
      if (count >= 20) break; // 够了，不用继续数
    }
    if (count >= 3 && (!best || count > best.count)) best = { pat, count, hit };
  }
  if (best) {
    return {
      id: best.pat.id,
      name: best.pat.name,
      source: 'content',
      evidence: `正文里「${best.hit}」出现了 ${best.count} 次`,
      edition: guessEdition(titleText),
    };
  }

  return { id: '', name: '', source: 'none', evidence: '', edition: guessEdition(titleText) };
}

/**
 * 从标题里抠版本/编者信息。
 *
 * 例：
 *  - 「高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )」→「同济·第7版」
 *  - 「信号与系统（第二版）第1章」→「第二版」
 *
 * 为什么值得抠：不同版本的章节划分不同，检索时带上版本能避免
 * 「同济第7版的第3章」和「某校自编教材的第3章」串味。
 */
export function guessEdition(titleText: string): string {
  const parts: string[] = [];

  /* 版本：第7版 / 第七版 / 第二版 / 3rd edition */
  const ver = /第\s*([0-9一二三四五六七八九十]+)\s*版/.exec(titleText);
  if (ver) parts.push(`第${ver[1]}版`);
  else {
    const en = /([0-9]+)(?:st|nd|rd|th)\s*edition/i.exec(titleText);
    if (en) parts.push(`${en[1]}版`);
  }

  /* 编者/出版社：找「…编」「…著」「…主编」前面那一段 */
  const ed = /([\u4e00-\u9fa5]{2,12}(?:大学|学院|系|教研室)?)\s*(?:编|著|主编)/.exec(titleText);
  if (ed) parts.push(ed[1]!.trim());

  return parts.join('·');
}

/* ==========================================================================
 * 解析完整性闸门
 * ========================================================================== */

/** 一份资料的解析完整度 */
export interface ParseCompleteness {
  /** 能否直接规划路线 */
  ok: boolean;
  /**
   * 不完整的原因分类：
   * - `no-text`：一点正文都没有（扫描件/没解析）
   * - `thin-text`：有段落但总量太少（< 200 字），排不出可靠路线
   * - `partial-chapters`：目录声明到第 N 章，正文只到第 M 章
   *
   * ⚠️ 2026-11-22 去掉了 `partial-pages`（按「每页字数」判断）。
   * 那个判据不成立：段数不等于页数，而且 PPT/图文资料每页天然字少。
   */
  reason: 'none' | 'no-text' | 'thin-text' | 'partial-chapters' | 'ok';
  /** 给用户看的一句话 */
  message: string;
  /** 已解析的**段落数** */
  parsed: number;
  /**
   * 这份资料的**页数**（`pageCount`）；未知时等于段数。
   *
   * ⚠️ 这个字段不要拿来当"应该有几段"用 —— 段与页是两个量。
   * 老文案犯的正是这个错，写出了「共 86 段，但只解析出 86 段」。
   */
  total: number;
}

/**
 * 判断一份资料是否解析得够完整、可以据此规划路线。
 *
 * ## 这个判断的定位已经变了（2026-11-22）
 *
 * 原来它是个**闸门**（不完整就挡住，按钮不能点）。用户后来明确要求：
 * > 这个提示应该是提醒用户资料未完全解析，但规划路线的按钮还是要保留给用户，
 * > 让用户自己决定。
 *
 * 所以现在它**只产出提示文案**，调用方（`MapHomePage`）显示黄字、
 * 但按钮始终可点。`ok === false` 不再意味着"不能规划"。
 *
 * ## ⚠️ 为什么删掉「每页字数」这个判据
 *
 * 老实现用「平均每页不足 200 字」判「正文没进来」，有两个真问题：
 *
 * 1. **段数被当成页数写进文案**。老文案是
 *    「这份资料共 {pageCount} 页，但只解析出 {segments.length} 页」——
 *    第二个值是**段数**。当一份 PPT 的段数恰好等于页数（86 段 / 86 页），
 *    就渲染成「共 86 页，但只解析出 86 页」—— 自相矛盾。
 *    用户是从截图里发现这句的。
 *
 * 2. **判据本身不成立**。一页 PPT 是标题 + 三五个要点，80 字很正常；
 *    图文混排的书页也常常字少。按「每页 600 字」当基准，会把
 *    大量正常资料判成"没解析"。
 *
 * ## 现在用什么判据（都可观测、可验证）
 *
 * - **一点段落都没有** → `no-text`（真的没正文）
 * - **总量 < 200 字** → `thin-text`（有东西但太少，排不出路线）
 * - **目录声明的章 > 正文覆盖的章，且差 ≥ 2** → `partial-chapters`
 *   （这是唯一能真正说明"解析漏了"的证据：作者列了 8 章，正文只到第 1 章）
 *
 * 三条都不看"每页多少字"，所以不会再冤枉 PPT 和图文资料。
 */
export function checkCompleteness(
  source: Pick<Source, 'pageCount' | 'textStatus'>,
  segments: readonly SourceSegment[],
  outline: SourceOutline,
  coverage: { declaredTo: number | null; to: number } | null,
): ParseCompleteness {
  const parsed = segments.length;
  /* total 只用于显示"这份资料有多少页"，不再冒充"应该有几段" */
  const total = source.pageCount ?? segments.length;
  const charTotal = segments.reduce((n, s) => n + (s.charCount || s.text.length), 0);

  /* ---------- 1. 完全没有任何段落 ---------- */
  if (parsed === 0) {
    return {
      ok: false,
      reason: 'no-text',
      message:
        source.textStatus === 'no-text-layer'
          ? '这份资料是扫描件，没有文字层。先到「文档解析」里用 OCR 识别出文字，再来规划路线。'
          : '这份资料还没有正文。先到「文档解析」里解析出文字，再来规划路线。',
      parsed: 0,
      total,
    };
  }

  /* ---------- 2. 有段落但总量极小 ---------- */
  /*
   * 阈值 200 字：少于这个数连"这门课讲什么"都看不出来，
   * 排出来的路线纯属模型自由发挥。
   *
   * 不再叠加「页数 <= 20」的条件 —— 那个条件的本意是"别把
   * 127 页只解析 1 页的情况笼统判成没正文"，但删掉每页字数判据后
   * 它没有意义了：内容够就是够，不够就是不够，与几页无关。
   */
  if (charTotal < 200) {
    return {
      ok: false,
      reason: 'thin-text',
      message:
        source.textStatus === 'no-text-layer'
          ? '这份资料是扫描件，没有文字层。先到「文档解析」里用 OCR 识别出文字，再来规划路线。'
          : `这份资料只解析出 ${charTotal} 字正文，不足以排出可靠的路线。先到「文档解析」把它解析完整。`,
      parsed,
      total,
    };
  }

  /* ---------- 3. 目录声明比正文多得多 ---------- */
  /*
   * 这是唯一能真正证明"解析漏了"的证据：作者自己在目录里
   * 列了 N 章，而正文只找到 M 章。
   *
   * 只在 `declaredTo` 存在时才判定（说明目录确实列得更多），
   * 且要求差 2 章以上 —— 差 1 章可能只是最后一章刚开始。
   */
  if (coverage?.declaredTo !== null && coverage?.declaredTo !== undefined) {
    const gap = coverage.declaredTo - coverage.to;
    if (gap >= 2) {
      const missing = outline.chapterNumbers.filter(
        (n) => !outline.contentChapterNumbers.includes(n),
      );
      const missingText =
        missing.length > 0
          ? `（缺第 ${missing.slice(0, 8).join('、')} 章${missing.length > 8 ? ' 等' : ''}）`
          : '';
      return {
        ok: false,
        reason: 'partial-chapters',
        message:
          `这份资料的目录列到第 ${coverage.declaredTo} 章，但正文只到第 ${coverage.to} 章${missingText}。` +
          '按现有内容规划只能覆盖到那几章 —— 如果资料本该有更多章，先补解析；' +
          '如果它本来就是节选，请确认后继续。',
        parsed,
        total,
      };
    }
  }

  return { ok: true, reason: 'ok', message: '', parsed, total };
}