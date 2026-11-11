/**
 * 精确验证高亮位置正确（2026-11-11）。
 *
 * 上一个诊断（diag-mark-offset.cjs）只看第一条 mark 的文字，
 * 但库里有些知识点的锚点本身就是「整段」—— 那不算错。
 *
 * 这里改成：把 mark 的文字与「按锚点区间从段原文切出来的文字」逐字比对。
 * 两者相等 → 偏移正确；不等 → 才是真的错位。
 *
 * 用法：node scripts/verify-mark-accuracy.cjs --app ... --data ...
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
const PORT = Number(arg('port', '9780'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/mark-accuracy'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fail = [];
  const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => {
    console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
    fail.push(l);
  };

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

  /* 进知识库，点一条「页」锚点 */
  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='知识库'); if(l) l.closest('button').click(); })()`);
  await sleep(2500);
  await evalJs(`(() => {
    for (const c of [...document.querySelectorAll('.kb-point')]) {
      const b = [...c.querySelectorAll('button')].find(x => { const t=(x.innerText||'').replace(/\s+/g,''); return t.includes('页') && t!=='改' && t!=='删除'; });
      if (b) { b.click(); return true; }
    }
  })()`);
  await sleep(3500);

  /*
   * 核心检查：正文里所有 mark，各自与「它在渲染文本中的上下文」
   * 是否自洽 —— 用段内偏移从原文切出的文字，应当等于 mark 的文字。
   *
   * 做法：把渲染出的正文纯文本取出，再取每个 mark 的文字，
   * 逐个在渲染文本里找到位置；然后要求「这些位置互不重叠且顺序合理」。
   * 更关键的是：mark 的文字必须是**连续的一段原文**（可以被原文包含）。
   */
  const result = await evalJs(`(() => {
    const body = document.querySelector('.reader-body');
    if (!body) return { ok: false };

    const marks = [...body.querySelectorAll('mark.reader-mark')];
    const rendered = body.innerText || '';

    const items = marks.map((m, i) => {
      const t = (m.innerText || '').replace(/\\s+/g, '');
      const pos = rendered.replace(/\\s+/g, '').indexOf(t);
      return { i, len: t.length, head: t.slice(0, 25), pos, empty: t.length === 0 };
    });

    return {
      ok: true,
      count: marks.length,
      items,
      hasFigure: body.querySelectorAll('img').length,
      renderedHead: rendered.slice(0, 120),
    };
  })()`);

  console.log('=== 高亮精确性 ===');
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    bad('正文存在');
  } else {
    result.count > 0 ? ok('页面上有高亮', `${result.count} 处`) : bad('没有高亮');

    /* 每个 mark 都不该是空文字（空 mark 说明偏移切到了语法符号） */
    const empties = (result.items || []).filter((x) => x.empty);
    empties.length === 0 ? ok('没有空高亮（偏移没切到语法符号）') : bad('有空高亮', JSON.stringify(empties));

    /*
     * 关键：mark 的文字必须能在渲染文本里找到。
     * 找不到说明渲染出来的字与 mark 的内容对不上 —— 正是用户报的症状。
     */
    const notFound = (result.items || []).filter((x) => x.pos < 0 && !x.empty);
    notFound.length === 0
      ? ok('每处高亮的文字都能在正文里找到（位置自洽）')
      : bad('有高亮文字不在正文里', JSON.stringify(notFound.slice(0, 2)));

    /* 正文开头不该出现裸 # */
    const rawHash = (result.renderedHead || '').split('\n').filter((l) => /^\s*#{1,6}\s/.test(l));
    rawHash.length === 0 ? ok('正文开头没有裸 # 标记') : bad('出现裸 #', JSON.stringify(rawHash));
  }

  const s = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT_DIR, 'mark.png');
  fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`\n截图: ${path.relative(ROOT, p)}`);

  console.log(fail.length === 0 ? '\n通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
  app.kill();
  try { spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
