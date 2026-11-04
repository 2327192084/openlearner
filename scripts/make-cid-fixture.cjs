/**
 * 构造一份「只有 Identity-H、没有 ToUnicode」的中文 PDF。
 *
 * 这是真实教材最常见、也正是我们之前读不出文字的那类文件。
 * 用来验证两件事：
 *   1. 配了 cMap 之后能不能正确解码中文
 *   2. 不配 cMap 时是否被正确识别为「解码失败」而不是「扫描件」
 *
 * 手写 PDF 结构（不引第三方库）：一份最小但合法的 PDF，
 * 字体用 Type0 + Identity-H 编码 + 一个 CIDFont，
 * 并且**刻意不写 ToUnicode**。
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'test', 'fixtures', 'cid-no-tounicode.pdf');

/** 要写进 PDF 的中文文本（与 course.pdf 内容一致，便于对照） */
const LINES = [
  '第一章 数据结构绪论',
  '数据结构研究的是数据元素之间的关系以及在这些关系上的操作。',
  '逻辑结构分为线性结构与非线性结构两大类。',
];

/**
 * 把中文转成 CID。
 *
 * 简化处理：用字符的 Unicode 码位本身当 CID。
 * 配合下面 ToUnicode 缺失 + Identity-H 的设置，
 * pdfjs 必须靠 cMap（UniGB-UCS2-H）才能把 CID 还原成字符。
 * 这正是我们要测的路径。
 */
function toCidHex(text) {
  const cids = [];
  for (const ch of text) {
    cids.push(ch.codePointAt(0).toString(16).padStart(4, '0').toUpperCase());
  }
  return cids.join('');
}

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ---- 组装 PDF ----
const objects = [];

// 1: Catalog
objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
// 2: Pages
objects.push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);

// 3: Page（A4，带字体资源）
objects.push(
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
);

/**
 * 4: Type0 字体
 *
 * Encoding 用 UniGB-UCS2-H：这是中文 PDF 里最常见的预定义 CMap 名。
 * pdfjs 看到它就会去找 cmaps/UniGB-UCS2-H.bcmap ——
 * 如果不配 cMapUrl，这一步失败，文字取不出来。
 */
objects.push(
  `<< /Type /Font /Subtype /Type0 /BaseFont /SimSun ` +
    `/Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>`,
);

// 5: 内容流
const contentLines = LINES.map((line, i) => {
  const y = 780 - i * 40;
  return `BT /F1 14 Tf 60 ${y} Td <${toCidHex(line)}> Tj ET`;
}).join('\n');
const stream = contentLines;
objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);

// 6: CIDFont
objects.push(
  `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> ` +
    `/FontDescriptor 7 0 R /DW 1000 >>`,
);

// 7: FontDescriptor
objects.push(
  `<< /Type /FontDescriptor /FontName /SimSun /Flags 6 ` +
    `/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 ` +
    `/CapHeight 880 /StemV 93 >>`,
);

// ---- 序列化 ----
let pdf = '%PDF-1.4\n';
const offsets = [];

objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += `0000000000 65535 f \n`;
for (const off of offsets) {
  pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
pdf += `startxref\n${xrefStart}\n%%EOF\n`;

fs.writeFileSync(OUT, Buffer.from(pdf, 'latin1'));
console.log(`已生成: ${OUT}`);
console.log(`大小: ${fs.statSync(OUT).size} 字节`);
console.log(`编码: UniGB-UCS2-H（需要 cMap），ToUnicode: 无`);
