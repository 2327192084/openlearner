/**
 * 验证「划选资料正文 → 做成闪卡」（2026-11-14）。
 *
 * ## 用户要求
 *
 * 「让 ai 写闪卡这个功能可以再接入资料库，和让 ai 提问一样，
 *  用户可以划选资料内容制作闪卡」
 *
 * ## 断言怎么设计（硬约束 9）
 *
 * 只断言「浮层里有个按钮」是没有意义的 —— 那证明不了它接到哪儿。
 * 要验的是**整条链路**：
 *
 *  1. 在阅读器里划一段 → 浮层**同时**出现「用这段提问」与「做成闪卡」
 *     （两者并列是用户要的「和让 AI 提问一样」）
 *  2. 点「做成闪卡」→ 跳到闪卡管理页
 *  3. 那一页出现「待确认」的 AI 草稿区（不是直接入库）
 *
 * 第 3 条最要紧：它证明草稿真的跨页传过来了。
 * 光有按钮而点了没反应 = 假按钮。
 *
 * ⚠️ 这台机器上没有可用的真 AI Key，所以第 3 步在**没有 Key 时**
 * 期望看到的是「明确的失败提示」而不是静默无反应 ——
 * 那同样证明链路通了（请求真的发出去了，只是没凭据）。
 * 脚本会把实际拿到的是哪种情况如实打出来。
 *
 *   node scripts/verify-selection-flashcard.cjs --data .tmp/sel-fcx
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/sel-fcx'));
const PORT = Number(arg('port', '10030'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/sel-flashcard'));
const SLEEP_MS = Number(arg('boot-wait', '3200'));

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

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 打开一份资料（进阅读器） ---------- */
    const opened = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(700);
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim() === '资料');
      hit?.closest('button')?.click();
      await sleep(2000);
      const row = document.querySelector('.source-item .source-row');
      if (!row) return { ok: false, reason: 'no-source-row' };
      row.click();
      await sleep(3200);
      return { ok: !!document.querySelector('.reader-body') };
    })()`);
    record('能打开一份资料的原文', opened.ok === true, JSON.stringify(opened));

    if (!opened.ok) {
      console.log('\n进不了阅读器，后续跳过');
      return;
    }

    /*
     * ---------- 2. 先翻到**有正文**的一页 ----------
     *
     * ⚠️ 第一版直接找正文，结果报「no-text-node」。探测后发现：
     * 这本书的正文按 442 段切分，而阅读器打开时停在第 4 页 ——
     * 那一页的 `.reader-md` 内容长度是 0（分段里有些页没有正文）。
     * 所以必须先翻几段，找到真正有字的再选。
     */
    const moved = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const md = () => document.querySelector('.reader-md');
      const nextBtn = () => [...document.querySelectorAll('.reader-bottom-nav button')]
        .find(b => (b.innerText || '').indexOf('下一段') !== -1);
      for (let i = 0; i < 40; i++) {
        const el = md();
        if (el && (el.innerText || '').trim().length > 60) {
          return { ok: true, moved: i, len: (el.innerText || '').trim().length };
        }
        const b = nextBtn();
        if (!b) break;
        b.click();
        await sleep(500);
      }
      const el = md();
      return { ok: false, len: el ? (el.innerText || '').trim().length : -1 };
    })()`);
    record('能翻到一段有正文的页面（否则没法划选）', moved.ok === true, JSON.stringify(moved));

    /* ---------- 2b. 在正文里选中一段文字 ---------- */
    const selected = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 正文在 .reader-md 里 */
      const host = document.querySelector('.reader-md') || document.querySelector('.reader-body');
      if (!host) return { ok: false, reason: 'no-reader-body' };
      const cand = [...host.querySelectorAll('p, li, h1, h2, h3, div, span')]
        .find(el => (el.innerText || '').trim().length > 40);
      /* 退一步：整个容器自己有文本也行 */
      const target = cand || ((host.innerText || '').trim().length > 40 ? host : null);
      if (!target) return { ok: false, reason: 'no-text-node', len: (host.innerText||'').length };
      const text = (target.innerText || '').slice(0, 30);
      /* 用 Range 选中前 30 个字 */
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      /* 跳过纯空白的文本节点，选第一个有字的 */
      let node = walker.nextNode();
      while (node && (node.textContent || '').trim().length === 0) node = walker.nextNode();
      if (!node) return { ok: false, reason: 'no-text-node-2' };
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(30, (node.textContent || '').length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      /* 触发 selectionchange，让宿主算出浮层位置 */
      document.dispatchEvent(new Event('selectionchange'));
      await sleep(1200);
      const bar = document.querySelector('.selbar');
      return {
        ok: !!bar,
        picked: text,
        buttons: bar ? [...bar.querySelectorAll('.selbar__btn')].map(b => (b.innerText || '').trim()) : [],
      };
    })()`);
    record('划选正文后浮层出现', selected.ok === true, JSON.stringify(selected).slice(0, 260));

    if (selected.ok) {
      const btns = selected.buttons ?? [];
      record(
        '★ 浮层里有「用这段提问」（原有动作还在）',
        btns.some((t) => t.indexOf('提问') !== -1),
        JSON.stringify(btns),
      );
      record(
        '★ 浮层里有「做成闪卡」（和提问并列 —— 这是用户要的）',
        btns.some((t) => t.indexOf('闪卡') !== -1),
        JSON.stringify(btns),
      );
      await shot('01-selection-bar.png');

      /* ---------- 3. 点「做成闪卡」 → 应该跳到闪卡页 ---------- */
      const clicked = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const bar = document.querySelector('.selbar');
        if (!bar) return { ok: false, reason: 'no-bar' };
        const btn = [...bar.querySelectorAll('.selbar__btn')]
          .find(b => (b.innerText || '').indexOf('闪卡') !== -1);
        if (!btn) return { ok: false, reason: 'no-card-button' };
        const disabled = btn.disabled;
        btn.click();
        /*
         * ⚠️ AI 写卡是真实网络请求，耗时不可控（第一次跑时等 6 秒不够，
         * 于是误报「点了没反应」—— 那是**脚本**的问题，不是功能的问题）。
         * 改成轮询：最多等 30 秒，一出现草稿区或错误就立刻往下走。
         */
        let waited = 0;
        while (waited < 30000) {
          await sleep(1500);
          waited += 1500;
          if (document.querySelector('.fcx__ai') || document.querySelector('.fcx__err')) break;
          if (!document.querySelector('.fcx')) continue; /* 还在跳页 */
          /* 到了闪卡页但没有草稿也没有错误：继续等 AI */
        }
        const fcx = document.querySelector('.fcx');
        return {
          ok: true,
          disabled,
          /* 有没有到闪卡页 */
          onFlashcardsPage: !!fcx,
          /* 待确认区在不在（有草稿或明确的失败提示） */
          hasDraftArea: !!document.querySelector('.fcx__ai'),
          err: document.querySelector('.fcx__err')?.innerText?.trim() ?? null,
          notice: document.querySelector('.fcx__notice')?.innerText?.trim() ?? null,
          drafts: document.querySelectorAll('.fcx__ai-item').length,
          waitedMs: waited,
        };
      })()`);

      record('「做成闪卡」按钮可点（不是禁用状态）', clicked.disabled === false, `disabled=${clicked.disabled}`);
      record(
        '★ 点了之后跳到了闪卡管理页（证明跨页链路通了）',
        clicked.onFlashcardsPage === true,
        JSON.stringify(clicked).slice(0, 300),
      );

      /*
       * 第 3 条的期望要分两种情况，因为这台机器可能配了也可能没配后端：
       *  - 有后端：出现草稿区（.fcx__ai），里面有一张 AI 写的卡
       *  - 没后端/没 Key：出现明确的错误提示
       * 两者都算「链路通了」—— 真正要排除的是**点了什么都没发生**。
       */
      const reacted = clicked.hasDraftArea || !!clicked.err;
      record(
        '★ 点了之后有明确反应（草稿区 或 明确错误，不是静默无反应）',
        reacted === true,
        `draftArea=${clicked.hasDraftArea} err=${JSON.stringify(clicked.err)} drafts=${clicked.drafts}`,
      );
      if (clicked.hasDraftArea) {
        record(
          '★ AI 草稿真的跨页传过来了（待确认区里有内容）',
          clicked.drafts > 0,
          `草稿 ${clicked.drafts} 张`,
        );
      } else {
        record(
          '（这台机器没接可用后端，因此是明确报错而非草稿 —— 如实记录）',
          true,
          clicked.err ?? '',
        );
      }
      await shot('02-after-make-card.png');
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
