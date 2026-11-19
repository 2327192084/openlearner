import { describe, expect, it, beforeEach } from 'vitest';
import { DeckService, filterMaterialsByLevel, type GenerateQuestionsOutput } from './service.ts';
import { MockQuestionBackend } from './mock-backend.ts';
import { pointsToMaterials, segmentsToMaterials, type QuestionMaterial } from './materials.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { newId, nowIso } from '../id.ts';
import type { KnowledgePoint, SourceSegment } from '../model.ts';

/**
 * 认知层级筛选（2026-11-19 修的第二个假开关）。
 *
 * ## 修之前是什么样
 *
 * `QuotaPicker` 上有四个认知层级复选框，还写着「只会从这一层的知识点里出题」，
 * `GeneratePage` 也确实把 `levels` 传给了 `service.generate` ——
 * 但**全库只有 mock 后端读它**（`mock-backend.ts:136`）：
 * `service.generate` 不筛素材，出题提示词也不提层级。
 *
 * 也就是说接了真实模型时，勾了「只出 apply 层」没有任何作用，
 * 界面却宣称生效了。这是本项目最忌讳的那类问题（说了没做 / 做了没接上）。
 *
 * ## 为什么在 service 层做
 *
 * 真实后端与 mock 后端走**同一条**筛选路径，不会各写一遍再漂移；
 * 素材本来就带 `cognitiveLevel`，不用改后端契约，也不用改提示词。
 *
 * ## ⚠️ 这些断言对修复前的实现必须失败
 *
 * 修复前 `filterMaterialsByLevel` 不存在，`generate` 会拿全部素材去出题 ——
 * 所以「限定某一层时不该出现别的层」这一条，对旧实现一定不成立。
 * 光断言「能出题」是不够的（旧实现也能出题）。
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

/** 一条最小素材（直接构造，用来单独测纯函数） */
function makeMaterial(
  id: string,
  level: KnowledgePoint['cognitiveLevel'],
): QuestionMaterial {
  return {
    id,
    statement: `素材 ${id}`,
    quotes: [`素材 ${id} 的原文`],
    cognitiveLevel: level,
    chapter: '第一章',
    page: 1,
    anchors: [{ sourceId: 'src_1', page: 1, charStart: 0, charEnd: 10 }],
    origin: 'knowledge',
  };
}

let storage: MemoryStorage;
let decks: DeckService;

beforeEach(() => {
  storage = new MemoryStorage();
  decks = new DeckService(storage);
});

