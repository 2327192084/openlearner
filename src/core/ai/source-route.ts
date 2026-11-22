/**
 * 「依据资料本体」的学习路线规划（2026-11-21 深夜）。
 *
 * ## 用户改了口径（这是第二轮重写）
 *
 * 第一版依据**知识点**规划（`plan-order.ts`），用户否掉了：
 *
 * > 这个规划路线的规划方法需要修改一下，当前是依据知识库里的知识点进行规划，
 * > 我觉得应该依据资料本体进行构建。
 *
 * 用户给的技术思路：
 *
 * > 对有目录的资料，依据目录内容分析出所学科目，自主分析配合网上检索
 * > 规划学习路线。对于没有目录的资料，可以询问用户资料涉及的科目
 * > 再结合自主判断，判断出资料有关科目然后规划方法和上述一样。
 * > （没有目录的资料要注意边界，规划的路线不能超出现有资料内容范围。）
 *
 * ## 与 `plan-order.ts` 的分工（两个都保留）
 *
 * | | `plan-order.ts`（旧） | 这里（新） |
 * |---|---|---|
 * | 输入 | 知识点清单 | **资料的目录/章节结构** |
 * | 排什么 | 105 条知识点谁先谁后 | **章 → 节的学习顺序** |
 * | 依据 | 模型对知识点的学科判断 | 目录 + 检索 + 模型判断 |
 * | 用途 | 细到每条的攻坚顺序 | 整门课的路线 |
 *
 * 旧的没有删：知识点级排序在「我有 105 个点，先攻哪个」时仍然有用。
 * 但**学习地图上的路线用新的这个**（用户要的是「依据资料本体」）。
 *
 * ## 三条硬约束（都来自用户原话）
 *
 * 1. **不能超出现有资料范围** —— 资料只到第 1 章就不许排第 2 章
 * 2. **有目录就用目录** —— 那是作者写的结构，最权威
 * 3. **没有目录就得问科目** —— 不硬猜
 *
 * 这三条在提示词与解析层**各挡一次**：提示词让它别这么干，
 * 解析层（`filterOutOfScope`）在模型还是干了的时候把越界的丢掉。
 * 只靠提示词不行 —— 模型不听的时候得有人兜。
 */

import type { SourceOutline } from '@/v2/core/source-outline.ts';
import type { SubjectGuess } from '@/v2/core/subject-guess.ts';
import type { SearchResult } from './web-search.ts';
import { formatHitsForPrompt } from './web-search.ts';

/** 路线里的一步（一章 / 一节） */
export interface RouteStep {
  /** 章号（有的话）。0 = 认不出章号（如无目录资料的散点） */
  chapterNumber: number;
  /** 标题（目录条目 / 章节名） */
  title: string;
  /**
   * 这一步对应的**资料里实际有的内容**。
   *
   * 空数组 = 资料里找不到对应内容 —— 这种步骤要被 `filterOutOfScope` 丢掉，
   * 或者标成「资料里没有，建议自行补充」。
   *
   * 为什么要这个：用户明确要求路线不能超出资料范围。
   * 记录「这一步依据的是哪几段」，才能在解析层验证它真的在范围内。
   */
  segmentIds: string[];
  /** 学习这一步的理由（给用户看） */
  reason: string;
  /** 依据来源：目录 / 检索 / 模型判断 */
  basis: 'toc' | 'search' | 'model';
  /** 难度 1–5（与 plan-order 同一口径：知识点本身的难度，不是掌握度） */
  difficulty: number | null;
  /**
   * 这一步（这一章）包含哪些**小节**（2026-11-22 下午，方案第 3 步）。
   *
   * ## 为什么要 AI 给，而不是只用正文标题切
   *
   * `section-split.ts` 能从正文标题切小节（信号那份能切 26 个），
   * 但有两类资料切不出：整份没标题（pptx）、或只切出 1 个
   *（等于没切）。那种资料需要 AI 读正文后按内容拆。
   *
   * ## `quote` 是干什么的
   *
   * 每个小节必须给一句**原文片段**，解析层拿它去正文里找对应段落，
   * 回填 `segmentIds`。这样「这个小节依据的是资料里哪几段」是
   * **可验证的**，不是模型说啥算啥。
   *
   * 空数组 = 模型没给（或给的都对不上原文）→ 调用方退回标题切分。
   */
  sections: RouteSectionDraft[];
  /**
   * 前置章号（AI 顺带给）。
   *
   * ⚠️ **只提醒、不锁** —— 用户明确要求「章节可以同时进行」。
   * 解析层会校验：不存在的章号、自引用一律丢弃。
   */
  prerequisites: number[];
  /** 为什么需要这些前置（给用户看） */
  prereqReason: string;
}

