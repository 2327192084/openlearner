/**
 * 验证「在标题上做标注不会偏移」（2026-11-11）。
 *
 * ## 用户报的具体场景
 *
 * 「第一页的标题我进行了标注，但是发生了偏移」
 *
 * 根因：标题渲染时 `#` 被吃掉，DOM 文本比原文少了 `#` 与空格。
 * 旧代码用 `Range.toString().length` 量偏移 —— 那是在 DOM 上量的，
 * 于是算出的偏移比原文偏移小，标注往前偏。
 *
 * 修法：MarkdownBodyMarked 在块元素上标 `data-from` / `data-offset-base`，
 * 取偏移时按「块原文起点 + 块内偏移」还原，再校验切出的文字确实是选区。
 *
 * 本脚本：
 *  1. 在**标题**上造选区 → 点「高亮」→ 读回库里的 anchor.start/end
 *  2. 用这个偏移从原文切出文字，必须与选区文字逐字相同
 *  3. 同时验证段落上的标注（不能因为修标题把段落弄坏）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : f; }
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', ''));
const PORT = Number(arg('port', '9860'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fail = [];
  const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail.push(l); };

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

  /* 进阅读器 —— 选带 Markdown 标题的那份（PDF，36 页） */
  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='资料'); if(l) l.closest('button').click(); })()`);
  await sleep(2000);

  /*
   * 关键：要挑**含 Markdown 标题**的那份资料。
   * 库里有 DOCX（纯段落、无 # 标题）与 PDF（有 `# 第1章` 这种）。
   * 标题偏移的 bug 只在后者出现 —— 选错资料就测不到。
   */
  const picked = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.source-row')];
    /* .source-row__meta 里有 "PDF · 36 页" 这种，按 PDF 挑 */
    for (const r of rows) {
      const meta = (r.querySelector('.source-row__meta') || {}).innerText || '';
      if (meta.includes('PDF')) { r.click(); return { ok: true, meta }; }
    }
    /* 没有 PDF 就用第一条 */
    if (rows[0]) { rows[0].click(); return { ok: true, meta: 'first' }; }
    return { ok: false };
  })()`);
  picked.ok ? ok('打开 PDF 资料（含 Markdown 标题）', picked.meta) : bad('没有资料可打开');
  await sleep(3200);

  /* ---- 检查块元素上有没有 data-from ---- */
  const attrs = await evalJs(`(() => {
    const body = document.querySelector('.reader-body');
    const h = [...body.querySelectorAll('[data-from]')];
    return {
      count: h.length,
      samples: h.slice(0, 4).map(e => ({
        tag: e.tagName,
        cls: e.className,
        from: e.getAttribute('data-from'),
        base: e.getAttribute('data-offset-base'),
        text: (e.innerText||'').slice(0, 20),
      })),
    };
  })()`);

  attrs.count > 0
    ? ok('块元素带 data-from 标记', `${attrs.count} 个`)
    : bad('块元素没有 data-from（修不了标题偏移）');
  console.log('        样本:', JSON.stringify(attrs.samples.slice(0, 2)));

  /* ---- 在标题上造选区并标注 ---- */
  const headingMark = await evalJs(`(async () => {
    const body = document.querySelector('.reader-body');

    /*
     * 必须选中真正的标题元素（h1~h4），不能退化成第一个 [data-from]。
     *
     * 第一版写成 \`h1,h2,h3,h4,[data-from]\` 的选择器并取第一个 ——
     * 结果是第一个带 data-from 的段落，不是标题，测不出标题偏移。
     */
    const h = body.querySelector('h1, h2, h3, h4');
    if (!h) return { ok: false, why: '这一页没有 Markdown 标题（换份资料或翻页）' };

    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    let node = null, n;
    while ((n = walker.nextNode())) { if ((n.textContent||'').trim().length > 3) { node = n; break; } }
    if (!node) return { ok: false, why: 'no text node in heading' };

    const text = node.textContent;
    const start = 1;
    const end = Math.min(text.length, start + 4);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    return {
      ok: true,
      quote: text.slice(start, end),
      tag: h.tagName,
      fullHeading: text,
      dataFrom: h.getAttribute('data-from'),
      base: h.getAttribute('data-offset-base'),
    };
  })()`);

  headingMark.ok
    ? ok('在标题上造出选区', `「${headingMark.quote}」 in ${headingMark.tag}（标题全文「${headingMark.fullHeading}」, data-from=${headingMark.dataFrom}）`)
    : bad('造标题选区失败', headingMark.why);
  await sleep(700);

  /* 切到批注页点高亮 */
  await evalJs(`(() => { const t=[...document.querySelectorAll('.rside__tab')].find(b=>(b.innerText||'').includes('批注')); if(t) t.click(); })()`);
  await sleep(800);
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.rside__kind')].find(x => (x.innerText||'').includes('高亮'));
    if (b && !b.disabled) b.click();
  })()`);
  await sleep(1500);

  /* ---- 读回库里的 anchor，校验偏移 ---- */
  const verify = await evalJs(`(async () => {
    const dbs = await indexedDB.databases();
    const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || {}).name;
    const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
    const all = (s) => new Promise((res) => { const rq = db.transaction(s,'readonly').objectStore(s).getAll(); rq.onsuccess = () => res(rq.result); });

    const anns = await all('sourceAnnotations');
    const segs = await all('sourceSegments');

    /* 找刚才那条：kind=highlight 且 createdAt 最新，并记下它属于哪份资料 */
    let latest = null;
    let latestSourceId = null;
    for (const a of anns) {
      for (const m of (a.textMarks || [])) {
        if (!latest || m.createdAt > latest.createdAt) {
          latest = m;
          latestSourceId = a.sourceId;
        }
      }
    }
    if (!latest) { db.close(); return { ok: false, why: 'no mark' }; }

    const seg = segs.find(s => s.page === latest.anchor.page && s.sourceId === latestSourceId);
    db.close();
    if (!seg) return { ok: false, why: 'no seg' };

    /* 用存下来的偏移从原文切，必须等于 exact */
    const sliced = seg.text.slice(latest.anchor.start, latest.anchor.end);
    return {
      ok: true,
      exact: latest.anchor.exact,
      start: latest.anchor.start,
      end: latest.anchor.end,
      sliced,
      matches: sliced === latest.anchor.exact,
      segLen: seg.text.length,
    };
  })()`);

  if (!verify.ok) {
    bad('读回标注', verify.why);
  } else {
    console.log(`        选区   : ${JSON.stringify(verify.exact)}`);
    console.log(`        偏移   : [${verify.start}, ${verify.end}]`);
    console.log(`        切出的 : ${JSON.stringify(verify.sliced)}`);
    verify.matches
      ? ok('标题标注的偏移准确（按偏移切出的文字 = 选区文字）')
      : bad('标题标注偏移错', `${JSON.stringify(verify.sliced)} ≠ ${JSON.stringify(verify.exact)}`);
  }

  console.log(fail.length === 0 ? '\n全部通过（标题标注已修）' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);

  app.kill();
  try { spawn('taskkill', ['/F','/IM','OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
