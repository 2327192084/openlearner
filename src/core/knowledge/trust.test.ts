import { describe, expect, it } from 'vitest';
import { locateQuotes } from './locator.ts';
import { MockBackend } from './mock-backend.ts';
import type { SourceSegment } from '../model.ts';
import type { KnowledgeDraft } from './backend-types.ts';

/**
 * 端到端可信度测试：证明「位置来自原文实测，不来自模型」。
 *
 * 这组测试的意义：P2 最容易出的错不是「定位不到」，而是
 * **模型说第 5 页，我们就信了第 5 页**。那样界面上点「看原文」
 * 会跳到一个错误的位置，而且看起来完全正常 —— 计划书称之为
 * 「指错页比不能跳转更糟，因为它冒充可信」。
 *
 * 所以这里直接模拟"模型撒谎"，验证系统不采信。
 */

function seg(page: number, text: string, chapter: string | null = null): SourceSegment {
  return {
    id: `seg_${page}`,
    sourceId: 'src_1',
    index: page,
    page,
    chapter,
    text,
    charCount: text.length,
  };
}

const SEGMENTS: SourceSegment[] = [
  seg(1, '第一章\n\n甲内容甲内容甲内容甲内容甲内容甲内容。', '第一章'),
  seg(2, '第二章\n\n乙内容乙内容乙内容乙内容乙内容乙内容。', '第二章'),
  seg(3, '第三章\n\n丙内容丙内容丙内容丙内容丙内容丙内容。', '第三章'),
];

describe('模型说什么页码都不影响结果', () => {
  it('后端返回的草稿里带 page 字段也不会被采纳', () => {
    // 真实内容在第 2 页，但模型"以为"在第 3 页
    const lyingDraft = {
      statement: '一条来自第 2 页的知识点',
      quotes: ['乙内容乙内容乙内容乙内容乙内容乙内容'], // 这段确实在第 2 页
      // 模拟模型多带了页码信息（即使接口没这个字段，真实模型输出常带）
      page: 3,
      cognitiveLevel: 'understand' as const,
      tags: [],
    } as unknown as KnowledgeDraft;

    // 定位器根本不看 draft.page
    const result = locateQuotes(SEGMENTS, lyingDraft.quotes, 'src_1');

    expect(result.located).toBe(true);
    // 实际落在第 2 页，不是模型说的第 3 页
    expect(result.anchors[0].page).toBe(2);
  });

  it('模型给出错误章节也不影响（章节取自命中段）', () => {
    const result = locateQuotes(SEGMENTS, ['丙内容丙内容丙内容'], 'src_1');

    expect(result.located).toBe(true);
    expect(result.anchors[0].page).toBe(3);
    // 章节来自真实段，不是任何外部声明
    expect(result.anchors[0].chapter).toBe('第三章');
  });
});

