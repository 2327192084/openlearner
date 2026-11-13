/**
 * 验证「继续：xxx」只在**真的有任务在进行**时才出现（2026-11-13 傍晚）。
 *
 * ## 用户报的原话
 *
 * 「做这个跳页功能是为了知道某些任务的进度，例如文档解析，出题功能。
 *  但没有正在进行文档解析的任务时，这个提示也一直存在。」
 *
 * 根因：第一版拿「这一页在保活栈里」当「有任务在进行」。
 * 打开过一次文档解析页就永久占一层，提示永远在。
 *
 * ## 断言怎么设计才能区分好坏（硬约束 9）
 *
 * 关键的一条是**否定断言**：打开过页面、但什么都没跑时，
 * 侧栏**不许**有「继续」。
 *
 * 这条对旧实现必然失败（旧实现一打开就挂上），
 * 对新实现必须通过 —— 这才叫在验东西。
 *
 * 光有否定断言也不够（一个「永远不显示」的实现也能全过），
 * 所以还要反向的一条：真在跑的时候**必须**出现，且带进度。
 * 两条合起来才把这个功能夹住。
 *
 * ## 用法
 *
 *   node scripts/verify-resume-task.cjs --data .tmp/layers-data
 *   node scripts/verify-resume-task.cjs --app .tmp/old-build --data .tmp/x   # 反向验证
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/layers-data'));
const PORT = Number(arg('port', '9981'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/resume-task'));
const SLEEP_MS = Number(arg('boot-wait', '3000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function withApp(fn) {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );
  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 140; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && (t.url || '').indexOf('file://') === 0);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');
    await sleep(SLEEP_MS);

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    return await fn({ evalJs, shot });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(2000);
  }
}

/** 侧栏「继续」入口的现状 */
const resumeEntry = (evalJs) =>
  evalJs(`(() => {
    const btn = [...document.querySelectorAll('.nav-item--resume')].find(b => b.offsetParent !== null);
    if (!btn) return { present: false };
    const label = btn.querySelector('.nav-item__label')?.innerText?.trim() ?? '';
    const chip = btn.querySelector('.nav-item__chip')?.innerText?.trim() ?? '';
    return { present: true, label, chip, text: (btn.innerText || '').trim() };
  })()`);

