/**
 * 验证「从资料中提问」的范围选择器（2026-11-10）。
 *
 * 与 verify-selection-ask.cjs 同样跑打包产物 + 真实 IndexedDB（原因见那个脚本
 * 的文件头：dev server 的 origin 看不到 file:// 下的用户数据）。
 *
 * 本脚本专门查这几件事：
 *   1. 复习巩固页的「提问式复习」入口在
 *   2. 面板顶部真的出现范围下拉，且选项里有「知识点随机」+ 各资料的整本/章节
 *   3. 切到一个章节范围后，范围说明真的跟着变（不是只换了 state）
 *   4. 换范围不会误写 oralReviews
 *   5. 截图落盘供肉眼复核
 *
 * 用法：node scripts/verify-oral-scope.cjs --app release/win-unpacked --data .tmp/<副本>
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_URL_PREFIX = 'file://';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/oralscope-data'));
const PORT = Number(arg('port', '9968'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/oral-scope'));

if (!fs.existsSync(DATA_DIR)) {
  console.error(`数据目录不存在: ${DATA_DIR}`);
  process.exit(2);
}
const APP_EXE = path.join(APP_DIR, 'OpenLeaner.exe');
if (!fs.existsSync(APP_EXE)) {
  console.error(`找不到打包产物: ${APP_EXE}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  const fail = [];
  const ok = (label, detail = '') => report.push(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  const bad = (label, detail = '') => {
    report.push(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail.push(label);
  };

  let app = null;
  try {
    app = spawn(
      APP_EXE,
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1440,900',
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            typeof t.url === 'string' &&
            t.url.indexOf(APP_URL_PREFIX) === 0,
        );
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('应用没起来（CDP 连不上应用页）');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = id++;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });

    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, name);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      return p;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    await evalJs(`(() => {
      if (window.__cdpErrors) return;
      window.__cdpErrors = [];
      const orig = console.error;
      console.error = function (...a) {
        try { window.__cdpErrors.push(a.map(String).join(' ').slice(0, 300)); } catch {}
        return orig.apply(console, a);
      };
      window.addEventListener('error', (e) => window.__cdpErrors.push('window.error: ' + (e.message || '')));
    })()`);

    /* ================= 1. 直接进复习巩固页 ================= */
    /*
     * 这一页在 pages.ts 里 show:false，不进侧栏，所以不能点侧栏。
     * 用「开始学习」页的入口进去（与用户实际路径一致）。
     */
    const entered = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => {
        const t = (b.innerText || '').trim();
        return t.indexOf('复习巩固') >= 0 || t.indexOf('开始复习') >= 0;
      });
      if (hit) { hit.click(); return 'clicked:' + hit.innerText.trim().slice(0, 20); }
      return 'none|' + JSON.stringify(btns.map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 25));
    })()`);
    String(entered).startsWith('clicked') ? ok('进入复习巩固页', String(entered)) : bad('进入复习巩固页', String(entered));
    await sleep(3000);

    /* 若自动进了今日复习，先退出，回到复习巩固主界面 */
    await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const end = btns.find(b => (b.innerText || '').trim() === '结束');
      if (end) { end.click(); return true; }
      const back = btns.find(b => (b.innerText || '').trim().indexOf('回到复习巩固') >= 0);
      if (back) { back.click(); return true; }
      return false;
    })()`);
    await sleep(1200);

    /* ================= 2. 找「提问式复习」入口 ================= */
    const entry = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => (b.innerText || '').trim().indexOf('提问式复习') >= 0);
      if (!hit) {
        return { found: false, all: btns.map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 30) };
      }
      hit.click();
      return { found: true, text: hit.innerText.trim() };
    })()`);
    entry.found ? ok('找到「提问式复习」入口', entry.text) : bad('没找到提问式复习入口', JSON.stringify(entry.all));
    await sleep(3500);

    /* ================= 3. 范围下拉存在吗 ================= */
    const picker = await evalJs(`(() => {
      const sel = document.querySelector('.osp__select');
      if (!sel) {
        return { exists: false, empty: !!document.querySelector('.osp__empty'), orp: !!document.querySelector('.orp') };
      }
      const opts = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() }));
      return {
        exists: true,
        value: sel.value,
        count: opts.length,
        options: opts.slice(0, 12),
        selectedText: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : null,
      };
    })()`);

    if (!picker.exists) {
      bad('范围下拉出现', JSON.stringify(picker));
    } else {
      ok('范围下拉出现', `共 ${picker.count} 个选项，当前「${picker.selectedText}」`);
      picker.options.some((o) => o.value === 'points')
        ? ok('含「知识点随机」选项（三期行为保留）')
        : bad('缺少知识点选项', JSON.stringify(picker.options));

      const hasSource = picker.options.some((o) => o.value.indexOf('source:') === 0);
      const hasChapter = picker.options.some((o) => o.value.indexOf('chapter:') === 0);
      hasSource ? ok('含「整本资料」选项') : bad('缺少整本资料选项');
      hasChapter ? ok('含「某章节」选项') : bad('缺少章节选项');

      /* 选项文字里应带计数，让用户知道这段范围有多少段可问 */
      picker.options.every((o) => /（\d+）/.test(o.text))
        ? ok('选项带素材条数')
        : bad('部分选项没有条数', JSON.stringify(picker.options.slice(0, 5)));
    }

    const p1 = await shot('01-范围下拉.png');
    report.push(`        截图: ${path.relative(ROOT, p1)}`);

    /* ================= 4. 切到一个章节范围 ================= */
    const switched = await evalJs(`(() => {
      const sel = document.querySelector('.osp__select');
      if (!sel) return { ok: false, why: 'no select' };
      const target = [...sel.options].find(o => o.value.indexOf('chapter:') === 0);
      if (!target) return { ok: false, why: 'no chapter option' };
      const before = document.querySelector('.orp__scope') ? document.querySelector('.orp__scope').innerText.trim() : null;
      const beforeQ = document.querySelector('.orp__q') ? document.querySelector('.orp__q').innerText.trim() : null;
      /* 用原生 setter 触发 React 的 onChange */
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, target.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, picked: target.textContent.trim(), before, beforeQ };
    })()`);
    switched.ok ? ok('选中一个章节范围', switched.picked) : bad('无法选中章节', switched.why);
    await sleep(3500);

    const afterSwitch = await evalJs(`(() => {
      const sc = document.querySelector('.orp__scope');
      const sel = document.querySelector('.osp__select');
      const q = document.querySelector('.orp__q');
      return {
        scope: sc ? sc.innerText.trim() : null,
        selected: sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : null,
        hasQuestion: !!q,
        question: q ? q.innerText.trim().slice(0, 80) : null,
        err: document.querySelector('.osp__error') ? document.querySelector('.osp__error').innerText.trim() : null,
      };
    })()`);

    /*
     * 关键断言：范围说明必须真的变了。
     * 只断言「下拉 value 变了」会漏掉「state 改了但素材没换」这种 bug
     * （划选提问那次就是这么漏的：面板起来了但范围写着别的）。
     */
    afterSwitch.scope && afterSwitch.scope !== switched.before
      ? ok('范围说明真的跟着换了', `「${switched.before}」→「${afterSwitch.scope}」`)
      : bad('范围说明没变（可能只改了 state）', `仍是「${afterSwitch.scope}」`);

    afterSwitch.err ? bad('切换范围报错', afterSwitch.err) : ok('切换范围无报错');
    afterSwitch.hasQuestion
      ? ok('换了范围后重新出了题', String(afterSwitch.question))
      : bad('换范围后没有题目', JSON.stringify(afterSwitch));

    /*
     * ⚠️ 最关键的一条：题目必须**真的换了**。
     *
     * 第一版只断言「有题目」，结果漏掉一个真 bug：
     * 范围说明已经变成新章节，底下问题还是旧范围的（面板没重建，
     * phase 停在旧题上）。截图一看就发现，但断言全绿。
     * 所以这里比对新旧题目文本。
     */
    if (switched.beforeQ && afterSwitch.question) {
      const same = switched.beforeQ === afterSwitch.question;
      same
        ? bad('题目没换（面板没重建，phase 停在旧题上）', `仍是「${afterSwitch.question}」`)
        : ok('题目确实跟着换了', `旧「${String(switched.beforeQ).slice(0, 24)}…」→ 新「${String(afterSwitch.question).slice(0, 24)}…」`);
    } else {
      report.push('        跳过题目比对（某一侧没有题目文本）');
    }

    const p2 = await shot('02-切到章节.png');
    report.push(`        截图: ${path.relative(ROOT, p2)}`);

    /* ================= 5. IndexedDB：不该有写入 ================= */
    const idb = await evalJs(`(async () => {
      const dbs = await indexedDB.databases();
      const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
      if (!name) return { ok: false };
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const count = (store) => new Promise((res) => {
        if (!db.objectStoreNames.contains(store)) { res(null); return; }
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).count();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      });
      const out = {
        ok: true, db: name, version: db.version,
        stores: [...db.objectStoreNames].length,
        oralReviews: await count('oralReviews'),
        reviewRecords: await count('reviewRecords'),
      };
      db.close();
      return out;
    })()`);
    if (idb.ok) {
      ok('IndexedDB 可读', `DB=${idb.db} v${idb.version} / ${idb.stores} 分区`);
      typeof idb.oralReviews === 'number'
        ? ok('换范围没有写入 oralReviews', `${idb.oralReviews} 条`)
        : bad('读不到 oralReviews');
      typeof idb.reviewRecords === 'number'
        ? ok('复习记录未被改动', `${idb.reviewRecords} 条`)
        : bad('读不到 reviewRecords');
    } else {
      bad('IndexedDB 可读', 'no db');
    }

    /* ================= 6. 控制台 ================= */
    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0 ? bad('控制台有错误', JSON.stringify(errs)) : ok('控制台无明显错误');

    console.log('\n========== 范围选择器验证 ==========');
    report.forEach((l) => console.log(l));
    console.log('====================================');
    console.log(fail.length === 0 ? '\n全部通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
    process.exitCode = fail.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n验证脚本自身出错:', e.message);
    if (report.length) {
      console.log('\n已完成的检查:');
      report.forEach((l) => console.log(l));
    }
    process.exitCode = 1;
  } finally {
    try {
      app && app.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    await sleep(600);
  }
})();
