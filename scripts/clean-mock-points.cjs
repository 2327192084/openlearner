/**
 * 清掉「示例后端」产出的知识点（2026-11-21 深夜）。
 *
 * ## 为什么会有这批数据
 *
 * 我自己踩的坑：接到「重新整理旧知识点」的任务后，点开整理页直接点了
 * 「开始整理」，**没注意默认选的是示例后端**。
 * 示例后端（`MockBackend`）从原文里摘句子冒充整理结果，于是往真实库里
 * 写了 144 条带「【原文摘录·未经提炼】」前缀、带「示例后端」标签的碎片。
 *
 * 用户明确要求清掉。
 *
 * ## 安全边界（这条最重要）
 *
 * **只删 `backendId === 'mock'` 的**。
 *
 * 用户原来的 105 条知识点是 `backend_7240fa00…` / `backend_5cd77d51…`
 * 这些真实后端产出的，一条都不能碰。判断依据是**后端 id**，
 * 不是「有没有示例后端标签」—— 标签可以被用户手改过，id 不会。
 *
 * ## 三步走（照 11-13 那次事故的教训）
 *
 *   1. `--probe`   只读探测：数清楚要删几条、剩下几条、有没有被题目引用
 *   2. `--data X`  副本演练：改一份副本，独立复核条数
 *   3. `--apply`   真库执行：**不带任何目录参数**启动桌面安装版
 *                  （`--user-data-dir` 只是候选之一，会跑偏到别处）
 *
 * ## 真库执行前必须确认的事
 *
 * - 程序没在运行（否则 LevelDB 被占用，写入会失败或写坏）
 * - 先备份整份 IndexedDB
 * - 写后独立复核（另起一次探测，而不是信自己的返回值）
 *
 * 用法：
 *   node scripts/clean-mock-points.cjs --probe
 *   node scripts/clean-mock-points.cjs --data .tmp/x
 *   node scripts/clean-mock-points.cjs --apply
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : i >= 0
      ? true
      : undefined;
}

const PROBE = arg('probe') === true;
const APPLY = arg('apply') === true;
const DATA_ARG = typeof arg('data') === 'string' ? arg('data') : null;
const PORT = Number(arg('port') || 9995);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要清理的后端 id。示例后端的 id 是固定的 `mock` */
const MOCK_BACKEND_ID = 'mock';

