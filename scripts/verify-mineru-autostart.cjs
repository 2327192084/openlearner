/**
 * 真机验证「按资料分组」…不对，是「MinerU 服务自动启动」（2026-11-11）。
 *
 * 用户提出的问题：「如果用户不懂如何启动 mineru 服务怎么办？
 * 有没有办法让后端配置的 AI 帮忙解决？」
 *
 * 答案：既不用 AI，也不用用户操作 —— 程序自己启动。
 * 本脚本直接调用主进程那份真实实现，验证三条路径：
 *   1. 服务在跑     → 立刻返回 started:false（不多花时间）
 *   2. 服务没跑     → 真的把它启起来，返回 started:true
 *   3. 服务刚启起来 → 后续 parse 不再撞 server_not_running
 *
 * 为什么用真机脚本而不是单测：
 * 这段逻辑的价值全在「和真实子进程打交道」——
 * 注入假 execFile 只能验证分支，验不到「mineru server start 真的有用」。
 * 单测写不下去时，真机验证是更诚实的做法（而且留下的是可复现的证据）。
 *
 * 用法：node scripts/verify-mineru-autostart.cjs
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINERU = process.env.MINERU_EXE || 'E:/StudyHub/MinerU/venv/Scripts/mineru.exe';

const mineru = require(path.join(ROOT, 'electron', 'mineru.cjs'));

const fail = [];
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
const bad = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args) {
  try {
    return execFileSync(MINERU, args, { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
}

function isRunning() {
  const out = cli(['server', 'status', '--json']);
  try {
    return JSON.parse(out.slice(out.indexOf('{')))?.running === true;
  } catch {
    return false;
  }
}

(async () => {
  console.log('MinerU:', MINERU);

  /* ---------- 1. 已在运行时不多花时间 ---------- */
  console.log('\n=== 1. 服务已在运行 → 快路径 ===');
  if (!isRunning()) {
    cli(['server', 'start']);
    await sleep(4000);
  }
  if (!isRunning()) { bad('前置：服务已在运行'); }
  else {
    const t0 = Date.now();
    const r = await mineru.ensureServerRunning(MINERU);
    const sec = (Date.now() - t0) / 1000;
    console.log('  ', JSON.stringify(r), `${sec.toFixed(1)}s`);
    if (r.ok && r.started === false) ok('返回 ok 且 started=false（不是它启的）', `${sec.toFixed(1)}s`);
    else bad('返回 ok 且 started=false', JSON.stringify(r));
    if (sec < 10) ok('快路径不超过 10 秒', `${sec.toFixed(1)}s`);
    else bad('快路径不超过 10 秒', `${sec.toFixed(1)}s`);
  }

  /* ---------- 2. 服务没跑 → 自动启动 ---------- */
  console.log('\n=== 2. 服务停掉 → 自动启动 ===');
  cli(['server', 'stop']);
  await sleep(3000);
  if (isRunning()) bad('前置：服务已停');
  else {
    ok('前置：服务确实停了（这就是用户会遇到的状态）');
    const t0 = Date.now();
    const r = await mineru.ensureServerRunning(MINERU);
    const sec = (Date.now() - t0) / 1000;
    console.log('  ', JSON.stringify(r), `${sec.toFixed(1)}s`);
    if (r.ok && r.started === true) ok('★ 自动启动成功（用户不用敲任何命令）', `${sec.toFixed(1)}s`);
    else bad('★ 自动启动成功', JSON.stringify(r));
    if (isRunning()) ok('启动后 status 确认在运行');
    else bad('启动后 status 确认在运行');
  }

  /* ---------- 3. 启动后 parse 不再撞 server_not_running ---------- */
  console.log('\n=== 3. 启动后立刻解析，确认不再报服务未运行 ===');
  const fs = require('node:fs');
  const outDir = path.join(ROOT, '.tmp', 'autostart-job');
  fs.mkdirSync(outDir, { recursive: true });
  const pdf = path.join(ROOT, 'src', 'test', 'fixtures', 'large-50p.pdf');
  if (!fs.existsSync(pdf)) {
    console.log('  SKIP  缺 fixture PDF');
  } else {
    const res = await mineru.runMineru(
      { filePath: pdf, outDir, tier: 'standard', pages: '1-2' },
      { exePath: MINERU },
    );
    /*
     * runMineru 的返回形状：`{ ok:true, result:{ markdown, outFile } }`。
     * markdown 是原始 Markdown 字符串，**不是**已解析的 pages。
     * 上一版我按 pages 取，所以 undefined —— 记在这里免得再犯。
     */
    const md = res.ok ? String(res.result?.markdown ?? '') : '';
    const pageMarkers = [...md.matchAll(/<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->/g)].map((m) => ({
      page: Number(m[1]),
      total: Number(m[2]),
    }));

    console.log('  ', JSON.stringify({
      ok: res.ok,
      trouble: res.trouble ?? null,
      mdLen: md.length,
      markers: pageMarkers,
    }));

    if (res.ok) ok('分片解析成功（第 1-2 页）', `markdown ${md.length} 字符`);
    else bad('分片解析成功', `${res.trouble}: ${String(res.message).slice(0, 100)}`);

    if (pageMarkers.length > 0) {
      if (pageMarkers[0].page === 1) ok('★ 请求 1-2 页，输出从第 1 页开始', JSON.stringify(pageMarkers));
      else bad('请求 1-2 页，输出从第 1 页开始', JSON.stringify(pageMarkers));
      if (pageMarkers.every((m) => m.total === 50)) ok('声明总页数仍是整本的 50');
      else bad('声明总页数仍是 50', JSON.stringify(pageMarkers));
    } else {
      bad('输出里有页码标记', '一个都没找到');
    }
  }

  console.log(`\n===== 结果：${fail.length === 0 ? '全部通过' : fail.length + ' 项失败'} =====`);
  for (const f of fail) console.log('  ✗', f);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