/** AI 给的一个小节草稿 */
export interface RouteSectionDraft {
  /** 小节标题（尽量用资料里的原标题） */
  title: string;
  /**
   * 原文片段，用于本地回填段 id。
   *
   * 取不到就空串 —— 解析层会把它当成"对不上"，不会瞎猜。
   */
  quote: string;
  /**
   * 由 `attachSectionSegments` 本地回填（模型不知道段 id）。
   *
   * 空数组 = **这句 quote 在正文里找不到**。
   * 界面与调用方据此判断「这个小节的依据是否可验证」。
   */
  segmentIds?: string[];
}

/** 一条规划好的路线 */
export interface SourceRoute {
  /** 学科名（用户确认过的） */
  subject: string;
  /** 教材版本信息（可空） */
  edition: string;
  /** 分组的路线（块 = 学习阶段） */
  blocks: { title: string; why: string; steps: RouteStep[] }[];
  /**
   * 资料没覆盖、但按学科该有的部分。
   *
   * 这是**如实告知**：用户那份资料只到第 1 章时，
   * 路线里只排第 1 章，但这里要写「按高等数学的常规进度，
   * 第 2 章导数是下一步 —— 但你手上这份资料没有」。
   *
   * 用户明确要的正是这个区分：「不能超出现有资料范围」不等于
   * 「不告诉他后面还有什么」。
   */
  beyond: { title: string; note: string }[];
  /** 这次规划实际用到的依据 */
  usedSearch: boolean;
  /** 越界被丢掉的条数（诊断用；界面在 > 0 时提示） */
  droppedOutOfScope: number;
}

/** 可用的资料范围（由 `source-outline.ts` 算出） */
export interface ScopeInfo {
  /** 允许的章号范围；null = 无章号概念（按标题/段落走） */
  chapters: number[] | null;
  /** 资料标题 */
  sourceTitle: string;
  /** 每段 id → 该段的章号（用于解析时验证步骤是否在范围内） */
  chapterBySegment: Map<string, number | null>;
}

export interface BuildRoutePromptOptions {
  subject: SubjectGuess;
  outline: SourceOutline;
  scope: ScopeInfo;
  /** 检索结果；没搜就传 null */
  search: SearchResult | null;
  /** 目录条目（最多给多少条，防止巨大目录撑爆提示词） */
  maxEntries?: number;
}

/** 目录条目在提示词里最多给这么多条 —— 超过就只给章的标题 */
const DEFAULT_MAX_ENTRIES = 80;

/**
 * 构造「依据资料本体规划路线」的提示词。
 *
 * 返回 system + user。system 里的三条硬约束是本模块最重要的部分。
 */
