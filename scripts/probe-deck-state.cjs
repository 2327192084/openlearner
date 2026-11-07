/**
 * 深查某个数据目录里题组/题目的**真实状态**，用于回答两件事：
 *   1. 库里的题组是 draft 还是 published（草稿进不了做题）
 *   2. 库里有没有 'essay' 题（CardKind 没有 essay，会渲染成没有输入框的提交按钮）
 *
 * 用法：node scripts/probe-deck-state.cjs --data <目录副本> [--port 9371]
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
const PORT = Number(arg('port', '9371'));
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
  });
  let code = 0;
  try {
    const page = await findPage();
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
    await sleep(1500);

    const data = await evalJs(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const all = (store) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly');
        const q = tx.objectStore(store).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const decks = await all('decks');
      const questions = await all('questions');
      const kps = await all('knowledgePoints');
      const runs = await all('generationRuns');
      return {
        decks: decks.map(d => ({ title: d.title, status: d.status, cards: d.cardIds?.length ?? null, warnings: d.warnings?.length ?? 0, blockers: d.blockingIssues?.length ?? 0 })),
        kinds: questions.reduce((a, q) => (a[q.kind] = (a[q.kind] || 0) + 1, a), {}),
        deckOfQuestions: questions.reduce((a, q) => (a[q.deckId] = (a[q.deckId] || 0) + 1, a), {}),
        kpWithAnchors: kps.filter(k => (k.anchors || []).length > 0).length,
        kpTotal: kps.length,
        runs: runs.map(r => ({ kind: r.kind, status: r.status })),
      };
    })()`);

    console.log(`\n=== ${path.relative(ROOT, DATA_DIR)} ===`);
    console.log('题组:');
    for (const d of data.decks) {
      console.log(`  [${d.status}] ${d.title}  cards=${d.cards} warnings=${d.warnings} blockers=${d.blockers}`);
    }
    console.log('题目 kind 分布:', JSON.stringify(data.kinds));
    console.log('题 → 题组归属:', JSON.stringify(data.deckOfQuestions));
    console.log(`知识点有 anchors: ${data.kpWithAnchors} / ${data.kpTotal}`);
    console.log('生成记录:', JSON.stringify(data.runs));
  } catch (e) {
    console.error('失败:', e.message);
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
