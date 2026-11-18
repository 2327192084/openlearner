/**
 * 验证批注修复的两项 UI 效果（2026-11-18）：
 *  1) 批注下划线 ::highlight(leaner-mark-underline) 是蓝色（不是黄色）
 *  2) 右栏 .rside 固定：页面滚动后仍贴视口顶（position:sticky 生效）
 *
 * 复用隔离库 .tmp/mark-diag-appdata，新 dist，只读资料页 + 滚动/选区操作，
 * 不写库、不发请求。截图 .verify-shots/reader-fixes/。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/mark-diag-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/reader-fixes');
const PORT = Number(process.argv[2] || 9812);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`); ok ? pass++ : fail++; };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = spawn(EXE, [ROOT, `--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (!target) { console.error('起不来:' + log.slice(-2000)); process.exit(2); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = id++; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 60000); });
    const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable'); await sleep(4000);

    // 1) 下划线颜色规则
    const cssRule = await evalJs(`(()=>{
      let found=null;
      for(const sheet of document.styleSheets){
        let rules; try{rules=sheet.cssRules}catch(e){continue}
        for(const r of rules){
          if(r.selectorText && r.selectorText.includes('leaner-mark-underline')){
            found=(found||'')+r.cssText;
          }
        }
      }
      return found;
    })()`);
    const isBlue = cssRule && /37,\s*99,\s*235|#2563eb/i.test(cssRule) && !/234,\s*179,\s*8/i.test(cssRule);
    rec('批注下划线 CSS 为蓝色（非黄）', !!isBlue, (cssRule || 'not found').slice(0, 160));
    // 删除线仍红、高亮仍黄（不误伤）
    const otherRules = await evalJs(`(()=>{
      let out={};
      for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules}catch(e){continue}
        for(const r of rules){const s=r.selectorText||'';
          if(s.includes('leaner-mark-highlight'))out.h=(out.h||'')+r.cssText;
          if(s.includes('leaner-mark-strike'))out.s=(out.s||'')+r.cssText;
        }}
      return out;
    })()`);
    rec('高亮仍黄底（未误伤）', /234,\s*179,\s*8|250,\s*204,\s*21|eab308/i.test(otherRules.h || ''), (otherRules.h || '').slice(0, 100));
    rec('删除线仍红（未误伤）', /220,\s*100,\s*100/i.test(otherRules.s || ''), (otherRules.s || '').slice(0, 100));

    // 进资料页 + 打开信号与系统
    await evalJs(`(()=>{document.querySelectorAll('.nav-group').forEach(g=>{if(g.textContent.includes('资料'))g.classList.add('is-open');});return true;})()`);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('.nav-item__label,.nav-item')].find(e=>['资料库','资料'].includes(e.textContent.trim()));el&&el.click();return !!el;})()`);
    await sleep(1500);
    await evalJs(`(()=>{const r=[...document.querySelectorAll('.source-row')].find(x=>x.textContent.includes('信号与系统'));r&&r.click();return !!r;})()`);
    await sleep(3500);
    // 跳36页
    await evalJs(`(()=>{const inp=document.querySelector('.reader-nav__input');if(!inp)return false;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,'36');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await sleep(2000);
    // 清除选区（避免蓝色 selection 干扰视觉）
    await evalJs(`(()=>{window.getSelection().removeAllRanges();return true;})()`);
    await sleep(400);

    // 2) 三功能区固定贴顶：这次按用户真实操作滚【整个 document】。
    //    前三次验证全栽在滚错容器（.rside__body / 内部），用户滚的是整页：
    //    正文长撑高页面，由 document 滚动。右栏改成 position:fixed 后
    //    不依赖包含块，滚到底三按钮仍须贴视口顶部。
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.rside__tab')].find(x=>x.textContent.includes('批注'));b&&b.click();return !!b;})()`);
    await sleep(600);
    const layout = await evalJs(`(()=>{
      const rside=document.querySelector('.rside');
      const kinds=document.querySelector('.rside__kinds');
      if(!rside||!kinds) return {err:'no rside/kinds'};
      const rs=getComputedStyle(rside);
      // 顶栏按钮右边缘 vs 右栏左边缘：不能被 fixed 右栏压住（用户反馈「遮住按钮一部分」）
      const rr=rside.getBoundingClientRect();
      const acts=document.querySelector('.reader-head__actions');
      const bar=document.querySelector('.reader-bar');
      const actsRight=acts?Math.round(acts.getBoundingClientRect().right):-1;
      const barRight=bar?Math.round(bar.getBoundingClientRect().right):-1;
      const rsideLeft=Math.round(rr.left);
      return {rsidePosition:rs.position, kindCount:kinds.querySelectorAll('.rside__kind').length,
        docScrollH:document.scrollingElement.scrollHeight, viewH:window.innerHeight,
        scrollY0:Math.round(window.scrollY), kindsTop0:Math.round(kinds.getBoundingClientRect().top),
        actsRight, barRight, rsideLeft,
        topBarsClear:actsRight>0 && barRight>0 && actsRight<=rsideLeft+1 && barRight<=rsideLeft+1};
    })()`);
    rec('右栏 position:fixed（不依赖会滚走的包含块）', layout.rsidePosition === 'fixed', JSON.stringify(layout));
    rec('三个功能按钮齐全', layout.kindCount === 3, 'kindCount=' + layout.kindCount);
    rec('顶栏按钮不被 fixed 右栏遮住（全屏/返回、搜索/看原图完整可见）', layout.topBarsClear === true,
      `actsRight=${layout.actsRight} barRight=${layout.barRight} rsideLeft=${layout.rsideLeft}`);
    const docCanScroll = layout.docScrollH - layout.viewH > 100;
    rec('整页可滚动（能检验固定）', docCanScroll, `${layout.docScrollH}-${layout.viewH}`);
    if (docCanScroll) {
      await evalJs(`(()=>{window.scrollTo(0, document.scrollingElement.scrollHeight);return true;})()`);
      await sleep(700);
      const after = await evalJs(`(()=>{
        const kinds=document.querySelector('.rside__kinds');
        const rside=document.querySelector('.rside');
        const kr=kinds.getBoundingClientRect(), rr=rside.getBoundingClientRect();
        return {scrollY:Math.round(window.scrollY),
          kindsTop:Math.round(kr.top), rsideTop:Math.round(rr.top),
          kindsVisible:kr.top >= 40 && kr.top < 260};
      })()`);
      // 进入阅读器会跳到上次阅读位置（scrollY0 可能已很大），所以断言「确实到达底部」而非「滚动幅度 >100」
      rec('滚【整个 document】确实到达底部', after.scrollY >= layout.docScrollH - layout.viewH - 5,
        `scrollY ${layout.scrollY0}->${after.scrollY}, bottom=${layout.docScrollH - layout.viewH}`);
      rec('滚到底后三按钮仍贴视口顶部可见', after.kindsVisible === true, JSON.stringify(after));
      await shot('02-doc-scrolled-kinds-fixed.png');
      await evalJs(`(()=>{window.scrollTo(0,0);return true;})()`);
      await sleep(400);
    }
    await shot('01-underline-blue.png');
    console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('异常:', e.stack || e.message); console.error(log.slice(-2000)); process.exitCode = 1;
  } finally { if (ws) ws.close(); try { app.kill(); } catch {} }
})();