describe('filterMaterialsByLevel：纯函数', () => {
  const materials = [
    makeMaterial('m1', 'remember'),
    makeMaterial('m2', 'understand'),
    makeMaterial('m3', 'apply'),
    makeMaterial('m4', 'apply'),
  ];

  it('没勾层级 → 原样返回，levelFilter 为 null（老调用方行为不变）', () => {
    for (const levels of [null, undefined, [] as KnowledgePoint['cognitiveLevel'][]]) {
      const out = filterMaterialsByLevel(materials, levels);
      expect(out.materials.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(out.levelFilter).toBeNull();
    }
  });

  it('勾了某一层 → 只留那一层的素材，并如实回报用了多少', () => {
    const out = filterMaterialsByLevel(materials, ['apply']);
    expect(out.materials.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(out.levelFilter).toEqual({
      requested: ['apply'],
      used: 2,
      matched: 2,
      fellBack: false,
    });
  });

  it('勾了两层 → 两层都留', () => {
    const out = filterMaterialsByLevel(materials, ['remember', 'apply']);
    expect(out.materials.map((m) => m.id)).toEqual(['m1', 'm3', 'm4']);
    expect(out.levelFilter?.matched).toBe(3);
    expect(out.levelFilter?.fellBack).toBe(false);
  });

  it('**勾的层一条都没有 → 退回全部，但把 fellBack 标出来**（不静默）', () => {
    const out = filterMaterialsByLevel(materials, ['analyze']);
    /* 退回：宁可出难度不对的题，也别一道都出不来 */
    expect(out.materials.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    /* 但必须承认退回过 —— 界面据此提示用户「已退回用全部素材」 */
    expect(out.levelFilter).toEqual({
      requested: ['analyze'],
      used: 4,
      matched: 0,
      fellBack: true,
    });
  });

  it('不修改传入的数组（纯函数）', () => {
    const input = [...materials];
    filterMaterialsByLevel(input, ['apply']);
    expect(input.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});

describe('DeckService.generate：层级筛选真的生效', () => {
  /** 四个层级各一条，互不重叠 */
  function fourLevelPoints(): KnowledgePoint[] {
    return [
      makePoint({ statement: '记住：线性表的定义', cognitiveLevel: 'remember' }),
      makePoint({
        statement: '理解：顺序表为什么支持随机访问',
        cognitiveLevel: 'understand',
        anchors: [{ sourceId: 'src_1', page: 2, charStart: 100, charEnd: 140 }],
      }),
      makePoint({
        statement: '应用：给定插入位置写出移动元素的次数',
        cognitiveLevel: 'apply',
        anchors: [{ sourceId: 'src_1', page: 3, charStart: 10, charEnd: 50 }],
      }),
      makePoint({
        statement: '分析：比较顺序表与链表在不同操作下的复杂度取舍',
        cognitiveLevel: 'analyze',
        anchors: [{ sourceId: 'src_1', page: 4, charStart: 20, charEnd: 60 }],
      }),
    ];
  }

  it('**限定 apply 层 → 出的题只能引用 apply 层的知识点**', async () => {
    const points = fourLevelPoints();
    const applyId = points.find((p) => p.cognitiveLevel === 'apply')!.id;

    const out = await decks.generate({
      points,
      title: '只出 apply 层',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 4, levels: ['apply'], language: 'zh' },
      signal: new AbortController().signal,
    });

    expect(out.questions.length).toBeGreaterThan(0);
    /*
     * ⚠️ 这一条是核心：修复前 service 不筛素材，模型会从四条里挑，
     * 于是会出到 remember / understand / analyze 层的题 —— 本断言失败。
     */
    for (const q of out.questions) {
      expect(q.knowledgePointId).toBe(applyId);
    }
    expect(out.levelFilter).toEqual({
      requested: ['apply'],
      used: 1,
      matched: 1,
      fellBack: false,
    });
  });

  it('不限层级 → 四个层级都可能出现（对照：证明上一条不是「永远只出一条」）', async () => {
    const points = fourLevelPoints();
    const out = await decks.generate({
      points,
      title: '不限层级',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 8, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });

    const levels = new Set(out.questions.map((q) => q.cognitiveLevel));
    /*
     * 不强制四种都有（mock 后端的变体生成有随机性），
     * 但至少要出现 apply 之外的一种 —— 否则上面那条「只出 apply」
     * 可能是因为「本来就只会出 apply」，而不是筛选生效。
     */
    expect([...levels].some((l) => l !== 'apply')).toBe(true);
    expect(out.levelFilter).toBeNull();
  });

  it('**勾的层没有素材 → 退回全部，并且 levelFilter.fellBack 为 true**', async () => {
    /* 只给 remember 层的知识点，却要 analyze 层 */
    const points = [makePoint({ cognitiveLevel: 'remember' })];
    const out = await decks.generate({
      points,
      title: '退回测试',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 2, levels: ['analyze'], language: 'zh' },
      signal: new AbortController().signal,
    });

    /* 仍然是出得出题的（不因筛得太窄而一道都没有） */
    expect(out.questions.length).toBeGreaterThan(0);
    /* 但必须承认退回 */
    expect(out.levelFilter?.fellBack).toBe(true);
    expect(out.levelFilter?.matched).toBe(0);
    expect(out.levelFilter?.used).toBe(1);
  });

  it('素材全被筛掉时不会产出「引用被筛掉的素材」的题', async () => {
    /*
     * 这条覆盖一个容易漏的分支：`materialById` 必须用**筛选后**的素材建。
     * 用全量的话，模型若指了一条被筛掉的素材，我们照样能把题落库 ——
     * 那样层级筛选就等于形同虚设。
     */
    const points = fourLevelPoints();
    const applyId = points.find((p) => p.cognitiveLevel === 'apply')!.id;
    const out = await decks.generate({
      points,
      title: '不引用被筛掉的素材',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 4, levels: ['apply'], language: 'zh' },
      signal: new AbortController().signal,
    });

    for (const q of out.questions) {
      expect(q.knowledgePointId).not.toBeNull();
      expect(q.knowledgePointId).toBe(applyId);
    }
  });

  it('**从原文出题勾层级 → 必然退回，并如实标记**（已知局限，别当 bug）', async () => {
    /*
     * `segmentsToMaterials` 把段落层级统一写成 understand
     * （原文段落没有难度概念，统一给 understand 比随机猜一个诚实）。
     * 所以在「从原文出题」入口勾 apply/analyze 会筛空 → 退回全部。
     *
     * 这不是 bug，是素材本身没有层级信息。测试把它钉住，
     * 免得以后有人以为筛选坏了，也免得有人偷偷把段落层级改成随机。
     */
    const seg: SourceSegment = {
      id: 'seg_1',
      sourceId: 'src_1',
      index: 1,
      page: 1,
      chapter: '第一章',
      text: '线性表是由 n 个数据元素构成的有限序列，n 称为表长。这一段足够长了用来出题。',
      charCount: 40,
    };
    const materials = segmentsToMaterials([seg]);
    expect(materials[0].cognitiveLevel).toBe('understand');

    const out = await decks.generate({
      materials,
      points: [],
      title: '原文出题限 apply',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 2, levels: ['apply'], language: 'zh' },
      signal: new AbortController().signal,
    });

    expect(out.levelFilter?.fellBack).toBe(true);
    expect(out.levelFilter?.requested).toEqual(['apply']);
  });

  it('pointsToMaterials 的层级原样带到题材上（筛选的前提）', () => {
    const points = fourLevelPoints();
    const materials = pointsToMaterials(points);
    expect(materials.map((m) => m.cognitiveLevel)).toEqual([
      'remember',
      'understand',
      'apply',
      'analyze',
    ]);
  });
});

describe('levelFilter 的形态（供界面渲染）', () => {
  it('没勾层级时是 null，界面据此不显示任何说明', async () => {
    const out = await decks.generate({
      points: [makePoint()],
      title: 't',
      backend: new MockQuestionBackend(0),
      options: { kinds: ['single'], count: 1, levels: null, language: 'zh' },
      signal: new AbortController().signal,
    });
    const filter: GenerateQuestionsOutput['levelFilter'] = out.levelFilter;
    expect(filter).toBeNull();
  });
});
