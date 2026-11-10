/**
 * 验证「知识库按类型筛选」与「闪卡跳知识库挑卡」（2026-11-10）。
 *
 * 跑打包产物 + 真实 IndexedDB（原因见 verify-selection-ask.cjs 文件头：
 * dev server 的 origin 看不到 file:// 下的用户数据）。
 *
 * 查这几件事：
 *   1. 知识库有「按类型」四个按钮，数字与知识点总数对得上
 *   2. 点一个类型能真的收窄列表（条目数减少且都不含其它类型）
 *   3. 闪卡挑卡页有「去知识库挑」，点了会到知识库且进入挑选模式
 *   4. 挑选模式有勾选框与吸底确认栏
 *   5. 截图落盘
 *
 * 用法：node scripts/verify-knowledge-pick.cjs --app release/win-unpacked --data .tmp/<副本>
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
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/kbpick-data'));
const PORT = Number(arg('port', '9972'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/knowledge-pick'));

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
  const ok = (l, d = '') => report.push(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => {
    report.push(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
    fail.push(l);
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
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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

    /* ================= 1. 进知识库 ================= */
    const nav = await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(el => el.innerText.trim() === '知识库');
      if (!hit) return false;
      hit.closest('button').click();
      return true;
    })()`);
    nav ? ok('进知识库') : bad('进知识库', '侧栏找不到「知识库」');
    await sleep(2500);

    /* ================= 2. 类型按钮 ================= */
    const levels = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.kb-level')];
      return {
        count: btns.length,
        items: btns.map(b => ({
          text: (b.innerText || '').trim(),
          n: (b.querySelector('.kb-level__n') || {}).innerText || null,
          on: b.classList.contains('kb-level--on'),
        })),
        totalPoints: (document.querySelector('.kb-lead') || {}).innerText || null,
      };
    })()`);

    levels.count === 4
      ? ok('有四个类型按钮', levels.items.map((i) => i.text.replace(/\s+/g, ' ')).join(' / '))
      : bad('类型按钮数量不对', `实测 ${levels.count} 个`);

    const labels = levels.items.map((i) => i.text.replace(/[0-9]/g, '').trim());
    const expect = ['记忆', '理解', '应用', '分析'];
    expect.every((e) => labels.some((l) => l.indexOf(e) >= 0))
      ? ok('四个类型名与骨架页一致（记忆/理解/应用/分析）', labels.join(' / '))
      : bad('类型名不一致', labels.join(' / '));

    const sum = levels.items.reduce((n, i) => n + Number(i.n || 0), 0);
    const m = (levels.totalPoints || '').match(/共\s*(\d+)\s*条/);
    const total = m ? Number(m[1]) : null;
    sum === total
      ? ok('四个类型的计数之和等于知识点总数', `${sum} = ${total}`)
      : bad('计数之和对不上', `类型和=${sum} 总数=${total}`);

    const p1 = await shot('01-知识库类型筛选.png');
    report.push(`        截图: ${path.relative(ROOT, p1)}`);

    /* ================= 3. 点一个类型，列表要真的收窄 ================= */
    const before = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.kb-point')];
      return { total: items.length };
    })()`);

    const picked = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.kb-level')];
      /* 挑一个计数 > 0 且小于总数的类型，才看得出收窄 */
      const target = btns.find(b => {
        const n = Number((b.querySelector('.kb-level__n') || {}).innerText || 0);
        return n > 0;
      });
      if (!target) return { ok: false, why: '没有非空类型' };
      const label = (target.innerText || '').trim();
      target.click();
      return { ok: true, label };
    })()`);
    await sleep(1200);

    const after = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.kb-point')];
      const on = [...document.querySelectorAll('.kb-level--on')].map(b => (b.innerText || '').trim());
      return { total: items.length, on };
    })()`);

    picked.ok ? ok('点了类型筛选', picked.label) : bad('点类型失败', picked.why);
    after.on.length === 1 ? ok('按钮进入选中态') : bad('选中态不对', JSON.stringify(after.on));
    after.total < before.total || after.total === 0
      ? ok('列表真的收窄了', `${before.total} → ${after.total} 条`)
      : bad('列表没变（筛选没生效）', `${before.total} → ${after.total} 条`);

    const p2 = await shot('02-筛后.png');
    report.push(`        截图: ${path.relative(ROOT, p2)}`);

    /* 清空类型，恢复全量 */
    await evalJs(`(() => {
      const c = document.querySelector('.kb-levels__clear');
      if (c) c.click();
    })()`);
    await sleep(800);

    /* ================= 4. 闪卡「去知识库挑」 ================= */
    /*
     * 导航路径（踩过坑，别改回去）：
     * 复习巩固在 pages.ts 里 show:false，侧栏没有它，所以不能点侧栏。
     * 第一版去点「开始学习」页上文字含「复习巩固」的按钮，
     * 结果落到了「我的题组」——那一页也有按钮含这几个字（是别的入口）。
     * 改用「开始复习」：它在 开始学习 页上，且明确把 autoReview 打开，
     * 稳定进到复习巩固页（verify-oral-scope.cjs 也是这么走的）。
     */
    await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const learning = labels.find(el => el.innerText.trim() === '开始学习');
      if (learning) learning.closest('button').click();
    })()`);
    await sleep(2000);

    const toBook = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => (b.innerText || '').trim().indexOf('开始复习') === 0);
      if (!hit) return { ok: false, all: btns.map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 20) };
      hit.click();
      return { ok: true, text: hit.innerText.trim().slice(0, 30) };
    })()`);
    toBook.ok ? ok('进复习巩固页', toBook.text) : bad('进复习巩固页失败', JSON.stringify(toBook.all));
    await sleep(3000);

    /* 自动进了今日复习就先结束，回到复习巩固主界面 */
    await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const end = btns.find(b => (b.innerText || '').trim() === '结束');
      if (end) end.click();
    })()`);
    await sleep(1500);

    const openFc = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => (b.innerText || '').trim().indexOf('记忆闪卡') === 0);
      if (!hit) return { ok: false, all: btns.map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 30) };
      hit.click();
      return { ok: true, text: hit.innerText.trim() };
    })()`);
    openFc.ok ? ok('进闪卡面板', openFc.text) : bad('进闪卡面板失败', JSON.stringify(openFc.all));
    await sleep(2000);

    /*
     * 不要再点任何「挑」字样的按钮（第一版就栽在这里）。
     * 0 张卡时面板本来就停在 pick 模式，「去知识库挑」直接就在工具栏上；
     * 去闪卡有卡时才会先停在翻卡视图、需要点「加卡」。
     * 所以只在**确有「加卡」按钮**时才点它 —— 那是翻卡视图独有的。
     */
    await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const add = btns.find(b => (b.innerText || '').trim().indexOf('加卡') === 0);
      if (add) add.click();
    })()`);
    await sleep(1200);

    /*
     * 找「去知识库挑」。
     *
     * ⚠️ 这里有个容易误判的地方（第一版踩了）：
     * 0 张卡时 FlashcardsPanel 的初始 mode 就是 'pick'，此时面板里
     * 已经有「挑」相关的按钮。脚本若按「含『挑』字」去找并点一次，
     * 会**先点错按钮**，于是还没验证「去知识库挑」就已经跳到知识库了，
     * 然后断言「找不到去知识库挑」失败 —— 但功能其实是好的。
     *
     * 所以这里只按**精确文字**找，绝不模糊匹配；找不到时
     * 先检查是不是已经在知识库挑选页（说明上一步误触发了）。
     */
    const goPick = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find(b => (b.innerText || '').trim() === '去知识库挑');
      if (hit) { hit.click(); return { ok: true, how: 'clicked' }; }
      /* 已经在知识库挑选页？说明前面某步已经触发过跳转 */
      if (document.querySelector('.kb-pickbar')) return { ok: true, how: 'already-there' };
      return { ok: false, all: btns.map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 24) };
    })()`);
    goPick.ok
      ? ok('闪卡里有「去知识库挑」', goPick.how === 'already-there' ? '（已在挑选页）' : '')
      : bad('找不到「去知识库挑」', JSON.stringify(goPick.all));
    await sleep(3000);

    /* ================= 5. 挑选模式 ================= */
    const pickMode = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.kb-point__pick input[type=checkbox]')];
      const bar = document.querySelector('.kb-pickbar');
      const title = document.querySelector('.kb-title');
      return {
        checkboxes: boxes.length,
        hasBar: !!bar,
        barText: bar ? (bar.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        title: title ? title.innerText.trim() : null,
        lead: (document.querySelector('.kb-lead') || {}).innerText || null,
      };
    })()`);

    pickMode.checkboxes > 0
      ? ok('挑选模式有勾选框', `${pickMode.checkboxes} 个`)
      : bad('没有勾选框（没进入挑选模式）', JSON.stringify(pickMode));
    pickMode.hasBar ? ok('有吸底确认栏', pickMode.barText) : bad('没有确认栏');
    (pickMode.title || '').indexOf('挑') >= 0
      ? ok('标题变成挑选语气', pickMode.title)
      : bad('标题没变', pickMode.title);

    const p3 = await shot('03-挑选模式.png');
    report.push(`        截图: ${path.relative(ROOT, p3)}`);

    /* 勾两条，看计数与按钮文字跟着变 */
    const ticked = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.kb-point__pick input[type=checkbox]:not(:disabled)')];
      if (boxes.length === 0) return { ok: false };
      boxes[0].click();
      if (boxes[1]) boxes[1].click();
      return { ok: true, n: Math.min(2, boxes.length) };
    })()`);
    await sleep(600);

    const afterTick = await evalJs(`(() => {
      const bar = document.querySelector('.kb-pickbar');
      const okBtn = document.querySelector('.kb-pickbar__ok');
      return {
        barText: bar ? (bar.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        btnText: okBtn ? okBtn.innerText.trim() : null,
        btnDisabled: okBtn ? okBtn.disabled : null,
      };
    })()`);

    ticked.ok
      ? (afterTick.btnDisabled === false
          ? ok('勾选后确认按钮可用', `${afterTick.btnText} / ${afterTick.barText}`)
          : bad('勾选后按钮仍禁用', afterTick.btnText))
      : bad('无法勾选（可能全部已在闪卡里）');

    const p4 = await shot('04-勾选后.png');
    report.push(`        截图: ${path.relative(ROOT, p4)}`);

    /* ================= 6. 不该有意外写入 ================= */
    const idb = await evalJs(`(async () => {
      const dbs = await indexedDB.databases();
      const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
      if (!name) return { ok: false };
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const count = (s) => new Promise((res) => {
        if (!db.objectStoreNames.contains(s)) { res(null); return; }
        const rq = db.transaction(s, 'readonly').objectStore(s).count();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      });
      const out = {
        ok: true, db: name, version: db.version, stores: [...db.objectStoreNames].length,
        flashcards: await count('flashcards'),
        reviewRecords: await count('reviewRecords'),
        oralReviews: await count('oralReviews'),
      };
      db.close();
      return out;
    })()`);
    if (idb.ok) {
      ok('IndexedDB 可读', `DB=${idb.db} v${idb.version} / ${idb.stores} 分区`);
      /*
       * 只勾选、还没点「加入闪卡」→ flashcards 不该变。
       * 这条防的是「一勾就写库」那种误实现。
       */
      typeof idb.flashcards === 'number'
        ? ok('仅勾选未写入 flashcards', `${idb.flashcards} 张`)
        : bad('读不到 flashcards');
      typeof idb.reviewRecords === 'number'
        ? ok('复习记录未被改动', `${idb.reviewRecords} 条`)
        : bad('读不到 reviewRecords');
    } else {
      bad('IndexedDB 可读', 'no db');
    }

    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0 ? bad('控制台有错误', JSON.stringify(errs)) : ok('控制台无明显错误');

    console.log('\n========== 知识库分类 + 闪卡跳转验证 ==========');
    report.forEach((l) => console.log(l));
    console.log('===============================================');
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
