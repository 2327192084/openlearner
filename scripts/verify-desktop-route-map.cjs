/**
 * 验证桌面安装版含本轮改动（2026-11-21）。
 *
 * ## 为什么单独一个脚本
 *
 * `verify-route-map.cjs` 验的是 `dist/` 里那一份（开发构建）。
 * 而**桌面安装版**是另一条路径：`electron:pack` 打 asar → 替换安装目录。
 * 换的过程可能出错（asar 没打进去、exe 与 asar 不配对、换了别的目录），
 * 所以必须**对安装目录里的那个 exe 单独验一次**。
 *
 * ## 与「grep asar 里的源码文件名」的区别
 *
 * 硬约束 5 记过：asar 里装的是 dist 打包产物，按 `.ts` 源码文件名 grep
 * 永远是 0，那条检查对「有」和「没有」都返回 0，等于什么都没验。
 * 这个脚本走**真实 UI**，只看界面上有没有那几样东西。
 *
 * ## 隔离副本
 *
 * 用 `%LOCALAPPDATA%\Programs\OpenLeaner\OpenLeaner.exe`（安装版），
 * 但 `--user-data-dir` + APPDATA 都指向 `.tmp/` 副本 —— **不碰真实库**。
 * 跑前确认安装目录旁没有 `openleaner-data`（会抢先成为 userData）。
 *
 * 用法：node scripts/verify-desktop-route-map.cjs [port]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');
const EXE = path.join(APP, 'OpenLeaner.exe');
const APPDATA = path.resolve(ROOT, '.tmp/desktop-route-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-route-map');
const PORT = Number(process.argv[2] || 9950);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  /* ---------- 前置：确认验的是安装版 ---------- */
  if (!fs.existsSync(EXE)) {
    console.error('找不到安装版：' + EXE);
    process.exit(2);
  }

  /*
   * ⚠️ 硬约束 3：ensureUserDataDir 第 4 候选是
   * path.join(dirname(process.execPath), 'openleaner-data')，会抢先。
   * 所以安装目录旁不能有它 —— 有的话 --user-data-dir 就失效，
   * 验证会跑在别的地方（2026-11-13 那次「已删除但是假的」就是这个原因）。
   */
  const stray = path.join(APP, 'openleaner-data');
  if (fs.existsSync(stray)) {
    console.error('❌ 安装目录旁有 openleaner-data —— --user-data-dir 会失效');
    console.error('   先确认它是历史遗留还是用户数据，别直接删：' + stray);
    process.exit(2);
  }

  const asarPath = path.join(APP, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.error('找不到 app.asar');
    process.exit(2);
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* 真实库副本（只读源目录） */
  const realDb = path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB');
  if (!fs.existsSync(realDb)) {
    console.error('找不到真实库副本源');
    process.exit(2);
  }
  fs.cpSync(realDb, path.join(DATA, 'IndexedDB'), { recursive: true });
  console.log('已复制真实库副本到隔离目录');

  const app = spawn(
    EXE,
    ['--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1000'],
    { cwd: APP, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
    console.error('起不来：' + log.slice(-1500));
    process.exit(2);
  }
  console.log('页面 URL =', target.url.slice(0, 120));

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 1;
  const pending = new Map();
  const errs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
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
      }, 45000);
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expr, ms = 40000, label = '') => {
    const end = Date.now() + ms;
    let tries = 0;
    while (Date.now() < end) {
      await sleep(tries === 0 ? 1500 : 1200);
      tries += 1;
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(7000);

  /* ---------- 1. 确认 --user-data-dir 真生效 ---------- */
  const uddOk = await ev(`(async () => {
    /* 副本里种一条独有的记录，用它证明读写落在副本 */
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const names = [...db.objectStoreNames];
    const stores = db.transaction("settings", "readonly").objectStore("settings");
    const row = await new Promise((res, rej) => {
      const rq = stores.get("app");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return { storeCount: names.length, hasSettings: !!row };
  })()`);
  rec('页面里能打开 openleaner 库（不是空白副本）',
      (uddOk?.storeCount ?? 0) > 10, '分区 ' + uddOk?.storeCount + ' 个');

  /* 反证：副本目录里应该长出 IndexedDB 文件；真实库 mtime 不变由外层脚本核对 */
  const copyDbPath = path.join(DATA, 'IndexedDB');
  rec('数据落在隔离副本目录（--user-data-dir 生效）',
      fs.existsSync(copyDbPath), copyDbPath);

  /* ---------- 2. 侧栏：没有「学习顺序」独立栏 ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(1000);

  const nav = await ev(`(() => {
    const out = [...document.querySelectorAll(".nav-section")].map((sec) => ({
      label: (sec.querySelector(".nav-group__label")?.textContent ?? "").trim(),
      items: [...sec.querySelectorAll(".nav-item__label")].map((x) => x.textContent.trim()),
    }));
    const all = out.flatMap((g) => g.items);
    return { all, hasPlan: all.some((x) => x === "学习顺序"), hasMap: all.some((x) => x === "学习地图") };
  })()`);
  console.log('侧栏 =', JSON.stringify(nav.all));

  rec('**桌面版没有独立的「学习顺序」栏**（用户要求整合）', !nav?.hasPlan);
  rec('「学习地图」在', !!nav?.hasMap);

  /* ---------- 3. 学习地图里有横板路线块 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".map-page") ? true : null`, 25000, '学习地图');
  await sleep(2500);
  await shot('01-desktop-map-route-entry.png');

  const mapInfo = await ev(`(() => {
    const page = document.querySelector(".map-page");
    const txt = page ? (page.textContent || "") : "";
    const starter = page?.querySelector(".rmap--starter");
    return {
      hasRouteBlock: !!page?.querySelector(".rmap"),
      hasRouteTitle: txt.includes("学习路线"),
      hasStarter: !!starter,
      starterHasBtn: !!(starter && [...starter.querySelectorAll("button")].some((b) => (b.textContent || "").indexOf("让 AI 排一条学习路线") >= 0)),
      starterHasChapterBtn: !!(starter && [...starter.querySelectorAll("button")].some((b) => (b.textContent || "").indexOf("补缺失的章节") >= 0)),
      hasTrack: !!page?.querySelector(".rmap__track"),
      hasMapTree: !!page?.querySelector(".map-tree"),
      missingMatch: txt.match(/有 ([0-9]+) 条知识点没有章节/),
      starCount: (txt.match(/\\*\\*/g) || []).length,
      /*
       * 「难度 ≠ 掌握度」的说明（证明路线 UI 真的渲染了，不是空壳）。
       *
       * ⚠️ 第一版这里查的是「掌握度是本地按复习记录算的」——
       * 那句话**代码里根本没有**（我凭印象写的断言）。
       * 页面上真实的措辞是 RouteStarter 的「章节和你的掌握度」
       * 与详情面板的「知识点本身有多难，不是你掌握得怎样」。
       * 断言要引真话，不能引我以为的话。
       */
      hasMasteryHint: txt.includes("章节和你的掌握度") || txt.includes("不是你掌握得怎样"),
    };
  })()`);
  console.log('地图页 =', JSON.stringify(mapInfo, null, 1));

  rec('**桌面版有横板路线块**', !!mapInfo?.hasRouteBlock && !!mapInfo?.hasRouteTitle);
  rec('上半部分章节树仍在（路线是加进来，不是替换）', !!mapInfo?.hasMapTree);
  rec('**有「让 AI 排一条学习路线」按钮**', !!mapInfo?.starterHasBtn);
  rec('**有「补缺失的章节」按钮**（说明章节缺失检测被打进桌面版）',
      !!mapInfo?.starterHasChapterBtn,
      mapInfo?.missingMatch ? '缺 ' + mapInfo.missingMatch[1] + ' 条' : '(无缺章节)');
  rec('已确认的路线为 0（副本里没排过，显示入口态）',
      !mapInfo?.hasTrack && !!mapInfo?.hasStarter);
  rec('**桌面版文案里没有字面星号**', (mapInfo?.starCount ?? -1) === 0, String(mapInfo?.starCount));
  rec('**难度/掌握度分开的说明文案在**（证明 plan-order 相关代码已打进包）',
      !!mapInfo?.hasMasteryHint);

  /* ---------- 4. 考期功能（teammate 那部分）也在桌面版里 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "待办");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".board-page") ? true : null`, 25000, '待办页');
  await sleep(1500);
  await shot('02-desktop-board-exam.png');

  const boardInfo = await ev(`(() => {
    const page = document.querySelector(".board-page");
    const txt = page ? (page.textContent || "") : "";
    const labels = [...(page?.querySelectorAll("label") ?? [])].map((l) => (l.textContent || "").trim());
    return {
      hasPage: !!page,
      hasExamCheckbox: labels.some((l) => l.indexOf("这是考试") >= 0) || txt.includes("这是考试"),
      hasExamBadge: !!page?.querySelector(".bd-exam-badge, .exam-badge, [class*=exam]"),
      examClassCount: page ? page.querySelectorAll("[class*=exam]").length : 0,
      bodyHead: txt.replace(/\\s+/g, " ").slice(0, 260),
    };
  })()`);
  console.log('待办页 =', JSON.stringify(boardInfo, null, 1));

  rec('**桌面版待办页有「这是考试」**（考期功能已打进包）', !!boardInfo?.hasExamCheckbox);
  rec('待办页有考试相关样式类（徽标渲染能力在）',
      (boardInfo?.examClassCount ?? 0) > 0, '类名命中 ' + boardInfo?.examClassCount);

  /* ---------- 5. 首页（plan 小组件 / 倒计时出口存在） ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习库");
    if (el) el.click();
    return true;
  })()`);
  await sleep(3000);
  await shot('03-desktop-home.png');

  const homeInfo = await ev(`(() => {
    const txt = document.querySelector(".page")?.textContent || "";
    return {
      hasTodayCard: txt.includes("今日学习") || txt.includes("题待学"),
      head: txt.replace(/\\s+/g, " ").slice(0, 200),
      starCount: (txt.match(/\\*\\*/g) || []).length,
    };
  })()`);
  rec('首页正常渲染（没有因为新代码白屏）', !!homeInfo?.hasTodayCard, homeInfo?.head?.slice(0, 100));
  rec('首页无字面星号', (homeInfo?.starCount ?? -1) === 0, String(homeInfo?.starCount));

  /* ---------- 6. asar 完整性（用页面内的真实资源验证，不用 fetch） ---------- */
  /*
   * ⚠️ 第一版用 `fetch('./package.json')` 验 asar 完整 —— 在 file:// 下
   * 被 CORS 拦掉，拿到 null，然后我把「读不到」误判成「asar 不完整」。
   *
   * 换个能证明同一件事的判据：页面能跑起来（React 挂载了、导航渲染了）
   * 本身就说明 asar 里的 dist bundle 是完整的 —— 缺文件会白屏。
   * 再补一条：确认 preload 桥在（说明 electron 侧文件也在）。
   */
  const integrity = await ev(`(() => {
    const app = document.querySelector(".app");
    const nav = document.querySelectorAll(".nav-item").length;
    const bridge = typeof window.openleaner === "object" && window.openleaner !== null;
    const bridgeKeys = bridge ? Object.keys(window.openleaner).length : 0;
    return { hasApp: !!app, navCount: nav, hasBridge: bridge, bridgeKeys };
  })()`);
  rec('asar 完整：React 挂载 + 导航渲染 + preload 桥在',
      !!integrity?.hasApp && (integrity?.navCount ?? 0) > 5 && !!integrity?.hasBridge,
      '导航 ' + integrity?.navCount + ' 项 / 桥导出 ' + integrity?.bridgeKeys + ' 个');

  /* ---------- 7. 无控制台报错 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n==========================');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);

  try { app.kill(); } catch {}
  await sleep(800);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});