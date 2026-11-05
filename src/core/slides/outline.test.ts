import { describe, expect, it } from 'vitest';
import { buildCoverPage, buildOutline } from './outline.ts';
import { chunk, chunks, chunksInChapter } from '../../test/chunks.ts';

/**
 * 确定性大纲的测试。
 *
 * 这是 AI 失败时的回退路径 —— 它把原文按章节排成要点页，不做提炼。
 * 界面必须如实告诉用户「这次没用上 AI」，否则用户会以为看到的是
 * 模型生成的内容。
 *
 * 角标规则与 AI 路径一致：页码只从段落继承，缺页码就不给角标。
 * 最容易犯的错是「给每条要点都安一个角标，凑齐了看起来完整」，
 * 所以下面有一半的用例在断言**什么情况下不给角标**。
 */

describe('buildOutline：基本结构', () => {
  it('总是先出封面页', () => {
    const { pages } = buildOutline({ chunks: chunks(3), sourceTitle: '数据结构' });
    expect(pages[0]!.layout).toBe('title');
  });

  it('封面副标题带段数', () => {
    const { pages } = buildOutline({ chunks: chunks(3), sourceTitle: '数据结构' });
    expect(pages[0]!.subtitle).toContain('3');
  });

  it('指定标题时用指定标题，不用资料名', () => {
    const { pages } = buildOutline({
      chunks: chunks(1),
      sourceTitle: '数据结构',
      title: '期末冲刺',
    });
    expect(pages[0]!.title).toBe('期末冲刺');
  });

  it('单章节不插章节过渡页（只有一章时过渡页像卡住）', () => {
    const { pages } = buildOutline({
      chunks: chunksInChapter(3, '第一章', 1),
      sourceTitle: 'S',
    });
    expect(pages.some((p) => p.layout === 'section')).toBe(false);
  });

  it('多章节插章节过渡页', () => {
    const { pages } = buildOutline({
      chunks: [...chunksInChapter(1, '第一章', 1), ...chunksInChapter(1, '第二章', 2)],
      sourceTitle: 'S',
    });
    expect(pages.filter((p) => p.layout === 'section')).toHaveLength(2);
  });

  it('章节顺序按出现顺序，不按字母序', () => {
    const { pages } = buildOutline({
      chunks: [chunk('a', '甲', 1, '第二章'), chunk('b', '乙', 2, '第一章')],
      sourceTitle: 'S',
    });
    const sections = pages.filter((p) => p.layout === 'section').map((p) => p.title);
    expect(sections).toEqual(['第二章', '第一章']);
  });

  it('没有章节名的段落归为「主要内容」', () => {
    const { pages } = buildOutline({
      chunks: [chunk('a', '甲', 1, null)],
      sourceTitle: 'S',
    });
    const body = pages.find((p) => p.layout === 'bullets');
    expect(body!.title).toContain('主要内容');
  });
});

