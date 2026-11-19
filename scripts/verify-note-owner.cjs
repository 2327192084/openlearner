/**
 * 验证「笔记归属」修复（2026-11-19）。
 *
 * ## 用户报的原问题
 *
 * 「我在答题时使用了笔记功能，可是回到学习笔记栏发现该笔记定位到了原文
 * 而不是题目。」
 *
 * 只读诊断确认了数据本身是对的（`Note.cardId` = 题目 id，`sourceId` = null），
 * 问题出在展示与点击：
 *  1. 分组标题用资料名，把「题目：…」这层丢了
 *  2. 点击时只要有 sourceId 就跳原文，回不到题目
 *
 * ## 这个脚本验什么
 *
 * 用**用户真实库**里那条真实笔记（「我懂了」，挂在题目
 * 「下列各组函数中，表示同一个函数的是：」上）当样本：
 *  1. 学习笔记页里那条笔记**显示的是题目**，不是只有资料名
 *  2. 点它 → 进入做题页，且题目就是那一题
 *
 * ## 写操作
 *
 * **零写操作**：不新建笔记、不改题、不动设置。
 * 用桌面安装版默认 userData（真实库）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const path0 = require('node:path');
const ROOT = path0.resolve(__dirname, '..');
/*
 * 用**隔离副本**跑（硬约束 12）：
 *  - EXE 用工作区打包目录里的 electron.exe（它从 ROOT 读 dist，所以是刚构建的新代码）
 *  - userData 指向真实库的**复制品**（`.tmp/note-verify-appdata`）
 *
 * 为什么还要用真实库的副本：验证要拿用户那条真实笔记（「我懂了」）当样本，
 * 空库验不了「归属显示对不对」。副本是只读复制来的，写也只写副本。
 */
const EXE = path0.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const DATA = path0.join(ROOT, '.tmp/note-verify-appdata/OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/note-owner');
const PORT = Number(process.argv[2] || 9827);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = spawn(EXE, [
    ROOT, `--user-data-dir=${DATA}`, '--no-sandbox',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1000',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (!target) { console.error('起不来:' + log.slice(-1500)); process.exit(2); }

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

    /* 展开侧栏并进「学习笔记」 */
    for (let i = 0; i < 3; i++) {
      await evalJs(`(()=>{let n=0;for(const lb of document.querySelectorAll('.nav-group__label')){
        const b=lb.closest('button'), g=lb.closest('.nav-group');
        if(b&&g&&g.getAttribute('aria-expanded')!=='true'){b.click();n++}}return n})()`);
      await SLEEP(500);
    }
    const opened = await evalJs(`(()=>{
      const el=[...document.querySelectorAll('.nav-item__label,.nav-item')]
        .find(e=>e.textContent.trim().includes('学习笔记'));
      if(el){el.click();return true}return false})()`);
    await SLEEP(3000);
    rec('能打开「学习笔记」页', opened === true);

    /* 断言 1：那条笔记显示的是题目，不是只有资料名 */
    const rows = await evalJs(`(()=>[...document.querySelectorAll('.nl-item')].map(li=>({
      text: li.querySelector('.nl-item__text')?.innerText?.slice(0,40) ?? '',
      belong: li.querySelector('.nl-item__belong')?.innerText ?? null,
      tag: li.querySelector('.nl-tag')?.innerText ?? null,
    })))()`);
    console.log('  笔记行 =', JSON.stringify(rows, null, 1));

    /* 先把「那条笔记在库里长什么样」打出来，别再靠推断 */
    const rawNote = await evalJs(`(async()=>{
      const db = await new Promise((res,rej)=>{const q=indexedDB.open('openleaner');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
      const getAll=(s)=>new Promise((res)=>{const tx=db.transaction(s);const rq=tx.objectStore(s).getAll();rq.onsuccess=()=>res(rq.result);rq.onerror=()=>res([])});
      const notes=await getAll('notes'); db.close();
      return notes.map(n=>({id:n.id, body:n.body, cardId:n.cardId, sourceId:n.sourceId}));
    })()`);
    console.log('  库里笔记原始记录 =', JSON.stringify(rawNote, null, 1));

    const ourRow = rows.find((r) => r.text.includes('我懂了'));
    rec('找到了用户那条「我懂了」笔记', !!ourRow, ourRow ? 'yes' : 'no');
    rec('**笔记显示了它挂在哪道题上**',
      !!(ourRow && ourRow.belong && ourRow.belong.includes('题目')),
      String(ourRow?.belong));
    rec('归属描述里有题干内容（不是空泛的「题目」）',
      !!(ourRow && ourRow.belong && /函数/.test(ourRow.belong)),
      String(ourRow?.belong));
    await shot('01-notes-page.png');

    /* 断言 2：点它 → 进入做题页，且是那一题 */
    const clicked = await evalJs(`(()=>{
      const li=[...document.querySelectorAll('.nl-item')]
        .find(x=>x.querySelector('.nl-item__text')?.innerText?.includes('我懂了'));
      if(!li) return null;
      const btn=li.querySelector('.nl-item__btn');
      if(btn){btn.click();return true}
      return false;
    })()`);
    rec('点击那条笔记', clicked === true);
    await SLEEP(4000);

    const afterClick = await evalJs(`(()=>{
      const body=document.body.innerText;
      return {
        onPractice: !!document.querySelector('.review-foot') || !!document.querySelector('.question-card'),
        hasQuestion: /下列各组函数/.test(body),
        inReader: !!document.querySelector('.reader-page'),
        modeText: document.querySelector('.review-top__label, .review-head')?.innerText?.slice(0,60) ?? null,
      };
    })()`);
    console.log('  点击后 =', JSON.stringify(afterClick));

    rec('**点击后进入了做题页（不是阅读器）**', afterClick.onPractice === true && afterClick.inReader === false);
    rec('**题目就是笔记所属的那一道**', afterClick.hasQuestion === true);
    await shot('02-back-to-question.png');

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('异常：', e && e.message);
    console.error(log.slice(-1500));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await SLEEP(1500);
    console.log('（本次验证全程只读，未写任何笔记/题目/设置）');
  }
})();