import { describe, expect, it } from 'vitest';
import { locateLabel, locateQuestion, WHOLE_SEGMENT_RATIO } from './locate-sentence.ts';
import type { KnowledgePoint, Question, SourceSegment } from '@/core/model.ts';

/**
 * 「定位到句子」的判定逻辑（2026-11-20）。
 *
 * 用户诉求：「定位功能不够，现在只能定位到页面，不能具体到句子。」
 *
 * 这组测试守的是三条边界，它们对应真实数据里三种不同形状的锚点：
 *  - 句子级偏移 → 能定位到句子
 *  - 整段偏移   → 只能到页（并说明原因）
 *  - 没有出处   → 自改题，只给提示（用户明确接受）
 */

const SRC = 'src_1';

function seg(over: Partial<SourceSegment> = {}): SourceSegment {
  return {
    id: 'seg_1',
    sourceId: SRC,
    index: 1,
    page: 16,
    chapter: '第一章',
    /* 200 字符正文，方便构造「整段」与「句子」两种跨度 */
    text:
      '设 f: X → Y 是一个映射，对 X 中每个元素 x，按法则 f 在 Y 中有唯一确定的元素 y 与之对应。' +
      '因此像唯一，但原像不一定唯一，值域是 Y 的子集。' +
      '映射的记法通常写成 y = f(x)，其中 x 称为自变量。'.repeat(3),
    charCount: 200,
    ...over,
  } as SourceSegment;
}

function q(over: Partial<Question> = {}): Pick<Question, 'id' | 'anchors' | 'knowledgePointId'> {
  return {
    id: 'q_1',
    anchors: [{ sourceId: SRC, page: 16, segmentId: 'seg_1', charStart: 0, charEnd: 1 }],
    knowledgePointId: null,
    ...over,
  };
}

function kp(over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'kp_1',
    statement: '映射的像唯一但原像不一定唯一',
    chapter: '第一章',
    cognitiveLevel: 'understand',
    tags: [],
    anchors: [{ sourceId: SRC, page: 16, charStart: 5, charEnd: 40 }],
    quotes: [],
    anchorStatus: 'located',
    origin: 'material',
    sourceId: SRC,
    backendId: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as KnowledgePoint;
}

describe('locateQuestion · 句子级锚点', () => {
  it('**自己的锚点跨度小 → 判定为句子**', () => {
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, charStart: 5, charEnd: 40 }] }),
      [],
      [seg()],
    );
    expect(r.kind).toBe('sentence');
    if (r.kind !== 'sentence') return;
    expect(r.from).toBe('own-anchor');
    expect(r.target.charStart).toBe(5);
    expect(r.target.charEnd).toBe(40);
  });

  /**
   * 这条是核心：quote 必须取**原文切片**，不能拿题干。
   *
   * 上一轮的错误正是把题干当 quote 传给阅读器 ——
   * 题干通常不在原文里，阅读器匹配不上，落地只高亮页首。
   * 用户就是因此反馈「只能定位到页面」。
   */
  it('**quote 取自原文切片（不是题干）**', () => {
    const s = seg();
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, charStart: 5, charEnd: 40 }] }),
      [],
      [s],
    );
    expect(r.kind).toBe('sentence');
    if (r.kind !== 'sentence') return;
    expect(r.target.quote).toBe(s.text.slice(5, 40).trim());
    expect(r.target.quote.length).toBeGreaterThan(10);
  });

  it('带 segmentId 时一并传出（阅读器据此精确选段）', () => {
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, segmentId: 'seg_1', charStart: 5, charEnd: 40 }] }),
      [],
      [seg()],
    );
    expect(r.kind).toBe('sentence');
    if (r.kind !== 'sentence') return;
    expect(r.target.segmentId).toBe('seg_1');
  });
});

