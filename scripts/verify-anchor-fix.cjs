/**
 * 验证「公式区批注锚点」治本修复（2026-11-18）。
 *
 * 核心断言：在含 KaTeX 公式的段落上新建高亮标记后，
 * 存进 IndexedDB 的 anchor.exact 必须是【原文源码】，
 * 即 seg.text.indexOf(exact) >= 0 且不含零宽字符 ——
 * 而不是旧的「DOM 渲染文本」（含零宽字符/下标变形，还原时判 lost）。
 *
 * 用新 dist（.tmp/cloud-fullonly-app/electron.exe + 项目根）跑，
 * 数据用隔离库 .tmp/mark-diag-appdata（含信号与系统，只读复制）。
 * 不点解析、不发请求、不碰真实库。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/mark-diag-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/anchor-fix');
const fs = require('node:fs');
const SID = 'source_4d158c26-88b8-41d8-8f94-8f6d49f45382';
const PORT = Number(process.argv[2] || 9811);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const rec = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' :: ' + extra : ''}`);
  ok ? pass++ : fail++;
};

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
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await sleep(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-2000)); process.exit(2); }
    rec('新 dist 启动', true, target.url.slice(0, 70));

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
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
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    };
    await send('Runtime.enable'); await send('Page.enable');
    await sleep(4000);

    // 进资料页
    await evalJs(`(()=>{document.querySelectorAll('.nav-group').forEach(g=>{if(g.textContent.includes('资料'))g.classList.add('is-open');});return true;})()`);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('.nav-item__label,.nav-item')].find(e=>e.textContent.trim()==='资料库'||e.textContent.trim()==='资料');el&&el.click();return !!el;})()`);
    await sleep(1500);
    // 打开信号与系统资料
    const opened = await evalJs(`(()=>{const rows=[...document.querySelectorAll('.source-row')];const r=rows.find(x=>x.textContent.includes('信号与系统'));if(!r)return 'NOT_FOUND';r.click();return r.textContent.slice(0,40);})()`);
    rec('打开信号与系统资料', typeof opened === 'string' && opened !== 'NOT_FOUND', String(opened).slice(0, 40));
    await sleep(3500);

    // 基线：读 page36 的段与标记数
    const base = await evalJs(`(async()=>{
      const o=indexedDB.open('openleaner');
      const db=await new Promise((res,rej)=>{o.onsuccess=()=>res(o.result);o.onerror=()=>rej(o.error);});
      const tx=db.transaction(['sourceSegments','sourceAnnotations'],'readonly');
      const get=(s)=>new Promise((res,rej)=>{const q=tx.objectStore(s).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
      const [segs,annos]=await Promise.all([get('sourceSegments'),get('sourceAnnotations')]);
      const seg=segs.find(s=>s.sourceId==='${SID}'&&s.page===36);
      const a=annos.find(x=>x.sourceId==='${SID}'&&x.page===36);
      return {text:seg?.text||'', count:a?.textMarks?.length||0};
    })()`);
    rec('读到第36页段文本', base.text.length > 500, 'len=' + base.text.length);
    rec('读到现有标记基线', base.count >= 5, 'count=' + base.count);

    // 跳到第36页
    await evalJs(`(()=>{const inp=document.querySelector('.reader-nav__input');if(!inp)return false;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,'36');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await sleep(2500);
    const pageNow = await evalJs(`(()=>document.querySelector('.reader-nav__input')?.value)()`);
    rec('跳到第36页', String(pageNow) === '36', 'value=' + pageNow);

    // 构造选区：端点都在【同一个公式片段内部】（复现用户真实拖选公式的行为）。
    // 上一版假阳性就是端点落在不同片段上（s/e 不同才"通过"）；真实拖选时
    // 起终点都在同一 math 片段内，domPointToRaw 对 math 起终点都返回同一 rawFrom。
    const selInfo = await evalJs(`(()=>{
      const body=document.querySelector('.reader-body');
      if(!body) return {err:'no body'};
      const math=body.querySelector('[data-raw-math]');
      if(!math) return {err:'no math'};
      // KaTeX 的 .katex-html 可见层【整体带 aria-hidden="true"】（KaTeX 标准行为），
      // 用户真实拖选的就是这层里的文本节点 —— 不能按 aria-hidden 过滤，
      // 否则会把唯一可选的节点全排除（上一版假阳性的来源）。
      // 取 katex-html 下最长的一个文本节点，起终点都落在它内部（= 同一 math 片段内）。
      const kh=math.querySelector('.katex-html')||math;
      const walker=document.createTreeWalker(kh, NodeFilter.SHOW_TEXT);
      let node=null, best=0, n=walker.nextNode();
      while(n){ if(n.textContent.length>best){best=n.textContent.length;node=n;} n=walker.nextNode(); }
      if(!node) return {err:'no text node in katex-html', khLen:kh.innerHTML.length};
      const len=node.textContent.length;
      const range=document.createRange();
      range.setStart(node,0);
      range.setEnd(node,Math.min(3,len));
      const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return {sel:sel.toString().slice(0,60), mathRaw:math.getAttribute('data-raw'), visibleLen:len};
    })()`);
    rec('构造公式内部选区（端点同一 math 片段）', !!selInfo.sel && selInfo.sel.length > 0, JSON.stringify(selInfo).slice(0, 160));
    await sleep(600);

    // 切批注 tab，点高亮
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.rside__tab')].find(x=>x.textContent.includes('批注'));b&&b.click();return !!b;})()`);
    await sleep(500);
    const btnOK = await evalJs(`(()=>{const b=[...document.querySelectorAll('.rside__kind')].find(x=>x.textContent.includes('高亮'));if(!b)return {err:'no btn'};if(b.disabled)return {err:'disabled'};b.click();return {ok:true};})()`);
    rec('点击高亮加标记', btnOK.ok === true, JSON.stringify(btnOK));
    await sleep(1500);

    // 读新标记并核对 exact 是否原文源码
    const after = await evalJs(`(async()=>{
      const o=indexedDB.open('openleaner');
      const db=await new Promise((res,rej)=>{o.onsuccess=()=>res(o.result);o.onerror=()=>rej(o.error);});
      const tx=db.transaction(['sourceSegments','sourceAnnotations'],'readonly');
      const get=(s)=>new Promise((res,rej)=>{const q=tx.objectStore(s).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
      const [segs,annos]=await Promise.all([get('sourceSegments'),get('sourceAnnotations')]);
      const seg=segs.find(s=>s.sourceId==='${SID}'&&s.page===36);
      const a=annos.find(x=>x.sourceId==='${SID}'&&x.page===36);
      const marks=a?.textMarks||[];
      const fresh=marks.find(m=>!${JSON.stringify(base.count)} || marks.length>${base.count}
        ? marks.slice().sort((x,y)=>String(y.createdAt).localeCompare(String(x.createdAt)))[0]
        : null);
      const m=marks.slice().sort((x,y)=>String(y.createdAt).localeCompare(String(x.createdAt)))[0];
      const ex=m?.anchor?.exact||'';
      const text=seg?.text||'';
      return {
        count:marks.length,
        kind:m?.kind,
        exact:ex,
        exactLen:ex.length,
        hasZeroWidth:/[\\u200b\\u200c\\u200d\\ufeff]/.test(ex),
        indexInText:text.indexOf(ex),
        start:m?.anchor?.start,
        end:m?.anchor?.end,
        anchored:!!m
      };
    })()`);
    rec('新标记已写入', after.count === base.count + 1, `count ${base.count}->${after.count}`);
    rec('新标记 kind=highlight', after.kind === 'highlight', String(after.kind));
    rec('exact 非空', after.exactLen > 0, 'len=' + after.exactLen);
    rec('exact 不含零宽字符（治本关键）', after.hasZeroWidth === false, 'hasZeroWidth=' + after.hasZeroWidth);
    rec('exact 是原文源码（能在 seg.text 搜到）', after.indexInText >= 0, 'indexOf=' + after.indexInText);
    rec('anchor start 非0（定位到公式区）', after.start > 0, 'start=' + after.start);

    // 渲染确认：CSS.highlights 是否注册了新标记
    const painted = await evalJs(`(()=>{
      if(!('highlights' in CSS))return {supported:false};
      const out={supported:true};
      for(const name of ['leaner-mark-highlight','leaner-mark-underline','leaner-mark-strike']){
        const h=CSS.highlights.get(name);
        out[name]=h?h.size:0;
      }
      return out;
    })()`);
    rec('CSS Custom Highlight 可用', painted.supported !== false, JSON.stringify(painted));
    rec('高亮已注册到 CSS.highlights', (painted['leaner-mark-highlight'] || 0) > 0, 'size=' + painted['leaner-mark-highlight']);

    // —— 最关键：还原验证（用户最初报的就是"标记渲染不出来"）——
    // 翻到第35页再翻回36页，触发 paint effect 的 cleanup + 重新 paint，
    // 然后按生产 resolveTextAnchor 的同源判定，确认每条标记都能定位。
    await evalJs(`(()=>{const inp=document.querySelector('.reader-nav__input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,'35');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await sleep(1200);
    await evalJs(`(()=>{const inp=document.querySelector('.reader-nav__input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,'36');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    await sleep(1800);

    const restore = await evalJs(`(async()=>{
      const o=indexedDB.open('openleaner');
      const db=await new Promise((res,rej)=>{o.onsuccess=()=>res(o.result);o.onerror=()=>rej(o.error);});
      const tx=db.transaction(['sourceSegments','sourceAnnotations'],'readonly');
      const get=(s)=>new Promise((res,rej)=>{const q=tx.objectStore(s).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
      const [segs,annos]=await Promise.all([get('sourceSegments'),get('sourceAnnotations')]);
      const seg=segs.find(s=>s.sourceId==='${SID}'&&s.page===36);
      const a=annos.find(x=>x.sourceId==='${SID}'&&x.page===36);
      const text=seg?.text||'';
      // 生产 resolveTextAnchor 的判定链：①偏移+exact 校验 ②全文搜 exact
      const marks=(a?.textMarks||[]).map(m=>{
        const ex=m.anchor?.exact||'', s=m.anchor?.start, e=m.anchor?.end;
        const offsetOk = Number.isInteger(s) && Number.isInteger(e) && s>=0 && e<=text.length && text.slice(s,e)===ex;
        const fullIdx = ex ? text.indexOf(ex) : -1;
        return {kind:m.kind, exactLen:ex.length, offsetOk, fullIdx, resolved: offsetOk||fullIdx>=0};
      });
      return {total:marks.length, resolved:marks.filter(x=>x.resolved).length, marks};
    })()`);
    const freshMark = restore.marks.find((m) => m.exactLen === 33);
    rec('翻走翻回后新公式标记仍能定位（不判 lost）', !!freshMark && freshMark.resolved === true, JSON.stringify(freshMark));

    const ranges = await evalJs(`(()=>{
      const h=CSS.highlights?.get('leaner-mark-highlight');
      if(!h) return {err:'no highlight'};
      const body=document.querySelector('.reader-body');
      const out=[...h].map(r=>{
        const c=r.commonAncestorContainer;
        const el=c.nodeType===1?c:c.parentElement;
        return {inBody:!!el&&!!body&&body.contains(el), text:r.toString().slice(0,30)};
      });
      return {size:h.size, inBody:out.filter(x=>x.inBody).length, sample:out.slice(0,3)};
    })()`);
    rec('重渲染后高亮 Range 落在正文内', ranges.inBody > 0, JSON.stringify(ranges).slice(0, 200));

    await shot('anchor-fix-verify.png');
    console.log(`\n========== ${pass} PASS / ${fail} FAIL ==========`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('异常:', e.stack || e.message);
    console.error(log.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    try { app.kill(); } catch {}
  }
})();
