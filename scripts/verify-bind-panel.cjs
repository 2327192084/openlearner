/**
 * 验证「闪卡/题组绑定面板」（2026-11-22）。
 *
 * ## 用户原话
 *
 * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
 * > 但要留个给用户手工绑定的入口
 *
 * 自动绑定要调真模型（隔离副本里没有可用后端，不能拿用户的 Key 花额度），
 * 所以这里验**手工入口**这条等价路径：面板在不在、两块都在不在、
 * 统计有没有标注来源。
 *
 * 自动绑定的逻辑由 27 条单测守（含反向验证：去掉防重复绑 → 1 条红）。
 *
 * 用法：node scripts/verify-bind-panel.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/bind-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/bind-panel');
const PORT = Number(process.argv[2] || 9900);
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
    console.error('FAIL app 目录旁有 openleaner-data');
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
      console.log('（端口：' + actualPort + '）');
    }
    try {
      const l = await (await fetch('http://127.0.0.1:' + actualPort + '/json/list')).json();
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

  const gotoTree = async () => {
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
        .find((e) => (e.textContent || "").trim() === "学习地图");
      if (el) el.click();
      return true;
    })()`);
    await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
    await sleep(1500);

    const picked = await ev(`(() => {
      const rows = [...document.querySelectorAll(".maphome-row")];
      const row = rows.find((r) => {
        const t = r.querySelector(".maphome-row__title");
        return t && (t.textContent || "").indexOf("信号与系统") >= 0;
      });
      if (!row) return { ok: false };
      const b = [...row.querySelectorAll("button")].find((x) =>
        (x.textContent || "").includes("查看地图"),
      );
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    })()`);
    if (!picked || !picked.ok) throw new Error('找不到「信号与系统」地图');
    await waitFor(`document.querySelector(".rtree") ? true : null`, 30000, '二级页');
    await sleep(2000);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1300,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  await gotoTree();
  await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector(".rtree__node--chapter")?.click();
    await sleep(900);
    document.querySelector(".rtree__node--section")?.click();
    await sleep(900);
    return true;
  })()`);
  await sleep(1200);
  await shot('01-detail-with-binding.png');

  const panel = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    const b = d ? d.querySelector(".bindp") : null;
    return {
      hasDetail: !!d,
      hasPanel: !!b,
      labels: b ? [...b.querySelectorAll(".bindp__label")].map((e) => (e.textContent || "").trim()) : [],
      hasNote: b ? !!b.querySelector(".bindp__note") : false,
      emptyHint: b && b.querySelector(".bindp__empty")
        ? (b.querySelector(".bindp__empty").textContent || "").trim().slice(0, 60)
        : null,
    };
  })()`);
  console.log('绑定面板 =', JSON.stringify(panel));

  rec('小节详情里有绑定面板', !!(panel && panel.hasPanel));
  rec('有「绑定的闪卡」与「绑定的题组」两块',
      ((panel && panel.labels) || []).length === 2, JSON.stringify(panel && panel.labels));
  rec('有说明文字（AI 自动绑 + 可自己改）', !!(panel && panel.hasNote));

  /*
   * 用户库实测闪卡 0 张、题组有 11 个（含草稿）。
   * 面板应如实说明"库里还没有闪卡/题组"而不是摆空列表。
   */
  console.log('空态提示 =', panel && panel.emptyHint);

  const statsSrc = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    return {
      srcs: [...(d ? d.querySelectorAll(".rsdetail__stat-src") : [])]
        .map((e) => (e.textContent || "").trim()),
    };
  })()`);
  console.log('统计来源标注 =', JSON.stringify(statsSrc));
  rec('统计标注了来源（绑定的 / 自动找到的）',
      ((statsSrc && statsSrc.srcs) || []).length > 0, JSON.stringify(statsSrc && statsSrc.srcs));

  /* ---------- 折叠三角形（2026-11-22 用户要求） ---------- */
  const collapse = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const toggles = [...document.querySelectorAll(".rsdetail .bindp__toggle")];
    if (toggles.length < 2) return { hasToggles: toggles.length };
    const carets = toggles.map(t => t.querySelector(".bindp__caret"));
    const before = toggles.map(t => t.getAttribute("aria-expanded"));
    const caretBefore = carets.map(c => c ? getComputedStyle(c).transform : null);
    toggles[0].click();
    await sleep(500);
    const after = toggles.map(t => t.getAttribute("aria-expanded"));
    const caretAfter = carets.map(c => c ? getComputedStyle(c).transform : null);
    toggles[0].click();
    await sleep(400);
    return {
      hasToggles: toggles.length, before, after, caretBefore, caretAfter,
      hasCaretGlyph: carets.every(c => !!c),
    };
  })()`);
  console.log('折叠 =', JSON.stringify(collapse));
  await shot('02-collapse.png');

  rec('两个区块各有一个折叠按钮', (collapse && collapse.hasToggles) === 2,
      (collapse && collapse.hasToggles) + ' 个');
  rec('有倒三角形图标', !!(collapse && collapse.hasCaretGlyph));
  rec('三角形字号够大（>=12px，太小等于没有入口）',
      (await ev(`(() => {
        const c = document.querySelector(".rsdetail .bindp__caret");
        if (!c) return 0;
        return parseFloat(getComputedStyle(c).fontSize);
      })()`)) >= 12);
  rec('本节未绑卡时有「生成几张闪卡」按钮（与全库有没有卡无关）',
      (await ev(`(() => {
        const p = document.querySelector(".rsdetail .bindp");
        if (!p) return false;
        return [...p.querySelectorAll("button")].some(b => (b.textContent||"").indexOf("生成") >= 0);
      })()`)) === true);
  rec('点击能切换展开/收起（aria-expanded 变化）',
      !!(collapse && collapse.before[0] === 'true' && collapse.after[0] === 'false'),
      JSON.stringify(collapse && collapse.before) + ' -> ' + JSON.stringify(collapse && collapse.after));
  rec('三角形跟着旋转（transform 变了）',
      !!(collapse && collapse.caretBefore[0] !== collapse.caretAfter[0]),
      (collapse && collapse.caretBefore[0]) + ' -> ' + (collapse && collapse.caretAfter[0]));

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