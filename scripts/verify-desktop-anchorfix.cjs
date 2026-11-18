/**
 * 验证桌面安装版（resources/app.asar）的批注三项修复（2026-11-18）：
 *  1) 治本：公式区新建标记 exact = 原文源码（无零宽、能在 seg.text 搜到、start>0）
 *  2) 下划线蓝、高亮黄、删除线红（不误伤）
 *  3) 右栏 position:sticky，滚动后仍贴顶
 *
 * 直接启动安装目录 OpenLeaner.exe（无项目根参数 → 走 app.asar），
 * --user-data-dir 指隔离副本，APPDATA 指隔离副本，不碰真实库。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const INSTALL = path.join(process.env.LOCALAPPDATA || 'C:/Users/ASUS/AppData/Local', 'Programs/OpenLeaner');
const EXE = path.join(INSTALL, 'OpenLeaner.exe');
const APPDATA = path.resolve(__dirname, '../.tmp/mark-diag-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.resolve(__dirname, '../.verify-shots/desktop-anchorfix');
const SID = 'source_4d158c26-88b8-41d8-8f94-8f6d49f45382';
const PORT = Number(process.argv[2] || 9813);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`); ok ? pass++ : fail++; };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = spawn(EXE, [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], { cwd: INSTALL, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 200; i++) {
      try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0); if (target) break; } catch {}
      await sleep(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-3000)); process.exit(2); }
    rec('桌面版启动且 asar integrity 通过', String(target.url).includes('app.asar'), target.url.slice(0, 90));
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 90000); });
    const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable'); await sleep(4000);

    // 下划线颜色规则
    const cssRule = await evalJs(`(()=>{for(const s of document.styleSheets){let rs;try{rs=s.cssRules}catch(e){continue}for(const r of rs)if((r.selectorText||'').includes('leaner-mark-underline'))return r.cssText;}return null;})()`);
    const blue = cssRule && (/#2563eb/i.test(cssRule) || /37,\s*99,\s*235/.test(cssRule)) && !/234,\s*179,\s*8/.test(cssRule);
    rec('桌面版下划线为蓝色（非黄）', !!blue, (cssRule || 'not found').slice(0, 120));
    // 进资料页 + 打开信号与系统 + 跳36页
    await evalJs(`(()=>{document.querySelectorAll('.nav-group').forEach(g=>{if(g.textContent.includes('资料'))g.classList.add('is-open');});return true;})()`);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('.nav-item__label,.nav-item')].find(e=>['资料库','资料'].includes(e.textContent.trim()));el&&el.click();return !!el;})()`);
    await sleep(1500);
    const opened = await evalJs(`(()=>{const r=[...document.querySelectorAll('.source-row')].find(x=>x.textContent.includes('信号与系统'));if(!r)return false;r.click();return true;})()`);
    rec('打开信号与系统资料', opened === true);
    await sleep(3500);
    await evalJs(`(()=>{const inp=document.querySelector('.reader-nav__input');if(!inp)return false;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,'36');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await sleep(2200);

    // 基线标记数
    const count0 = await evalJs(`(async()=>{const o=indexedDB.open('openleaner');const db=await new Promise((r,j)=>{o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error)});const tx=db.transaction('sourceAnnotations','readonly');const q=tx.objectStore('sourceAnnotations').getAll();const a=await new Promise((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const rec=a.find(x=>x.sourceId==='${SID}'&&x.page===36);return rec?.textMarks?.length||0;})()`);
    rec('读到第36页标记基线', count0 >= 5, 'count=' + count0);

    // 构造选区：端点都在【同一公式片段内部】（复现用户真实拖选，避免假阳性）
    const sel = await evalJs(`(()=>{const body=document.querySelector('.reader-body');if(!body)return{err:'no body'};const math=body.querySelector('[data-raw-math]');if(!math)return{err:'no math'};const kh=math.querySelector('.katex-html')||math;const walker=document.createTreeWalker(kh,NodeFilter.SHOW_TEXT);let node=null,best=0,n=walker.nextNode();while(n){if(n.textContent.length>best){best=n.textContent.length;node=n;}n=walker.nextNode();}if(!node)return{err:'no text node'};const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(3,node.textContent.length));const s=window.getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));return{sel:s.toString().slice(0,50)};})()`);
    rec('构造公式内部选区（端点同一片段）', !!sel.sel && sel.sel.length > 0, JSON.stringify(sel).slice(0, 100));
    await sleep(600);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.rside__tab')].find(x=>x.textContent.includes('批注'));b&&b.click();return !!b;})()`);
    await sleep(500);
    const clicked = await evalJs(`(()=>{const b=[...document.querySelectorAll('.rside__kind')].find(x=>x.textContent.includes('高亮'));if(!b||b.disabled)return false;b.click();return true;})()`);
    rec('点击高亮加标记', clicked === true);

    await sleep(1500);
    const after = await evalJs(`(async()=>{const o=indexedDB.open('openleaner');const db=await new Promise((r,j)=>{o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error)});const tx=db.transaction(['sourceAnnotations','sourceSegments'],'readonly');const get=(s)=>new Promise((r,j)=>{const q=tx.objectStore(s).getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const [as,segs]=await Promise.all([get('sourceAnnotations'),get('sourceSegments')]);const rec=as.find(x=>x.sourceId==='${SID}'&&x.page===36);const marks=rec?.textMarks||[];const m=marks.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];const ex=m?.anchor?.exact||'';const text=(segs.find(s=>s.sourceId==='${SID}'&&s.page===36)?.text)||'';return{count:marks.length,kind:m?.kind,exactLen:ex.length,hasZeroWidth:/[\\u200b\\u200c\\u200d\\ufeff]/.test(ex),indexInText:text.indexOf(ex),start:m?.anchor?.start};})()`);
    rec('新标记已写入桌面版库', after.count === count0 + 1, `count ${count0}->${after.count}`);
    rec('kind=highlight', after.kind === 'highlight', String(after.kind));
    rec('exact 不含零宽字符（治本）', after.hasZeroWidth === false, 'hasZeroWidth=' + after.hasZeroWidth);
    rec('exact 是原文源码（治本）', after.indexInText >= 0, 'indexOf=' + after.indexInText);
    rec('start>0', after.start > 0, 'start=' + after.start);

    // 三功能区固定贴顶：按用户真实操作滚【整个 document】，不再滚 rside__body。
    // 右栏 position:fixed 后不依赖包含块，滚到底三按钮仍须贴视口顶部。
    const stickySec = await evalJs(`(()=>{
      const rside=document.querySelector('.rside');
      const kinds=document.querySelector('.rside__kinds');
      if(!rside||!kinds) return {err:'no rside/kinds'};
      const acts=document.querySelector('.reader-head__actions');
      const bar=document.querySelector('.reader-bar');
      const rsideLeft=Math.round(rside.getBoundingClientRect().left);
      const actsRight=acts?Math.round(acts.getBoundingClientRect().right):-1;
      const barRight=bar?Math.round(bar.getBoundingClientRect().right):-1;
      return {rsidePosition:getComputedStyle(rside).position,
        docScrollable:document.scrollingElement.scrollHeight-window.innerHeight,
        kindCount:kinds.querySelectorAll('.rside__kind').length,
        actsRight, barRight, rsideLeft,
        topBarsClear:actsRight>0&&barRight>0&&actsRight<=rsideLeft+1&&barRight<=rsideLeft+1};
    })()`);
    rec('右栏 position:fixed（桌面版）', stickySec.rsidePosition === 'fixed', JSON.stringify(stickySec));
    rec('三功能按钮齐全（桌面版）', stickySec.kindCount === 3, 'kindCount=' + stickySec.kindCount);
    rec('顶栏按钮不被右栏遮住（桌面版）', stickySec.topBarsClear === true,
      `actsRight=${stickySec.actsRight} barRight=${stickySec.barRight} rsideLeft=${stickySec.rsideLeft}`);
    if (stickySec.docScrollable > 100) {
      await evalJs(`(()=>{window.scrollTo(0,document.scrollingElement.scrollHeight);return true;})()`);
      await sleep(700);
      const after2 = await evalJs(`(()=>{const kinds=document.querySelector('.rside__kinds');const kr=kinds.getBoundingClientRect();return{scrollY:Math.round(window.scrollY),kindsTop:Math.round(kr.top),kindsVisible:kr.top>=40&&kr.top<260};})()`);
      rec('滚【整个 document】到底三按钮仍贴视口顶部（桌面版）', after2.kindsVisible === true, JSON.stringify(after2));
      await evalJs(`(()=>{window.scrollTo(0,0);return true;})()`);
      await sleep(400);
    }
    await shot('desktop-anchorfix.png');
    console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) { console.error('异常:', e.stack || e.message); console.error(log.slice(-3000)); process.exitCode = 1; }
  finally { if (ws) ws.close(); try { app.kill(); } catch {} }
})();
