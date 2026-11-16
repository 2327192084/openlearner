/**
 * 只读探针：看用户配了哪个模型后端（2026-11-16）。
 *
 * ## 为什么需要
 *
 * 用户报云 OCR 说「文件超过 100 MiB」，但实测文件只有 55.07 MiB。
 * 代码里 413 分支**不读响应体**，直接写死那句话 —— 所以那句话是
 * 程序自己编的，不一定是服务端的意思。要查清 413 从哪来，
 * 得先知道请求实际发去了哪个地址。
 *
 * 这里只读 `backends` 表里的**非敏感字段**：label / baseUrl / model。
 * **不读 `secrets` 表**（明文 Key 一个字节都不碰）。
 *
 * ## 用法
 *
 *   node scripts/probe-backends.cjs --app release/win-unpacked --data <数据目录副本>
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', ''));
const PORT = Number(arg('port', '9740'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: node scripts/probe-backends.cjs --data <数据目录副本>');
    process.exit(2);
  }

  const app = spawn(
    path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1200,900'],
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
      }, 30000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(4000);

  const out = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('open failed'));
    });
    const getAll = (s) => new Promise((res) => {
      if (!db.objectStoreNames.contains(s)) { res([]); return; }
      const rq = db.transaction(s, 'readonly').objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const backends = await getAll('backends');
    /* 只列非敏感字段；apiKey 之类的字段一律不碰 */
    const rows = backends.map((b) => ({
      id: b.id,
      label: b.label,
      baseUrl: b.baseUrl ?? null,
      model: b.model ?? null,
      status: b.status ?? null,
      isDefault: b.isDefault ?? null,
    }));
    db.close();
    return { ok: true, rows };
  })()`);

  console.log(JSON.stringify(out, null, 2));

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  process.exit(0);
})().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});