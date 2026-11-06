/**
 * 学习库数据模型（P0 只落地骨架需要的部分）
 *
 * 设计约束来自计划书第 2 节：中间层「知识点」是唯一整理结果，
 * PPT 与习题都是它的两种输出。因此 P0 先把这些实体的**外壳**定好，
 * 后续阶段只往里填字段，不改动已有结构的语义。
 *
 * 所有实体都带 id + schemaVersion，导出/导入备份靠它做迁移。
 */

/** 当前学习库结构版本。改动实体结构时递增，并在 migrations.ts 补一段迁移。 */
export const LIBRARY_SCHEMA_VERSION = 10;

/**
 * 位置信息 —— 全项目「点回原文」的唯一依据。
 *
 * 语义在这里必须**精确定义**，因为 P2/P3/P4 全靠它：
 * 指错页比不能跳转更糟，它冒充可信。
 *
 * - `page`：页码，从 1 开始。按页切分的资料（PDF/PPTX）用它；
 *   按章节切分的资料（DOCX/MD）此值为该章节**起始**所占的序号。
 * - `chapter`：章节标题，便于目录跳转与出题时标注范围。
 * - `charStart`/`charEnd`：相对于**该页/该章节文本**（即 SourceSegment.text）的字符偏移，
 *   左闭右开。刻意不用「全文偏移」：全文偏移在重新导入或编辑后会整体错位，
 *   而页内偏移只依赖那一页的文本，稳定得多。
 */
export interface SourceLocation {
  /** 资料 id */
  sourceId: string;
  /** 页码（从 1 开始）。按章节切分的资料此值为该章节起始页/序号。 */
  page?: number;
  /** 章节标题（按章节切分时使用） */
  chapter?: string;
  /** 该片段在**本页/本章文本**中的起始字符偏移（左闭） */
  charStart?: number;
  /** 结束字符偏移（右开） */
  charEnd?: number;
}

/** 资料里的一段可定位文本（一页，或一章）。 */
export interface SourceSegment {
  id: string;
  sourceId: string;
  /** 顺序号，从 1 开始；用于翻页与稳定排序 */
  index: number;
  /** 页码。按章节切分的资料里等于 index */
  page: number;
  /** 所属章节标题，没有则 null */
  chapter: string | null;
  /**
   * 规范化后的正文。
   *
   * 「规范化」指：PDF 里被行尾硬断开的句子已经接回整句（见 parser/normalize.ts），
   * 段落之间用 `\n\n` 分隔。这样全文搜索整句能命中，
   * 而 charStart/charEnd 也直接对应这里，高亮不会错位。
   */
  text: string;
  /** 该段字符数，避免每次搜索都算长度 */
  charCount: number;
}

/** 资料的文本可用状态。扫描件在这里被显式标出来，而不是伪装成「导入成功」。 */
export type SourceTextStatus =
  /** 正常，有可检索的文本层 */
  | 'ready'
  /** 扫描件：没有文本层，文字在图片里。用看图模型逐页识别可转成文字 */
  | 'no-text-layer'
  /**
   * 解码失败：文件里有字（有字体、有绘制指令），但我们取不出来。
   *
   * 和扫描件必须分开：扫描件该让用户换电子版或等 OCR，
   * 解码失败是我们这边的配置/依赖问题，让用户去换文件是推卸责任。
   */
  | 'decode-failed';

/**
 * 资料（教材/课件/讲义/粘贴文本）。
 */
