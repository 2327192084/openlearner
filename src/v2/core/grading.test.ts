import { describe, expect, it } from 'vitest';
import type { Card } from './cards.ts';
import {
  DEFAULT_GRADING_RULES,
  baseSecondsFor,
  isDefaultRules,
  judgeByTiming,
  normalizeGradingRules,
  strictnessFor,
  RATIO_THRESHOLDS,
  STRICTNESS_FACTOR,
  MAX_RATIO,
} from './grading.ts';

/**
 * 计时评分的测试。
 *
 * ## 这块为什么必须有测试
 *
 * 评分直接决定「下次什么时候再让你复习」。
 * 算错了用户不会说「阈值错了」，只会觉得「这软件天天让我看同一道题」
 * 或者「明明不会却半年不考我」。这类问题在界面上完全看不出来，
 * 只能靠测试把每一档的边界钉死。
 */

const mk = (over: Partial<Card>): Card => ({
  id: 'c1',
  sourceId: 's1',
  kind: 'single',
  prompt: '题干',
  options: [],
  answer: 'A',
  explanation: '',
  anchors: [],
  deckId: 'd1',
  createdAt: '2026-11-06',
  ...over,
});

/** 造一道基准时长正好是 baseMs 的题，便于精确控制倍率 */
const cardWithBase = (seconds: number, over: Partial<Card> = {}): Card => {
  // single 的公式：6 + 0.06×题干字数。要让 base = seconds，解出题干字数
  const chars = Math.round((seconds - 6) / 0.06);
  return mk({ kind: 'single', prompt: '题'.repeat(Math.max(0, chars)), options: [], ...over });
};

