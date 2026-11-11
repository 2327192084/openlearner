/**
 * 精确复现「划线备注按钮不可用」（2026-11-11）。
 *
 * ## 为什么要单独一个脚本
 *
 * verify-reader-notes.cjs 是「造选区 → 直接写入 → 点按钮」，
 * 全程没离开正文，所以选区一直在，按钮当然可用。
 *
 * 但用户的实际操作是：
 *   1. 在正文里选中一段
 *   2. **点备注输入框**（此时浏览器清掉正文选区）
 *   3. 打字
 *   4. 点「划选备注」
 *
 * 第 2 步就会让旧实现的 selectionText 变空、按钮变灰。
 * 这个脚本按用户真实顺序走一遍，并在第 2 步之后检查按钮状态。
 *
 * 用法：node scripts/verify-note-button.cjs --app ... --data ...
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
const PORT = Number(arg('port', '9800'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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

  /* 进阅读器 */
  await evalJs(`(() => { const l=[...document.querySelectorAll('.nav-item__label')].find(e=>e.innerText.trim()==='资料'); if(l) l.closest('button').click(); })()`);
  await sleep(2000);
  await evalJs(`(() => { const r=document.querySelector('.source-row'); if(r) r.click(); })()`);
  await sleep(3000);

  /* 切到备注页 */
  await evalJs(`(() => { const t=[...document.querySelectorAll('.rside__tab')].find(b=>(b.innerText||'').includes('备注')); if(t) t.click(); })()`);
  await sleep(900);

  /* 第 1 步：在正文里选中一段 */
  const sel = await evalJs(`(() => {
    const el = document.querySelector('.reader-body');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = null, n;
    while ((n = walker.nextNode())) { if ((n.textContent||'').trim().length > 40) { node = n; break; } }
    if (!node) return { ok: false };
    const r = document.createRange();
    r.setStart(node, 5); r.setEnd(node, 17);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    return { ok: true, quote: node.textContent.slice(5, 17) };
  })()`);
  sel.ok ? ok('第1步：选中文字', `「${sel.quote}」`) : bad('第1步失败');
  await sleep(700);

  /* 第 2 步：点输入框（模拟真实点击 —— 这一步会清掉正文选区） */
  const afterFocus = await evalJs(`(() => {
    const ta = document.querySelector('.rside__note-input');
    if (!ta) return { ok: false };
    ta.focus();
    /* 真的点一下：同时清掉 Selection，模拟浏览器行为 */
    if (window.getSelection) window.getSelection().removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    return { ok: true };
  })()`);
  await sleep(800);

  const btnState = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
    const why = document.querySelector('.rside__note-why');
    return {
      exists: !!b,
      disabled: b ? b.disabled : null,
      title: b ? b.title : null,
      why: why ? why.innerText.trim() : null,
    };
  })()`);

  /*
   * 注意：此时按钮**仍然禁用是对的** —— 输入框还空着。
   *
   * 前两轮我把这一条当成失败（"按钮变灰了"），其实判断错了两次：
   * 第 1 次没意识到禁用条件是「没选区 || 没内容」；
   * 第 2 次断言写成要求 title 是「挂到选中句」，但 title 会优先报
   * 「先写内容」—— 那恰恰说明**选区记住了**（否则会报「先选中文字」）。
   *
   * 正确的判据：title 不能是「先在正文里选中」。
   */
  const forgotSelection = /先在正文里选中/.test(btnState.title || '');
  !forgotSelection
    ? ok('第2步后仍记得选区（没退回「先选中文字」）', `title=${btnState.title}`)
    : bad('第2步后选区记忆丢了', `title=${btnState.title}`);
  btnState.why ? ok('有「还差什么」的实时提示', btnState.why) : bad('没有状态提示');

  /* 第 3 步：打字 */
  await evalJs(`(() => {
    const ta = document.querySelector('.rside__note-input');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '选完之后才写的备注。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600);

  const afterType = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
    return { disabled: b ? b.disabled : null };
  })()`);
  afterType.disabled === false ? ok('第3步打字后按钮可用') : bad('打字后按钮仍禁用');

  /* 第 4 步：点它，应当成功写入 */
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
    if (b && !b.disabled) b.click();
  })()`);
  await sleep(1500);

  const written = await evalJs(`(() => {
    const notes = [...document.querySelectorAll('.reader-body .reader-note')];
    const list = [...document.querySelectorAll('.rside__item--note')];
    return {
      inline: notes.length,
      texts: notes.map(n => (n.innerText||'').trim().slice(0, 20)),
      listed: list.length,
    };
  })()`);

  written.inline > 0
    ? ok('第4步：备注成功写入正文', JSON.stringify(written.texts))
    : bad('第4步：备注没写进去');
  written.listed > 0 ? ok('备注出现在列表里', `${written.listed} 条`) : bad('备注没进列表');

  console.log(fail.length === 0 ? '\n全部通过（用户报的 bug 已修）' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);

  app.kill();
  try { spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  process.exit(fail.length === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
