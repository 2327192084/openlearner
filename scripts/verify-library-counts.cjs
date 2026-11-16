/**
 * 只读核对：真实学习库现在还完整吗（2026-11-17 00:19 有一次写入，需确认原因）。
 *
 * 起因：`%APPDATA%\OpenLeaner\IndexedDB\...\000004.log` 从 19:44 的
 * 2,097,926 字节变成了 00:19 的 2,209,789 字节。我在那前后跑过
 * 一个读 Key 的脚本（目标本该是 `C:\Users\ASUS\ol-ocr` 副本）。
 *
 * 必须查清两件事：
 *  1. 用户资料还在不在（资料数、知识点数、题数、原件字节数）
 *  2. 有没有被我的操作写脏
 *
 * 做法：复制一份到 $USERPROFILE 下，用应用打开只读统计。
 * **不写源目录**。判据是「数量与交接文档记的一致」：
 * 资料 2 份、题目 20、知识点 59、正文段 478、回收站 9 项。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9840;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-verify-counts');
  const appDir = path.join(process.env.USERPROFILE, 'ol-verify-app');

  /* 复制一份（只读源） */
  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(copy, { recursive: true });
  fs.cpSync(path.join(src, 'IndexedDB'), path.join(copy, 'IndexedDB'), { recursive: true });
  const ls = path.join(src, 'Local Storage');
  if (fs.existsSync(ls)) fs.cpSync(ls, path.join(copy, 'Local Storage'), { recursive: true });

  /* 独立 app 目录（避免候选#4 抢先） */
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  const unpacked = path.join(ROOT, 'release', 'win-unpacked');
  for (const name of fs.readdirSync(unpacked)) {
    if (name === 'openleaner-data') continue;
    fs.cpSync(path.join(unpacked, name), path.join(appDir, name), { recursive: true });
  }

  const app = spawn(
    path.join(appDir, 'OpenLeaner.exe'),
    [`--user-data-dir=${copy}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1200,900'],
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

  const out = await evalJs(`(async () => {
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
    const out = {};
    for (const s of ['sources','sourceSegments','knowledgePoints','questions','decks','reviewRecords','flashcards','trash','sourceFiles']) {
      const rows = await getAll(s);
      out[s] = rows.length;
    }
    /* 原件字节总量 */
    const files = await getAll('sourceFiles');
    out._fileBytes = files.reduce((n, f) => n + (f.data?.byteLength || 0), 0);
    out._fileMiB = +(out._fileBytes / 1048576).toFixed(2);
    db.close();
    return out;
  })()`);

  console.log(JSON.stringify(out, null, 2));

  console.log('\n=== 与交接文档的记录对比 ===');
  const expect = { sources: 2, questions: 20, knowledgePoints: 59, sourceSegments: 478, trash: 9 };
  let allOk = true;
  for (const [k, v] of Object.entries(expect)) {
    const got = out[k];
    const ok = got === v;
    if (!ok) allOk = false;
    console.log(`  ${k.padEnd(16)} 期望 ${String(v).padStart(4)}  实测 ${String(got).padStart(4)}  ${ok ? '✅' : '⚠️ 不一致'}`);
  }
  console.log(`\n${allOk ? '✅ 数据与记录一致，那次写入没有破坏什么' : '⚠️ 有数量不一致，需要细看'}`);

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(2);
});