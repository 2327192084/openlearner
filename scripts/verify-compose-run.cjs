/**
 * 验证 AI 组卷会在任务栏留下记录（2026-11-17）。
 *
 * 用户要求：「这个让 ai 组卷的过程在任务栏目里面也要有记录」。
 *
 * ## 验什么
 *
 * 走真实界面点一次「让 AI 组卷」（会花约 0.01 元），然后：
 *  1. 任务页出现一条「AI 组卷」记录
 *  2. 状态是「已完成」，不是卡在「进行中」
 *  3. 显示「挑出 N 题」与真实 token
 *  4. 有跳转到模拟考页的按钮
 *
 * ## 为什么必须真跑
 *
 * 记录是在 `onAiCompose` 的前后写的。只看代码「应该会写」不算数 ——
 * 这个项目因「做了没接上」被投诉过多次。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9950;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-crun-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-crun-app');

  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(copy, { recursive: true });
  fs.cpSync(path.join(src, 'IndexedDB'), path.join(copy, 'IndexedDB'), { recursive: true });
  fs.cpSync(path.join(src, 'Local Storage'), path.join(copy, 'Local Storage'), { recursive: true });

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
      }, 180000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const nav = async (label) => {
    await evalJs(`(() => {
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      return true;
    })()`);
    await sleep(1000);
    const ok = await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item')]) {
        const l = b.querySelector('.nav-item__label');
        if (l && l.innerText.trim() === ${JSON.stringify(label)}) { b.click(); return true; }
      }
      return false;
    })()`);
    await sleep(2800);
    return ok;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4500);

  /* 先记下跑之前的组卷记录数 */
  const before = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const rows = await new Promise((res) => {
      const rq = db.transaction('generationRuns','readonly').objectStore('generationRuns').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    db.close();
    return rows.filter(r => r.kind === 'compose').length;
  })()`);
  console.log(`跑之前的组卷记录数: ${before}`);

  /* 进模拟考 → 点 AI 组卷 */
  await nav('模拟考试');
  const clicked = await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim().indexOf('让 AI 组卷') >= 0) { b.click(); return true; }
    }
    return false;
  })()`);
  rec('点了「让 AI 组卷」', clicked === true);

  /* 等组卷完成（推理模型约 10 秒，给足余量） */
  let done = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    done = await evalJs(`(() => {
      const inExam = !!document.querySelector('.ex-nav');
      const err = document.querySelector('.ex-note--bad');
      return { inExam, err: err ? err.innerText : null };
    })()`);
    if (done.inExam || done.err) break;
  }
  rec('组卷成功（进了考试界面）', done.inExam === true, done.err ?? '');
  if (!done.inExam) {
    app.kill();
    process.exit(1);
  }

  /* 去任务页看记录 */
  await nav('任务');
  const taskView = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.tk-item')].map(it => ({
      kind: (it.querySelector('.tk-item__kind') || {}).innerText || '',
      target: (it.querySelector('.tk-item__target') || {}).innerText || '',
      meta: (it.querySelector('.tk-item__meta') || {}).innerText.replace(/\\s+/g,' ') || '',
      buttons: [...it.querySelectorAll('button')].map(b => b.innerText.trim()),
      badge: (it.querySelector('.tk-badge') || {}).innerText || '',
    }));
    return items.filter(i => i.kind.indexOf('AI 组卷') >= 0);
  })()`);

  console.log(`\n  任务页里的 AI 组卷记录: ${JSON.stringify(taskView).slice(0, 400)}\n`);

  rec('★ 任务页出现了「AI 组卷」记录', taskView.length >= 1, `${taskView.length} 条`);
  const latest = taskView[0];
  if (latest) {
    rec('★ 状态是「完成」而不是卡在「进行中」', latest.badge.indexOf('完成') >= 0, latest.badge);
    rec('★ 显示「挑出 N 题」', latest.meta.indexOf('挑出') >= 0, latest.meta);
    /*
     * token 断言：数字带千分位逗号（「4,086 tokens」）。
     * 第一版用 /\\d/ 但先 replace('挑出','') 又拼接字符串，把逗号也算错了 ——
     * 直接匹配「数字 空格 tokens」这个形状更可靠。
     */
    rec('★ 记录了真实 token（不是空的）', /[\d,]+ tokens/.test(latest.meta), latest.meta);
    rec('★ 有去模拟考页的按钮', latest.buttons.some((b) => b.indexOf('组卷') >= 0 || b.indexOf('模拟考') >= 0), JSON.stringify(latest.buttons));
  }

  /* 库里也应该真的多了一条 */
  const after = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const rows = await new Promise((res) => {
      const rq = db.transaction('generationRuns','readonly').objectStore('generationRuns').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    db.close();
    const compose = rows.filter(r => r.kind === 'compose');
    return { count: compose.length, latest: compose[compose.length - 1] };
  })()`);
  rec('★ 库里确实多了一条组卷记录', after.count === before + 1, `${before} → ${after.count}`);
  rec('记录里有 producedCount 与 actualTokens', after.latest?.producedCount > 0 && after.latest?.actualTokens > 0,
    `picked=${after.latest?.producedCount} tokens=${after.latest?.actualTokens}`);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, '.verify-shots/compose-run-20261117/tasks.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`截图: ${out}`);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
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
