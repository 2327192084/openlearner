import { describe, expect, it } from 'vitest';
import type { Source, SourceSegment } from '@/core/model.ts';
import { buildOutline } from './source-outline.ts';
import { checkCompleteness, guessEdition, guessSubject } from './subject-guess.ts';

/**
 * 科目推断 + 解析完整性闸门（2026-11-21 深夜）。
 *
 * ## 夹具全部来自用户真实库
 *
 * 三条资料标题与内容都是**实测数据**（只读探测 2026-11-21）：
 *  - 「高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )」
 *  - 「信号与系统（第二版）第1章 信号与系统 正文（不含习题）」
 *  - 「课程知识点一」（pptx，内容讲安全生产）
 *
 * 用真数据测是因为假数据测不出「标题里混着编者、版本、站点残留」
 * 这类真实噪音。
 */

function seg(index: number, text: string): SourceSegment {
  return {
    id: 'seg-' + index,
    sourceId: 'src-1',
    index,
    page: index,
    chapter: null,
    text,
    charCount: text.length,
  };
}

function source(over: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    title: '未命名资料',
    fileName: null,
    kind: 'pdf',
    courseId: null,
    pageCount: null,
    byteSize: 0,
    textStatus: 'ready',
    segmentCount: 0,
    fileStored: false,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Source;
}

describe('guessSubject：从标题推断（最可信）', () => {
  it('真实标题「高等数学 第7版 上 -- 同济大学数学系编」', () => {
    const g = guessSubject(
      source({ title: '高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )' }),
      buildOutline([]),
    );
    expect(g.name).toBe('高等数学');
    expect(g.source).toBe('title');
    expect(g.evidence).toContain('高等数学');
  });

  it('真实标题「信号与系统（第二版）第1章」', () => {
    const g = guessSubject(
      source({ title: '信号与系统（第二版）第1章 信号与系统 正文（不含习题）' }),
      buildOutline([]),
    );
    expect(g.name).toBe('信号与系统');
    expect(g.source).toBe('title');
  });

  it('⚠️「高等数学」不能被「数学」先吃掉（具体分支优先）', () => {
    /*
     * 词表顺序有意义：如果「数学」排在「高等数学」前面，
     * 高等数学会被识别成一个泛泛的「数学」，检索就搜不准了。
     */
    const g = guessSubject(source({ title: '高等数学 上册' }), buildOutline([]));
    expect(g.name).toBe('高等数学');
    expect(g.id).toBe('advanced-math');
  });

  it('英文标题也认（calculus）', () => {
    const g = guessSubject(source({ title: 'Calculus Early Transcendentals' }), buildOutline([]));
    expect(g.name).toBe('高等数学');
  });

  it('文件名也能用（标题是「未命名」时）', () => {
    const g = guessSubject(
      source({ title: '未命名资料', fileName: '线性代数-同济第五版.pdf' }),
      buildOutline([]),
    );
    expect(g.name).toBe('线性代数');
  });
});

describe('guessSubject：从目录推断', () => {
  it('标题猜不出、目录里有科目词 → source = toc', () => {
    const segs = [
      seg(1, `目录
第1章 数据结构与算法
第2章 线性表
第3章 树与二叉树`),
    ];
    const o = buildOutline(segs);
    const g = guessSubject(source({ title: '课程资料一' }), o, segs);
    expect(g.source).toBe('toc');
    expect(g.name).toBe('数据结构');
    expect(g.evidence).toContain('目录');
  });
});

describe('guessSubject：从正文推断（最弱）', () => {
  it('只有正文反复出现科目词才认（阈值 3 次）', () => {
    const segs = [
      seg(1, '数据结构中最重要的是线性表。'),
      seg(2, '数据结构的树形结构如下。'),
      seg(3, '数据结构里的图算法很复杂。'),
    ];
    const g = guessSubject(source({ title: '课程资料一' }), buildOutline(segs), segs);
    expect(g.source).toBe('content');
    expect(g.name).toBe('数据结构');
    expect(g.evidence).toContain('3 次');
  });

  it('⚠️ 只出现 1~2 次不算（教材里偶然提到别的科目很常见）', () => {
    /*
     * 信号与系统的书里也会提到「微积分」，那不代表这门课是微积分。
     */
    const segs = [seg(1, '这里用到了微积分的基本定理。'), seg(2, '其它内容都与信号有关。')];
    const g = guessSubject(source({ title: '课程资料一' }), buildOutline(segs), segs);
    expect(g.source).toBe('none');
    expect(g.name).toBe('');
  });

  it('推不出时 source = none（必须问用户，不硬猜）', () => {
    const segs = [seg(1, '这一段讲的是某种非常特定的内部流程规范。')];
    const g = guessSubject(source({ title: '资料' }), buildOutline(segs), segs);
    expect(g.source).toBe('none');
    expect(g.id).toBe('');
  });
});

describe('guessEdition：抠版本与编者', () => {
  it('抠出「第7版」', () => {
    expect(guessEdition('高等数学 第7版 上')).toContain('第7版');
  });

  it('抠出编者', () => {
    const e = guessEdition('高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )');
    expect(e).toContain('第7版');
    expect(e).toContain('同济大学数学系');
  });

  it('中文版本号也认（第二版）', () => {
    expect(guessEdition('信号与系统（第二版）第1章')).toContain('第二版');
  });

  it('没有版本信息时返回空串（不编）', () => {
    expect(guessEdition('课程知识点一')).toBe('');
  });
});

