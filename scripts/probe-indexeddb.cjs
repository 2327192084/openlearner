/**
 * 只读探针：把某个「openleaner-data」目录里的 IndexedDB 复制一份，
 * 用 Edge + --allow-file-access-from-files 打开 file:// 页面，
 * 直接数每个分区里到底有多少条真实记录。
 *
 * 为什么不能用 strings 扫 leveldb：
 *   .log 是追加写的，删掉的记录还在里面。字符串计数会把
 *   「删过的」也算成「现有的」，结论会反。
 *
 * 用法：
 *   node scripts/probe-indexeddb.cjs --data <dir> [--port 9350]
 *
 * 只读：源目录一个字节都不改（先 cp -r 到 .tmp 再开）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATA_DIR = arg('data', '');
const PORT = Number(arg('port', '9350'));
if (!DATA_DIR) {
  console.error('用法: node scripts/probe-indexeddb.cjs --data <openleaner-data 目录> [--port N]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }
}

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Edge 没起来（CDP 端口连不上）');
}

(async () => {
  const src = path.resolve(ROOT, DATA_DIR);
  if (!fs.existsSync(path.join(src, 'IndexedDB'))) {
    console.error(`没有 IndexedDB：${src}`);
    process.exit(2);
  }

  /*
   * 直接把复制的目录当成 Electron 的 userData 用（--user-data-dir），
   * 这样 IndexedDB 就在 Chromium 期望的位置上，不用猜目录结构。
   */
  const profile = path.join(ROOT, '.tmp', `idb-probe-${PORT}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  for (const sub of ['IndexedDB', 'Local Storage', 'Session Storage']) {
    const from = path.join(src, sub);
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(profile, sub), { recursive: true });
    }
  }
  /*
   * 必须用**和真实应用同一个 file:// 路径**打开页面。
   * Chromium 对 file:// 的存储按路径分区，随便找个 probe.html
   * 打开会看到一个空库，从而误判「这个包里没数据」。
   */
  const pageFile = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(pageFile)) {
    console.error(`没有 ${pageFile}，先 npx vite build`);
    process.exit(2);
  }

  const edge = spawn(
    EDGE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--allow-file-access-from-files',
      '--headless=new',
      `file:///${pageFile.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore', detached: false },
  );

  let code = 0;
  try {
    const page = await connect(PORT);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');

    const origins = await cdp.eval(`
      (async () => {
        if (!indexedDB.databases) return ['<无 databases() 支持>'];
        const dbs = await indexedDB.databases();
        return dbs.map(d => d.name + '@v' + d.version);
      })()
    `);
    console.log(`\n=== ${DATA_DIR} ===`);
    console.log(`origin: file://  库: ${JSON.stringify(origins)}`);

    const out = await cdp.eval(`
      (async () => {
        const open = (name, v) => new Promise((res, rej) => {
          const r = indexedDB.open(name, v);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const db = await open('openleaner', 4);
        const stores = [...db.objectStoreNames].sort();
        const counts = {};
        for (const s of stores) {
          counts[s] = await new Promise((res, rej) => {
            const tx = db.transaction(s, 'readonly');
            const req = tx.objectStore(s).count();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
        }
        return counts;
      })()
    `);

    console.log('分区记录数：');
    const nonEmpty = Object.entries(out).filter(([, n]) => n > 0);
    for (const [s, n] of Object.entries(out)) {
      console.log(`  ${n > 0 ? '●' : '·'} ${s.padEnd(24)} ${n}`);
    }
    console.log(`合计非空分区 ${nonEmpty.length} / ${Object.keys(out).length}`);
    code = 0;
  } catch (err) {
    console.error(`探针失败: ${err.message}`);
    code = 1;
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
    await sleep(600);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
})();