describe('假后端的输出必须能被自己的定位器定位', () => {
  it('假后端摘的每一条引用都能在原文里找到', async () => {
    const backend = new MockBackend(0);

    const result = await backend.organize({
      sourceTitle: '测试资料',
      segments: SEGMENTS.map((s) => ({
        segmentId: s.id,
        page: s.page,
        chapter: s.chapter,
        text: s.text,
      })),
      signal: new AbortController().signal,
    });

    expect(result.drafts.length).toBeGreaterThan(0);

    // 每一条草稿的引用都必须能定位成功 ——
    // 否则假后端就成了「制造定位失败」的机器，验收时会误导人
    for (const draft of result.drafts) {
      const located = locateQuotes(SEGMENTS, draft.quotes, 'src_1');
      expect(
        located.located,
        `假后端给的引用「${draft.quotes[0]}」应当能在原文里找到`,
      ).toBe(true);
    }
  });

  it('假后端产出的引用与原文逐字一致，不是改写过的', async () => {
    const backend = new MockBackend(0);
    const result = await backend.organize({
      sourceTitle: '测试资料',
      segments: SEGMENTS.map((s) => ({
        segmentId: s.id,
        page: s.page,
        chapter: s.chapter,
        text: s.text,
      })),
      signal: new AbortController().signal,
    });

    const allText = SEGMENTS.map((s) => s.text).join('\n');
    for (const draft of result.drafts) {
      for (const quote of draft.quotes) {
        // 假后端不该改写原文 —— 改写过就定位不到，验收会全红
        expect(allText).toContain(quote);
      }
    }
  });

  it('假后端遵守 onDraft 逐条回调契约', async () => {
    const backend = new MockBackend(0);
    const seen: string[] = [];

    const result = await backend.organize({
      sourceTitle: '测试资料',
      segments: SEGMENTS.map((s) => ({
        segmentId: s.id,
        page: s.page,
        chapter: s.chapter,
        text: s.text,
      })),
      signal: new AbortController().signal,
      onDraft: async (draft) => {
        seen.push(draft.statement);
      },
    });

    // 每一条都经过 onDraft，数量要一致
    expect(seen.length).toBe(result.drafts.length);
  });

  it('停止信号能让假后端提前结束', async () => {
    const backend = new MockBackend(20);
    const controller = new AbortController();
    let count = 0;

    const result = await backend.organize({
      sourceTitle: '测试资料',
      segments: SEGMENTS.map((s) => ({
        segmentId: s.id,
        page: s.page,
        chapter: s.chapter,
        text: s.text,
      })),
      signal: controller.signal,
      onDraft: async () => {
        count += 1;
        if (count >= 2) controller.abort();
      },
    });

    expect(result.stopped).toBe(true);
    // 停止后不应继续产出全部内容
    expect(result.drafts.length).toBeLessThan(9);
  });
});

describe('认知层级推断只是建议值', () => {
  it('定义类句子推为 remember', async () => {
    const backend = new MockBackend(0);
    const result = await backend.organize({
      sourceTitle: 't',
      segments: [
        {
          segmentId: 's1',
          page: 1,
          chapter: null,
          text: '线性表是指由 n 个数据元素构成的有限序列。',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(result.drafts[0].cognitiveLevel).toBe('remember');
  });

  it('比较类句子推为 analyze', async () => {
    const backend = new MockBackend(0);
    const result = await backend.organize({
      sourceTitle: 't',
      segments: [
        {
          segmentId: 's1',
          page: 1,
          chapter: null,
          text: '顺序表与链表在插入效率上的区别很明显，需要仔细比较优缺点。',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(result.drafts[0].cognitiveLevel).toBe('analyze');
  });
});

describe('不变量：unlocated 必须没有任何位置', () => {
  /**
   * 这条不变量是 P2 的核心约束，值得单独钉死。
   *
   * 早先 locateQuotes 在多引用场景下会返回 `anchors: 部分命中` 而 located=false，
   * 于是库里出现「状态=待处理 但带着位置」的矛盾数据。
   * 界面上会同时显示"待处理"徽标和可点的"看原文"，用户不知道该信哪个。
   */
  it('多引用里有一条找不到时，anchors 必须完全为空（不是部分保留）', () => {
    const result = locateQuotes(
      SEGMENTS,
      [
        '甲内容甲内容甲内容甲内容', // 第 1 页，能找到
        '这段内容原文里根本没有出现过', // 找不到
      ],
      'src_1',
    );

    expect(result.located).toBe(false);
    // 关键：不能返回部分命中的锚点
    expect(result.anchors).toEqual([]);
  });

  it('第一条能命中、第二条不能命中时也不保留任何位置', () => {
    const result = locateQuotes(
      SEGMENTS,
      ['乙内容乙内容乙内容乙内容', '完全不存在的内容啊同学们'],
      'src_1',
    );

    expect(result.located).toBe(false);
    expect(result.anchors).toEqual([]);
  });

  it('全部命中时才返回全部位置', () => {
    const result = locateQuotes(
      SEGMENTS,
      ['甲内容甲内容甲内容', '乙内容乙内容乙内容'],
      'src_1',
    );

    expect(result.located).toBe(true);
    expect(result.anchors).toHaveLength(2);
  });
});
