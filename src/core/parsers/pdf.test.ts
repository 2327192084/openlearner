import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parsePdf } from './pdf.ts';
import { ImportError } from './types.ts';

/**
 * PDF 解析的位置准确性测试。
 *
 * 这是计划书第 7 节点名的重点：「抽查最关键的一条——任意一条知识点／一道题／
 * 一个 PPT 角标，点回原文是否真的落在正确位置。指错页比不能跳转更糟。」
 *
 * 所以这里不测「有没有解析出文本」，而测**「哪句话在哪一页」对不对**。
 * 期望值来自 fixtures/expectations.json，即生成样本时写下的固定内容。
 */

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');

interface Expectations {
  course: {
    pageCount: number;
    pages: { page: number; chapter: string; mustContain: string[] }[];
  };
  locate: { query: string; expectedPage: number }[];
  uniqueTerms: { term: string; page: number }[];
}

const expectations: Expectations = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf-8'),
);

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

/** 把整份文档拼成「每页文本」数组，下标 0 = 第 1 页 */
async function parseCourse() {
  const doc = await parsePdf(readFixture('course.pdf'), { title: '数据结构复习讲义' });
  return doc;
}

describe('PDF 按页切分', () => {
  it('页数与文件一致', async () => {
    const doc = await parseCourse();
    expect(doc.pageCount).toBe(expectations.course.pageCount);
    expect(doc.segments).toHaveLength(expectations.course.pageCount);
  });

  it('段序号从 1 开始且连续，page 与 index 一致', async () => {
    const doc = await parseCourse();
    doc.segments.forEach((seg, i) => {
      expect(seg.index).toBe(i + 1);
      expect(seg.page).toBe(i + 1);
    });
  });

  it('每一页都包含该页应有的原文片段', async () => {
    const doc = await parseCourse();
    for (const expected of expectations.course.pages) {
      const seg = doc.segments.find((s) => s.page === expected.page);
      expect(seg, `第 ${expected.page} 页应当存在`).toBeDefined();

      for (const fragment of expected.mustContain) {
        // 关键断言：原文片段必须逐字出现在**这一页**，而不是别的页
        expect(
          seg!.text.includes(fragment),
          `第 ${expected.page} 页应包含「${fragment}」\n实际内容：${seg!.text}`,
        ).toBe(true);
      }
    }
  });

  it('跨页不串内容：第 1 页不含第 3 页的文本', async () => {
    const doc = await parseCourse();
    const page1 = doc.segments[0].text;
    const page3 = doc.segments[2].text;

    expect(page1).not.toContain('后进先出');
    expect(page3).not.toContain('非线性结构');
  });
});

describe('「点回原文」定位准确性（核心验收）', () => {
  it('任意一句话都能定位到正确的那一页', async () => {
    const doc = await parseCourse();

    for (const { query, expectedPage } of expectations.locate) {
      const hits = doc.segments.filter((s) => s.text.includes(query));
      expect(hits.length, `「${query}」应恰好命中一页，实际命中 ${hits.length} 页`).toBe(1);
      expect(hits[0].page, `「${query}」应落在第 ${expectedPage} 页`).toBe(expectedPage);
    }
  });

  it('独特词只出现在期望的页，用于全文搜索命中数断言', async () => {
    const doc = await parseCourse();

    for (const { term, page } of expectations.uniqueTerms) {
      const hits = doc.segments.filter((s) => s.text.includes(term));
      expect(hits.length, `「${term}」应只命中 1 页`).toBe(1);
      expect(hits[0].page).toBe(page);
    }
  });

  it('段落内字符偏移能精确切回原文片段', async () => {
    const doc = await parseCourse();
    const seg = doc.segments[2]; // 第 3 页
    const target = '循环队列用取模运算';

    const start = seg.text.indexOf(target);
    expect(start).toBeGreaterThanOrEqual(0);

    // 模拟 P2 会用到的用法：存 charStart/charEnd，之后按偏移取回
    const charStart = start;
    const charEnd = start + target.length;
    expect(seg.text.slice(charStart, charEnd)).toBe(target);
  });
});

describe('文本规范化：PDF 行尾硬断必须接回去', () => {
  it('被行尾断开的句子在结果里是连续的', async () => {
    const doc = await parseCourse();

    // 实测发现 pdfjs 会把这句断成「…非线性」+「结构包括树与图。」
    // 规范化后必须能整句搜到，否则全文搜索形同虚设
    const full = doc.segments.map((s) => s.text).join('\n');
    expect(full).toContain('非线性结构包括树与图');
  });

  it('英文断行处补空格，不把单词粘在一起', async () => {
    const doc = await parseCourse();
    const page2 = doc.segments[1].text;
    // 「线性表是由 n 个数据元素…」里 n 两侧本来就该有空格，不能被吃掉
    expect(page2).toContain('n 个数据元素');
  });

  it('段落之间用空行分隔，而不是一行一段', async () => {
    const doc = await parseCourse();
    const page1 = doc.segments[0].text;
    const paragraphs = page1.split('\n\n').filter((p) => p.trim());

    // 第 1 页是 1 个标题 + 3 段正文 = 4 块。
    // 如果规范化失败（每行一块），这里会变成 8 块以上
    expect(paragraphs.length).toBe(4);
  });
});

describe('扫描件识别（读不出文字的 PDF）', () => {
  it('没有文本层时如实标为 no-text-layer，而不是抛错', async () => {
    const doc = await parsePdf(readFixture('scanned.pdf'), { title: '扫描件' });

    // 计划书要求：「一份扫描版 PDF（读不出文字）能被识别并给出下一步建议」
    // 它是可导入的（能翻看），所以不能当失败
    expect(doc.textStatus).toBe('no-text-layer');
    expect(doc.pageCount).toBe(3);
  });

  it('扫描件的每页文本都是空的，不伪造内容', async () => {
    const doc = await parsePdf(readFixture('scanned.pdf'), { title: '扫描件' });

    for (const seg of doc.segments) {
      expect(seg.text.replace(/\s/g, '')).toBe('');
    }
  });

  it('正常 PDF 不会被误判成扫描件', async () => {
    const doc = await parseCourse();
    expect(doc.textStatus).toBe('ready');
  });
});

describe('失败分类：坏文件必须说清原因', () => {
  it('损坏的 PDF 报「文件损坏」，不报内部错误', async () => {
    const broken = readFixture('broken.pdf');

    // 只解析一次、只捕获一次。
    // 早先这里连着调了两遍 parsePdf，第二次在 try 外抛出，
    // 导致断言拿到的是 undefined —— 测试写错，不是实现错。
    const error = await parsePdf(broken).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ImportError);
    const e = error as ImportError;
    expect(e.code).toBe('corrupted');
    // hint 必须可操作，不能只说"失败"
    expect(e.hint).toMatch(/另存|重新/);
  });

  it('根本不是 PDF 的文件报「文件损坏」并指出缺文件头', async () => {
    const notPdf = new TextEncoder().encode('这只是一段普通文本，不是 PDF');

    await expect(parsePdf(notPdf)).rejects.toThrow(/不是有效的 PDF/);
  });

  it('空文件的失败原因说得清', async () => {
    await expect(parsePdf(new Uint8Array(0))).rejects.toThrow(/PDF/);
  });
});
