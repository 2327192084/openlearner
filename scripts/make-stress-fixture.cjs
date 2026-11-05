/**
 * 生成「50 页教材」压力测试样本。
 *
 * 计划书 P4「算做完」最后一条：**50 页教材一次生成不崩**。
 * 现有 fixture（course.pdf）只有 3 页，验不出这一点 ——
 * 3 页教材上永远不会暴露的瓶颈，在 50 页上可能是致命的：
 *   - 知识点数量涨 16 倍，PPT 页数、引用表、角标编号都跟着涨
 *   - 导出时 pptxgenjs 要处理几百个文本框
 *   - 全文搜索与定位器要在大文本上跑
 *
 * 为什么单独一个脚本而不是加进 make-fixtures.cjs：
 * 这份样本 1MB+，只在压力验收时用；把它塞进常规 fixture 目录会让
 * 每次跑单测都要多读一次大文件，而单测其实并不需要它。
 *
 * 跑法：node scripts/make-stress-fixture.cjs
 * 产物：src/test/fixtures/large-50p.pdf（需要提交）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const TMP = path.join(__dirname, '..', '.scratch', 'stress');

const PAGE_COUNT = 50;

/**
 * 造 50 页内容。
 *
 * 刻意做成「每页有独立标题 + 3~5 段、每段 30~80 字」的样子：
 * 这和真实教材的密度接近，也保证知识点提取有足够素材。
 * 如果每页只有一句话，50 页也造不出压力。
 */
const TOPICS = [
  '数据结构绪论', '线性表', '栈与队列', '串与数组', '树与二叉树',
  '图与网络', '查找方法', '排序算法', '递归与分治', '动态规划',
];

const ASPECTS = [
  '基本概念与术语定义',
  '逻辑结构与物理结构',
  '核心操作的实现思路',
  '时间复杂度与空间复杂度',
  '典型应用场景',
];

function buildPages() {
  const pages = [];
  for (let i = 0; i < PAGE_COUNT; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    const aspect = ASPECTS[Math.floor(i / TOPICS.length) % ASPECTS.length];
    const chapter = Math.floor(i / 5) + 1;
    pages.push({
      title: `第 ${chapter} 章 ${topic} · ${aspect}`,
      blocks: [
        `${topic}的${aspect}是本课程的基础内容，理解它有助于后续章节的学习。` +
          `本页是整份讲义的第 ${i + 1} 页，属于第 ${chapter} 章。`,
        `${topic}在实践中经常与相邻知识点一起出现，需要结合具体例子理解，` +
          `不能只记住结论而忽略推导过程。这一点在考试中经常被考查。`,
        `学习者应当能够用自己的话复述${topic}的要点，并说明它在什么情况下适用、` +
          `在什么情况下不适用，这样才能真正掌握而不是机械记忆。`,
        i % 3 === 0
          ? `典型例题会给出一个具体场景，要求判断应选择哪种方案，并说明理由与代价。`
          : `练习题通常要求分析复杂度、写出关键步骤，并指出容易出错的地方。`,
      ],
    });
  }
  return pages;
}

function htmlShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: "Microsoft YaHei", "SimSun", serif; font-size: 12pt; line-height: 1.9; color: #000; }
  h1 { font-size: 15pt; margin: 0 0 12pt; }
  p { margin: 0 0 10pt; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
</style></head><body>
<h1 style="font-size:20pt">数据结构与算法 综合讲义（${PAGE_COUNT} 页压力样本）</h1>
<p style="margin-bottom:18pt">本文件由 scripts/make-stress-fixture.cjs 生成，用于验证「50 页教材一次生成不崩」。</p>
${bodyHtml}
</body></html>`;
}

function buildHtml(pages) {
  const body = pages
    .map(
      (p) =>
        `<div class="page"><h1>${p.title}</h1>${p.blocks.map((b) => `<p>${b}</p>`).join('')}</div>`,
    )
    .join('\n');
  return htmlShell('数据结构综合讲义', body);
}

async function printToPdf(html, outFile) {
  fs.mkdirSync(TMP, { recursive: true });
  const htmlFile = path.join(TMP, 'large-50p.html');
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
        '--disable-extensions',
        `--print-to-pdf=${outFile}`,
        '--no-pdf-header-footer',
        `file:///${htmlFile.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Edge 退出码 ${code}`))));
    child.on('error', reject);
  });

  // 等文件落盘
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!fs.existsSync(outFile)) throw new Error('PDF 没有生成');
  await new Promise((r) => setTimeout(r, 1200));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pages = buildPages();
  console.log(`准备打印 ${pages.length} 页…`);

  const out = path.join(OUT, 'large-50p.pdf');
  await printToPdf(buildHtml(pages), out);

  const size = fs.statSync(out).size;
  console.log(`large-50p.pdf  ${size} bytes  (${(size / 1024).toFixed(0)} KB)`);

  // 粗验页数（PDF 里 /Type /Page 的个数，不含 /Pages）
  const raw = fs.readFileSync(out).toString('latin1');
  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`页数约 ${pageCount}`);

  // 期望内容清单：压力验收里用来核对「100% 内容都能被定位」
  const expectations = {
    note: '由 scripts/make-stress-fixture.cjs 生成。',
    pageCount,
    firstPage: pages[0].title,
    lastPage: pages[pages.length - 1].title,
    // 抽查用的引用片段（必须逐字出现在对应页正文里）
    samples: [
      { title: pages[0].title, snippet: pages[0].blocks[0].slice(0, 20) },
      { title: pages[24].title, snippet: pages[24].blocks[1].slice(0, 20) },
      { title: pages[49].title, snippet: pages[49].blocks[0].slice(0, 20) },
    ],
  };
  fs.writeFileSync(
    path.join(OUT, 'expectations-large.json'),
    JSON.stringify(expectations, null, 2),
    'utf-8',
  );
  console.log('expectations-large.json 已写入');
}

main().catch((err) => {
  console.error('生成失败：', err);
  process.exit(1);
});