describe('checkCompleteness：用户确认要「挡住」', () => {
  const cover = (declaredTo: number | null, to: number) => ({ declaredTo, to });

  it('⚠️ 高数那种：442 页只解析 3.5 万字 → 必须拦', () => {
    /*
     * 真实数据：用户库《高等数学 第7版 上》442 页、正文 35738 字
     * = 平均每页 80 字。拿去规划路线只能看到封面和前言。
     */
    const segs = Array.from({ length: 442 }, (_, i) =>
      seg(i + 1, '封面与前言内容'.repeat(3)),
    );
    const o = buildOutline(segs);
    const c = checkCompleteness(
      source({ pageCount: 442, textStatus: 'ready' }),
      segs,
      o,
      cover(null, 1),
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('partial-pages');
    expect(c.message).toContain('442 页');
  });

  it('正常教材（每页 800 字）→ 放行', () => {
    const text = '正文内容'.repeat(200); // 800 字
    const segs = Array.from({ length: 30 }, (_, i) => seg(i + 1, text));
    const c = checkCompleteness(
      source({ pageCount: 30, textStatus: 'ready' }),
      segs,
      buildOutline(segs),
      cover(null, 3),
    );
    expect(c.ok).toBe(true);
    expect(c.reason).toBe('ok');
  });

  it('完全没有正文 → 拦，且给出可操作提示', () => {
    const c = checkCompleteness(
      source({ pageCount: 100, textStatus: 'no-text-layer' }),
      [],
      buildOutline([]),
      null,
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('no-text');
    expect(c.message).toContain('OCR');
  });

  it('⚠️ 目录列到第 8 章、正文只到第 1 章 → 拦（差 ≥2 章）', () => {
    /*
     * 夹具要**先满足每页字数门槛**，否则会先被判成 partial-pages，
     * 测不到这里想测的「章数差」那条规则。
     * 36 页 × 800 字 = 28800 字，perPage = 800，能过第一道门槛。
     *
     * 这本身就是一条教训：夹具不符合前置条件时，测到的是别的规则。
     */
    const body = ('第1章 信号与系统\n' + '正文内容'.repeat(200)).slice(0, 800);
    const segs = Array.from({ length: 36 }, (_, i) => seg(i + 1, body));
    const c = checkCompleteness(
      source({ pageCount: 36, textStatus: 'ready' }),
      segs,
      buildOutline(segs),
      cover(8, 1),
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('partial-chapters');
    expect(c.message).toContain('第 8 章');
    expect(c.message).toContain('第 1 章');
  });

  it('⚠️ 只差 1 章不拦（可能只是最后一章还没解析完）', () => {
    const text = '正文内容'.repeat(150);
    const segs = Array.from({ length: 30 }, (_, i) => seg(i + 1, text));
    const c = checkCompleteness(
      source({ pageCount: 30, textStatus: 'ready' }),
      segs,
      buildOutline(segs),
      cover(4, 3),
    );
    expect(c.ok).toBe(true);
  });

  it('pageCount 为 null（pptx/docx）时跳过「每页字数」那条规则', () => {
    /*
     * pptx 没有「页」概念（pageCount = null），所以「每页多少字」
     * 这条规则不适用 —— 不能因为算不出 perPage 就拦住。
     *
     * 但「正文总量」门槛仍然适用：100 字读不出讲什么，该拦。
     * 所以夹具要有足够正文（≥200 字）才能证明这条规则被跳过。
     */
    const text = '正文内容说明'.repeat(40); // 240 字
    const segs = [seg(1, text)];
    const c = checkCompleteness(
      source({ pageCount: null, textStatus: 'ready', kind: 'pptx' }),
      segs,
      buildOutline(segs),
      null,
    );
    expect(c.ok).toBe(true);
    expect(c.reason).toBe('ok');
  });

  it('pageCount 为 null 且正文极少 → 仍然拦住那一条（不是放行）', () => {
    const segs = [seg(1, '正文'.repeat(50))]; // 100 字
    const c = checkCompleteness(
      source({ pageCount: null, textStatus: 'ready', kind: 'pptx' }),
      segs,
      buildOutline(segs),
      null,
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('no-text');
  });

  it('页数少（≤20）时不套用每页字数阈值', () => {
    /*
     * 20 页以内的小资料可能就是图片多、字少（如习题册），
     * 用每页 200 字的门槛会误拦。但也要求有**最低限度**的正文
     * （≥200 字），否则连「讲什么」都读不出来。
     */
    const segs = Array.from({ length: 10 }, (_, i) =>
      seg(i + 1, '这一节的重点内容说明'.repeat(5)),
    );
    const c = checkCompleteness(
      source({ pageCount: 10, textStatus: 'ready' }),
      segs,
      buildOutline(segs),
      null,
    );
    expect(c.ok).toBe(true);
  });

  it('页数少且正文也极少（< 200 字）→ 仍然拦（读不出讲什么）', () => {
    const segs = Array.from({ length: 3 }, (_, i) => seg(i + 1, '短'));
    const c = checkCompleteness(
      source({ pageCount: 3, textStatus: 'ready' }),
      segs,
      buildOutline(segs),
      null,
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('no-text');
  });
});