export function buildRoutePrompt(options: BuildRoutePromptOptions): {
  system: string;
  user: string;
} {
  const { subject, outline, scope, search } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const subjectLine = subject.name || '（未确定）';
  const editionLine = subject.edition ? `（${subject.edition}）` : '';

  /* ---------- 范围说明（用户第 1 条硬约束） ---------- */
  const scopeLines: string[] = [];
  if (scope.chapters === null || scope.chapters.length === 0) {
    scopeLines.push(
      '这份资料**没有可用的章节结构**（没有目录页，也没有章节标题）。',
      '所以路线只能按内容主题分块，不能编造章号。',
    );
  } else {
    scopeLines.push(
      `这份资料**只覆盖第 ${scope.chapters.join('、')} 章**。`,
      '⚠️ 路线里**绝对不能**出现这些章之外的章号或内容 —— 资料里没有那些内容，',
      '排出来学员也学不到。',
      '按学科常规确实还有后续章节的话，写进 `beyond` 字段（如实告知「资料里没有」），',
      '**不要**写进 blocks。',
    );
  }

  /* ---------- 目录部分 ---------- */
  const tocLines: string[] = [];
  if (outline.kind === 'toc-page' && outline.entries.length > 0) {
    tocLines.push('## 这份资料的目录（作者写的结构，最权威）', '');
    const entries = outline.entries.slice(0, maxEntries);
    for (const e of entries) tocLines.push(`- ${e}`);
    if (outline.entries.length > maxEntries) {
      tocLines.push(`- …（还有 ${outline.entries.length - maxEntries} 条未列出）`);
    }
    tocLines.push('');
  } else if (outline.kind === 'chapter-marks' && outline.entries.length > 0) {
    tocLines.push('## 这份资料里出现的章节标题（没有完整目录页，从正文标题认出来的）', '');
    for (const e of outline.entries.slice(0, maxEntries)) tocLines.push(`- ${e}`);
    tocLines.push('');
  } else {
    tocLines.push('## 这份资料没有目录', '');
    tocLines.push('请按内容主题分块，不要编造章号与章名。', '');
  }

  /* ---------- 检索结果 ---------- */
  const searchText = search ? formatHitsForPrompt(search) : '';
  const searchLines: string[] = [];
  if (searchText.length > 0) {
    searchLines.push(searchText);
  } else if (search && !search.searched) {
    searchLines.push(
      '## 这次没有联网检索',
      '',
      search.note || '（没有拿到外部资料）',
      '',
      '所以下面的路线请你依据**自己的学科知识 + 这份资料的目录**来排。',
      '如果有拿不准的地方，在 reason 里如实写「按常规进度推断」。',
      '',
    );
  }

  const system = [
    `你是一位有经验的学科老师，正在为「${subjectLine}${editionLine}」这门课排学习路线。`,
    '',
    '## 三条硬规矩',
    '',
    '### 1. 路线不能超出这份资料的范围',
    '',
    ...scopeLines,
    '',
    '### 2. 有目录就按目录走',
    '',
    '目录是作者写的结构，比你的推断权威。分块与步序都要贴着目录来，',
    '不要自己发明一套分类（例如把「第1章 函数」拆成「基础篇/进阶篇」）。',
    '',
    '### 3. 知道就说知道，不知道就说不确定',
    '',
    '每个步骤的 `basis` 字段必须如实写你的依据来源：',
    '- `toc`：来自这份资料的目录/章节标题',
    '- `search`：来自上面给的网上参考资料',
    '- `model`：凭你自己的学科知识推断的**（资料和检索都没提到）**',
    '',
    '`model` 不是坏事，但要标出来 —— 学员需要知道哪一步是「资料里确实有」，',
    '哪一步是「老师按经验补充的」。**不要为了让路线好看而假装都是 toc**。',
    '',
    '## 分块怎么分',
    '',
    '按学习阶段分 3–6 块（如「基础概念」「核心方法」「综合应用」）。',
    '每块给一个 why（为什么按这个顺序学）。不要一题一块。',
    '',
    '## 难度',
    '',
    '每步给 1–5 的难度（1 最容易）。**这是这一步内容本身的难度**，',
    '与学员掌握得怎样无关 —— 你看不到他的掌握度，也不需要猜。',
    '',
    '### 4. 每章给出小节',
    '',
    '每一章（每个 step）要列出它包含的**小节**，放进 `sections` 数组。',
    '',
    '**只能按这一章已有的正文拆，不许引入资料外的小节。**',
    '每个小节必须给一句 `quote` —— 从这一章正文里**原样抄**的一句',
    '（8–40 字，能唯一定位到那段话）。这句用来在本地把小节',
    '对应回原文段落，所以**必须是原文里真的有的字**，不要改写。',
    '',
    '如果这一章的正文里已经有明显的小节标题（如「1.1 连续时间信号」），',
    '就直接用那些标题当 `title`，不要自己另起一套。',
    '',
    '如果这一章实在没有可拆的结构（整章就一个主题），`sections` 给空数组 ——',
    '**不要为了填满而硬造小节**。',
    '',
    '### 5. 前置关系：只写"真的需要先学"的',
    '',
    '每一章给 `prerequisites`（需要先学哪几章，填章号数组）与',
    '`prereqReason`（一句话说明为什么需要）。',
    '',
    '⚠️ **不要把前面所有章都列成前置。** 只写「不先学这一章，',
    '这一章就真的看不懂」那种关系。绝大多数章没有硬前置，那就给空数组。',
    '拿不准就给空数组 —— 空数组不会误导人，乱列前置会让学员以为',
    '必须按顺序学，而实际上用户要的是可以并行。',
    '',
    '## 输出格式',
    '',
    '只输出一个完整 JSON 对象，不要解释文字，不要 markdown 围栏。',
    '括号必须完整 —— 残缺的结果会被整份丢弃。',
    '',
    '{',
    '  "blocks": [',
    '    {',
    '      "title": "块名（6–12 字）",',
    '      "why": "为什么这一块排在这里",',
    '      "steps": [',
    '        {',
    '          "chapterNumber": 1,',
    '          "title": "步骤标题（用目录里的章名）",',
    '          "difficulty": 2,',
    '          "reason": "为什么这一步排在这个位置（20 字以内）",',
    '          "basis": "toc",',
    '          "sections": [',
    '            { "title": "1.1 连续时间信号", "quote": "正文里原样的一句" },',
    '            { "title": "1.2 离散时间信号", "quote": "另一句原样的话" }',
    '          ],',
    '          "prerequisites": [],',
    '          "prereqReason": ""',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "beyond": [',
    '    { "title": "第2章 导数与微分", "note": "按常规进度这是下一步，但这份资料没有" }',
    '  ]',
    '}',
    '',
    '`beyond` 只在「资料范围之外、但按学科确实有后续」时填写；没有就留空数组。',
  ].join('\n');

  const user = [
    `资料：《${scope.sourceTitle}》`,
    `学科：${subjectLine}${editionLine}`,
    subject.evidence ? `（学科判断依据：${subject.evidence}）` : '',
    '',
    ...tocLines,
    ...searchLines,
    '请排出学习路线。记住：不能超出现有资料的范围。',
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  return { system, user };
}

/** 解析结果 */
export type ParseRouteResult =
  | { ok: true; route: SourceRoute; dropped: number }
  | { ok: false; reason: string };

/**
 * 解析模型返回的路线，并**在本地校验范围**。
 *
 * ## 为什么要在解析层再挡一次「越界」
 *
 * 用户在提示词里已经被告知「不能超出范围」，但模型不一定听。
 * 实测经验（项目里记过多次）：提示词是**软约束**，模型该越界还是越界。
 *
 * 所以这里做机械校验：每一步的章号必须在 `scope.chapters` 里。
 * 不在的一律丢弃并计数 —— **宁可少排，也不能排资料里没有的内容**。
 * 这正是用户点名的那条要求，得有人真正执行。
 *
 * ## 与 `parsePlanOrder` 一致的部分
 *
 * - 残缺 JSON 整轮拒绝（不修补）
 * - 难度非法置 null（不夹边界值）
 * - 未知字段忽略
 */
export function parseSourceRoute(
  content: string,
  scope: ScopeInfo,
  subject: { name: string; edition: string },
  usedSearch: boolean,
): ParseRouteResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }

  const parsed = extractCompleteJsonObject(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const rawBlocks = (parsed.value as { blocks?: unknown }).blocks;
  if (!Array.isArray(rawBlocks)) {
    return { ok: false, reason: '返回的 JSON 里没有 blocks 数组。' };
  }

  const allowed = scope.chapters;
  const blocks: SourceRoute['blocks'] = [];
  let dropped = 0;

  for (const rawBlock of rawBlocks) {
    if (!rawBlock || typeof rawBlock !== 'object') {
      dropped += 1;
      continue;
    }
    const b = rawBlock as Record<string, unknown>;
    const rawSteps = b.steps;
    if (!Array.isArray(rawSteps)) {
      dropped += 1;
      continue;
    }

    const steps: RouteStep[] = [];
    for (const rawStep of rawSteps) {
      if (!rawStep || typeof rawStep !== 'object') {
        dropped += 1;
        continue;
      }
      const s = rawStep as Record<string, unknown>;

      const title = typeof s.title === 'string' ? s.title.trim().slice(0, 60) : '';
      if (title.length === 0) {
        dropped += 1;
        continue;
      }

      const chapterNumber = toInt(s.chapterNumber) ?? 0;

      /*
       * ⚠️ 范围校验（用户第 1 条硬约束的**执行点**）。
       *
       * 只有在资料有明确章号范围时才校验。没有章号概念的资料
       * （scope.chapters === null）不按章号挡 —— 那种情况下
       * 「越界」无法机械判断，只能靠 `beyond` 字段如实交代。
       */
      if (allowed !== null && allowed.length > 0) {
        if (chapterNumber !== 0 && !allowed.includes(chapterNumber)) {
          dropped += 1;
          continue;
        }
        /*
         * 章号为 0（模型没给）时也丢掉 —— 有范围的资料里，
         * 一个没有章号的步骤意味着「不知道它在哪一章」，
         * 很可能就是它自己编的。宁可不要。
         */
        if (chapterNumber === 0) {
          dropped += 1;
          continue;
        }
      }

      steps.push({
        chapterNumber,
        title,
        /* 模型不提供 segmentIds；由调用方按章号回填（见 attachSegments） */
        segmentIds: [],
        reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 80) : '',
        basis: normalizeBasis(s.basis),
        difficulty: toDifficulty(s.difficulty),
        sections: parseSections(s.sections),
        prerequisites: parsePrerequisites(s.prerequisites, chapterNumber, allowed),
        prereqReason: typeof s.prereqReason === 'string' ? s.prereqReason.trim().slice(0, 120) : '',
      });
    }

    if (steps.length === 0) continue;

    blocks.push({
      title: typeof b.title === 'string' && b.title.trim().length > 0
        ? b.title.trim().slice(0, 40)
        : `第 ${blocks.length + 1} 块`,
      why: typeof b.why === 'string' ? b.why.trim().slice(0, 120) : '',
      steps,
    });
  }

  if (blocks.length === 0) {
    return { ok: false, reason: '返回的路线里没有任何一步落在资料范围内。' };
  }

  /* ---------- beyond：如实告知资料外的部分 ---------- */
  const beyond: SourceRoute['beyond'] = [];
  const rawBeyond = (parsed.value as { beyond?: unknown }).beyond;
  if (Array.isArray(rawBeyond)) {
    for (const rb of rawBeyond) {
      if (!rb || typeof rb !== 'object') continue;
      const o = rb as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim().slice(0, 60) : '';
      const note = typeof o.note === 'string' ? o.note.trim().slice(0, 160) : '';
      if (title.length === 0) continue;
      beyond.push({ title, note });
    }
  }

  return {
    ok: true,
    route: {
      subject: subject.name,
      edition: subject.edition,
      blocks,
      beyond,
      usedSearch,
      droppedOutOfScope: dropped,
    },
    dropped,
  };
}

