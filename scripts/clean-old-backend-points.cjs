/**
 * 清掉某份资料里旧后端产出的知识点（2026-11-21 深夜）。
 *
 * ## 背景
 *
 * 用户要求「旧知识点重新整理」。用 DeepSeek + 新提示词重跑「信号与系统」
 * 那份之后，这份资料里有 **144 条**：
 *  - 94 条新产出（`backend_5cd77d51…` = DeepSeek，新提示词的整段归纳）
 *  - 50 条旧产出（`backend_7240fa00…`，旧提示词拆的碎片）
 *
 * `generate()` 只清「同后端」的结果（`clearBySourceAndBackend`），
 * 所以旧后端那批留了下来。用户要求**只留新的**。
 *
 * ## 安全边界
 *
 * 只删「指定资料 + 指定后端」两个条件**同时**满足的。
 * 两个条件缺一不可：
 *  - 只按资料删 → 会连新产出一起删
 *  - 只按后端删 → 会删掉别的资料用同后端产出的
 *
 * 另外**绝不动被题目引用的**：那种删了就是悬空引用（11-20 清过 29 条，
 * 不该再造新的）。检测到就停下报错。
 *
 * 用法：
 *   node scripts/clean-old-backend-points.cjs --probe
 *   node scripts/clean-old-backend-points.cjs --data .tmp/x
 *   node scripts/clean-old-backend-points.cjs --apply
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PROBE = arg('probe') === true;
const APPLY = arg('apply') === true;
const DATA_ARG = typeof arg('data') === 'string' ? arg('data') : null;
const PORT = Number(arg('port') || 9998);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目标资料标题关键词 */
const SOURCE_KEYWORD = '信号与系统';
/** 要清掉的后端（旧提示词那批） */
const OLD_BACKEND = 'backend_7240fa00-86fb-4004-ab36-438c48127c5f';
/** 要保留的后端（DeepSeek 新产出） */
const KEEP_BACKEND = 'backend_5cd77d51-f07c-498d-9121-30580345cb26';

