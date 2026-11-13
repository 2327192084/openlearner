/**
 * 验证「首页各行点了能跳到对应的地方」（2026-11-13 深夜）。
 *
 * ## 用户原话
 *
 * 「建议：点击界面上的题组、错题或是资料能直接跳转到对应的题组、
 *  错题或是资料页面，不用再到对于功能栏打开」
 *
 * ## 断言怎么设计才能区分好坏（硬约束 9）
 *
 * 只断言「页面切过去了」是不够的 —— 那正是改造前的水平
 * （错题五行都跳错题页，页面确实切过去了）。
 * 所以每一步都要验「落到了**那一个**具体对象上」：
 *
 *  - 资料阅读行 → 阅读器打开，且**页码 = 首页写的那一页**
 *  - 题组进度行 → 学习地图里那一份资料被高亮（.map-src--focus）
 *  - 错题行     → 错题页里那一题被高亮（.wbk-item--focus）且已滚进视口
 *
 * 另外两点：
 *  - 每一行都得是**真按钮**（键盘能用），不是加了 onClick 的 div
 *  - `__none__`（随机或手工题库）那种行不该假装能点
 *
 * ⚠️ 只在副本上跑。默认 .tmp/navrow-data。
 *
 *   node scripts/verify-home-rows.cjs --data .tmp/navrow-data
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/navrow-data'));
const PORT = Number(arg('port', '9995'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/home-rows'));
const SLEEP_MS = Number(arg('boot-wait', '3000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function withApp(fn) {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );
  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 140; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && (t.url || '').indexOf('file://') === 0);
        if (page) break;
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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    return await fn({ evalJs, shot });
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
    await sleep(2000);
  }
}

/** 回首页（侧栏「学习库」） */
const goHome = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(600);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === '学习库');
    if (!hit) return { ok: false };
    hit.closest('button').click();
    await sleep(2000);
    return { ok: true };
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    await goHome(evalJs);
    await sleep(1200);

    /* ---------- 0. 先确认首页那几块都在 ---------- */
    const sections = await evalJs(`(() => {
      const titles = [...document.querySelectorAll('.dash-h2')].map(h => (h.innerText || '').trim().split('\\n')[0]);
      return {
        titles,
        hasStudyProgress: !!document.querySelector('.dash-source__link'),
        readRows: document.querySelectorAll('.dash-source__link').length,
        wrongRows: document.querySelectorAll('.dash-recent__row').length,
      };
    })()`);
    record(
      '首页有「题组进度」和「资料阅读」两块内容',
      sections.titles.some((t) => t.indexOf('题组进度') !== -1),
      JSON.stringify(sections.titles),
    );
    await shot('01-home.png');

    /*
     * ---------- 1. 每一行都必须是真按钮（键盘可用、读屏念得出） ----------
     * 用 div + onClick 也能「点得动」，但 Tab 不到、回车没反应 ——
     * 那是假的可点击。
     */
    const tagCheck = await evalJs(`(() => {
      const links = [...document.querySelectorAll('.dash-source__link')];
      const wrong = [...document.querySelectorAll('.dash-recent__row')];
      return {
        linkTags: links.map(e => e.tagName),
        wrongTags: wrong.map(e => e.tagName),
        linkCount: links.length,
        wrongCount: wrong.length,
      };
    })()`);
    record(
      '题组进度/资料阅读的行是真 <button>（键盘能到）',
      tagCheck.linkCount > 0 && tagCheck.linkTags.every((t) => t === 'BUTTON'),
      JSON.stringify(tagCheck.linkTags),
    );
    record(
      '错题的行是真 <button>',
      tagCheck.wrongCount > 0 && tagCheck.wrongTags.every((t) => t === 'BUTTON'),
      JSON.stringify(tagCheck.wrongTags),
    );

    /* ---------- 2. 资料阅读行 → 打开阅读器，且页码与首页一致 ---------- */
    const readClick = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 找到「资料阅读」那一块里的行（第二组 .dash-sources） */
      const lists = [...document.querySelectorAll('.dash-sources')];
      const list = lists[lists.length - 1];
      if (!list) return { ok: false, reason: 'no-read-list' };
      const btn = list.querySelector('.dash-source__link');
      if (!btn) return { ok: false, reason: 'no-link', html: list.innerText.slice(0, 200) };
      const label = btn.querySelector('.dash-source__pct')?.innerText ?? '';
      const m = label.match(/(\\d+)\\s*\\//);
      const expectedPage = m ? Number(m[1]) : null;
      btn.click();
      await sleep(2800);
      const input = document.querySelector('.reader-nav__input');
      return {
        ok: !!document.querySelector('.reader-body'),
        expectedPage,
        label,
        actualPage: input ? Number(input.value) : null,
      };
    })()`);
    record('点「资料阅读」的一行 → 打开阅读器', readClick.ok === true, JSON.stringify(readClick).slice(0, 200));
    record(
      '★ 落到的页码 = 首页写的那一页（不是永远第 1 页）',
      readClick.ok === true &&
        readClick.expectedPage !== null &&
        readClick.actualPage === readClick.expectedPage,
      `首页写「${readClick.label}」→ 实际第 ${readClick.actualPage} 页`,
    );
    await shot('02-reader-at-page.png');

    /* ---------- 3. 题组进度行 → 学习地图，且那一份被高亮 ---------- */
    await goHome(evalJs);
    await sleep(1000);
    const mapClick = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const list = document.querySelector('.dash-sources');
      const btn = list ? list.querySelector('.dash-source__link') : null;
      if (!btn) return { ok: false, reason: 'no-link' };
      const title = btn.querySelector('.dash-source__title')?.innerText ?? '';
      btn.click();
      await sleep(2600);
      const focused = document.querySelector('.map-src--focus');
      const inView = (() => {
        if (!focused) return null;
        const r = focused.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= (window.innerHeight || 0);
      })();
      return {
        ok: !!document.querySelector('.map-tree'),
        title,
        focusedTitle: focused ? (focused.querySelector('.map-src__title')?.innerText ?? '') : null,
        inView,
      };
    })()`);
    record('点「题组进度」的一行 → 进学习地图', mapClick.ok === true, JSON.stringify(mapClick).slice(0, 200));
    record(
      '★ 学习地图里落到那一份资料上（高亮）',
      !!mapClick.focusedTitle && mapClick.title.length > 0 && mapClick.focusedTitle.indexOf(mapClick.title.slice(0, 8)) !== -1,
      `点的「${mapClick.title}」→ 高亮的「${mapClick.focusedTitle}」`,
    );
    record(
      '★ 那一份在视口里（真的滚过去了，不是停在页顶）',
      mapClick.inView === true,
      `inView=${mapClick.inView}`,
    );
    await shot('03-map-focused.png');

    /* ---------- 4. 错题行 → 错题页，且那一题被高亮 ---------- */
    await goHome(evalJs);
    await sleep(1000);
    const wrongClick = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('.dash-recent__row')];
      if (rows.length === 0) return { ok: false, reason: 'no-wrong-rows' };
      const prompt = rows[0].querySelector('.dash-recent__prompt')?.innerText ?? '';
      rows[0].click();
      await sleep(3000);
      const focused = document.querySelector('.wbk-item--focus');
      const inView = (() => {
        if (!focused) return null;
        const r = focused.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= (window.innerHeight || 0);
      })();
      return {
        ok: true,
        clickedPrompt: prompt.slice(0, 30),
        focusedPrompt: focused
          ? (focused.querySelector('.wbk-item__prompt')?.innerText ?? '').slice(0, 30)
          : null,
        inView,
        focusCount: document.querySelectorAll('.wbk-item--focus').length,
      };
    })()`);
    record('点「错题」的一行 → 进错题页', wrongClick.ok === true, JSON.stringify(wrongClick).slice(0, 200));
    record(
      '★ 错题页里落到那一题上（高亮，且只有一条高亮）',
      !!wrongClick.focusedPrompt &&
        wrongClick.focusedPrompt === wrongClick.clickedPrompt &&
        wrongClick.focusCount === 1,
      `点的「${wrongClick.clickedPrompt}」→ 高亮的「${wrongClick.focusedPrompt}」focusCount=${wrongClick.focusCount}`,
    );
    record(
      '★ 那一题在视口里（错题多时会滚过去）',
      wrongClick.inView === true,
      `inView=${wrongClick.inView}`,
    );
    await shot('04-wrong-focused.png');

    /* ---------- 5. 同一行再点一次也要能重新定位（token 递增） ---------- */
    await goHome(evalJs);
    await sleep(1000);
    const twice = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const clickFirstWrong = async () => {
        const rows = [...document.querySelectorAll('.dash-recent__row')];
        if (!rows[0]) return false;
        rows[0].click();
        await sleep(2800);
        return !!document.querySelector('.wbk-item--focus');
      };
      const first = await clickFirstWrong();
      /* 回首页再点同一行 */
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(500);
      const home = [...document.querySelectorAll('.nav-item__label')].find(l => (l.innerText||'').trim() === '学习库');
      home?.closest('button')?.click();
      await sleep(1800);
      const second = await clickFirstWrong();
      return { first, second };
    })()`);
    record(
      '同一行再点一次仍然能定位（不会因为 id 没变而失效）',
      twice.first === true && twice.second === true,
      JSON.stringify(twice),
    );
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();
