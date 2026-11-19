/**
 * 端到端验证「针对错误讲一遍」（2026-11-19）。
 *
 * ## 验什么（按真实操作路径）
 *
 * 1. 在做题页答错一道题 → 解析区出现「没懂？针对这个错误讲一遍」面板
 * 2. 点「讲故事」→ 走真实链路（界面 → service → 主进程代理 → 假模型）
 * 3. **发给模型的请求体里必须含：用户选错的选项、那个选项的 why、正确答案**
 *    —— 这是这个功能的价值所在，只给题干就等于重讲一遍整题
 * 4. 讲解渲染到界面上
 * 5. **讲解落进了 questions.explainNotes**（不只存在于组件 state）
 * 6. 关掉重进这道题，讲解还在（证明是落库不是内存）
 *
 * ## 为什么用本地假模型
 *
 * 真调云端要花钱且内容不可预期；这里要验的是**链路与提示词内容**，
 * 假模型能收到请求就能断言。loopback http 是 checkProxyTarget 允许的，
 * 走的是与真实模型完全相同的代码路径。
 *
 * ## 隔离
 *
 * 用隔离副本（硬约束 12），跑完检查 app 目录旁没有 openleaner-data。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createFakeModel } = require('./fake-model-server.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/verify-fakeswitch-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/explain');
const PORT = Number(process.argv[2] || 9824);
const MODEL_PORT = Number(process.argv[3] || 9912);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const stray = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
  if (fs.existsSync(stray)) fs.rmSync(stray, { recursive: true, force: true });

  /*
   * 假模型：既要能回「讲解」，也要能回「出题」。
   * 这里按 system 提示词的特征分流 —— 讲解的 system 里有「针对学生这一次的具体错误」。
   */
  const http = require('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ url: req.url, body: parsed, raw: body });

      if (req.url && req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }

      const msgs = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';
      const isExplain = system.includes('针对学生这一次的具体错误');

      let content;
      if (isExplain) {
        content = JSON.stringify({
          crux: '你把「有限」记成了「无限」',
          body: '第一段：线性表的定义里「有限」是关键约束。\n\n第二段：无限序列属于另一种结构，不能叫线性表。',
          nextStep: '回去看一眼定义的第一个词',
        });
      } else {
        const ids = [...user.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
        const countMatch = /出\s*(\d+)\s*道题/.exec(user);
        const want = countMatch ? Math.min(Number(countMatch[1]), 6) : 1;
        const qs = [];
        for (let i = 0; i < want && ids.length > 0; i++) {
          qs.push({
            knowledgePointId: ids[i % ids.length],
            kind: 'single',
            prompt: `假模型第 ${i + 1} 题：线性表的定义是？`,
            options: [
              { key: 'A', text: '有限序列', why: '符合定义：n 个元素的有限序列' },
              { key: 'B', text: '无限序列', why: '把「有限」记成了「无限」，常见误解' },
              { key: 'C', text: '树结构', why: '混淆了线性与树形结构' },
              { key: 'D', text: '图结构', why: '图可以有环' },
            ],
            answer: 'A',
            explanation: '线性表是由 n 个数据元素构成的有限序列。',
          });
        }
        content = JSON.stringify({ questions: qs });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }));
    });
  });
  await new Promise((r) => server.listen(MODEL_PORT, '127.0.0.1', r));
  console.log(`  假模型 127.0.0.1:${MODEL_PORT}`);

  const app = spawn(EXE, [
    ROOT, `--user-data-dir=${DATA}`, '--no-sandbox',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1000',
  ], { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-2000)); process.exit(2); }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = id++; pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 120000);
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (n) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
    };

    await send('Runtime.enable'); await send('Page.enable');
    await SLEEP(5000);

    /* ---------- 种子：知识点 + 资料 + 后端 + 凭据 ---------- */
    const seeded = await evalJs(`(async()=>{
      const db = await new Promise((res,rej)=>{const r=indexedDB.open('openleaner');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const ts = new Date().toISOString();
      const put = (store, rows) => new Promise((res,rej)=>{
        const tx=db.transaction(store,'readwrite'); const st=tx.objectStore(store);
        rows.forEach(r=>st.put(r)); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
      });
      const clear = (store) => new Promise((res)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).clear();tx.oncomplete=res;tx.onerror=res});
      for (const st of ['knowledgePoints','sources','sourceSegments','backends','secrets','questions','decks','reviewRecords','reviewLogs','answerRecords','generationRuns']) await clear(st);

      await put('knowledgePoints', [{
        id:'kp_x', statement:'线性表是 n 个数据元素的有限序列',
        chapter:'第一章 线性表', cognitiveLevel:'remember', tags:[],
        anchors:[{sourceId:'src_x', page:1, charStart:0, charEnd:20, segmentId:'seg_x'}],
        quotes:['线性表是由 n 个数据元素构成的有限序列。'],
        anchorStatus:'located', origin:'material', sourceId:'src_x', backendId:'be_x',
        createdAt:ts, updatedAt:ts,
      }]);
      await put('sources', [{ id:'src_x', title:'测试资料', kind:'text', pageCount:1, textStatus:'ready', createdAt:ts, updatedAt:ts, segmentCount:1, readProgress:null }]);
      await put('sourceSegments', [{ id:'seg_x', sourceId:'src_x', index:1, page:1, chapter:'第一章 线性表',
        text:'线性表是由 n 个数据元素构成的有限序列，n 称为表长。这一段足够长用来出题。', charCount:40 }]);
      await put('backends', [{ id:'be_x', label:'本地假模型', kind:'direct-api', provider:'custom',
        baseUrl:'http://127.0.0.1:${MODEL_PORT}', model:'fake-model',
        capabilities:{ textOrganize:true, visionFormula:false },
        status:'ready', isDefault:true, createdAt:ts, updatedAt:ts }]);
      await put('secrets', [{ id:'sec_x', backendId:'be_x', value:'sk-fake', createdAt:ts, updatedAt:ts }]);
      db.close();
      return { ok:true };
    })()`);
    rec('种子数据写入（知识库/资料/后端/凭据）', !!(seeded && seeded.ok));

    await evalJs(`location.reload()`);
    await SLEEP(6000);

    /* ---------- 出题（走真实界面） ---------- */
    const clickNav = async (label) => evalJs(`(()=>{
      const el=[...document.querySelectorAll('.nav-item__label,.nav-item')]
        .find(e=>e.textContent.trim().includes(${JSON.stringify(label)}));
      if(el){el.click();return true}return false})()`);
    for (let i = 0; i < 3; i++) {
      await evalJs(`(()=>{let n=0;for(const lb of document.querySelectorAll('.nav-group__label')){
        const b=lb.closest('button'), g=lb.closest('.nav-group');
        if(b&&g&&g.getAttribute('aria-expanded')!=='true'){b.click();n++}}return n})()`);
      await SLEEP(500);
    }

    await clickNav('我的题组');
    await SLEEP(2200);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建题组'));el&&el.click();return !!el})()`);
    await SLEEP(1500);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('知识库知识点'));el&&el.click();return !!el})()`);
    await SLEEP(1200);

    requests.length = 0;
    await evalJs(`(()=>{const c=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=c.find(b=>/生成并检查题组/.test(b.textContent)); if(el){el.click();return true}return false})()`);
    await SLEEP(9000);
    rec('出题请求已发出', requests.length > 0, `count=${requests.length}`);

    /* 发布题组 */
    const pub = await evalJs(`(async()=>{
      const db = await new Promise((res,rej)=>{const r=indexedDB.open('openleaner');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const decks = await new Promise((res)=>{const tx=db.transaction('decks');const rq=tx.objectStore('decks').getAll();rq.onsuccess=()=>res(rq.result)});
      for(const d of decks.filter(x=>x.status!=='published')){
        d.status='published'; d.publishedAt=new Date().toISOString();
        await new Promise((res)=>{const tx=db.transaction('decks','readwrite');tx.objectStore('decks').put(d);tx.oncomplete=res;tx.onerror=res});
      }
      const qs = await new Promise((res)=>{const tx=db.transaction('questions');const rq=tx.objectStore('questions').getAll();rq.onsuccess=()=>res(rq.result)});
      db.close();
      return { decks: decks.length, questions: qs.length, firstQ: qs[0]?.id ?? null };
    })()`);
    console.log('  发布结果 =', JSON.stringify(pub));
    rec('题组已发布且有题', pub && pub.questions > 0);

    await evalJs(`location.reload()`);
    await SLEEP(6000);

    /* ---------- 进做题页答错 ---------- */
    await clickNav('开始学习');
    await SLEEP(1800);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('开始做题'));el&&el.click();return !!el})()`);
    await SLEEP(2000);
    await evalJs(`(()=>{const c=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=c.find(b=>/^自由练习$/.test(b.textContent.trim()));el&&el.click();return !!el})()`);
    await SLEEP(2200);
    await evalJs(`(()=>{const c=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=c.find(b=>/^做这组$/.test(b.textContent.trim()));el&&el.click();return !!el})()`);
    await SLEEP(3200);

    /* 选 B（错），提交 */
    const picked = await evalJs(`(()=>{const o=[...document.querySelectorAll('.option')];
      const w=o.find(x=>x.textContent.includes('无限序列'))||o[1]; if(w){w.click();return w.textContent.trim().slice(0,20)}return null})()`);
    rec('选中错误选项 B', !!picked, String(picked));
    await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('提交答案'));b&&b.click();return !!b})()`);
    await SLEEP(1800);

    /* ---------- 面板是否出现 ---------- */
    const panel = await evalJs(`(()=>{
      const p=document.querySelector('.explain-panel');
      return { exists: !!p, title: p?.querySelector('.explain-panel__title')?.textContent ?? null,
               styles: [...document.querySelectorAll('.explain-panel__style')].map(b=>b.textContent.trim()) };
    })()`);
    rec('答错后出现「针对这个错误讲一遍」面板', panel.exists === true, JSON.stringify(panel).slice(0, 160));
    rec('面板有 5 种讲解方式', Array.isArray(panel.styles) && panel.styles.length === 5, JSON.stringify(panel.styles));
    await shot('01-panel.png');

    /* ---------- 点「讲故事」 ---------- */
    requests.length = 0;
    const clicked = await evalJs(`(()=>{
      const b=[...document.querySelectorAll('.explain-panel__style')].find(x=>x.textContent.trim()==='讲故事');
      if(b){b.click();return true}return false})()`);
    rec('点了「讲故事」', clicked === true);
    await SLEEP(9000);

    /* ---------- 关键断言：请求体里有没有"他错在哪" ---------- */
    const explainReq = requests.find((r) => {
      const sys = (r.body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
      return sys.includes('针对学生这一次的具体错误');
    });
    rec('讲解请求已发出', !!explainReq, `requests=${requests.length}`);
    const userPrompt = (explainReq?.body?.messages ?? []).find((m) => m.role === 'user')?.content ?? '';
    console.log('  发给模型的提示词片段：\n' + userPrompt.slice(0, 700).split('\n').map((l) => '    ' + l).join('\n'));

    rec('**请求体标明用户选了 B**', /他选了\s*B/.test(userPrompt), '');
    rec('**请求体含那个错误选项的 why**', userPrompt.includes('把「有限」记成了「无限」'), '');
    rec('**请求体标明正确答案是 A**', /正确答案是\s*A/.test(userPrompt), '');
    rec('请求体含题干与解析（有上下文才讲得准）',
      userPrompt.includes('线性表的定义') || userPrompt.includes('有限序列'), '');
    rec('讲解策略生效（讲故事的那句在 system 里）', (() => {
      const sys = (explainReq?.body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
      return sys.includes('故事') || sys.includes('类比');
    })(), '');

    /* ---------- 界面是否渲染出讲解 ---------- */
    const shown = await evalJs(`(()=>{
      const notes=[...document.querySelectorAll('.explain-note')];
      return { count: notes.length,
        crux: notes[0]?.querySelector('.explain-note__crux')?.textContent ?? null,
        body: notes[0]?.querySelector('.explain-note__body')?.innerText?.slice(0,120) ?? null,
        style: notes[0]?.querySelector('.explain-note__style')?.textContent ?? null,
        next: notes[0]?.querySelector('.explain-note__next')?.textContent ?? null };
    })()`);
    console.log('  渲染结果 =', JSON.stringify(shown));
    rec('讲解渲染到界面（.explain-note）', shown.count >= 1, `count=${shown.count}`);
    rec('显示出「错在哪」那句话', (shown.crux ?? '').includes('有限'), String(shown.crux));
    rec('正文分段渲染', (shown.body ?? '').includes('有限'), '');
    rec('标注了讲解方式', (shown.style ?? '') === '讲故事', String(shown.style));
    await shot('02-explained.png');

    /* ---------- 落库验证（关键：不是只在内存里） ---------- */
    const stored = await evalJs(`(async()=>{
      const db = await new Promise((res,rej)=>{const r=indexedDB.open('openleaner');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const qs = await new Promise((res)=>{const tx=db.transaction('questions');const rq=tx.objectStore('questions').getAll();rq.onsuccess=()=>res(rq.result)});
      db.close();
      const withNotes = qs.filter(q=>Array.isArray(q.explainNotes)&&q.explainNotes.length>0);
      return { total: qs.length, withNotes: withNotes.length, sample: withNotes[0]?.explainNotes?.[0] ?? null };
    })()`);
    console.log('  落库结果 =', JSON.stringify(stored).slice(0, 400));
    rec('**讲解落进了 questions.explainNotes**', stored.withNotes >= 1, `withNotes=${stored.withNotes}`);
    rec('落库内容含 given / styleId / body',
      !!(stored.sample && stored.sample.given === 'B' && stored.sample.styleId === 'story' && stored.sample.body),
      JSON.stringify(stored.sample).slice(0, 160));

    /* ---------- ②③ 分类 / 不重复 / 收起（2026-11-19 第二轮） ---------- */
    /*
     * 再点一次不同讲法，然后检查：
     *  - 屏幕上只渲染**一条**（不是把全部铺开）
     *  - 出现按讲法分类的页签
     *  - 同一条内容不重复出现
     */
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.explain-panel__style')].find(x=>x.textContent.trim()==='对比着讲');if(b){b.click();return true}return false})()`); 
    await SLEEP(9000);

    const layout = await evalJs(`(()=>{
      const notes=[...document.querySelectorAll('.explain-note')];
      const tabs=[...document.querySelectorAll('.explain-tab')].map(t=>t.textContent.trim());
      return {
        renderedNotes: notes.length,
        tabs,
        bodies: notes.map(n=>n.querySelector('.explain-note__body')?.innerText?.trim().slice(0,40) ?? ''),
        hasCollapse: !!document.querySelector('.explain-panel__collapse'),
        hasCount: !!document.querySelector('.explain-panel__count'),
      };
    })()`);
    console.log('  布局 =', JSON.stringify(layout));

    rec('**只渲染一条讲解**（不再全铺开）', layout.renderedNotes === 1, 'count=' + layout.renderedNotes);
    rec('**出现按讲法分类的页签**', Array.isArray(layout.tabs) && layout.tabs.length >= 2, JSON.stringify(layout.tabs));
    rec('**正文不重复**（同一段内容只出现一次）',
      new Set(layout.bodies).size === layout.bodies.length, JSON.stringify(layout.bodies));
    rec('有「收起」按钮', layout.hasCollapse === true);
    rec('标题带条数徽标', layout.hasCount === true);
    await shot('04-grouped.png');

    /* 点另一个页签，看内容是否切换 */
    const switched = await evalJs(`(()=>{
      const tabs=[...document.querySelectorAll('.explain-tab')];
      const other=tabs.find(t=>t.getAttribute('aria-selected')!=='true');
      if(other){other.click();return other.textContent.trim()}
      return null})()`);
    await SLEEP(1200);
    const afterSwitch = await evalJs(`(()=>({
      rendered: document.querySelectorAll('.explain-note').length,
      style: document.querySelector('.explain-note__style')?.textContent?.trim() ?? null,
    }))()`);
    rec('**切页签只换内容、仍只渲染一条**',
      afterSwitch.rendered === 1, JSON.stringify({ switched, ...afterSwitch }));

    /* 收起 */
    const collapsed = await evalJs(`(()=>{
      const b=document.querySelector('.explain-panel__collapse');
      if(b){b.click();return true}return false})()`);
    await SLEEP(800);
    const collapsedState = await evalJs(`(()=>({
      panelGone: !document.querySelector('.explain-panel'),
      entry: document.querySelector('.explain-panel__collapsed')?.innerText?.trim() ?? null,
    }))()`);
    rec('**点「收起」后变成一行入口**',
      collapsed === true && collapsedState.panelGone === true, JSON.stringify(collapsedState));
    await shot('05-collapsed.png');

    /* 再展开 */
    const reopened = await evalJs(`(()=>{
      const b=document.querySelector('.explain-panel__collapsed');
      if(b){b.click();return true}return false})()`);
    await SLEEP(800);
    const reopenedState = await evalJs(`(()=>document.querySelectorAll('.explain-note').length)()`);
    rec('能再展开', reopened === true && reopenedState === 1, 'notes=' + reopenedState);

    /* ---------- 重新进入，讲解还在（证明是持久化） ---------- */
    await evalJs(`location.reload()`);
    await SLEEP(6000);
    await clickNav('开始学习');
    await SLEEP(1800);
    await evalJs(`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('开始做题'));el&&el.click();return !!el})()`);
    await SLEEP(2000);
    await evalJs(`(()=>{const c=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=c.find(b=>/^自由练习$/.test(b.textContent.trim()));el&&el.click();return !!el})()`);
    await SLEEP(2200);
    await evalJs(`(()=>{const c=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=c.find(b=>/^做这组$/.test(b.textContent.trim()));el&&el.click();return !!el})()`);
    await SLEEP(3200);
    await evalJs(`(()=>{const o=[...document.querySelectorAll('.option')];
      const w=o.find(x=>x.textContent.includes('无限序列'))||o[1]; if(w)w.click(); return !!w})()`);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('提交答案'));b&&b.click();return !!b})()`);
    await SLEEP(2000);

    const afterReload = await evalJs(`document.querySelectorAll('.explain-note').length`);
    rec('**重进这道题，讲解还在（持久化生效）**', afterReload >= 1, `count=${afterReload}`);
    await shot('03-after-reload.png');

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2500));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await new Promise((r) => server.close(r));
    await SLEEP(1500);
    const strayAfter = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
    console.log(fs.existsSync(strayAfter)
      ? '⚠️ app 目录旁出现 openleaner-data（隔离失效）'
      : '✅ 隔离生效');
  }
})();