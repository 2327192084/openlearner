import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { parseMarkdown } from './markdown.ts';
import {
  collectLocators,
  countFigures,
  figureId,
  hasFigures,
  importFigures,
  loadFigures,
  splitByFigures,
  toImageRecords,
  type FetchedFigure,
} from './images.ts';
import type { SourceImageRecord } from '../model.ts';

/**
 * 取图编排层的测试。
 *
 * 全部用假 fetcher —— 真取图要装 MinerU、起服务、有真实 PDF，
 * 单测不该依赖这些。真链路留给「最后在真实数据上跑一次」那步。
 *
 * 重点守四件事：
 *  1. 取不到的图**不存空记录**（否则渲染出破图，看着像资料坏了）
 *  2. 重转时旧图要被清掉（否则 charOffset 过期的孤儿记录留一堆）
 *  3. 失败要如实入账，不吞
 *  4. splitByFigures 的边界不乱序、不丢图
 */

const md = `<!-- page 1 of 2 -->

## 第1章

正文一段。

![Image block](doc:87731df/tier:standard/page:1/block:7)

图1.1 电路

正文二段。

![Chart block](doc:87731df/tier:standard/page:1/block:10)

图1.2 汽车

<!-- page 2 of 2 -->

第二页正文。

![Image block](doc:87731df/tier:standard/page:2/block:3)

图1.3 波形
`;

function fakeFigure(seed = 1): FetchedFigure {
  return {
    dataUri: `data:image/jpeg;base64,AAAA${seed}`,
    width: 400,
    height: 200 + seed,
    byteSize: 100 + seed,
  };
}

/** 所有 locator 都成功 */
const allOk = async () => ({ ok: true as const, figure: fakeFigure() });

describe('figureId', () => {
  it('用 sourceId + page + block 拼，重转时能覆盖同一张', () => {
    expect(figureId('src_1', 1, 7)).toBe('figure_src_1_1_7');
  });

  it('同页不同块不会撞', () => {
    expect(figureId('src_1', 1, 7)).not.toBe(figureId('src_1', 1, 10));
  });

  it('不同页不会撞', () => {
    expect(figureId('src_1', 1, 7)).not.toBe(figureId('src_1', 2, 7));
  });
});

describe('collectLocators', () => {
  it('按正文顺序收集，页序正确', () => {
    const r = parseMarkdown(md, { tier: 'standard' });
    const locs = collectLocators(r.pages);
    expect(locs).toHaveLength(3);
    expect(locs[0]!.page).toBe(1);
    expect(locs[0]!.block).toBe(7);
    expect(locs[2]!.page).toBe(2);
  });

  it('重复的 locator 只取一次（跨页图不重复花时间）', () => {
    const dup = `<!-- page 1 of 1 -->

![Image block](doc:87731df/tier:standard/page:1/block:7)

甲

![Image block](doc:87731df/tier:standard/page:1/block:7)

乙
`;
    const r = parseMarkdown(dup, {});
    expect(collectLocators(r.pages)).toHaveLength(1);
  });

  it('外链图片不进 locator 列表（我们取不了）', () => {
    const ext = `<!-- page 1 of 1 -->\n\n![图](https://example.com/a.png)\n\n说明\n`;
    const r = parseMarkdown(ext, {});
    expect(collectLocators(r.pages)).toHaveLength(0);
  });
});

describe('countFigures', () => {
  it('总数与分类都对', () => {
    const r = parseMarkdown(md, { tier: 'standard' });
    const c = countFigures(r.pages);
    expect(c.total).toBe(3);
    expect(c.external).toBe(0);
    expect(c.byKind.image).toBe(2);
    expect(c.byKind.chart).toBe(1);
  });

  it('外链算在总数里，但单独计', () => {
    const ext = `<!-- page 1 of 1 -->\n\n![图](https://example.com/a.png)\n\n说明\n`;
    const r = parseMarkdown(ext, {});
    const c = countFigures(r.pages);
    expect(c.total).toBe(1);
    expect(c.external).toBe(1);
  });
});

