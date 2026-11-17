/**
 * 验证模拟考试这一轮的四个改动（2026-11-17）。
 *
 * 用户要求：
 * 1. 「增加一个可以从浏览题库并从不同题组里组卷出题的功能」
 * 2. 「新增 ai 组卷功能，选择特定的资料或是题库，让 ai 出一套题型分布
 *    符合考试标准的题目」
 * 3. 「历史成绩可以点击查看试卷所有的习题」
 * 4. 「在错题巩固栏目增加试卷的错题」
 * 5. 「试卷的历史纪录要能删除」
 *
 * ## 这个脚本验什么
 *
 * 显示层与接线：
 *  - 设置页有「从题库选题组卷」和「让 AI 组卷」两个入口
 *  - 选题面板真的能跨题组列出题目、能勾选
 *  - 历史成绩每行可点、有删除按钮
 *  - 删除真的把记录从库里去掉
 *
 * 核心逻辑（组卷校验、错题落库、待评口径）已有 33 条单测钉住，
 * 这里不重复 —— 但要看一眼界面是不是真的接上了。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9920;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-ex4-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-ex4-app');

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
    const out = path.join(ROOT, '.verify-shots/exam4-20261117', `${name}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4500);

  /* 造一条历史记录，供「点开 / 删除」验证 */
  await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const questions = await new Promise((res) => {
      const rq = db.transaction('questions','readonly').objectStore('questions').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    if (questions.length < 2) { db.close(); return; }
    const picked = questions.slice(0, 2);
    const attempt = {
      id: 'exam_verify4',
      title: '验证用试卷',
      questionIds: picked.map(q => q.id),
      startedAt: '2026-11-17T04:00:00.000Z',
      finishedAt: '2026-11-17T04:10:00.000Z',
      limitSec: 600, usedSec: 120,
      answers: picked.map((q, i) => ({
        questionId: q.id, response: 'A',
        correct: i === 0, gradedBy: 'auto', aiGrade: null, aiComment: null,
      })),
      correct: 1, total: 2, pendingCount: 0, timedOut: false,
    };
    const tx = db.transaction('examAttempts','readwrite');
    tx.objectStore('examAttempts').put(attempt);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    db.close();
  })()`);

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

  /* ---------- 1. 两个新入口在不在 ---------- */
  const entries = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim());
    return {
      hasPicker: btns.some(t => t.indexOf('从题库选题组卷') >= 0),
      hasAi: btns.some(t => t.indexOf('让 AI 组卷') >= 0),
      all: btns.filter(t => t.length > 2).slice(0, 12),
    };
  })()`);
  rec('★ 有「从题库选题组卷」入口', entries.hasPicker === true, JSON.stringify(entries.all));
  rec('★ 有「让 AI 组卷」入口', entries.hasAi === true, '');

  await shot('setup');

  /* ---------- 2. 打开选题面板，验证跨题组 ---------- */
  const opened = await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim().indexOf('从题库选题组卷') >= 0) { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(2000);

  const picker = await evalJs(`(() => {
    const groups = [...document.querySelectorAll('.qp-group')].map(g => ({
      title: (g.querySelector('.qp-group__title') || {}).innerText || '',
      items: g.querySelectorAll('.qp-item').length,
    }));
    const total = document.querySelectorAll('.qp-item').length;
    const kinds = [...document.querySelectorAll('.qp-kind')].map(b => b.innerText.trim());
    return { groups, total, kinds };
  })()`);

  rec('选题面板打开', opened === true);
  rec('★ 跨题组：列出了多个题组', picker.groups.length >= 2, JSON.stringify(picker.groups.map((g) => g.title.slice(0, 18))));
  rec('★ 列出了题目（可逐题勾选）', picker.total > 0, `${picker.total} 道`);
  rec('有按题型快选', picker.kinds.length > 0, JSON.stringify(picker.kinds));

  await shot('picker');

  /* ---------- 3. 勾两道题，确认能开考 ---------- */
  const picked = await evalJs(`(() => {
    const boxes = [...document.querySelectorAll('.qp-item input[type="checkbox"]')];
    if (boxes.length < 2) return { ok: false, n: boxes.length };
    boxes[0].click();
    boxes[1].click();
    const count = document.querySelector('.qp-foot__count');
    return { ok: true, countText: count ? count.innerText.replace(/\\s+/g,' ') : '' };
  })()`);
  await sleep(800);

  const afterPick = await evalJs(`(() => {
    const count = document.querySelector('.qp-foot__count');
    const btn = [...document.querySelectorAll('.qp-foot button')].find(b => b.innerText.indexOf('开考') >= 0);
    return { countText: count ? count.innerText.replace(/\\s+/g,' ') : '', btnDisabled: btn ? btn.disabled : null };
  })()`);
  rec('★ 勾选后计数变为 2', afterPick.countText.indexOf('2') >= 0, afterPick.countText);
  rec('勾了题之后「开考」按钮可用', afterPick.btnDisabled === false);

  await shot('picker-picked');

  /* ---------- 4. 返回，验证历史记录可点开 / 可删除 ---------- */
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim() === '取消') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(1500);

  const history = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.ex-history__item')];
    return {
      count: items.length,
      openable: items.filter(i => i.querySelector('.ex-history__open')).length,
      deletable: items.filter(i => i.querySelector('.ex-history__del')).length,
      texts: items.map(i => i.innerText.replace(/\\s+/g,' ').slice(0, 40)),
    };
  })()`);
  rec('★ 历史记录每行可点开', history.openable === history.count && history.count > 0, `${history.openable}/${history.count}`);
  rec('★ 历史记录每行有删除按钮', history.deletable === history.count && history.count > 0, `${history.deletable}/${history.count}`);

  /* 点开一条，看是否进入试卷回看 */
  const openedHistory = await evalJs(`(() => {
    const b = document.querySelector('.ex-history__open');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(2000);

  const histView = await evalJs(`(() => {
    const title = (document.querySelector('.ex-title') || {}).innerText || '';
    const items = document.querySelectorAll('.ex-review__item').length;
    return { title, items };
  })()`);
  rec('★ 点开后进入试卷回看，列出每道题', histView.title.indexOf('试卷回看') >= 0 && histView.items > 0, `${histView.title} / ${histView.items} 题`);

  await shot('history-view');

  /* ---------- 5. 删除会不会真的删掉 ---------- */
  const before = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => {
      const rq = db.transaction('examAttempts','readonly').objectStore('examAttempts').count();
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(-1);
    });
    db.close();
    return all;
  })()`);

  /* 回到列表，点第一行删除 → 确认 */
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim() === '返回') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(1500);

  await evalJs(`(() => {
    const b = document.querySelector('.ex-history__del');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(800);

  const dialogShown = await evalJs(`(() => {
    const dlg = document.querySelector('[role="dialog"]') || document.querySelector('.dlg');
    return {
      shown: !!dlg,
      text: dlg ? dlg.innerText.replace(/\\s+/g,' ').slice(0, 100) : '',
    };
  })()`);
  rec('★ 删除有二次确认（不是点一下就删）', dialogShown.shown === true, dialogShown.text);

  /* 点确认 */
  await evalJs(`(() => {
    const dlg = document.querySelector('[role="dialog"]') || document.querySelector('.dlg');
    if (!dlg) return false;
    for (const b of [...dlg.querySelectorAll('button')]) {
      if (b.innerText.trim() === '删除') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(2000);

  const after = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => {
      const rq = db.transaction('examAttempts','readonly').objectStore('examAttempts').count();
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(-1);
    });
    db.close();
    return all;
  })()`);

  rec('★ 删除后库里记录真的少了一条', after === before - 1, `${before} → ${after}`);

  const failed = results.filter((r) => !r.pass);
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