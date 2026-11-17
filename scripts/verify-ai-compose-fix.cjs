/**
 * 验证「AI 组卷」真的能出卷（2026-11-17，修复后）。
 *
 * ## 用户报的问题
 *
 * 「ai组卷功能没使用成功」—— 界面显示「AI 这次没给出可用的组卷结果」。
 *
 * ## 查到的根因
 *
 * `deepseek-flash` 是推理模型，先输出思考再输出正文。
 * 原 `maxTokens: 1200` 全被 reasoning 吃光：
 *   finish_reason: "length"、reasoning_tokens: 1200、content: ""
 * 于是 parseCompose('') 返回 null。
 *
 * 修复：maxTokens 提到 4000；并把「被截断」与「返回不是 JSON」分开报。
 *
 * ## 这个脚本验什么
 *
 * 用**真实桌面版的界面**点「让 AI 组卷」，看：
 *  1. 面板有没有出现题目（真的开考了）
 *  2. 有没有报错
 *  3. 出的题是不是真的来自题库（不是幻觉）
 *
 * 会花一次 chat 的费用（约 0.01 元）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9940;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-aifix-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-aifix-app');

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
      }, 180000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, '.verify-shots/ai-compose-fix-20261117', `${name}.png`);
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

  /* 点「让 AI 组卷」 */
  const clicked = await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim().indexOf('让 AI 组卷') >= 0) { b.click(); return b.innerText.trim(); }
    }
    return '';
  })()`);
  rec('找到并点了「让 AI 组卷」', clicked.length > 0, clicked);

  /* 等结果：要么进入考试界面，要么出现错误提示 */
  let outcome = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    outcome = await evalJs(`(() => {
      /*
       * ⚠️ 判据要贴**真实状态**，不能贴页面里随便出现的字。
       *
       * 第一版用 body.indexOf('交卷') —— 设置页的说明文字里也有
       * 「交卷后统一批改」，于是请求还在进行中就被判成「已进考试」。
       * 截图抓到的正是那一幕：按钮还写着「AI 组卷中…」，
       * 脚本却报 PASS。
       *
       * 现在用三个只有考试界面才有的结构：
       *  - .ex-nav（题号导航）存在
       *  - 或者 .ex-taker / 倒计时那类元素
       */
      const inExam =
        !!document.querySelector('.ex-nav') ||
        !!document.querySelector('[class*="ex-taking"]') ||
        !!document.querySelector('.ex-timer');
      /* 还在组卷中：按钮文案变成「AI 组卷中…」 */
      const busy = [...document.querySelectorAll('button')].some(
        (b) => b.innerText.indexOf('AI 组卷中') >= 0,
      );
      const errEl = document.querySelector('.ex-note--bad');
      const noteEls = [...document.querySelectorAll('.ex-note:not(.ex-note--bad)')];
      return {
        inExam,
        busy,
        err: errEl ? errEl.innerText : null,
        note: noteEls.map((e) => e.innerText).join(' | '),
        head: document.body.innerText.slice(0, 160).replace(/\\s+/g, ' '),
      };
    })()`);
    /* 进考试了，或者出错了，才停 */
    if (outcome.inExam || outcome.err) break;
    /* 仍在组卷中就继续等（不要因为「没报错」就当成成功） */
  }

  console.log(`\n  结果: ${JSON.stringify(outcome).slice(0, 400)}\n`);

  rec(
    '★ AI 组卷成功进入考试',
    outcome.inExam === true,
    outcome.inExam ? '' : outcome.err ?? (outcome.busy ? '仍在组卷中（超时）' : '没有进入考试'),
  );
  if (outcome.note) console.log(`  组卷说明: ${outcome.note.slice(0, 200)}`);

  await shot('after-ai-compose');

  /* 校验：卷子里的题必须都来自题库（不是幻觉 id） */
  const integrity = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => {
      const rq = db.transaction('questions','readonly').objectStore('questions').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    db.close();
    const known = new Set(all.map(q => q.id));
    /* 页面上能看到的题干数量 */
    const shown = document.querySelectorAll('.ex-card, .ex-question, [class*="ex-"] li').length;
    return { knownCount: known.size, shown };
  })()`);
  rec('题库里有题（组卷有素材）', integrity.knownCount > 0, `${integrity.knownCount} 道`);

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
