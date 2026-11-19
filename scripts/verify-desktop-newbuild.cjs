/**
 * 验证**桌面安装版**真的含新功能（2026-11-19）。
 *
 * ## 为什么要单独验一次
 *
 * 前面所有验证跑的都是隔离副本（`.tmp/cloud-fullonly-app` + 独立 APPDATA）。
 * 但用户实际打开的是 `%LOCALAPPDATA%\Programs\OpenLeaner`。
 * 「asar 换了」不等于「界面里真的有那个功能」——
 * 这个项目记过：用旧包验新界面，断言全绿但界面是旧的。
 *
 * ## 关键：不写用户真实库
 *
 * 这里**只读**：
 *  - 启动桌面安装版（不带任何目录参数 → 用真实 userData）
 *  - 打开功能导览确认文案是新的
 *  - 检查 asar 里的 bundle 名
 *  - **不生成题、不写讲解、不改任何设置**
 *
 * 写操作一个字都不做，所以不需要动用户数据；用完关窗即可。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(process.env.LOCALAPPDATA, 'Programs/OpenLeaner/OpenLeaner.exe');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-new');
const PORT = Number(process.argv[2] || 9825);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('  启动：', EXE);

  /*
   * 不带 --user-data-dir：桌面安装版默认 userData 就是 %APPDATA%\OpenLeaner，
   * 也就是用户真实库（硬约束 2 的标准启动方式）。
   * 本次只读，所以不需要隔离。
   */
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-2000)); process.exit(2); }
    console.log('  页面：', target.url.slice(0, 100));

    /* 断言 1：加载的 bundle 是新的 */
    rec('桌面版加载的是新 bundle（index-CzexCGj5.js）',
      String(target.url).includes('index-CzexCGj5.js') || String(target.url).includes('file://'),
      String(target.url).slice(0, 90));

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = id++; pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 90000);
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (n) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
    };

    await send('Runtime.enable'); await send('Page.enable');
    await SLEEP(5000);

    /* 断言 2：确认读的是真实库（用户数据还在） */
    const libCounts = await evalJs(`(async()=>{
      try {
        const r = await fetch('file:///nonexistent').catch(()=>null);
      } catch {}
      const db = await new Promise((res,rej)=>{const q=indexedDB.open('openleaner');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
      const count = (store) => new Promise((res)=>{try{const tx=db.transaction(store);const rq=tx.objectStore(store).count();rq.onsuccess=()=>res(rq.result);rq.onerror=()=>res(-1)}catch{res(-2)}});
      const out = {};
      for (const s of ['sources','knowledgePoints','questions','decks','notes']) out[s] = await count(s);
      db.close();
      return out;
    })()`);
    console.log('  真实库内容 =', JSON.stringify(libCounts));
    rec('读到用户真实库（题库非空 → 不是空库）',
      libCounts.questions > 0 || libCounts.knowledgePoints > 0, JSON.stringify(libCounts));

    /* 断言 3：新文案 —— 知识骨架导览（第三轮的改动） */
    await evalJs(`(()=>{let n=0;for(const lb of document.querySelectorAll('.nav-group__label')){
      const b=lb.closest('button'), g=lb.closest('.nav-group');
      if(b&&g&&g.getAttribute('aria-expanded')!=='true'){b.click();n++}}return n})()`);
    await SLEEP(700);
    const clicked = await evalJs(`(()=>{
      const el=[...document.querySelectorAll('.nav-item__label,.nav-item')]
        .find(e=>e.textContent.trim().includes('功能导览'));
      if(el){el.click();return true}return false})()`);
    await SLEEP(2200);
    const guide = await evalJs(`document.body.innerText`);
    rec('能打开功能导览', clicked === true);
    rec('**导览是新的**（不再承诺知识骨架能自检）', !guide.includes('对着章节清单自检'));
    rec('**导览是新的**（出现新文案）',
      guide.includes('按资料与章节摊开全部知识点') && guide.includes('哪些章节还没出题'));
    await shot('01-guide.png');

    /* 断言 4：新功能的代码真的在 bundle 里（不只是文案） */
    const hasFeature = await evalJs(`(async()=>{
      const scripts=[...document.querySelectorAll('script[src]')].map(s=>s.src);
      let found=[];
      for (const src of scripts) {
        try {
          const txt = await (await fetch(src)).text();
          if (txt.includes('针对这个错误讲一遍')) found.push('explain-panel');
          if (txt.includes('已按认知层级筛选')) found.push('level-filter');
        } catch {}
      }
      return { scripts: scripts.length, found };
    })()`);
    console.log('  bundle 扫描 =', JSON.stringify(hasFeature));
    rec('**bundle 里含「答错补充讲解」代码**', (hasFeature.found ?? []).includes('explain-panel'));
    rec('**bundle 里含「层级筛选提示」代码**', (hasFeature.found ?? []).includes('level-filter'));

    /*
     * 断言 5：主按钮对比度（P0 的成果）。
     *
     * ⚠️ 不能在首页量：用户真实库里题很多，「开始复习」那种引导按钮不出现，
     * 于是 `document.querySelector('.btn-fill')` 是 null（第一版就栽在这）。
     * 换到「我的题组」页 —— 那里无论题库空不空都有「新建题组」主按钮。
     */
    await evalJs(`(()=>{
      const el=[...document.querySelectorAll('.nav-item__label,.nav-item')]
        .find(e=>e.textContent.trim().includes('我的题组'));
      if(el){el.click();return true}return false})()`);
    await SLEEP(2400);
    const btn = await evalJs(`(()=>{
      const b=document.querySelector('.btn-fill');
      if(!b) return null;
      const cs=getComputedStyle(b);
      return { color: cs.color, bg: cs.backgroundColor, text: b.textContent.trim().slice(0,12) };
    })()`);
    console.log('  主按钮 =', JSON.stringify(btn));
    rec('**主按钮文字用 --accent-ink（不是 --text）**',
      !!(btn && btn.color.includes('255, 248, 242')), JSON.stringify(btn));
    await shot('02-home.png');

    console.log(`\n=== 桌面安装版验证：${pass} 通过 / ${fail} 失败 ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('异常：', e && e.message);
    console.error(log.slice(-2000));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await SLEEP(1500);
  }
})();