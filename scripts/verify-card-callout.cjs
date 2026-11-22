/**
 * 验证闪卡的 Obsidian callout 版式（2026-11-23）。
 *
 * ## 为什么这个脚本里有一条"反重复"断言
 *
 * 上一版（2026-11-22）我把 callout 头部做成「标题 = 正面第一行截断」，
 * 而正文**仍然渲染整段正面**。用户库里的知识点卡正面基本都是
 * 单行长句（实测 8 张全是），于是每张卡把同一句话显示两遍。
 *
 * 当时 33 条单测全绿 —— 因为单测只验纯函数，没人验"头部与正文重叠"。
 * 是**看截图**才发现的。所以这里把这件事变成断言。
 *
 * ## 要证的
 *
 * 1. callout 结构在（色条卡、组别徽章、图标、「闪卡 N」编号）
 * 2. ⚠️ **头部标题不出现在正文里**（防重复回归）
 * 3. 组别徽章有文字（不只靠颜色区分）
 * 4. 编号是全库序号（筛选不改变它）
 * 5. 没有字面 `**`（markdown 没漏成原文）
 * 6. 无控制台报错
 *
 * 用法：node scripts/verify-card-callout.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/cardcallout-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/card-callout');
const PORT = Number(process.argv[2] || 9870);
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

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 1500,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* 进闪卡管理页 */
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
      .find((e) => (e.textContent || "").includes("闪卡管理"));
    if (el) el.click();
    return true;
  })()`);
  await sleep(7000);

  /* 展开第一张的背面（标记行只在背面） */
  await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const first = document.querySelector(".fcal");
    if (!first) return false;
    const b = [...first.querySelectorAll("button")].find((x) =>
      (x.textContent || "").includes("看背面"));
    if (b) { b.click(); await sleep(700); }
    return true;
  })()`);
  await sleep(1000);
  await shot('cards-callout.png');

  const cards = await ev(`(() => {
    const list = [...document.querySelectorAll(".fcal")];
    if (list.length === 0) return { count: 0 };

    const one = list[0];
    const headEl = one.querySelector(".fcal__head");
    const bodyEl = one.querySelector(".fcal__body");
    const head = (headEl?.textContent || "").trim();
    const body = (bodyEl?.textContent || "").trim();

    /*
     * 反重复：把头部里「闪卡 N」之后的部分当标题，
     * 检查它有没有整段出现在正文里。
     * 单行正面时头部不该有标题（只有徽章/图标/编号），所以这条
     * 在有标题的卡上才有意义 —— 没标题时跳过。
     */
    const afterNo = head.replace(/^[^闪]*闪卡\\s*\\d+/, '').replace(/^[｜|\\s]+/, '').trim();
    const hasTitle = afterNo.length > 4;
    const duplicated = hasTitle && body.includes(afterNo.slice(0, 24));

    return {
      count: list.length,
      head,
      body: body.slice(0, 60),
      hasTitle,
      duplicated,
      hasGroup: !!one.querySelector(".fcal__group"),
      groupText: (one.querySelector(".fcal__group")?.textContent || "").trim(),
      hasIcon: !!one.querySelector(".fcal__icon"),
      /* 编号：第一张应是 1，第二张 2（全库序号） */
      nos: list.slice(0, 3).map((c) => (c.querySelector(".fcal__no")?.textContent || "").trim()),
      roles: {
        answer: document.querySelectorAll(".fcal__line--answer").length,
        point: document.querySelectorAll(".fcal__line--point").length,
        warn: document.querySelectorAll(".fcal__line--warn").length,
        ordered: document.querySelectorAll(".fcal__line--ordered").length,
      },
      katexCount: document.querySelectorAll(".fcal .katex").length,
      literalStars: ((document.querySelector(".fcx__list")?.textContent || "").match(/\\*\\*/g) || [])
        .length,
    };
  })()`);
  console.log('卡片 =', JSON.stringify(cards, null, 1));

  rec('callout 卡片渲染出来了', (cards?.count ?? 0) > 0, (cards?.count ?? 0) + ' 张');
  /* ⚠️ 本轮最重要的一条：抓"头部重述正文"这个回归 */
  rec('**头部标题没有重述正文**（防上一版每张卡重复一遍的缺陷）',
      !cards?.duplicated,
      cards?.duplicated
        ? '⚠️ 头部标题在正文里又出现了一遍'
        : cards?.hasTitle
          ? '有标题且不重复'
          : '单行正面 → 头部无标题（正确）');
  rec('组别徽章有文字（不只靠颜色）', !!cards?.hasGroup && (cards?.groupText ?? '').length > 0,
      cards?.groupText);
  rec('有 callout 图标', !!cards?.hasIcon);
  rec('编号是连续的「闪卡 N」', (cards?.nos ?? []).join(',') === '闪卡 1,闪卡 2,闪卡 3',
      JSON.stringify(cards?.nos));
  rec('没有字面星号（markdown 没漏成原文）', (cards?.literalStars ?? -1) === 0,
      String(cards?.literalStars));

  /*
   * 如实报告：标记行/公式的渲染能力在真实数据上是否被覆盖到。
   * 用户库现在 8 张都是知识点卡、正面单行、背面还没写，
   * 所以 ✅💡⚠️ 与 $$ $$ 那条路径**在真实数据上没跑到** ——
   * 这不是缺陷，但必须说明，否则会被当成"已端到端验证"。
   */
  const covered = (cards?.roles?.answer ?? 0) + (cards?.roles?.warn ?? 0) + cards?.katexCount;
  console.log(
    covered > 0
      ? '提示：真实数据里有标记行/公式，渲染路径已被覆盖'
      : '注意：真实数据里没有 ✅💡⚠️ 标记行与 LaTeX（背面未写），' +
        '该渲染路径只由 40 条单测覆盖，未在真实卡片上跑到',
  );

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
  console.log(alive ? '⚠️ 仍有 electron 进程（请人工确认）' : '已确认进程退出干净');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});