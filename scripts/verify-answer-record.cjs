/**
 * 验证「答疑记录」页（2026-11-19）。
 *
 * ## 要证的事
 *
 * 1. 导航里那一页叫「答疑记录」（不再是「提问复习记录」）
 * 2. **两种来源的行都在**：提问复习的问答 + 错题讲解
 * 3. 来源筛选能用，且计数与列表一致
 * 4. 讲解那几条能「回那道题」；提问那几条能「回原文」
 *
 * ## 用真实库副本
 *
 * 用户真实库里已经有 1 条提问记录和 2 条讲解（他自己用出来的）。
 * 复制过来当样本 —— 比造假数据真实，也验证了「旧数据能正常显示」。
 *
 * 全程写操作只落在副本上。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.join(ROOT, '.tmp/answerrec-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/answerrecord');
const PORT = Number(process.argv[2] || 9834);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  /* 复制真实库（只读复制，之后只写副本） */
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const realIdb = path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB');
  const dstIdb = path.join(DATA, 'IndexedDB');
  fs.cpSync(realIdb, dstIdb, { recursive: true });
  console.log('  已复制真实库副本');

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
    await SLEEP(6000);

    /* ---------- 1. 导航名 ---------- */
    for (let i = 0; i < 3; i++) {
      await evalJs('(() => { let n = 0; for (const lb of document.querySelectorAll(".nav-group__label")) { const b = lb.closest("button"); const g = lb.closest(".nav-group"); if (b && g && g.getAttribute("aria-expanded") !== "true") { b.click(); n++; } } return n; })()');
      await SLEEP(500);
    }
    const navLabels = await evalJs('(() => [...document.querySelectorAll(".nav-item__label,.nav-item")].map((e) => e.textContent.trim()))()');
    rec('导航里有「答疑记录」', navLabels.some((t) => t.includes('答疑记录')), JSON.stringify(navLabels.filter((t) => t.includes('答疑') || t.includes('提问'))));
    rec('旧的「提问复习记录」已不在导航里', !navLabels.some((t) => t.includes('提问复习记录')));

    /*
     * 副本里 oralReviews 是 0 条 —— 用户真实库还没用过提问式复习。
     * 「两种来源都在」这条断言在他的数据上无法成立，所以补一条合成的
     * 提问记录（**只写副本**），把合并逻辑验掉。
     */
    const seededOral = await evalJs(`(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('openleaner'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const ts = new Date().toISOString();
      const rec = {
        id: 'oral_test_1', scopeLabel: '第 9 页 · 1.2 离散时间信号',
        /*
         * 必须给一个**真实存在**的 sourceId，否则「回原文」按钮不渲染
         * （组件只在有 sourceId 时给入口 —— 点了找不到资料的按钮不该存在）。
         * 第一版给了 null，于是断言说「提问没带回复原文」，其实是数据问题。
         */
        sourceId: (await new Promise((res) => {
          const tx = db.transaction('sources'); const rq = tx.objectStore('sources').getAll();
          rq.onsuccess = () => res(rq.result?.[0]?.id ?? null); rq.onerror = () => res(null);
        })),
        page: 9, quote: '离散时间信号只在离散时刻取值',
        question: '离散时间信号的定义是什么？',
        answer: '就是只在离散时刻有值的信号',
        verdict: 'memory', quotedFromSource: '只在离散时刻取值',
        quoteVerified: true, explanation: '你漏了「离散时刻」这个限定',
        correction: '离散时间信号：只在离散时刻取值的信号。',
        savedAs: 'brief', fullText: null, createdAt: ts,
      };
      await new Promise((res, rej) => { const tx = db.transaction('oralReviews', 'readwrite'); tx.objectStore('oralReviews').put(rec); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      db.close();
      return { ok: true };
    })()`);
    rec('（准备）在副本里种一条提问记录', !!(seededOral && seededOral.ok));
    await evalJs('location.reload()');
    await SLEEP(6000);
    for (let i = 0; i < 3; i++) {
      await evalJs('(() => { let n = 0; for (const lb of document.querySelectorAll(".nav-group__label")) { const b = lb.closest("button"); const g = lb.closest(".nav-group"); if (b && g && g.getAttribute("aria-expanded") !== "true") { b.click(); n++; } } return n; })()');
      await SLEEP(500);
    }

    /* ---------- 2. 打开页面 ---------- */
    const opened = await evalJs('(() => { const el = [...document.querySelectorAll(".nav-item__label,.nav-item")].find((e) => e.textContent.trim().includes("答疑记录")); if (el) { el.click(); return true; } return false; })()');
    await SLEEP(3500);
    rec('能打开答疑记录页', opened === true);

    const page = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.ansrec-item')];
      return {
        title: document.querySelector('.ansrec-title')?.textContent?.trim() ?? null,
        count: items.length,
        sources: items.map((li) => li.className.replace('ansrec-item ansrec-item--', '')),
        badges: items.map((li) => li.querySelector('.ansrec-badge')?.textContent?.trim() ?? ''),
        tabs: [...document.querySelectorAll('.ansrec-tab')].map((t) => t.textContent.trim()),
        hasBackToQuestion: items.some((li) => [...li.querySelectorAll('button')].some((b) => b.textContent.includes('回那道题'))),
        hasBackToSource: items.some((li) => [...li.querySelectorAll('button')].some((b) => b.textContent.includes('回原文'))),
        empty: !!document.querySelector('.ansrec-empty'),
      };
    })()`);
    console.log('  页面状态 =', JSON.stringify(page));

    rec('标题是「答疑记录」', page.title === '答疑记录', String(page.title));
    rec('**列表里有记录**（不是空态）', page.count > 0 && page.empty === false, 'count=' + page.count);
    rec('**两种来源都在**', page.sources.includes('oral') && page.sources.includes('wrong-explain'), JSON.stringify(page.sources));
    rec('讲解那几条带「回那道题」', page.hasBackToQuestion === true);
    rec('提问那几条带「回原文」', page.hasBackToSource === true);
    await shot('01-answer-record.png');

    /* ---------- 3. 筛选 ---------- */
    if (page.tabs.length >= 3) {
      const tabs = await evalJs('(() => [...document.querySelectorAll(".ansrec-tab")].map((t) => ({ label: t.textContent.replace(/[0-9]+$/, "").trim(), n: t.querySelector(".ansrec-tab__n")?.textContent?.trim() })))()');
      console.log('  页签 =', JSON.stringify(tabs));

      const onlyExplain = await evalJs(`(() => {
        const t = [...document.querySelectorAll('.ansrec-tab')].find((x) => x.textContent.includes('错题讲解'));
        if (t) { t.click(); return true; }
        return false;
      })()`);
      await SLEEP(900);
      const afterFilter = await evalJs(`(() => {
        const items = [...document.querySelectorAll('.ansrec-item')];
        return { count: items.length, allExplain: items.every((li) => li.className.includes('wrong-explain')) };
      })()`);
      rec('**按「错题讲解」筛选后只剩讲解**',
        onlyExplain === true && afterFilter.count > 0 && afterFilter.allExplain === true,
        JSON.stringify(afterFilter));
      await shot('02-filtered.png');

      /* 切回全部 */
      await evalJs(`(() => { const t = [...document.querySelectorAll('.ansrec-tab')].find((x) => x.textContent.includes('全部')); if (t) { t.click(); return true; } return false; })()`);
      await SLEEP(800);
      const backAll = await evalJs('(() => document.querySelectorAll(".ansrec-item").length)()');
      rec('切回「全部」恢复条数', backAll === page.count, 'count=' + backAll + ' vs ' + page.count);
    } else {
      rec('两个来源都有时出现筛选页签', false, 'tabs=' + JSON.stringify(page.tabs));
    }

    /* ---------- 4. 计数与列表一致 ---------- */
    const consistency = await evalJs(`(() => {
      const tabs = [...document.querySelectorAll('.ansrec-tab')];
      const all = tabs.find((t) => t.textContent.includes('全部'));
      const allN = Number(all?.querySelector('.ansrec-tab__n')?.textContent?.trim() ?? -1);
      const shown = document.querySelectorAll('.ansrec-item').length;
      return { allN, shown, ok: allN === shown };
    })()`);
    rec('「全部」的计数与列表条数一致', consistency.ok === true, JSON.stringify(consistency));

    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2000));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await SLEEP(1200);
  }
})();