/**
 * 只读探针：量出「库里的原始文件」到底有多大（2026-11-16）。
 *
 * ## 为什么需要它
 *
 * 用户报：云 OCR 提示「文件超过 100 MiB，请先拆分」，可桌面上那份
 * 「高等数学」PDF 只有 55 MB。
 *
 * 这个报错有两个来源，**位置不同、含义完全不同**：
 *  - `deepseek-ocr.ts:237` 本地拦：文案带具体 MiB 数
 *    （「文件超过 100 MiB（112.3 MiB），请先拆分」）
 *  - `deepseek-ocr.ts:294` 服务端 413：文案**不带数字**
 *    （「文件超过 100 MiB，请先拆分」）
 *
 * 用户截图里那句没有数字 → 走的是 413 → **本地算出来的字节数没超**，
 * 是服务端认为超了。那就要先弄清：本地到底发了多少字节出去。
 *
 * ## 为什么不用 `probe-lib-counts.cjs` 那种方式
 *
 * 那种是「用一个最小 file:// 页面去 openIndexedDB」。实测在本机报
 * `UnknownError: Internal error` —— 两个探针都报，连原来那个能跑的也报。
 * 原因是那个最小页面的 origin 与建档时的 origin 不同（file:// 是
 * opaque origin，Chromium 不给它开别人的库）。
 *
 * 所以这里反过来：**启动应用本身**（它自己的 file:// 页面 + 自己的库），
 * 在它的页面上下文里读。origin 必然匹配，读到的就是真实数据。
 * 只读，不改库。
 *
 * ## 用法
 *
 *   node scripts/probe-source-file-size.cjs --app release/win-unpacked \
 *        --data <数据目录副本>
 *
 * 数据目录要**复制一份**再传进来（Chromium 会往里面写 LOCK/LOG）。
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
const PORT = Number(arg('port', '9710'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: node scripts/probe-source-file-size.cjs --data <数据目录副本>');
    process.exit(2);
  }
  const exe = path.join(APP_DIR, 'OpenLeaner.exe');
  if (!fs.existsSync(exe)) {
    console.error(`找不到应用: ${exe}`);
    process.exit(2);
  }

  const app = spawn(
    exe,
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

  /*
   * 只读整条链：sources 表里每份资料的元信息 + sourceFiles 里对应字节长度。
   * `byteSize` 是写入时记下的，`real` 是这条记录里 buffer 的真实长度 ——
   * 两者不一致就是「存进去的字节和记账对不上」，那是另一类 bug。
   */
  const out = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    if (!name) return { ok: false, why: 'no db', dbs: dbs.map(d => d.name) };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('open failed'));
    });

    const getAll = (s) => new Promise((res) => {
      if (!db.objectStoreNames.contains(s)) { res([]); return; }
      const rq = db.transaction(s, 'readonly').objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });

    const sources = await getAll('sources');
    const files = await getAll('sourceFiles');
    const fileById = new Map();
    for (const f of files) {
      const real = f.data
        ? (f.data.byteLength !== undefined ? f.data.byteLength : (f.data.length || 0))
        : 0;
      fileById.set(f.id, { real, recorded: f.byteSize ?? null, savedAt: f.savedAt ?? null });
    }

    const rows = sources.map((s) => {
      const f = fileById.get(s.id) || null;
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        fileStored: s.fileStored === true,
        pageCount: s.pageCount ?? null,
        hasRecord: !!f,
        realBytes: f ? f.real : 0,
        realMiB: f ? +(f.real / 1024 / 1024).toFixed(2) : 0,
        recordedBytes: f ? f.recorded : null,
      };
    });

    const srcIds = new Set(sources.map((s) => s.id));
    const orphans = [...fileById.keys()].filter((k) => !srcIds.has(k));

    db.close();
    return { ok: true, db: name, version: db.version, rows, orphanFileRecords: orphans };
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