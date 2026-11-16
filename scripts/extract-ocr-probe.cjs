/**
 * 提取值：从隔离副本里读出 DeepSeek Key 与最小那份 PDF 的字节。
 *
 * ## 为什么单独一步
 *
 * 下一步要用 Node 直接调 DeepSeek OCR API 验证「功能本身通不通」。
 * 需要两样东西：用户的 Key（在 IndexedDB 的 secrets 分区）与
 * 一份真实 PDF 的字节（在 sourceFiles 分区）。
 *
 * 本脚本**只读**隔离副本，把字节写到 .tmp 供下一步使用。
 * **不打印 Key 明文**，只写到临时文件供下一步读。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const APP_DIR = path.resolve(arg('app', 'release/win-unpacked'));
const DATA = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9831'));
const OUT = path.resolve(arg('out', '.tmp/ocr-real'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: --data <隔离副本>');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

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
      }, 120000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(4000);

  /* Key：base64 出去，避免 JSON 转义出问题 */
  const keyInfo = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res) => {
      if (!db.objectStoreNames.contains(s)) { res([]); return; }
      const rq = db.transaction(s, 'readonly').objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const backends = await getAll('backends');
    const secrets = await getAll('secrets');
    db.close();
    const bk = backends.find(b => b.status === 'ready');
    if (!bk) return { ok: false, why: 'no ready backend' };
    const sec = secrets.find(s => s.backendId === bk.id);
    if (!sec) return { ok: false, why: 'no secret' };
    /* 用 btoa 编码，避免明文出现在日志里 */
    const enc = btoa(unescape(encodeURIComponent(sec.value)));
    return { ok: true, keyB64: enc, baseUrl: bk.baseUrl || 'https://api.deepseek.com', label: bk.label };
  })()`);

  if (!keyInfo.ok) {
    console.error('取 Key 失败:', keyInfo.why);
    app.kill();
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT, 'key.b64'), keyInfo.keyB64, 'utf8');
  fs.writeFileSync(path.join(OUT, 'baseUrl.txt'), keyInfo.baseUrl, 'utf8');
  console.log(`Key 已取（${Buffer.from(keyInfo.keyB64, 'base64').toString().length} 字符），后端: ${keyInfo.label}`);
  console.log(`baseUrl: ${keyInfo.baseUrl}`);

  /* 最小那份 PDF 的字节：分块 base64 传出（避免一次 returnByValue 过大） */
  const meta = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const getAll = (s) => new Promise((res) => {
      const rq = db.transaction(s, 'readonly').objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const sources = await getAll('sources');
    const files = await getAll('sourceFiles');
    db.close();
    const fmap = new Map(files.map(f => [f.id, f]));
    const cand = sources
      .filter(s => s.kind === 'pdf' && fmap.has(s.id))
      .map(s => ({ id: s.id, title: s.title, size: fmap.get(s.id).data.byteLength }))
      .sort((a, b) => a.size - b.size);
    return { ok: true, list: cand };
  })()`);

  if (!meta.ok || !meta.list.length) {
    console.error('库里没有带原件的 PDF');
    app.kill();
    process.exit(1);
  }
  console.log('\n可选文件（按大小）:');
  meta.list.forEach((x) => console.log(`  ${x.size} 字节  ${x.title.slice(0, 50)}`));

  const pick = meta.list[0];
  fs.writeFileSync(path.join(OUT, 'pick.json'), JSON.stringify(pick, null, 2), 'utf8');

  /* 分块导出字节（每块 512KB 原始 → 约 680KB base64） */
  const CHUNK = 512 * 1024;
  const totalChunks = Math.ceil(pick.size / CHUNK);
  console.log(`\n导出 ${pick.size} 字节，分 ${totalChunks} 块…`);

  const filePath = path.join(OUT, 'doc.pdf');
  const fd = fs.openSync(filePath, 'w');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const b64 = await evalJs(`(async () => {
        const dbs = await indexedDB.databases();
        const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
        const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
        const rec = await new Promise((res) => {
          const rq = db.transaction('sourceFiles','readonly').objectStore('sourceFiles').get(${JSON.stringify(pick.id)});
          rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
        });
        db.close();
        if (!rec) return null;
        const all = new Uint8Array(rec.data);
        const slice = all.subarray(${i * CHUNK}, ${(i + 1) * CHUNK});
        let s = '';
        for (let k = 0; k < slice.length; k += 8192) {
          s += String.fromCharCode.apply(null, slice.subarray(k, Math.min(k + 8192, slice.length)));
        }
        return btoa(s);
      })()`);
      if (!b64) throw new Error(`第 ${i} 块取不到`);
      fs.writeSync(fd, Buffer.from(b64, 'base64'));
      process.stdout.write(`\r  ${i + 1}/${totalChunks}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const st = fs.statSync(filePath);
  console.log(`\n写出 ${path.relative(process.cwd(), filePath)}（${st.size} 字节，应与 ${pick.size} 一致）`);

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(2);
});