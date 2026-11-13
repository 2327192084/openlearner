/**
 * 验证「开始复习改成跳转 + 闪卡管理新栏目」（2026-11-14 深夜）。
 *
 * ## 用户这一轮的三条要求
 *
 * 1. 「开始复习功能不用这种翻面闪卡样式了，就做成一个跳转到
 *    复习巩固栏目的按钮吧」
 * 2. 「错题闪卡改名为闪卡管理」
 * 3. 「在课程准备与管理的栏目下新开一个闪卡管理栏目」
 *
 * ## 断言怎么设计（硬约束 9：对坏实现也成立的断言等于没验）
 *
 * 三条都要验「落到了对的地方」，不是「有这个东西」：
 *
 *  - 开始复习：点它之后必须**到了复习巩固页**，且**没有**进翻面会话
 *    （翻面会话的特征是出现 `.rt__card` 与「先在心里回想」那种界面）。
 *    只断言「页面变了」是没用的 —— 旧实现在点了之后也换了页面。
 *  - 闪卡管理：在「课程准备与管理」组里**真的有一个入口**，
 *    点进去是闪卡管理页，且两种卡都列出来了（分组 tab 上两个数字）。
 *  - 错题闪卡：开始学习页里**不再有**「错题闪卡」这一项（改名并搬走了）。
 *
 * ⚠️ 只在副本上跑。
 *
 *   node scripts/verify-flashcard-mgmt.cjs --data .tmp/fcx-data
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/fcx-data'));
const PORT = Number(arg('port', '10005'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/flashcard-mgmt'));
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

/** 侧栏里所有可见项的文字（先展开折叠分组 —— 硬约束 17） */
const sideLabels = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(800);
    return [...document.querySelectorAll('.nav-item__label')].map(l => (l.innerText || '').trim());
  })()`);

/** 点侧栏某一项（中文名精确匹配） */
const navTo = (evalJs, name) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(700);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === ${JSON.stringify(name)});
    if (!hit) return { ok: false };
    hit.closest('button').click();
    await sleep(2200);
    return { ok: true };
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 侧栏：「闪卡管理」在课程准备与管理组里 ---------- */
    const labels = await sideLabels(evalJs);
    record('侧栏里出现了「闪卡管理」', labels.indexOf('闪卡管理') !== -1, JSON.stringify(labels).slice(0, 300));
    record('侧栏里不再有「错题闪卡」这个旧名字', labels.indexOf('错题闪卡') === -1, '');

    /* 分组归属：它必须是「课程准备与管理」那一组里的项 */
    const groupOf = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(800);
      /* 每个 nav-section = 一个分组 */
      for (const sec of document.querySelectorAll('.nav-section')) {
        const gname = (sec.querySelector('.nav-group__label')?.innerText || '').trim();
        const items = [...sec.querySelectorAll('.nav-item__label')].map(l => (l.innerText || '').trim());
        if (items.indexOf('闪卡管理') !== -1) return { group: gname, items };
      }
      return { group: null };
    })()`);
    record(
      '「闪卡管理」落在「课程准备与管理」组下',
      groupOf.group === '课程准备与管理',
      JSON.stringify(groupOf).slice(0, 260),
    );
    await shot('01-sidebar.png');

    /* ---------- 2. 开始学习页：「错题闪卡」没了，「开始复习」还在 ---------- */
    const study = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim() === '开始学习');
      hit?.closest('button')?.click();
      await sleep(2000);
      const on = document.querySelector('.page-layer--on') || document.body;
      const titles = [...on.querySelectorAll('.study-option__title, .study-card__title, h3')]
        .map(e => (e.innerText || '').trim());
      return { text: (on.innerText || '').slice(0, 500), titles };
    })()`);
    const studyText = study.text ?? '';
    record('开始学习页里仍有「开始复习」', studyText.indexOf('开始复习') !== -1, '');
    /*
     * ⚠️ 第一版这条断言用「整页文字里不含『错题闪卡』」来判，结果**假失败**：
     * 闪卡管理那一项的说明文字是「统一管知识点闪卡与错题闪卡」，
     * 里面自然出现了这个词。断言要看的是「有没有那一张**选项卡**」，
     * 不是「整页文字里有没有这四个字」。
     */
    record(
      '★ 开始学习页里不再有「错题闪卡」这个选项（改名并搬去侧栏了）',
      Array.isArray(study.titles) && study.titles.indexOf('错题闪卡') === -1,
      JSON.stringify(study.titles).slice(0, 200),
    );
    record('开始学习页里出现了「闪卡管理」那一项', studyText.indexOf('闪卡管理') !== -1, '');
    await shot('02-study-page.png');

    /* ---------- 3. 点「开始复习」：必须到复习巩固页，且不进翻面会话 ---------- */
    const reviewClick = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const on = document.querySelector('.page-layer--on') || document.body;
      /* 找「开始复习」那张卡片的可点区域 */
      const card = [...on.querySelectorAll('button, [role="button"]')]
        .find(b => (b.innerText || '').indexOf('开始复习') !== -1);
      if (!card) return { ok: false, reason: 'no-review-button' };
      card.click();
      await sleep(3000);
      const now = document.querySelector('.page-layer--on') || document.body;
      const t = (now.innerText || '').slice(0, 900);
      return {
        ok: true,
        /* 翻面会话的特征（ReviewToday）：.rt__card 或「先在心里回想」 */
        hasReviewToday: !!document.querySelector('.rt__card'),
        hasRecallHint: t.indexOf('先在心里回想') !== -1,
        /* 复习巩固页的特征 */
        isBookPage: t.indexOf('复习巩固') !== -1,
        text: t.slice(0, 260),
      };
    })()`);
    record('点「开始复习」后页面变了', reviewClick.ok === true, JSON.stringify(reviewClick).slice(0, 200));
    record(
      '★ 到了「复习巩固」页（用户要的「跳转过去」）',
      reviewClick.isBookPage === true,
      JSON.stringify(reviewClick.text).slice(0, 200),
    );
    record(
      '★ 没有直接起翻面会话（不再出现先回想→翻面的界面）',
      reviewClick.hasReviewToday === false && reviewClick.hasRecallHint === false,
      `rt=${reviewClick.hasReviewToday} recall=${reviewClick.hasRecallHint}`,
    );
    await shot('03-review-jump.png');

    /* ---------- 4. 闪卡管理页：两种卡都列出来 ---------- */
    const fcx = await navTo(evalJs, '闪卡管理');
    record('能从侧栏进闪卡管理页', fcx.ok === true, '');

    const page = await evalJs(`(() => {
      const root = document.querySelector('.fcx');
      if (!root) return { ok: false, body: document.body.innerText.slice(0, 300) };
      const tabs = [...root.querySelectorAll('.fcx__tab')].map(b => (b.innerText || '').replace(/\\s+/g, ' ').trim());
      const items = root.querySelectorAll('.fcx__item').length;
      const badges = [...root.querySelectorAll('.fcx__badge--point, .fcx__badge--wrong')]
        .map(b => (b.innerText || '').trim());
      return {
        ok: true,
        title: (root.querySelector('.fcx__title')?.innerText || '').trim(),
        tabs,
        items,
        hasPoint: badges.indexOf('知识点') !== -1,
        hasWrong: badges.indexOf('错题') !== -1,
        text: (root.innerText || '').slice(0, 400).replace(/\\s+/g, ' '),
      };
    })()`);
    record('闪卡管理页渲染出来了', page.ok === true, JSON.stringify(page).slice(0, 200));
    record('标题是「闪卡管理」', page.title === '闪卡管理', `title=${JSON.stringify(page.title)}`);
    record(
      '★ 分组 tab 上有三种：全部 / 知识点闪卡 / 错题闪卡',
      Array.isArray(page.tabs) &&
        page.tabs.some((t) => t.indexOf('知识点闪卡') !== -1) &&
        page.tabs.some((t) => t.indexOf('错题闪卡') !== -1),
      JSON.stringify(page.tabs),
    );
    /*
     * 这条原本断言「两种徽标都要出现」——但它假设库里两种卡都有。
     * 实测用户库里知识点闪卡是 **0 张**（他从没在知识库挑过卡），
     * 错题闪卡 20 张。于是那条对**正确的**实现也失败。
     *
     * 改成断言一个与数据无关的不变式：
     * **显示的徽标种类，必须正好等于 tab 上数字 >0 的那些组**。
     * 这样无论库里有哪种卡，它都在验「列出来的和算出来的一致」。
     */
    const tabNums = (page.tabs ?? []).map((t) => Number((t.match(/(\d+)\s*$/) ?? [])[1] ?? -1));
    const [allN, pointN, wrongN] = tabNums;
    const expectPoint = pointN > 0;
    const expectWrong = wrongN > 0;
    record(
      '★ 列出来的卡与 tab 上的数字一致（有哪种就显示哪种，不空报）',
      page.hasPoint === expectPoint && page.hasWrong === expectWrong && allN === page.items,
      `tab: 全部=${allN} 知识点=${pointN} 错题=${wrongN} / 实际 items=${page.items} 徽标 point=${page.hasPoint} wrong=${page.hasWrong}`,
    );
    record(
      '两种卡的来源在数据里各自是什么（如实记录，不是断言）',
      true,
      `知识点闪卡 ${pointN} 张、错题闪卡 ${wrongN} 张`,
    );
    await shot('04-flashcards-page.png');

    /* ---------- 5. 错题卡不给「删除」（它是推导出来的，删了会回来） ---------- */
    const wrongRow = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 切到「错题闪卡」这一档 */
      const tab = [...document.querySelectorAll('.fcx__tab')]
        .find(b => (b.innerText || '').indexOf('错题闪卡') !== -1);
      if (!tab) return { ok: false, reason: 'no-wrong-tab' };
      tab.click();
      await sleep(700);
      const item = document.querySelector('.fcx__item');
      if (!item) return { ok: true, empty: true };
      const texts = [...item.querySelectorAll('.fcx__act')].map(b => (b.innerText || '').trim());
      return { ok: true, empty: false, actions: texts };
    })()`);
    if (wrongRow.empty) {
      record('错题闪卡那一档目前是空的（库里没有错题，跳过）', true, '');
    } else {
      record(
        '★ 错题卡有「去做这题」',
        Array.isArray(wrongRow.actions) && wrongRow.actions.indexOf('去做这题') !== -1,
        JSON.stringify(wrongRow.actions),
      );
      record(
        '★ 错题卡**没有**「删除」按钮（删了下次刷新会回来，那是假按钮）',
        Array.isArray(wrongRow.actions) && wrongRow.actions.indexOf('删除') === -1,
        JSON.stringify(wrongRow.actions),
      );
      await shot('05-wrong-flashcard.png');
    }

    /* ---------- 6. 知识点卡可以删，且删除只删卡不删知识点 ---------- */
    const pointRow = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = [...document.querySelectorAll('.fcx__tab')]
        .find(b => (b.innerText || '').indexOf('知识点闪卡') !== -1);
      if (!tab) return { ok: false, reason: 'no-point-tab' };
      tab.click();
      await sleep(700);
      const item = document.querySelector('.fcx__item');
      if (!item) return { ok: true, empty: true };
      const texts = [...item.querySelectorAll('.fcx__act')].map(b => (b.innerText || '').trim());
      /* 点「删除」看确认文案里说了什么 */
      const del = [...item.querySelectorAll('.fcx__act')].find(b => (b.innerText || '').trim() === '删除');
      let confirmNote = null;
      if (del) {
        del.click();
        await sleep(600);
        confirmNote = document.querySelector('.fcx__confirm-note')?.innerText ?? null;
        const cancel = [...document.querySelectorAll('.fcx__confirm .fcx__act')]
          .find(b => (b.innerText || '').trim() === '取消');
        cancel?.click();
        await sleep(400);
      }
      return { ok: true, empty: false, actions: texts, confirmNote };
    })()`);
    if (pointRow.empty) {
      record('知识点闪卡那一档目前是空的（跳过）', true, '');
    } else {
      record(
        '★ 知识点卡有「删除」（它是独立记录，能删）',
        Array.isArray(pointRow.actions) && pointRow.actions.indexOf('删除') !== -1,
        JSON.stringify(pointRow.actions),
      );
      record(
        '★ 删除确认里明确说明「不会删掉知识点」（不让用户以为会连带删内容）',
        typeof pointRow.confirmNote === 'string' && pointRow.confirmNote.indexOf('知识点') !== -1,
        JSON.stringify(pointRow.confirmNote),
      );
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