describe('baseSecondsFor：基准时长按题型与长度算', () => {
  it('题干越长，基准越长', () => {
    const short = baseSecondsFor(mk({ prompt: '短题干' }));
    const long = baseSecondsFor(mk({ prompt: '这是一段明显更长的题干'.repeat(5) }));
    expect(long).toBeGreaterThan(short);
  });

  it('简答题比单选题基准更长（要组织语言）', () => {
    const prompt = '请说明线性表与链表的区别'.repeat(3);
    const single = baseSecondsFor(mk({ kind: 'single', prompt }));
    const short = baseSecondsFor(mk({ kind: 'short', prompt }));
    expect(short).toBeGreaterThan(single);
  });

  it('选择题把选项字数算进去，没有选项时更短', () => {
    const noOpt = baseSecondsFor(mk({ kind: 'single', prompt: '题干', options: [] }));
    const withOpt = baseSecondsFor(
      mk({
        kind: 'single',
        prompt: '题干',
        options: [
          { key: 'A', text: '一个很长的选项内容' },
          { key: 'B', text: '另一个很长的选项内容' },
        ],
      }),
    );
    expect(withOpt).toBeGreaterThan(noOpt);
  });

  it('知识点只算正文长度，不算题干', () => {
    const short = baseSecondsFor(mk({ kind: 'point', prompt: '标题', explanation: '短' }));
    const long = baseSecondsFor(
      mk({ kind: 'point', prompt: '标题', explanation: '正文'.repeat(100) }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it('保底 3 秒：空题干也不会算出很小的基准', () => {
    expect(baseSecondsFor(mk({ kind: 'single', prompt: '', options: [] }))).toBeGreaterThanOrEqual(3);
  });
});

describe('judgeByTiming：答错一律 again', () => {
  it('答错就是 again，不管多快', () => {
    const card = cardWithBase(10);
    expect(judgeByTiming(card, false, 500).grade).toBe('again');
  });

  it('答错且很慢也是 again（不会降级成别的）', () => {
    const card = cardWithBase(10);
    expect(judgeByTiming(card, false, 120000).grade).toBe('again');
  });

  it('答错的 reason 为空（界面不再展示解释）', () => {
    /*
     * 用户要求「答错了直接记入错题就行」—— 答错时界面不再弹判定面板，
     * 所以 reason 写了也不会被显示，只会作为死字符串留在包里。
     *
     * 这条断言的作用是：如果将来有人重新给答错写了文案却忘了接回界面，
     * 或者反过来接了界面却忘了写文案，都能立刻发现。
     */
    const v = judgeByTiming(cardWithBase(10), false, 3000);
    expect(v.grade).toBe('again');
    expect(v.reason).toBe('');
  });
});

describe('judgeByTiming：答对按倍率分档', () => {
  const card = cardWithBase(10);
  /**
   * 用真实的基准毫秒，而不是假设它正好是 10000。
   *
   * cardWithBase 要按题干字数取整，实际基准会是 10.02 秒这种值 ——
   * 拿 10000 当分母去卡边界，测的就是「我算得准不准」而不是「代码对不对」。
   */
  const base = baseSecondsFor(card) * 1000;
  const { easyBelow, goodBelow } = RATIO_THRESHOLDS;

  it('明显快于基准 → easy', () => {
    expect(judgeByTiming(card, true, base * (easyBelow * 0.5)).grade).toBe('easy');
  });

  it('接近基准 → good', () => {
    expect(judgeByTiming(card, true, base * ((easyBelow + goodBelow) / 2)).grade).toBe('good');
  });

  it('明显慢于基准 → hard', () => {
    expect(judgeByTiming(card, true, base * (goodBelow + 0.5)).grade).toBe('hard');
  });

  it('慢到上限也只到 hard，不会变成 again（答对了就是答对了）', () => {
    const v = judgeByTiming(card, true, base * 100);
    expect(v.grade).toBe('hard');
    expect(v.tooSlow).toBe(true);
  });

  it('倍率恰在 easy 边界内一点点 → easy，之外 → 不是 easy', () => {
    expect(judgeByTiming(card, true, base * (easyBelow - 0.001)).grade).toBe('easy');
    expect(judgeByTiming(card, true, base * (easyBelow + 0.001)).grade).not.toBe('easy');
  });
});

describe('judgeByTiming：知识点没有对错，只看停留时间', () => {
  const point = mk({ kind: 'point', prompt: '标题', explanation: '正文'.repeat(30) });

  it('读得很快 → easy', () => {
    expect(judgeByTiming(point, null, 500).grade).toBe('easy');
  });

  it('读得慢最差只到 hard，不会判成 again（没做题就没有对错）', () => {
    const v = judgeByTiming(point, null, 600000);
    expect(v.grade).toBe('hard');
  });
});

describe('judgeByTiming：异常输入不产生离谱结果', () => {
  const card = cardWithBase(10);

  it('负耗时按 0 处理，不产生负倍率', () => {
    const v = judgeByTiming(card, true, -5000);
    expect(v.ratio).toBe(0);
    expect(v.elapsedMs).toBe(0);
  });

  it('NaN 按 0 处理', () => {
    const v = judgeByTiming(card, true, Number.NaN);
    expect(v.ratio).toBe(0);
  });

  it('超过上限时 ratio 被夹到 MAX_RATIO，并标记 clamped', () => {
    const v = judgeByTiming(card, true, baseSecondsFor(card) * 1000 * (MAX_RATIO + 5));
    expect(v.ratio).toBe(MAX_RATIO);
    expect(v.clamped).toBe(true);
  });

  it('没超过上限时 clamped 为 false', () => {
    expect(judgeByTiming(card, true, baseSecondsFor(card) * 1000).clamped).toBe(false);
  });
});

describe('宽容度：三档确实拉开差距', () => {
  const card = cardWithBase(10);
  /**
   * 取一个「标准档判 good、宽松档判 easy」的耗时。
   *
   * 计算：easy 边界在 standard 是 0.6、lenient 是 0.6×1.35=0.81。
   * 取倍率 0.7，落在两者之间。
   */
  const elapsed = baseSecondsFor(card) * 1000 * 0.7;

  it('同一耗时：宽松档更容易判成 easy', () => {
    const lenient = judgeByTiming(card, true, elapsed, { strictness: 'lenient', perKind: {} });
    const standard = judgeByTiming(card, true, elapsed, { strictness: 'standard', perKind: {} });
    expect(lenient.grade).toBe('easy');
    expect(standard.grade).toBe('good');
  });

  it('同一耗时：严格档更难判成 easy', () => {
    const strict = judgeByTiming(card, true, elapsed, { strictness: 'strict', perKind: {} });
    expect(strict.grade).not.toBe('easy');
  });

  it('宽松档的阈值确实比标准档大（方向不能反）', () => {
    expect(STRICTNESS_FACTOR.lenient).toBeGreaterThan(STRICTNESS_FACTOR.standard);
    expect(STRICTNESS_FACTOR.strict).toBeLessThan(STRICTNESS_FACTOR.standard);
  });
});

describe('按题型覆盖宽容度（C3）', () => {
  it('perKind 覆盖总档', () => {
    const rules = { strictness: 'standard' as const, perKind: { single: 'strict' as const } };
    expect(strictnessFor('single', rules)).toBe('strict');
    // 未覆盖的题型沿用总档
    expect(strictnessFor('short', rules)).toBe('standard');
  });

  it('选择题判严、简答判松：同一倍率下结论不同', () => {
    const rules = {
      strictness: 'standard' as const,
      perKind: { single: 'strict' as const, short: 'lenient' as const },
    };
    const single = cardWithBase(10);
    const short = mk({ kind: 'short', prompt: '题'.repeat(30) });
    // 都用 0.7 倍率
    const a = judgeByTiming(single, true, baseSecondsFor(single) * 1000 * 0.7, rules);
    const b = judgeByTiming(short, true, baseSecondsFor(short) * 1000 * 0.7, rules);
    expect(b.grade).toBe('easy');
    expect(a.grade).not.toBe('easy');
  });
});

describe('normalizeGradingRules：坏数据收敛成默认，不抛错', () => {
  it('undefined / null / 非对象 → 默认', () => {
    expect(normalizeGradingRules(undefined)).toEqual({ strictness: 'standard', perKind: {} });
    expect(normalizeGradingRules(null)).toEqual({ strictness: 'standard', perKind: {} });
    expect(normalizeGradingRules('乱写的')).toEqual({ strictness: 'standard', perKind: {} });
  });

  it('非法宽容度被丢掉，退回默认', () => {
    expect(normalizeGradingRules({ strictness: '超严格' }).strictness).toBe('standard');
  });

  it('合法值保留', () => {
    expect(normalizeGradingRules({ strictness: 'strict' }).strictness).toBe('strict');
  });

  it('perKind 里的非法键与非法值都被过滤', () => {
    const out = normalizeGradingRules({
      strictness: 'standard',
      perKind: { single: 'lenient', 不存在的题型: 'strict', short: '乱写' },
    });
    expect(out.perKind).toEqual({ single: 'lenient' });
  });
});

describe('isDefaultRules：判断是否已偏离默认', () => {
  it('默认规则返回 true', () => {
    expect(isDefaultRules(DEFAULT_GRADING_RULES)).toBe(true);
  });

  it('改了总档 → false', () => {
    expect(isDefaultRules({ strictness: 'strict', perKind: {} })).toBe(false);
  });

  it('只改了某个题型 → false', () => {
    expect(isDefaultRules({ strictness: 'standard', perKind: { blank: 'lenient' } })).toBe(false);
  });
});

/**
 * 用户明确说过：「答题建议时长这个功能不用，这个不好估计」。
 *
 * 所以判定文案里**不能出现任何形式的时间建议**。
 * 基准时长仍然参与计算（做归一化需要它），但绝不能露到用户面前。
 *
 * 这条约束很容易在后续改动中被无意破坏 ——
 * 比如为了「解释得更清楚」，顺手把 baseSec 拼进文案里。
 * 那种改动看起来是善意，实际是把一个不可靠的数字摆到了用户眼前。
 */
describe('对外文案不暴露「建议时长」', () => {
  const forbidden = ['通常要', '通常约', '约需', '建议', '应该花', '标准用时'];

  const cases: { desc: string; card: Card; correct: boolean | null; ms: number }[] = [
    { desc: '答错', card: mk({}), correct: false, ms: 3000 },
    { desc: '一眼就会', card: cardWithBase(10), correct: true, ms: 1000 },
    { desc: '正常速度', card: cardWithBase(10), correct: true, ms: 10 * 1000 },
    { desc: '想了一会儿', card: cardWithBase(10), correct: true, ms: 20 * 1000 },
    { desc: '太慢', card: cardWithBase(10), correct: true, ms: 200 * 1000 },
    {
      desc: '知识点读了很久',
      card: mk({ kind: 'point', explanation: '正文'.repeat(50) }),
      correct: null,
      ms: 60 * 1000,
    },
  ];

  for (const c of cases) {
    it(`${c.desc}：reason 里没有任何时间建议`, () => {
      const v = judgeByTiming(c.card, c.correct, c.ms);
      for (const word of forbidden) {
        expect(v.reason).not.toContain(word);
      }
      /*
       * 答错是唯一例外：界面不展示它的 reason，所以允许为空。
       * 其余档位必须说明「你用了多久」，否则用户不知道判定依据。
       */
      if (c.correct === false) {
        expect(v.reason).toBe('');
      } else {
        expect(v.reason).toMatch(/用了|读得|花的时间|停顿/);
      }
    });
  }
});