describe('toImageRecords', () => {
  it('把位置 + 字节拼成记录，字段齐全', () => {
    const r = parseMarkdown(md, { tier: 'standard' });
    const fetched = new Map<string, FetchedFigure>([
      ['doc:87731df/tier:standard/page:1/block:7', fakeFigure(1)],
    ]);
    const recs = toImageRecords({ sourceId: 'src_1', pages: r.pages, fetched });
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.id).toBe('figure_src_1_1_7');
    expect(rec.page).toBe(1);
    expect(rec.block).toBe(7);
    expect(rec.kind).toBe('image');
    expect(rec.tier).toBe('standard');
    expect(rec.docShortId).toBe('87731df');
    expect(rec.caption).toBe('图1.1 电路');
    expect(rec.dataUri.startsWith('data:image/jpeg')).toBe(true);
    expect(rec.charOffset).toBeGreaterThan(0);
  });

  it('取失败（不在 fetched 里）的图不产生记录 —— 不存空壳', () => {
    /*
     * 这条是本节最重要的断言。
     * 如果给失败的图也存一条 dataUri 空的记录，阅读器会渲染出一个破图，
     * 用户以为是资料或程序坏了，而实际只是「这张图没取到」。
     * 少一张图是可理解的；破图是不可理解的。
     */
    const r = parseMarkdown(md, { tier: 'standard' });
    const recs = toImageRecords({ sourceId: 'src_1', pages: r.pages, fetched: new Map() });
    expect(recs).toEqual([]);
  });

  it('外链图片不产生记录', () => {
    const ext = `<!-- page 1 of 1 -->\n\n![图](https://example.com/a.png)\n\n说明\n`;
    const r = parseMarkdown(ext, {});
    const recs = toImageRecords({ sourceId: 'src_1', pages: r.pages, fetched: new Map() });
    expect(recs).toEqual([]);
  });
});

describe('importFigures', () => {
  it('全部成功时账目对得上', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    const report = await importFigures({
      storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk,
    });
    expect(report.total).toBe(3);
    expect(report.stored).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.failures).toEqual([]);
    expect(await storage.getAll('sourceImages')).toHaveLength(3);
  });

  it('部分失败：成功的照存，失败如实入账，不抛异常', async () => {
    /*
     * 真实场景：88 张图里有一两张取不到。
     * 一张失败不该让 87 张白取，也不该让正文回滚。
     */
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    let n = 0;
    const flaky = async () => {
      n += 1;
      return n === 2
        ? { ok: false as const, error: 'Requested parsed content is not cached.' }
        : { ok: true as const, figure: fakeFigure(n) };
    };
    const report = await importFigures({
      storage, sourceId: 'src_1', pages: r.pages, fetcher: flaky,
    });
    expect(report.stored).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.error).toContain('not cached');
    expect(await storage.getAll('sourceImages')).toHaveLength(2);
  });

  it('全部失败时 stored=0，但没有空壳记录', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    const report = await importFigures({
      storage, sourceId: 'src_1', pages: r.pages,
      fetcher: async () => ({ ok: false as const, error: '服务没起' }),
    });
    expect(report.stored).toBe(0);
    expect(report.failed).toBe(3);
    expect(await storage.getAll('sourceImages')).toEqual([]);
  });

  it('重转时清掉这份资料的旧图（否则过期 charOffset 留一堆孤儿）', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });

    await importFigures({ storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(3);

    // 假设重转后只剩 1 张图
    const fewer = parseMarkdown(
      `<!-- page 1 of 1 -->\n\n甲\n\n![Image block](doc:87731df/tier:standard/page:1/block:7)\n\n图1.1\n`,
      {},
    );
    await importFigures({ storage, sourceId: 'src_1', pages: fewer.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(1);
  });

  it('重转只清这一份资料的图，别的资料的图不动', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk });
    await importFigures({ storage, sourceId: 'src_2', pages: r.pages, fetcher: allOk });
    expect(await storage.getAll('sourceImages')).toHaveLength(6);

    const fewer = parseMarkdown(
      `<!-- page 1 of 1 -->\n\n甲\n\n![Image block](doc:87731df/tier:standard/page:1/block:7)\n\n图\n`,
      {},
    );
    await importFigures({ storage, sourceId: 'src_1', pages: fewer.pages, fetcher: allOk });
    const left = await storage.getAll('sourceImages');
    expect(left).toHaveLength(4); // src_2 的 3 张 + src_1 的 1 张
    expect(left.filter((x) => x.sourceId === 'src_2')).toHaveLength(3);
  });

  it('进度回调按 locator 数递增，最后一次等于总数', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    const seen: Array<[number, number]> = [];
    await importFigures({
      storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('没有图片的页面：账目全 0，不报错', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown('<!-- page 1 of 1 -->\n\n纯文字。\n', {});
    const report = await importFigures({
      storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk,
    });
    expect(report.total).toBe(0);
    expect(report.stored).toBe(0);
  });
});

