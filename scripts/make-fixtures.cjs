/**
 * 生成 P1 解析器的测试样本（fixtures）。
 *
 * 为什么要自己造样本：本机没有任何可用 PDF/DOCX/PPTX，
 * 而位置映射的准确性必须对着**已知内容的文件**验，不能对着随手下的课件猜。
 * 这些 fixture 的每一页写了什么、第几页，都由本脚本决定，测试里可以直接引用。
 *
 * 生成方式：
 *   - PDF：Edge 无头模式 --print-to-pdf 打印 HTML。
 *     这样产出的 PDF 有真实文本层与内嵌中文字体，和真课件同构。
 *     （不像手搓 PDF 只能写拉丁字符，验不出中文断行与字距的问题）
 *   - 扫描版 PDF：同一套 —— 但正文画在 <canvas> 里，所以没有文本层。
 *     这正是「扫描件读不出文字」的等价物，用于验证能否识别并给出建议。
 *   - DOCX / PPTX：用 JSZip 拼最小合法的 Open XML 包。
 *   - MD / TXT：直接写文本。
 *
 * 跑法： node scripts/make-fixtures.cjs
 * 产物写到 src/test/fixtures/，**需要提交**，这样测试不依赖浏览器。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', '.scratch', 'fixtures');

/** 精简版中文假课件：三页，每页内容固定，测试里逐字引用 */
const COURSE_PAGES = [
  {
    title: '第一章 数据结构绪论',
    blocks: [
      '数据结构研究的是数据元素之间的关系以及在这些关系上的操作。',
      '逻辑结构分为线性结构与非线性结构两大类。线性结构包括线性表、栈、队列、串；非线性结构包括树与图。',
      '存储结构又称物理结构，是逻辑结构在计算机中的表示，常见的有顺序存储与链式存储。',
    ],
  },
  {
    title: '第二章 线性表',
    blocks: [
      '线性表是由 n 个数据元素构成的有限序列，n 称为表长。',
      '顺序表用一段地址连续的存储单元依次存放元素，支持随机访问，插入与删除需要移动元素。',
      '链表通过指针连接结点，插入与删除不需要移动元素，但查找必须从头开始。',
    ],
  },
  {
    title: '第三章 栈与队列',
    blocks: [
      '栈是只允许在一端进行插入和删除的线性表，遵循后进先出原则。',
      '队列只允许在一端插入、另一端删除，遵循先进先出原则。',
      '循环队列用取模运算把顺序存储的首尾相接，解决了假溢出的问题。',
    ],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function htmlShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: "Microsoft YaHei", "SimSun", serif; font-size: 12pt; line-height: 1.9; color: #000; }
  h1 { font-size: 16pt; margin: 0 0 12pt; }
  p { margin: 0 0 10pt; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
</style></head><body>${bodyHtml}</body></html>`;
}

/** 正常 PDF：三页，每页一个标题 + 三段正文 */
function buildCourseHtml() {
  const pages = COURSE_PAGES.map(
    (p) =>
      `<div class="page"><h1>${p.title}</h1>${p.blocks.map((b) => `<p>${b}</p>`).join('')}</div>`,
  ).join('\n');
  return htmlShell('数据结构复习讲义', pages);
}

/**
 * 扫描版 PDF：同样的三页外观，但文字画在 canvas 上。
 * 打印到 PDF 后是位图，**没有文本层** —— 用来验证扫描件识别。
 */
function buildScannedHtml() {
  const pages = COURSE_PAGES.map(
    (p) => `
    <div class="page">
      <canvas class="scan" width="1200" height="1700"></canvas>
      <script>
        (function(){
          const c = document.currentScript.previousElementSibling;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height);
          ctx.fillStyle = '#111';
          ctx.font = 'bold 40px "Microsoft YaHei", sans-serif';
          ctx.fillText(${JSON.stringify(p.title)}, 80, 130);
          ctx.font = '30px "Microsoft YaHei", sans-serif';
          const lines = ${JSON.stringify(p.blocks)};
          let y = 220;
          for (const line of lines) {
            // 简单折行：每 26 个字符一行，够用即可
            for (let i = 0; i < line.length; i += 26) {
              ctx.fillText(line.slice(i, i + 26), 80, y);
              y += 56;
            }
            y += 30;
          }
        })();
      </script>
    </div>`,
  ).join('\n');
  return htmlShell('扫描件', pages).replace(
    '.page { page-break-after: always; }',
    '.page { page-break-after: always; } canvas.scan { width: 100%; height: auto; display: block; }',
  );
}

async function printToPdf(html, outFile, { waitMs = 2500 } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const htmlFile = path.join(TMP, `${path.basename(outFile, '.pdf')}.html`);
  fs.writeFileSync(htmlFile, html, 'utf-8');
  fs.rmSync(outFile, { force: true });

  await new Promise((resolve, reject) => {
    const child = spawn(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--run-all-compositor-stages-before-draw',
        `--virtual-time-budget=${waitMs}`,
        `--print-to-pdf=${outFile}`,
        '--no-pdf-header-footer',
        `file:///${htmlFile.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`))));
  });

  // --print-to-pdf 是异步落盘，等文件稳定
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 500) return;
    await sleep(150);
  }
  throw new Error(`PDF 未生成: ${outFile}`);
}

