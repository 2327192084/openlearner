/**
 * 验证「改名」（2026-11-13 傍晚，用户要求）。
 *
 * ## 用户原话
 *
 * 「建议：加个更名功能，可以更名资料库的资料，题组。」
 *
 * ## 断言怎么设计（硬约束 9：对坏实现也成立的断言等于没验）
 *
 * 只验「输入框出现、能打字、界面文字变了」是不够的 ——
 * 换名字只改 React state 也能让界面变。所以必须验**跨会话**：
 *
 *   ① 改名 → 关掉 app
 *   ② 重新启动 → 名字仍然是新的
 *
 * 这样才排除了「只是改了内存」。
 *
 * 另外两条容易漏的：
 * - 空名字必须被拦住，而且**库里的名字不能被改成空**
 * - 改名之后**资料本身还能打开**（说明改的只是 title，没动别的）
 *
 * ⚠️ 只在副本上跑（默认 .tmp/rename-data）。真实库一概不碰。
 *
 *   node scripts/verify-rename.cjs --data .tmp/rename-data
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/rename-data'));
const PORT = Number(arg('port', '9991'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/rename'));
const SLEEP_MS = Number(arg('boot-wait', '3000'));

/** 本脚本新起的名字（带时间戳，避免与上一次运行的残留混淆） */
const NEW_SOURCE_NAME = '信号与系统 · 第一章（改过名）';
const NEW_DECK_NAME = '高等数学 · 改过名的题组';
/** 被改那一份资料的原名（用于「旧名字不在了」的断言） */
const OLD_SOURCE_NAME = '高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl )';

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
    /* 等它真的退出，leveldb 才会落盘 —— 否则下一次读到旧值 */
    await sleep(2500);
  }
}