/**
 * 把「这一步对应资料里哪些段」回填进去。
 *
 * ## 为什么要回填
 *
 * 用户强调路线要「依据资料本体」。一个步骤如果**指不出**它是从哪几段
 * 来的，那它就不是依据资料，而是模型自己的发挥。
 *
 * 回填之后界面能显示「第 1 章 · 对应 36 段正文」，
 * 学员点进去就能看到原文 —— 这样「依据资料本体」才是可验证的，
 * 而不是一句口号。
 *
 * 章号为 0 的步骤（无目录资料）按标题词匹配，匹配不上就留空数组，
 * 界面如实说「这一步在资料里没有直接对应」。
 */
export function attachSegments(route: SourceRoute, scope: ScopeInfo): SourceRoute {
  const byChapter = new Map<number, string[]>();
  for (const [segId, ch] of scope.chapterBySegment) {
    if (ch === null) continue;
    const arr = byChapter.get(ch);
    if (arr) arr.push(segId);
    else byChapter.set(ch, [segId]);
  }

  const blocks = route.blocks.map((b) => ({
    ...b,
    steps: b.steps.map((s) => ({
      ...s,
      segmentIds: byChapter.get(s.chapterNumber) ?? [],
    })),
  }));

  return { ...route, blocks };
}

/**
 * 用 `quote` 把 AI 给的小节**对回真实段落**（方案 4.3 的核心要求）。
 *
 * ## 为什么这一步不能省
 *
 * 提示词要求模型给 `quote`，但如果不在本地验证，它就只是一句话 ——
 * 模型完全可能编一句"看起来像原文"的话。只有去正文里**真的找到**，
 * 「这一节依据资料里哪几段」才成立。
 *
 * ## 匹配规则（保守优先）
 *
 * 1. 先精确匹配（去掉空白后包含）
 * 2. 不行再按前缀匹配（模型可能截断后半句）
 * 3. 都不行 → 空数组，**不猜**
 *
 * ## 为什么限定在这一章的段里找
 *
 * 同一句话可能在书里出现多次（页眉、重复的例题）。限定在本章的
 * 段集合内可以大幅降低错配，而错配的后果是"点这一节跳到别章去"。
 */
