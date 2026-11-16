/**
 * 端到端验证：真跑一次解析，看任务记录会不会自动写进去（2026-11-17）。
 *
 * ## 为什么必须真跑
 *
 * 前一个脚本（verify-task-buckets.cjs）是**手写记录**进库，再验证任务页
 * 怎么显示 —— 那只能证明「显示层」对，证明不了「解析时真的会写记录」。
 *
 * 用户要的是「任务栏记录文档解析的任务」。如果 ConvertPanel 那边
 * 没接上 runRecorder，显示层再漂亮也是空的。这个项目因为
 * 「做了没接上」被投诉过多次，所以这一步不能省。
 *
 * ## 怎么跑
 *
 * 用真桌面版 + 隔离副本：
 *  1. 进「文档解析」，选那份 36 页的信号与系统
 *  2. 切到云 OCR（会真实计费约 0.05 元；比等 MinerU 几十分钟可行）
 *  3. 点解析
 *  4. 等结果，然后查 generationRuns 里有没有一条 kind='parse' 的记录
 *
 * ## 费用
 *
 * 约 0.05 元（36 页 × 1.5 元/1000 页）。只跑一次。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9890;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-e2e-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-e2e-app');

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
      }, 300000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(4500);

  /* 记下跑之前的解析记录数 */
  const before = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const rows = await new Promise((res) => {
      const rq = db.transaction('generationRuns','readonly').objectStore('generationRuns').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    db.close();
    return rows.filter(r => (r.kind || 'organize') === 'parse').length;
  })()`);
  console.log(`跑之前的解析记录数: ${before}`);

  /* 进文档解析页 */
  await evalJs(`(() => {
    for (const g of [...document.querySelectorAll('.nav-group')]) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    return true;
  })()`);
  await sleep(1200);
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('.nav-item')]) {
      const l = b.querySelector('.nav-item__label');
      if (l && l.innerText.trim() === '文档解析') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(3000);

  /* 选中「信号与系统」（有原件、36 页、避开网关上限） */
  const picked = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.pp-source')];
    for (const r of rows) {
      if (r.innerText.indexOf('信号与系统') >= 0) { r.click(); return r.innerText.replace(/\\s+/g,' ').slice(0, 40); }
    }
    return '';
  })()`);
  console.log(`选中的资料: ${picked}`);
  await sleep(2000);

  /* 切云 OCR */
  const cloud = await evalJs(`(() => {
    const r = document.querySelector('input[name="parse-engine"][value="deepseek"]');
    if (!r || r.disabled) return 'unavailable';
    r.click();
    return r.checked ? 'ok' : 'not-checked';
  })()`);
  console.log(`切到云 OCR: ${cloud}`);
  await sleep(6000);

  /* 点解析 */
  const clicked = await evalJs(`(() => {
    const panel = document.querySelector('.convert-panel');
    for (const b of [...(panel || document).querySelectorAll('button')]) {
      const t = b.innerText.trim();
      if (!b.disabled && (t.indexOf('识别') >= 0 || t.indexOf('解析') >= 0 || t.indexOf('转成正文') >= 0)) {
        b.click();
        return t;
      }
    }
    return '(没找到按钮)';
  })()`);
  console.log(`点了: ${clicked}`);

  /* 等结果（36 页约 7 秒，给足余量） */
  let sawRunningRun = false;
  let finalText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await evalJs(`(async () => {
      const dbs = await indexedDB.databases();
      const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      const rows = await new Promise((res) => {
        const rq = db.transaction('generationRuns','readonly').objectStore('generationRuns').getAll();
        rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
      });
      db.close();
      const parse = rows.filter(r => (r.kind || 'organize') === 'parse');
      const panel = (document.querySelector('.convert-panel') || {}).innerText || '';
      return {
        count: parse.length,
        running: parse.filter(r => r.status === 'running').length,
        latest: parse.length ? parse.sort((a,b)=> a.startedAt < b.startedAt ? 1 : -1)[0] : null,
        panel: panel.replace(/\\s+/g,' ').slice(0, 160),
      };
    })()`);

    if (st.running > 0) sawRunningRun = true;
    finalText = st.panel;

    /* 结束条件：记录数增加了，且没有 running 的了 */
    if (st.count > before && st.running === 0) {
      console.log(`\n面板: ${st.panel}`);
      rec('★ 解析时真的写了任务记录（数量 +1）', st.count === before + 1, `${before} → ${st.count}`);
      rec('★ 跑的过程中出现过「进行中」状态', sawRunningRun === true);
      rec(
        '★ 跑完后状态是终态（不再卡在进行中）',
        st.latest && st.latest.status !== 'running',
        st.latest ? `${st.latest.status} / ${st.latest.producedCount} 页` : '(无)',
      );
      rec(
        '★ 记录里有页码范围与引擎',
        Boolean(st.latest && st.latest.pageRange !== undefined && st.latest.backendId),
        st.latest ? `backend=${st.latest.backendId}` : '',
      );
      break;
    }
  }

  if (!results.length) {
    rec('★ 解析时真的写了任务记录', false, `等待超时，面板=${finalText.slice(0, 120)}`);
  }

  const failed = results.filter((r) => !r.pass);
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