describe('loadFigures', () => {
  it('只返回这份资料的图，按页 + 位置排序', async () => {
    const storage = new MemoryStorage();
    const r = parseMarkdown(md, { tier: 'standard' });
    await importFigures({ storage, sourceId: 'src_1', pages: r.pages, fetcher: allOk });
    const figs = await loadFigures(storage, 'src_1');
    expect(figs).toHaveLength(3);
    expect(figs[0]!.page).toBe(1);
    expect(figs[2]!.page).toBe(2);
    // 同页内按 charOffset 升序
    expect(figs[0]!.charOffset).toBeLessThan(figs[1]!.charOffset);
  });

  it('没有图时返回空数组', async () => {
    const storage = new MemoryStorage();
    expect(await loadFigures(storage, 'src_x')).toEqual([]);
  });
});

describe('splitByFigures', () => {
  function rec(charOffset: number, id = 'f'): SourceImageRecord {
    return {
      id, sourceId: 's', page: 1, block: 1, charOffset, kind: 'image',
      dataUri: 'data:image/jpeg;base64,AA', width: 1, height: 1, byteSize: 1,
      caption: null, tier: 'basic', docShortId: 'x', createdAt: '',
    };
  }

  it('没有图时整段返回一个 text', () => {
    expect(splitByFigures('abc', [])).toEqual([{ kind: 'text', text: 'abc' }]);
  });

  it('空文本 + 没有图 → 空数组', () => {
    expect(splitByFigures('', [])).toEqual([]);
  });

  it('中间插一张图，切成三段且文字不丢', () => {
    const pieces = splitByFigures('abcdef', [rec(3)]);
    expect(pieces.map((p) => p.kind)).toEqual(['text', 'figure', 'text']);
    const texts = pieces.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('');
    expect(texts).toBe('abcdef');
  });

  it('图在正文开头（offset 0）', () => {
    const pieces = splitByFigures('abc', [rec(0)]);
    expect(pieces[0]!.kind).toBe('figure');
    expect(pieces[1]).toEqual({ kind: 'text', text: 'abc' });
  });

  it('图在正文末尾（offset 超出长度时夹到末尾）', () => {
    const pieces = splitByFigures('abc', [rec(999)]);
    expect(pieces[pieces.length - 1]!.kind).toBe('figure');
  });

  it('负数 offset 夹到开头，不崩', () => {
    const pieces = splitByFigures('abc', [rec(-5)]);
    expect(pieces[0]!.kind).toBe('figure');
  });

  it('NaN offset 当 0 处理，不产生 undefined 切片', () => {
    const pieces = splitByFigures('abc', [rec(Number.NaN)]);
    expect(pieces[0]!.kind).toBe('figure');
  });

  it('同一位置多张图都不丢，按输入顺序', () => {
    const pieces = splitByFigures('abc', [rec(2, 'f1'), rec(2, 'f2')]);
    const figs = pieces.flatMap((p) => (p.kind === 'figure' ? [p.figure.id] : []));
    expect(figs).toEqual(['f1', 'f2']);
  });

  it('乱序输入按 charOffset 稳定排好', () => {
    const pieces = splitByFigures('abcdef', [rec(4, 'late'), rec(2, 'early')]);
    const figs = pieces.flatMap((p) => (p.kind === 'figure' ? [p.figure.id] : []));
    expect(figs).toEqual(['early', 'late']);
  });

  it('文字内容与原文逐字相同（不丢字、不重复）', () => {
    /*
     * 这条防的是「切分时差一位」这类最难看的 bug：
     * 高亮偏移是按字符算的，切错一位就会高亮到相邻的字。
     */
    const text = '信号可以描述范围极为广泛的一类物理现象。';
    const pieces = splitByFigures(text, [rec(5), rec(12)]);
    const joined = pieces.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('');
    expect(joined).toBe(text);
  });
});

describe('hasFigures', () => {
  it('空数组为 false（渲染层据此走零开销的纯文本路径）', () => {
    expect(hasFigures([])).toBe(false);
  });
  it('有图为 true', () => {
    expect(hasFigures([{ id: 'x' } as SourceImageRecord])).toBe(true);
  });
});
