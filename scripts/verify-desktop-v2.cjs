/**
 * 验证桌面安装版（2026-11-21 深夜那一包）。
 *
 * 重点：示例后端选项真的从界面消失、资料本体路线在、搜索 Key 在。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');
const EXE = path.join(APP, 'OpenLeaner.exe');
const APPDATA = path.join(ROOT, '.tmp/desk-v2-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-v2');
const PORT = 9975;
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
  fs.cpSync(path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'), path.join(DATA, 'IndexedDB'), { recursive: true });

  if (fs.existsSync(path.join(APP, 'openleaner-data'))) {
    console.error('❌ 安装目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    EXE,
    ['--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1100'],
    { cwd: APP, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d));
  app.stderr.on('data', (d) => (log += d));

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
    console.error('起不来：' + log.slice(-800));
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
      errs.push((m.params.args || []).map((a) => a.value ?? '').join(' ').slice(0, 150));
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
      }, 60000);
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

  /* 1. 数据落在副本 */
  const udd = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const n = db.objectStoreNames.length;
    db.close();
    return n;
  })()`);
  rec('--user-data-dir 生效（副本里有库）', udd > 10, udd + ' 个分区');
  rec('数据落在隔离副本目录', fs.existsSync(path.join(DATA, 'IndexedDB')));

  /* 2. 进资料页 → 整理入口 → 检查后端下拉里没有示例后端 */
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
      .find((e) => (e.textContent || "").trim() === "资料");
    if (el) el.click();
    return true;
  })()`);
  await sleep(3500);
  await shot('01-sources.png');

  const navClick = await ev(`(() => {
    const rows = [...document.querySelectorAll("li, .src-row, .source-item, article")];
    const row = rows.find((r) => (r.textContent || "").indexOf("信号与系统") >= 0 && (r.textContent || "").length < 900);
    if (!row) return { ok: false, reason: "no row" };
    const btn = [...row.querySelectorAll("button, a")].find((b) => /整理知识点|重新整理|整理/.test(b.textContent || ""));
    if (!btn) return { ok: false, btns: [...row.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).slice(0, 10) };
    btn.click();
    return { ok: true };
  })()`);
  rec('从资料页进到整理页', navClick?.ok === true, JSON.stringify(navClick).slice(0, 150));
  await sleep(3500);
  await shot('02-organize.png');

  const backendOpts = await ev(`(() => {
    const sels = [...document.querySelectorAll("select")];
    const sel = sels.find((s) => [...s.options].some((o) => /DeepSeek|智谱|GLM|示例后端/.test(o.textContent || "")));
    if (!sel) return { ok: false, selectCount: sels.length };
    return {
      ok: true,
      options: [...sel.options].map((o) => (o.textContent || "").trim()),
      current: sel.value,
      currentText: (sel.selectedOptions[0]?.textContent || "").trim(),
    };
  })()`);
  console.log('后端下拉 =', JSON.stringify(backendOpts, null, 1));

  rec('**桌面版整理页的后端下拉里没有「示例后端」**（已删掉）',
      backendOpts?.ok === true && !(backendOpts?.options ?? []).some((o) => o.indexOf('示例后端') >= 0),
      JSON.stringify(backendOpts?.options));
  rec('**默认选中了真后端**（不是示例后端）',
      backendOpts?.ok === true && backendOpts?.current !== 'mock' && (backendOpts?.currentText ?? '').length > 0,
      '当前=' + backendOpts?.currentText);

  /* 3. 学习地图有资料本体路线面板 */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".rmap--planner") ? true : null`, 25000, '规划面板');
  await sleep(2500);
  await shot('03-map-planner.png');
  const planner = await ev(`(() => {
    const p = document.querySelector(".rmap--planner");
    const txt = p ? (p.textContent || "") : "";
    return {
      has: !!p,
      hasPick: txt.indexOf("选一份资料") >= 0,
      hasConfirm: txt.indexOf("确认科目") >= 0,
      hasSearch: txt.indexOf("联网检索") >= 0,
      stars: (txt.match(/\\*\\*/g) || []).length,
    };
  })()`);
  rec('**桌面版学习地图有资料本体规划面板**', !!planner?.has && !!planner?.hasPick, JSON.stringify(planner).slice(0, 120));
  rec('有确认科目 + 联网检索两段', !!planner?.hasConfirm && !!planner?.hasSearch);
  rec('面板文案无字面星号', (planner?.stars ?? -1) === 0, String(planner?.stars));

  /* 4. 设置页有搜索 Key */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "设置");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".settings-nav__item") ? true : null`, 20000, '设置页');
  await sleep(1200);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".settings-nav__item")].find((e) => (e.textContent || "").indexOf("模型与出题") >= 0);
    if (el) el.click();
    return true;
  })()`);
  await sleep(1800);
  await shot('04-settings-key.png');
  const keyField = await ev(`(() => {
    const s = document.querySelector(".skf");
    return { has: !!s, text: s ? (s.textContent || "").replace(/\\s+/g, " ").slice(0, 160) : null };
  })()`);
  rec('**桌面版设置页有搜索 API Key 输入**', !!keyField?.has, (keyField?.text ?? '').slice(0, 90));

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  try { app.kill(); } catch {}
  await sleep(600);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});