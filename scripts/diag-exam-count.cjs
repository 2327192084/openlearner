/**
 * 只读诊断：题目总数 vs 模拟考能收的题数（2026-11-17）。
 *
 * ## 用户的问题
 *
 * 「软件内题组现在有23道题，为什么模拟考试显示所有已发布的题目只有19题？」
 *
 * ## 已从代码确认的机制
 *
 * 模拟考（ExamPage.tsx:101）只收 `isAutoGraded(q.kind)` 的题 ——
 * 因为交卷时要自动判分，而问答（essay）与计算（calc）是
 * `graded: 'self'`（用户自己评），进不了考场。
 *
 * 题型与判分方式的对应（src/core/questions/kinds.ts）：
 *   single / multiple / truefalse / blank → auto
 *   essay / calc                        → self
 *
 * ## 这个脚本验什么
 *
 * 不是「23-19=4 猜得对」，而是**逐题列出**：
 *  - 全部题目按 kind 分组计数
 *  - 只算「已发布题组」里的题（模拟考只取 published）
 *  - 自评题的清单（用户能看到具体是哪几道）
 *
 * 这样给出的是证据，不是推测。
 *
 * 只读，不改库。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-exam-diag');
  const appDir = path.join(process.env.USERPROFILE, 'ol-exam-app');

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
    const questions = await getAll('questions');
    const decks = await getAll('decks');
    db.close();

    const deckById = new Map(decks.map(d => [d.id, d]));
    const AUTO = new Set(['single', 'multiple', 'truefalse', 'blank']);

    const byKind = {};
    for (const q of questions) {
      byKind[q.kind] = (byKind[q.kind] || 0) + 1;
    }

    /* 模拟考只取 published 题组里的题（ExamPage.tsx:82 起） */
    const published = decks.filter(d => d.status === 'published');
    const pubIds = new Set(published.map(d => d.id));
    const inPublished = questions.filter(q => pubIds.has(q.deckId));

    const selfGraded = questions.filter(q => !AUTO.has(q.kind));
    const selfInPublished = inPublished.filter(q => !AUTO.has(q.kind));

    return {
      totalQuestions: questions.length,
      totalDecks: decks.length,
      publishedDecks: published.map(d => ({ id: d.id, title: d.title, status: d.status })),
      byKind,
      inPublishedCount: inPublished.length,
      autoInPublished: inPublished.filter(q => AUTO.has(q.kind)).length,
      selfInPublished: selfInPublished.map(q => ({
        kind: q.kind,
        stem: String(q.stem || '').slice(0, 50),
        deckTitle: (deckById.get(q.deckId) || {}).title || '（题组已删）',
      })),
      selfGradedAll: selfGraded.length,
    };
  })()`);

  console.log('=== 题目总览 ===');
  console.log(`总题数      : ${out.totalQuestions}`);
  console.log(`总题组数    : ${out.totalDecks}`);
  console.log(`已发布题组  : ${out.publishedDecks.length} 个`);
  for (const d of out.publishedDecks) console.log(`   - ${d.title}`);

  console.log('\n=== 按题型分组 ===');
  const kindLabel = {
    single: '单选（自动判分）',
    multiple: '多选（自动判分）',
    truefalse: '判断（自动判分）',
    blank: '填空（自动判分）',
    essay: '问答（**自评**）',
    calc: '计算（**自评**）',
  };
  let autoTotal = 0;
  let selfTotal = 0;
  for (const [k, n] of Object.entries(out.byKind).sort((a, b) => b[1] - a[1])) {
    const isAuto = ['single', 'multiple', 'truefalse', 'blank'].includes(k);
    if (isAuto) autoTotal += n; else selfTotal += n;
    console.log(`  ${(kindLabel[k] || k).padEnd(20)} ${String(n).padStart(3)} 题`);
  }
  console.log(`  ${'—'.repeat(24)}`);
  console.log(`  自动判分合计          ${String(autoTotal).padStart(3)} 题`);
  console.log(`  自评合计              ${String(selfTotal).padStart(3)} 题`);

  console.log('\n=== 模拟考实际能收多少 ===');
  console.log(`已发布题组里的题  : ${out.inPublishedCount}`);
  console.log(`其中自动判分      : **${out.autoInPublished}**  ← 这就是模拟考显示的数字`);

  if (out.selfInPublished.length) {
    console.log(`\n被排除的自评题（${out.selfInPublished.length} 道）:`);
    for (const q of out.selfInPublished) {
      console.log(`  [${q.kind}] ${q.stem}  ← ${q.deckTitle}`);
    }
  }

  console.log('\n=== 结论 ===');
  const diff = out.totalQuestions - out.autoInPublished;
  console.log(
    `${out.totalQuestions} 题（题组总数） - ${out.selfInPublished.length} 题（自评题型，进不了考场） ` +
      `= ${out.autoInPublished} 题（模拟考显示的数字）`,
  );
  if (diff !== out.selfInPublished.length) {
    console.log(
      `\n⚠️ 上面这条等式不成立（差 ${diff} vs 自评 ${out.selfInPublished.length}）—— ` +
        `可能有题不在已发布题组里，原因不止「自评题型」一种。`,
    );
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
