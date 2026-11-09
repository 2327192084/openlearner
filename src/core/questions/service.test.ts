import { describe, expect, it, beforeEach } from 'vitest';
import { DeckService } from './service.ts';
import { MockQuestionBackend } from './mock-backend.ts';
import { segmentsToMaterials } from './materials.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { newId, nowIso } from '../id.ts';
import type { KnowledgePoint, Question } from '../model.ts';
import type { QuestionDraft, QuestionSourcePoint } from './backend-types.ts';

/**
 * 习题集服务测试。
 *
 * 对应计划书 P3「算做完」：
 *  - 生成 20 道题，题题有答案、有解析、有能点通的出处
 *  - 答对答错的记录正确进入错题归集，重做后状态更新
 *  - 抽查 5 道题：答案确实被原文支撑
 *  - 发布时逐题再校验一遍
 */

function makePoint(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  const ts = nowIso();
  return {
    id: newId('kp'),
    statement: '线性表是由 n 个数据元素构成的有限序列',
    chapter: '第二章 线性表',
    cognitiveLevel: 'remember',
    tags: [],
    anchors: [
      { sourceId: 'src_1', page: 2, chapter: '第二章 线性表', charStart: 10, charEnd: 40 },
    ],
    quotes: ['线性表是由 n 个数据元素构成的有限序列，n 称为表长。'],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: 'src_1',
    backendId: 'mock',
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

let storage: MemoryStorage;
let decks: DeckService;

beforeEach(() => {
  storage = new MemoryStorage();
  decks = new DeckService(storage);
});

const backend = () => new MockQuestionBackend(0);

describe('出题', () => {
  it('能从知识点生成题目，且每道题都有答案与出处', async () => {
    const points = [
      makePoint({ statement: '线性表是由 n 个数据元素构成的有限序列' }),
      makePoint({
        statement: '顺序表用一段地址连续的存储单元依次存放元素',
        quotes: ['顺序表用一段地址连续的存储单元依次存放元素，支持随机访问。'],
        anchors: [{ sourceId: 'src_1', page: 2, charStart: 100, charEnd: 140 }],
      }),
      makePoint({
        statement: '链表通过指针连接结点',
        quotes: ['链表通过指针连接结点，插入与删除不需要移动元素。'],
        anchors: [{ sourceId: 'src_1', page: 3, charStart: 20, charEnd: 60 }],
      }),
    ];

    const out = await decks.generate({
      points,
      title: '线性表练习',
      backend: backend(),
      options: { kinds: ['single', 'blank'], count: 6, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    expect(out.questions.length).toBeGreaterThan(0);
    expect(out.deck.status).toBe('draft');

    for (const q of out.questions) {
      expect(q.answer.trim().length).toBeGreaterThan(0);
      expect(q.explanation.trim().length).toBeGreaterThan(0);
      // P3 核心：题题有出处
      expect(q.anchors.length).toBeGreaterThan(0);
    }
  });

  /**
   * 这是整个 P3 里最重要的一条断言。
   *
   * 题目的 anchors 必须**逐字段等于**它依据的知识点的 anchors。
   * 如果哪天有人改成「让模型自己给出处」，这里会立刻变红。
   */
  it('**题目的出处逐字段继承自知识点（不让模型重新给）**', async () => {
    const point = makePoint({
      statement: '栈是只允许在一端进行插入和删除的线性表',
      anchors: [
        { sourceId: 'src_9', page: 7, chapter: '第三章', charStart: 55, charEnd: 99 },
      ],
      quotes: ['栈是只允许在一端进行插入和删除的线性表，遵循后进先出原则。'],
    });

    const out = await decks.generate({
      points: [point],
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const q = out.questions[0];
    expect(q.knowledgePointId).toBe(point.id);
    /*
     * 2026-11-09 改：锚点除了继承位置，还会补一个 quote（知识点自带的引文），
     * 用于精确定位那一句话。所以断言「位置逐字段一致」而不是整对象相等。
     *
     * 核心保证没变：**位置来自知识点，不是模型给的**。
     */
    expect(q.anchors[0]).toMatchObject({
      sourceId: 'src_9',
      page: 7,
      chapter: '第三章',
      charStart: 55,
      charEnd: 99,
    });
    // 引文是新增的附加信息，不改变位置
    expect(q.anchors[0].quote).toBe('栈是只允许在一端进行插入和删除的线性表，遵循后进先出原则。');
    // 页码必须一致 —— 这是「点回原文」可靠的根据
    expect(q.anchors[0].page).toBe(7);
  });

  it('从原文出题的题，knowledgePointId 是 null（不塞段落 id 冒充知识点 id）', async () => {
    /*
     * 真实 bug 的回归测试（2026-11-09 修）。
     *
     * 原实现无条件写 `knowledgePointId: material.id`，而原文出题的
     * 素材 id 是**段落 id**（seg_ 开头）。结果题目里这个字段指向一个
     * 不存在的知识点 —— 实测用户库里 10 道题 0 命中，链断了。
     *
     * 类型都是 string，这个 bug 单测和 tsc 都抓不到，只能靠真实数据对 id。
     */
    const seg = {
      id: 'seg_abc123',
      sourceId: 'src_1',
      index: 1,
      page: 4,
      chapter: '第一章',
      text: '这是一段足够长的原文正文，用来测试从原文出题的锚点继承与知识点归属判定是否正确。',
      charCount: 43,
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    } as never;

    /* 走真实链路：段落 → 素材（与 GeneratePage 的做法一致） */
    const materials = segmentsToMaterials([seg]);

    const out = await decks.generate({
      /* 原文出题不经过知识点，但仍要满足入参形状 */
      points: [],
      materials,
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const q = out.questions[0];
    expect(q.knowledgePointId).toBeNull();
    /* 位置仍然要有，否则点了回不去 */
    expect(q.anchors[0].page).toBe(4);
    /* 新题会带上段落 id，用于硬定位 */
    expect(q.anchors[0].segmentId).toBe('seg_abc123');
  });

  it('认知层级从知识点继承', async () => {
    const point = makePoint({ cognitiveLevel: 'analyze' });
    const out = await decks.generate({
      points: [point],
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    expect(out.questions[0].cognitiveLevel).toBe('analyze');
  });

  it('没有已定位的知识点时明确拒绝并说明原因', async () => {
    const unlocated = makePoint({ anchors: [], anchorStatus: 'unlocated' });

    await expect(
      decks.generate({
        points: [unlocated],
        title: 't',
        backend: backend(),
        options: { kinds: ['single'], count: 3, levels: null, language: 'zh' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/没有定位到原文位置/);
  });

  it('完全没有知识点时给出可操作提示', async () => {
    await expect(
      decks.generate({
        points: [],
        title: 't',
        backend: backend(),
        options: { kinds: ['single'], count: 3, levels: null, language: 'zh' },
        signal: new AbortController().signal,
      }),
    /*
     * 断言「指向真实入口」。
     *
     * 文案变了（现在有两条出题路径：从知识库、从原文字），但约束没变：
     * 报错必须告诉用户去**真实存在**的地方，且不能出现「知识点」页
     * 这种不存在的页名（v2 里叫「整理知识点」）。
     */
    ).rejects.toThrow(/整理知识点/);
  });

  /*
   * 两条用户可见的报错都**不能指向不存在的页面**。
   *
   * 这是本项目的一条硬约束（交接文档「几条不能碰的约束」第 4 条：
   * 说「去 X 页面做 Y」前先确认 X 真有 Y 入口）。曾经这两句分别写着
   * 「知识点」页和「校对页」，而 v2 里前者叫「整理知识点」、后者根本不存在。
   * 用户照着做会找不到地方。这条测试把这件事钉住。
   */
  it('报错文案不指向不存在的页面', async () => {
    const messages: string[] = [];

    // ① 完全没有知识点
    try {
      await decks.generate({
        points: [],
        title: 't',
        backend: backend(),
        options: { kinds: ['single'], count: 3, levels: null, language: 'zh' },
        signal: new AbortController().signal,
      });
    } catch (err) {
      messages.push(err instanceof Error ? err.message : String(err));
    }

    // ② 有知识点但都没定位
    try {
      await decks.generate({
        points: [makePoint({ anchors: [], anchorStatus: 'unlocated' })],
        title: 't',
        backend: backend(),
        options: { kinds: ['single'], count: 3, levels: null, language: 'zh' },
        signal: new AbortController().signal,
      });
    } catch (err) {
      messages.push(err instanceof Error ? err.message : String(err));
    }

    expect(messages.length).toBe(2);
    for (const m of messages) {
      // 「校对页」在 v2 里不存在
      expect(m).not.toContain('校对页');
      // 「知识点」页不存在；只有「整理知识点」这一页
      expect(m).not.toMatch(/「知识点」/);
      // 反过来，必须指向真实存在的页
      expect(m).toContain('整理知识点');
    }
  });

  it('中途停止时已产出的题目保留', async () => {
    const points = [
      makePoint({ statement: '线性表是由数据元素构成的有限序列' }),
      makePoint({ statement: '顺序表用连续存储单元存放元素' }),
      makePoint({ statement: '链表通过指针连接各个结点' }),
    ];
    const controller = new AbortController();

    const out = await decks.generate({
      points,
      title: 't',
      backend: new MockQuestionBackend(20),
      options: { kinds: ['blank'], count: 12, levels: null, language: 'zh' },
      signal: controller.signal,
      onProgress: (p) => {
        if (p.produced >= 2) controller.abort();
      },
    });

    expect(out.stopped).toBe(true);
    // 停止前产出的必须在库里
    const stored = await decks.getQuestions(out.deck.id);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBe(out.questions.length);
  });

  it('记录实际用量', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    expect(out.actualTokens).toBeGreaterThan(0);
  });
});

describe('发布前逐题校验（计划书 P3 第 2 条）', () => {
  function makeQuestion(over: Partial<Question> = {}): Question {
    return {
      id: newId('q'),
      deckId: 'd1',
      kind: 'single',
      prompt: '线性表的定义是什么？',
      options: [
        { key: 'A', text: '有限序列' },
        { key: 'B', text: '无限序列' },
        { key: 'C', text: '树结构' },
      ],
      answer: 'A',
      explanation: '线性表是有限序列。',
      anchors: [{ sourceId: 's', page: 2, charStart: 0, charEnd: 10 }],
      knowledgePointId: 'kp1',
      cognitiveLevel: 'remember',
      topic: null,
      order: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...over,
    };
  }

  it('合格的题目没有任何 blocking 问题', () => {
    const issues = decks.validateQuestions([makeQuestion()]);
    expect(issues.filter((i) => i.severity === 'blocking')).toHaveLength(0);
  });

  it('缺答案 → blocking', () => {
    const issues = decks.validateQuestions([makeQuestion({ answer: '   ' })]);
    const blocking = issues.filter((i) => i.severity === 'blocking');
    expect(blocking.some((i) => i.code === 'missing-answer')).toBe(true);
  });

  it('答案键不在选项里 → blocking（这是最危险的一类错误）', () => {
    const issues = decks.validateQuestions([makeQuestion({ answer: 'D' })]);
    const blocking = issues.filter((i) => i.severity === 'blocking');
    expect(blocking.some((i) => i.code === 'invalid-answer-key')).toBe(true);
    // 提示要具体到第几题、答案是什么、选项有什么
    expect(blocking[0].message).toMatch(/第 1 题/);
    expect(blocking[0].message).toMatch(/D/);
  });

  it('单选题给了多个正确答案 → blocking', () => {
    const issues = decks.validateQuestions([makeQuestion({ answer: 'A,C' })]);
    expect(issues.some((i) => i.code === 'invalid-answer-key' && i.severity === 'blocking')).toBe(
      true,
    );
  });

  it('选择题选项少于 2 个 → blocking', () => {
    const issues = decks.validateQuestions([
      makeQuestion({ options: [{ key: 'A', text: '只有一项' }] }),
    ]);
    expect(issues.some((i) => i.code === 'missing-options')).toBe(true);
  });

  it('多选题两个答案都有效 → 不算 blocking', () => {
    const issues = decks.validateQuestions([
      makeQuestion({ kind: 'multiple', answer: 'A,C' }),
    ]);
    expect(issues.filter((i) => i.severity === 'blocking')).toHaveLength(0);
  });

  it('缺解析 → 只是 warning，不拦发布', () => {
    const issues = decks.validateQuestions([makeQuestion({ explanation: '' })]);
    const issue = issues.find((i) => i.code === 'missing-explanation');
    expect(issue?.severity).toBe('warning');
  });

  it('缺出处 → 只是 warning（允许先刷着，回头补）', () => {
    const issues = decks.validateQuestions([makeQuestion({ anchors: [] })]);
    const issue = issues.find((i) => i.code === 'missing-anchors');
    expect(issue?.severity).toBe('warning');
  });

  it('题干重复 → warning 并指出与第几题重复', () => {
    const a = makeQuestion({ order: 0 });
    const b = makeQuestion({ order: 1, prompt: a.prompt });
    const issues = decks.validateQuestions([a, b]);
    const dup = issues.find((i) => i.code === 'duplicate-prompt');
    expect(dup).toBeDefined();
    expect(dup!.message).toMatch(/第 2 题与第 1 题/);
  });
});

describe('发布流程', () => {
  async function makeDeckWithQuestions(n = 3) {
    const points = [
      makePoint({ statement: '线性表是由数据元素构成的有限序列' }),
      makePoint({ statement: '顺序表用连续存储单元存放元素' }),
      makePoint({ statement: '链表通过指针连接结点' }),
    ];
    const out = await decks.generate({
      points,
      title: '待发布',
      backend: backend(),
      options: { kinds: ['blank'], count: n, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    return out;
  }

  it('有 blocking 问题时拒绝发布，并说明具体原因', async () => {
    const out = await makeDeckWithQuestions();
    // 人为破坏一道题：把答案改成不存在的选项
    const q = out.questions[0];
    await decks.updateQuestion(q.id, { kind: 'single', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], answer: 'Z' });

    await expect(decks.publish(out.deck.id)).rejects.toThrow(/必须先修好/);
  });

  it('合格时能发布，状态变 published', async () => {
    const out = await makeDeckWithQuestions();
    const { deck } = await decks.publish(out.deck.id, { allowWarnings: true });

    expect(deck.status).toBe('published');
    expect(deck.publishedAt).toBeTruthy();
    expect(deck.blockingIssues).toBe(0);
  });

  it('有 warning 时不带 allowWarnings 会被拦，带上才放行', async () => {
    const out = await makeDeckWithQuestions();
    // 制造一个 warning：删掉解析
    await decks.updateQuestion(out.questions[0].id, { explanation: '' });

    await expect(decks.publish(out.deck.id)).rejects.toThrow(/提醒/);
    const { deck } = await decks.publish(out.deck.id, { allowWarnings: true });
    expect(deck.status).toBe('published');
  });

  it('空习题集不能发布', async () => {
    const ts = nowIso();
    await storage.put('decks', {
      id: 'empty',
      title: '空',
      courseId: null,
      status: 'draft',
      sourceId: null,
      backendId: null,
      questionCount: 0,
      blockingIssues: 0,
      publishedAt: null,
      createdAt: ts,
      updatedAt: ts,
    });

    await expect(decks.publish('empty')).rejects.toThrow(/还没有题目/);
  });

  it('改回草稿', async () => {
    const out = await makeDeckWithQuestions();
    await decks.publish(out.deck.id, { allowWarnings: true });
    const draft = await decks.unpublish(out.deck.id);
    expect(draft?.status).toBe('draft');
  });
});

describe('判分', () => {
  function q(over: Partial<Question>): Question {
    return {
      id: 'q1',
      deckId: 'd',
      kind: 'single',
      prompt: 'p',
      options: [
        { key: 'A', text: 'a' },
        { key: 'B', text: 'b' },
      ],
      answer: 'A',
      explanation: 'e',
      anchors: [],
      knowledgePointId: null,
      cognitiveLevel: 'remember',
      topic: null,
      order: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...over,
    };
  }

  it('单选：大小写不敏感', () => {
    expect(decks.gradeAnswer(q({}), 'a')).toBe(true);
    expect(decks.gradeAnswer(q({}), 'B')).toBe(false);
  });

  it('多选：顺序不影响对错', () => {
    const m = q({ kind: 'multiple', answer: 'A,C' });
    expect(decks.gradeAnswer(m, 'C,A')).toBe(true);
    expect(decks.gradeAnswer(m, 'A')).toBe(false);
    expect(decks.gradeAnswer(m, 'A,B')).toBe(false);
  });

  it('填空：忽略空格与首尾标点', () => {
    const b = q({ kind: 'blank', answer: '线性表' });
    expect(decks.gradeAnswer(b, ' 线性表 ')).toBe(true);
    expect(decks.gradeAnswer(b, '线性表。')).toBe(true);
    expect(decks.gradeAnswer(b, '顺序表')).toBe(false);
  });

  it('问答：返回 null（需自评）', () => {
    expect(decks.gradeAnswer(q({ kind: 'essay' }), '随便写点什么')).toBeNull();
  });
});

describe('作答与错题归集', () => {
  /** 造一个已发布的习题集，含 2 道填空 */
  async function setup() {
    const points = [
      makePoint({ statement: '线性表是由数据元素构成的有限序列' }),
      makePoint({ statement: '顺序表用连续存储单元存放元素' }),
    ];
    const out = await decks.generate({
      points,
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    await decks.publish(out.deck.id, { allowWarnings: true });
    return out;
  }

  it('答错的题进入错题本', async () => {
    const out = await setup();
    const q = out.questions[0];

    await decks.submitAnswer({ questionId: q.id, response: '故意写错' });

    const wrong = await decks.getWrongQuestions();
    expect(wrong).toHaveLength(1);
    expect(wrong[0].question.id).toBe(q.id);
    expect(wrong[0].wrongCount).toBe(1);
  });

  it('答对的题不进错题本', async () => {
    const out = await setup();
    const q = out.questions[0];

    await decks.submitAnswer({ questionId: q.id, response: q.answer });
    expect(await decks.getWrongQuestions()).toHaveLength(0);
  });

  it('答错后重做对了，从错题本移除（状态更新）', async () => {
    const out = await setup();
    const q = out.questions[0];

    await decks.submitAnswer({ questionId: q.id, response: '错' });
    expect(await decks.getWrongQuestions()).toHaveLength(1);

    await decks.submitAnswer({ questionId: q.id, response: q.answer });
    // 关键：最近一次答对了，就不该继续躺在错题本
    expect(await decks.getWrongQuestions()).toHaveLength(0);
  });

  it('答对后再答错，重新回到错题本', async () => {
    const out = await setup();
    const q = out.questions[0];

    await decks.submitAnswer({ questionId: q.id, response: q.answer });
    await decks.submitAnswer({ questionId: q.id, response: '又错了' });
    expect(await decks.getWrongQuestions()).toHaveLength(1);
  });

  it('按关键词筛选错题', async () => {
    const out = await setup();
    for (const q of out.questions) {
      await decks.submitAnswer({ questionId: q.id, response: '错' });
    }
    expect(await decks.getWrongQuestions()).toHaveLength(2);

    const filtered = await decks.getWrongQuestions({ keyword: out.questions[0].prompt.slice(0, 4) });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('按习题集筛选错题', async () => {
    const out = await setup();
    await decks.submitAnswer({ questionId: out.questions[0].id, response: '错' });

    expect(await decks.getWrongQuestions({ deckId: out.deck.id })).toHaveLength(1);
    expect(await decks.getWrongQuestions({ deckId: '别的' })).toHaveLength(0);
  });

  it('错题按错误次数排序', async () => {
    const out = await setup();
    const [a, b] = out.questions;
    await decks.submitAnswer({ questionId: a.id, response: '错' });
    await decks.submitAnswer({ questionId: b.id, response: '错' });
    await decks.submitAnswer({ questionId: b.id, response: '又错' });

    const wrong = await decks.getWrongQuestions();
    expect(wrong[0].question.id).toBe(b.id);
    expect(wrong[0].wrongCount).toBe(2);
  });

  it('作答历史按时间倒序', async () => {
    const out = await setup();
    const q = out.questions[0];
    await decks.submitAnswer({ questionId: q.id, response: '错' });
    await decks.submitAnswer({ questionId: q.id, response: q.answer });

    const history = await decks.getHistory(q.id);
    expect(history).toHaveLength(2);
    // 最新的（答对的那次）在前
    expect(history[0].correct).toBe(true);
  });

  it('统计：完成度与正确率', async () => {
    const out = await setup();
    const [a, b] = out.questions;

    await decks.submitAnswer({ questionId: a.id, response: a.answer }); // 对
    await decks.submitAnswer({ questionId: b.id, response: '错' }); // 错

    const stats = await decks.getStats(out.deck.id);
    expect(stats.total).toBe(2);
    expect(stats.answered).toBe(2);
    expect(stats.correct).toBe(1);
    expect(stats.accuracy).toBe(0.5);
  });

  it('统计里同一题答多次只算最近一次', async () => {
    const out = await setup();
    const q = out.questions[0];

    await decks.submitAnswer({ questionId: q.id, response: '错' });
    await decks.submitAnswer({ questionId: q.id, response: q.answer });

    const stats = await decks.getStats(out.deck.id);
    expect(stats.answered).toBe(1);
    expect(stats.correct).toBe(1);
  });
});

describe('删除的级联清理', () => {
  it('删题会一并删掉它的作答记录（否则错题本指向不存在的题）', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    const q = out.questions[0];
    await decks.submitAnswer({ questionId: q.id, response: '错' });
    expect(await storage.getAll('answerRecords')).toHaveLength(1);

    await decks.removeQuestion(q.id);

    expect(await storage.getAll('answerRecords')).toHaveLength(0);
    expect(await decks.getWrongQuestions()).toHaveLength(0);
  });

  it('删习题集会删掉题目与作答记录', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: 't',
      backend: backend(),
      options: { kinds: ['blank'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    await decks.submitAnswer({ questionId: out.questions[0].id, response: '错' });

    await decks.removeDeck(out.deck.id);

    expect(await decks.get(out.deck.id)).toBeNull();
    expect(await storage.getAll('questions')).toHaveLength(0);
    expect(await storage.getAll('answerRecords')).toHaveLength(0);
  });
});

describe('示例后端的题目质量（诚实性）', () => {
  it('每道题都能通过 blocking 校验', async () => {
    const points = [
      makePoint({ statement: '线性表是由数据元素构成的有限序列' }),
      makePoint({ statement: '顺序表用连续存储单元存放元素' }),
      makePoint({ statement: '链表通过指针连接结点' }),
    ];
    const out = await decks.generate({
      points,
      title: 't',
      backend: backend(),
      options: {
        kinds: ['single', 'multiple', 'blank', 'essay'],
        count: 8,
        levels: null,
        language: 'zh',
      },
      signal: new AbortController().signal,
    });

    const issues = decks.validateQuestions(out.questions);
    const blocking = issues.filter((i) => i.severity === 'blocking');
    // 示例后端出的题不该出现「答案不在选项里」这种硬伤
    expect(blocking).toEqual([]);
  });

  it('题干不会与知识点表述一模一样（至少做了挖空/改造）', async () => {
    const points = [makePoint({ statement: '线性表是由数据元素构成的有限序列' })];
    const out = await decks.generate({
      points,
      title: 't',
      backend: backend(),
      options: { kinds: ['blank', 'single'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    for (const q of out.questions) {
      expect(q.prompt).not.toBe(points[0].statement);
      expect(q.prompt.length).toBeGreaterThan(5);
    }
  });
});

describe('updateDeck：题集改名', () => {
  it('能改标题，其余字段不变', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: '线性表 · 练习',
      backend: backend(),
      options: { kinds: ['blank'], count: 2, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const renamed = await decks.updateDeck(out.deck.id, { title: '第二章 专项' });
    expect(renamed!.title).toBe('第二章 专项');
    // 题数、状态不能被改名弄丢
    expect(renamed!.questionCount).toBe(out.deck.questionCount);
    expect(renamed!.id).toBe(out.deck.id);
  });

  it('标题留空时保留原名', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: '保留我',
      backend: backend(),
      options: { kinds: ['blank'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const same = await decks.updateDeck(out.deck.id, { title: '   ' });
    expect(same!.title).toBe('保留我');
  });

  it('习题集不存在时返回 null 而不是抛错', async () => {
    expect(await decks.updateDeck('不存在', { title: 'x' })).toBeNull();
  });
});

describe('出题失败时保留草稿引用', () => {
  it('后端抛错时，错误对象上带着 deckId，且已产出的题留在库里', async () => {
    const points = [makePoint({ statement: '线性表是由数据元素构成的有限序列' })];

    // 出一个题之后抛错，模拟网络中断
    let producedOnce = false;
    const failingBackend = {
      id: 'failing',
      label: '会失败的',
      isMock: true,
      estimateTokens: () => 100,
      generate: async (
        _p: QuestionSourcePoint[],
        opts: { onDraft?: (d: QuestionDraft) => void | Promise<void> },
      ) => {
        if (!producedOnce) {
          producedOnce = true;
          await opts.onDraft?.({
            kind: 'blank',
            prompt: '第一题',
            options: [],
            answer: points[0].statement,
            explanation: 'e',
            knowledgePointId: points[0].id,
          });
        }
        throw new Error('模拟网络中断');
      },
    };

    const error = await decks
      .generate({
        points,
        title: '会失败的题集',
        backend: failingBackend,
        options: { kinds: ['blank'], count: 5, levels: null, language: 'zh' },
        signal: new AbortController().signal,
      })
      .then(
        () => null,
        (e: unknown) => e as Error & { deckId?: string; producedCount?: number },
      );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/模拟网络中断/);

    // 核心断言：调用方拿得到 deckId，才能准确告诉用户草稿在哪
    expect(error!.deckId).toBeTruthy();
    expect(error!.producedCount).toBe(1);

    // 且草稿真的在库里，已产出的题也在
    const deck = await decks.get(error!.deckId!);
    expect(deck).not.toBeNull();
    expect(deck!.questionCount).toBe(1);
    expect(await decks.getQuestions(error!.deckId!)).toHaveLength(1);
  });
});

describe('校验 code：题干为空与缺答案是两种毛病', () => {
  it('题干为空报 missing-prompt', () => {
    const q: Question = {
      id: 'q1',
      deckId: 'd',
      kind: 'blank',
      prompt: '   ',
      options: [],
      answer: '有答案',
      explanation: 'e',
      anchors: [],
      knowledgePointId: null,
      cognitiveLevel: 'remember',
      topic: null,
      order: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const issues = decks.validateQuestions([q]);
    // 早先两者共用 missing-answer，统计时分不清是哪类问题
    expect(issues.some((i) => i.code === 'missing-prompt')).toBe(true);
    expect(issues.some((i) => i.code === 'missing-answer')).toBe(false);
  });
});

describe('题数超过知识点数时不产生重复题', () => {
  /**
   * 这条来自真实观察：10 条知识点出 20 道题，
   * 界面上发布校验报出 10 条「第 N 题与第 M 题题干重复」。
   *
   * 根因是示例后端用 `candidates[i % length]` 绕圈取知识点，
   * 题数一旦超过知识点数就必然重复。
   */
  it('10 条知识点出 20 道题，题干互不相同', async () => {
    const points = Array.from({ length: 10 }, (_, i) =>
      makePoint({
        id: `kp_${i}`,
        statement: `第${i + 1}条知识点的概念表述内容`,
        quotes: [`第${i + 1}条知识点的原文引用内容。`],
        chapter: `第${i + 1}章`,
        anchors: [{ sourceId: 's', page: i + 1, charStart: 0, charEnd: 20 }],
      }),
    );

    const out = await decks.generate({
      points,
      title: '重复检查',
      backend: backend(),
      options: {
        kinds: ['single', 'multiple', 'blank', 'essay'],
        count: 20,
        levels: null,
        language: 'zh',
      },
      signal: new AbortController().signal,
    });

    const prompts = out.questions.map((q) => q.prompt);
    const unique = new Set(prompts);

    // 关键：不重复
    expect(unique.size).toBe(prompts.length);
    // 且尽量出满（题数不该因为没有变体而大幅缩水）
    expect(out.questions.length).toBeGreaterThanOrEqual(15);

    // 校验结果里不该有题干重复这一类问题
    const issues = decks.validateQuestions(out.questions);
    expect(issues.filter((i) => i.code === 'duplicate-prompt')).toEqual([]);
  });
});
