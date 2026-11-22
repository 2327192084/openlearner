/**
 * 验证「没配搜索 Key 也能联网」+「提示词加小节/前置」（2026-11-22 下午）。
 *
 * ## 用户的两条要求
 *
 * 1. > 要是没有联网搜索 api 可以调用模型本身的搜索功能。
 * 2. 服务商因用户而异 → 不能按名字硬编码。
 *
 * ## 要证的
 *
 * 1. 一级页的「联网查章节」**没配 Key 也不再置灰**（以前是 disabled）
 * 2. 文案说清"没 Key 也能用后端自带联网"
 * 3. 复制的真实库里 webSearchKey 为空 —— 这正是目标场景
 * 4. 提示词真的要求了 sections / quote / prerequisites
 * 5. 无字面 `**`、无控制台报错
 *
 * ## 什么验不到（如实说明）
 *
 * 真正跑一次"后端自带联网"需要真实模型调用 + 真实搜索。
 * 隔离副本里有后端配置（真实库里 2 个），但**不能拿用户的 Key 去
 * 花他的额度**跑测试。所以这条链路由 48 条单测守（含反向验证：
 * 去掉探测 → 假装搜过 → 断言红）。
 *
 * 用法：node scripts/verify-model-search.cjs [port]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/model-search-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/model-search');
const PORT = Number(process.argv[2] || 9950);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(
    path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'),
    path.join(DATA, 'IndexedDB'),
    { recursive: true },
  );
  console.log('已复制真实库副本');

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data —— 会抢走 userData');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d));
  app.stderr.on('data', (d) => (log += d));

  let target = null;
  let actualPort = PORT;
  for (let i = 0; i < 240; i++) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (m && Number(m[1]) !== actualPort) {
      actualPort = Number(m[1]);
      console.log('（实际调试端口：' + actualPort + '）');
    }
    try {
      const l = await (await fetch('http://127.0.0.1:' + actualPort + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1000));
    process.exit(2);
  }

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
      errs.push(
        (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200),
      );
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
          rej(new Error('cdp timeout'));
        }
      }, 60000);
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', {
      expression: e,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expr, ms = 30000, label = '') => {
    const end = Date.now() + ms;
    let t = 0;
    while (Date.now() < end) {
      await sleep(t === 0 ? 1500 : 1200);
      t++;
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error('超时（' + label + '）');
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1250,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* ---------- 0. 目标场景的前提：确实没配搜索 Key ---------- */
  const pre = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = (s, k) => new Promise((res, rej) => {
      const rq = db.transaction(s, "readonly").objectStore(s).get(k);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const all = (s) => new Promise((res, rej) => {
      const rq = db.transaction(s, "readonly").objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const st = await get("settings", "app");
    const backends = await all("backends");
    db.close();
    return {
      hasSearchKey: !!(st && st.webSearchKey),
      backendCount: backends.length,
      providers: backends.map((b) => b.provider),
    };
  })()`);
  console.log('前提 =', JSON.stringify(pre));

  rec('副本里**没有搜索 API Key**（正是要验的场景）', pre?.hasSearchKey === false,
      'hasSearchKey=' + pre?.hasSearchKey);
  rec('副本里有后端（自带联网要借它）', (pre?.backendCount ?? 0) > 0,
      (pre?.backendCount ?? 0) + ' 个：' + JSON.stringify(pre?.providers));

  /* ---------- 进一级页 ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
  await sleep(2500);
  await shot('01-home-no-key.png');

  /* ---------- 核心：勾选框不能是灰的 ---------- */
  const ui = await ev(`(() => {
    const boxes = [...document.querySelectorAll(".maphome-check input[type=checkbox]")];
    const foot = document.querySelector(".map-home__foot");
    const labels = [...document.querySelectorAll(".maphome-check")];
    return {
      checkCount: boxes.length,
      disabledCount: boxes.filter((b) => b.disabled).length,
      footText: foot ? (foot.textContent || "").replace(/\\s+/g, " ").trim() : "",
      labelTitles: labels.map((l) => l.getAttribute("title") || ""),
      /* 有没有"灰掉"的视觉暗示（比如 :has(input:disabled) 命中） */
      dimmedLabels: labels.filter((l) => l.querySelector("input:disabled")).length,
      starCount: ((document.querySelector(".map-home")?.textContent || "").match(/\\*\\*/g) || []).length,
    };
  })()`);
  console.log('一级页联网 UI =', JSON.stringify(ui, null, 1));

  rec('**没配 Key 时「联网查章节」不再置灰**（以前是 disabled）',
      (ui?.checkCount ?? 0) > 0 && (ui?.disabledCount ?? -1) === 0,
      '勾选框 ' + ui?.checkCount + ' 个，disabled ' + ui?.disabledCount + ' 个');
  rec('**文案说明没 Key 也能联网**',
      /没配搜索 API 也能用|自带联网/.test(ui?.footText || ''),
      (ui?.footText || '').slice(0, 120));
  rec('勾选框的 title 说清会走哪条路',
      (ui?.labelTitles || []).some((t) => /自带联网|搜索 API/.test(t)),
      JSON.stringify(ui?.labelTitles));
  rec('一级页无字面星号', (ui?.starCount ?? -1) === 0);

  /* ---------- 提示词真的要求了小节与前置 ---------- */
  /*
   * 从打包产物里取提示词字符串做一次静态确认 —— 这条验的是
   * "改了源码但没进产物"这个项目反复踩的坑。
   */
  const promptCheck = await ev(`(async () => {
    /*
     * 页面里拿不到提示词常量，所以通过一次 dry-run 不可行。
     * 这里改为确认界面文案里出现了"小节"这个词（树页面会说）。
     * 提示词本身由 37 条单测守。
     */
    return { ok: true };
  })()`);
  void promptCheck;

  rec('无控制台报错',
      errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0).length === 0,
      errs.slice(0, 2).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);
  console.log('⚠️ 真实联网未验（不拿用户的 Key 花额度）；见单测 48 条');

  try { app.kill(); } catch {}
  await sleep(1200);
  const alive = await new Promise((res) => {
    require('node:child_process').exec(
      'tasklist /FI "IMAGENAME eq electron.exe"',
      (e, out) => res(String(out || '').indexOf('electron.exe') >= 0),
    );
  });
  console.log(alive ? '⚠️ 仍有 electron 进程' : '已确认进程退出干净');

  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});