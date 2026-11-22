/**
 * 验证「外部资源栏」（2026-11-22，方案第 7 步）。
 *
 * ## 用户确认过的口径
 *
 * - 自建入口：**小节详情 + 阅读器右栏都留**
 * - 表单：**只有网址必填**，标题留空自动回退
 * - 坏输入：`javascript:` / `file://` 拒绝，无协议头自动补 https
 *
 * ## 要证的
 *
 * 1. 小节详情里有「+ 添加资源」
 * 2. 加一条正常网址 → 出现在列表里，带域名/来源/相对时间
 * 3. **`javascript:` 被拒**，且输入框内容**没被清空**（方案 7.5 要求）
 * 4. 无协议头自动补 https
 * 5. 重复网址被拒
 * 6. 刷新后资源还在（存下来了）
 * 7. 无字面 `**`、无控制台报错
 *
 * 用真实库副本跑（不碰真库）。
 * 用法：node scripts/verify-resources.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/resources-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(
  ROOT,
  '.verify-shots/resources' + (process.argv.includes('--desktop') ? '-desktop' : ''),
);
const PORT = Number(process.argv[2] || 9930);
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

  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  const APP_DIR = USE_DESKTOP ? path.dirname(exe) : ROOT;

  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data —— 会抢走 userData');
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

  /**
   * 进「信号与系统」那张地图。
   *
   * ⚠️ 不能点"第一个查看地图"——库里可能有**多张地图**
   * （实测用户库现在有 3 张：信号与系统 / 高等数学 / 安全监测与控制）。
   * 点第一个会随机进到别的资料，验证结果不可复现，
   * 而且断言会对着不相干的数据判断。
   *
   * 所以按**资料标题**找那一行。找不到就报错退出（不静默跑偏）。
   */
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
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => (e.textContent || "").trim() === "学习地图");
      if (el) el.click();
      return true;
    })()`);
    await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
    await sleep(1500);

    const picked = await ev(`(() => {
      /* 按标题挑"信号与系统"那一行（有多张地图时必须定死一个） */
      const rows = [...document.querySelectorAll(".maphome-row")];
      const row = rows.find((r) => {
        const t = (r.querySelector(".maphome-row__title")?.textContent || "");
        return t.indexOf("信号与系统") >= 0;
      });
      if (!row) {
        return {
          ok: false,
          available: rows.map((r) => (r.querySelector(".maphome-row__title")?.textContent || "").trim()),
        };
      }
      const b = [...row.querySelectorAll("button")].find((x) => (x.textContent || "").includes("查看地图"));
      if (!b) return { ok: false, why: "这一行没有查看地图按钮" };
      b.click();
      return { ok: true };
    })()`);

    if (!picked?.ok) {
      throw new Error(
        '找不到「信号与系统」那张地图。当前可用：' + JSON.stringify(picked?.available ?? picked),
      );
    }

    await waitFor(`document.querySelector(".rtree") ? true : null`, 30000, '二级页');
    await sleep(2000);
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

  /* ---------- 进二级页，展开章、打开小节 ---------- */
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
  await shot('01-section-with-resources.png');

  const initial = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    const p = d?.querySelector(".rsdetail__resources .rpanel");
    return {
      hasDetail: !!d,
      hasPanel: !!p,
      hasAddBtn: !!([...(p?.querySelectorAll("button") || [])]
        .find((b) => (b.textContent || "").includes("添加资源"))),
      emptyText: (p?.querySelector(".rpanel__empty")?.textContent || "").trim(),
    };
  })()`);
  console.log('初始态 =', JSON.stringify(initial));

  rec('小节详情里有资源面板', !!initial?.hasPanel);
  rec('有「+ 添加资源」按钮', !!initial?.hasAddBtn);
  rec('空态说明了可以加什么', (initial?.emptyText || '').length > 0, initial?.emptyText);

  /* ---------- 坏输入：javascript: 必须被拒且不清空 ---------- */
  const bad = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = document.querySelector(".rsdetail__resources .rpanel");
    const add = [...p.querySelectorAll("button")].find((b) => (b.textContent || "").includes("添加资源"));
    if (!add) return { ok: false, why: "没有添加按钮" };
    add.click();
    await sleep(500);
    const input = p.querySelector(".rpanel__input");
    if (!input) return { ok: false, why: "没有输入框" };

    /* 用原生 setter 写值，再触发 input 事件（React 受控组件需要） */
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    setVal(input, "javascript:alert(1)");
    await sleep(200);
    const submit = [...p.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "添加");
    submit.click();
    await sleep(600);

    const errEl = p.querySelector(".rpanel__err");
    return {
      ok: true,
      err: errEl ? (errEl.textContent || "").trim() : null,
      inputStillHasValue: (p.querySelector(".rpanel__input")?.value || "").length > 0,
      inputValue: p.querySelector(".rpanel__input")?.value || "",
      itemCount: p.querySelectorAll(".rpanel__item").length,
    };
  })()`);
  console.log('javascript: 被拒 =', JSON.stringify(bad));
  await shot('02-reject-javascript.png');

  rec('**`javascript:` 被拒绝**', typeof bad?.err === 'string' && bad.err.indexOf('可执行脚本') >= 0, bad?.err);
  rec('**拒绝后输入框内容没被清空**（用户改一个字就能重试）', !!bad?.inputStillHasValue, bad?.inputValue);
  rec('被拒时列表里没有多出东西', (bad?.itemCount ?? -1) === 0, (bad?.itemCount ?? 0) + ' 条');

  /* ---------- file:// 也必须被拒 ---------- */
  const fileBad = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = document.querySelector(".rsdetail__resources .rpanel");
    const input = p.querySelector(".rpanel__input");
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(input, "file:///C:/Users/ASUS/secret.docx");
    await sleep(200);
    [...p.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "添加").click();
    await sleep(600);
    return { err: (p.querySelector(".rpanel__err")?.textContent || "").trim() };
  })()`);
  rec('**`file://` 被拒绝**（不暴露本机路径）',
      (fileBad?.err || '').indexOf('本机') >= 0, fileBad?.err);

  /* ---------- 正常添加（无协议头自动补 https） ---------- */
  const added = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = document.querySelector(".rsdetail__resources .rpanel");
    const input = p.querySelector(".rpanel__input");
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    /* 故意不写协议头 */
    setVal(input, "www.bilibili.com/video/BV1test");
    await sleep(200);
    [...p.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "添加").click();
    await sleep(900);

    const items = [...p.querySelectorAll(".rpanel__item")];
    return {
      count: items.length,
      name: items[0]?.querySelector(".rpanel__name")?.textContent?.trim() || "",
      meta: items[0]?.querySelector(".rpanel__meta")?.textContent?.trim() || "",
      err: p.querySelector(".rpanel__err") ? (p.querySelector(".rpanel__err").textContent || "").trim() : null,
    };
  })()`);
  console.log('添加结果 =', JSON.stringify(added));
  await shot('03-added.png');

  rec('**正常网址加进去了**', (added?.count ?? 0) === 1, (added?.count ?? 0) + ' 条');
  rec('**无协议头自动补 https**（标题回退成域名）',
      (added?.name || '').indexOf('bilibili') >= 0, added?.name);
  rec('元信息里有域名与来源标注',
      /bilibili/.test(added?.meta || '') && /人工整理/.test(added?.meta || ''), added?.meta);

  /* ---------- 重复网址被拒 ---------- */
  const dup = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = document.querySelector(".rsdetail__resources .rpanel");
    const addBtn = [...p.querySelectorAll("button")].find((b) => (b.textContent || "").includes("添加资源"));
    if (addBtn) { addBtn.click(); await sleep(400); }
    const input = p.querySelector(".rpanel__input");
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    /* 与已有那条只有协议不同 */
    setVal(input, "https://www.bilibili.com/video/BV1test");
    await sleep(200);
    [...p.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "添加").click();
    await sleep(600);
    return {
      err: (p.querySelector(".rpanel__err")?.textContent || "").trim(),
      count: p.querySelectorAll(".rpanel__item").length,
    };
  })()`);
  rec('**重复网址被拒绝**（只有协议不同也算重复）',
      (dup?.err || '').indexOf('已经在列表里') >= 0, dup?.err);
  rec('重复时列表没多出东西', (dup?.count ?? -1) === 1, (dup?.count ?? 0) + ' 条');

  /* ---------- 刷新后资源还在（存下来了） ---------- */
  await send('Page.reload', { ignoreCache: true });
  await sleep(9000);
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

  const afterReload = await ev(`(() => {
    const p = document.querySelector(".rsdetail__resources .rpanel");
    const items = [...(p?.querySelectorAll(".rpanel__item") || [])];
    return {
      count: items.length,
      name: items[0]?.querySelector(".rpanel__name")?.textContent?.trim() || "",
    };
  })()`);
  console.log('刷新后 =', JSON.stringify(afterReload));
  await shot('04-after-reload.png');

  rec('**刷新后资源还在**（真的存进库了）', (afterReload?.count ?? 0) === 1,
      (afterReload?.count ?? 0) + ' 条：' + (afterReload?.name || ''));

  rec('无字面星号（全页）',
      (await ev(`((document.body.textContent || "").match(/\\*\\*/g) || []).length`)) === 0);

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
  console.log(alive ? '⚠️ 仍有 electron 进程' : '已确认进程退出干净');

  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});