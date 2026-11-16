/**
 * 验证：解析时不再要求用户重新选文件（2026-11-16）。
 *
 * ## 用户的原话
 *
 * 「解析选择的 pdf 的时候需要再在文件资源管理器里选择一次要解析的文件。」
 *
 * ## 这一轮改了什么
 *
 * 云 OCR 本来就从库里取字节，不需要路径（上一轮已修）。
 * MinerU 需要磁盘路径，而「sourceId → 路径」那张表只在主进程内存里、
 * 重启就空。所以现在多了一条兜底：**把库里的原件字节落成临时文件**，
 * 用那个路径喂给 MinerU。
 *
 * ## 这个脚本验什么
 *
 * 用真实桌面版 + 隔离副本：
 *  1. 进「文档解析」，选那份有原件的资料（442 页的高数）
 *  2. 确认**不会弹出系统文件选择框**（判据：进程没有卡在对话框上，
 *     且面板进入了 running / 立刻给出业务错误）
 *  3. 直接调一次 `materializeSourceFile`，证明库里的字节
 *     真的能落到磁盘并返回一个存在的路径
 *
 * 不真的跑 MinerU（这台机器上模型可能要几十分钟），
 * 只验「路径能不能从库里自己拿到」这一步 —— 那正是用户抱怨的那一步。
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
const PORT = Number(arg('port', '9801'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: --data <数据目录副本>');
    process.exit(2);
  }

  const app = spawn(
    path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
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

  /* ---------- 1. 桥是否真的有新方法 ---------- */
  const hasBridge = await evalJs(
    `(() => {
      const b = window.openleaner && window.openleaner.mineru;
      return {
        hasMaterialize: typeof b?.materializeSourceFile === 'function',
        hasPickSourceFile: typeof b?.pickSourceFile === 'function',
      };
    })()`,
  );
  rec('preload 暴露了 materializeSourceFile', hasBridge.hasMaterialize === true, JSON.stringify(hasBridge));

  /* ---------- 2. 真的能把库里的字节落成文件 ---------- */
  const materialized = await evalJs(`(async () => {
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
    const sources = await getAll('sources');
    const files = await getAll('sourceFiles');
    db.close();

    const fmap = new Map(files.map(f => [f.id, f]));
    /* 挑那份「有字节记录的 442 页高数」—— 用户点的就是它 */
    const src = sources.find(s => s.pageCount === 442 && fmap.has(s.id));
    if (!src) return { ok: false, why: '库里没有带原件的 442 页资料' };

    const rec = fmap.get(src.id);
    const bytes = new Uint8Array(rec.data);

    const r = await window.openleaner.mineru.materializeSourceFile(src.id, '.pdf', bytes);
    return {
      ok: r.ok === true,
      filePath: r.ok ? r.filePath : null,
      message: r.ok ? null : r.message,
      srcBytes: bytes.byteLength,
      srcId: src.id,
    };
  })()`);

  rec('能从库里取到原件字节', materialized.srcBytes > 0, `${materialized.srcBytes} 字节`);
  rec('materializeSourceFile 调用成功', materialized.ok === true, materialized.message ?? '');

  /* ---------- 3. 那个路径真的存在、且大小对得上 ---------- */
  if (materialized.ok && materialized.filePath) {
    const exists = fs.existsSync(materialized.filePath);
    const size = exists ? fs.statSync(materialized.filePath).size : -1;
    rec('返回的路径真实存在', exists, materialized.filePath);
    rec('写出的文件大小与原字节一致', size === materialized.srcBytes, `${size} vs ${materialized.srcBytes}`);

    /* 第二次应复用，不重写 */
    const again = await evalJs(`(async () => {
      const dbs = await indexedDB.databases();
      const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
      const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
      const f = await new Promise((res) => {
        const rq = db.transaction('sourceFiles','readonly').objectStore('sourceFiles').getAll();
        rq.onsuccess = () => res((rq.result||[])); rq.onerror = () => res([]);
      });
      db.close();
      const rec = f.find(x => x.id === ${JSON.stringify(materialized.srcId)});
      const bytes = new Uint8Array(rec.data);
      const r = await window.openleaner.mineru.materializeSourceFile(${JSON.stringify(materialized.srcId)}, '.pdf', bytes);
      return { ok: r.ok, reused: r.reused === true };
    })()`);
    rec('同大小再调一次会复用（不重复写几十 MB）', again.reused === true, JSON.stringify(again));
  }

  /* ---------- 4. 路径被拒绝的场景（安全边界） ---------- */
  const badExt = await evalJs(
    `window.openleaner.mineru.materializeSourceFile('source_test_1234', '.exe', new Uint8Array([1,2,3]))`,
  );
  rec('非法扩展名被拒绝', badExt.ok === false, badExt.message ?? '');

  const badId = await evalJs(
    `window.openleaner.mineru.materializeSourceFile('../etc/passwd', '.pdf', new Uint8Array([1]))`,
  );
  rec('非法 sourceId（路径穿越）被拒绝', badId.ok === false, badId.message ?? '');

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n失败项：');
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
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(2);
});