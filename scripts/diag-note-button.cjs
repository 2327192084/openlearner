/**
 * 查「点输入框后按钮为什么还变灰」（2026-11-11）。
 *
 * 前两轮都以为修好了（改 state、保留历史），但实测仍 disabled=true。
 * 不再猜，直接把每一步的 selectionText / recentSelection / 按钮状态
 * 打出来，看是哪个环节把值清掉了。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; }
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9810'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = spawn(path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA_DIR}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && String(t.url).startsWith('file://') && !String(t.url).includes('devtools'));
      if (page) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { app.kill(); throw new Error('没起来'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, {once:true}); ws.addEventListener('error', rej, {once:true}); });
  let id = 1; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const {resolve,reject}=pending.get(m.id); pending.delete(m.id); m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result); } });
  const send = (method, params={}) => new Promise((resolve,reject)=>{ const n=id++; pending.set(n,{resolve,reject}); ws.send(JSON.stringify({id:n,method,params})); setTimeout(()=>{ if(pending.has(n)){pending.delete(n);reject(new Error('timeout '+method));} }, 30000); });
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', {expression:expr, returnByValue:true, awaitPromise:true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);

  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='资料'); if(l) l.closest('button').click(); })()`);
  await sleep(2000);
  await evalJs(`(() => { const r=document.querySelector('.source-row'); if(r) r.click(); })()`);
  await sleep(3000);
  await evalJs(`(() => { const t=[...document.querySelectorAll('.rside__tab')].find(b=>(b.innerText||'').includes('备注')); if(t) t.click(); })()`);
  await sleep(900);

  const probe = async (label) => {
    const s = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
      const ta = document.querySelector('.rside__note-input');
      return {
        按钮存在: !!b,
        按钮禁用: b ? b.disabled : null,
        按钮title: b ? b.title : null,
        输入框值: ta ? ta.value : null,
        选区文字: (window.getSelection() || {}).toString ? (window.getSelection().toString()||'').slice(0,20) : null,
      };
    })()`);
    console.log(`[${label}]`, JSON.stringify(s));
  };

  await probe('初始');

  await evalJs(`(() => {
    const el = document.querySelector('.reader-body');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node=null,n; while((n=walker.nextNode())){ if((n.textContent||'').trim().length>40){node=n;break;} }
    const r=document.createRange(); r.setStart(node,5); r.setEnd(node,17);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  })()`);
  await sleep(900);
  await probe('选完字');

  /* 关键：点输入框 */
  await evalJs(`(() => { const ta=document.querySelector('.rside__note-input'); if(ta) ta.focus(); })()`);
  await sleep(900);
  await probe('聚焦输入框后');

  /* 再手动清选区，模拟浏览器 */
  await evalJs(`(() => { window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); })()`);
  await sleep(900);
  await probe('清掉选区后');

  app.kill();
  try { spawn('taskkill', ['/F','/IM','OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
