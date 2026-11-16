/**
 * 只读诊断：两份资料的 fileStored 与原件字节现状（2026-11-17）。
 *
 * 背景：刚才核对发现 `sourceFiles` 只剩 1 份（2.15 MiB 的信号与系统），
 * 而 55 MB 高数的原件不见了。用户库里有 2 份资料。
 *
 * 必须查清：
 *  - 两份资料各自的 fileStored 是什么
 *  - 高数那份是没有 sourceFiles 记录（从未存 / 被删），还是 fileStored=false
 *  - 有没有孤儿 sourceFiles（有字节但没有 sources 行）
 *
 * 只读，不改任何东西。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9841;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-diag-files');
  const appDir = path.join(process.env.USERPROFILE, 'ol-diag-app');

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
    const sources = await getAll('sources');
    const files = await getAll('sourceFiles');
    const trash = await getAll('trash');
    db.close();

    const fmap = new Map(files.map(f => [f.id, f]));
    const srcIds = new Set(sources.map(s => s.id));
    return {
      sources: sources.map(s => ({
        id: s.id.slice(0, 24),
        title: s.title.slice(0, 40),
        kind: s.kind,
        pageCount: s.pageCount,
        textStatus: s.textStatus,
        fileStored: s.fileStored,
        hasFileRecord: fmap.has(s.id),
        fileMiB: fmap.has(s.id) ? +(fmap.get(s.id).data.byteLength / 1048576).toFixed(2) : null,
        createdAt: s.createdAt,
      })),
      fileRecords: files.map(f => ({
        id: f.id.slice(0, 24),
        mib: +(f.data.byteLength / 1048576).toFixed(2),
        savedAt: f.savedAt,
        orphan: !srcIds.has(f.id),
      })),
      trash: trash.map(t => ({
        id: String(t.id || '').slice(0, 20),
        kind: t.kind,
        title: String(t.title || '').slice(0, 36),
        deletedAt: t.deletedAt,
      })),
    };
  })()`);

  console.log('=== 资料（sources）===');
  for (const s of out.sources) {
    console.log(
      `  ${s.title}\n` +
        `    fileStored=${s.fileStored}  hasRecord=${s.hasFileRecord}  fileMiB=${s.fileMiB}  ` +
        `pages=${s.pageCount}  text=${s.textStatus}  created=${s.createdAt}`,
    );
  }

  console.log('\n=== 原件记录（sourceFiles）===');
  for (const f of out.fileRecords) {
    console.log(`  ${f.id}  ${f.mib} MiB  savedAt=${f.savedAt}  ${f.orphan ? '⚠️ 孤儿' : ''}`);
  }

  console.log('\n=== 回收站（trash）===');
  for (const t of out.trash) {
    console.log(`  [${t.kind}] ${t.title}  deletedAt=${t.deletedAt}`);
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
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(2);
});