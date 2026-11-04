import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { parseDocx } from './docx.ts';
import { parsePptx } from './pptx.ts';
import { parseMarkdown, parseText } from './text.ts';
import { detectFormat, parseAny, titleFromFileName } from './index.ts';
import { ImportError } from './types.ts';

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

const expectations = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf-8'),
) as {
  course: { pageCount: number; pages: { page: number; chapter: string; mustContain: string[] }[] };
};

describe('PPTX：按幻灯片切分', () => {
  it('段数等于幻灯片数，page 与 index 一致', async () => {
    const doc = await parsePptx(readFixture('course.pptx'), { title: '演示文稿' });

    expect(doc.pageCount).toBe(expectations.course.pageCount);
    expect(doc.segments).toHaveLength(expectations.course.pageCount);
    doc.segments.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.page).toBe(i + 1);
    });
  });

  it('每张幻灯片包含自己那页的文字', async () => {
    const doc = await parsePptx(readFixture('course.pptx'));

    for (const expected of expectations.course.pages) {
      const seg = doc.segments.find((s) => s.page === expected.page);
      expect(seg).toBeDefined();
      for (const fragment of expected.mustContain) {
        expect(seg!.text, `第 ${expected.page} 页应含「${fragment}」`).toContain(fragment);
      }
    }
  });

  it('跨页不串：第 1 页不含第 3 页文字', async () => {
    const doc = await parsePptx(readFixture('course.pptx'));
    expect(doc.segments[0].text).not.toContain('后进先出');
    expect(doc.segments[2].text).not.toContain('非线性结构');
  });

  /**
   * 这条是整个 P1 里最重要的一条测试。
   *
   * PowerPoint 调整页序时只改 presentation.xml 里的 sldIdLst 顺序，
   * **不改文件名**。如果按 slide1/slide2 文件名排序，页序就和用户看到的不一致，
   * 导致「点回原文」指到错误的幻灯片 —— 计划书特别警告「指错页比不能跳转更糟」。
   *
   * 这里构造一份「sldIdLst 顺序与文件名顺序相反」的 PPTX 来验证。
   */
  it('页序以 presentation.xml 的 sldIdLst 为准，不按文件名排序', async () => {
    const zip = new JSZip();

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
</Types>`,
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    );

    // 关键：先引用 rId2（slide2.xml），再引用 rId1（slide1.xml）
    // 也就是说用户看到的第 1 页，文件名叫 slide2.xml
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst>
  <p:sldId id="257" r:id="rId2"/>
  <p:sldId id="256" r:id="rId1"/>
</p:sldIdLst>
</p:presentation>`,
    );

    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`,
    );

    const mkSlide = (text: string) =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

    zip.file('ppt/slides/slide1.xml', mkSlide('文件里叫 slide1 但显示在第二页'));
    zip.file('ppt/slides/slide2.xml', mkSlide('文件里叫 slide2 但显示在第一页'));

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const doc = await parsePptx(new Uint8Array(buf));

    // 显示顺序：第 1 页必须是 rId2 指向的内容
    expect(doc.segments[0].text).toContain('显示在第一页');
    expect(doc.segments[1].text).toContain('显示在第二页');
  });

  it('纯图片 PPT 标为无文本层，而不是报错', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    );
    // 只有图形，没有 a:t 文字
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`,
    );

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const doc = await parsePptx(new Uint8Array(buf));
    expect(doc.textStatus).toBe('no-text-layer');
  });
});

describe('DOCX：按章节切分', () => {
  it('按 Heading1 切成三章', async () => {
    const doc = await parseDocx(readFixture('course.docx'), { title: '讲义' });

    expect(doc.pageCount).toBe(3);
    expect(doc.segments).toHaveLength(3);
  });

  it('章节名取自标题，正文归属正确章节', async () => {
    const doc = await parseDocx(readFixture('course.docx'));

    for (const expected of expectations.course.pages) {
      const seg = doc.segments.find((s) => s.page === expected.page);
      expect(seg).toBeDefined();
      expect(seg!.chapter).toBe(expected.chapter);
      for (const fragment of expected.mustContain) {
        expect(seg!.text).toContain(fragment);
      }
    }
  });

  it('表格里的文字也会被读到', async () => {
    // 教材里表格常承载重要内容，只取顶层段落会漏掉
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file(
      'word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格里的关键定义</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>表格外的正文</w:t></w:r></w:p></w:body></w:document>`,
    );

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const doc = await parseDocx(new Uint8Array(buf));
    const all = doc.segments.map((s) => s.text).join('\n');

    expect(all).toContain('表格里的关键定义');
    expect(all).toContain('表格外的正文');
  });

  it('损坏的 docx 报文件损坏', async () => {
    const error = await parseDocx(new Uint8Array([1, 2, 3, 4])).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('corrupted');
  });
});

