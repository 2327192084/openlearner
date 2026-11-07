import { newId, nowIso } from '../id.ts';
import type {
  AnswerRecord,
  Deck,
  KnowledgePoint,
  Question,
  QuestionIssue,
  QuestionKind,
  SourceLocation,
} from '../model.ts';
import type { StorageAdapter } from '../storage/types.ts';
import { pointsToMaterials, toSourcePoint, type QuestionMaterial } from './materials.ts';
import type { UsageService } from '../usage.ts';
import {
  DEFAULT_EXPORT_OPTIONS,
  exportFileName,
  exportToJson,
  exportToMarkdown,
} from './export.ts';
import type { ExportOptions } from './export.ts';
import { parseDeckJson } from './import-json.ts';
import type { ParsedImport } from './import-json.ts';
import type {
  GenerateQuestionsOptions,
  QuestionBackend,
  QuestionDraft,
  QuestionSourcePoint,
} from './backend-types.ts';

/**
 * 习题集服务：出题、草稿、发布校验、作答、错题归集。
 *
 * ## 这个文件里最重要的一个决定
 *
 * **题目的出处继承知识点的 anchors，绝不让模型重新给引用。**
 *
 * 计划书 P3 验收要求「题题有出处，且点得通」。做法有两种：
 *   A. 让模型为每道题再说一次「这道题出自哪段原文」→ 不可靠
 *   B. 让模型只说「依据哪条知识点」，位置从知识点的 anchors 继承 → 可靠
 *
 * 选 B 的原因：模型对同一段话两次引用会不一致。
 * 盘点结果是「知识点说第 3 页、题目说第 5 页」，学生不知道该信哪个 ——
 * 这比没有出处更糟，因为它冒充可信。
 *
 * 所以 `materialize()` 里 anchors 一律从知识点复制，模型给的任何位置信息都不采信。
 */

/** 出题进度 */
export interface GenerateProgress {
  produced: number;
  /** 按知识点数估算的目标总量，用于进度条 */
  estimatedTotal: number;
  pointTotal: number;
}

export interface GenerateQuestionsInput {
  /** 出题依据的知识点（由调用方从 KnowledgeService 取） */
  points: KnowledgePoint[];
  /**
   * 用「归一后的素材」出题（2026-11-07 新增）。
   *
   * 为什么加这个而不是改 points：用户要求出题可以来自**两处** ——
   *  - 知识库（知识点）
   *  - 资料原文（正文段落，不再经过知识点）
   *
   * 两者形状不同，但出题后端只认 QuestionSourcePoint。把「素材」抽出来之后，
   * 后端与提示词一行都不用改，调用方只要给出 materials，走哪条来源都行。
   *
   * 传了 materials 就**优先用它**；都没传则报错。
   */
  materials?: QuestionMaterial[];
  title: string;
  courseId?: string | null;
  sourceId?: string | null;
  /**
   * 这批题是否来自「整库随机抽取」。
   *
   * 用户要求「随机题组要特意标注」，所以要落到 Deck 上，
   * 而不是只在生成那一刻的界面里提一句（刷新就没了）。
   */
  randomSource?: boolean;
  backend: QuestionBackend;
  options: Omit<GenerateQuestionsOptions, 'signal'>;
  signal: AbortSignal;
  onProgress?: (p: GenerateProgress) => void;
}

export interface GenerateQuestionsOutput {
  deck: Deck;
  questions: Question[];
  stopped: boolean;
  actualTokens: number | null;
}