export function attachSectionSegments(
  route: SourceRoute,
  segments: readonly { id: string; text: string }[],
  chapterBySegment: ReadonlyMap<string, number | null>,
): SourceRoute {
  /** 章号 → 该章的段 */
  const byChapter = new Map<number, { id: string; text: string }[]>();
  for (const seg of segments) {
    const ch = chapterBySegment.get(seg.id);
    if (ch === null || ch === undefined) continue;
    const arr = byChapter.get(ch);
    if (arr) arr.push(seg);
    else byChapter.set(ch, [seg]);
  }

  const norm = (t: string) => t.replace(/\s+/g, '');

  const blocks = route.blocks.map((b) => ({
    ...b,
    steps: b.steps.map((step) => {
      if (step.sections.length === 0) return step;

      const pool = byChapter.get(step.chapterNumber) ?? [];

      const sections = step.sections.map((sec) => {
        const q = norm(sec.quote);
        if (q.length === 0) return { ...sec, segmentIds: [] as string[] };

        /* 1) 精确包含 */
        const exact = pool.filter((seg) => norm(seg.text).includes(q));
        if (exact.length > 0) {
          return { ...sec, segmentIds: exact.map((x) => x.id) };
        }

        /*
         * 2) 前缀匹配：用前 8 个字（太短容易误命中，太长容易全落空）。
         *    只在 quote 够长时才做 —— 3 个字的"前言"会匹配到半个书。
         */
        if (q.length >= 8) {
          const head = q.slice(0, 8);
          const loose = pool.filter((seg) => norm(seg.text).includes(head));
          if (loose.length > 0) {
            return { ...sec, segmentIds: loose.map((x) => x.id) };
          }
        }

        /* 3) 找不到 → 空数组（如实"对不上"，绝不猜） */
        return { ...sec, segmentIds: [] as string[] };
      });

      return { ...step, sections };
    }),
  }));

  return { ...route, blocks };
}

