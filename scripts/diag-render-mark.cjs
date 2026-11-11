/**
 * 对比「数据里的锚点偏移」与「页面上实际高亮的位置」（2026-11-11）。
 *
 * 上一步已证明数据没错（scripts/diag-anchor-data.cjs：12/12 逐字吻合）。
 * 那就一定是渲染时偏移算错了。
 *
 * 做法：点一条知识点的「第 N 页」，进阅读器后：
 *  1. 从页面 DOM 读出 mark 的实际文字
 *  2. 从库里读同一条知识点的 quote
 *  3. 逐字比对 —— 不等就是渲染偏移错
 *
 * 并且**多试几条**（不同页、有无插图），看是不是只在某些页错。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; }
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9830'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/diag-render'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
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

  /* 进知识库 */
  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='知识库'); if(l) l.closest('button').click(); })()`);
  await sleep(2500);

  /* 收集所有「第 N 页」按钮，逐条点开对比 */
  const results = [];
  for (let round = 0; round < 5; round++) {
    /* 回知识库首页（如果已经在阅读器，先返回） */
    const back = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('返回'));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    if (back) await sleep(1800);

    /* 确保在知识库 */
    const onKb = await evalJs(`(() => !!document.querySelector('.kb-point'))()`);
    if (!onKb) {
      await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='知识库'); if(l) l.closest('button').click(); })()`);
      await sleep(2000);
    }

    /* 点第 round 个「第 N 页」 */
    const clicked = await evalJs(`(() => {
      const cards = [...document.querySelectorAll('.kb-point')];
      let seen = 0;
      for (const c of cards) {
        const b = [...c.querySelectorAll('button')].find(x => { const t=(x.innerText||'').replace(/\s+/g,''); return t.includes('页') && t!=='改' && t!=='删除'; });
        if (!b) continue;
        if (seen === ${round}) {
          const quote = (c.querySelector('.kb-point__quote') || {}).innerText || '';
          b.click();
          return { ok: true, label: b.innerText.trim(), quote: quote.replace(/^「|」$/g,'').trim() };
        }
        seen++;
      }
      return { ok: false };
    })()`);
    if (!clicked.ok) break;
    await sleep(3200);

    /* 读页面实际渲染的 mark */
    const rendered = await evalJs(`(() => {
      const body = document.querySelector('.reader-body');
      if (!body) return { ok: false };
      const marks = [...body.querySelectorAll('mark.reader-mark')];
      const meta = (body.querySelector('.reader-meta') || {}).innerText || '';
      return {
        ok: true,
        markTexts: marks.map(m => (m.innerText || '')),
        markCount: marks.length,
        meta,
        hasFigure: body.querySelectorAll('img').length,
      };
    })()`);

    const norm = (s) => (s || '').replace(/\s+/g, '');
    const quoteN = norm(clicked.quote);
    /* mark 文字里是否有与 quote 开头一致的部分 */
    const anyMatch = (rendered.markTexts || []).some((t) => {
      const tn = norm(t);
      if (!tn || !quoteN) return false;
      return tn === quoteN || tn.startsWith(quoteN.slice(0, 15)) || quoteN.startsWith(tn.slice(0, 15));
    });

    results.push({
      round,
      label: clicked.label,
      quoteHead: clicked.quote.slice(0, 30),
      markCount: rendered.markCount,
      markHeads: (rendered.markTexts || []).map((t) => t.slice(0, 30)),
      meta: rendered.meta,
      hasFigure: rendered.hasFigure,
      match: anyMatch,
    });

    /* 截图留证（只留第一张） */
    if (round === 0) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, 'first.png'), Buffer.from(s.data, 'base64'));
    }
  }

  console.log('=== 渲染层诊断：页面高亮 vs 知识点引文 ===\n');
  for (const r of results) {
    console.log(`${r.match ? 'OK  ' : '❌错'} 轮${r.round} ${r.label}  (${r.meta.trim()}, 图${r.hasFigure})`);
    console.log(`      引文: ${JSON.stringify(r.quoteHead)}`);
    console.log(`      高亮: ${JSON.stringify(r.markHeads)}`);
  }
  const bad = results.filter((r) => !r.match);
  console.log(`\n渲染错位: ${bad.length} / ${results.length}`);

  app.kill();
  try { spawn('taskkill', ['/F','/IM','OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
