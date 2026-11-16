/**
 * 验证任务页三栏分类 + 解析任务记录（2026-11-17）。
 *
 * ## 用户的要求
 *
 * 「任务栏没有记录文档解析的任务，把这个加上去。
 *   同时任务栏也做分类，未完成；进行中；已完成三种。
 *   其中未完成和进行中可以通过点击相关任务转到对应功能界面
 *   选择重新进行任务或是查看任务进度。」
 *
 * ## 验什么
 *
 * 1. 任务页真的有「未完成 / 进行中 / 已完成」三栏
 * 2. 每栏显示计数
 * 3. 造一条「解析」运行记录 → 出现在任务页，且标为「文档解析」
 * 4. 那条记录**不被误判成出题**（这正是改之前 `!isOrganize` 的 bug）
 * 5. 未完成/进行中的解析记录有「去重新解析 / 去看进度」按钮
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9880;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-task-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-task-app');

  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(copy, { recursive: true });
  fs.cpSync(path.join(src, 'IndexedDB'), path.join(copy, 'IndexedDB'), { recursive: true });

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  const unpacked = path.join(ROOT, 'release', 'win-unpacked');
  for (const name of fs.readdirSync(unpacked)) {
    if (name === 'openleaner-data') continue;
    fs.cpSync(path.join(unpacked, name), path.join(appDir, name), { recursive: true });
  }

  const app = spawn(
    path.join(appDir, 'OpenLeaner.exe'),
    [`--user-data-dir=${copy}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    app.kill();
    throw new Error('应用没起来');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => {
        if (pending.has(n)) {
          pending.delete(n);
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(4500);

  /* ---------- 1. 先造三条解析记录：进行中 / 未完成 / 已完成 ---------- */
  const seeded = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });

    /* 先拿一份真实资料的 id，好让跳转按钮有意义 */
    const sources = await new Promise((res) => {
      const rq = db.transaction('sources','readonly').objectStore('sources').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const src0 = sources[0];
    if (!src0) { db.close(); return { ok: false, why: '库里没有资料' }; }

    const base = (id, status, produced, startedAt, error) => ({
      id, kind: 'parse', sourceId: src0.id, pageRange: { from: 1, to: 442 }, status,
      estimatedTokens: null, actualTokens: null, producedCount: produced, unlocatedCount: 0,
      error: error || null, backendId: 'deepseek-ocr', startedAt,
      finishedAt: status === 'running' ? null : startedAt,
    });

    const rows = [
      base('run_test_done', 'completed', 442, '2026-11-17T00:00:00.000Z', null),
      base('run_test_running', 'running', 0, '2026-11-17T01:00:00.000Z', null),
      base('run_test_failed', 'failed', 0, '2026-11-17T00:30:00.000Z', '请求体太大'),
    ];
    const tx = db.transaction('generationRuns', 'readwrite');
    for (const r of rows) tx.objectStore('generationRuns').put(r);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    db.close();
    return { ok: true, count: rows.length, sourceTitle: src0.title };
  })()`);

  if (!seeded.ok) {
    rec('能造测试记录', false, seeded.why);
    app.kill();
    process.exit(1);
  }
  rec('造了 3 条解析记录（完成/进行中/失败）', true, `${seeded.count} 条`);

  /* ---------- 2. 进任务页 ---------- */
  await evalJs(`(() => {
    for (const g of [...document.querySelectorAll('.nav-group')]) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    return true;
  })()`);
  await sleep(1200);
  const navOk = await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('.nav-item')]) {
      const l = b.querySelector('.nav-item__label');
      if (l && l.innerText.trim() === '任务') { b.click(); return 'ok'; }
    }
    return 'not-found';
  })()`);
  await sleep(3000);

  const page = await evalJs(`(() => {
    const title = (document.querySelector('.topbar__title') || {}).innerText || '';
    const buckets = [...document.querySelectorAll('.tk-bucket')].map(b => ({
      cls: b.className,
      title: (b.querySelector('.tk-bucket__title') || {}).innerText || '',
      count: (b.querySelector('.tk-bucket__count') || {}).innerText || '',
      items: [...b.querySelectorAll('.tk-item')].map(i => ({
        kind: (i.querySelector('.tk-item__kind') || {}).innerText || '',
        target: (i.querySelector('.tk-item__target') || {}).innerText || '',
        meta: (i.querySelector('.tk-item__meta') || {}).innerText || '',
        buttons: [...i.querySelectorAll('button')].map(x => x.innerText.trim()),
      })),
    }));
    return { title, buckets };
  })()`);

  console.log(`\n  顶栏: ${page.title}`);
  for (const b of page.buckets) {
    console.log(`  [${b.title}] ${b.items.length} 项`);
    for (const it of b.items.slice(0, 3)) {
      console.log(`     - ${it.kind} / ${it.target.slice(0, 20)} / ${it.meta.replace(/\s+/g,' ')}`);
    }
  }
  console.log('');

  /* ---------- 3. 断言 ---------- */
  rec('在任务页', page.title === '任务', page.title);

  const titles = page.buckets.map((b) => b.title.replace(/\d+$/, '').trim());
  rec('★ 有三栏：未完成 / 进行中 / 已完成', titles.length === 3, JSON.stringify(titles));
  rec('★ 栏名正确', ['未完成', '进行中', '已完成'].every((t) => titles.includes(t)), JSON.stringify(titles));

  /* 我们造的记录必须落在正确的栏里 */
  const byTitle = (t) => page.buckets.find((b) => b.title.indexOf(t) >= 0);
  const doneB = byTitle('已完成');
  const runB = byTitle('进行中');
  const todoB = byTitle('未完成');

  const isParse = (it) => it.kind.indexOf('文档解析') >= 0;
  rec('★ 已完成栏里有解析记录（442 页）', Boolean(doneB?.items.some((i) => isParse(i) && i.meta.includes('442'))));
  rec('★ 进行中栏里有解析记录', Boolean(runB?.items.some(isParse)));
  rec('★ 未完成栏里有解析记录（失败那条）', Boolean(todoB?.items.some(isParse)));

  /*
   * 最关键的一条否定断言：解析记录**不能**被显示成「出题」。
   * 改之前 TasksPage 用 `!isOrganize(r)` 分派，parse 会落进出题。
   */
  const allItems = page.buckets.flatMap((b) => b.items);
  const parseAsQuestion = allItems.filter((i) => i.kind.indexOf('出题') >= 0 && i.meta === '' && false);
  void parseAsQuestion;
  const wrongKind = allItems.filter((i) => i.kind === '出题' && i.meta.indexOf('442') >= 0 && i.meta.indexOf('页') >= 0);
  rec('★ 解析记录没被误判成「出题」', wrongKind.length === 0, `${wrongKind.length} 条误判`);

  /* 跳转按钮 */
  const runningItem = runB?.items.find(isParse);
  const todoItem = todoB?.items.find(isParse);
  rec(
    '★ 进行中的解析有「去看解析进度」按钮',
    Boolean(runningItem?.buttons.some((t) => t.indexOf('进度') >= 0)),
    JSON.stringify(runningItem?.buttons ?? []),
  );
  rec(
    '★ 未完成的解析有「去重新解析」按钮',
    Boolean(todoItem?.buttons.some((t) => t.indexOf('重新解析') >= 0)),
    JSON.stringify(todoItem?.buttons ?? []),
  );

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(2);
});