/**
 * 解析 AI 给的 `sections`（方案第 3 步）。
 *
 * ## 三条校验
 *
 * 1. `title` 空的丢掉（没法显示）
 * 2. `quote` 空的也丢掉 —— **没有原文片段就没法回填段 id**，
 *    留着会变成一个"不知道依据在哪"的小节，比没有更糟
 * 3. 同一个 title 只留第一个（模型有时会重复列出）
 *
 * ## 为什么 quote 是硬要求
 *
 * 「依据资料」这件事必须是可验证的。模型说「这一章分三节」很容易，
 * 但要它指出「这一节对应正文的哪句话」，就把编造成本抬高了 ——
 * 抄不出原句就说明它多半是在编。
 *
 * 调用方（`tree-build`）还拿不到对应段落时会退回正文标题切分，
 * 所以丢掉不会让树变空。
 */
function parseSections(raw: unknown): RouteSectionDraft[] {
  if (!Array.isArray(raw)) return [];

  const out: RouteSectionDraft[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';
    if (title.length === 0) continue;

    const quote = typeof o.quote === 'string' ? o.quote.trim().slice(0, 300) : '';
    if (quote.length === 0) continue;

    const key = title.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ title, quote });
  }

  return out;
}

/**
 * 解析 AI 给的 `prerequisites`（方案第 3 步 / 第九节）。
 *
 * ## 三条校验（方案里点名要做的）
 *
 * 1. **不存在的章号丢弃** —— 模型可能给出这份资料里没有的章
 *    （尤其它看过别的教材）。`allowed` 是资料实际覆盖的章号集合。
 * 2. **自引用丢弃** —— 「第 3 章需要先学第 3 章」是废话。
 * 3. **重复去重**
 *
 * ## 为什么只提醒不锁
 *
 * 用户明确要求「章节可以同时进行，不用按顺序」。
 * 所以这里只产出数据，界面拿它显示提醒条，**绝不拿它禁用按钮**。
 */
