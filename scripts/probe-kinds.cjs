/**
 * 只读探针：看看这份数据副本里有哪些题型、有没有已发布的问答/计算题。
 *
 * 用法：node scripts/probe-kinds.cjs --data .tmp/sg-data [--port 9990]
 * ⚠️ 只读，不改任何数据。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/sg-data'));
const PORT = Number(arg('port', '9990'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );

  try {
    let page = null;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
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
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await sleep(2800);

    const out = await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const getAll = (store) => new Promise((res, rej) => {
        if (!d.objectStoreNames.contains(store)) return res([]);
        const tx = d.transaction(store, 'readonly');
        const q = tx.objectStore(store).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const qs = await getAll('questions');
      const decks = await getAll('decks');
      const by = {};
      for (const q of qs) by[q.kind] = (by[q.kind] || 0) + 1;
      const deckStatus = {};
      for (const dk of decks) deckStatus[dk.status || 'none'] = (deckStatus[dk.status || 'none'] || 0) + 1;
      const selfQs = qs.filter((q) => q.kind === 'essay' || q.kind === 'calc');
      const pubIds = new Set(decks.filter((dk) => dk.status === 'published').map((dk) => dk.id));
      return {
        stores: [...d.objectStoreNames],
        questions: qs.length,
        byKind: by,
        decks: decks.length,
        deckStatus,
        selfGradeQuestions: selfQs.map((q) => ({
          id: q.id,
          kind: q.kind,
          deckPublished: pubIds.has(q.deckId),
          prompt: (q.prompt || '').slice(0, 40),
        })),
      };
    })()`);

    console.log(JSON.stringify(out, null, 2));
  } finally {
    app.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
