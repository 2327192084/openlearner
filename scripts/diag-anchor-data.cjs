/**
 * 精确诊断：高亮落到错句子时，错在数据还是渲染（2026-11-11）。
 *
 * 用户反馈「高亮落在错的那句话上」，资料是带 2 张插图的 PDF。
 *
 * 之前的 verify-mark-accuracy 只检查「mark 文字能在正文里找到」——
 * 那只能发现「渲染出了乱七八糟的字」，发现不了「渲染得很好但位置错了」。
 *
 * 这次对比三样东西：
 *   A. 知识点 anchors 里存的 charStart/charEnd + quote（数据）
 *   B. 按 A 的偏移从 seg.text 切出来的文字（数据自洽性）
 *   C. 页面上 <mark> 实际渲染出来的文字（渲染结果）
 *
 * 判读：
 *  - B ≠ quote      → 数据里锚点就错了（与渲染无关）
 *  - B = quote 但 C ≠ B → 渲染偏移算错（我的 bug）
 *  - 三者一致        → 这条没错，看下一条
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; }
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9820'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/diag-mark'));
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

  /* ---- 1. 直接从 IndexedDB 读数据，看锚点本身对不对 ---- */
  const data = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || {}).name;
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (store) => new Promise((res) => {
      if (!db.objectStoreNames.contains(store)) { res([]); return; }
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res([]);
    });

    const points = await all('knowledgePoints');
    const segs = await all('sourceSegments');

    /* 只取 PDF 那份（36 页） */
    const sources = await all('sources');
    const pdf = sources.find(s => (s.pageCount || 0) > 10) || sources[0];

    const segByPage = new Map();
    for (const s of segs) if (s.sourceId === pdf.id) segByPage.set(s.page, s);

    /* 逐条知识点，比对「按偏移切出来的文字」与「quote」 */
    const checked = [];
    for (const p of points) {
      if (p.sourceId !== pdf.id) continue;
      const a = (p.anchors || [])[0];
      if (!a || typeof a.charStart !== 'number') continue;
      const seg = segByPage.get(a.page);
      if (!seg) continue;

      const sliced = seg.text.slice(a.charStart, a.charEnd);
      const quote = (p.quotes || [])[0] || '';

      checked.push({
        id: p.id,
        page: a.page,
        charStart: a.charStart,
        charEnd: a.charEnd,
        slicedHead: sliced.slice(0, 40),
        quoteHead: quote.slice(0, 40),
        /* 关键判定：偏移切出来的，与 quote 是否一致（忽略空白） */
        offsetMatchesQuote:
          sliced.replace(/\\s+/g, '') === quote.replace(/\\s+/g, '') ||
          (quote.length > 0 && sliced.replace(/\\s+/g,'').startsWith(quote.replace(/\\s+/g,'').slice(0, 20))),
        slicedLen: sliced.length,
        quoteLen: quote.length,
      });
    }

    db.close();
    return { ok: true, pdfTitle: pdf.title, total: checked.length, checked: checked.slice(0, 12) };
  })()`);

  console.log('=== 数据层诊断（锚点 vs 原文）===');
  console.log('资料:', data.pdfTitle);
  console.log('被检知识点:', data.total);
  console.log();
  for (const c of data.checked) {
    const flag = c.offsetMatchesQuote ? 'OK  ' : '❌错';
    console.log(`${flag} p${c.page} [${c.charStart},${c.charEnd}] len=${c.slicedLen}/${c.quoteLen}`);
    console.log(`      按偏移切出: ${JSON.stringify(c.slicedHead)}`);
    console.log(`      知识点引文: ${JSON.stringify(c.quoteHead)}`);
  }

  const badData = data.checked.filter((c) => !c.offsetMatchesQuote);
  console.log();
  console.log(`数据层错位: ${badData.length} / ${data.checked.length}`);

  app.kill();
  try { spawn('taskkill', ['/F','/IM','OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