(async () => {
  if (!PROBE && !APPLY && !DATA_ARG) {
    console.error('用法：--probe | --data <副本> | --apply');
    process.exit(2);
  }

  let exe;
  let args;
  let env = { ...process.env };

  if (APPLY) {
    exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe');
    if (!fs.existsSync(exe)) {
      console.error('找不到安装版');
      process.exit(2);
    }
    if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
      console.error('❌ 安装目录旁有 openleaner-data —— 会跑偏');
      process.exit(2);
    }
    args = ['--no-sandbox', '--remote-debugging-port=' + PORT];
  } else if (DATA_ARG) {
    exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    args = [ROOT, '--user-data-dir=' + path.resolve(ROOT, DATA_ARG), '--no-sandbox', '--remote-debugging-port=' + PORT];
  } else {
    const tmp = path.join(ROOT, '.tmp/clean-old-probe');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'OpenLeaner'), { recursive: true });
    fs.cpSync(
      path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'),
      path.join(tmp, 'OpenLeaner/IndexedDB'),
      { recursive: true },
    );
    exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    args = [ROOT, '--user-data-dir=' + path.join(tmp, 'OpenLeaner'), '--no-sandbox', '--remote-debugging-port=' + PORT];
    env = { ...process.env, APPDATA: tmp };
    console.log('probe：读真实库副本');
  }

  console.log((APPLY ? '=== 真库执行 ===' : DATA_ARG ? '=== 副本演练 ===' : '=== 只读探测 ==='));
  const app = spawn(exe, args, { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let target = null;
  for (let i = 0; i < 240; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1200));
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa) =>
    new Promise((res, rej) => {
      const n = id++;
      pending.set(n, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: n, method: me, params: pa || {} }));
      setTimeout(() => {
        if (pending.has(n)) {
          pending.delete(n);
          rej(new Error('timeout'));
        }
      }, 120000);
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(6000);

  const before = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const tx = db.transaction(s, "readonly");
      const rq = tx.objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const kps = await getAll("knowledgePoints");
    const questions = await getAll("questions");
    const sources = await getAll("sources");
    db.close();

    const src = sources.find((s) => (s.title || "").indexOf(${JSON.stringify(SOURCE_KEYWORD)}) >= 0);
    if (!src) return { error: "找不到目标资料" };

    const mine = kps.filter((k) => k.sourceId === src.id);
    const toDelete = mine.filter((k) => k.backendId === ${JSON.stringify(OLD_BACKEND)});
    const toKeep = kps.filter((k) => !(k.sourceId === src.id && k.backendId === ${JSON.stringify(OLD_BACKEND)}));

    const qKpIds = new Set(questions.filter((q) => q.knowledgePointId).map((q) => q.knowledgePointId));
    const referenced = toDelete.filter((k) => qKpIds.has(k.id));

    return {
      sourceId: src.id,
      sourceTitle: src.title.slice(0, 40),
      total: kps.length,
      thisSourceTotal: mine.length,
      thisSourceByBackend: (() => {
        const m = {};
        for (const k of mine) m[String(k.backendId).slice(0, 16)] = (m[String(k.backendId).slice(0, 16)] || 0) + 1;
        return m;
      })(),
      toDelete: toDelete.length,
      toKeep: toKeep.length,
      referencedByQuestions: referenced.length,
      questionCount: questions.length,
    };
  })()`);

  console.log('\n=== 清理前 ===');
  console.log(JSON.stringify(before, null, 1));

  if (before.error) {
    console.error('❌ ' + before.error);
    try { app.kill(); } catch {}
    process.exit(2);
  }
  if (before.toDelete === 0) {
    console.log('\n没有要清理的。');
    try { app.kill(); } catch {}
    process.exit(0);
  }
  if (before.referencedByQuestions > 0) {
    console.error('\n❌ 有 ' + before.referencedByQuestions + ' 条被题目引用，删了会造悬空引用。已停止。');
    try { app.kill(); } catch {}
    process.exit(2);
  }

  if (PROBE) {
    console.log('\n（--probe：没写任何东西）');
    try { app.kill(); } catch {}
    process.exit(0);
  }

  const deleted = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res, rej) => {
      const tx = db.transaction("knowledgePoints", "readonly");
      const rq = tx.objectStore("knowledgePoints").getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const ids = all
      .filter((k) => k.sourceId === ${JSON.stringify(before.sourceId)} && k.backendId === ${JSON.stringify(OLD_BACKEND)})
      .map((k) => k.id);

    const tx = db.transaction("knowledgePoints", "readwrite");
    const store = tx.objectStore("knowledgePoints");
    for (const id of ids) store.delete(id);
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("事务被中止"));
    });
    db.close();
    return { deleted: ids.length };
  })()`);
  console.log('\n已删除：' + JSON.stringify(deleted));

  const after = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const tx = db.transaction(s, "readonly");
      const rq = tx.objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const kps = await getAll("knowledgePoints");
    const questions = await getAll("questions");
    const records = await getAll("reviewRecords");
    db.close();
    const mine = kps.filter((k) => k.sourceId === ${JSON.stringify(before.sourceId)});
    const kpIds = new Set(kps.map((k) => k.id));
    const dangling = questions.filter((q) => q.knowledgePointId && !kpIds.has(q.knowledgePointId));
    return {
      total: kps.length,
      thisSourceTotal: mine.length,
      thisSourceOldBackend: mine.filter((k) => k.backendId === ${JSON.stringify(OLD_BACKEND)}).length,
      thisSourceNewBackend: mine.filter((k) => k.backendId === ${JSON.stringify(KEEP_BACKEND)}).length,
      danglingRefs: dangling.length,
      questions: questions.length,
      reviewRecords: records.length,
      favorites: kps.filter((k) => k.favorite).length,
    };
  })()`);

  console.log('\n=== 独立复核 ===');
  console.log(JSON.stringify(after, null, 1));

  const checks = [
    ['旧后端清零', after.thisSourceOldBackend === 0, after.thisSourceOldBackend],
    ['新产出仍在', after.thisSourceNewBackend === before.thisSourceByBackend ? true : after.thisSourceNewBackend > 0, after.thisSourceNewBackend],
    ['全库条数 = 清理前 - 删除数', after.total === before.toKeep, before.toKeep + ' → ' + after.total],
    ['无悬空引用', after.danglingRefs === 0, after.danglingRefs],
    ['题目数不变', after.questions === before.questionCount, after.questions],
  ];
  console.log('\n=== 判定 ===');
  let allOk = true;
  for (const [name, ok, val] of checks) {
    console.log((ok ? '✅' : '❌') + ' ' + name + '（' + val + '）');
    if (!ok) allOk = false;
  }

  try { app.kill(); } catch {}
  await sleep(600);
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error('脚本出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});