// ---------------------------------------------------------------------------
// DOCX / PPTX：最小合法 Open XML
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function makeDocx(outFile) {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  // 用 Heading1 样式区分章节，验证按章节切分
  const paras = COURSE_PAGES.flatMap((p) => [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(p.title)}</w:t></w:r></w:p>`,
    ...p.blocks.map(
      (b) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(b)}</w:t></w:r></w:p>`,
    ),
  ]).join('');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`,
  );

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outFile, buf);
}

async function makePptx(outFile) {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${COURSE_PAGES.map(
  (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
).join('\n')}
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  );

  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst>${COURSE_PAGES.map(
      (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`,
    ).join('')}</p:sldIdLst>
</p:presentation>`,
  );

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${COURSE_PAGES.map(
  (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
).join('\n')}
</Relationships>`,
  );

  COURSE_PAGES.forEach((page, i) => {
    // 每张幻灯片：标题 + 要点，用 sp 结构承载
    const paragraphs = [page.title, ...page.blocks]
      .map(
        (t) =>
          `<a:p><a:r><a:t>${escapeXml(t)}</a:t></a:r></a:p>`,
      )
      .join('');

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
    );
  });

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outFile, buf);
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log(`输出目录: ${OUT}\n`);

  // 1. 正常 PDF
  const coursePdf = path.join(OUT, 'course.pdf');
  await printToPdf(buildCourseHtml(), coursePdf);
  console.log(`course.pdf          ${fs.statSync(coursePdf).size} bytes`);

  // 2. 扫描版 PDF（无文本层）
  const scannedPdf = path.join(OUT, 'scanned.pdf');
  await printToPdf(buildScannedHtml(), scannedPdf, { waitMs: 4000 });
  console.log(`scanned.pdf         ${fs.statSync(scannedPdf).size} bytes`);

  // 3. DOCX
  const docx = path.join(OUT, 'course.docx');
  await makeDocx(docx);
  console.log(`course.docx         ${fs.statSync(docx).size} bytes`);

  // 4. PPTX
  const pptx = path.join(OUT, 'course.pptx');
  await makePptx(pptx);
  console.log(`course.pptx         ${fs.statSync(pptx).size} bytes`);

  // 5. Markdown（带 # 标题，验证按章节切分）
  const md = COURSE_PAGES.map(
    (p) => `# ${p.title}\n\n${p.blocks.map((b) => `${b}\n`).join('\n')}`,
  ).join('\n');
  fs.writeFileSync(path.join(OUT, 'notes.md'), md, 'utf-8');
  console.log(`notes.md            ${Buffer.byteLength(md)} bytes`);

  // 6. 纯文本（无标题，只能按段落切）
  const txt = COURSE_PAGES.flatMap((p) => [p.title, ...p.blocks]).join('\n\n');
  fs.writeFileSync(path.join(OUT, 'plain.txt'), txt, 'utf-8');
  console.log(`plain.txt           ${Buffer.byteLength(txt)} bytes`);

  // 7. 损坏文件（验证「文件损坏」错误分类）
  const brokenPdf = Buffer.from('%PDF-1.4\n这是故意写坏的，没有 xref 与 trailer\n%%EOF');
  fs.writeFileSync(path.join(OUT, 'broken.pdf'), brokenPdf);
  console.log(`broken.pdf          ${brokenPdf.length} bytes（故意损坏）`);

  // 8. 不支持格式（验证「格式不支持」）
  fs.writeFileSync(path.join(OUT, 'unsupported.xlsx.rename'), 'not really a workbook');
  console.log(`unsupported.*       不支持格式样本`);

  // 9. 期望内容清单，测试里引用它断言
  const expectations = {
    note: '由 scripts/make-fixtures.cjs 生成。测试断言以此为准。',
    course: {
      pageCount: COURSE_PAGES.length,
      pages: COURSE_PAGES.map((p, i) => ({
        page: i + 1,
        chapter: p.title,
        /** 该页应当包含的原文片段（逐字取自 HTML） */
        mustContain: [p.title, ...p.blocks],
      })),
    },
    /** 用来验证「指到哪一页」的检索词 → 期望页码 */
    locate: [
      { query: '数据结构研究的是数据元素之间的关系', expectedPage: 1 },
      { query: '线性表是由 n 个数据元素构成的有限序列', expectedPage: 2 },
      { query: '栈是只允许在一端进行插入和删除的线性表', expectedPage: 3 },
      { query: '循环队列用取模运算', expectedPage: 3 },
    ],
    /** 只出现在某一页的独特词，用于全文搜索命中数断言 */
    uniqueTerms: [
      { term: '假溢出', page: 3 },
      { term: '随机访问', page: 2 },
      { term: '非线性结构', page: 1 },
    ],
  };
  fs.writeFileSync(
    path.join(OUT, 'expectations.json'),
    JSON.stringify(expectations, null, 2),
    'utf-8',
  );
  console.log(`expectations.json   已写入\n`);
  console.log('完成。');
}

main().catch((err) => {
  console.error('生成 fixtures 失败:', err);
  process.exit(1);
});
