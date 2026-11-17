/**
 * 验证组卷时的忙碌提示（2026-11-17 用户要求）。
 *
 * ## 用户的要求
 *
 * 「ai组卷需要时间，这个时间内用户并不知道组卷是否成功进行，
 *   我需要在进行组卷时按钮变灰并提醒用户正在组卷。」
 *
 * ## 验什么（用**真跑**，因为要点是「跑的时候」的状态）
 *
 * 1. 点「让 AI 组卷 → 直接从题库挑一套」之后，**立刻**：
 *    - 按钮变灰（disabled）
 *    - 出现「AI 正在组卷…」状态条
 *    - 状态条带转圈元素
 * 2. 组卷完成后：状态条消失、进入考试
 *
 * ## 为什么要验「立刻」
 *
 * 上一轮我在验证 AI 组卷时犯过错：脚本比实际状态先判成功
 * （判据抓了页面里随便出现的字）。这次要确认忙碌态**真的出现并持续**，
 * 而不是一闪而过或者压根没设。
 *
 * 会花一次 AI 组卷的费用（约 0.01 元）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9970;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const src = path.join(process.env.APPDATA, 'OpenLeaner');
  const copy = path.join(process.env.USERPROFILE, 'ol-busy-data');
  const appDir = path.join(process.env.USERPROFILE, 'ol-busy-app');

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
    const out = path.join(ROOT, '.verify-shots/exam-busy-20261117', `${name}.png`);
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

  /* 打开二级菜单，点第一项（直接从题库挑一套） */
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('button')]) {
      if (b.innerText.trim().indexOf('让 AI 组卷') >= 0) { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(800);
  const started = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.ex-menu__item')];
    if (!items[0]) return false;
    items[0].click();
    return true;
  })()`);
  rec('点了「直接从题库挑一套」', started === true);

  /*
   * ★ 立刻查忙碌态（这是本次的核心）。
   *
   * 判据要贴真实 UI 结构：
   *  - .ex-running 状态条存在
   *  - 里面有 .ex-running__spinner（转圈）
   *  - 文案含「正在组卷」
   *  - 「让 AI 组卷」按钮 disabled
   */
  let sawBusy = false;
  let busySnapshot = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const st = await evalJs(`(() => {
      const bar = document.querySelector('.ex-running');
      const btns = [...document.querySelectorAll('button')];
      const aiBtn = btns.find(b => b.innerText.indexOf('AI 组卷') >= 0);
      const inExam = !!document.querySelector('.ex-nav');
      return {
        hasBar: !!bar,
        barText: bar ? bar.innerText.replace(/\\s+/g, ' ').slice(0, 90) : '',
        hasSpinner: !!document.querySelector('.ex-running__spinner'),
        aiBtnDisabled: aiBtn ? aiBtn.disabled : null,
        inExam,
        err: document.querySelector('.ex-note--bad')?.innerText ?? null,
      };
    })()`);
    if (st.hasBar) {
      sawBusy = true;
      busySnapshot = st;
      break;
    }
    if (st.inExam || st.err) break;
  }

  console.log(`\n  忙碌态快照: ${JSON.stringify(busySnapshot)}\n`);

  rec('★ 组卷时出现了状态条', sawBusy === true, busySnapshot?.barText ?? '没抓到（可能跑太快）');
  if (sawBusy) {
    rec('★ 状态条带转圈动画元素', busySnapshot.hasSpinner === true);
    rec(
      '★ 状态条说清「正在组卷」',
      busySnapshot.barText.indexOf('组卷') >= 0,
      busySnapshot.barText,
    );
    rec('★ 组卷时「让 AI 组卷」按钮变灰', busySnapshot.aiBtnDisabled === true, String(busySnapshot.aiBtnDisabled));
    await shot('busy');
  }

  /* 等它跑完：应该进考试 */
  let ended = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    ended = await evalJs(`(() => {
      const inExam = !!document.querySelector('.ex-nav');
      const bar = document.querySelector('.ex-running');
      return { inExam, stillBusy: !!bar, err: document.querySelector('.ex-note--bad')?.innerText ?? null };
    })()`);
    if (ended.inExam || ended.err) break;
  }

  rec('★ 组完后进入考试（状态条随之消失）', ended?.inExam === true, ended?.err ?? '');
  rec('★ 结束后状态条不再显示', ended?.stillBusy === false);

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
