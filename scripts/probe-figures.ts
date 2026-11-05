/**
 * 探针：PDF 里的插图到底是位图还是矢量图。
 *
 * 这决定了「图文页」该怎么实现。
 *
 * 如果是位图（paintImageXObject），直接抽出来即可；
 * 如果是矢量图（一堆 path / stroke / fill 指令），
 * 抽出「内嵌图片」什么也得不到 —— 教材里的电路图、坐标系、
 * 波形图基本都是矢量绘制。那时唯一通用的办法是把该页**渲染**成图片。
 *
 * 用法：npx vite-node scripts/probe-figures.ts <pdf>
 */
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('用法：npx vite-node scripts/probe-figures.ts <pdf>');
    process.exit(1);
  }

  const loadingTask = getDocument({ data: new Uint8Array(readFileSync(path)) });
  const pdf = await loadingTask.promise;
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  console.log(`文件：${path}`);
  console.log(`页数：${pdf.numPages}\n`);

  const pagesToCheck = Math.min(pdf.numPages, 10);
  for (let p = 1; p <= pagesToCheck; p += 1) {
    const page = await pdf.getPage(p);
    const ops = await page.getOperatorList();

    let images = 0;
    let paths = 0;
    let strokes = 0;
    let fills = 0;
    let texts = 0;

    for (const fn of ops.fnArray) {
      if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) images += 1;
      else if (fn === OPS.constructPath) paths += 1;
      else if (fn === OPS.stroke) strokes += 1;
      else if (fn === OPS.fill || fn === OPS.eoFill) fills += 1;
      else if (fn === OPS.showText) texts += 1;
    }

    console.log(
      `第 ${String(p).padStart(2)} 页  位图 ${String(images).padStart(3)}  路径 ${String(paths).padStart(4)}  描边 ${String(strokes).padStart(4)}  填充 ${String(fills).padStart(4)}  文字块 ${texts}`,
    );
    page.cleanup();
  }

  await loadingTask.destroy();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
