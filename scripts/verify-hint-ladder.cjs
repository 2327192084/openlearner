/**
 * 端到端验证「提示阶梯」（2026-11-19）。
 *
 * ## 要证明的三件事
 *
 * 1. **提示面板出现在作答前**（答完就不该有了）
 * 2. **提示是逐级展开的，且每一级要求不同**
 *    —— 读真实发给模型的请求体，确认第 3 级要的是「关键条件」、
 *       并且带上「已经给过第 1、2 级，不要重复」
 * 3. **强提示后答对 → 不算真会**（最要紧的一条）
 *    —— 用到 3 级后答对，reviewLogs 里该次记录必须带 hintLevel=3
 *
 * 第 3 条是硬证据：读库里的 reviewLogs，不是读界面文字。
 *
 * ## 隔离
 *
 * 用隔离副本（.tmp + 独立 APPDATA），假模型服务回固定内容。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/hint-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/hint');
const PORT = Number(process.argv[2] || 9832);
const MODEL_PORT = Number(process.argv[3] || 9913);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/* 假模型：按 system 里的「这一级的要求」判断该回什么 */
function startFakeModel() {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ url: req.url, body: parsed });

      if (req.url && req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }

      const msgs = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';

      let content;
      if (system.includes('正在给学生**逐级**的提示')) {
        /* 按级别回不同内容 —— 让界面能看出确实是不同级 */
        let text = '提示内容';
        if (system.includes('方向性')) text = '第1级：想想「同一个函数」需要哪两个条件都相同。';
        else if (system.includes('更小的子问题')) text = '第2级：先分别算出两个函数的定义域，它们一样吗？';
        else if (system.includes('关键条件')) text = '第3级：注意定义域必须是同一个集合。';
        else if (system.includes('同构但不同')) text = '第4级：比如 f(x)=x 与 g(x)=|x|，在 x<0 时取值不同，所以不是同一个。';
        content = JSON.stringify({ text });
      } else if (system.includes('根据学习材料出练习题')) {
        const ids = [...user.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
        content = JSON.stringify({
          questions: ids.slice(0, 1).map((id) => ({
            knowledgePointId: id,
            kind: 'single',
            prompt: '下列各组函数中，表示同一个函数的是？',
            options: [
              { key: 'A', text: 'f(x)=x 与 g(x)=√(x²)', why: 'x<0 时取值不同' },
              { key: 'B', text: 'f(x)=lg x² 与 g(x)=2 lg x', why: '定义域与对应关系都相同' },
            ],
            answer: 'B',
            explanation: '定义域与对应关系都相同才叫同一个函数。',
          })),
        });
      } else {
        content = JSON.stringify({ text: '（未预期的请求）' });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }));
    });
  });
  return { server, requests };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const fake = startFakeModel();
  await new Promise((r) => fake.server.listen(MODEL_PORT, '127.0.0.1', r));
  console.log('  假模型 127.0.0.1:' + MODEL_PORT);

  const app = spawn(EXE, [
    ROOT, '--user-data-dir=' + DATA, '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--window-size=1440,1100',
  ], { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-1500)); process.exit(2); }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); }
      }, 120000);
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

    await send('Runtime.enable');
    await send('Page.enable');
    await SLEEP(5000);

    /* ---------- 种子 ---------- */
    const seedSql = [
      '(async () => {',
      '  const db = await new Promise((res, rej) => { const q = indexedDB.open("openleaner"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });',
      '  const ts = new Date().toISOString();',
      '  const put = (st, rows) => new Promise((res, rej) => { const tx = db.transaction(st, "readwrite"); const s = tx.objectStore(st); rows.forEach((r) => s.put(r)); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });',
      '  const clear = (st) => new Promise((res) => { const tx = db.transaction(st, "readwrite"); tx.objectStore(st).clear(); tx.oncomplete = res; tx.onerror = res; });',
      '  for (const st of ["questions","decks","reviewRecords","reviewLogs","knowledgePoints","sources","sourceSegments","backends","secrets","answerRecords"]) await clear(st);',
      '  await put("sources", [{ id:"src_h", title:"测试资料", kind:"text", pageCount:3, textStatus:"ready", createdAt:ts, updatedAt:ts, segmentCount:3, readProgress:null }]);',
      '  await put("sourceSegments", [1,2,3].map((p) => ({ id:"seg_h"+p, sourceId:"src_h", index:p, page:p, chapter:"第一章", text:"第"+p+"页测试正文，长度足够出题，讲函数与定义域。", charCount:40 })));',
      '  await put("knowledgePoints", [{ id:"kp_h", statement:"两个函数相同当且仅当定义域与对应关系都相同", chapter:"第一章", cognitiveLevel:"understand", tags:[], anchors:[{sourceId:"src_h",page:1,charStart:0,charEnd:10,segmentId:"seg_h1"}], quotes:["定义域与对应关系都相同。"], anchorStatus:"located", origin:"material", sourceId:"src_h", backendId:"b", createdAt:ts, updatedAt:ts }]);',
      '  await put("decks", [{ id:"deck_h", title:"测试题组", status:"published", sourceId:"src_h", backendId:"b", questionCount:1, blockingIssues:0, publishedAt:ts, createdAt:ts, updatedAt:ts }]);',
      '  await put("questions", [{ id:"q_h1", deckId:"deck_h", kind:"single", prompt:"下列各组函数中，表示同一个函数的是？", options:[{key:"A",text:"f(x)=x 与 g(x)=√(x²)",why:"x<0 时取值不同"},{key:"B",text:"f(x)=lg x² 与 g(x)=2 lg x",why:"定义域与对应关系都相同"}], answer:"B", explanation:"定义域与对应关系都相同才叫同一个函数。", anchors:[{sourceId:"src_h",page:1,charStart:0,charEnd:10,segmentId:"seg_h1"}], knowledgePointId:"kp_h", cognitiveLevel:"understand", topic:"函数", order:1, createdAt:ts, updatedAt:ts }]);',
      '  await put("backends", [{ id:"be_h", label:"本地假模型", kind:"direct-api", provider:"custom", baseUrl:"http://127.0.0.1:' + MODEL_PORT + '", model:"fake-model", capabilities:{textOrganize:true,visionFormula:false}, status:"ready", isDefault:true, createdAt:ts, updatedAt:ts }]);',
      '  await put("secrets", [{ id:"sec_h", backendId:"be_h", value:"sk-fake", createdAt:ts, updatedAt:ts }]);',
      '  db.close();',
      '  return { ok: true };',
      '})()',
    ].join('\n');
    const seeded = await evalJs(seedSql);
    rec('种子数据写入', !!(seeded && seeded.ok));

    await evalJs('location.reload()');
    await SLEEP(6000);

    /* ---------- 进做题页 ---------- */
    for (let i = 0; i < 3; i++) {
      await evalJs('(() => { let n = 0; for (const lb of document.querySelectorAll(".nav-group__label")) { const b = lb.closest("button"); const g = lb.closest(".nav-group"); if (b && g && g.getAttribute("aria-expanded") !== "true") { b.click(); n++; } } return n; })()');
      await SLEEP(500);
    }
    await evalJs('(() => { const el = [...document.querySelectorAll(".nav-item__label,.nav-item")].find((e) => e.textContent.trim().includes("开始学习")); if (el) { el.click(); return true; } return false; })()');
    await SLEEP(1800);
    await evalJs('(() => { const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("开始做题")); if (el) { el.click(); return true; } return false; })()');
    await SLEEP(2200);
    await evalJs('(() => { const c = [...document.querySelectorAll("button")].filter((b) => !b.disabled); const el = c.find((b) => /^自由练习$/.test(b.textContent.trim())); if (el) { el.click(); return true; } return false; })()');
    await SLEEP(2200);
    await evalJs('(() => { const c = [...document.querySelectorAll("button")].filter((b) => !b.disabled); const el = c.find((b) => /^做这组$/.test(b.textContent.trim())); if (el) { el.click(); return true; } return false; })()');
    await SLEEP(3200);

    /* ---------- ① 面板出现在作答前 ---------- */
    const panel = await evalJs('(() => ({ exists: !!document.querySelector(".hint-panel"), btn: document.querySelector(".hint-panel__ask")?.textContent?.trim() ?? null, revealed: !!document.querySelector(".reveal__options") }))()');
    console.log('  面板 =', JSON.stringify(panel));
    rec('① 作答前出现提示面板', panel.exists === true);
    rec('① 初始按钮是「给个方向」', panel.btn === '给个方向', String(panel.btn));
    await shot('01-before-answer.png');

    /* ---------- ② 逐级点三级 ---------- */
    fake.requests.length = 0;
    await evalJs('(() => { const b = document.querySelector(".hint-panel__ask"); if (b) { b.click(); return true; } return false; })()');
    await SLEEP(5000);
    const lv1 = await evalJs('(() => [...document.querySelectorAll(".hint-item")].map((li) => li.innerText.replace(/\\n/g, " ⏎ ")))()');
    console.log('  第 1 级 =', JSON.stringify(lv1));
    rec('② 出第 1 级提示', lv1.length === 1 && lv1[0].includes('第1级'), JSON.stringify(lv1).slice(0, 120));

    /* 连点两次到第 3 级 */
    for (let k = 0; k < 2; k++) {
      await evalJs('(() => { const b = document.querySelector(".hint-panel__ask"); if (b) { b.click(); return true; } return false; })()');
      await SLEEP(5000);
    }
    const all = await evalJs('(() => ({ items: [...document.querySelectorAll(".hint-item")].map((li) => li.innerText.replace(/\\n/g, " ⏎ ")), warnCount: document.querySelectorAll(".hint-item__warn").length }))()');
    console.log('  三级后 =', JSON.stringify(all).slice(0, 500));
    rec('② 累积到 3 条提示（不是覆盖）', all.items.length === 3, 'count=' + all.items.length);
    rec('② 第 3 级带「不算真会」警告', all.warnCount >= 1, 'warnCount=' + all.warnCount);
    await shot('02-three-hints.png');

    /* 读发给模型的请求：第 3 级的要求对不对 */
    const hintReqs = fake.requests.filter((r) => {
      const sys = (r.body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
      return sys.includes('正在给学生**逐级**的提示');
    });
    rec('② 三次提示请求都发出去了', hintReqs.length === 3, 'count=' + hintReqs.length);

    const lastUser = (hintReqs[hintReqs.length - 1]?.body?.messages ?? []).find((m) => m.role === 'user')?.content ?? '';
    rec('② 第 3 级的请求要求「点出关键条件」',
      (hintReqs[hintReqs.length - 1]?.body?.messages ?? []).find((m) => m.role === 'system')?.content?.includes('关键条件') === true);
    rec('② 第 3 级请求带上「已给过的提示，不要重复」',
      lastUser.includes('已经给过的提示') && lastUser.includes('第 1 级'), lastUser.slice(0, 150).replace(/\n/g, ' ⏎ '));

    /* ---------- ③ 答对后：hintLevel 必须落库 ---------- */
    await evalJs('(() => { const o = [...document.querySelectorAll(".option")]; const b = o.find((x) => x.textContent.includes("lg x")); if (b) { b.click(); return true; } return false; })()');
    await SLEEP(600);
    await evalJs('(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith("提交答案")); if (b) { b.click(); return true; } return false; })()');
    await SLEEP(2500);
    await shot('03-answered.png');

    /*
     * 还要点评分档 —— 这是既有设计：客观题答对后**不立即写 reviewLog**，
     * 等用户点「忘记/勉强/一般/熟练」时才写（那里才知道该给什么间隔）。
     *
     * 第一版验证漏了这一步，于是 reviewLogs 是空的，误报「没落库」。
     */
    const gradeBtns = await evalJs('(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(-12))()');
    console.log('  评分档候选 =', JSON.stringify(gradeBtns));
    const graded = await evalJs('(() => { const b = [...document.querySelectorAll("button")].find((x) => /^(熟练|一般|还行|正常回忆)/.test(x.textContent.trim())); if (b) { b.click(); return b.textContent.trim(); } return null; })()');
    console.log('  点了评分档 =', graded);
    await SLEEP(2500);

    const logsSql = [
      '(async () => {',
      '  const db = await new Promise((res, rej) => { const q = indexedDB.open("openleaner"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });',
      '  const logs = await new Promise((res) => { const tx = db.transaction("reviewLogs"); const rq = tx.objectStore("reviewLogs").getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => res([]); });',
      '  db.close();',
      '  return logs.map((l) => ({ cardId: l.cardId, grade: l.grade, hintLevel: l.hintLevel }));',
      '})()',
    ].join('\n');
    const logs = await evalJs(logsSql);
    console.log('  reviewLogs =', JSON.stringify(logs));
    const withHint = logs.find((l) => l.hintLevel === 3);
    rec('③ **用到 3 级提示后，reviewLogs 记录了 hintLevel=3**', !!withHint, JSON.stringify(logs));

    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2000));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await new Promise((r) => fake.server.close(r));
    await SLEEP(1200);
  }
})();