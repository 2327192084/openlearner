/**
 * 只读探针：数一个 openleaner 数据目录里各分区有多少条真实记录。
 *
 * 为什么需要：判断「备份是不是完整的用户库」不能靠 grep 字符串
 * （leveldb 是追加写的，删掉的记录还在 .log 里，字符串计数会把
 * 已删除的也算上，结论会反）。必须让 Chromium 自己打开 IndexedDB 去数。
 *
 * 做法：把数据目录复制一份，用 Electron 以 file:// 打开一个最小页面，
 * 在里面 open 库并 count()。只读源目录，不写。
 *
 * 用法：node scripts/probe-lib-counts.cjs --data <.tmp 副本> [--port 9700]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const DATA = path.resolve(ROOT, arg('data', ''));
const PORT = Number(arg('port', '9700'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORES = ['sources','sourceSegments','knowledgePoints','questions','decks','reviewRecords','settings','oralReviews','flashcards','sourceImages','meta','courses'];

(async () => {
  if (!DATA || !fs.existsSync(DATA)) { console.error('用法: --data <.tmp 副本>'); process.exit(2); }
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  // 用一个最小页面：只需能跑脚本、有 IndexedDB
  const page = path.join(DATA, '__probe.html');
  fs.writeFileSync(page, '<!doctype html><title>probe</title>');
  const app = spawn(exe, [page, `--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=800,600'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && String(t.url).includes('__probe.html'));
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) { app.kill(); throw new Error('Electron 没起来'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 1; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 20000); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  await send('Runtime.enable');
  await sleep(1500);
  const out = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    if (!name) return { ok: false, why: 'no db', dbs: dbs.map(d => d.name) };
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const count = (s) => new Promise((res) => { if (!db.objectStoreNames.contains(s)) { res(null); return; } const rq = db.transaction(s, 'readonly').objectStore(s).count(); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const counts = {};
    for (const s of ${JSON.stringify(STORES)}) counts[s] = await count(s);
    const out = { ok: true, db: name, version: db.version, stores: db.objectStoreNames.length, counts };
    db.close();
    return out;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  try { fs.unlinkSync(page); } catch {}
  app.kill();
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(400);
  process.exit(0);
})().catch((e) => { console.error('探针失败:', e.message); process.exit(1); });