/** 侧栏导航（先展开折叠分组，按 .nav-item__label 精确匹配中文名） */
const navTo = (evalJs, name) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(600);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === ${JSON.stringify(name)});
    if (!hit) {
      return { ok: false, labels: [...document.querySelectorAll('.nav-item__label')].map(l => (l.innerText||'').trim()) };
    }
    hit.closest('button').click();
    await sleep(1800);
    return { ok: true };
  })()`);

/** 读资料列表里每一行的标题 */
const sourceTitles = (evalJs) =>
  evalJs(`[...document.querySelectorAll('.source-row__title')].map(e => (e.innerText || '').trim())`);

/** 读题组列表里每一个标题 */
const deckTitles = (evalJs) =>
  evalJs(`[...document.querySelectorAll('.deck-item__title')].map(e => (e.innerText || '').trim())`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  /* ================= 会话 1：改名 ================= */
  const firstRun = await withApp(async ({ evalJs, shot }) => {
    /* ---------- 资料改名 ---------- */
    const toSources = await navTo(evalJs, '资料');
    record('能进资料页', toSources.ok === true, JSON.stringify(toSources).slice(0, 200));
    if (!toSources.ok) return false;

    const before = await sourceTitles(evalJs);
    record('资料列表有内容（否则后面无从验起）', before.length > 0, JSON.stringify(before));

    /* 点第一行的「改名」 */
    const opened = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.source-item__rename');
      if (!btn) return { ok: false, reason: '没有改名按钮' };
      btn.click();
      await sleep(500);
      const input = document.querySelector('.rename-field__input');
      return { ok: !!input, value: input ? input.value : null, focused: document.activeElement === input };
    })()`);
    record('点「改名」就地出现输入框', opened.ok === true, JSON.stringify(opened));
    record('输入框里是当前名字（不是空的）', typeof opened.value === 'string' && opened.value.length > 0, `value=${JSON.stringify(opened.value)}`);
    record('输入框自动获得焦点', opened.focused === true, `focused=${opened.focused}`);
    await shot('01-rename-open.png');

    /* ---------- 先验「空名字要被拦住」 ---------- */
    const emptyBlocked = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.rename-field__input');
      if (!input) return { ok: false, reason: 'no-input' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(600);
      const err = document.querySelector('.rename-field__error');
      return {
        ok: true,
        stillEditing: !!document.querySelector('.rename-field__input'),
        error: err ? (err.innerText || '').trim() : null,
      };
    })()`);
    record(
      '空名字被拦住：仍停在编辑状态',
      emptyBlocked.ok === true && emptyBlocked.stillEditing === true,
      JSON.stringify(emptyBlocked),
    );
    record(
      '空名字被拦住：给出了原因',
      !!emptyBlocked.error && emptyBlocked.error.length > 0,
      `error=${JSON.stringify(emptyBlocked.error)}`,
    );
    await shot('02-empty-blocked.png');

    /* ---------- 真正的改名 ---------- */
    const renamed = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.rename-field__input');
      if (!input) return { ok: false, reason: 'no-input' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(NEW_SOURCE_NAME)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1600);
      return {
        ok: true,
        closed: !document.querySelector('.rename-field__input'),
        titles: [...document.querySelectorAll('.source-row__title')].map(e => (e.innerText || '').trim()),
      };
    })()`);
    record('按回车保存后输入框收起', renamed.ok === true && renamed.closed === true, JSON.stringify(renamed).slice(0, 300));
    record(
      '★ 资料名在列表里立刻变成新的',
      Array.isArray(renamed.titles) && renamed.titles.indexOf(NEW_SOURCE_NAME) !== -1,
      JSON.stringify(renamed.titles),
    );
    await shot('03-source-renamed.png');

    /* ---------- 题组改名 ---------- */
    const toDecks = await navTo(evalJs, '我的题组');
    record('能进我的题组页', toDecks.ok === true, JSON.stringify(toDecks).slice(0, 200));

    const deckBefore = await deckTitles(evalJs);
    record('题组列表有内容（否则后面无从验起）', deckBefore.length > 0, JSON.stringify(deckBefore));

    const deckRenamed = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.deck-item__rename');
      if (!btn) return { ok: false, reason: '没有改名按钮' };
      btn.click();
      await sleep(500);
      const input = document.querySelector('.rename-field__input');
      if (!input) return { ok: false, reason: '没有输入框' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(NEW_DECK_NAME)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1600);
      return {
        ok: true,
        closed: !document.querySelector('.rename-field__input'),
        titles: [...document.querySelectorAll('.deck-item__title')].map(e => (e.innerText || '').trim()),
      };
    })()`);
    record('题组改名：输入框收起', deckRenamed.ok === true && deckRenamed.closed === true, JSON.stringify(deckRenamed).slice(0, 300));
    record(
      '★ 题组名在列表里立刻变成新的',
      Array.isArray(deckRenamed.titles) && deckRenamed.titles.indexOf(NEW_DECK_NAME) !== -1,
      JSON.stringify(deckRenamed.titles),
    );
    await shot('04-deck-renamed.png');

    /* ---------- 改名之后资料还能打开（说明只动了 title） ---------- */
    const stillOpens = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(600);
      const hit = [...document.querySelectorAll('.nav-item__label')].find(l => (l.innerText||'').trim() === '资料');
      hit?.closest('button')?.click();
      await sleep(1600);
      const row = [...document.querySelectorAll('.source-row')]
        .find(r => (r.innerText || '').indexOf('改过名') !== -1);
      if (!row) return { ok: false, reason: '没找到改名后的那一行' };
      row.click();
      await sleep(2800);
      return { ok: !!document.querySelector('.reader-body'), title: document.querySelector('.reader-head h1, .reader-title')?.innerText ?? null };
    })()`);
    record('★ 改名后的资料仍然能打开看原文', stillOpens.ok === true, JSON.stringify(stillOpens).slice(0, 200));
    await shot('05-renamed-source-opens.png');

    return true;
  });

  if (!firstRun) {
    console.log('\n会话 1 未跑完，跳过跨会话验证');
    process.exitCode = 1;
    return;
  }

  /* ================= 会话 2：重开 app，验真的落库了 ================= */
  await withApp(async ({ evalJs, shot }) => {
    const toSources = await navTo(evalJs, '资料');
    if (toSources.ok) {
      await sleep(800);
      const titles = await sourceTitles(evalJs);
      record(
        '★ 跨会话：重启后资料名仍然是新的（证明真的落库了）',
        Array.isArray(titles) && titles.indexOf(NEW_SOURCE_NAME) !== -1,
        JSON.stringify(titles),
      );
      /*
       * ⚠️ 「旧名字不在了」这条断言必须拿**我实际改的那一份**的旧名字比。
       * 我第一次写的时候写死了「信号与系统…」，而改名改的是列表第一行
       * （高等数学），于是这条对正确实现也失败 —— 断言本身错了。
       * 库里有两份名字相似的资料，正是最容易写错的地方。
       */
      record(
        '跨会话：被改那一份的旧名字已经不在列表里',
        Array.isArray(titles) && titles.indexOf(OLD_SOURCE_NAME) === -1,
        `old=${JSON.stringify(OLD_SOURCE_NAME)} now=${JSON.stringify(titles)}`,
      );
      await shot('06-after-restart-source.png');
    } else {
      record('重启后能进资料页', false, JSON.stringify(toSources).slice(0, 200));
    }

    const toDecks = await navTo(evalJs, '我的题组');
    if (toDecks.ok) {
      await sleep(900);
      const titles = await deckTitles(evalJs);
      record(
        '★ 跨会话：重启后题组名仍然是新的',
        Array.isArray(titles) && titles.indexOf(NEW_DECK_NAME) !== -1,
        JSON.stringify(titles),
      );
      await shot('07-after-restart-deck.png');
    } else {
      record('重启后能进我的题组页', false, JSON.stringify(toDecks).slice(0, 200));
    }
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();
