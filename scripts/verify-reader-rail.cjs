/**
 * 验证「阅读器右栏的资源标签」（2026-11-22，方案 7.1 / 7.3）。
 *
 * ## 这个脚本的第一版走错了路（记下来）
 *
 * 我第一版改的是 `src/pages/sources/SourceReader.tsx`（v1 死代码）——
 * 而 `App.tsx` 用的是 `./ReaderPage.tsx`（v2）。源码里其实早就写着
 * 「不是 src/pages/sources/SourcesPage.tsx —— 后者是 v1」，我没读到。
 * 已全部撤回，改在 v2 的 `ReaderSidePanel.tsx`（右栏本来就是独立文件）。
 *
 * ## 类名都是实测出来的
 *
 * 侧栏文本带数量徽标（「资料3」），不能用全等匹配；
 * 资料行是 `.source-row`；阅读器是 `.reader-page`；右栏是 `.rside`。
 *
 * 用法：node scripts/verify-reader-rail.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/rail-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(
  ROOT,
  '.verify-shots/reader-rail' + (process.argv.includes('--desktop') ? '-desktop' : ''),
);
const PORT = Number(process.argv[2] || 9910);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));
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

  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  const APP_DIR = USE_DESKTOP ? path.dirname(exe) : ROOT;

  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('FAIL app 目录旁有 openleaner-data —— 会抢走 userData');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [
      ...(USE_DESKTOP ? [] : [ROOT]),
      '--user-data-dir=' + DATA,
      '--no-sandbox',
      '--remote-debugging-port=' + PORT,
    ],
    { cwd: APP_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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

  const openReader = async () => {
    await ev(`(() => {
      for (const lb of document.querySelectorAll(".nav-group__label")) {
        const b = lb.closest("button"); const g = lb.closest(".nav-group");
        if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
      }
      return true;
    })()`);
    await sleep(800);
    await ev(`(() => {
      const el = [...document.querySelectorAll(".nav-item")]
        .find((e) => (e.textContent || "").trim().startsWith("资料"));
      if (el) el.click();
      return true;
    })()`);
    await waitFor(`document.querySelector(".source-row") ? true : null`, 30000, '资料列表');

    const opened = await ev(`(() => {
      const rows = [...document.querySelectorAll(".source-row")];
      const row = rows.find((r) => (r.textContent || "").indexOf("信号与系统") >= 0);
      if (!row) {
        return { ok: false, available: rows.map((r) => (r.textContent || "").trim().slice(0, 20)) };
      }
      row.click();
      return { ok: true };
    })()`);
    if (!opened || !opened.ok) {
      throw new Error('找不到「信号与系统」那一行。当前：' + JSON.stringify(opened && opened.available));
    }
    await waitFor(`document.querySelector(".reader-page") ? true : null`, 30000, '阅读器');
    await sleep(2500);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1200,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  await openReader();
  await shot('01-reader.png');

  const tabs = await ev(`(() => {
    const side = document.querySelector(".rside");
    if (!side) return { hasSide: false };
    const btns = [...side.querySelectorAll(".rside__tab")].map((b) => ({
      text: (b.textContent || "").trim(),
      on: b.className.indexOf("--on") >= 0,
    }));
    return { hasSide: true, tabs: btns };
  })()`);
  console.log('右栏标签 =', JSON.stringify(tabs));

  rec('阅读器右栏存在（.rside）', !!(tabs && tabs.hasSide));
  rec('右栏有「资源」标签',
      ((tabs && tabs.tabs) || []).some((t) => t.text.indexOf('资源') === 0),
      JSON.stringify(((tabs && tabs.tabs) || []).map((t) => t.text)));

  await ev(`(() => {
    const b = [...document.querySelectorAll(".rside__tab")]
      .find((x) => (x.textContent || "").trim().indexOf("资源") === 0);
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);
  await shot('02-resources-tab.png');

  const panel = await ev(`(() => {
    const side = document.querySelector(".rside");
    const p = side ? side.querySelector(".rpanel") : null;
    return {
      hasPanel: !!p,
      hasAddBtn: !!(p && [...p.querySelectorAll("button")]
        .find((b) => (b.textContent || "").includes("添加资源"))),
      emptyText: p ? (p.querySelector(".rpanel__empty") || {}).textContent || null : null,
      width: side ? Math.round(side.getBoundingClientRect().width) : 0,
    };
  })()`);
  console.log('资源面板 =', JSON.stringify(panel));

  rec('点「资源」标签后面板出现', !!(panel && panel.hasPanel));
  rec('面板有「+ 添加资源」', !!(panel && panel.hasAddBtn));
  rec('右栏宽度约 260px',
      Math.abs(((panel && panel.width) || 0) - 260) <= 24, ((panel && panel.width) || 0) + 'px');

  const contrast = await ev(`(() => {
    const p = document.querySelector(".rside .rpanel");
    if (!p) return { ok: false };
    const el = p.querySelector(".rpanel__title") || p.querySelector(".rpanel__empty");
    if (!el) return { ok: false, why: "no text" };
    const bgOf = (node) => {
      let n = node;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
        n = n.parentElement;
      }
      return "rgb(30,27,24)";
    };
    const lum = (c) => {
      const m = c.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const arr = m[1].split(",").map((x) => parseFloat(x));
      const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
      return 0.2126*f(arr[0]) + 0.7152*f(arr[1]) + 0.0722*f(arr[2]);
    };
    const fg = getComputedStyle(el).color;
    const bg = bgOf(el);
    const L1 = lum(fg);
    const L2 = lum(bg);
    if (L1 === null || L2 === null) return { ok: false, fg, bg };
    return {
      ok: true, fg, bg,
      ratio: Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)) * 100) / 100,
      text: (el.textContent || "").trim().slice(0, 24),
    };
  })()`);
  console.log('对比度 =', JSON.stringify(contrast));
  rec('右栏资源文字看得见（对比度 >=3:1）',
      !!(contrast && contrast.ok) && ((contrast && contrast.ratio) || 0) >= 3,
      ((contrast && contrast.fg) || '') + ' on ' + ((contrast && contrast.bg) || '') +
        ' = ' + ((contrast && contrast.ratio) || '?') + ':1');

  const added = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = document.querySelector(".rside .rpanel");
    const addBtn = [...p.querySelectorAll("button")]
      .find((b) => (b.textContent || "").includes("添加资源"));
    if (!addBtn) return { ok: false, why: "no add button" };
    addBtn.click();
    await sleep(500);
    const input = p.querySelector(".rpanel__input");
    if (!input) return { ok: false, why: "no input" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "www.bilibili.com/video/BVreader");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    [...p.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "添加").click();
    await sleep(1000);
    const items = [...p.querySelectorAll(".rpanel__item")];
    const nameEl = items[0] ? items[0].querySelector(".rpanel__name") : null;
    return {
      ok: true,
      count: items.length,
      name: nameEl ? (nameEl.textContent || "").trim() : "",
    };
  })()`);
  console.log('添加 =', JSON.stringify(added));
  await shot('03-added.png');

  rec('右栏里能加资源', ((added && added.count) || 0) === 1, ((added && added.count) || 0) + ' 条');
  rec('无协议头自动补 https（标题回退成域名）',
      ((added && added.name) || '').indexOf('bilibili') >= 0, added && added.name);

  await send('Page.reload', { ignoreCache: true });
  await sleep(9000);
  await openReader();
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rside__tab")]
      .find((x) => (x.textContent || "").trim().indexOf("资源") === 0);
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);

  const afterReload = await ev(`(() => {
    const p = document.querySelector(".rside .rpanel");
    const items = [...((p && p.querySelectorAll(".rpanel__item")) || [])];
    const nameEl = items[0] ? items[0].querySelector(".rpanel__name") : null;
    return { count: items.length, name: nameEl ? (nameEl.textContent || "").trim() : "" };
  })()`);
  console.log('刷新后 =', JSON.stringify(afterReload));
  rec('刷新后资源还在（存进库了）', ((afterReload && afterReload.count) || 0) === 1,
      ((afterReload && afterReload.count) || 0) + ' 条：' + ((afterReload && afterReload.name) || ''));

  const stars = await ev(`((document.body.textContent || "").match(/\\*\\*/g) || []).length`);
  rec('无字面星号（全页）', stars === 0);

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);

  try { app.kill(); } catch {}
  await sleep(1200);
  const alive = await new Promise((res) => {
    require('node:child_process').exec(
      'tasklist /FI "IMAGENAME eq electron.exe"',
      (e, out) => res(String(out || '').indexOf('electron.exe') >= 0),
    );
  });
  console.log(alive ? 'WARN 仍有 electron 进程' : '已确认进程退出干净');

  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});