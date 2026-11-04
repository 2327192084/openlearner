/**
 * PDF 文字层诊断工具。
 *
 * 用户导入真实教材后读不出文字时，用它对文件做一次体检，
 * 判断到底是「扫描件」还是「编码没解开」，以及缺什么。
 *
 * 用法：
 *   node scripts/diagnose-pdf.cjs "C:\path\to\your.pdf"
 *
 * 只做诊断，不修改文件、不上传任何内容。
 */

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node scripts/diagnose-pdf.cjs <pdf 路径>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`找不到文件: ${file}`);
    process.exit(1);
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const size = fs.statSync(file).size;
  const buf = fs.readFileSync(file);

  console.log('='.repeat(60));
  console.log(`文件: ${path.basename(file)}`);
  console.log(`大小: ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('='.repeat(60));

  // ---- 原始字节层面的证据（不依赖 pdfjs）----
  const raw = buf.toString('latin1');
  console.log('\n【原始结构】');
  console.log(`  含 /Image 对象      : ${/\/Subtype\s*\/Image/.test(raw) ? '是' : '否'}`);
  console.log(`  含 /Font 对象       : ${/\/Type\s*\/Font/.test(raw) ? '是' : '否'}`);
  console.log(`  含 Identity-H       : ${/Identity-H/.test(raw) ? '是' : '否'}`);
  console.log(`  含 ToUnicode        : ${/ToUnicode/.test(raw) ? '是' : '否'}`);
  const cmapNames = [...raw.matchAll(/\/(UniGB-[A-Z0-9-]+|GBK-EUC-[HV]|GB-[A-Z0-9-]+|UniCNS-[A-Z0-9-]+|UniJIS-[A-Z0-9-]+|UniKS-[A-Z0-9-]+)/g)]
    .map((m) => m[1]);
  console.log(
    `  引用的预定义 CMap  : ${cmapNames.length > 0 ? [...new Set(cmapNames)].join(', ') : '无'}`,
  );

  // ---- pdfjs 实际提取（不配 cMap）----
  async function extract(withCmap) {
    const opts = { data: new Uint8Array(buf), useSystemFonts: true };
    if (withCmap) {
      opts.cMapUrl = `file:///${path.join(process.cwd(), 'public', 'cmaps').replace(/\\/g, '/')}/`;
      opts.cMapPacked = true;
      opts.standardFontDataUrl = `file:///${path.join(process.cwd(), 'public', 'standard_fonts').replace(/\\/g, '/')}/`;
    }
    try {
      const doc = await pdfjs.getDocument(opts).promise;
      const pages = Math.min(doc.numPages, 5);
      let totalChars = 0;
      let sample = '';
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items.filter((it) => 'str' in it).map((it) => it.str).join('');
        totalChars += text.replace(/\s/g, '').length;
        if (!sample && text.trim()) sample = text.trim().slice(0, 100);
      }
      const numPages = doc.numPages;
      await doc.destroy?.();
      return { ok: true, numPages, totalChars, sample };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 200) };
    }
  }

  console.log('\n【文字提取】');
  const without = await extract(false);
  console.log(`  不配 cMap: ${without.ok ? `${without.totalChars} 字（前 ${Math.min(without.numPages, 5)} 页）` : `失败: ${without.error}`}`);
  if (without.ok && without.sample) console.log(`    样例: ${without.sample}`);

  const withCmap = await extract(true);
  console.log(`  配了 cMap: ${withCmap.ok ? `${withCmap.totalChars} 字（前 ${Math.min(withCmap.numPages, 5)} 页）` : `失败: ${withCmap.error}`}`);
  if (withCmap.ok && withCmap.sample) console.log(`    样例: ${withCmap.sample}`);

  // ---- 结论 ----
  console.log('\n【结论】');
  const noText = !without.ok || without.totalChars < 20;
  const cmapHelped = withCmap.ok && withCmap.totalChars > (without.ok ? without.totalChars : 0) + 20;

  if (!noText) {
    console.log('  ✓ 能读出文字，属于正常文件。');
    console.log('    如果软件里仍报「无文字层」，请把这份诊断输出发给我们。');
  } else if (cmapHelped) {
    console.log('  ⚠ 这是「解码失败」：文件里有字，但不配 cMap 读不出来。');
    console.log('    → 说明软件需要 cMap 支持（我们已在 P5 补上）。');
    console.log('    → 请更新到最新版本后重新导入。');
  } else if (/\/Type\s*\/Font/.test(raw)) {
    console.log('  ⚠ 文件里有字体对象，但两种方式都读不出文字。');
    console.log('    → 可能是字体子集化过于激进，或编码方式特殊。');
    console.log('    → 请把这个 PDF 反馈给我们，可以针对性支持。');
  } else if (/\/Subtype\s*\/Image/.test(raw)) {
    console.log('  ● 这是扫描件：文字在图片里，文件本身没有文本层。');
    console.log('    → 需要 OCR（P6 的看图识别）或换一份电子版。');
  } else {
    console.log('  ? 无法判定。请把这份诊断输出发给我们。');
  }
  console.log('');
}

main().catch((err) => {
  console.error('诊断失败:', err);
  process.exit(2);
});
