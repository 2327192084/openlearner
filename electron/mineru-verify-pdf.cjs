/**
 * 生成一个最小的、**真正能被解析**的 PDF，用于安装后的端到端验收。
 *
 * ## 为什么不能用 --version 当验收
 *
 * 我第一版就是这么干的：跑 `mineru --version` 成功就报「安装完成」。
 * 但 `--version` 只证明**程序能启动**，证明不了：
 *   - 模型下全了没有
 *   - onnxruntime 能不能加载
 *   - 真的吐不吐出 markdown
 *
 * 实测后果：模型目录只有 .locks 和空壳子的时候，
 * 验收照样「通过」—— 这正是硬约束里「不做假开关」的反面。
 *
 * ## 这个 PDF 里有什么
 *
 * 手写一个最小合法 PDF（不引第三方库）：一页 A4，
 * 一行足够大的英文文本 `HELLO MINERU TEST`。
 * 文字够大是为了让 OCR / 版面识别都能稳定认出来。
 *
 * 参考 PDF 1.4 规范的最小子集：catalog → pages → page → contents → font。
 */

'use strict';

const fs = require('node:fs');

/**
 * 构造最小可解析 PDF 的字节。
 *
 * 为什么手写而不是用 pdf-lib：验收代码不该给主程序加依赖，
 * 而且这个 PDF 只有一页一行字，手写反而更透明、可审。
 */
function buildMinimalPdf() {
  const text = 'HELLO MINERU TEST 12345';

  /* 内容流：定位到页面中间偏上，用 36pt 大字 */
  const content = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET`;

  const objects = [
    /* 1: Catalog */
    '<< /Type /Catalog /Pages 2 0 R >>',
    /* 2: Pages */
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    /* 3: Page（A4 = 595x842） */
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    /* 4: 内容流 */
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    /* 5: 字体（Helvetica 是 PDF 的 14 个标准字体之一，不必内嵌） */
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** 写出验收用 PDF，返回路径 */
function writeVerifyPdf(dest) {
  const buf = buildMinimalPdf();
  fs.mkdirSync(require('node:path').dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

/** 验收时要在输出里找到的关键词（大写比较，OCR 大小写可能不稳） */
const VERIFY_KEYWORD = 'MINERU';

module.exports = { buildMinimalPdf, writeVerifyPdf, VERIFY_KEYWORD };