export class DeckService {
  /**
   * 只依赖存储，不依赖 KnowledgeService。
   *
   * 知识点由调用方取好传进来（见 GenerateQuestionsInput.points）：
   * 出题只需要「已定位的知识点」，而筛选条件属于上层业务判断。
   * 少一层依赖，测试里也不用为了出题去造一个知识点服务。
   */
  /**
   * 作答序号计数器。
   *
   * 从存储里已有的最大值续上，保证跨刷新也单调递增。
   * 不用时间戳，因为它的精度只到毫秒，同一毫秒内两次提交分不出先后（实测踩过）。
   */
  private sequenceCounter: number | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    /** 用量记账，可选。不传就是不记账，业务行为不变（见 KnowledgeService 的说明） */
    private readonly usage?: UsageService,
  ) {}

  /** 取下一个序号。首次调用时从库里扫一遍取最大值。 */
  private async nextSequence(): Promise<number> {
    if (this.sequenceCounter === null) {
      const all = await this.storage.getAll('answerRecords');
      let max = 0;
      for (const r of all) {
        // 兼容旧数据：没有 sequence 的按 0 处理
        const v = typeof r.sequence === 'number' ? r.sequence : 0;
        if (v > max) max = v;
      }
      this.sequenceCounter = max;
    }
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }

  // -------------------------------------------------------------------------
  // 习题集读写
  // -------------------------------------------------------------------------

  async list(): Promise<Deck[]> {
    const all = await this.storage.getAll('decks');
    return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async get(id: string): Promise<Deck | null> {
    return this.storage.get('decks', id);
  }

  /** 取某习题集的题目，按 order 升序 */
  async getQuestions(deckId: string): Promise<Question[]> {
    const all = await this.storage.getAll('questions');
    return all.filter((q) => q.deckId === deckId).sort((a, b) => a.order - b.order);
  }

  async getQuestion(id: string): Promise<Question | null> {
    return this.storage.get('questions', id);
  }

  // -------------------------------------------------------------------------
  // 生成
  // -------------------------------------------------------------------------

  /**
   * 从知识点出题。
   *
   * 与整理知识点一致的行为：
   *  - 逐题落库（中途停止时已产出的不丢）
   *  - 记录用量
   *  - 生成结果一律是**草稿**状态，必须人工检查后发布
   */
  async generate(input: GenerateQuestionsInput): Promise<GenerateQuestionsOutput> {
    /*
     * 两条来源统一成 materials：
     *  - 给了 materials（知识库出题 / 从原文出题）就直接用
     *  - 没给就退回老路径：从知识点映射
     */
    const materials: QuestionMaterial[] =
      input.materials && input.materials.length > 0
        ? input.materials
        : pointsToMaterials(input.points);

    if (materials.length === 0) {
      /*
       * 三种情况必须分开说，用户才知道下一步做什么：
       *  1. 给了 materials 但为空 → 原文太短/没解析出字
       *  2. 有知识点，但全都没定位到原文 → 重新整理一遍
       *  3. 一条知识点都没有 → 先整理，或从原文字出题
       */
      if (input.materials) {
        throw new Error(
          '没有可用于出题的素材。资料正文可能太短，或者都还没有解析出文字。',
        );
      }
      if (input.points.length > 0) {
        throw new Error(
          '这些知识点都没有定位到原文位置，出题后无法「点回原文」。请先到「整理知识点」把资料重新整理一遍，让每条都带上原文位置，再来出题。',
        );
      }
      throw new Error(
        '没有可出题的知识点。可以到「我的题组」从知识库出题，或到「整理知识点」把资料整理成知识点。',
      );
    }

    const sourcePoints: QuestionSourcePoint[] = materials.map(toSourcePoint);
    const estimated = input.backend.estimateTokens(sourcePoints, input.options);

    const ts = nowIso();
    const deckId = newId('deck');

    const deck: Deck = {
      id: deckId,
      title: input.title.trim() || '未命名习题集',
      courseId: input.courseId ?? null,
      status: 'draft',
      sourceId: input.sourceId ?? null,
      backendId: input.backend.id,
      /*
       * 题型与「是否随机」按用户要求落到题组上，这样列表里能直接标注，
       * 不用等到点进去才发现是单选还是简答。
       *
       * kinds 取自主出题选项（options.kinds），去重后保存；
       * 空数组视为「混合 / 未标注」。
       */
      ...(input.options.kinds && input.options.kinds.length > 0
        ? { kinds: [...new Set(input.options.kinds)] }
        : {}),
      ...(input.randomSource ? { randomSource: true } : {}),
      questionCount: 0,
      blockingIssues: 0,
      publishedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.storage.put('decks', deck);

    const questions: Question[] = [];
    // 知识点 id → 原对象，用于继承 anchors
    const materialById = new Map(materials.map((m) => [m.id, m]));

    /**
     * 出题失败（含用户中途停止）时，**草稿已经建好了**，不能就这么丢掉引用。
     *
     * 早先这里直接 await，出错就向上抛；调用方拿不到 deckId，
     * 只能提示「草稿已保留，回列表看」—— 而列表里可能有好几个草稿，
     * 用户根本不知道哪个是刚才那个。更糟的情况是留下一个空草稿没人管。
     *
     * 现在：捕获异常，先把已产出的题与题数写进库，
     * 再把 deckId 挂到错误对象上一起抛。调用方就能准确告诉用户
     * 「已保留在《xxx》，可以去继续编辑」。
     */
    let result;
    try {
      result = await input.backend.generate(sourcePoints, {
        ...input.options,
        signal: input.signal,
        onDraft: async (draft) => {
          const material = materialById.get(draft.knowledgePointId);
          // 模型指了一个不存在的素材：丢弃这道题，不要瞎猜出处
          if (!material) return;

          const question = this.materialize(draft, material, deckId, questions.length);
          await this.storage.put('questions', question);
          questions.push(question);

          input.onProgress?.({
            produced: questions.length,
            estimatedTotal: Math.max(input.options.count, 1),
            pointTotal: materials.length,
          });
        },
      });
    } catch (err) {
      // 把已有成果固化下来，再把 deckId 带出去
      const partial: Deck = {
        ...deck,
        questionCount: questions.length,
        blockingIssues: this.validateQuestions(questions).filter((i) => i.severity === 'blocking')
          .length,
        updatedAt: nowIso(),
      };
      await this.storage.put('decks', partial);

      const wrapped = err instanceof Error ? err : new Error(String(err));
      // 挂在错误对象上，调用方读得到但不需要改所有 catch
      Object.assign(wrapped, {
        deckId,
        partialDeck: partial,
        producedCount: questions.length,
      });
      throw wrapped;
    }

    // 更新题数与校验结果
    const issues = this.validateQuestions(questions);
    const blocking = issues.filter((i) => i.severity === 'blocking').length;

    const updated: Deck = {
      ...deck,
      questionCount: questions.length,
      blockingIssues: blocking,
      updatedAt: nowIso(),
    };
    await this.storage.put('decks', updated);

    void estimated;

    /**
     * 记账。放在 deck 落库之后，理由同 KnowledgeService：
     * 先存好用户的数据，再记这笔钱。停止也记 —— 请求已发出、照样计费。
     */
    if (this.usage && !input.backend.isMock && result.actualTokens) {
      await this.usage.record({
        backendId: input.backend.id,
        provider: input.backend.provider ?? 'unknown',
        kind: 'questions',
        tokens: result.actualTokens,
      });
    }

    return {
      deck: updated,
      questions,
      stopped: result.stopped,
      actualTokens: result.actualTokens,
    };
  }

  /**
   * 把模型草稿变成可落库的题目。
   *
   * **这里是「出处可信」的关口**：anchors 只从知识点复制，不看模型说了什么。
   */
  private materialize(
    draft: QuestionDraft,
    material: QuestionMaterial,
    deckId: string,
    order: number,
  ): Question {
    const ts = nowIso();
    return {
      id: newId('q'),
      deckId,
      kind: draft.kind,
      prompt: draft.prompt.trim(),
      options: draft.options ?? [],
      answer: draft.answer.trim(),
      explanation: draft.explanation?.trim() ?? '',
      // 继承，不是采信。模型输出的任何位置信息都不进入这里。
      anchors: material.anchors.map((a) => ({ ...a })),
      knowledgePointId: material.id,
      cognitiveLevel: material.cognitiveLevel,
      topic: material.chapter,
      order,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  // -------------------------------------------------------------------------
  // 发布前校验（计划书 P3 第 2 条）
  // -------------------------------------------------------------------------

  /**
   * 逐题校验。
   *
   * 分两级：
   *  - **blocking**：必须修好才能发布（缺答案、答案键不存在、单选缺选项…）
   *  - **warning**：可以发布，但要让人知道（缺出处、缺解析）
   *
   * 为什么「缺出处」只是 warning 而不是 blocking：
   * P3 验收确实要求「题题有出处」，但把所有缺出处的题一律拦住会导致
   * 「一条定位失败的题都发布不了」——而用户可能就想先刷着，回头再补出处。
   * 所以做成警告并在界面上标出来。发布时如果存在 warning，界面会二次确认。
   */
  validateQuestions(questions: Question[]): QuestionIssue[] {
    const issues: QuestionIssue[] = [];
    const seenPrompts = new Map<string, number>();

    questions.forEach((q, idx) => {
      const order = q.order + 1 || idx + 1;

      if (!q.prompt.trim()) {
        issues.push({
          questionId: q.id,
          order,
          severity: 'blocking',
          code: 'missing-prompt',
          message: `第 ${order} 题题干为空`,
        });
      }

      if (!q.answer.trim()) {
        issues.push({
          questionId: q.id,
          order,
          severity: 'blocking',
          code: 'missing-answer',
          message: `第 ${order} 题没有答案`,
        });
      }

      // 单选/多选必须有选项，且答案键必须在选项里
      if (q.kind === 'single' || q.kind === 'multiple') {
        if (q.options.length < 2) {
          issues.push({
            questionId: q.id,
            order,
            severity: 'blocking',
            code: 'missing-options',
            message: `第 ${order} 题是选择题，但选项少于 2 个`,
          });
        } else {
          const validKeys = new Set(q.options.map((o) => o.key));
          const answerKeys = q.answer.split(',').map((s) => s.trim()).filter(Boolean);
          const invalid = answerKeys.filter((k) => !validKeys.has(k));

          if (answerKeys.length === 0 || invalid.length > 0) {
            issues.push({
              questionId: q.id,
              order,
              severity: 'blocking',
              code: 'invalid-answer-key',
              message: `第 ${order} 题的答案「${q.answer}」不在选项里（选项为 ${[...validKeys].join('、')}）`,
            });
          }

          if (q.kind === 'single' && answerKeys.length > 1) {
            issues.push({
              questionId: q.id,
              order,
              severity: 'blocking',
              code: 'invalid-answer-key',
              message: `第 ${order} 题是单选题，却给了 ${answerKeys.length} 个正确答案`,
            });
          }
        }
      }

      if (!q.explanation.trim()) {
        issues.push({
          questionId: q.id,
          order,
          severity: 'warning',
          code: 'missing-explanation',
          message: `第 ${order} 题没有解析`,
        });
      }

      if (q.anchors.length === 0) {
        issues.push({
          questionId: q.id,
          order,
          severity: 'warning',
          code: 'missing-anchors',
          message: `第 ${order} 题没有出处，无法「点回原文」`,
        });
      }

      // 题干重复：同样的题出现两次，刷起来会疑惑
      const normalized = q.prompt.trim().replace(/\s+/g, '');
      const prev = seenPrompts.get(normalized);
      if (prev !== undefined) {
        issues.push({
          questionId: q.id,
          order,
          severity: 'warning',
          code: 'duplicate-prompt',
          message: `第 ${order} 题与第 ${prev} 题题干重复`,
        });
      } else {
        seenPrompts.set(normalized, order);
      }
    });

    return issues;
  }

  /** 对已存在的习题集重跑校验（编辑题目后调用） */
  async revalidate(deckId: string): Promise<{ issues: QuestionIssue[]; blocking: number }> {
    const questions = await this.getQuestions(deckId);
    const issues = this.validateQuestions(questions);
    const blocking = issues.filter((i) => i.severity === 'blocking').length;

    const deck = await this.storage.get('decks', deckId);
    if (deck) {
      await this.storage.put('decks', {
        ...deck,
        blockingIssues: blocking,
        questionCount: questions.length,
        updatedAt: nowIso(),
      });
    }

    return { issues, blocking };
  }

  /**
   * 发布。
   *
   * 有 blocking 问题一律拒绝 —— 这是计划书「发布时逐题再校验一遍」的落点。
   * 有 warning 时允许发布，但要显式确认（由界面负责二次确认）。
   */
  async publish(deckId: string, opts: { allowWarnings?: boolean } = {}): Promise<{
    deck: Deck;
    issues: QuestionIssue[];
  }> {
    const deck = await this.storage.get('decks', deckId);
    if (!deck) throw new Error('习题集不存在');

    const questions = await this.getQuestions(deckId);
    if (questions.length === 0) {
      throw new Error('这个习题集还没有题目，无法发布');
    }

    const issues = this.validateQuestions(questions);
    const blocking = issues.filter((i) => i.severity === 'blocking');

    if (blocking.length > 0) {
      throw new Error(
        `有 ${blocking.length} 个问题必须先修好才能发布：${blocking
          .slice(0, 3)
          .map((i) => i.message)
          .join('；')}${blocking.length > 3 ? '…' : ''}`,
      );
    }

    const warnings = issues.filter((i) => i.severity === 'warning');
    if (warnings.length > 0 && !opts.allowWarnings) {
      throw new Error(
        `还有 ${warnings.length} 条提醒（不影响刷题，但建议看一眼）：${warnings
          .slice(0, 3)
          .map((i) => i.message)
          .join('；')}`,
      );
    }

    const ts = nowIso();
    const published: Deck = {
      ...deck,
      status: 'published',
      blockingIssues: 0,
      publishedAt: ts,
      updatedAt: ts,
    };
    await this.storage.put('decks', published);

    return { deck: published, issues };
  }

  /**
   * 改习题集的基本信息（标题、归属课程）。
   *
   * 为什么需要它：题集标题默认是「资料名 · 练习」这种自动后缀，
   * 用户几乎一定想改成「第二章 线性表 专项」之类。
   * 而没有这个方法时，界面上那个「改名」按钮只能撤掉 ——
   * 一个点了必然报错的按钮比没有更糟。
   */
  async updateDeck(
    deckId: string,
    patch: { title?: string; courseId?: string | null },
  ): Promise<Deck | null> {
    const deck = await this.storage.get('decks', deckId);
    if (!deck) return null;

    const next: Deck = {
      ...deck,
      title: patch.title?.trim() || deck.title,
      courseId: patch.courseId !== undefined ? patch.courseId : deck.courseId,
      updatedAt: nowIso(),
    };
    await this.storage.put('decks', next);
    return next;
  }

  /** 改回草稿（已发布的题改了之后应当回到草稿，避免学生刷到半成品） */
  async unpublish(deckId: string): Promise<Deck | null> {
    const deck = await this.storage.get('decks', deckId);
    if (!deck) return null;
    const next: Deck = { ...deck, status: 'draft', updatedAt: nowIso() };
    await this.storage.put('decks', next);
    return next;
  }

  async updateQuestion(
    id: string,
    patch: Partial<Pick<Question, 'prompt' | 'answer' | 'explanation' | 'options' | 'kind'>>,
  ): Promise<Question | null> {
    const existing = await this.storage.get('questions', id);
    if (!existing) return null;

    const next: Question = { ...existing, ...patch, updatedAt: nowIso() };
    await this.storage.put('questions', next);

    // 改了题就重跑校验，让 blockingIssues 立即反映真实状态
    await this.revalidate(existing.deckId);
    return next;
  }

  async removeQuestion(id: string): Promise<void> {
    const existing = await this.storage.get('questions', id);
    if (!existing) return;
    await this.storage.remove('questions', id);
    // 删题也要把它的作答记录清掉，否则错题本里会出现指向不存在题目的记录
    const records = await this.storage.getAll('answerRecords');
    for (const r of records.filter((r) => r.questionId === id)) {
      await this.storage.remove('answerRecords', r.id);
    }
    await this.revalidate(existing.deckId);
  }

  /** 删除整个习题集（含题目与作答记录） */
  async removeDeck(deckId: string): Promise<void> {
    const questions = await this.getQuestions(deckId);
    for (const q of questions) {
      await this.storage.remove('questions', q.id);
    }
    const records = await this.storage.getAll('answerRecords');
    for (const r of records.filter((r) => r.deckId === deckId)) {
      await this.storage.remove('answerRecords', r.id);
    }
    await this.storage.remove('decks', deckId);
  }

  // -------------------------------------------------------------------------
  // 作答与错题
  // -------------------------------------------------------------------------

  /**
   * 判分。
   *
   * 客观题（单选/多选/填空）由程序判定；问答题返回 null 表示「需自评」。
   * 选择题的比较对**顺序不敏感**：'A,C' 与 'C,A' 都算对，
   * 因为多选的选项顺序不该影响对错。
   */
  gradeAnswer(question: Question, response: string): boolean | null {
    const normalized = response.trim();

    switch (question.kind) {
      case 'single': {
        return normalized.toUpperCase() === question.answer.trim().toUpperCase();
      }
      case 'multiple': {
        const keySet = (s: string) =>
          s
            .split(',')
            .map((k) => k.trim().toUpperCase())
            .filter(Boolean)
            .sort()
            .join(',');
        return keySet(normalized) === keySet(question.answer);
      }
      case 'truefalse': {
        /*
         * 判断题：答案是 'T' 或 'F'。
         *
         * 宽容一点：也接受 '对'/'错'/'true'/'false'，因为导入的题组
         * 可能来自别处、用别的写法。比较前统一大写。
         */
        const truthy = (s: string) => {
          const v = s.trim().toUpperCase();
          if (v === 'T' || v === 'TRUE' || v === '对' || v === '正确') return 'T';
          if (v === 'F' || v === 'FALSE' || v === '错' || v === '错误') return 'F';
          return v;
        };
        return truthy(normalized) === truthy(question.answer);
      }
      case 'blank': {
        // 填空：忽略大小写、全半角空格、首尾标点。
        // 学生手打的答案常带多余空格或句号，不该因此判错。
        return normalizeBlank(normalized) === normalizeBlank(question.answer);
      }
      case 'essay':
        // 问答没法自动判分，交给用户自评
        return null;
    }
  }

  /** 提交一次作答，写入记录 */
  async submitAnswer(input: {
    questionId: string;
    response: string;
    /** 问答类型由用户自评的对错；客观题忽略此字段 */
    selfGrade?: boolean | null;
    elapsedMs?: number | null;
  }): Promise<{ record: AnswerRecord; correct: boolean | null }> {
    const question = await this.storage.get('questions', input.questionId);
    if (!question) throw new Error('题目不存在，可能刚被删除');

    const auto = this.gradeAnswer(question, input.response);
    // 问答类型（auto === null）才采用自评结果
    const correct = auto === null ? (input.selfGrade ?? null) : auto;

    const record: AnswerRecord = {
      id: newId('ans'),
      questionId: question.id,
      deckId: question.deckId,
      response: input.response,
      correct,
      elapsedMs: input.elapsedMs ?? null,
      answeredAt: nowIso(),
      sequence: await this.nextSequence(),
    };
    await this.storage.put('answerRecords', record);

    return { record, correct };
  }

  /**
   * 错题本。
   *
   * 「错题」的定义：这道题**最近一次**作答是错的。
   * 用最近一次而不是「曾经错过」：学生改对了之后不该继续躺在错题本里，
   * 否则错题本只会越来越长，失去意义。
   */
  async getWrongQuestions(filter: {
    deckId?: string;
    keyword?: string;
    onlyUnmastered?: boolean;
  } = {}): Promise<{ question: Question; lastRecord: AnswerRecord; wrongCount: number }[]> {
    const [questions, records] = await Promise.all([
      this.storage.getAll('questions'),
      this.storage.getAll('answerRecords'),
    ]);

    // questionId → 该题的记录（按时间升序）
    const byQuestion = new Map<string, AnswerRecord[]>();
    for (const r of records) {
      const list = byQuestion.get(r.questionId) ?? [];
      list.push(r);
      byQuestion.set(r.questionId, list);
    }
    for (const list of byQuestion.values()) {
      // 用 sequence 排序，不用时间戳：同一毫秒内的两次提交时间戳相同，
      // 排不出先后，而错题归集正依赖「最近一次」这个顺序
      list.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    }

    const out: { question: Question; lastRecord: AnswerRecord; wrongCount: number }[] = [];

    for (const q of questions) {
      const list = byQuestion.get(q.id);
      if (!list || list.length === 0) continue;

      const last = list[list.length - 1];
      // 最近一次答对了 → 不算错题
      if (last.correct !== false) continue;

      if (filter.deckId && q.deckId !== filter.deckId) continue;

      if (filter.keyword) {
        const kw = filter.keyword.trim().toLowerCase();
        if (
          kw &&
          !q.prompt.toLowerCase().includes(kw) &&
          !(q.topic ?? '').toLowerCase().includes(kw)
        ) {
          continue;
        }
      }

      const wrongCount = list.filter((r) => r.correct === false).length;
      out.push({ question: q, lastRecord: last, wrongCount });
    }

    return out.sort((a, b) => b.wrongCount - a.wrongCount);
  }

  /** 某题的作答历史，用于「这道题我做过几次」 */
  async getHistory(questionId: string): Promise<AnswerRecord[]> {
    const all = await this.storage.getAll('answerRecords');
    return all
      .filter((r) => r.questionId === questionId)
      .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
  }

  /** 统计：某习题集的完成度与正确率 */
  async getStats(deckId: string): Promise<{
    total: number;
    answered: number;
    correct: number;
    accuracy: number | null;
  }> {
    const questions = await this.getQuestions(deckId);
    const records = (await this.storage.getAll('answerRecords')).filter(
      (r) => r.deckId === deckId,
    );

    // 每题取最近一次
    const latest = new Map<string, AnswerRecord>();
    for (const r of records) {
      const prev = latest.get(r.questionId);
      if (!prev || (r.sequence ?? 0) > (prev.sequence ?? 0)) {
        latest.set(r.questionId, r);
      }
    }

    const answered = latest.size;
    const correct = [...latest.values()].filter((r) => r.correct === true).length;

    return {
      total: questions.length,
      answered,
      correct,
      accuracy: answered > 0 ? correct / answered : null,
    };
  }

  // -------------------------------------------------------------------------
  // 导出（计划书 P3 第 7 条）
  // -------------------------------------------------------------------------

  /**
   * 导出为 Markdown 文本。
   *
   * 由服务层统一出口，而不是让每个界面各写一遍：
   * 导出内容的格式属于产品行为，不属于某个页面的渲染细节。
   */
  async exportMarkdown(
    deckId: string,
    options?: Partial<ExportOptions>,
  ): Promise<{ content: string; fileName: string }> {
    const deck = await this.storage.get('decks', deckId);
    if (!deck) throw new Error('习题集不存在');

    const questions = await this.getQuestions(deckId);
    if (questions.length === 0) {
      throw new Error('这个习题集还没有题目，没有可导出的内容');
    }

    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };
    return {
      content: exportToMarkdown(deck, questions, opts),
      fileName: exportFileName(deck, 'md'),
    };
  }

  /**
   * 导入 JSON 题组。
   *
   * ## 为什么要经过这一层，而不是让界面直接写库
   *
   * 导入要做三件界面不该管的事：
   *  1. 解析与校验（`parseDeckJson`，会给第几题错）
   *  2. 生成 id、接上 deckId、算 order
   *  3. 落库（decks + questions 两张表，必须在同一个流程里完成）
   *
   * 第 3 点尤其重要：写了一半失败会留下「有题组没题」或「有题没题组」的
   * 半截数据。所以先把所有 Question 在内存里建好，再一次性写。
   *
   * ## 默认落成草稿
   *
   * 与「AI 出题」一致：导入的题也要人工检查后才发布。
   * 别的软件导出的题可能有格式问题（答案不在选项里、题干为空），
   * 直接进复习等于绕过那道关。
   */
  async importJson(
    text: string,
    options: { title?: string; publishImmediately?: boolean } = {},
  ): Promise<{ deck: Deck; questions: Question[]; parsed: ParsedImport }> {
    const parsed = parseDeckJson(text);
    const ts = nowIso();
    const deckId = newId('deck');

    /*
     * 先全部建好再写。
     *
     * 顺序很关键：如果先写 deck 再逐题写 questions，
     * 中间某题抛错就会留下一个空题组 —— 用户看到「有题组 0 道题」，
     * 不知道是自己导错了还是软件坏了。
     */
    const questions: Question[] = parsed.questions.map((q, i) => ({
      id: newId('q'),
      deckId,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      /* 导入的题没有 anchors：出处来自原文件的锚点，外部 JSON 里没有可信位置 */
      anchors: [],
      knowledgePointId: null,
      cognitiveLevel: q.cognitiveLevel,
      topic: q.topic,
      order: i + 1,
      createdAt: ts,
      updatedAt: ts,
    }));

    const nowPublished = options.publishImmediately === true;
    const deck: Deck = {
      id: deckId,
      title: (options.title?.trim() || parsed.title).slice(0, 200),
      courseId: null,
      status: nowPublished ? 'published' : 'draft',
      sourceId: null,
      backendId: null,
      kinds: [...new Set(questions.map((q) => q.kind))],
      questionCount: questions.length,
      blockingIssues: 0,
      publishedAt: nowPublished ? ts : null,
      createdAt: ts,
      updatedAt: ts,
    };

    await this.storage.put('decks', deck);
    for (const q of questions) await this.storage.put('questions', q);

    return { deck, questions, parsed };
  }

  /** 导出为 JSON 文本 */
  async exportJson(
    deckId: string,
    options?: Partial<ExportOptions>,
  ): Promise<{ content: string; fileName: string }> {
    const deck = await this.storage.get('decks', deckId);
    if (!deck) throw new Error('习题集不存在');

    const questions = await this.getQuestions(deckId);
    if (questions.length === 0) {
      throw new Error('这个习题集还没有题目，没有可导出的内容');
    }

    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };
    return {
      content: exportToJson(deck, questions, opts),
      fileName: exportFileName(deck, 'json'),
    };
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 填空答案归一化：去空白、去首尾标点、统一大小写 */
function normalizeBlank(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/^[，。；：、,. ;:]+|[，。；：、,. ;:]+$/g, '')
    .toLowerCase();
}

export type { QuestionKind, SourceLocation };
