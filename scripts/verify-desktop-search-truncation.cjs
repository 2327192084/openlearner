/**
 * 验证「高频词截断如实告知」（2026-11-20 打磨）。
 *
 * ## 用真实库跑真实高频词
 *
 * 实测用户库里搜「的」有 **2365 处**，而 limit 是 500。
 * 第一版界面显示「共 500 处」—— 假话，用户以为搜遍了全库。
 *
 * ## 要证的
 *
 * 1. 搜高频词时，摘要显示**真实总数**（2365 级别），不是 500
 * 2. 摘要明确说「只列前 500 处」
 * 3. 组头上的数字是**真实命中数**，且标出「列前 N 处」
 * 4. 组末尾说「还有 X 处没显示」（文案 2026-11-20 从「没列出」改成「没显示」）
 * 5. 搜普通词时**不出现**这些截断提示（不能没事就吓人）
 *
 * 用法：node scripts/verify-search-truncation.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/desktop-search-trunc-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-search-truncation');
const PORT = Number(process.argv[2] || 9878);
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
  console.log('已复制真实库副本');

  const exe = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [`--user-data-dir=${DATA}`, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1000'],
    { cwd: path.dirname(exe), env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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
    console.error('起不来：' + log.slice(-1200));
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
      }, 120000);
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
  const waitFor = async (expr, ms = 30000, label = '') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => null);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  const search = async (kw) => {
    await ev(`(() => {
      const i = document.querySelector(".gsearch__input");
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(i, ${JSON.stringify(kw)});
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await ev(`(() => {
      const b = document.querySelector(".gsearch__go");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".gsearch__panel") ? true : null`, 30000, '结果面板:' + kw);
    /* 等摘要里出现数字（搜索是异步读库） */
    await waitFor(
      `(() => { const s = document.querySelector(".gsearch__summary"); return s && /\\d/.test(s.textContent) ? true : null; })()`,
      30000,
      '摘要出现:' + kw,
    );
    await sleep(400);
    return ev(`(() => {
      const panel = document.querySelector(".gsearch__panel");
      const groups = [...panel.querySelectorAll(".gsearch__group")];
      return {
        summary: (panel.querySelector(".gsearch__summary")?.textContent ?? "").trim(),
        groupCount: groups.length,
        groups: groups.slice(0, 3).map((g) => ({
          source: (g.querySelector(".gsearch__source")?.textContent ?? "").trim(),
          count: (g.querySelector(".gsearch__count")?.textContent ?? "").trim(),
          shown: g.querySelectorAll(".gsearch__hit").length,
          more: (g.querySelector(".gsearch__more")?.textContent ?? "").trim(),
        })),
        totalShown: panel.querySelectorAll(".gsearch__hit").length,
      };
    })()`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* ---------- 1. 高频词「的」 ---------- */
  const defreq = await search('的');
  console.log('搜「的」=', JSON.stringify(defreq, null, 1));
  await shot('01-high-freq-truncated.png');

  /*
   * 真实总数应该是四位数（实测 2365）。断言用「>= 1000」而不是写死 2365 ——
   * 用户库还会变，写死会随数据漂移而假失败。
   */
  const m = defreq.summary.match(/共 (\d+) 处/);
  const realTotal = m ? Number(m[1]) : 0;
  rec('**摘要里的总数是真实总数（四位数），不是 500**', realTotal >= 1000, String(realTotal));
  rec('**摘要承认「只列前 N 处」**', /只列前/.test(defreq.summary), defreq.summary);
  rec('列表实际渲染条数 ≤ 500（没把 2365 条都塞进 DOM）', defreq.totalShown <= 500, String(defreq.totalShown));
  rec(
    '**组头显示的是真实命中数，并标出列了多少**',
    defreq.groups.some((g) => /列前/.test(g.count)),
    JSON.stringify(defreq.groups.map((g) => g.count)),
  );
  rec(
    '**组末尾说「还有 X 处没显示」**',
    defreq.groups.some((g) => /还有 [0-9]+ 处没显示/.test(g.more)),
    JSON.stringify(defreq.groups.map((g) => g.more).filter(Boolean).slice(0, 2)),
  );

  /* ---------- 2. 普通词不应该出现截断提示 ---------- */
  const rare = await search('极限');
  console.log('搜「极限」=', JSON.stringify(rare, null, 1));
  await shot('02-normal-no-truncation.png');

  const rareTotal = Number((rare.summary.match(/共 (\d+) 处/) || [])[1] ?? 0);
  rec('普通词能正常搜到', rareTotal > 0, String(rareTotal));
  rec('**普通词不出现「只列前」**（不能没事就吓人）', !/只列前/.test(rare.summary), rare.summary);
  rec('普通词不出现「没显示」提示', rare.groups.every((g) => !/没显示/.test(g.more)), JSON.stringify(rare.groups.map((g) => g.more)));

  /* ---------- 3. 点结果仍能跳到句子 ---------- */
  await ev(`(() => {
    const b = document.querySelector(".gsearch__hit");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器');
  await waitFor(`document.querySelector("mark.reader-mark, .reader-jump") ? true : null`, 20000, '定位标记');
  await sleep(800);
  const jumped = await ev(`(() => ({
    inReader: !!document.querySelector(".reader-page, .reader-split"),
    marks: document.querySelectorAll("mark.reader-mark").length,
  }))()`);
  rec('**点结果仍能跳到原文并标出那句话**（没被改动破坏）', jumped.inReader && jumped.marks >= 1, JSON.stringify(jumped));

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();