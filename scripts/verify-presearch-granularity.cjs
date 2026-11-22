/**
 * 验证「预搜粒度做成可选项」（2026-11-23，用户拍板）。
 *
 * ## 验什么（真实操作路径）
 *
 * 1. 一级页勾「联网查章节」→ 粒度 radio 出现；取消勾 → 消失（假开关双向查）
 * 2. radio 切换 → 成本话术**跟着变**（章级说章级、小节级带 30 量级）
 *    —— 这是"控件状态与提示内容之间的关系"，本项目断言盲区的老配方
 * 3. 话术里明说"模型调用"（成本如实提示，不藏）
 * 4. 默认选中章级
 * 5. 无控制台报错
 *
 * ## 什么验不到（如实说明）
 *
 * 点「创建地图」会把 radio 的值真的传到预搜调用 —— 但建图要调模型、
 * 花真实额度，不能拿测试名义跑。这条链由两层钉住：
 *  - tsc：`onCreate(prep, name, wantSearch, granularity)` 四参签名，
 *    App 的 `createTreeFor` 少了第 4 参就编译不过（接线不会被静默拆掉）
 *  - 单测：`describePresearchCostEstimate` 与 `PRESEARCH_MAX_TASKS`
 *    的对应关系（含 3 组反向验证，见 presearch-resources.test.ts）
 *
 * 用法：node scripts/verify-presearch-granularity.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/gran-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/granularity');
const PORT = Number(process.argv[2] || 9892);
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
  console.log('已复制真实库副本（隔离）');

  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, 'release/win-unpacked/OpenLeaner.exe');
  const APP_DIR = path.dirname(exe);

  if (fs.existsSync(path.join(APP_DIR, 'openleaner-data'))) {
    console.error('FAIL app 目录旁有 openleaner-data（候选 #4 会抢 userData）');
    process.exit(2);
  }

  const app = spawn(
    exe,
    ['--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT],
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
      console.log('（实际端口：' + actualPort + '）');
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
  const waitForOr = async (ms, expr) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(1200);
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    return null;
  };
  const finish = async () => {
    try {
      app.kill();
    } catch {}
    await sleep(1200);
    const alive = await new Promise((res) => {
      require('node:child_process').exec(
        USE_DESKTOP
          ? 'tasklist /FI "IMAGENAME eq OpenLeaner.exe"'
          : 'tasklist /FI "IMAGENAME eq OpenLeaner.exe"',
        (e, out) => res(String(out || '').indexOf('OpenLeaner.exe') >= 0),
      );
    });
    console.log(alive ? 'WARN 仍有 OpenLeaner 进程' : '已确认进程退出干净');
    process.exit(fail === 0 ? 0 : 1);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1200,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* ---------- 进一级页（侧栏展开 → 点「学习地图」） ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  const onLevel1 = await waitForOr(20000, 'document.querySelector(".map-home") ? true : null');
  if (!onLevel1) {
    rec('进得了一级页', false, '超时');
    await finish();
    return;
  }
  await sleep(1500);

  /* ---------- 找一份还没有地图的行（有创建表单的那行） ---------- */
  let rowInfo = await ev(`(() => {
    const rows = [...document.querySelectorAll(".maphome-row")];
    const target = rows.find((r) => !r.classList.contains("maphome-row--has"));
    if (!target) return { ok: false, rows: rows.length };
    target.setAttribute("data-vt", "1");
    const title = target.querySelector(".maphome-row__title");
    return { ok: true, title: title ? title.textContent.trim().slice(0, 40) : '' };
  })()`);

  /*
   * 库实测 3 份资料**都已有地图** —— 没有"未建图"的行。
   * 这里在隔离副本上先删一份地图制造该行（删的是 settings 里的地图，
   * 副本随便动；真实库不碰）。按标题锁定被删的那份（硬约束 18）。
   */
  if (!rowInfo.ok) {
    console.log('没有未建图的行 → 在副本上删一份地图（按标题锁定）');
    const del = await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = [...document.querySelectorAll(".maphome-row")];
      /* 选标题含"高数"的那份（用户说过它的地图最不重要）；没有就取最后一行 */
      let row = rows.find((r) => ((r.querySelector(".maphome-row__title") || {}).textContent || "").indexOf("高数") >= 0) || rows[rows.length - 1];
      const title = (row.querySelector(".maphome-row__title") || {}).textContent || '';
      const open = [...row.querySelectorAll("button")].find((b) => (b.textContent || "").includes("查看地图"));
      if (!open) return { ok: false, why: 'no open btn', title };
      open.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        await sleep(400);
        if (document.querySelector(".rtree")) break;
      }
      const clear = [...document.querySelectorAll(".rtree button, .map-tree-page button")]
        .find((b) => (b.textContent || "").includes("删除这张地图") || (b.textContent || "").includes("删除地图"));
      if (!clear) return { ok: false, why: 'no clear btn', title };
      clear.click();
      await sleep(600);
      const conf = [...document.querySelectorAll(".set-modal__actions button")]
        .find((b) => (b.textContent || "").trim() === "删除");
      if (!conf) return { ok: false, why: 'no confirm btn', title };
      conf.click();
      const t1 = Date.now();
      while (Date.now() - t1 < 20000) {
        await sleep(400);
        if (document.querySelector(".map-home")) break;
      }
      return { ok: !!document.querySelector(".map-home"), title };
    })()`);
    console.log('删地图前置 =', JSON.stringify(del));
    await sleep(1500);
    rowInfo = await ev(`(() => {
      const rows = [...document.querySelectorAll(".maphome-row")];
      const target = rows.find((r) => !r.classList.contains("maphome-row--has"));
      if (!target) return { ok: false, rows: rows.length };
      target.setAttribute("data-vt", "1");
      const title = target.querySelector(".maphome-row__title");
      return { ok: true, title: title ? title.textContent.trim().slice(0, 40) : '' };
    })()`);
  }
  console.log('测试行 =', JSON.stringify(rowInfo));
  rec('一级页有可创建地图的资料行', !!(rowInfo && rowInfo.ok), JSON.stringify(rowInfo));
  if (!rowInfo || !rowInfo.ok) {
    rec('（无法继续）粒度区检查', false, '库里每份资料都已有地图');
    await finish();
    return;
  }

  /* ---------- 1. 没勾联网时不显示粒度区（假开关双向查·方向1） ---------- */
  const before = await ev(`(() => {
    const row = document.querySelector('.maphome-row[data-vt="1"]');
    return {
      hasGran: !!(row && row.querySelector('.maphome-gran')),
      hasSearchCheck: !!(row && row.querySelector('.maphome-check input[type="checkbox"]')),
    };
  })()`);
  rec('未勾联网时粒度区不出现', !before.hasGran && before.hasSearchCheck, JSON.stringify(before));

  /* ---------- 2. 勾上 → 出现 + 章级话术 ---------- */
  await ev(`(() => {
    const row = document.querySelector('.maphome-row[data-vt="1"]');
    row.querySelector('.maphome-check input[type="checkbox"]').click();
    return true;
  })()`);
  await sleep(700);
  const c1 = await ev(`(() => {
    const g = document.querySelector('.maphome-row[data-vt="1"] .maphome-gran');
    if (!g) return { has: false };
    const radios = [...g.querySelectorAll('input[type="radio"]')];
    const cost = g.querySelector('.maphome-gran__cost');
    return {
      has: true,
      radios: radios.length,
      checkedIdx: radios.findIndex((r) => r.checked),
      costText: cost ? cost.textContent.trim() : '',
    };
  })()`);
  console.log('勾联网后 =', JSON.stringify(c1));
  rec('勾联网后粒度区出现（方向2）', !!(c1 && c1.has));
  rec('两个粒度选项且默认选中章级', !!(c1 && c1.has && c1.radios === 2 && c1.checkedIdx === 0),
      'radios=' + (c1 && c1.radios) + ' checked=' + (c1 && c1.checkedIdx));
  rec('章级话术按章说、带模型调用字样',
      !!(c1 && /按章找资料/.test(c1.costText) && /模型调用|估/.test(c1.costText)),
      c1 && c1.costText.slice(0, 60));
  await shot('01-chapter.png');

  /* ---------- 3. 切到小节级 → 话术必须跟着变（关系断言） ---------- */
  await ev(`(() => {
    const g = document.querySelector('.maphome-row[data-vt="1"] .maphome-gran');
    [...g.querySelectorAll('input[type="radio"]')][1].click();
    return true;
  })()`);
  await sleep(700);
  const c3 = await ev(`(() => {
    const g = document.querySelector('.maphome-row[data-vt="1"] .maphome-gran');
    const cost = g.querySelector('.maphome-gran__cost');
    const radios = [...g.querySelectorAll('input[type="radio"]')];
    return {
      checkedIdx: radios.findIndex((r) => r.checked),
      costText: cost ? cost.textContent.trim() : '',
    };
  })()`);
  console.log('切小节级后 =', JSON.stringify(c3));
  rec('radio 切到小节级', !!(c3 && c3.checkedIdx === 1));
  rec(
    '⚠️ 话术跟着粒度变（按小节 + 30 量级，不再说按章）',
    !!(c3 && /按小节找资料/.test(c3.costText) && !/按章找资料/.test(c3.costText)),
    c3 && c3.costText.slice(0, 70),
  );
  rec('小节级话术带上限量级 30', !!(c3 && /30/.test(c3.costText)), c3 && c3.costText.slice(0, 70));
  await shot('02-section.png');

  /* ---------- 4. 取消联网 → 粒度区再消失 ---------- */
  await ev(`(() => {
    const row = document.querySelector('.maphome-row[data-vt="1"]');
    row.querySelector('.maphome-check input[type="checkbox"]').click();
    return true;
  })()`);
  await sleep(600);
  const c4 = await ev(`!!document.querySelector('.maphome-row[data-vt="1"] .maphome-gran')`);
  rec('取消联网后粒度区收起（不是留下了假控件）', c4 === false);

  /* ---------- 5. 控制台 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);
  console.log('如实说明：没点「创建地图」（花真实额度）；granularity 传参链由 tsc 签名 + 单测钉住。');

  await finish();
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
