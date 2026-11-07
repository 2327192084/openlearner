/**
 * 用**真实 Electron 二进制**打开某个数据目录，通过 CDP 数各分区的现存记录数。
 *
 * 为什么不能用 Edge：Chromium 默认禁用 file:// 的 IndexedDB，
 * 而 Electron 是开着的。用 Edge 打开会看到「一个库都没有」，
 * 从而得出「这个包是空库」的错误结论。
 *
 * 为什么不能用 strings 扫 leveldb：.log 是追加写的，删掉的还在文件里。
 *
 * 用法：node scripts/probe-electron-idb.cjs --data <数据目录副本> [--port 9361]
 * 只读语义：调用方自己负责传一个副本目录。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'OpenLeaner.exe');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATA_DIR = path.resolve(ROOT, arg('data', ''));
const PORT = Number(arg('port', '9361'));
if (!DATA_DIR || !fs.existsSync(DATA_DIR)) {
  console.error('用法: node scripts/probe-electron-idb.cjs --data <数据目录副本> [--port N]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

(async () => {
  const app = spawn(EXE, [`--user-data-dir=${DATA_DIR}`, '--no-sandbox', `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false,
  });

  let code = 0;
  try {
    const page = await findPage();
    if (!page) throw new Error('Electron 没起来或 CDP 端口连不上');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };

    await send('Runtime.enable');
    await sleep(1500); // 等 App 自己建好库再读

    const dbs = await evalJs(`(async () => {
      const d = await indexedDB.databases();
      return d.map(x => x.name + '@v' + x.version);
    })()`);
    console.log(`\n=== ${path.relative(ROOT, DATA_DIR) || DATA_DIR} ===`);
    console.log(`origin: ${await evalJs('location.origin')}  库: ${JSON.stringify(dbs)}`);

    const counts = await evalJs(`(async () => {
      /* 不传版本号 ⇒ 打开现有库；传了就必须与库内版本完全一致，加一次迁移就会炸 */
      const open = (n, v) => new Promise((res, rej) => {
        const r = v === undefined ? indexedDB.open(n) : indexedDB.open(n, v);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open('openleaner');
      const out = {};
      for (const s of [...db.objectStoreNames].sort()) {
        out[s] = await new Promise((res, rej) => {
          const tx = db.transaction(s, 'readonly');
          const q = tx.objectStore(s).count();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
      }
      return out;
    })()`);

    const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
    console.log('分区记录数（● 非空）：');
    for (const [s, n] of Object.entries(counts)) {
      if (n > 0) console.log(`  ● ${s.padEnd(22)} ${n}`);
    }
    console.log(`  · 空分区 ${Object.keys(counts).length - nonEmpty.length} 个`);
    console.log(`非空分区 ${nonEmpty.length} / ${Object.keys(counts).length}`);

    /* 再看一眼 sources 的表头，判断这个库里到底有没有用户资料 */
    if (counts.sources > 0) {
      const rows = await evalJs(`(async () => {
        const open = (n, v) => new Promise((res, rej) => {
          const r = indexedDB.open(n, v);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const db = await open('openleaner');
        const all = await new Promise((res, rej) => {
          const tx = db.transaction('sources', 'readonly');
          const q = tx.objectStore('sources').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        return all.map(s => ({ title: s.title, kind: s.kind, pages: s.pageCount ?? null, status: s.textStatus ?? null }));
      })()`);
      console.log('sources 内容:');
      for (const r of rows) console.log(`  - ${r.title}  [${r.kind}]  ${r.pages ?? '?'}页  ${r.status ?? ''}`);
    }
    code = 0;
  } catch (err) {
    console.error(`探针失败: ${err.message}`);
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(1200);
  }
  process.exit(code);
})();