/** 侧栏导航：按中文名点一项（先展开折叠分组） */
const navTo = (evalJs, name) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(600);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === ${JSON.stringify(name)});
    if (!hit) return { ok: false, reason: 'no-nav-item', labels: [...document.querySelectorAll('.nav-item__label')].map(l => (l.innerText||'').trim()) };
    hit.closest('button').click();
    await sleep(1800);
    return { ok: true };
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 基线：刚打开，不该有任何「继续」 ---------- */
    const atHome = await resumeEntry(evalJs);
    record('刚启动（首页）：没有「继续」入口', atHome.present === false, JSON.stringify(atHome));

    /* ---------- 用户报的核心场景：进过文档解析页、但没跑解析 ---------- */
    const toParse = await navTo(evalJs, '文档解析');
    record('能进文档解析页', toParse.ok === true, JSON.stringify(toParse).slice(0, 200));

    /*
     * 停在这一页（没点开始解析）。这正是用户说的那件事：
     * 「没有正在进行文档解析的任务时」。
     */
    await sleep(800);
    const onParseIdle = await resumeEntry(evalJs);
    record(
      '★ 用户报的场景：进了文档解析页但没跑解析 → 不许有「继续」',
      onParseIdle.present === false,
      JSON.stringify(onParseIdle),
    );
    await shot('01-parse-idle-no-resume.png');

    /* ---------- 离开这一页后，也不该留下提示 ---------- */
    const back = await navTo(evalJs, '学习库');
    record('能回到首页', back.ok === true, '');
    await sleep(600);
    const afterLeavingParse = await resumeEntry(evalJs);
    record(
      '★ 离开文档解析页之后 → 仍然不许有「继续」',
      afterLeavingParse.present === false,
      JSON.stringify(afterLeavingParse),
    );
    await shot('02-after-leaving-parse.png');

    /* ---------- 也不该把解析页保活（DOM 里不该有它） ---------- */
    const layers = await evalJs(`(() => {
      const on = document.querySelector('.page-layer--on');
      return {
        count: document.querySelectorAll('.page-layer').length,
        onHasParse: !!on && /解析/.test((on.innerText || '').slice(0, 300)),
        text: (on?.innerText || '').slice(0, 80).replace(/\\s+/g, ' '),
      };
    })()`);
    record(
      '★ 没跑解析的页面不被保活（DOM 里只有当前这一层）',
      layers.count === 1,
      JSON.stringify(layers),
    );

    /* ---------- 正面：真在跑的时候必须出现，且带进度 ---------- */
    const toExam = await navTo(evalJs, '模拟考试');
    if (!toExam.ok) {
      record('能进模拟考试页', false, JSON.stringify(toExam).slice(0, 200));
      return;
    }
    /* 开一场不限时的考试（不用等倒计时，也避免超时自动交卷） */
    const started = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const visible = (b) => b && b.offsetParent !== null && !b.disabled;
      /*
       * ⚠️ 必须限定在**当前页那一层**里找按钮。
       * 直接查 document 会先碰到侧栏的「开始学习」——
       * 我第一次写的时候正则 /开始/ 就把侧栏那个按钮点了，
       * 于是页面跳去「开始学习」，脚本却报「开不了考试」。
       */
      const layer = document.querySelector('.page-layer--on') || document.body;
      const noLimit = [...layer.querySelectorAll('button, [role="radio"], label')]
        .find(b => visible(b) && (b.innerText || '').trim() === '不限时');
      noLimit?.click();
      await sleep(400);
      const startBtn = [...layer.querySelectorAll('button')]
        .find(b => visible(b) && /开始考试|开考/.test(b.innerText || ''));
      if (!startBtn) return { ok: false, reason: 'no-start-button', layerText: (layer.innerText || '').slice(0, 300) };
      startBtn.click();
      await sleep(2200);
      return { ok: !!document.querySelector('.ex-bar'), layerText: (layer.innerText || '').slice(0, 160) };
    })()`);
    record('能开始一场考试', started.ok === true, JSON.stringify(started).slice(0, 250));

    if (started.ok) {
      const inExam = await resumeEntry(evalJs);
      record(
        '★ 正在考试时不许提示「继续考试」（人就在这一页）',
        inExam.present === false,
        JSON.stringify(inExam),
      );

      /* 跳走去看资料 —— 这时应该出现「继续：模拟考试」并带题号 */
      const toSources = await navTo(evalJs, '资料');
      record('考试中途能跳去资料页', toSources.ok === true, '');
      await sleep(700);
      const resumeExam = await resumeEntry(evalJs);
      record(
        '★ 考试中途跳走 → 出现「继续：模拟考试」',
        resumeExam.present === true && resumeExam.label.indexOf('模拟考试') !== -1,
        JSON.stringify(resumeExam),
      );
      record(
        '★ 这个提示带进度（用户要的是「知道进度」）',
        resumeExam.present === true && /\d+\s*\/\s*\d+/.test(resumeExam.chip),
        `chip=${JSON.stringify(resumeExam.chip)}`,
      );
      await shot('03-resume-exam-with-progress.png');

      /* 点「继续」能回去，且考试还在（题号/倒计时没重置） */
      const backToExam = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = [...document.querySelectorAll('.nav-item--resume')].find(b => b.offsetParent !== null);
        if (!btn) return { ok: false };
        btn.click();
        await sleep(1500);
        return { ok: !!document.querySelector('.ex-bar') };
      })()`);
      record('点「继续」能回到考试，且考试还在', backToExam.ok === true, JSON.stringify(backToExam));

      /* 交卷结束这一场，避免污染下一次运行 */
      const submit = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = [...document.querySelectorAll('button')]
          .find(b => b.offsetParent !== null && !b.disabled && (b.innerText || '').trim() === '交卷');
        if (!btn) return { ok: false };
        btn.click();
        await sleep(1500);
        /* 可能弹确认框 */
        const confirm = [...document.querySelectorAll('button')]
          .find(b => b.offsetParent !== null && /确认|交卷|确定/.test(b.innerText || ''));
        if (confirm && document.querySelector('[role="dialog"], .dialog, .modal')) { confirm.click(); await sleep(1800); }
        return { ok: true };
      })()`);
      await sleep(1500);
      const afterSubmit = await resumeEntry(evalJs);
      record(
        '★ 交卷之后不再提示「继续」（这一轮结束了）',
        afterSubmit.present === false,
        `submit=${JSON.stringify(submit)} entry=${JSON.stringify(afterSubmit)}`,
      );
      await shot('04-after-exam-submit.png');
    }
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();
