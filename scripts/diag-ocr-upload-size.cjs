/**
 * 决定性实验（2026-11-16）：Chromium 真正发出去的请求体有多大？
 *
 * ## 背景
 *
 * 用户报：云 OCR 说「文件超过 100 MiB，请先拆分」，可那份 PDF 只有 55 MB。
 *
 * 已经查实的（都有实测）：
 *  - 库里存的字节 = 55.07 MiB，与磁盘文件逐字节一致
 *  - 55 MiB **不会**被本地拦截（deepseek-ocr.ts:237 那条带数字的）
 *  - 用户看到的那句**不带数字** → 走的是 413 分支（deepseek-ocr.ts:294）
 *  - 官方文档：413 = 文件超过 100 MiB
 *  - Node 侧 FormData 编码后 = 55.07 MiB，没有膨胀
 *
 * 于是只剩一个未验证的环节：**Chromium 的网络栈**。
 * 应用跑在渲染进程里，用的不是 Node 的 FormData，行为可以不同。
 *
 * ## 这个实验做什么
 *
 * 起一个本地 HTTP 服务器，数它**真正收到**多少字节；然后在应用自己的
 * 渲染进程里（同一份 IndexedDB 数据、同一段构造代码）POST 上去。
 * 收到的字节数就是这个问题的答案。
 *
 * 只读库、只发本地请求，不碰 DeepSeek、不花钱。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', ''));
const CDP_PORT = Number(arg('port', '9720'));
const ECHO_PORT = Number(arg('echo', '9730'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: --data <数据目录副本> [--app release/win-unpacked]');
    process.exit(2);
  }

  /* ---- 回显服务器：只数字节，不存盘 ---- */
  let received = null;
  const server = http.createServer((req, res) => {
    let total = 0;
    const declared = Number(req.headers['content-length'] || 0);
    req.on('data', (c) => {
      total += c.length;
    });
    req.on('end', () => {
      received = { declared, actual: total };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: total }));
    });
  });
  await new Promise((res) => server.listen(ECHO_PORT, '127.0.0.1', res));

  const app = spawn(
    path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1200,900'],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    app.kill();
    server.close();
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

  await send('Runtime.enable');
  await sleep(4000);

  /*
   * 在渲染进程里照抄 runOcr 的构造方式（deepseek-ocr.ts:256-281），
   * 只把目标地址换成本地回显服务器。
   */
  const out = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('open failed'));
    });
    const sources = await new Promise((res) => {
      const rq = db.transaction('sources','readonly').objectStore('sources').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const files = await new Promise((res) => {
      const rq = db.transaction('sourceFiles','readonly').objectStore('sourceFiles').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    db.close();

    const fmap = new Map(files.map(f => [f.id, f]));
    /* 挑那份「有字节记录的 442 页高数」——用户点的就是它 */
    const target = sources.find(s => s.pageCount === 442 && fmap.has(s.id)) || sources.find(s => fmap.has(s.id));
    if (!target) return { ok: false, why: '库里没有带字节的资料' };
    const rec = fmap.get(target.id);

    /* 这里照抄 getOriginalFile 与 runOcr 的写法 */
    const bytes = new Uint8Array(rec.data);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);

    const form = new FormData();
    form.append('file', new Blob([copy.buffer], { type: 'application/pdf' }), 'a.pdf');
    form.append('purpose', 'rich_layout_recognition');

    const t0 = performance.now();
    const res = await fetch('http://127.0.0.1:${ECHO_PORT}/echo', { method: 'POST', body: form });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => null);

    return {
      ok: true,
      title: target.title,
      recBytes: rec.data.byteLength,
      recMiB: +(rec.data.byteLength/1024/1024).toFixed(2),
      copyBufferBytes: copy.buffer.byteLength,
      echoServerSaw: body ? body.bytes : null,
      ms,
    };
  })()`);

  console.log(JSON.stringify({ renderer: out, serverSaw: received }, null, 2));

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  server.close();
  await sleep(600);
  process.exit(0);
})().catch((e) => {
  console.error('实验失败:', e.message);
  process.exit(1);
});