describe('Markdown：按 # 标题切章', () => {
  it('切成三章且章节名正确', async () => {
    const doc = await parseMarkdown(readFixture('notes.md'));

    expect(doc.segments).toHaveLength(3);
    expect(doc.segments[0].chapter).toBe('第一章 数据结构绪论');
    expect(doc.segments[2].chapter).toBe('第三章 栈与队列');
  });

  it('正文文字完整保留', async () => {
    const doc = await parseMarkdown(readFixture('notes.md'));
    for (const expected of expectations.course.pages) {
      const seg = doc.segments.find((s) => s.chapter === expected.chapter);
      expect(seg).toBeDefined();
      for (const fragment of expected.mustContain.slice(1)) {
        expect(seg!.text).toContain(fragment);
      }
    }
  });

  it('剥掉 markdown 符号但不动文字', async () => {
    const md = new TextEncoder().encode(
      '# 标题\n\n**加粗**与*斜体*，还有 [链接文字](https://example.com) 和 `代码`。\n',
    );
    const doc = await parseMarkdown(md);
    const text = doc.segments[0].text;

    expect(text).toContain('加粗');
    expect(text).toContain('斜体');
    expect(text).toContain('链接文字');
    expect(text).toContain('代码');
    // 符号应当消失
    expect(text).not.toContain('**');
    expect(text).not.toContain('https://example.com');
  });

  it('代码块里的 # 不当标题', async () => {
    const md = new TextEncoder().encode(
      '# 真标题\n\n```\n# 这是注释不是标题\n```\n\n正文。\n',
    );
    const doc = await parseMarkdown(md);

    // 只有「真标题」一章，代码块里的 # 不能开新章
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0].chapter).toBe('真标题');
  });
});

describe('纯文本：按段落聚合', () => {
  it('没有标题时也能切出内容', async () => {
    const doc = await parseText(readFixture('plain.txt'));
    expect(doc.segments.length).toBeGreaterThan(0);
    const all = doc.segments.map((s) => s.text).join('\n');
    expect(all).toContain('线性表是由 n 个数据元素构成的有限序列');
  });

  it('空文件报「内容为空」', async () => {
    const error = await parseText(new Uint8Array([])).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as ImportError).code).toBe('empty');
  });

  it('非 UTF-8 文件明确提示改编码，而不是给出乱码', async () => {
    // GBK 的「中文」两个字
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const error = await parseText(gbk).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ImportError);
    const e = error as ImportError;
    // 乱码进库之后「点回原文」就全废了，宁可拒绝
    expect(e.code).toBe('unsupported-format');
    expect(e.hint).toMatch(/UTF-8/);
  });

  it('UTF-8 BOM 被正确剥掉', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# 标题\n\n正文')]);
    const doc = await parseMarkdown(withBom);
    expect(doc.segments[0].chapter).toBe('标题');
  });
});

describe('格式嗅探：按内容而不是只看扩展名', () => {
  it('扩展名说谎时以魔数为准', () => {
    const pdfLike = new TextEncoder().encode('%PDF-1.7 里面其实是 PDF');
    // 文件名说它是 txt，但内容是 PDF
    expect(detectFormat('其实是pdf.txt', pdfLike)).toBe('pdf');
  });

  it('docx / pptx 靠扩展名区分（魔数都是 zip）', () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectFormat('a.docx', zipMagic)).toBe('docx');
    expect(detectFormat('a.pptx', zipMagic)).toBe('pptx');
  });

  it('扩展名不明时解开 zip 看内部结构', async () => {
    // 把真实 docx 存成 .bin，应当还能识别
    const docx = readFixture('course.docx');
    const doc = await parseAny('无扩展名.bin', docx);
    expect(doc.segments.length).toBe(3);
  });

  it('不支持的格式给出明确说明', async () => {
    const xlsxLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const error = await parseAny('表格.xlsx', xlsxLike).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as ImportError).code).toBe('unsupported-format');
  });

  it('0 字节文件报空', async () => {
    const error = await parseAny('空.txt', new Uint8Array([])).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as ImportError).code).toBe('empty');
  });
});

describe('titleFromFileName', () => {
  it('去掉扩展名', () => {
    expect(titleFromFileName('数据结构复习.pdf')).toBe('数据结构复习');
  });

  it('去掉路径', () => {
    expect(titleFromFileName('C:\\Users\\a\\课件.pptx')).toBe('课件');
    expect(titleFromFileName('/home/u/lecture.md')).toBe('lecture');
  });

  it('多点文件名只去最后一个扩展名', () => {
    expect(titleFromFileName('第1章.v2.docx')).toBe('第1章.v2');
  });
});