describe('locateQuestion · 整段锚点只能到页', () => {
  /**
   * 真实库里题目的锚点就是这样：charStart 0 → charEnd 1366（整段）。
   * 它表达的是「这道题出自这一段」，不是「这一句」。
   */
  it('**跨度接近整段 → 判定为 page，不是句子**', () => {
    const s = seg();
    const r = locateQuestion(
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(s.text.length * 0.95) },
        ],
      }),
      [],
      [s],
    );
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.page).toBe(16);
    /* 必须说清为什么不高亮 —— 静默只跳页会让用户以为定位失败 */
    expect(r.reason).toContain('整段');
  });

  it(`阈值与 ReaderPage 同口径（${WHOLE_SEGMENT_RATIO}）`, () => {
    const s = seg();
    const len = s.text.length;
    /* 刚好低于阈值 → 算句子 */
    const below = locateQuestion(
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(len * (WHOLE_SEGMENT_RATIO - 0.05)) },
        ],
      }),
      [],
      [s],
    );
    expect(below.kind).toBe('sentence');
    /* 刚好超过阈值 → 算整段 */
    const above = locateQuestion(
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(len * (WHOLE_SEGMENT_RATIO + 0.05)) },
        ],
      }),
      [],
      [s],
    );
    expect(above.kind).toBe('page');
  });

  it('偏移越界（超出段长）不算句子', () => {
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, charStart: 0, charEnd: 99999 }] }),
      [],
      [seg()],
    );
    expect(r.kind).toBe('page');
  });

  /**
   * ⚠️ 这条是回归测试，锁住一个真实踩到的 bug（2026-11-20）。
   *
   * 整段级题第一版只把 `{sourceId, page}` 传给阅读器，没带 charStart/charEnd。
   * 阅读器判断「这是整段、所以有意不圈」靠的正是这两个值 ——
   * 拿不到就 `spanIsWholeSegment = false`，落进「什么都没找到」分支，
   * **连一句解释都不显示**，用户看到跳到第 16 页却不知道为什么没高亮。
   *
   * 实测现象：整段级题进阅读器后 `reader-jump` 元素数量为 0。
   * 断言「不高亮」当时是绿的 —— 因为不显示提示也等于不高亮。
   * 又一次「断言对坏实现也成立」。
   */
  it('**page 分支必须带上原始偏移**（否则阅读器连解释都不显示）', () => {
    const s = seg();
    const cs = 0;
    const ce = Math.floor(s.text.length * 0.95);
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, segmentId: 'seg_1', charStart: cs, charEnd: ce }] }),
      [],
      [s],
    );
    expect(r.kind).toBe('page');
    if (r.kind !== 'page') return;
    expect(r.charStart).toBe(cs);
    expect(r.charEnd).toBe(ce);
    expect(r.segmentId).toBe('seg_1');
  });
});

describe('locateQuestion · 借关联知识点定位', () => {
  /**
   * 知识点的锚点通常是真句子（实测用户库：44 字符 vs 整段 1366）。
   * 「从知识点出题」产生的题会带 knowledgePointId。
   */
  it('**题目锚点是整段、但关联知识点有句子 → 用知识点的位置**', () => {
    const s = seg();
    const r = locateQuestion(
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(s.text.length * 0.9) },
        ],
        knowledgePointId: 'kp_1',
      }),
      [kp({ anchors: [{ sourceId: SRC, page: 16, charStart: 60, charEnd: 100 }] })],
      [s],
    );
    expect(r.kind).toBe('sentence');
    if (r.kind !== 'sentence') return;
    expect(r.from).toBe('knowledge-point');
    expect(r.target.charStart).toBe(60);
    expect(r.target.charEnd).toBe(100);
  });

  it('知识点也有位置但也是整段 → 退到 page（不硬凑）', () => {
    const s = seg();
    const r = locateQuestion(
      /*
       * 题目自己的锚点也要是整段 —— 否则会先命中 own-anchor 分支，
       * 根本走不到知识点那一步（第一版测试漏了这点，失败过一次）。
       */
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(s.text.length * 0.95) },
        ],
        knowledgePointId: 'kp_1',
      }),
      [
        kp({
          anchors: [
            { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(s.text.length * 0.95) },
          ],
        }),
      ],
      [s],
    );
    expect(r.kind).toBe('page');
  });
});

describe('locateQuestion · 没有位置（自改题）', () => {
  /**
   * 用户原话：「自改题可以没有定位功能，给用户个提示就行」。
   *
   * 实测他的真实库：39 道题全部没有 knowledgePointId（都是自选改造组卷），
   * 且题目自己的 anchors 是整段 —— 所以这类题**必然**走 page 分支。
   * 真正走 none 的是「连 anchors 都没有」的手工题。
   */
  it('**没有任何锚点 → none，并给出可读的提示**', () => {
    const r = locateQuestion(q({ anchors: [] }), [], []);
    expect(r.kind).toBe('none');
    if (r.kind !== 'none') return;
    expect(r.reason).toContain('没有记录原文出处');
  });

  it('none 的文案对用户说清「为什么没有」，不是一句「失败」', () => {
    const r = locateQuestion(q({ anchors: [] }), [], []);
    expect(r.kind).toBe('none');
    if (r.kind !== 'none') return;
    /* 要提到自选/改造题，让用户知道这不是 bug */
    expect(r.reason).toMatch(/自选|改造|手工/);
  });
});

describe('locateLabel', () => {
  it('能定位到句子时，文案明确说「具体句子」而不是只给页码', () => {
    const r = locateQuestion(
      q({ anchors: [{ sourceId: SRC, page: 16, charStart: 5, charEnd: 40 }] }),
      [],
      [seg()],
    );
    const label = locateLabel(r);
    expect(label).toContain('具体句子');
    expect(label).toContain('16');
  });

  it('只能到页时，文案不再宣称能定位到句子', () => {
    const s = seg();
    const r = locateQuestion(
      q({
        anchors: [
          { sourceId: SRC, page: 16, charStart: 0, charEnd: Math.floor(s.text.length * 0.95) },
        ],
      }),
      [],
      [s],
    );
    const label = locateLabel(r);
    expect(label).not.toContain('具体句子');
    expect(label).toContain('跳到原文');
  });

  it('没有出处时如实说', () => {
    expect(locateLabel(locateQuestion(q({ anchors: [] }), [], []))).toBe('没有原文出处');
  });
});
