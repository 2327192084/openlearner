/**
 * 清理库里悬空的 `question.knowledgePointId`（2026-11-20）。
 *
 * ## 背景：为什么会有悬空引用
 *
 * `question.knowledgePointId` 本应指向 `knowledgePoints` 里的真实记录。
 * 实测用户真实库 39 道题里 **29 道指向不存在的东西**，两类：
 *
 *  - `variant:<原题id>` —— 变式题造出的伪 id（`questions/variants.ts:176`）
 *  - `seg_xxx` —— 段落 id 被误写成知识点 id
 *
 * 代码在 2026-11-09 就修了（`questions/service.ts:532` 只在
 * `material.origin === 'knowledge'` 时写），**但旧数据没有迁移** ——
 * 而 `migrations.ts` 只处理**备份文件的版本升级**，不是清理库内坏数据的机制。
 *
 * 后果：这些题在「定位到句子」时永远走「只能到页」分支
 * （`locateQuestion` 拿伪 id 去 `points.find()` 必然落空）。
 *
 * ## 为什么置 null 而不是回填真实 id
 *
 * 先探测过（本次实测）：**29 条一条都回填不了**。
 *  - `variant:` 的原题已经不在库里（或原题自己也没有知识点）
 *  - 锚点位置匹配：这些题的锚点全是 `charStart:0, charEnd:整段`，
 *    而知识点的锚点是真句子偏移，两者不可能相等
 *
 * 硬凑一个 id 就是编数据 —— 项目一贯：如实写 null，不给假 id。
 *
 * ## ⚠️ 写真实库的启动方式（这是安全隐患最大的一环）
 *
 * `electron/main.cjs` 的 `ensureUserDataDir()` **不接受命令行参数作为决定项**，
 * 它按候选顺序挑第一个可写的：
 *   1. `library-location.json`   2. `--user-data-dir`
 *   3. `%APPDATA%\OpenLeaner`    4. `<exe 同目录>/openleaner-data` ← 会抢先
 *
 * 11-13 那次「以为删了、其实删了副本」的事故就是第 4 候选赢了。
 * 所以本脚本：
 *  - **真库模式用桌面安装版 + 不带任何目录参数**（userData 就是 `%APPDATA%\OpenLeaner`）
 *  - **演练模式用 --user-data-dir 指向副本**，且只写副本
 *  - 两种模式都先校验「页面里能看到 openleaner 库」才继续
 *
 * ## 安全措施
 *
 * - 默认 dry-run，加 `--apply` 才写
 * - 写前把整份 IndexedDB 备份到 `.tmp/realdb-backup-<时间>/`
 * - 只改 `knowledgePointId` 一个字段，其余字段 `Object.assign` 原样保留
 * - 写后立即读回校验三件事：坏引用归零、有效引用数不变、总题数不变
 *
 * ## 用法
 *
 * ```bash
 * # 1) 演练（自动复制真库，只写副本）
 * node scripts/clean-bad-kp-refs.cjs --data .tmp/rehearsal-appdata
 *
 * # 2) 真库 dry-run（只看不写）
 * node scripts/clean-bad-kp-refs.cjs
 *
 * # 3) 真库执行（必须先确认程序未运行）
 * node scripts/clean-bad-kp-refs.cjs --apply
 * ```
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const REAL_APPDATA = process.env.APPDATA;
const REAL_IDB = path.join(REAL_APPDATA, 'OpenLeaner/IndexedDB');

const dataArg = process.argv.indexOf('--data');
const USE_COPY = dataArg >= 0;
const apply = process.argv.includes('--apply') || USE_COPY;
const COPY_ROOT = USE_COPY ? path.resolve(ROOT, process.argv[dataArg + 1]) : null;
const COPY_DATA = COPY_ROOT ? path.join(COPY_ROOT, 'OpenLeaner') : null;
const PORT = Number(process.env.PORT || 9848);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---------- 准备启动方式 ---------- */
  let exe;
  let args;
  let env;
  let cwd;

  if (USE_COPY) {
    fs.rmSync(COPY_ROOT, { recursive: true, force: true });
    fs.mkdirSync(COPY_DATA, { recursive: true });
    fs.cpSync(REAL_IDB, path.join(COPY_DATA, 'IndexedDB'), { recursive: true });
    console.log('演练：' + COPY_DATA + '（真实库未被触碰）');
    exe = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
    args = [ROOT, '--user-data-dir=' + COPY_DATA, '--no-sandbox', '--remote-debugging-port=' + PORT];
    env = { ...process.env, APPDATA: COPY_ROOT };
    cwd = ROOT;
  } else {
    if (!fs.existsSync(INSTALL_EXE)) {
      console.error('缺桌面安装版：' + INSTALL_EXE);
      process.exit(2);
    }
    console.log('目标：真实库 ' + path.join(REAL_APPDATA, 'OpenLeaner'));
    console.log('模式：' + (apply ? '** 真写 **' : 'dry-run（只看不写）'));
    exe = INSTALL_EXE;
    /* 不带任何目录参数 —— 见文件头对 ensureUserDataDir 的说明 */
    args = ['--no-sandbox', '--remote-debugging-port=' + PORT];
    env = { ...process.env };
    cwd = path.dirname(INSTALL_EXE);
  }

  if (!USE_COPY && apply) {
    const bk = path.join(ROOT, '.tmp', 'realdb-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(bk, { recursive: true });
    fs.cpSync(REAL_IDB, path.join(bk, 'IndexedDB'), { recursive: true });
    console.log('已备份到 ' + bk);
  }

  const app = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let target = null;
  for (let i = 0; i < 240; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1200));
    app.kill();
    process.exit(2);
  }
  console.log('页面：' + target.url.slice(0, 90));

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
  await sleep(3500);

  /* ---------- 确认连到了预期那个库 ---------- */
  const where = await ev(`(async () => (await indexedDB.databases()).map((d) => d.name))()`);
  console.log('可见的库：' + JSON.stringify(where));
  if (!where.includes('openleaner')) {
    console.error('❌ 页面里没有 openleaner 库 —— 目录指错了，中止');
    ws.close();
    app.kill();
    process.exit(2);
  }

  /* ---------- 写之前 ---------- */
  const before = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open("openleaner");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    const getAll = (st) => new Promise((res, rej) => {
      const tx = db.transaction(st, "readonly");
      const rq = tx.objectStore(st).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const [qs, kps] = await Promise.all([getAll("questions"), getAll("knowledgePoints")]);
    db.close();
    const kpIds = new Set(kps.map((k) => k.id));
    const withId = qs.filter((q) => q.knowledgePointId);
    return {
      totalQuestions: qs.length,
      totalKp: kps.length,
      withId: withId.length,
      good: withId.filter((q) => kpIds.has(q.knowledgePointId)).length,
      bad: withId.filter((q) => !kpIds.has(q.knowledgePointId)).length,
    };
  })()`);
  console.log('\n写之前：' + JSON.stringify(before, null, 1));

  if (before.bad === 0) {
    console.log('\n没有悬空引用，无需处理。');
    ws.close();
    app.kill();
    return;
  }
  if (!apply) {
    console.log('\n（dry-run）将把 ' + before.bad + ' 条置 null；有效引用 ' + before.good + ' 条不动。');
    ws.close();
    app.kill();
    return;
  }

  /* ---------- 执行 ---------- */
  const done = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open("openleaner");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    const getAll = (st) => new Promise((res, rej) => {
      const tx = db.transaction(st, "readonly");
      const rq = tx.objectStore(st).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const [qs, kps] = await Promise.all([getAll("questions"), getAll("knowledgePoints")]);
    const kpIds = new Set(kps.map((k) => k.id));
    const toFix = qs.filter((q) => q.knowledgePointId && !kpIds.has(q.knowledgePointId));
    if (toFix.length === 0) { db.close(); return { fixed: 0 }; }

    /* 只改 knowledgePointId；其余字段原样写回 */
    const updated = toFix.map((q) => Object.assign({}, q, { knowledgePointId: null }));
    await new Promise((res, rej) => {
      const tx = db.transaction("questions", "readwrite");
      const st = tx.objectStore("questions");
      updated.forEach((q) => st.put(q));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });

    const qs2 = await getAll("questions");
    db.close();
    const withId2 = qs2.filter((q) => q.knowledgePointId);
    return {
      fixed: toFix.length,
      afterTotal: qs2.length,
      afterWithId: withId2.length,
      afterGood: withId2.filter((q) => kpIds.has(q.knowledgePointId)).length,
      afterBad: withId2.filter((q) => !kpIds.has(q.knowledgePointId)).length,
    };
  })()`);
  console.log('\n执行结果：' + JSON.stringify(done, null, 1));

  ws.close();
  app.kill();
  await sleep(2000);

  const ok =
    done.fixed === before.bad &&
    done.afterBad === 0 &&
    done.afterGood === before.good &&
    done.afterTotal === before.totalQuestions;
  console.log('\n' + (ok ? '✅ 清理完成，三项校验全过' : '❌ 校验不通过'));
  if (!ok) process.exitCode = 1;
})();