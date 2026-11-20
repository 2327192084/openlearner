/**
 * 验证「命中很多时的分组折叠」在**桌面安装版**里生效（2026-11-20）。
 *
 * 与 verify-search-collapse.cjs（源码侧）同一套断言，只换启动目标。
 *
 * ## 为什么要折叠
 *
 * 实测搜「的」有 2365 处、列表列 500 条、面板限高 620px。
 * 用户要滚很久才能看到第二本书 —— 而「哪几本书里有」
 * 正是跨资料搜索要回答的第一个问题。
 *
 * ## 要证的
 *
 * 1. 高频词时每组只列 3 条（默认折叠）
 * 2. 组头有「展开全部 N 条」按钮
 * 3. 点它 → 该组全列（或列到上限）
 * 4. 再有「收起」按钮，点了回到 3 条
 * 5. **普通词不折叠**（一次能看完的不该多一次点击）
 * 6. 折叠不影响「真实命中数」的显示
 *
 * 用法：node scripts/verify-search-collapse.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/search-collapse-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-search-collapse');
const PORT = Number(process.argv[2] || 9880);
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
    await waitFor(`document.querySelector(".gsearch__panel") ? true : null`, 30000, '面板:' + kw);
    await waitFor(
      `(() => { const s = document.querySelector(".gsearch__summary"); return s && /\\d/.test(s.textContent) ? true : null; })()`,
      30000,
      '摘要:' + kw,
    );
    await sleep(500);
  };

  const snapshot = () =>
    ev(`(() => {
      const panel = document.querySelector(".gsearch__panel");
      const groups = [...panel.querySelectorAll(".gsearch__group")];
      return {
        toggles: [...panel.querySelectorAll(".gsearch__toggle")].map((b) => b.textContent.trim()),
        groups: groups.map((g) => ({
          source: (g.querySelector(".gsearch__source")?.textContent ?? "").trim().slice(0, 18),
          count: (g.querySelector(".gsearch__count")?.textContent ?? "").trim(),
          shown: g.querySelectorAll(".gsearch__hit").length,
          more: [...g.querySelectorAll(".gsearch__more")].map((p) => p.textContent.trim()),
        })),
        totalShown: panel.querySelectorAll(".gsearch__hit").length,
      };
    })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* ---------- 1. 高频词默认折叠 ---------- */
  await search('的');
  const collapsed = await snapshot();
  console.log('搜「的」（折叠态）=', JSON.stringify(collapsed, null, 1));
  await shot('01-collapsed.png');

  rec('**高频词时每组只列 3 条**（默认折叠）',
      collapsed.groups.every((g) => g.shown <= 3),
      JSON.stringify(collapsed.groups.map((g) => g.shown)));
  rec('**每份资料都能看到**（不再第一份吃光额度）',
      collapsed.groups.length >= 2 && collapsed.groups.every((g) => g.shown > 0),
      '组数=' + collapsed.groups.length);
  rec('组头有「展开全部」按钮',
      collapsed.toggles.some((t) => /展开全部/.test(t)),
      JSON.stringify(collapsed.toggles));
  /*
   * ⚠️ 这个断言第一版写成 `/\\d+ 处/` —— 在 JS 模板字符串里
   * `\\d` 是字面的反斜杠 + d，永远匹配不上数字，于是「失败」。
   * 直接用 /[0-9]+ 处/ 更稳（不需要转义层级）。
   */
  rec('组头仍显示**真实命中数**',
      collapsed.groups.every((g) => /[0-9]+ 处/.test(g.count)),
      JSON.stringify(collapsed.groups.map((g) => g.count)));
  /*
   * 折叠提示的文案（2026-11-20 合并过）：
   * 原来是「还有 348 处没列出」+「已折叠 164 条」两条并列 ——
   * 用户要自己相减才知道总共还有多少。现在合成一句：
   * 「还有 512 处没显示（默认只列 3 条，点「展开全部」看）」
   *
   * 断言只要求「说清还有多少没显示」，不绑死具体措辞 ——
   * 绑死措辞会让正常改文案变成假失败。
   */
  rec('折叠时说清「还有多少没显示」',
      collapsed.groups.some((g) => g.more.some((m) => /还有 \d+ 处没显示/.test(m))),
      JSON.stringify(collapsed.groups[0]?.more));
  rec('**底部提示只有一条**（不再「已折叠」与「没列出」两条并列）',
      collapsed.groups.every((g) => g.more.length <= 1),
      JSON.stringify(collapsed.groups.map((g) => g.more.length)));

  /* ---------- 2. 点「展开全部」 ---------- */
  const firstToggle = await ev(`(() => {
    const b = [...document.querySelectorAll(".gsearch__toggle")].find((x) => /展开全部/.test(x.textContent));
    if (!b) return null;
    const t = b.textContent.trim();
    b.click();
    return t;
  })()`);
  await sleep(900);
  const opened = await snapshot();
  console.log('展开后 =', JSON.stringify(opened.groups, null, 1));
  await shot('02-expanded.png');

  rec('点了「展开全部」', !!firstToggle, firstToggle ?? '');
  rec('**该组列表条数变多**',
      opened.groups[0].shown > collapsed.groups[0].shown,
      collapsed.groups[0].shown + ' → ' + opened.groups[0].shown);
  rec('展开后出现「收起」按钮', opened.toggles.some((t) => t === '收起'), JSON.stringify(opened.toggles));

  /* ---------- 3. 点「收起」回到折叠 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".gsearch__toggle")].find((x) => x.textContent.trim() === "收起");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(800);
  const recollapsed = await snapshot();
  rec('**点「收起」回到 3 条**',
      recollapsed.groups[0].shown === 3,
      String(recollapsed.groups[0].shown));

  /* ---------- 4. 普通词不折叠 ---------- */
  await search('极限');
  const normal = await snapshot();
  console.log('搜「极限」=', JSON.stringify(normal.groups, null, 1));
  await shot('03-normal-not-collapsed.png');

  rec('**普通词不出现折叠按钮**（一次能看完的不该多一次点击）',
      normal.toggles.length === 0,
      JSON.stringify(normal.toggles));
  rec('普通词列出全部命中',
      normal.groups.every((g) => g.more.length === 0 || !g.more.some((m) => /已折叠/.test(m))),
      JSON.stringify(normal.groups.map((g) => g.more)));

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();