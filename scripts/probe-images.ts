/**
 * 探针：能不能从现有解析链路里拿到「图」。
 *
 * 计划书 P4 功能第 2 条要求「标题页 / 要点页 / 图文页」。
 * 要做图文页，先得回答一个事实问题：我们的资料来源里有图吗？
 *
 * 当前导入链路只存抽出来的文字，**不存原始文件字节**，
 * 所以要么在导入时顺手把图抽出来存下，要么就没有图可用。
 * 这个脚本先回答「抽得出来吗、抽出来多大」。
 *
 * 用法：npx vite-node scripts/probe-images.ts <pdf/docx/pptx 路径>
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import JSZip from 'jszip';

async function probePdf(path: string): Promise<void> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const loadingTask = getDocument({ data, useSystemFonts: false });
  const pdf = await loadingTask.promise;
  console.log(`PDF 页数：${pdf.numPages}`);

  const pagesToCheck = Math.min(pdf.numPages, 12);
  let totalImages = 0;
  const samples: Array<{ page: number; width: number; height: number; bytes?: number }> = [];

  for (let p = 1; p <= pagesToCheck; p += 1) {
    const page = await pdf.getPage(p);
    const ops = await page.getOperatorList();
    // OPS.paintImageXObject 的名字在不同版本里不同，按常量表找
    const imageOps = ops.fnArray.filter((fn: number) => {
      const name = ops.fnArray.length ? null : null;
      void name;
      return fn === 85 /* paintImageXObject */ || fn === 82 /* paintImageMaskXObject */;
    });
    if (imageOps.length > 0) {
      totalImages += imageOps.length;
      // 取第一个图像对象看尺寸
      for (let i = 0; i < ops.fnArray.length; i += 1) {
        if (ops.fnArray[i] === 85) {
          const objId = ops.argsArray[i][0] as string;
          try {
            const img = await new Promise<{ width: number; height: number; data?: Uint8Array }>(
              (resolve, reject) => {
                page.objs.get(objId, (obj: { width: number; height: number; data?: Uint8Array }) =>
                  resolve(obj),
                );
                setTimeout(() => reject(new Error('timeout')), 3000);
              },
            );
            samples.push({
              page: p,
              width: img.width,
              height: img.height,
              bytes: img.data ? img.data.length : undefined,
            });
          } catch {
            samples.push({ page: p, width: -1, height: -1 });
          }
          break;
        }
      }
    }
    page.cleanup();
  }

  console.log(`前 ${pagesToCheck} 页图像绘制指令：${totalImages} 处`);
  console.log('样本：', JSON.stringify(samples.slice(0, 8), null, 2));
  await loadingTask.destroy();
}

async function probeZip(path: string): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const media = Object.keys(zip.files).filter((n) => /(^|\/)media\//.test(n));
  console.log(`内嵌媒体文件：${media.length} 个`);
  const rows: Array<{ name: string; bytes: number }> = [];
  for (const name of media.slice(0, 12)) {
    const buf = await zip.file(name)!.async('uint8array');
    rows.push({ name, bytes: buf.length });
  }
  console.table(rows);
  const total = (
    await Promise.all(
      media.map(async (n) => (await zip.file(n)!.async('uint8array')).length),
    )
  ).reduce((a, b) => a + b, 0);
  console.log(`媒体总量：${(total / 1024 / 1024).toFixed(2)} MB`);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('用法：npx vite-node scripts/probe-images.ts <文件路径>');
    process.exit(1);
  }
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') await probePdf(path);
  else if (ext === '.docx' || ext === '.pptx') await probeZip(path);
  else console.error(`不支持的扩展名：${ext}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
