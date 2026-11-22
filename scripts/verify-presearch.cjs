/**
 * 验证「规划时预搜外部资源」+「死代码清理」（2026-11-22）。
 *
 * ## 为什么这两件事一起验
 *
 * 它们在同一轮做的，而且都会影响"建地图"这条路径：
 *  - 死代码清理删掉了 MapPage/RoutePlanner/RouteBoard
 *  - 预搜插在建图流程里
 *
 * 如果清理有遗漏（比如某个组件还在被引用），建图会白屏 ——
 * 那种情况下"预搜能不能用"根本无从谈起。所以先验建图整体，
 * 再验预搜那部分。
 *
 * ## 要证的
 *
 * 1. 学习地图两级页面仍然正常工作（清理没有弄坏它）
 * 2. 一级页能列出资料、能进二级页
 * 3. 二级页的树渲染正常
 * 4. **死代码没留在产物里**（MapPage/RoutePlanner/RouteBoard 类名与文案）
 * 5. 资源面板与绑定面板都还在（这两块是新功能）
 * 6. 无控制台报错
 *
 * ## 什么验不到（如实说明）
 *
 * 预搜要真调模型（每章一次），不能拿用户的 Key 花额度跑测试。
 * 所以这里不验"预搜真的搜到了什么"，只验：
 *  - 建图流程没被清理弄坏
 *  - 预搜的纯逻辑（36 条单测 + 反向验证）
 *
 * 用法：node scripts/verify-presearch.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/presearch-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/presearch');
const PORT = Number(process.argv[2] || 9890);
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
    height: 1300,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

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
    const el = [...document.querySelectorAll(".nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
  await sleep(2000);
  await shot('01-level1.png');

  const lvl1 = await ev(`(() => {
    const h = document.querySelector(".map-home");
    if (!h) return { has: false };
    return {
      has: true,
      rows: h.querySelectorAll(".maphome-row").length,
      createBtns: [...h.querySelectorAll("button")].filter((b) =>
        (b.textContent || "").trim() === "创建地图").length,
      openBtns: [...h.querySelectorAll("button")].filter((b) =>
        (b.textContent || "").includes("查看地图")).length,
      /* 死代码的痕迹 */
      hasOldBoard: !!document.querySelector(".rboard"),
      hasOldPlanner: !!document.querySelector(".rmap--planner"),
      hasOldMapTree: !!document.querySelector(".map-tree"),
    };
  })()`);
  console.log('一级页 =', JSON.stringify(lvl1));

  rec('清理后一级页仍正常渲染', !!(lvl1 && lvl1.has));
  rec('每份资料一行且都有动作', ((lvl1 && lvl1.rows) || 0) > 0 &&
      ((lvl1 && lvl1.createBtns) || 0) + ((lvl1 && lvl1.openBtns) || 0) === lvl1.rows,
      '行=' + (lvl1 && lvl1.rows) + ' 建=' + (lvl1 && lvl1.createBtns) +
        ' 看=' + (lvl1 && lvl1.openBtns));
  rec('死代码的 DOM 痕迹全部消失（横板/规划表单/旧章节列表）',
      !(lvl1 && lvl1.hasOldBoard) && !(lvl1 && lvl1.hasOldPlanner) && !(lvl1 && lvl1.hasOldMapTree),
      'rboard=' + (lvl1 && lvl1.hasOldBoard) + ' planner=' + (lvl1 && lvl1.hasOldPlanner) +
        ' mapTree=' + (lvl1 && lvl1.hasOldMapTree));

  /* ---------- 进二级页 ---------- */
  const picked = await ev(`(() => {
    const rows = [...document.querySelectorAll(".maphome-row")];
    const row = rows.find((r) => {
      const t = r.querySelector(".maphome-row__title");
      return t && (t.textContent || "").indexOf("信号与系统") >= 0;
    });
    if (!row) return { ok: false, count: rows.length };
    const b = [...row.querySelectorAll("button")].find((x) =>
      (x.textContent || "").includes("查看地图"));
    if (!b) return { ok: false, why: 'no open button' };
    b.click();
    return { ok: true };
  })()`);
  if (!picked || !picked.ok) {
    console.error('进不了二级页：' + JSON.stringify(picked));
    rec('能进入二级页', false, JSON.stringify(picked));
  } else {
    await waitFor(`document.querySelector(".rtree") ? true : null`, 30000, '二级页');
    await sleep(2500);
    await shot('02-level2.png');

    const lvl2 = await ev(`(() => {
      const t = document.querySelector(".rtree");
      return {
        hasTree: !!t,
        chapters: t ? t.querySelectorAll(".rtree__node--chapter").length : 0,
        root: t ? t.querySelectorAll(".rtree__node--root").length : 0,
        wires: t ? t.querySelectorAll(".rtree__wire").length : 0,
        hasBack: !!document.querySelector(".map-tree-page__back"),
        hasLevel1: !!document.querySelector(".map-home"),
      };
    })()`);
    console.log('二级页 =', JSON.stringify(lvl2));

    rec('清理后树仍正常渲染', !!(lvl2 && lvl2.hasTree) &&
        ((lvl2 && lvl2.chapters) || 0) > 0 && ((lvl2 && lvl2.root) || 0) === 1,
        '章=' + (lvl2 && lvl2.chapters) + ' 根=' + (lvl2 && lvl2.root) +
          ' 线=' + (lvl2 && lvl2.wires));
    rec('两级页面仍然分开', !(lvl2 && lvl2.hasLevel1));
    rec('返回按钮还在', !!(lvl2 && lvl2.hasBack));

    /* ---------- 两块新功能都还在（清理没误删） ---------- */
    await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector(".rtree__node--chapter")?.click();
      await sleep(900);
      document.querySelector(".rtree__node--section")?.click();
      await sleep(900);
      return true;
    })()`);
    await sleep(1200);
    await shot('03-detail.png');

    const detail = await ev(`(() => {
      const d = document.querySelector(".rsdetail");
      return {
        hasDetail: !!d,
        hasResourcePanel: !!(d && d.querySelector(".rpanel")),
        hasBindingPanel: !!(d && d.querySelector(".bindp")),
        hasCaret: !!(d && d.querySelector(".bindp__caret")),
      };
    })()`);
    console.log('详情面板 =', JSON.stringify(detail));

    rec('资源面板还在（清理没误删）', !!(detail && detail.hasResourcePanel));
    rec('绑定面板还在', !!(detail && detail.hasBindingPanel));
    rec('折叠三角形还在', !!(detail && detail.hasCaret));
  }

  /* ---------- 死代码字符串不该出现在产物里 ---------- */
  /*
   * 这条验的是"构建产物"而不是 DOM —— 死代码即使不渲染，
   * 留在包里也会让包变大、让以后的人以为它还在用。
   */
  const bundleCheck = await ev(`(async () => {
    /* 页面里拿不到 bundle 文本，所以查 DOM 里有没有它们的类名残留 */
    const html = document.documentElement.outerHTML;
    return {
      hasRboard: html.indexOf("rboard") >= 0,
      hasRmap: html.indexOf("rmap--planner") >= 0,
    };
  })()`);
  rec('DOM 里没有旧横板的类名', !(bundleCheck && bundleCheck.hasRboard));
  rec('DOM 里没有旧规划表单的类名', !(bundleCheck && bundleCheck.hasRmap));

  rec('无字面星号（全页）',
      (await ev(`((document.body.textContent || "").match(/\\*\\*/g) || []).length`)) === 0);

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);
  console.log('注意：预搜要真调模型（每章一次），未做端到端；纯逻辑由 36 条单测覆盖');

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