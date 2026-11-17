/**
 * 验证「让 AI 组卷」的二级选项（2026-11-17）。
 *
 * ## 用户的要求（分两步说的）
 *
 * 1. 先：「用户先在题库挑选想要的题目，然后 ai 在这些题目的基础上改动出题」
 * 2. 又：「不用多加个按钮，让用户点击 ai 组卷后再弹出个二级选项就行，
 *       这样界面看起来不会太臃肿」
 *
 * ## 验什么
 *
 * 1. 设置页只有**一个**「让 AI 组卷」按钮（不是两个并排）
 * 2. 点它 → 弹出二级选项，两项都在
 * 3. 第一项「直接从题库挑一套」保留原有功能
 * 4. 第二项「先自己挑，再让 AI 改造」能进选题面板，
 *    且面板的确认按钮文案变成「让 AI 改造后组卷」而不是「用这些题开考」
 *
 * 不真跑 AI 改造（那要花 token 且耗时），只验界面与接线。
 * 素材准备逻辑有 14 条单测。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9960;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-menu-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-menu-app');

  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(copy, { recursive: true });
  fs.cpSync(path.join(src, 'IndexedDB'), path.join(copy, 'IndexedDB'), { recursive: true });
  fs.cpSync(path.join(src, 'Local Storage'), path.join(copy, 'Local Storage'), { recursive: true });

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  const unpacked = path.join(ROOT, 'release', 'win-unpacked');
  for (const name of fs.readdirSync(unpacked)) {
    if (name === 'openleaner-data') continue;
    fs.cpSync(path.join(unpacked, name), path.join(appDir, name), { recursive: true });
  }

  const app = spawn(
    path.join(appDir, 'OpenLeaner.exe'),
    [`--user-data-dir=${copy}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    app.kill();
    throw new Error('应用没起来');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => {
        if (pending.has(n)) {
          pending.delete(n);
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, '.verify-shots/exam-menu-20261117', `${name}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4500);

  /* 进模拟考页 */
  await evalJs(`(() => {
    for (const g of [...document.querySelectorAll('.nav-group')]) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    return true;
  })()`);
  await sleep(1200);
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('.nav-item')]) {
      const l = b.querySelector('.nav-item__label');
      if (l && l.innerText.trim() === '模拟考试') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(3000);

  /* ---------- 1. 只有一个 AI 组卷按钮 ---------- */
  const btns = await evalJs(`(() => {
    const all = [...document.querySelectorAll('button')].map(b => b.innerText.trim());
    return {
      aiCount: all.filter(t => t.indexOf('让 AI 组卷') >= 0).length,
      hasVariantBtn: all.some(t => t.indexOf('改造后组卷') >= 0),
      all: all.filter(t => t.length > 1).slice(0, 14),
    };
  })()`);
  rec('★ 只有一个「让 AI 组卷」按钮（界面不臃肿）', btns.aiCount === 1, `找到 ${btns.aiCount} 个`);
  rec('★ 没有并排的「改造后组卷」按钮', btns.hasVariantBtn === false);

  /* ---------- 2. 点开二级选项 ---------- */
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim().indexOf('让 AI 组卷') >= 0) { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(1000);

  const menu = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.ex-menu__item')].map(i => ({
      title: (i.querySelector('.ex-menu__title') || {}).innerText || '',
      desc: (i.querySelector('.ex-menu__desc') || {}).innerText || '',
      disabled: i.disabled,
    }));
    return { count: items.length, items };
  })()`);

  console.log(`\n  二级菜单: ${JSON.stringify(menu.items).slice(0, 300)}\n`);

  rec('★ 点开后出现二级选项', menu.count === 2, `${menu.count} 项`);
  rec(
    '★ 第一项是「直接从题库挑一套」（原有功能保留）',
    menu.items[0]?.title.indexOf('直接从题库挑') >= 0,
    menu.items[0]?.title ?? '',
  );
  rec(
    '★ 第二项是「先自己挑，再让 AI 改造」（新功能）',
    menu.items[1]?.title.indexOf('先自己挑') >= 0,
    menu.items[1]?.title ?? '',
  );
  rec('第二项可用（不是置灰的假开关）', menu.items[1]?.disabled === false);

  await shot('menu-open');

  /* ---------- 3. 点第二项 → 进选题面板，确认按钮文案变了 ---------- */
  const clicked = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.ex-menu__item')];
    if (items[1]) { items[1].click(); return true; }
    return false;
  })()`);
  await sleep(2500);

  const picker = await evalJs(`(() => {
    const foot = [...document.querySelectorAll('.qp-foot button')].map(b => b.innerText.trim());
    const groups = document.querySelectorAll('.qp-group').length;
    const items = document.querySelectorAll('.qp-item').length;
    return { foot, groups, items };
  })()`);

  console.log(`  选题面板按钮: ${JSON.stringify(picker.foot)}\n`);

  rec('点第二项进了选题面板', clicked === true && picker.items > 0, `${picker.items} 道题`);
  rec(
    '★ 确认按钮文案变成「让 AI 改造后组卷」',
    picker.foot.some((t) => t.indexOf('改造后组卷') >= 0),
    JSON.stringify(picker.foot),
  );
  rec(
    '★ 没有「用这些题开考」（这个模式下不该有）',
    !picker.foot.some((t) => t.indexOf('用这些题开考') >= 0),
  );

  await shot('picker-variant-mode');

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(2);
});