describe('buildOutline：角标与引用', () => {
  it('每段生成角标，编号从 1 开始连续', () => {
    const { citations } = buildOutline({ chunks: chunks(3), sourceTitle: 'S' });
    expect(citations.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('角标的页码从段落原样继承，不重新猜', () => {
    const { citations } = buildOutline({
      chunks: [chunk('s1', '甲', 17)],
      sourceTitle: 'S',
    });
    expect(citations[0]!.page).toBe(17);
  });

  it('角标记录段落 id（点回原文的锚点）', () => {
    const { citations } = buildOutline({
      chunks: [chunk('seg_x', '甲', 1)],
      sourceTitle: 'S',
    });
    expect(citations[0]!.segmentId).toBe('seg_x');
  });

  it('角标带原文引用片段，便于资料页核对', () => {
    const { citations } = buildOutline({
      chunks: [chunk('s1', '这是原文里的一句话，应当出现在引用片段里。', 1)],
      sourceTitle: 'S',
    });
    expect(citations[0]!.quote).toContain('这是原文里的一句话');
  });

  it('段落缺页码：要点照常生成，但没有角标', () => {
    const { pages, citations, bulletsWithoutCitation } = buildOutline({
      chunks: [chunk('s1', '甲甲', 0)],
      sourceTitle: 'S',
    });

    const bullets = pages.find((p) => p.layout === 'bullets')!.bullets;
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets[0]!.citationIndex).toBeNull();
    expect(citations).toHaveLength(0);
    expect(bulletsWithoutCitation).toBeGreaterThan(0);
  });

  it('同一段拆出的多条要点共用一个角标编号', () => {
    const long = '这是第一句话，' + '内容'.repeat(60) + '。这是第二句话，' + '内容'.repeat(60) + '。';
    const { pages, citations } = buildOutline({
      chunks: [chunk('s1', long, 1)],
      sourceTitle: 'S',
    });

    const bullets = pages.find((p) => p.layout === 'bullets')!.bullets;
    expect(bullets.length).toBeGreaterThan(1);
    expect(new Set(bullets.map((b) => b.citationIndex)).size).toBe(1);
    expect(citations).toHaveLength(1);
  });

  it('跨资料引用：sourceTitle 按 sourceId 查表取', () => {
    const { citations } = buildOutline({
      chunks: [chunk('s1', '甲', 1)],
      sourceTitle: '主资料',
      sourceId: 'src_1',
      sourceTitles: new Map([['src_1', '数据结构讲义']]),
    });
    expect(citations[0]!.sourceTitle).toBe('数据结构讲义');
  });

  it('查不到资料标题时回退到主资料名（不留空字符串）', () => {
    const { citations } = buildOutline({
      chunks: [chunk('s1', '甲', 1)],
      sourceTitle: '主资料',
      sourceId: 'src_unknown',
      sourceTitles: new Map(),
    });
    expect(citations[0]!.sourceTitle).toBe('主资料');
  });
});

describe('buildOutline：分页与边界', () => {
  it('要点超过每页上限时拆成续页，不截断', () => {
    const source = Array.from({ length: 12 }, (_, i) =>
      chunk(`s${i}`, `第 ${i} 段正文，内容各不相同，需要占满一行。`, 1, '第一章'),
    );
    const { pages } = buildOutline({ chunks: source, sourceTitle: 'S' });

    const bulletPages = pages.filter((p) => p.layout === 'bullets');
    expect(bulletPages.length).toBeGreaterThan(1);
    expect(bulletPages[1]!.title).toContain('（续）');

    // 内容不丢：每一段的文字都要出现在某个要点里
    const allText = bulletPages.flatMap((p) => p.bullets.map((b) => b.text)).join('');
    for (let i = 0; i < 12; i++) {
      expect(allText).toContain(`第 ${i} 段`);
    }
  });

  it('空正文的段落被跳过并计数', () => {
    const { skippedPoints } = buildOutline({
      chunks: [chunk('s1', '甲', 1), chunk('s2', '   ', 2), chunk('s3', '', 3)],
      sourceTitle: 'S',
    });
    expect(skippedPoints).toBe(2);
  });

  it('50 页教材规模：200 段不崩且要点数守恒', () => {
    const source = Array.from({ length: 200 }, (_, i) =>
      chunk(`s${i}`, `第 ${i} 段。`, Math.floor(i / 4) + 1, `第${Math.floor(i / 40) + 1}章`),
    );
    const { pages } = buildOutline({ chunks: source, sourceTitle: 'S' });

    const bulletCount = pages
      .filter((p) => p.layout === 'bullets')
      .reduce((n, p) => n + p.bullets.length, 0);
    expect(bulletCount).toBe(200);
  });

  it('没有任何段落时只出封面页', () => {
    const { pages } = buildOutline({ chunks: [], sourceTitle: 'S' });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.layout).toBe('title');
  });

  it('资料标题为空时用「学习资料」兜底', () => {
    const { pages } = buildOutline({ chunks: [chunk('s1', '甲', 1)], sourceTitle: '  ' });
    expect(pages[0]!.subtitle).toContain('学习资料');
  });

  it('每条要点都有唯一 id（界面要按 id 做增删）', () => {
    const { pages } = buildOutline({ chunks: chunks(5), sourceTitle: 'S' });
    const ids = pages.flatMap((p) => p.bullets.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildCoverPage：两条路径共用', () => {
  it('副标题格式按单位拼', () => {
    const page = buildCoverPage({ deckTitle: 'T', sourceTitle: 'S', pointCount: 3 });
    expect(page.subtitle).toBe('S · 3 页');
  });

  it('可以指定单位', () => {
    const page = buildCoverPage({
      deckTitle: 'T',
      sourceTitle: 'S',
      pointCount: 3,
      unit: '段原文',
    });
    expect(page.subtitle).toContain('段原文');
  });

  it('零条时不带数量后缀', () => {
    const page = buildCoverPage({ deckTitle: 'T', sourceTitle: 'S', pointCount: 0 });
    expect(page.subtitle).toBe('S');
  });
});
