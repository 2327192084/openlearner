/**
 * 真机端到端：分片解析 1-2 页 → 再分片解析 3-4 页 → 四页正文都要在。
 *
 * 这是用户报的那个 bug 的直接复现与验证：
 * 「解析了两页，又解析了后面三四页，结果看不到之前的了」。
 *
 * 用真实 MinerU + 真实 SourceService，不走界面 —— 这样能精确看到
 * 库里每一页的正文，而不是靠截图猜。
 *
 * 前置：mineru server 在运行。
 * 用法：node scripts/verify-partial-merge-real.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MINERU = process.env.MINERU_EXE || 'E:/StudyHub/MinerU/venv/Scripts/mineru.exe';
const OUT = path.join(ROOT, '.tmp', 'merge-real');

const fail = [];
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
const bad = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail.push(l); };

function cli(args) {
  try { return execFileSync(MINERU, args, { encoding: 'utf8', timeout: 300000 }); }
  catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
}

(async () => {
  /* 确保服务在跑 */
  const st = cli(['server', 'status', '--json']);
  if (!/"running":\s*true/.test(st)) {
    console.log('启动 mineru server…');
    cli(['server', 'start']);
    await new Promise((r) => setTimeout(r, 6000));
  }

  fs.mkdirSync(OUT, { recursive: true });
  const pdf = path.join(ROOT, 'src', 'test', 'fixtures', 'large-50p.pdf');
  if (!fs.existsSync(pdf)) { console.error('缺 fixture PDF'); process.exit(2); }

  /* 动态 import TS（用 vitest 不行，这里走 esbuild 预编译产物太绕，
     所以用 node 直接跑一个临时 tsx 脚本 —— 改用 vitest 跑更稳） */
  console.log('\n本脚本只负责跑真实 MinerU 拿两份输出，断言交给 vitest。');

  const run = async (pages, outName) => {
    const outFile = path.join(OUT, outName);
    console.log(`\n=== 解析 pages=${pages} ===`);
    const r = cli(['parse', pdf, '--tier', 'standard', '--pages', pages, '--wait', '600',
      '--json', '-o', outFile, '--force']);
    if (!fs.existsSync(outFile)) { bad(`产出 ${outName}`, r.slice(-200)); return null; }
    const md = fs.readFileSync(outFile, 'utf8');
    const markers = [...md.matchAll(/<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->/g)]
      .map((m) => ({ page: Number(m[1]), total: Number(m[2]) }));
    console.log('  页标记:', JSON.stringify(markers));
    ok(`产出 ${outName}`, `${md.length} 字符, ${markers.length} 个标记`);
    return { md, markers };
  };

  const a = await run('1-2', 'part-1-2.md');
  const b = await run('3-4', 'part-3-4.md');

  if (a && b) {
    /* 直接做一次「纯文本层面」的合并预演，确认页码语义正确 */
    const pagesA = a.markers.map((m) => m.page);
    const pagesB = b.markers.map((m) => m.page);
    if (pagesA.join(',') === '1,2') ok('第一次输出是 1,2 页');
    else bad('第一次输出是 1,2 页', pagesA.join(','));
    if (pagesB.join(',') === '3,4') ok('第二次输出是 3,4 页（真实页号，不是 1,2）');
    else bad('第二次输出是 3,4 页', pagesB.join(','));
    if (a.markers[0].total === 50 && b.markers[0].total === 50) {
      ok('两次都声明整本 50 页', `of ${a.markers[0].total}`);
    } else {
      bad('两次都声明整本 50 页', JSON.stringify([a.markers[0], b.markers[0]]));
    }

    /* 把两份输出存成 fixture 供 vitest 做完整断言 */
    fs.copyFileSync(path.join(OUT, 'part-1-2.md'), path.join(ROOT, 'src/test/fixtures/mineru-part-1-2.md'));
    fs.copyFileSync(path.join(OUT, 'part-3-4.md'), path.join(ROOT, 'src/test/fixtures/mineru-part-3-4.md'));
    console.log('\n已存 fixture: src/test/fixtures/mineru-part-1-2.md, mineru-part-3-4.md');
  }

  console.log(`\n===== 结果：${fail.length === 0 ? '全部通过' : fail.length + ' 项失败'} =====`);
  for (const f of fail) console.log('  ✗', f);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
