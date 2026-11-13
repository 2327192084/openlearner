/**
 * 验证「资料阅读进度」的记忆系统（2026-11-13）。
 *
 * ## 用户的两个要求
 *
 * 1. 「资料进度不符合实际情况，应更名为题组进度」
 * 2. 「资料进度应该根据资料阅读情况实现，需要做一个记忆系统，
 *     记住用户上一次打开资料的状态」
 *
 * 用户之后又定了两条口径：
 *  - 进度 = **翻到过的最远页码**
 *  - 打开资料时**不提示、直接自动回到上次位置**
 *
 * ## 断言什么
 *
 * 这是「记忆系统」，最容易出错的不是存不进去，而是**存了但读不回来**、
 * 或者**回读时回到错的页**。所以必须跨会话验：
 *
 *   ① 打开资料 → 翻到第 N 页 → 关掉 app
 *   ② 重新打开 app → 再进同一份资料 → 必须回到第 N 页
 *
 * 只在一次会话里测是不够的（那种情况下页面状态本来就还在）。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-read-progress.cjs --data .tmp/rp-data [--port 9930]
 *   加 --app <目录> 做反向验证（旧构建应失败）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/rp-data'));
const PORT = Number(arg('port', '9930'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/read-progress'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 起一次 app，跑 fn(page 操作函数)，然后关掉。用于「跨会话」验证 */
async function withApp(fn) {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [
      `--user-data-dir=${DATA}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1400,900',
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && (t.url || '').indexOf('file://') === 0);
        if (page && page.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');
    await sleep(SLEEP_MS);

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
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
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    return await fn({ evalJs, send, shot });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    /* 等它真的退出，leveldb 才会落盘 —— 否则下一次读到的是旧值 */
    await sleep(2500);
  }
}

/** 进资料页并打开「段数最多」的那份 */
const openBiggestSource = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(700);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === '资料');
    hit?.closest('button')?.click();
    await sleep(1800);
    const items = [...document.querySelectorAll('.source-item')];
    let best = null;
    for (const li of items) {
      const meta = li.querySelector('.source-row__meta')?.innerText ?? '';
      const segPart = meta.split('·').map(x => x.trim()).find(x => x.endsWith('段')) || '';
      const segs = Number(segPart.replace(/[^0-9]/g, '')) || 0;
      if (!best || segs > best.segs) best = { li, segs, meta };
    }
    if (!best || best.segs <= 0) return { ok: false, metas: items.map(i => i.querySelector('.source-row__meta')?.innerText) };
    best.li.querySelector('.source-row')?.click();
    await sleep(3000);
    return { ok: true, meta: best.meta, segs: best.segs };
  })()`);

/** 读当前阅读器的页码 */
const readerPage = (evalJs) =>
  evalJs(`(() => {
    const input = document.querySelector('.reader-nav__input');
    return {
      inReader: !!document.querySelector('.reader-body'),
      page: input ? Number(input.value) : null,
      scrollY: window.scrollY,
    };
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  /* ---------- 会话 1：读到第 9 段，然后关掉 ---------- */
  const first = await withApp(async ({ evalJs, shot }) => {
    const opened = await openBiggestSource(evalJs);
    record('能打开一份有正文的资料', opened.ok === true, JSON.stringify(opened));
    if (!opened.ok) return null;

    const before = await readerPage(evalJs);
    record('刚打开时在第一页', before.page === 1, JSON.stringify(before));

    /* 用页码输入框跳到第 9 段（比点 8 次「下一段」稳，也更接近真实用法） */
    const jumped = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.reader-nav__input');
      if (!input) return { ok: false, reason: '没有页码输入框' };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '9');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1500);
      return { ok: true, page: Number(document.querySelector('.reader-nav__input')?.value) };
    })()`);
    record('能跳到第 9 段', jumped.ok === true && jumped.page === 9, JSON.stringify(jumped));

    /* 等防抖写完（600ms）+ 余量 */
    await sleep(1600);
    await shot('reader-at-9.png');
    return { page: Number(await evalJs("document.querySelector('.reader-nav__input')?.value")) };
  });

  /* ---------- 库里应该已经有 readProgress ---------- */
  const stored = await withApp(async ({ evalJs }) => {
    return evalJs(`(async () => {
      const open = () => new Promise((res, rej) => {
        const q = indexedDB.open('openleaner');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const db = await open();
      const all = (s) => new Promise((res, rej) => {
        const tx = db.transaction(s, 'readonly');
        const rq = tx.objectStore(s).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const srcs = await all('sources');
      const withProgress = srcs.filter(s => s.readProgress && s.readProgress.furthestPage > 0);
      return {
        total: srcs.length,
        withProgress: withProgress.length,
        rows: withProgress.map(s => ({
          title: String(s.title).slice(0, 24),
          furthestPage: s.readProgress.furthestPage,
          lastPage: s.readProgress.lastPage,
          lastSegmentIndex: s.readProgress.lastSegmentIndex,
          lastReadAt: s.readProgress.lastReadAt,
        })),
        /* updatedAt 不该被翻页刷新 —— 那是「改属性」才该动的时间 */
        unchangedUpdatedAt: srcs.every(s => s.updatedAt !== s.readProgress?.lastReadAt),
      };
    })()`);
  });

  record(
    '★ 阅读位置真的落库了（Source.readProgress）',
    stored.withProgress >= 1,
    JSON.stringify({ total: stored.total, withProgress: stored.withProgress, rows: stored.rows }),
  );
  record(
    '★ 记的是「翻到过的最远页码」而不是当前页',
    stored.rows.some((r) => r.furthestPage >= 9),
    JSON.stringify(stored.rows),
  );
  record(
    '翻页没有把资料的 updatedAt 刷成最新（否则列表里像刚被编辑过）',
    stored.unchangedUpdatedAt === true,
  );

  /* ---------- 会话 2：重新打开同一份资料，应回到第 9 段 ---------- */
  const second = await withApp(async ({ evalJs, shot }) => {
    const opened = await openBiggestSource(evalJs);
    if (!opened.ok) return { ok: false };
    await sleep(1200);
    const state = await readerPage(evalJs);
    await shot('reopened-should-be-9.png');
    return { ok: true, ...state };
  });

  record(
    '★★ 重新打开 app 后，同一份资料自动回到上次那一段（不提示）',
    second.ok === true && second.page === 9,
    JSON.stringify(second),
  );

  /* ---------- 会话 3：往回翻到第 3 段，furthestPage 必须还停在 9 ---------- */
  /*
   * 这一项单独验，因为它正是「最远页码」这个口径最容易走样的地方：
   * 实现里若写成 `furthestPage: page`，往回翻一下进度条就缩水，
   * 用户会觉得「我明明读到第 9 页，怎么变第 3 页了」。
   * 而 lastPage 必须跟着变成 3 —— 否则下次打开回不到他真正停的地方。
   */
  const back = await withApp(async ({ evalJs }) => {
    const opened = await openBiggestSource(evalJs);
    if (!opened.ok) return { ok: false };
    /* 回翻到第 3 段 */
    const went = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.reader-nav__input');
      if (!input) return { ok: false };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1600);
      return { ok: true, page: Number(document.querySelector('.reader-nav__input')?.value) };
    })()`);
    await sleep(1600);
    const after = await evalJs(`(async () => {
      const open = () => new Promise((res, rej) => {
        const q = indexedDB.open('openleaner');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const db = await open();
      const all = (s) => new Promise((res, rej) => {
        const tx = db.transaction(s, 'readonly');
        const rq = tx.objectStore(s).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const row = (await all('sources')).find(s => s.readProgress && s.readProgress.furthestPage > 0);
      return row ? { furthestPage: row.readProgress.furthestPage, lastPage: row.readProgress.lastPage } : null;
    })()`);
    return { ok: true, went, after };
  });

  record(
    '★★ 往回翻到第 3 段后，furthestPage 仍是 9（进度不缩水）',
    back.ok === true && back.after && back.after.furthestPage === 9,
    JSON.stringify(back),
  );
  record(
    '★ 同时 lastPage 变成 3（下次打开回到他真正停的地方）',
    back.ok === true && back.after && back.after.lastPage === 3,
    JSON.stringify(back),
  );

  /* ---------- 首页：改名 + 阅读进度块 ---------- */
  const home = await withApp(async ({ evalJs, shot }) => {
    await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim() === '学习库');
      hit?.closest('button')?.click();
      await sleep(2000);
      return true;
    })()`);
    const state = await evalJs(`(() => {
      const h2s = [...document.querySelectorAll('.dash-h2')].map(h => (h.innerText || '').split('\\n')[0].trim());
      const body = document.body.innerText;
      return {
        headings: h2s,
        hasOldLabel: body.indexOf('资料进度') >= 0,
        hasZuzhang: body.indexOf('题组进度') >= 0,
        hasReading: body.indexOf('资料阅读') >= 0,
        readLabelShown: [...document.querySelectorAll('.dash-source__pct')].map(x => (x.innerText || '').trim()).filter(t => t.indexOf('到过') >= 0),
      };
    })()`);
    await shot('home-x.png');
    return state;
  });

  record('首页不再出现「资料进度」这个名不副实的标题', home.hasOldLabel === false, JSON.stringify(home.headings));
  record('★ 改名为「题组进度」', home.hasZuzhang === true, JSON.stringify(home.headings));
  record('★ 新增真正的「资料阅读」块', home.hasReading === true, JSON.stringify(home.headings));
  record(
    '「资料阅读」显示「到过第 N/M 页」（不写「已读」，因为跳读也算）',
    home.readLabelShown.some((t) => t.indexOf('到过第') >= 0),
    JSON.stringify(home.readLabelShown),
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
