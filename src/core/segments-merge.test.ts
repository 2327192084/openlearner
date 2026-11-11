import { describe, expect, it, beforeEach } from 'vitest';
import { SourceService } from './sources.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 分段写入的两种模式（2026-11-11）。
 *
 * ## 为什么必须单测这一层
 *
 * 用户要求「分片解析」能**分几次把整本凑齐**。这依赖 `writeSegments`
 * 的 `merge` 模式：新写的页覆盖同页旧内容，没写到的页保留。
 *
 * 这条一旦错了，症状是「之前解析好的页莫名消失」——
 * 用户很难自己判断是解析失败还是被覆盖了，而数据其实已经没了。
 * 所以用单测钉死，而不是只靠手动点一遍。
 *
 * ## 为什么不改默认值
 *
 * `replace` 仍是默认：OCR 写回依赖「先删干净」，
 * 因为扫描件原本是「每页一段、正文为空」，只覆盖不删会留下旧空段。
 * 分片解析显式传 `merge`。
 */

let storage: MemoryStorage;
let sources: SourceService;

beforeEach(async () => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
});

describe('writeSegments：replace 模式（默认，保持旧行为）', () => {
  it('第二次写入完全替换第一次的段', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(s.id, [
      { page: 1, text: '第一页' },
      { page: 2, text: '第二页' },
      { page: 3, text: '第三页' },
    ], 'ready');

    await sources.writeSegments(s.id, [{ page: 1, text: '只有一页' }], 'ready');

    const segs = await sources.getSegments(s.id);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('只有一页');
  });
});

describe('writeSegments：merge 模式（分片解析用）', () => {
  it('★ 只写一部分页时，其他页原样保留', async () => {
    const s = await sources.importText('资料', '占位');
    /* 先「完整解析」出 1-10 页 */
    await sources.writeSegments(
      s.id,
      Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: `第${i + 1}页` })),
      'ready',
    );

    /* 再「分片解析」第 4-6 页（内容改成新的） */
    await sources.writeSegments(
      s.id,
      [
        { page: 4, text: '新第4页' },
        { page: 5, text: '新第5页' },
        { page: 6, text: '新第6页' },
      ],
      'ready',
      'merge',
    );

    const segs = await sources.getSegments(s.id);
    /* 总页数没变 */
    expect(segs).toHaveLength(10);
    /* 覆盖的页是新内容 */
    expect(segs.find((x) => x.page === 4)!.text).toBe('新第4页');
    expect(segs.find((x) => x.page === 5)!.text).toBe('新第5页');
    expect(segs.find((x) => x.page === 6)!.text).toBe('新第6页');
    /* 没碰的页还是旧内容 —— 这正是「分几次凑齐整本」的基础 */
    expect(segs.find((x) => x.page === 1)!.text).toBe('第1页');
    expect(segs.find((x) => x.page === 3)!.text).toBe('第3页');
    expect(segs.find((x) => x.page === 7)!.text).toBe('第7页');
    expect(segs.find((x) => x.page === 10)!.text).toBe('第10页');
  });

  it('★ 两次分片能拼成完整一本（3-5 然后 6-8）', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(s.id, [{ page: 1, text: 'x' }], 'ready');

    await sources.writeSegments(
      s.id,
      [
        { page: 3, text: 'p3' },
        { page: 4, text: 'p4' },
        { page: 5, text: 'p5' },
      ],
      'ready',
      'merge',
    );
    await sources.writeSegments(
      s.id,
      [
        { page: 6, text: 'p6' },
        { page: 7, text: 'p7' },
        { page: 8, text: 'p8' },
      ],
      'ready',
      'merge',
    );

    const segs = await sources.getSegments(s.id);
    const pages = segs.map((x) => x.page);
    /* 1（原有）+ 3,4,5 + 6,7,8 = 7 段 */
    expect(pages).toEqual([1, 3, 4, 5, 6, 7, 8]);
    /* 第二次解析没有把第一次的 3-5 删掉 */
    expect(segs.find((x) => x.page === 3)!.text).toBe('p3');
    expect(segs.find((x) => x.page === 5)!.text).toBe('p5');
  });

  it('★ 合并后按页码升序，index 从 1 连续', async () => {
    /*
     * 顺序错了阅读器的「上一页/下一页」会乱跳。
     * index 必须从 1 连续（界面按 index 定位段落）。
     */
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(s.id, [{ page: 9, text: 'p9' }], 'ready');
    /* 插入更靠前的页 */
    await sources.writeSegments(
      s.id,
      [
        { page: 3, text: 'p3' },
        { page: 5, text: 'p5' },
      ],
      'ready',
      'merge',
    );

    const segs = await sources.getSegments(s.id);
    expect(segs.map((x) => x.page)).toEqual([3, 5, 9]);
    expect(segs.map((x) => x.index)).toEqual([1, 2, 3]);
  });

  it('合并后 segmentCount 反映总数，不是这次写入数', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(
      s.id,
      Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: `p${i + 1}` })),
      'ready',
    );
    const out = await sources.writeSegments(
      s.id,
      [{ page: 2, text: '改过' }],
      'ready',
      'merge',
    );
    expect(out!.source.segmentCount).toBe(5);
    expect(out!.segments).toHaveLength(5);
  });

  it('charCount 跟着新内容走（同一页被覆盖后不会残留旧长度）', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(s.id, [{ page: 1, text: '很短' }], 'ready');
    await sources.writeSegments(s.id, [{ page: 1, text: '长很多的内容在这里' }], 'ready', 'merge');

    const segs = await sources.getSegments(s.id);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.charCount).toBe('长很多的内容在这里'.length);
  });

  it('完整解析用 merge 与 replace 结果相同（每页都被覆盖）', async () => {
    const s = await sources.importText('资料', '占位');
    await sources.writeSegments(
      s.id,
      Array.from({ length: 4 }, (_, i) => ({ page: i + 1, text: `旧${i + 1}` })),
      'ready',
    );
    await sources.writeSegments(
      s.id,
      Array.from({ length: 4 }, (_, i) => ({ page: i + 1, text: `新${i + 1}` })),
      'ready',
      'merge',
    );
    const segs = await sources.getSegments(s.id);
    expect(segs.map((x) => x.text)).toEqual(['新1', '新2', '新3', '新4']);
  });
});