export interface Source {
  id: string;
  title: string;
  /** 原始文件名，粘贴文本为 null */
  fileName: string | null;
  /**
   * 来源类型。
   *
   * `image` 是后加的：图片本身没有文本层，导入后是「一段、正文待识别」，
   * 靠 OCR 转成文字参与后续流程。它和扫描件走同一条路
   * （textStatus = 'no-text-layer'），所以下游不需要为它开特例。
   */
  kind: 'pdf' | 'docx' | 'pptx' | 'markdown' | 'text' | 'image';
  /** 归属课程，未归类为 null */
  courseId: string | null;
  /** 总页数（未知为 null） */
  pageCount: number | null;
  /** 导入时的字节数（粘贴文本为字符数） */
  byteSize: number;
  /** 文本可用状态 */
  textStatus: SourceTextStatus;
  /** 切分出的段数，列表页直接显示，不必再查 segments */
  segmentCount: number;
  /**
   * 原始文件字节是否还在本机（`sourceFiles` 分区）。
   *
   * 只有 PDF 会留字节，且仅用于把原文某一页渲染成图片贴进 PPT（图文页）。
   * 超过大小上限、或非 PDF 的资料为 false —— 界面据此如实关闭图文页入口，
   * 而不是让用户点了才报错。
   */
  fileStored: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 课程，用于把资料分组（P1 资料库列表依赖）。 */
export interface Course {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

/**
 * 一条知识点的定位状态。
 *
 * 为什么要有这个字段：计划书 P2 第 7 条要求
 * 「指认不到原文位置的条目单独标出来，等人处理，**不要自动填一个位置上去**」。
 * 用一个显式状态把这件事变成数据，而不是靠「anchors 为空」去猜 ——
 * 「用户删掉了锚点」和「AI 给的位置找不到」是两种不同的情况，界面提示也不同。
 */
export type AnchorStatus =
  /** 定位成功，anchors 可用 */
  | 'located'
  /** AI 给了引用文本，但在原文里找不到 → 需要人工处理 */
  | 'unlocated'
  /** 人工确认为「没有出处」（比如模型总结性的话），不再提示 */
  | 'waived';

/**
 * 知识点：中间层实体，PPT 与习题都由它派生。
 *
 * 设计上最重要的一条：**模型不产出页码，只产出原文引用**。
 * 页码由我们在真实段落里定位后写入（见 core/knowledge/locator.ts）。
 * 让模型直接说「第 12 页」是不可信的 —— 它不知道分页在哪，
 * 而指错页比不能跳转更糟，因为它冒充可信。
 */
export interface KnowledgePoint {
  id: string;
  /** 概念表述 —— 会被 PPT 与题目引用 */
  statement: string;
  /** 归属章节 */
  chapter: string | null;
  /** 认知层级，决定出题难度（P3 依赖） */
  cognitiveLevel: 'remember' | 'understand' | 'apply' | 'analyze';
  tags: string[];
  /**
   * 锚定的原文位置。定位失败时**为空数组**，绝不用估算位置填充。
   * 每个 anchor 的 page/charStart/charEnd 都是实测出来的。
   */
  anchors: SourceLocation[];
  /** 原文片段（引用文本），与 anchors 一一对应 */
  quotes: string[];
  /** 定位状态，决定界面上是否要标红提醒人工处理 */
  anchorStatus: AnchorStatus;
  /** 该知识点是教材原文还是网上补充资料 */
  origin: 'material' | 'web';
  /** 来源资料（P2 生成时记录，便于回溯与重新定位） */
  sourceId: string | null;
  /** 生成这批知识点用的后端 id，便于 P5「多后端结果并存对比」 */
  backendId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一次生成任务的元信息。
 *
 * 单独存一张表而不是塞进 source：一次生成可能跨多份资料（后期），
 * 而且「中途停止」要求已产出的部分保留，需要一个地方记录这次跑到哪。
 */
export interface GenerationRun {
  id: string;
  /** 归属资料（P2 阶段一次只处理一份） */
  sourceId: string;
  /** 页码范围，null 表示整份 */
  pageRange: { from: number; to: number } | null;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  /** 预计用量（token），生成前显示 */
  estimatedTokens: number | null;
  /** 实际用量，生成后显示 */
  actualTokens: number | null;
  /** 产出的知识点条数 */
  producedCount: number;
  /** 定位失败的条数，便于界面直接提示 */
  unlocatedCount: number;
  /** 失败原因（status === 'failed' 时） */
  error: string | null;
  /** 用的后端 */
  backendId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * 用量统计的一条记录：**按「天 + 后端 + 用途」聚合**，不是流水账。
 *
 * 为什么不存每次调用的明细：
 * 一次整理可能发好几次请求，一次出题也是。按次存，一个月就是几千条记录，
 * 而用户真正想知道的只有「这个月智谱花了多少、DeepSeek 花了多少」。
 * 聚合记录的 id 是确定性的（见 usageKey），同一格重复写入就是累加，
 * 天然幂等，也不会因为反复重试而膨胀。
 *
 * 为什么单独建表而不从 GenerationRun 统计：
 * GenerationRun 只覆盖「整理知识点」，出题的 token 完全没落库；
 * 而且它会被 clearBySource / 删除资料清掉，用量记录不该跟着消失
 * —— 钱已经花了，删资料不能让账单变少。
 */
export interface UsageRecord {
  /** 确定性 id：`${day}|${backendId}|${kind}`，保证同一格只有一条 */
  id: string;
  /** 本地日期 YYYY-MM-DD。按用户所在时区切天，不按 UTC */
  day: string;
  /** 用的后端（BackendConfig.id，或 model:xxx 这类内置标识） */
  backendId: string;
  /** 服务商标识，便于界面上按「智谱/DeepSeek」汇总而不必回查后端配置 */
  provider: string;
  /**
   * 消耗在什么地方。
   *
   * `organize` 整理知识点、`questions` 出题、`slides` 生成 PPT 大纲。
   * 三者必须分开记：用户需要知道钱花在哪一环，
   * 混成一个数就只剩「这个月花了多少」，没法判断值不值。
   */
  kind: 'organize' | 'questions' | 'slides';
  /** 累计调用次数，让「几次请求花了这么多」有据可依 */
  calls: number;
  /** 累计 token。服务端没返回 usage 时不计入（不猜） */
  tokens: number;
  /** 最近一次调用时间 */
  lastAt: string;
}

/** 习题集。 */
export interface Deck {
  id: string;
  title: string;
  courseId: string | null;
  /**
   * 草稿 / 已发布。
   *
   * 计划书 P3 第 2 条：「生成习题集 → 先落草稿，人工检查后才发布；
   * 发布时逐题再校验一遍」。草稿里可随意删改，发布后学生才开始刷。
   */
  status: 'draft' | 'published';
  /** 生成这批题用的资料（可空：也支持手工建的空习题集） */
  sourceId: string | null;
  /** 生成用的后端，便于回溯「这批题是谁出的」 */
  backendId: string | null;
  /** 题数缓存，列表页直接显示，不必每次数 */
  questionCount: number;
  /** 发布前校验发现的阻塞问题数（0 才能发布） */
  blockingIssues: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 题型 */
export type QuestionKind =
  /** 单选：一个正确选项 */
  | 'single'
  /** 多选：多个正确选项 */
  | 'multiple'
  /** 填空：文本答案 */
  | 'blank'
  /** 问答：长文本答案，需自评 */
  | 'essay';

/** 一个选项（仅单选/多选有） */
export interface QuestionOption {
  /** 稳定标识，如 'A' 'B'，作答记录靠它 */
  key: string;
  text: string;
}

/**
 * 单道题目。
 *
 * ## 关键设计：出处继承知识点，不让模型重新给引用
 *
 * `knowledgePointId` 指向出题的来源知识点，`anchors` **直接继承**它的位置。
 *
 * 为什么不让模型再说一次「这道题出自哪段原文」：
 * 模型对同一段话两次引用可能不一致，会出现
 * 「知识点说第 3 页、题目说第 5 页」的矛盾，而学生不知道该信哪个。
 * 继承已经验证过的位置，题目的「点回原文」必然准确。
 */
export interface Question {
  id: string;
  deckId: string;
  kind: QuestionKind;
  prompt: string;
  /** 选项。single/multiple 必须有；blank/essay 为空数组 */
  options: QuestionOption[];
  /**
   * 正确答案。
   * - single：一个选项 key，如 'A'
   * - multiple：多个 key 用逗号分隔，如 'A,C'
   * - blank / essay：参考答案文本
   */
  answer: string;
  explanation: string;
  /** 出处。继承自知识点，可能是空数组（该知识点本身就没定位到） */
  anchors: SourceLocation[];
  /** 出题依据的知识点 id；手工建的题可为 null */
  knowledgePointId: string | null;
  /** 认知层级，从知识点继承，决定难度 */
  cognitiveLevel: 'remember' | 'understand' | 'apply' | 'analyze';
  /** 题干涉及的概念（用于列表展示与筛选） */
  topic: string | null;
  /** 排序序号，保证题目顺序稳定 */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一次作答记录。
 *
 * 单独一张表而不是塞进 Question：同一道题可以刷多次，
 * 每次的作答时间、对错都要留着 —— 这是错题归集与间隔复习的数据基础。
 */
export interface AnswerRecord {
  id: string;
  questionId: string;
  deckId: string;
  /** 用户提交的答案，格式同 Question.answer */
  response: string;
  /** 判定结果。essay 类型是自评 */
  correct: boolean | null;
  /** 本次耗时毫秒，可空 */
  elapsedMs: number | null;
  answeredAt: string;
  /**
   * 单调递增的提交序号。
   *
   * 为什么不能只靠 answeredAt：`new Date().toISOString()` 精度只到毫秒，
   * 学生连点两次、或者脚本连续提交时，两条记录的 answeredAt 会**完全相同**。
   * 那样「最近一次作答」就排不出先后 —— 而错题归集恰恰依赖这个顺序：
   * 判断错题的标准是「最近一次答错了」，顺序错了结论就反了。
   *
   * 这是实测发现的：测试里连续提交两次「错→对」，
   * 因为时间戳相同，取到的"最近一次"仍是被判错的那条。
   */
  sequence: number;
}

/**
 * 发布前校验发现的一个问题。
 *
 * 计划书 P3：「发布时逐题再校验一遍」。
 * 做成数据结构而不是一串字符串，界面才能逐条指出「第几题、什么问题」。
 */
export interface QuestionIssue {
  questionId: string;
  /** 题号（从 1 开始），便于用户定位 */
  order: number;
  severity: 'blocking' | 'warning';
  /** 问题代码，便于统计与测试断言 */
  code:
    | 'missing-prompt'
    | 'missing-answer'
    | 'missing-explanation'
    | 'missing-anchors'
    | 'missing-options'
    | 'invalid-answer-key'
    | 'duplicate-prompt';
  message: string;
}

/**
 * 幻灯片版式。
 *
 * 只做四种，不做自由排版引擎（计划书第 4 节「不做」清单第 7 条）。
 * 版式少的好处是每页都规整，不会出现文字压到边角的情况。
 */
export type SlideLayout =
  /** 封面：标题 + 副标题（资料来源概览） */
  | 'title'
  /** 章节过渡页：只放章节名 */
  | 'section'
  /** 要点页：一组要点，每条带引用角标 */
  | 'bullets'
  /** 资料来源页：角标编号 → 文档名 + 页码。固定放在最后 */
  | 'sources'
  /**
   * 图文页：左侧或整幅放原文某一页的截图，配一段说明。
   *
   * ## 为什么是「原文页截图」而不是「从教材里抽插图」
   *
   * 计划书 P4 要求标题页/要点页/图文页。直觉做法是抽取教材里的插图，
   * 但我们用 scripts/probe-figures.ts 实测过：文字型教材每页的内嵌位图是 0 张
   * （章节示意图基本都是矢量绘制），唯一有位图的 scanned.pdf 是整页一张图。
   * 也就是说「抽插图」这条路在真实教材上抽不到东西。
   *
   * 而「把原文那一页渲染成图片」既总能实现，又正好落在本项目的核心卖点上：
   * 学生拿到的 PPT 里，图和原文是同一页，不会出现「这张图到底哪来的」。
   */
  | 'figure';

/**
 * 幻灯片里的一条要点。
 *
 * ## 为什么不存位置，只存 citationId
 *
 * 和 P3 的题目同理：位置从知识点**继承**，不在 PPT 层再算一次。
 * 如果这里也存一份 page，就有两处可能打架，而学生不知道该信哪个。
 * 存 citationId 指向本 PPT 的引用表，引用表里的位置是从知识点复制来的，
 * 而知识点的位置是 P2 定位器在真实文本里实测出来的。
 */
export interface SlideBullet {
  id: string;
  text: string;
  /** 指向 SlideDeck.citations 的下标；null 表示这条要点没有出处（比如页面过渡语） */
  citationIndex: number | null;
}

/**
 * 一张原文页截图（图文页用）。
 *
 * ## 为什么把图片数据直接存在这里，而不是另开分区放
 *
 * 图片是这张幻灯片的正文，不是附件。存成外键的话，备份文件里会留下
 * 「PPT 说有张图、图却没跟着走」的空壳 —— 换台机器恢复后打开是坏图。
 * 直接存在页里，PPT 是自包含的：备份、导出、预览三处永远是同一份图。
 *
 * 代价是备份会变大。一张 1600px 宽的页面截图约 200~400KB，而图文页是
 * 用户一页一页手动加的，不会像资料正文那样一次几十万字，所以可以接受。
 */
export interface SlideFigure {
  /** 取自哪份资料 */
  sourceId: string;
  /** 资料的第几页（从 1 开始） */
  page: number;
  /**
   * PNG 的 data URL（`data:image/png;base64,...`）。
   *
   * 用 data URL 而不是 base64 裸串：pptxgenjs 的 addImage 直接收这个格式，
   * 浏览器的 <img> 也直接收，两边都不用再做前缀拼接，少一处出错的地方。
   */
  imageData: string;
  /** 图片像素宽高，用于在版面上按比例摆放，避免被拉扁 */
  width: number;
  height: number;
  /** 图注，用户可改。默认「《资料名》第 N 页」 */
  caption: string;
}

/**
 * 叠在页面上的一块自由摆放内容（图片 / 文本框）。
 *
 * ## 为什么坐标存比例而不是像素
 *
 * 用户在预览里拖拽，拿到的是像素；导出用 pptxgenjs，要的是英寸。
 * 如果直接把像素存进库，换一个屏幕尺寸（或换台机器）再打开，
 * 图就会跑到别的位置 —— 存的时候是「距左 320px」，
 * 而 320px 在 1440 宽的屏和 900 宽的屏上不是同一个比例。
 *
 * 所以这里一律存 **0~1 的相对比例**，由渲染层各自乘回自己的单位：
 * 预览 × 容器宽度、导出 × SLIDE_SIZE.width。这样两边必然一致，
 * 也就守住了「预览 = 导出」这条底线。
 */
export interface SlideOverlay {
  id: string;
  kind: 'image' | 'text';
  /**
   * 图片记录 id（指向 slideImages 分区）。kind='image' 时必填。
   *
   * 存 id 而不是内嵌 base64：同样一张图在 50 页里用两次，
   * 内嵌会让 deck 记录大 100 倍，而 IndexedDB 单条记录是有大小风险的。
   */
  imageId?: string;
  /** 文字内容。kind='text' 时必填 */
  text?: string;
  /** 位置与尺寸，全部是相对版面的比例（0~1）。x/y 是左上角 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 叠放顺序，大的在上层。同值时按数组顺序 */
  z: number;
  /** 文字的字号（磅）。仅 kind='text' */
  fontSize?: number;
  /** 文字颜色（不带 # 的十六进制）。不填用主题正文色 */
  color?: string;
}

/**
 * 一张用户插入的图片。
 *
 * 与 `SlideFigure`（原文页截图）分开存：那个是「资料某页的渲染结果」，
 * 由系统生成且与 sourceId/page 绑定；这个是用户从自己电脑里选的文件，
 * 系统对它一无所知。混用会让「重新渲染原文页」的逻辑误伤用户自己的图。
 */
export interface SlideImageRecord {
  id: string;
  /** `data:image/png;base64,...` 整串 */
  imageData: string;
  /** 像素宽高，用于按原比例摆放 */
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
}

/** 大纲里的一页。用户可改标题、调顺序、增删页。 */
export interface SlideOutlinePage {
  id: string;
  layout: SlideLayout;
  title: string;
  /** 副标题，仅 title/section 版式使用 */
  subtitle: string | null;
  bullets: SlideBullet[];
  /** 图文页的图片；其他版式恒为 null */
  figure: SlideFigure | null;
  /**
   * 用户自由摆放的叠加内容（图片、文本框）。
   *
   * 与 `figure` 的区别：figure 是「这一页的主要配图」，参与版式排版；
   * overlays 是叠在成品页面之上的东西，不参与段落排版，
   * 所以它可以是 0 个、也可以是好几个。
   *
   * 旧数据没有这个字段时为 undefined，按「没有叠加内容」处理。
   */
  overlays?: SlideOverlay[];
}

/**
 * 一条引用（角标）。
 *
 * 同一份资料的同一页可能有多个角标指向同一个位置，这里按知识点去重：
 * 一条知识点一个角标，编号连续，便于在末尾的资料页逐条列出。
 */
export interface SlideCitation {
  /** 角标编号，从 1 开始。界面显示为 ① 或 [1] */
  index: number;
  /**
   * 出处段落 id（`sourceSegments` 的主键）。
   *
   * PPT 现在从**资料原文**生成，出处就是这一段原文；
   * 页码直接取 `SourceSegment.page`，不再经过知识点。
   *
   * 这样一来角标链路少一跳，也不再要求「知识点必须定位成功」——
   * 段落是解析器切出来的，页码必然准确。
   */
  segmentId: string;
  /** 出处资料 */
  sourceId: string;
  sourceTitle: string;
  /** 页码/章节序号 */
  page: number | null;
  chapter: string | null;
  /** 被引用的原文片段，资料页显示前 40 字，便于核对 */
  quote: string;
  /**
   * 旧字段：旧版本 PPT 的角标来自知识点。
   *
   * 保留只为让迁移能把老数据读出来（旧 PPT 打开时不至于报错）。
   * 新生成的 PPT **不再写这个字段** —— 出处一律用 segmentId。
   */
  knowledgePointId?: string;
}

/**
 * 一次导出的记录。
 *
 * 计划书 P4 第 5 条：「重复导出不覆盖旧版本」。
 * 光靠文件名加版本号还不够 —— 用户看不到自己到底导过几次、导的是哪一版。
 * 存下来，界面才能如实显示「已导出 3 次，最近一次 10:32，24 页」。
 */
export interface SlideExportRecord {
  id: string;
  fileName: string;
  /** 这次导出的页数，便于和当前大纲对比出「导出后又改过」 */
  slideCount: number;
  byteSize: number;
  exportedAt: string;
}

/**
 * 学习 PPT。
 *
 * 两段式：先出大纲（status='outline'，用户可改），确认后再生成幻灯片
 * （status='ready'）。这和 P3「先落草稿、人工检查后发布」是同一个思路 ——
 * 让人在花时间导出之前先看一眼结构对不对。
 */
export interface SlideDeck {
  id: string;
  title: string;
  courseId: string | null;
  /** 生成用的资料（可空：也支持手工建的空 PPT） */
  sourceId: string | null;
  /**
   * 配色主题 id（见 core/slides/theme.ts）。
   *
   * 存 id 而不是存一份色值：色值是渲染层的知识，存进数据会让
   * 「改一套配色」变成「迁移所有历史 PPT」。id 找不到时渲染层
   * 退回默认主题，所以旧备份不会因为配色名对不上而打不开。
   *
   * 旧数据没有这个字段时为 undefined，按默认主题处理。
   */
  theme?: string;
  /**
   * 自定义主色（不带 # 的六位十六进制）。可选。
   *
   * 只覆盖强调色（标题装饰线、角标），不动正文色 ——
   * 用户改的是「风格」，不是「让正文变成别的颜色」。
   * 对比度不足时界面会警告但放行，见 theme.ts 的 checkAccent。
   */
  accentColor?: string;
  /** 大纲 / 已确认 */
  status: 'outline' | 'ready';
  /** 大纲页。顺序即幻灯片顺序 */
  pages: SlideOutlinePage[];
  /** 引用表，角标编号 → 出处 */
  citations: SlideCitation[];
  /** 导出历史，按时间正序。数组长度即导出次数 */
  exports: SlideExportRecord[];
  createdAt: string;
  updatedAt: string;
}

/**
 * AI 后端配置。
 *
 * 安全要求（计划书 P5 验收）：凭据不得出现在导出文件、日志、界面截图中。
 * 因此 apiKey 单独存于 `secrets` 存储区，**永不进入备份文件**。
 */
export interface BackendConfig {
  id: string;
  /** 用户可读名称 */
  label: string;
  /** 后端类型：模型 API 直连 / agent 应用接入 */
  kind: 'direct-api' | 'agent-app';
  /** direct-api 的服务商标识，如 deepseek / openai-compatible */
  provider: string;
  /** API 基址（direct-api 使用） */
  baseUrl: string;
  /** 默认模型名 */
  model: string;
  /**
   * 该后端自报支持的能力（P5 要求调用前就告知）。
   *
   * 每一项都必须有代码真的去读它，否则就是假开关。
   * `visionFormula` 由 `OcrService`（src/core/ocr/）读取 —— 勾上它，
   * 扫描件才会真的逐页送进多模态模型识别。
   *
   * 早先这里还有第三项 `webSearch`（联网检索）。它从来没有被读取过：
   * OpenAI 兼容接口没有统一的联网检索写法（各家形状都不同），
   * 所以那个勾选框点了也不会有任何事发生。已按「假控件要么变成真功能、
   * 要么摘掉」的原则移除，不留一个永远没人读的字段。
   */
  capabilities: {
    /** 文字整理：把有文本层的资料整理成知识点 */
    textOrganize: boolean;
    /** 看图识公式：把扫描件逐页渲染后交给多模态模型识别 */
    visionFormula: boolean;
  };
  /** 当前可用状态（P5 要求调用前告知，不做「点了才发现不能用」） */
  status: 'ready' | 'unconfigured' | 'needs-login' | 'expired';
  /** 是否为当前默认后端 */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 应用设置（与学习库一起导出，但不含任何凭据）。 */
export interface AppSettings {
  /** 界面语言，P0 固定 zh-CN */
  locale: 'zh-CN';
  /** 默认出题语言 */
  questionLanguage: 'zh' | 'en';
  /** 是否已看过首次引导 */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  questionLanguage: 'zh',
  onboarded: false,
};

/**
 * 存储层里的设置记录。
 *
 * 设置本身是一个单例，但所有分区都以 `id` 为主键（导入备份时靠它覆盖），
 * 所以这里显式带上 id，而不是在存储代码里到处 as 断言。
 */
export interface SettingsRecord extends AppSettings {
  id: string;
}

/**
 * 学习库元信息。
 * 一个学习库 = 一个可整体导出/导入的单元（P0 交付要求）。
 */
export interface LibraryMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

/**
 * 备份文件结构。
 *
 * 刻意**不包含** secrets：凭据不进导出文件是 P5 的硬性验收项。
 */
export interface LibraryBackup {
  /** 固定标记，导入时校验，防止误传其他 JSON */
  format: 'openleaner-library';
  schemaVersion: number;
  exportedAt: string;
  meta: LibraryMeta;
  settings: AppSettings;
  courses: Course[];
  sources: Source[];
  /** 切分后的正文。跟资料一起备份，否则恢复后「点回原文」全失效 */
  sourceSegments: SourceSegment[];
  /**
   * 用户手写的页面注释。
   *
   * 进备份的理由：这是用户自己画的内容，不像 sourceFiles 那样
   * 能从原文件重新渲染。丢了就真的找不回来。
   */
  sourceAnnotations?: SourceAnnotation[];
  knowledgePoints: KnowledgePoint[];
  /** 生成任务记录。跟知识点一起备份，否则恢复后看不到「这批是哪次跑的、花了多少」 */
  generationRuns: GenerationRun[];
  decks: Deck[];
  questions: Question[];
  /** 作答记录。跟题一起备份，否则恢复后错题本全空 */
  answerRecords: AnswerRecord[];
  slideDecks: SlideDeck[];
  /**
   * 用户插入到 PPT 里的图片。
   *
   * 进备份：这些是用户从自己电脑里选的文件，丢了就找不回来，
   * 和 sourceFiles（能从原 PDF 重新渲染）性质不同。
   */
  slideImages: SlideImageRecord[];
  backends: BackendConfig[];
  /**
   * 用量统计。跟库一起备份：换机器后账单不该归零。
   *
   * 注意这不违反「凭据不进备份」——这里只有「哪天用了多少 token」，
   * 不含 Key、不含任何请求内容。
   */
  usageRecords: UsageRecord[];
}

// ---------------------------------------------------------------------------
// 资料页面注释（画笔 + 文本框）
// ---------------------------------------------------------------------------

/**
 * 笔形。
 *
 * 每种笔不是简单的粗细差别，而是**渲染方式**不同：
 *  - pen      钢笔：随速变粗细（压感模拟），边缘清晰
 *  - marker   马克笔：方头、半透明叠加，划重点用
 *  - highlighter 荧光笔：更宽更淡，垫在文字下面
 *  - pencil   铅笔：轻微抖动 + 颗粒感，草稿感
 *  - laser    激光笔：高亮但不落墨（默认不留存，松手即散）
 */
export type PenKind = 'pen' | 'marker' | 'highlighter' | 'pencil' | 'laser';

/** 一笔画笔笔迹。一次按下-拖动-抬起算一笔 */
export interface InkStroke {
  /** 笔迹内的点，坐标是页面比例（0~1） */
  points: { x: number; y: number }[];
  /** 线的颜色，形如 `#e11d48` */
  color: string;
  /** 线的粗细，以页面宽度的比例表示（0~1）。这样缩放时不跟着变粗 */
  width: number;
  /**
   * 笔形。缺省视为 'pen'。
   *
   * 为什么用枚举而不是 `highlighter?: boolean`：
   * 布尔只能表达「是不是荧光笔」，加第三种笔就表达不了。
   * 早先的布尔字段保留兼容（见 renderStroke 里的回退）。
   */
  kind?: PenKind;
  /**
   * @deprecated 用 kind: 'highlighter' 代替。
   * 保留是为了让 2026-11-06 之前存下的注释还能正常显示。
   */
  highlighter?: boolean;
}

/** 图形种类 */
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';

/**
 * 一个图形元素（直线、箭头、矩形、椭圆）。
 *
 * 与笔迹分开存而不是「用笔迹模拟」：
 * 图形必须是**矢量**的 —— 缩放后重画才不糊，擦除时也是一个整体。
 * 用笔迹拼矩形的话，放大到 300% 边缘会有锯齿。
 */
export interface ShapeElement {
  id: string;
  kind: ShapeKind;
  /** 起点（比例）。矩形/椭圆是一组对角 */
  x1: number;
  y1: number;
  /** 终点（比例） */
  x2: number;
  y2: number;
  color: string;
  /** 线宽，页面宽度比例 */
  width: number;
  /** 填充色，null 表示不填充 */
  fill: string | null;
}

/** 页面上的一类注释 */
export interface SourceAnnotation {
  id: string;
  sourceId: string;
  /** 页码，从 1 开始。与 SourceSegment.page 对齐 */
  page: number;
  /** 画笔笔迹集合 */
  strokes: InkStroke[];
  /** 文本框 */
  texts: TextNote[];
  /**
   * 图形元素（线/箭头/矩形/椭圆）。
   *
   * 可选是为了兼容 2026-11-06 之前存下的记录 ——
   * 那些记录里没有这个字段，读出来是 undefined，
   * 各处按 `?? []` 处理。
   */
  shapes?: ShapeElement[];
  createdAt: string;
  updatedAt: string;
}

/** 页面上的一个文本框 */
export interface TextNote {
  id: string;
  /** 文本内容 */
  text: string;
  /** 位置：左上角 + 尺寸，全部是页面比例（0~1） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 字号，以页面高度的比例表示，缩放时不跟着变 */
  fontSize: number;
  /** 文字颜色 */
  color: string;
  /** 背景色，null 表示透明（只看字，不挡原文） */
  background: string | null;
}

