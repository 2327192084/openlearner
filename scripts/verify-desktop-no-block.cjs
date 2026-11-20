/**
 * 验证「整段出处不标注」（2026-11-20 最终版）。
 *
 * ## 这一版为什么和上一版相反
 *
 * 上一版按用户要求做了「整段也标出来」（段落级淡橙底）。
 * 用户看过实测截图后指出：
 *
 * > 我看都是一整个页面被标注了，如果是整页标注的话那就不能称作段落，
 * > 那就不需要标注。
 *
 * 数据支持他的判断：他的资料**一页就是一段**
 * （`avgSegmentsPerPage: 1.00`，23/23 道已发布题的锚点跨度 = 整段长度）。
 * 所以「标出这一段」等于「标出整页」——既不传递信息，也不该叫段落级。
 *
 * ## 现在要证的
 *
 * 1. 点整段出处的题，**正文里没有任何 mark**（不标注）
 * 2. 但**必须说明为什么**（不能静默什么都不做）
 * 3. 说明里说清「整段、精确不到句子、所以不标注」
 * 4. 页码仍然会跳对（定位到页这件事没坏）
 * 5. 没有控制台报错
 *
 * 用法：node scripts/verify-no-block-highlight.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/desktop-noblock-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-no-block');
const PORT = Number(process.argv[2] || 9863);
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
    console.error('❌ app 目录旁有 openleaner-data，会抢先');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [`--user-data-dir=${DATA}`, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1100'],
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
  const waitFor = async (expr, ms = 20000, label = '') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => null);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* 进复习巩固 */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(700);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => e.textContent.trim().includes("复习巩固"));
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '复习巩固页');
  await sleep(1000);

  /* 入口文案：应说「不标注」 */
  const entry = await ev(`(() => {
    const li = document.querySelector(".bk-q");
    return {
      btnText: (li?.querySelector(".bk-q__locate")?.textContent ?? "").trim(),
      note: (li?.querySelector(".bk-q__locate-note")?.textContent ?? "").trim(),
    };
  })()`);
  console.log('入口 =', JSON.stringify(entry));
  rec('入口说明说「不标注」', /不标注/.test(entry.note), entry.note);
  rec('入口说明不再承诺「标出来」', !/会把那一段标出来/.test(entry.note));
  rec('入口仍提供「跳到原文」（定位到页没坏）', /跳到原文/.test(entry.btnText), entry.btnText);

  /* 点进阅读器 */
  await ev(`(() => {
    const b = document.querySelector(".bk-q__locate");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器');
  await sleep(2600);
  await shot('01-whole-segment-no-mark.png');

  const state = await ev(`(() => ({
    inReader: !!document.querySelector(".reader-page, .reader-split"),
    markCount: document.querySelectorAll("mark.reader-mark").length,
    notes: [...document.querySelectorAll(".reader-jump")].map((n) => n.textContent.trim()),
    pageLabel: (document.querySelector(".reader-nav input")?.value ?? "").trim(),
    bodyLen: (document.querySelector(".reader-body")?.textContent ?? "").replace(/\\s/g, "").length,
  }))()`);
  console.log('阅读器 =', JSON.stringify(state, null, 1));

  rec('**进了阅读器**', state.inReader);
  rec('**正文里没有任何高亮标记**（整页不该标）', state.markCount === 0, 'mark 数=' + state.markCount);
  rec('**但没有静默 —— 给了说明**', state.notes.length > 0, JSON.stringify(state.notes));
  rec(
    '说明说清「整段 / 精确不到句子 / 所以不标注」',
    state.notes.some((t) => /整段/.test(t) && /(精确不到|不标注)/.test(t)),
    JSON.stringify(state.notes),
  );
  rec('页码跳对了（第 16 页）', state.pageLabel === '16', state.pageLabel);
  rec('正文有内容（不是空白页）', state.bodyLen > 100, state.bodyLen + ' 字');
  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  /* 翻页后仍然无标记（确认没有残留） */
  await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "下一段");
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  await sleep(1500);
  const after = await ev(`document.querySelectorAll("mark.reader-mark").length`);
  rec('翻页后依然没有任何标记', after === 0, String(after));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();