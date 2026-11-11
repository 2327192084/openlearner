/**
 * 诊断「标注高亮位置错」到底错在哪（2026-11-11）。
 *
 * 用户第二次反馈同一个 bug：「标注显示还没修好」。
 * 上一轮我把 MarkdownBody 与切三段合并了，理论偏移应该一致，
 * 所以必须实测：高亮区间的字符偏移、渲染出来的文字、原文三者
 * 逐字对照，看偏差从哪来。
 *
 * 用法：node scripts/diag-mark-offset.cjs --app ... --data ...
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(n, f) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
}
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9770'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = spawn(
    path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA_DIR}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { stdio: 'ignore' },
  );

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

  /* 进知识库 → 点一条有锚点的知识点 */
  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='知识库'); if(l) l.closest('button').click(); })()`);
  await sleep(2500);

  await evalJs(`(() => {
    for (const c of [...document.querySelectorAll('.kb-point')]) {
      const b = [...c.querySelectorAll('button')].find(x => { const t=(x.innerText||'').replace(/\s+/g,''); return t.includes('页') && t!=='改' && t!=='删除'; });
      if (b) { b.click(); return true; }
    }
  })()`);
  await sleep(3500);

  /* 核心诊断：拿到段原文、高亮区间、以及 mark 里实际渲染的文字 */
  const diag = await evalJs(`(() => {
    const body = document.querySelector('.reader-body');
    if (!body) return { ok: false, why: 'no body' };

    const mark = body.querySelector('mark.reader-mark');
    const md = body.querySelector('.reader-md');

    /* 正文渲染出来的纯文本（去掉 mark 的高亮记忆，我们要看真实字符） */
    const rendered = body.innerText || '';

    /* mark 里的文字 */
    const markText = mark ? (mark.innerText || '') : null;

    /* mark 在渲染文本里的位置 */
    const markPos = markText ? rendered.indexOf(markText) : -1;

    /* 这一页的 meta 行告诉我们页/字数 */
    const meta = (body.querySelector('.reader-meta') || {}).innerText || '';

    return {
      ok: true,
      hasMark: !!mark,
      markText,
      markPos,
      /* mark 前 60 字与后 60 字，方便看它落在哪 */
      beforeMark: markPos > 0 ? rendered.slice(Math.max(0, markPos - 60), markPos) : null,
      afterMark: markPos >= 0 && markText ? rendered.slice(markPos + markText.length, markPos + markText.length + 60) : null,
      meta,
      renderedHead: rendered.slice(0, 200),
      hasFigure: body.querySelectorAll('.reader-figure, figure, img').length,
      noteCount: body.querySelectorAll('.reader-note').length,
    };
  })()`);

  console.log('=== 高亮渲染诊断 ===');
  console.log(JSON.stringify(diag, null, 2));

  app.kill();
  try { spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