function parsePrerequisites(
  raw: unknown,
  selfChapter: number,
  allowed: number[] | null,
): number[] {
  if (!Array.isArray(raw)) return [];

  const allowedSet = allowed ? new Set(allowed) : null;
  const out: number[] = [];

  for (const item of raw) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim()) : NaN;
    if (!Number.isInteger(n) || n <= 0) continue;
    /* 自引用 */
    if (n === selfChapter) continue;
    /* 不存在的章号 */
    if (allowedSet && !allowedSet.has(n)) continue;
    if (out.includes(n)) continue;
    out.push(n);
  }

  return out.sort((a, b) => a - b);
}

/** 依据来源归一 */
function normalizeBasis(v: unknown): RouteStep['basis'] {
  if (v === 'toc' || v === 'search' || v === 'model') return v;
  /*
   * 给了不认识的依据时归到 model —— 那是**最保守**的选择：
   * model 意味着「这条是推断的，学员要自己判断」。
   * 归到 toc 会让一条其实没依据的步骤看起来有目录支撑。
   */
  return 'model';
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** 难度只认 1–5；其余 null（不猜，不夹边界值） */
function toDifficulty(v: unknown): number | null {
  const n = toInt(v);
  if (n === null || n < 1 || n > 5) return null;
  return n;
}

/** 严格版 JSON 提取（与 plan-order.ts 同一套路：括号不配对就整轮拒绝） */
function extractCompleteJsonObject(
  content: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let s = content.trim();

  const fence = s.indexOf('```');
  if (fence >= 0) {
    const after = s.indexOf('\n', fence);
    const end = s.indexOf('```', after + 1);
    if (after >= 0 && end > after) s = s.slice(after + 1, end).trim();
  }

  const start = s.indexOf('{');
  if (start < 0) return { ok: false, reason: '返回的内容里没有 JSON 对象。' };

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return { ok: false, reason: '返回的 JSON 括号不配对。' };
    }
  }

  if (end < 0) {
    return { ok: false, reason: '返回的 JSON 不完整（可能被截断），已丢弃。' };
  }

  let value: unknown;
  try {
    value = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: false, reason: '返回的 JSON 解析失败，已丢弃。' };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: '返回的 JSON 顶层不是对象。' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}