(async () => {
  if (!PROBE && !APPLY && !DATA_ARG) {
    console.error('用法：--probe（只读探测）| --data <副本目录>（演练）| --apply（真库执行）');
    process.exit(2);
  }

  /*
   * 三种模式怎么启动 app：
   *
   * - probe / --data：用 node_modules 里的 electron + --user-data-dir
   *   （隔离副本，随便折腾）
   * - --apply：**必须用桌面安装版且不带任何目录参数**
   *   理由见交接文档 11-13：`ensureUserDataDir` 有 4 个候选，
   *   `--user-data-dir` 只是其中之一，第 4 候选
   *   `path.join(dirname(process.execPath),'openleaner-data')` 会抢先。
   *   11-13 那次「已删除但是假的」就是栽在这里。
   */
  let exe;
  let args;
  let env = { ...process.env };

  if (APPLY) {
    exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe');
    if (!fs.existsSync(exe)) {
      console.error('找不到桌面安装版：' + exe);
      process.exit(2);
    }
    /* app 目录旁不能有 openleaner-data —— 有就会跑在那份副本上 */
    const stray = path.join(path.dirname(exe), 'openleaner-data');
    if (fs.existsSync(stray)) {
      console.error('❌ 安装目录旁有 openleaner-data —— 会跑在那份副本上，不是真库');
      process.exit(2);
    }
    args = ['--no-sandbox', '--remote-debugging-port=' + PORT];
  } else if (DATA_ARG) {
    exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    args = [ROOT, '--user-data-dir=' + path.resolve(ROOT, DATA_ARG), '--no-sandbox', '--remote-debugging-port=' + PORT];
  } else {
    /* --probe：读真实库的**副本**（绝不直接读真库，避免 lock 干扰用户） */
    const tmp = path.join(ROOT, '.tmp/clean-mock-probe-data');
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
    console.log('probe 模式：读真实库副本 ' + tmp);
  }

  console.log(
    (APPLY ? '=== 真库执行 ===' : DATA_ARG ? '=== 副本演练 ===' : '=== 只读探测 ===') +
      '\n启动：' + path.basename(exe),
  );

  const app = spawn(exe, args, {
    cwd: path.dirname(exe),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

  /* ---------- 1. 探测 ---------- */
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
    db.close();

    const mock = kps.filter((k) => k.backendId === ${JSON.stringify(MOCK_BACKEND_ID)});
    const keep = kps.filter((k) => k.backendId !== ${JSON.stringify(MOCK_BACKEND_ID)});
    const qKpIds = new Set(questions.filter((q) => q.knowledgePointId).map((q) => q.knowledgePointId));

    /* 要删的那些有没有被题目引用 —— 有的话必须先停下来问 */
    const mockReferenced = mock.filter((k) => qKpIds.has(k.id));

    /* 保留的那些，各后端分布 */
    const keepByBackend = {};
    for (const k of keep) keepByBackend[k.backendId || "(无)"] = (keepByBackend[k.backendId || "(无)"] || 0) + 1;

    return {
      total: kps.length,
      toDelete: mock.length,
      toKeep: keep.length,
      keepByBackend,
      mockReferencedByQuestions: mockReferenced.length,
      mockWithExampleTag: mock.filter((k) => (k.tags || []).indexOf("示例后端") >= 0).length,
      keepWithChapter: keep.filter((k) => k.chapter && String(k.chapter).trim()).length,
      keepFavorites: keep.filter((k) => k.favorite).length,
      questionCount: questions.length,
    };
  })()`);

  console.log('\n=== 清理前 ===');
  console.log(JSON.stringify(before, null, 1));

  if (before.toDelete === 0) {
    console.log('\n没有要清理的（backendId = "mock" 的知识点为 0）。');
    try { app.kill(); } catch {}
    await sleep(400);
    process.exit(0);
  }

  if (before.mockReferencedByQuestions > 0) {
    console.error(
      '\n❌ 有 ' + before.mockReferencedByQuestions + ' 条被题目引用，删了会造成悬空引用。已停止。',
    );
    try { app.kill(); } catch {}
    await sleep(400);
    process.exit(2);
  }

  if (PROBE) {
    console.log('\n（--probe：到此为止，没有写任何东西）');
    try { app.kill(); } catch {}
    await sleep(400);
    process.exit(0);
  }

  /* ---------- 2. 执行删除 ---------- */
  const deleted = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    /* 先读出来确认（避免边遍历边删的游标陷阱） */
    const all = await new Promise((res, rej) => {
      const tx = db.transaction("knowledgePoints", "readonly");
      const rq = tx.objectStore("knowledgePoints").getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const ids = all.filter((k) => k.backendId === ${JSON.stringify(MOCK_BACKEND_ID)}).map((k) => k.id);

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

  console.log('\n=== 已删除 ===');
  console.log(JSON.stringify(deleted));

  /* ---------- 3. 独立复核（另起一次读，不信自己的返回值） ---------- */
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

    const mockLeft = kps.filter((k) => k.backendId === ${JSON.stringify(MOCK_BACKEND_ID)}).length;
    const kpIds = new Set(kps.map((k) => k.id));
    const dangling = questions.filter((q) => q.knowledgePointId && !kpIds.has(q.knowledgePointId));

    return {
      total: kps.length,
      mockLeft,
      danglingRefs: dangling.length,
      questions: questions.length,
      reviewRecords: records.length,
      keepWithChapter: kps.filter((k) => k.chapter && String(k.chapter).trim()).length,
      keepFavorites: kps.filter((k) => k.favorite).length,
    };
  })()`);

  console.log('\n=== 独立复核 ===');
  console.log(JSON.stringify(after, null, 1));

  const okDelete = after.mockLeft === 0;
  const okKeep = after.total === before.toKeep;
  const okNoDangling = after.danglingRefs === 0;
  const okChapter = after.keepWithChapter === before.keepWithChapter;
  const okFav = after.keepFavorites === before.keepFavorites;
  const okQuestions = after.questions === before.questionCount;

  console.log('\n=== 判定 ===');
  console.log((okDelete ? '✅' : '❌') + ' 示例知识点清零（剩 ' + after.mockLeft + '）');
  console.log((okKeep ? '✅' : '❌') + ' 保留的条数不变（' + before.toKeep + ' → ' + after.total + '）');
  console.log((okNoDangling ? '✅' : '❌') + ' 无悬空引用');
  console.log((okChapter ? '✅' : '❌') + ' 章节数不变（' + before.keepWithChapter + ' → ' + after.keepWithChapter + '）');
  console.log((okFav ? '✅' : '❌') + ' 收藏数不变（' + before.keepFavorites + ' → ' + after.keepFavorites + '）');
  console.log((okQuestions ? '✅' : '❌') + ' 题目数不变（' + after.questions + '）');

  try { app.kill(); } catch {}
  await sleep(600);
  process.exit(okDelete && okKeep && okNoDangling && okChapter && okFav && okQuestions ? 0 : 1);
})().catch((e) => {
  console.error('脚本出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});