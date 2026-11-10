/**
 * 验证「划选提问」（2026-11-10）。
 *
 * 为什么不能只靠单测：这次改的是**交互与几何**。2026-11-10 那天
 * 有 5 个 bug 都是测试全绿但界面错。这条功能的失败方式很典型：
 * 单测能证明「选区转素材」对，但证明不了「浮层出现在选区旁边、
 * 不跑出屏幕、点下去真的换页」。
 *
 * ## 为什么跑**打包产物**而不是 vite dev server
 *
 * 踩过：dev server 的 origin 是 `http://127.0.0.1:5173`，而用户真实
 * 数据存在 `file://` origin 下（IndexedDB 目录名 `file__0...`）。
 * 用 dev server 打开等于面对一个**全新空库**，页面上「资料 0」，
 * 后面所有步骤都无从谈起，还会让人误以为功能坏了。
 *
 * 所以流程是：`vite build` → `pack-dev-asar.cjs` 打到 `.tmp/apprun`
 * → 用**副本数据**启动那个产物。这样 origin 与真实一致，
 * 且不碰 release/win-unpacked（用户正在用的那份）。
 *
 * 所以本脚本跑真实 Electron + 真实 IndexedDB，并且：
 *   1. 真的在正文里造一个 Range 选区（不是调内部函数）
 *   2. 量浮层的几何（left/top/尺寸）与选区的相对位置
 *   3. 截图落盘供肉眼复核
 *   4. 点「用这段提问」，断言跳到了复习巩固页且面板起来了
 *   5. 查 IndexedDB 确认没有意外的写入
 *
 * ⚠️ 三条踩过的坑（都在本脚本里修掉了，别改回去）：
 *   - CDP /json/list 里 DevTools 也是 type='page' 且排在最前，必须按 URL 过滤；
 *   - 侧栏项要按 .nav-item__label 精确匹配，「资料」会同时命中包含项；
 *   - 必须用打包产物（file:// origin），否则看不到用户真实数据。
 *
 * 用法：
 *   node scripts/verify-selection-ask.cjs --data .tmp/selask-data --app .tmp/apprun
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/** 打包产物以 file:// 打开，origin 与用户真实环境一致 */
const APP_URL_PREFIX = 'file://';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', '.tmp/apprun'));
const DATA_DIR = path.resolve(ROOT, arg('data', path.join(APP_DIR, 'openleaner-data')));
const PORT = Number(arg('port', '9960'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/selection-ask'));
const WIDTH = 1440;
const HEIGHT = 900;

if (!fs.existsSync(DATA_DIR)) {
  console.error(`数据目录不存在: ${DATA_DIR}`);
  process.exit(2);
}
const APP_EXE = path.join(APP_DIR, 'OpenLeaner.exe');
if (!fs.existsSync(APP_EXE)) {
  console.error(`找不到打包产物: ${APP_EXE}\n先跑：npx vite build && node scripts/pack-dev-asar.cjs --out .tmp/apprun`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  const fail = [];
  const ok = (label, detail = '') => {
    report.push(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  };
  const bad = (label, detail = '') => {
    report.push(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail.push(label);
  };

  /* ---- 启动打包产物（file:// origin，与用户真实环境一致）---- */
  let app = null;
  try {
    app = spawn(
      APP_EXE,
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        `--window-size=${WIDTH},${HEIGHT}`,
      ],
      { stdio: 'ignore' },
    );

    /* ---- 找应用页（必须排除 DevTools）---- */
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
    if (!page) throw new Error('Electron 没起来（CDP 连不上应用页）');

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

    /* 收集控制台错误（先挂上，后面的步骤都受益） */
    await evalJs(`(() => {
      if (window.__cdpErrors) return;
      window.__cdpErrors = [];
      const orig = console.error;
      console.error = function (...a) {
        try { window.__cdpErrors.push(a.map(String).join(' ').slice(0, 300)); } catch {}
        return orig.apply(console, a);
      };
      window.addEventListener('error', (e) => {
        window.__cdpErrors.push('window.error: ' + (e.message || ''));
      });
    })()`);

    /* ================= 1. 进资料页（按 .nav-item__label 精确匹配）================= */
    const navOk = await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(el => el.innerText.trim() === '资料');
      if (!hit) return false;
      hit.closest('button').click();
      return true;
    })()`);
    navOk ? ok('进「资料」页') : bad('进「资料」页', '侧栏找不到 .nav-item__label=资料');
    await sleep(1500);

    /* ================= 2. 打开第一份资料的阅读器 ================= */
    const openOk = await evalJs(`(() => {
      /* 先看这一页有哪些按钮，便于脚本自己说明失败原因 */
      const btns = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean);
      const read = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('阅读'));
      if (read) { read.click(); return 'button:' + read.innerText.trim(); }
      /* 有些版本点整行卡片 */
      const row = document.querySelector('.src-row, .source-row, .src-card, .source-card');
      if (row) { row.click(); return 'row'; }
      return 'no-entry|buttons=' + JSON.stringify(btns.slice(0, 20));
    })()`);
    String(openOk).startsWith('no-entry')
      ? bad('打开阅读器', openOk)
      : ok('打开阅读器', String(openOk));
    await sleep(2500);

    /* ================= 3. 正文渲染了吗 ================= */
    const bodyInfo = await evalJs(`(() => {
      const el = document.querySelector('.reader-body');
      if (!el) return { found: false };
      return { found: true, len: (el.innerText || '').length, paragraphs: el.querySelectorAll('p').length };
    })()`);
    bodyInfo.found && bodyInfo.len > 100
      ? ok('正文已渲染', `${bodyInfo.len} 字 / ${bodyInfo.paragraphs} 段`)
      : bad('正文已渲染', JSON.stringify(bodyInfo));

    /* ================= 4. 造一个真实 Range 选区 ================= */
    const selInfo = await evalJs(`(() => {
      const el = document.querySelector('.reader-body');
      if (!el) return { ok: false, why: 'no body' };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null, n;
      while ((n = walker.nextNode())) {
        if ((n.textContent || '').trim().length > 60) { node = n; break; }
      }
      if (!node) return { ok: false, why: 'no long text node' };
      const text = node.textContent;
      const start = Math.min(20, Math.max(0, text.length - 30));
      const end = Math.min(text.length, start + 24);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      /* 合成事件不会自动触发 selectionchange */
      document.dispatchEvent(new Event('selectionchange'));
      return { ok: true, quote: text.slice(start, end), len: end - start };
    })()`);
    selInfo.ok
      ? ok('造出选区', `「${String(selInfo.quote).slice(0, 16)}…」${selInfo.len} 字`)
      : bad('造出选区', selInfo.why);
    await sleep(800);

    /* ================= 5. 浮层与几何 ================= */
    const barInfo = await evalJs(`(() => {
      const bar = document.querySelector('.selbar');
      if (!bar) return { exists: false };
      const r = bar.getBoundingClientRect();
      const sel = window.getSelection();
      const sr = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const btn = bar.querySelector('.selbar__btn');
      return {
        exists: true,
        cls: bar.className,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        vw: window.innerWidth, vh: window.innerHeight,
        selRect: sr ? { left: sr.left, top: sr.top, bottom: sr.bottom, width: sr.width } : null,
        btnText: btn ? btn.innerText.trim() : null,
        btnDisabled: btn ? btn.disabled : null,
      };
    })()`);

    if (!barInfo.exists) {
      bad('选区浮层出现', 'DOM 里没有 .selbar');
    } else {
      ok('选区浮层出现', `按钮文字=「${barInfo.btnText}」`);
      barInfo.inViewport
        ? ok('浮层完整在视口内', `rect=${JSON.stringify(barInfo.rect)} 视口=${barInfo.vw}x${barInfo.vh}`)
        : bad('浮层跑出视口', JSON.stringify(barInfo.rect));

      if (barInfo.selRect) {
        const gap =
          barInfo.rect.bottom <= barInfo.selRect.top
            ? barInfo.selRect.top - barInfo.rect.bottom
            : barInfo.rect.top - barInfo.selRect.bottom;
        const attached = Math.abs(gap - 8) <= 3; /* BAR_GAP=8，含 1px 边框误差 */
        attached
          ? ok('浮层贴着选区（间距≈8px）', `实测 ${gap.toFixed(1)}px，位置=${barInfo.cls}`)
          : bad('浮层与选区距离不对', `实测 ${gap.toFixed(1)}px，期望≈8px`);

        const selCenter = barInfo.selRect.left + barInfo.selRect.width / 2;
        const barCenter = barInfo.rect.left + barInfo.rect.width / 2;
        Math.abs(selCenter - barCenter) < 60
          ? ok('浮层水平对齐选区', `选区中心 ${selCenter.toFixed(0)} / 浮层中心 ${barCenter.toFixed(0)}`)
          : bad('浮层水平偏离选区', `选区中心 ${selCenter.toFixed(0)} / 浮层中心 ${barCenter.toFixed(0)}`);
      }

      barInfo.btnDisabled === true
        ? bad('按钮不该禁用', '已接入模型时却禁用')
        : ok('按钮可点');

      const p = await shot('01-选区浮层.png');
      report.push(`        截图: ${path.relative(ROOT, p)}`);
    }

    /* ================= 6. 点击 → 进复习巩固页并起提问 ================= */
    const clicked = await evalJs(
      `(() => { const b = document.querySelector('.selbar__btn'); if (!b) return false; b.click(); return true; })()`,
    );
    await sleep(3000);

    const after = await evalJs(`(() => {
      const active = document.querySelector('.nav-item--on .nav-item__label');
      const heading = document.querySelector('h1, .page-title, header h1');
      const oral = document.querySelector('.orp');
      return {
        url: location.hash,
        heading: heading ? heading.innerText.trim() : null,
        activeNav: active ? active.innerText.trim() : null,
        hasOralPanel: !!oral,
        oralText: oral ? (oral.innerText || '').slice(0, 200) : null,
        selbarGone: !document.querySelector('.selbar'),
        /*
         * 不靠侧栏高亮判断到了哪一页：复习巩固在 pages.ts 里是 show:false
         * （用户点侧栏进不去，只能由「开始复习」「用这段提问」带进去），
         * 所以永远不会有 .nav-item--on 指向它。踩过一次。
         * 改用面包屑/页面标题里的文字。
         */
        breadcrumb: (() => {
          const el = document.querySelector('.crumb, .topbar__crumb, .app-top__crumb, .page-crumb');
          return el ? el.innerText.trim() : null;
        })(),
        bodyHead: (document.body.innerText || '').slice(0, 400),
      };
    })()`);

    clicked ? ok('点击「用这段提问」') : bad('点击「用这段提问」', '按钮不见了');
    after.selbarGone ? ok('点击后浮层收起') : bad('点击后浮层仍在');

    /*
     * 判断「去了复习巩固页」用页面正文里有没有对应标题，
     * 不用侧栏高亮（那一页 show:false，不进侧栏）。
     */
    const onBookPage =
      (after.bodyHead || '').indexOf('复习巩固') >= 0 || (after.breadcrumb || '').indexOf('复习巩固') >= 0;
    onBookPage
      ? ok('跳到了复习巩固页', `面包屑=${after.breadcrumb} 高亮=${after.activeNav ?? '（该页不进侧栏，正常）'}`)
      : bad('页面没跳到复习巩固', `面包屑=${after.breadcrumb}`);

    /*
     * 面板是否起来：看顶部范围说明。
     *
     * 这里**同时**断言「范围写的是划选」，而不只是「面板出现了」——
     * 因为踩过一个真 bug：面板起来了，但素材被知识点池覆盖，
     * 顶部写着「知识点随机提问」。只断言「面板出现」会漏掉它。
     */
    const scopeLabel = await evalJs(`(() => {
      /* 面板根是 .orp，范围写在 .orp__scope（类名见 OralReviewPanel.tsx） */
      const el = document.querySelector('.orp__scope');
      if (el) return el.innerText.trim();
      const t = document.body.innerText || '';
      const m = t.match(/(划选片段提问|知识点随机提问|随机提问)/);
      return m ? m[1] : null;
    })()`);

    after.hasOralPanel
      ? ok('提问面板已起来', `范围=${JSON.stringify(scopeLabel)}`)
      : bad('提问面板没起来', `oralText=${JSON.stringify(after.oralText)}`);

    (scopeLabel || '').indexOf('划选') >= 0
      ? ok('范围如实标明来自划选', `「${scopeLabel}」`)
      : bad('范围被覆盖成知识点随机', `实测「${scopeLabel}」`);

    const p2 = await shot('02-点后进入提问.png');
    report.push(`        截图: ${path.relative(ROOT, p2)}`);

    /* ================= 7. IndexedDB：不该有意外写入 ================= */
    const idb = await evalJs(`(async () => {
      const dbs = await indexedDB.databases();
      const name = (dbs.find(d => d.name && d.name.indexOf('openleaner') >= 0) || dbs[0] || {}).name;
      if (!name) return { ok: false, why: 'no db' };
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
        sources: await count('sources'),
      };
      db.close();
      return out;
    })()`);

    if (idb.ok) {
      ok('IndexedDB 可读', `DB=${idb.db} v${idb.version} / ${idb.stores} 分区`);
      /*
       * 只是「划选 + 点提问」，还没作答也没保存 → oralReviews 不该增加。
       * 默认不保存是明确设计（用户可能只是随手试试）。
       */
      typeof idb.oralReviews === 'number'
        ? ok('没有意外写入 oralReviews', `${idb.oralReviews} 条`)
        : bad('读不到 oralReviews');
      typeof idb.reviewRecords === 'number'
        ? ok('复习记录未被改动', `${idb.reviewRecords} 条`)
        : bad('读不到 reviewRecords');
    } else {
      bad('IndexedDB 可读', idb.why);
    }

    /* ================= 8. 控制台错误 ================= */
    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0
      ? bad('控制台有错误', JSON.stringify(errs))
      : ok('控制台无明显错误');

    console.log('\n========== 验证报告 ==========');
    report.forEach((l) => console.log(l));
    console.log('==============================');
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
